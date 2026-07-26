// SPDX-License-Identifier: MIT
//
// Everything the UI needs to talk to Aqua. Reads come from the canonical Aqua registry and from our
// skew provider; writes are ship, dock, and a taker fill used to simulate market flow in the demo.
import { ethers } from "ethers";
import deployment from "../deployment.json";
import {
    provider, makerSigner, takerSigner, session, getMaker, onMakerChange,
    hasInjectedWallet, connectWallet, seedConnectedWallet,
    connectExternalSigner, disconnectToDemo,
    type Session,
} from "./fork-session";
import { TakerTraitsLib } from "./swapvm-helpers";

export {
    provider, makerSigner, takerSigner, session, hasInjectedWallet, connectWallet, seedConnectedWallet,
    connectExternalSigner, disconnectToDemo,
};
export type { Session };

export const BPS = 1_000_000_000n;
export const FRAC = 10_000n;

const AQUA_ABI = [
    "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
    "function dock(address app, bytes32 strategyHash, address[] tokens)",
    "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
];
const ROUTER_ABI = [
    "function hash((address maker, uint256 traits, bytes data) order) view returns (bytes32)",
    "function swap((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256,uint256,bytes32)",
];
const APP_ABI = [
    "function buildProgram(address maker, address tokenA, address tokenB, uint32 feeBpsIn, uint256 sqrtPriceMin, uint256 sqrtPriceMax, uint16 decayPeriod, address skewProvider, uint64 salt, uint40 deadline) view returns (tuple(address maker, uint256 traits, bytes data))",
];
const SKEW_ABI = [
    "function setWaterline(bytes32 orderHash, (address maker, address token0, address token1, uint128 reference0, uint128 reference1, uint128 budget0, uint128 budget1, uint32 baseFeeBps, uint32 maxFeeBps, uint16 kink, uint16 waterlineFrac, address harvestTo) w)",
    "function remainingFraction(bytes32 orderHash, address token) view returns (uint256)",
    "function feeBpsFor(bytes32 orderHash, address token) view returns (uint32)",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function deposit() payable",
];

export const d = deployment;

let aqua = new ethers.Contract(deployment.aqua, AQUA_ABI, getMaker());
const router = new ethers.Contract(deployment.router, ROUTER_ABI, takerSigner);
const app = new ethers.Contract(deployment.docaApp, APP_ABI, provider);
let skew = new ethers.Contract(deployment.skewProvider, SKEW_ABI, getMaker());
let weth = new ethers.Contract(deployment.weth, ERC20_ABI, getMaker());
let usdc = new ethers.Contract(deployment.usdc, ERC20_ABI, getMaker());

onMakerChange((signer) => {
    aqua = new ethers.Contract(deployment.aqua, AQUA_ABI, signer);
    skew = new ethers.Contract(deployment.skewProvider, SKEW_ABI, signer);
    weth = new ethers.Contract(deployment.weth, ERC20_ABI, signer);
    usdc = new ethers.Contract(deployment.usdc, ERC20_ABI, signer);
});

export type Order = { maker: string; traits: bigint; data: string };
export type Strategy = {
    hash: string;
    order: Order;
    promisedWeth: bigint;
    promisedUsdc: bigint;
    budgetWeth: bigint;
    budgetUsdc: bigint;
    wethLeft: bigint;
    usdcLeft: bigint;
    remaining: bigint;       // WETH budget left, in FRAC units (drives the water level)
    remainingUsdc: bigint;   // USDC budget left, in FRAC units (health checks use both legs)
    surchargeBps: bigint;
};
export type Wallet = { weth: bigint; usdc: bigint };

export type Preset = { id: string; label: string; hint: string; count: number; promiseFactor: number };

// Each preset is one decision for the user: how many places their balance works at once.
export const PRESETS: Preset[] = [
    { id: "careful", label: "Careful", hint: "2 markets · zero oversubscription", count: 2, promiseFactor: 0.5 },
    { id: "balanced", label: "Balanced", hint: "3 markets · 2.25× coverage", count: 3, promiseFactor: 0.75 },
    { id: "busy", label: "Busy", hint: "4 markets · maximum coverage", count: 4, promiseFactor: 1 },
];

// Curve: nothing while the budget is healthy, prohibitive once it is gone.
const CURVE = { baseFeeBps: 0n, maxFeeBps: BPS / 5n, kink: 4_000n, waterlineFrac: 1_000n };

// Reads always go through the fork provider: the injected wallet may sit on another
// network where these addresses hold no code, which turns balanceOf into empty data.
const wethRead = new ethers.Contract(deployment.weth, ERC20_ABI, provider);
const usdcRead = new ethers.Contract(deployment.usdc, ERC20_ABI, provider);
const aquaRead = new ethers.Contract(deployment.aqua, AQUA_ABI, provider);
const skewRead = new ethers.Contract(deployment.skewProvider, SKEW_ABI, provider);

