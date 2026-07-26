// SPDX-License-Identifier: MIT
//
// LP Desk: compose and ship multiple AquaSwapVM AMM strategies (XYC, concentrate, pegged)
// via the plain AquaAMM builder: no inventory skew.
import { ethers, type EventLog, type Log } from "ethers";
import deployment from "../deployment.json";
import { TakerTraitsLib } from "./swapvm-helpers";

const KEYS = {
    maker: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    taker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

const AQUA_ABI = [
    "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
    "function dock(address app, bytes32 strategyHash, address[] tokens)",
    "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
    "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
    "event Docked(address maker, address app, bytes32 strategyHash)",
    "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
];
const ROUTER_ABI = [
    "function hash((address maker, uint256 traits, bytes data) order) view returns (bytes32)",
    "function swap((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256,uint256,bytes32)",
    "function quote((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256,uint256,bytes32)",
];
const AMM_ABI = [
    "function buildProgram(address maker, address tokenA, address tokenB, uint32 feeBpsIn, uint256 sqrtPriceMin, uint256 sqrtPriceMax, uint16 decayPeriod, uint32 protocolFeeBpsIn, address feeReceiver, uint64 salt, uint40 deadline) view returns (tuple(address maker, uint256 traits, bytes data))",
    "function buildPeggedProgram(address maker, address tokenA, address tokenB, uint32 feeBpsIn, uint256 linearWidth, uint256 reserveA, uint256 reserveB, uint8 decimalsA, uint8 decimalsB, uint32 protocolFeeBpsIn, address feeReceiver, uint64 salt, uint40 deadline) view returns (tuple(address maker, uint256 traits, bytes data))",
];
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
];

export const d = deployment as typeof deployment & { aquaAmm: string; taker: string };

// VITE_RPC_URL pins a public endpoint for hosted builds; otherwise the node lives on whatever
// host served the page, so the app works over localhost and over the tailnet unchanged.
const rpcUrl = import.meta.env.VITE_RPC_URL
    || (typeof window !== "undefined" ? `http://${window.location.hostname}:8545` : deployment.rpcUrl);

export const provider = new ethers.JsonRpcProvider(rpcUrl, deployment.chainId, {
    staticNetwork: true,
});

export const makerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.maker, provider));
export const takerSigner = new ethers.NonceManager(new ethers.Wallet(KEYS.taker, provider));

const aqua = new ethers.Contract(deployment.aqua, AQUA_ABI, makerSigner);
const router = new ethers.Contract(deployment.router, ROUTER_ABI, provider);
const routerAsTaker = new ethers.Contract(deployment.router, ROUTER_ABI, takerSigner);
const amm = new ethers.Contract(d.aquaAmm, AMM_ABI, provider);
const weth = new ethers.Contract(deployment.weth, ERC20_ABI, provider);
const usdc = new ethers.Contract(deployment.usdc, ERC20_ABI, provider);
const wethAsTaker = new ethers.Contract(deployment.weth, ERC20_ABI, takerSigner);
const usdcAsTaker = new ethers.Contract(deployment.usdc, ERC20_ABI, takerSigner);

const ONE_E18 = 10n ** 18n;
const ZERO = ethers.ZeroAddress;
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

export type StrategyKind = "xyc" | "concentrate" | "pegged";
export type Order = { maker: string; traits: bigint; data: string };

export type DraftStrategy = {
    id: string;
    kind: StrategyKind;
    promisedWeth: bigint;
    promisedUsdc: bigint;
    /** SwapVM fee units: 1e9 = 100% */
    feeBpsIn: bigint;
    /** USDC per WETH bounds (concentrate only) */
    priceMinUsdc?: number;
    priceMaxUsdc?: number;
    /** Pegged A parameter as human float (e.g. 0.8 → 0.8e27) */
    linearWidthA?: number;
};

export type LiveStrategy = {
    hash: string;
    order: Order;
    kind: StrategyKind;
    promisedWeth: bigint;
    promisedUsdc: bigint;
    feeBpsIn: bigint;
    wethLeft: bigint;
    usdcLeft: bigint;
    label: string;
};

export type Wallet = { weth: bigint; usdc: bigint };

export const KIND_LABEL: Record<StrategyKind, string> = {
    xyc: "XYC",
    concentrate: "Concentrated",
    pegged: "Pegged",
};

/** Human percent → SwapVM fee (1e9 = 100%). */
export function feeFromPercent(percent: number): bigint {
    if (!(percent >= 0) || !Number.isFinite(percent)) return 0n;
    return BigInt(Math.round(percent * 1e7));
}

