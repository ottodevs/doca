// SPDX-License-Identifier: MIT
//
// Everything the UI needs to talk to Aqua. Reads come from the canonical Aqua registry and from our
// skew provider; writes are ship, dock, and a taker fill used to simulate market flow in the demo.
import { ethers } from "ethers";
import deployment from "../deployment.json";
import { TakerTraitsLib } from "./swapvm-helpers";

// Well-known anvil development keys. Demo only: on a public chain this is a wallet connector.
const KEYS = {
    maker: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    taker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

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
];

export const d = deployment;

export const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
    staticNetwork: true,
});

// The fork inherits real Base account nonces, so let NonceManager own sequencing instead of
// relying on per-block caches: several of these actions fire back to back.
export const makerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.maker, provider));
export const takerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.taker, provider));

const aqua = new ethers.Contract(deployment.aqua, AQUA_ABI, makerSigner);
const router = new ethers.Contract(deployment.router, ROUTER_ABI, takerSigner);
const app = new ethers.Contract(deployment.plimsollApp, APP_ABI, provider);
const skew = new ethers.Contract(deployment.skewProvider, SKEW_ABI, makerSigner);
const weth = new ethers.Contract(deployment.weth, ERC20_ABI, makerSigner);
const usdc = new ethers.Contract(deployment.usdc, ERC20_ABI, makerSigner);

export type Order = { maker: string; traits: bigint; data: string };
export type Strategy = {
    hash: string;
    order: Order;
    promisedWeth: bigint;
    promisedUsdc: bigint;
    budgetWeth: bigint;
    wethLeft: bigint;
    remaining: bigint;   // budget left, in FRAC units
    surchargeBps: bigint;
};
export type Wallet = { weth: bigint; usdc: bigint };

export type Preset = { id: string; label: string; hint: string; count: number; promiseFactor: number };

// Each preset is one decision for the user: how many places their balance works at once.
export const PRESETS: Preset[] = [
    { id: "careful", label: "Careful", hint: "2 places, no oversubscription", count: 2, promiseFactor: 0.5 },
    { id: "balanced", label: "Balanced", hint: "3 places, 2.25x your balance", count: 3, promiseFactor: 0.75 },
    { id: "busy", label: "Busy", hint: "4 places, 4x your balance", count: 4, promiseFactor: 1 },
];

// Curve: nothing while the budget is healthy, prohibitive once it is gone.
const CURVE = { baseFeeBps: 0n, maxFeeBps: BPS / 5n, kink: 4_000n, waterlineFrac: 1_000n };

export async function readWallet(): Promise<Wallet> {
    const [w, u] = await Promise.all([weth.balanceOf(d.maker), usdc.balanceOf(d.maker)]);
    return { weth: BigInt(w), usdc: BigInt(u) };
}

export async function readStrategy(s: { hash: string; order: Order; promisedWeth: bigint; promisedUsdc: bigint; budgetWeth: bigint }): Promise<Strategy> {
    const [raw, remaining, fee] = await Promise.all([
        aqua.rawBalances(d.maker, d.router, s.hash, d.weth),
        skew.remainingFraction(s.hash, d.weth),
        skew.feeBpsFor(s.hash, d.weth),
    ]);
    return { ...s, wethLeft: BigInt(raw[0]), remaining: BigInt(remaining), surchargeBps: BigInt(fee) };
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
        d.maker, d.weth, d.usdc, 3_000_000n, 0n, 0n, 0n, d.skewProvider, salt, 0n,
    );
    const order: Order = { maker: built.maker, traits: built.traits, data: built.data };

    const strategy = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address maker, uint256 traits, bytes data)"], [order],
    );
    await (await aqua.ship(d.router, strategy, [d.weth, d.usdc], [promisedWeth, promisedUsdc])).wait();

    const hash: string = await router.hash(order);
    await (await skew.setWaterline(hash, {
        maker: d.maker,
        token0: d.weth,
        token1: d.usdc,
        reference0: promisedWeth,
        reference1: promisedUsdc,
        budget0: budgetWeth,
        budget1: budgetUsdc,
        ...CURVE,
        harvestTo: d.maker,
    })).wait();

    return readStrategy({ hash, order, promisedWeth, promisedUsdc, budgetWeth });
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
        return { ok: false, reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 90) };
    }
}

/// The user spending from the same wallet while it is earning. Nothing needs to be withdrawn first.
export async function spendWeth(amount: bigint) {
    await (await weth.transfer(d.taker, amount)).wait();
}

export const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(4);
export const fmtUsdc = (v: bigint) => Number(ethers.formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (v: bigint) => (Number(v) / Number(FRAC) * 100).toFixed(1);
export const fmtFee = (v: bigint) => (Number(v) / Number(BPS) * 100).toFixed(2);