export async function readWallet(): Promise<Wallet> {
    const [w, u] = await Promise.all([wethRead.balanceOf(session.maker), usdcRead.balanceOf(session.maker)]);
    return { weth: BigInt(w), usdc: BigInt(u) };
}

export async function readStrategy(s: { hash: string; order: Order; promisedWeth: bigint; promisedUsdc: bigint; budgetWeth: bigint; budgetUsdc: bigint }): Promise<Strategy> {
    const [raw, rawUsdc, remaining, remainingUsdc, fee] = await Promise.all([
        aquaRead.rawBalances(session.maker, d.router, s.hash, d.weth),
        aquaRead.rawBalances(session.maker, d.router, s.hash, d.usdc),
        skewRead.remainingFraction(s.hash, d.weth),
        skewRead.remainingFraction(s.hash, d.usdc),
        skewRead.feeBpsFor(s.hash, d.weth),
    ]);
    return {
        ...s,
        wethLeft: BigInt(raw[0]),
        usdcLeft: BigInt(rawUsdc[0]),
        remaining: BigInt(remaining),
        remainingUsdc: BigInt(remainingUsdc),
        surchargeBps: BigInt(fee),
    };
}

/// Ships one strategy: a promise plus the budget that keeps it honorable.
export async function shipStrategy(
    salt: bigint,
    promisedWeth: bigint,
    promisedUsdc: bigint,
    budgetWeth: bigint,
    budgetUsdc: bigint,
): Promise<Strategy> {
    const built = await app.buildProgram(
        session.maker, d.weth, d.usdc, 3_000_000n, 0n, 0n, 0n, d.skewProvider, salt, 0n,
    );
    const order: Order = { maker: built.maker, traits: built.traits, data: built.data };

    const strategy = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address maker, uint256 traits, bytes data)"], [order],
    );
    await (await aqua.ship(d.router, strategy, [d.weth, d.usdc], [promisedWeth, promisedUsdc])).wait();

    const hash: string = await router.hash(order);
    await (await skew.setWaterline(hash, {
        maker: session.maker,
        token0: d.weth,
        token1: d.usdc,
        reference0: promisedWeth,
        reference1: promisedUsdc,
        budget0: budgetWeth,
        budget1: budgetUsdc,
        ...CURVE,
        // Surcharges belong to whoever owns the strategy. In wallet mode that is the
        // connected maker, never the demo deployment key.
        harvestTo: session.maker,
    })).wait();

    return readStrategy({ hash, order, promisedWeth, promisedUsdc, budgetWeth, budgetUsdc });
}

export async function start(preset: Preset, wallet: Wallet): Promise<Strategy[]> {
    const promisedWeth = BigInt(Math.floor(Number(wallet.weth) * preset.promiseFactor));
    const promisedUsdc = BigInt(Math.floor(Number(wallet.usdc) * preset.promiseFactor));
    const budgetWeth = wallet.weth / BigInt(preset.count);
    const budgetUsdc = wallet.usdc / BigInt(preset.count);

    const out: Strategy[] = [];
    for (let i = 0; i < preset.count; i++) {
        out.push(await shipStrategy(
            BigInt(Date.now() % 1_000_000 + i),
            promisedWeth,
            promisedUsdc,
            budgetWeth < promisedWeth ? budgetWeth : promisedWeth,
            budgetUsdc < promisedUsdc ? budgetUsdc : promisedUsdc,
        ));
    }
    return out;
}

export async function dock(s: Strategy) {
    await (await aqua.dock(d.router, s.hash, [d.weth, d.usdc])).wait();
}

/// A taker buying the maker's WETH. This is the market flow the position lives off.
export async function marketFill(s: Strategy, usdcAmount: bigint): Promise<{ ok: boolean; reason?: string }> {
    const takerData = TakerTraitsLib.build({
        taker: d.taker,
        isExactIn: true,
        isAToB: false,
        threshold: 1n,
        useTransferFromAndAquaPush: true,
    });
    try {
        await (await router.swap(s.order, usdcAmount, takerData)).wait();
        return { ok: true };
    } catch (e: any) {
        takerSigner.reset(); // a failed populate can desync the cached nonce
        return { ok: false, reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 90) };
    }
}

/// Clears cached nonces after a reverted send so follow-up transactions do not hang.
export function resetNonces() {
    makerSigner.reset();
    takerSigner.reset();
}

/// The user spending from the same wallet while it is earning. Nothing needs to be withdrawn first.
export async function spendWeth(amount: bigint) {
    await (await weth.transfer(d.taker, amount)).wait();
}

export const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(4);
export const fmtUsdc = (v: bigint) => Number(ethers.formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (v: bigint) => (Number(v) / Number(FRAC) * 100).toFixed(1);
export const fmtFee = (v: bigint) => (Number(v) / Number(BPS) * 100).toFixed(2);