export function percentFromFee(feeBpsIn: bigint): string {
    return (Number(feeBpsIn) / 1e7).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function bigintSqrt(value: bigint): bigint {
    if (value < 0n) throw new Error("sqrt of negative");
    if (value < 2n) return value;
    if (value <= 9007199254740991n) return BigInt(Math.floor(Math.sqrt(Number(value))));
    let x0 = value;
    let x1 = (value / x0 + x0) >> 1n;
    while (x1 < x0) {
        x0 = x1;
        x1 = (value / x0 + x0) >> 1n;
    }
    return x0;
}

/**
 * Convert USDC-per-WETH human range → sqrt(P) bounds for AquaAMM / XYCConcentrate.
 * P = tokenGt/tokenLt (address order). Matches @1inch/swap-vm-sdk `Price.fromHuman`.
 *
 * Base:  WETH < USDC → token0=WETH, token1=USDC → P rises with USDC/WETH.
 * Mainnet: USDC < WETH → inverted (higher USDC/WETH → lower P).
 */
export function usdcPerWethToSqrtPrices(minUsdc: number, maxUsdc: number): { sqrtMin: bigint; sqrtMax: bigint } {
    const low = Math.min(minUsdc, maxUsdc);
    const high = Math.max(minUsdc, maxUsdc);
    if (!(low > 0) || !(high > low)) throw new Error("concentrate range needs 0 < min < max");

    const wethIsToken0 = d.weth.toLowerCase() < d.usdc.toLowerCase();
    const scale = WETH_DECIMALS + USDC_DECIMALS; // 24

    const toSqrt = (humanUsdcPerWeth: number): bigint => {
        // Avoid float parseUnits issues: keep ~8 fractional digits.
        const text = humanUsdcPerWeth.toFixed(8).replace(/\.?0+$/, "") || "0";
        const scaledRaw = ethers.parseUnits(text, scale);
        if (scaledRaw <= 0n) throw new Error("price must be positive");

        if (wethIsToken0) {
            // Quote USDC = token1: sqrt((scaledRaw * 1e36) / 10^(2*decWeth))
            const denominator = 10n ** BigInt(WETH_DECIMALS + WETH_DECIMALS);
            return bigintSqrt((scaledRaw * ONE_E18 * ONE_E18) / denominator);
        }
        // Quote USDC = token0 (mainnet-style): sqrt((10^(2*decWeth) * 1e36) / scaledRaw)
        const numerator = 10n ** BigInt(WETH_DECIMALS + WETH_DECIMALS) * ONE_E18;
        return bigintSqrt((numerator * ONE_E18) / scaledRaw);
    };

    const a = toSqrt(low);
    const b = toSqrt(high);
    const sqrtMin = a < b ? a : b;
    const sqrtMax = a < b ? b : a;
    if (sqrtMin >= sqrtMax) throw new Error("invalid sqrt bounds from price range");
    return { sqrtMin, sqrtMax };
}

/** Balanced USDC for a WETH amount at spot (50/50 by value, natural XYC deposit). */
export function usdcForWethAtSpot(wethHuman: number, usdcPerWeth: number): string {
    if (!(wethHuman > 0) || !(usdcPerWeth > 0)) return "0";
    return (wethHuman * usdcPerWeth).toFixed(2);
}

/** Balanced WETH for a USDC amount at spot. */
export function wethForUsdcAtSpot(usdcHuman: number, usdcPerWeth: number): string {
    if (!(usdcHuman > 0) || !(usdcPerWeth > 0)) return "0";
    return (usdcHuman / usdcPerWeth).toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** Free wallet after accounting for uncommitted drafts. */
export function freeWallet(
    wallet: Wallet,
    drafts: { promisedWeth: bigint; promisedUsdc: bigint }[],
): Wallet {
    let weth = wallet.weth;
    let usdc = wallet.usdc;
    for (const dft of drafts) {
        weth -= dft.promisedWeth;
        usdc -= dft.promisedUsdc;
    }
    return {
        weth: weth > 0n ? weth : 0n,
        usdc: usdc > 0n ? usdc : 0n,
    };
}

export function assertFitsWallet(
    draft: { promisedWeth: bigint; promisedUsdc: bigint },
    free: Wallet,
): void {
    if (draft.promisedWeth > free.weth) {
        throw new Error(
            `Not enough WETH: need ${Number(ethers.formatEther(draft.promisedWeth)).toFixed(4)}, `
            + `free ${Number(ethers.formatEther(free.weth)).toFixed(4)} (wallet minus drafts)`,
        );
    }
    if (draft.promisedUsdc > free.usdc) {
        throw new Error(
            `Not enough USDC: need ${Number(ethers.formatUnits(draft.promisedUsdc, 6)).toFixed(2)}, `
            + `free ${Number(ethers.formatUnits(free.usdc, 6)).toFixed(2)} (wallet minus drafts)`,
        );
    }
}

export function linearWidthFromA(a: number): bigint {
    if (!(a >= 0) || !Number.isFinite(a)) throw new Error("linearWidth A must be ≥ 0");
    // A * 1e27; keep integer precision for common values like 0.8
    return BigInt(Math.round(a * 1e9)) * 10n ** 18n;
}

export async function readWallet(): Promise<Wallet> {
    const [w, u] = await Promise.all([weth.balanceOf(d.maker), usdc.balanceOf(d.maker)]);
    return { weth: BigInt(w), usdc: BigInt(u) };
}

export async function readLive(s: Omit<LiveStrategy, "wethLeft" | "usdcLeft">): Promise<LiveStrategy> {
    const [rawW, rawU] = await Promise.all([
        aqua.rawBalances(d.maker, d.router, s.hash, d.weth),
        aqua.rawBalances(d.maker, d.router, s.hash, d.usdc),
    ]);
    return { ...s, wethLeft: BigInt(rawW[0]), usdcLeft: BigInt(rawU[0]) };
}

async function buildOrder(draft: DraftStrategy, salt: bigint): Promise<Order> {
    if (draft.kind === "pegged") {
        const a = draft.linearWidthA ?? 0.8;
        const built = await amm.buildPeggedProgram(
            d.maker,
            d.weth,
            d.usdc,
            draft.feeBpsIn,
            linearWidthFromA(a),
            draft.promisedWeth,
            draft.promisedUsdc,
            WETH_DECIMALS,
            USDC_DECIMALS,
            0n,
            ZERO,
            salt,
            0n,
        );
        return { maker: built.maker, traits: built.traits, data: built.data };
    }

    let sqrtMin = 0n;
    let sqrtMax = 0n;
    if (draft.kind === "concentrate") {
        const min = draft.priceMinUsdc ?? 0;
        const max = draft.priceMaxUsdc ?? 0;
        ({ sqrtMin, sqrtMax } = usdcPerWethToSqrtPrices(min, max));
    }

    const built = await amm.buildProgram(
        d.maker,
        d.weth,
        d.usdc,
        draft.feeBpsIn,
        sqrtMin,
        sqrtMax,
        0n,
        0n,
        ZERO,
        salt,
        0n,
    );
    return { maker: built.maker, traits: built.traits, data: built.data };
}

function draftLabel(draft: DraftStrategy): string {
    if (draft.kind === "concentrate") {
        return `${KIND_LABEL.concentrate} ${draft.priceMinUsdc}-${draft.priceMaxUsdc}`;
    }
    if (draft.kind === "pegged") {
        return `${KIND_LABEL.pegged} A=${draft.linearWidthA ?? 0.8}`;
    }
    return KIND_LABEL.xyc;
}

export async function buildAndShip(draft: DraftStrategy, salt?: bigint): Promise<LiveStrategy> {
    if (!d.aquaAmm || d.aquaAmm === ethers.ZeroAddress) {
        throw new Error("deployment.json missing aquaAmm: re-run deploy-for-web.ts");
    }
    const bal = await readWallet();
    assertFitsWallet(draft, bal);

    const s = salt ?? BigInt(Date.now() % 1_000_000_000);
    const order = await buildOrder(draft, s);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address maker, uint256 traits, bytes data)"],
        [order],
    );
    await (await aqua.ship(d.router, encoded, [d.weth, d.usdc], [draft.promisedWeth, draft.promisedUsdc])).wait();
    const hash: string = await router.hash(order);
    return readLive({
        hash,
        order,
        kind: draft.kind,
        promisedWeth: draft.promisedWeth,
        promisedUsdc: draft.promisedUsdc,
        feeBpsIn: draft.feeBpsIn,
        label: draftLabel(draft),
    });
}

