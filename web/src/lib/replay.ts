// SPDX-License-Identifier: MIT
//
// Guided replay: an in-memory scripted backend for the hosted preview, which has no fork behind
// it. Exposes the same shapes as lib/doca.ts (Wallet, Strategy, the action functions) so App.tsx
// can drive the full 5-screen journey without a chain. Deterministic, no network, no wallet.
//
// The numbers mirror the real demo: a 2.00 WETH + 8,000 USDC wallet (the same seed
// seedConnectedWallet puts on the fork) and the Balanced preset's own math (lib/doca.ts `start`),
// not invented figures. The depletion curve is the exact curve from InventorySkewProvider.sol,
// reusing doca.ts's CURVE/BPS/FRAC constants so the surcharge ramps identically to the live demo.
import { BPS, FRAC, CURVE, type Order, type Preset, type Strategy, type Wallet } from "./doca";

const WEI = 10n ** 18n;
const USDC_DP = 10n ** 6n;

// Realistic action latency: ship/dock/fill/spend each wait for a "confirmation" like a real tx
// would. Reads stay fast, the way an RPC read does even when a write is still pending.
const jitter = (minMs: number, maxMs: number) => new Promise<void>((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
const actionLatency = () => jitter(300, 900);
const readLatency = () => jitter(30, 90);

// Internal reference price for sizing simulated taker flow only. Never shown to the user: the
// Uniswap live pill is hidden in replay mode and the Harbormaster's market-reference line is
// suppressed too (see App.tsx), so this number never reaches the UI as a claimed live price.
const REPLAY_REFERENCE_PRICE_USDC_PER_WETH = 4_000n;

// Per-strategy drain bias for the scripted stress flow, in 1000ths (1000n = neutral). The live
// demo's 8-fill round robin happens to hit every strategy evenly; here the bias reproduces the
// same "one strategy runs into trouble first" narrative deterministically instead of leaving it
// to chance. Strategy 2 (index 1) is the one that crosses the dock line, per the recorded demo.
const DRAIN_BIAS_1000: readonly bigint[] = [300n, 1680n, 300n];
const DEFAULT_BIAS_1000 = 1000n;

type Ledger = {
    hash: string;
    order: Order;
    shippedWeth: bigint; budgetWeth: bigint; balWeth: bigint;
    shippedUsdc: bigint; budgetUsdc: bigint; balUsdc: bigint;
};

const ledger = new Map<string, Ledger>();
let wallet: Wallet = { weth: 0n, usdc: 0n };
let shipCount = 0;

const REPLAY_MAKER = "0xREP1AY00000000000000000000000000000000";

/// Resets the scripted world to the recorded starting point: 2.00 WETH + 8,000 USDC, no
/// strategies shipped. Called whenever guided replay is (re)entered.
export function resetReplay(): void {
    ledger.clear();
    wallet = { weth: 2n * WEI, usdc: 8_000n * USDC_DP };
    shipCount = 0;
}
resetReplay();

export function resetNonces(): void { /* no chain nonces in replay */ }

function fakeHash(salt: bigint): string {
    shipCount += 1;
    return `0xreplay${salt.toString(16).padStart(10, "0")}${shipCount.toString(16).padStart(4, "0")}`;
}

// Mirrors InventorySkewProvider._remainingFraction: budget consumed, not balance remaining, as a
// fraction of FRAC (1e4).
function remFrac(shipped: bigint, budget: bigint, balance: bigint): bigint {
    if (balance >= shipped) return FRAC;
    const consumed = shipped - balance;
    if (consumed >= budget) return 0n;
    return ((budget - consumed) * FRAC) / budget;
}

// Mirrors InventorySkewProvider._feeBps: flat above the kink, quadratic ramp down to the
// waterline, capped at maxFeeBps below it.
function feeBpsFor(remaining: bigint): bigint {
    const { baseFeeBps, maxFeeBps, kink, waterlineFrac } = CURVE;
    if (remaining >= kink) return baseFeeBps;
    if (remaining <= waterlineFrac) return maxFeeBps;
    const span = kink - waterlineFrac;
    const travelled = kink - remaining;
    const spread = maxFeeBps - baseFeeBps;
    return baseFeeBps + (spread * travelled * travelled) / (span * span);
}

function toStrategy(l: Ledger): Strategy {
    const remaining = remFrac(l.shippedWeth, l.budgetWeth, l.balWeth);
    const remainingUsdc = remFrac(l.shippedUsdc, l.budgetUsdc, l.balUsdc);
    return {
        hash: l.hash,
        order: l.order,
        promisedWeth: l.shippedWeth,
        promisedUsdc: l.shippedUsdc,
        budgetWeth: l.budgetWeth,
        budgetUsdc: l.budgetUsdc,
        wethLeft: l.balWeth,
        usdcLeft: l.balUsdc,
        remaining,
        remainingUsdc,
        surchargeBps: feeBpsFor(remaining),
    };
}

export async function readWallet(): Promise<Wallet> {
    await readLatency();
    return { ...wallet };
}

export async function readStrategy(s: { hash: string }): Promise<Strategy> {
    await readLatency();
    const l = ledger.get(s.hash);
    // Mirrors the chain reads: a docked/unknown hash comes back as an empty, healthy-looking
    // position (zero balance, nothing left to protect) instead of throwing. Aqua's raw balances
    // and the skew provider's remainingFraction both do the same for a hash with no live state,
    // and App.tsx's refresh()/harbormaster can legitimately race a dock with a stale read.
    if (!l) return { hash: s.hash, order: { maker: REPLAY_MAKER, traits: 0n, data: "0x" }, promisedWeth: 0n, promisedUsdc: 0n, budgetWeth: 0n, budgetUsdc: 0n, wethLeft: 0n, usdcLeft: 0n, remaining: FRAC, remainingUsdc: FRAC, surchargeBps: 0n };
    return toStrategy(l);
}

/// Ships one strategy against the scripted wallet. Same signature as doca.ts's shipStrategy so
/// the Harbormaster's re-ship call (App.tsx) works unmodified against either backend.
export async function shipStrategy(
    salt: bigint,
    promisedWeth: bigint,
    promisedUsdc: bigint,
    budgetWeth: bigint,
    budgetUsdc: bigint,
): Promise<Strategy> {
    await actionLatency();
    const hash = fakeHash(salt);
    const l: Ledger = {
        hash,
        order: { maker: REPLAY_MAKER, traits: 0n, data: "0x" },
        shippedWeth: promisedWeth, budgetWeth, balWeth: promisedWeth,
        shippedUsdc: promisedUsdc, budgetUsdc, balUsdc: promisedUsdc,
    };
    ledger.set(hash, l);
    return toStrategy(l);
}

/// Ships `preset.count` strategies. Mirrors lib/doca.ts's `start` formula exactly (same
/// promiseFactor / count math), just against the scripted wallet instead of the fork.
export async function start(preset: Preset, w: Wallet): Promise<Strategy[]> {
    const promisedWeth = BigInt(Math.floor(Number(w.weth) * preset.promiseFactor));
    const promisedUsdc = BigInt(Math.floor(Number(w.usdc) * preset.promiseFactor));
    const budgetWeth = w.weth / BigInt(preset.count);
    const budgetUsdc = w.usdc / BigInt(preset.count);

    const out: Strategy[] = [];
    for (let i = 0; i < preset.count; i++) {
        out.push(await shipStrategy(
            BigInt(1 + i),
            promisedWeth,
            promisedUsdc,
            budgetWeth < promisedWeth ? budgetWeth : promisedWeth,
            budgetUsdc < promisedUsdc ? budgetUsdc : promisedUsdc,
        ));
    }
    return out;
}

export async function dock(s: { hash: string }): Promise<void> {
    await actionLatency();
    ledger.delete(s.hash);
}

/// A taker buying WETH out of the strategy, same shape as doca.ts's marketFill. WETH-out is
/// priced off an internal reference (never surfaced in the UI, see the constant above) and
/// biased per strategy so the round-robin stress flow reproduces the recorded narrative: one
/// strategy runs low, the other two stay comfortably inside their budgets.
export async function marketFill(s: { hash: string }, usdcAmount: bigint): Promise<{ ok: boolean; reason?: string }> {
    await actionLatency();
    const l = ledger.get(s.hash);
    if (!l) return { ok: false, reason: "replay: unknown strategy" };
    if (l.balWeth <= 0n) return { ok: false, reason: "strategy inventory exhausted" };

    const idx = Array.from(ledger.keys()).indexOf(s.hash);
    const bias = DRAIN_BIAS_1000[idx] ?? DEFAULT_BIAS_1000;
    const baseOut = (usdcAmount * 10n ** 12n) / REPLAY_REFERENCE_PRICE_USDC_PER_WETH;
    const wethOut = (baseOut * bias) / 1000n;
    const actualOut = wethOut > l.balWeth ? l.balWeth : wethOut;

    l.balWeth -= actualOut;
    l.balUsdc += usdcAmount;
    wallet = { weth: wallet.weth > actualOut ? wallet.weth - actualOut : 0n, usdc: wallet.usdc + usdcAmount };
    return { ok: true };
}

/// The user spending from the same wallet while it is earning. Purely a wallet-balance move,
/// same as doca.ts: strategies never custody tokens, so docking is unaffected.
export async function spendWeth(amount: bigint): Promise<void> {
    await actionLatency();
    wallet = { ...wallet, weth: wallet.weth > amount ? wallet.weth - amount : 0n };
}