export async function dock(s: LiveStrategy): Promise<void> {
    await (await aqua.dock(d.router, s.hash, [d.weth, d.usdc])).wait();
}

export function resetMakerNonce() {
    makerSigner.reset();
}

export function resetTakerNonce() {
    takerSigner.reset();
}

export type TradeSide = "buyWeth" | "sellWeth";

export type TradeResult = {
    ok: boolean;
    reason?: string;
};

/**
 * Fork-implied USDC per WETH from Aqua strategy reserves (XYC mid).
 * Prefers a router quote of a small WETH sell when liquidity allows.
 */
export async function fetchForkSpot(live: LiveStrategy[]): Promise<{ usdcPerWeth: number }> {
    const withLiq = live.filter((s) => s.wethLeft > 0n && s.usdcLeft > 0n);
    if (withLiq.length === 0) throw new Error("No strategy with both WETH and USDC left");

    // Reserve mid across all live liquidity.
    let wethSum = 0n;
    let usdcSum = 0n;
    for (const s of withLiq) {
        wethSum += s.wethLeft;
        usdcSum += s.usdcLeft;
    }
    const reserveMid = Number(ethers.formatUnits(usdcSum, 6)) / Number(ethers.formatEther(wethSum));

    // Try quoting a small WETH→USDC sell on the deepest WETH book.
    const probe = withLiq.reduce((a, b) => (a.wethLeft >= b.wethLeft ? a : b));
    const amountIn = probe.wethLeft / 100n > 10n ** 15n ? probe.wethLeft / 100n : 10n ** 15n; // ≥0.001 WETH
    if (amountIn > 0n && amountIn < probe.wethLeft) {
        try {
            const takerData = TakerTraitsLib.build({
                taker: d.taker,
                isExactIn: true,
                isAToB: true, // WETH (A) → USDC (B) on Base
                threshold: 1n,
                useTransferFromAndAquaPush: true,
            });
            const result = await router.quote.staticCall(probe.order, amountIn, takerData);
            const out = BigInt(result[1]);
            if (out > 0n) {
                const usdcPerWeth = Number(ethers.formatUnits(out, 6)) / Number(ethers.formatEther(amountIn));
                if (usdcPerWeth > 0) return { usdcPerWeth };
            }
        } catch {
            /* fall through to reserves */
        }
    }
    if (!(reserveMid > 0)) throw new Error("Fork reserve mid is zero");
    return { usdcPerWeth: reserveMid };
}

/**
 * Execute a taker swap against a shipped AquaSwapVM strategy on the local fork.
 * buyWeth  : pay USDC, receive WETH (isAToB=false)
 * sellWeth : pay WETH, receive USDC (isAToB=true)
 */
export async function tradeAgainst(
    s: LiveStrategy,
    side: TradeSide,
    amountHuman: string,
): Promise<TradeResult> {
    const isBuy = side === "buyWeth";
    const amount = isBuy
        ? ethers.parseUnits(amountHuman || "0", 6)
        : ethers.parseEther(amountHuman || "0");
    if (amount <= 0n) return { ok: false, reason: "Amount must be > 0" };

    try {
        if (isBuy) {
            const bal = BigInt(await usdc.balanceOf(d.taker));
            if (amount > bal) {
                return { ok: false, reason: `Taker only has ${fmtUsdc(bal)} USDC` };
            }
            const allowance = BigInt(await usdc.allowance(d.taker, d.router));
            if (allowance < amount) {
                await (await usdcAsTaker.approve(d.router, ethers.MaxUint256)).wait();
            }
        } else {
            const bal = BigInt(await weth.balanceOf(d.taker));
            if (amount > bal) {
                return { ok: false, reason: `Taker only has ${fmtWeth(bal)} WETH: buy some first` };
            }
            const allowance = BigInt(await weth.allowance(d.taker, d.router));
            if (allowance < amount) {
                await (await wethAsTaker.approve(d.router, ethers.MaxUint256)).wait();
            }
        }

        const takerData = TakerTraitsLib.build({
            taker: d.taker,
            isExactIn: true,
            isAToB: !isBuy, // sell WETH ⇒ A→B; buy WETH ⇒ B→A
            threshold: 1n,
            useTransferFromAndAquaPush: true,
        });

        await (await routerAsTaker.swap(s.order, amount, takerData)).wait();
        return { ok: true };
    } catch (e: any) {
        resetTakerNonce();
        return {
            ok: false,
            reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160),
        };
    }
}

export async function readTakerWallet(): Promise<Wallet> {
    const [w, u] = await Promise.all([weth.balanceOf(d.taker), usdc.balanceOf(d.taker)]);
    return { weth: BigInt(w), usdc: BigInt(u) };
}

export const fmtWeth = (v: bigint) => Number(ethers.formatEther(v)).toFixed(4);
export const fmtUsdc = (v: bigint) =>
    Number(ethers.formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** AquaOpcodes indices used in AquaAMM programs. */
const OP_XYC = 0x11;
const OP_CONCENTRATE = 0x12;
const OP_PEGGED = 0x1f;

function inferKindFromProgram(data: string): { kind: StrategyKind; label: string } {
    const bytes = ethers.getBytes(data);
    let hasConcentrate = false;
    let hasPegged = false;
    let hasXyc = false;
    for (let i = 0; i < bytes.length - 1; i++) {
        const op = bytes[i]!;
        const argLen = bytes[i + 1]!;
        if (argLen > 160) continue;
        if (i + 2 + argLen > bytes.length) continue;
        if (op === OP_CONCENTRATE) hasConcentrate = true;
        if (op === OP_PEGGED) hasPegged = true;
        if (op === OP_XYC) hasXyc = true;
    }
    if (hasPegged) return { kind: "pegged", label: KIND_LABEL.pegged };
    if (hasConcentrate) return { kind: "concentrate", label: KIND_LABEL.concentrate };
    if (hasXyc) return { kind: "xyc", label: KIND_LABEL.xyc };
    return { kind: "xyc", label: "Recovered" };
}

function decodeOrder(strategy: string): Order {
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["tuple(address maker, uint256 traits, bytes data)"],
        strategy,
    );
    return { maker: decoded.maker, traits: BigInt(decoded.traits), data: decoded.data };
}

/**
 * Reload active Aqua strategies for the demo maker from Shipped − Docked logs.
 * Balances come from the fork; initial promises from the first Pushed amounts when available.
 */
export async function loadShippedFromChain(): Promise<LiveStrategy[]> {
    const maker = d.maker.toLowerCase();
    const app = d.router.toLowerCase();
    // Only scan from the pinned fork block forward: avoids pulling all Base Aqua history.
    const fromBlock = (d as { forkBlock?: number }).forkBlock ?? 0;

    const isEvent = (e: Log | EventLog): e is EventLog => "args" in e && e.args != null;

    const shipped = (await aqua.queryFilter(aqua.filters.Shipped(), fromBlock)).filter(isEvent);
    const docked = (await aqua.queryFilter(aqua.filters.Docked(), fromBlock)).filter(isEvent);
    const pushed = (await aqua.queryFilter(aqua.filters.Pushed(), fromBlock)).filter(isEvent);

    const dockedHashes = new Set(
        docked
            .filter((e) => String(e.args.maker).toLowerCase() === maker && String(e.args.app).toLowerCase() === app)
            .map((e) => String(e.args.strategyHash).toLowerCase()),
    );

    const initial: Record<string, { weth: bigint; usdc: bigint }> = {};
    for (const e of pushed) {
        if (String(e.args.maker).toLowerCase() !== maker) continue;
        if (String(e.args.app).toLowerCase() !== app) continue;
        const hash = String(e.args.strategyHash).toLowerCase();
        if (dockedHashes.has(hash)) continue;
        const token = String(e.args.token).toLowerCase();
        const amount = BigInt(e.args.amount);
        const slot = initial[hash] ?? { weth: 0n, usdc: 0n };
        if (token === d.weth.toLowerCase() && slot.weth === 0n) slot.weth = amount;
        if (token === d.usdc.toLowerCase() && slot.usdc === 0n) slot.usdc = amount;
        initial[hash] = slot;
    }

    const byHash = new Map<string, LiveStrategy>();
    for (const e of shipped) {
        if (String(e.args.maker).toLowerCase() !== maker) continue;
        if (String(e.args.app).toLowerCase() !== app) continue;
        const hash = String(e.args.strategyHash);
        if (dockedHashes.has(hash.toLowerCase())) continue;
        try {
            const order = decodeOrder(e.args.strategy);
            const { kind, label } = inferKindFromProgram(order.data);
            const promised = initial[hash.toLowerCase()] ?? { weth: 0n, usdc: 0n };
            const live = await readLive({
                hash,
                order,
                kind,
                promisedWeth: promised.weth,
                promisedUsdc: promised.usdc,
                feeBpsIn: 0n,
                label,
            });
            // Skip fully empty / never-initialized
            if (live.wethLeft === 0n && live.usdcLeft === 0n && promised.weth === 0n && promised.usdc === 0n) {
                continue;
            }
            if (promised.weth === 0n && promised.usdc === 0n) {
                live.promisedWeth = live.wethLeft;
                live.promisedUsdc = live.usdcLeft;
            }
            byHash.set(hash.toLowerCase(), live);
        } catch {
            /* skip undecodable strategies (e.g. Doca demo skew programs) */
        }
    }

    return [...byHash.values()];
}
