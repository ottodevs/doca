// SPDX-License-Identifier: MIT
//
// Position vs HOLD series for LP Desk (Beefy CLM-style).
// HOLD     = deposit inventory × real Base Uniswap spot
// Position = deposit × spot before ship; carry-forward Aqua inventory × same L1 spot after
// Price axis keeps the full Uniswap hour history so the chart still has shape on a fresh ship.
import type { LiveStrategy } from "./lp-desk";
import { d } from "./lp-desk";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = `plimsoll-pnl-v2-${d.maker}-${d.router}`.toLowerCase();
const HOUR_MS = 3_600_000;

export type PositionBasis = {
    hash: string;
    weth: string;
    usdc: string;
    shippedAt: number;
};

export type PositionBasisLive = {
    hash: string;
    weth: bigint;
    usdc: bigint;
    shippedAt: number;
};

export type SpotHour = {
    at: number;
    usdcPerWeth: number;
};

/** Server / client history tick (price and optional Aqua balances). */
export type PositionHistoryTick = {
    at: number;
    usdcPerWeth: number;
    wethLeft?: number;
    usdcLeft?: number;
    holdWeth?: number;
    holdUsdc?: number;
    positionUsdc?: number;
    holdUsdcValue?: number;
    pnlUsdc?: number;
    strategyCount?: number;
    routing?: string;
};

export type PnlSample = {
    at: number;
    /** Real Base spot (USDC/WETH) used for both HOLD and Position. */
    spot: number;
    positionUsdc: number;
    holdUsdc: number;
    pnlUsdc: number;
    /** Aqua inventory marked at this sample (human units). */
    wethLeft?: number;
    usdcLeft?: number;
};

type Stored = {
    bases: PositionBasis[];
};

function toStored(b: PositionBasisLive): PositionBasis {
    return {
        hash: b.hash,
        weth: b.weth.toString(),
        usdc: b.usdc.toString(),
        shippedAt: b.shippedAt,
    };
}

function fromStored(b: PositionBasis): PositionBasisLive {
    return {
        hash: b.hash,
        weth: BigInt(b.weth),
        usdc: BigInt(b.usdc),
        shippedAt: b.shippedAt,
    };
}

export function loadPersistedBases(): PositionBasisLive[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Stored & { samples?: unknown };
        return (parsed.bases ?? []).map(fromStored);
    } catch {
        return [];
    }
}

export function persistBases(bases: PositionBasisLive[]) {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ bases: bases.map(toStored) }));
}

export function basisFromLive(s: LiveStrategy): PositionBasisLive {
    return {
        hash: s.hash,
        weth: s.promisedWeth > 0n ? s.promisedWeth : s.wethLeft,
        usdc: s.promisedUsdc > 0n ? s.promisedUsdc : s.usdcLeft,
        shippedAt: Date.now(),
    };
}

export function dropBasis(bases: PositionBasisLive[], hash: string): PositionBasisLive[] {
    return bases.filter((b) => b.hash.toLowerCase() !== hash.toLowerCase());
}

export function reconcileBases(
    live: LiveStrategy[],
    existing: PositionBasisLive[],
): PositionBasisLive[] {
    const liveHashes = new Set(live.map((s) => s.hash.toLowerCase()));
    const kept = existing.filter((b) => liveHashes.has(b.hash.toLowerCase()));
    const have = new Set(kept.map((b) => b.hash.toLowerCase()));
    for (const s of live) {
        if (have.has(s.hash.toLowerCase())) continue;
        kept.push(basisFromLive(s));
    }
    return kept;
}

function human(weth: bigint, usdc: bigint): { weth: number; usdc: number } {
    return {
        weth: Number(weth) / 1e18,
        usdc: Number(usdc) / 1e6,
    };
}

export function sumHold(bases: PositionBasisLive[]): { weth: number; usdc: number; since: number } {
    if (bases.length === 0) return { weth: 0, usdc: 0, since: Date.now() };
    let weth = 0;
    let usdc = 0;
    let since = Infinity;
    for (const b of bases) {
        const h = human(b.weth, b.usdc);
        weth += h.weth;
        usdc += h.usdc;
        since = Math.min(since, b.shippedAt);
    }
    return { weth, usdc, since: Number.isFinite(since) ? since : Date.now() };
}

export function sumPosition(live: LiveStrategy[]): { weth: number; usdc: number } {
    let weth = 0;
    let usdc = 0;
    for (const s of live) {
        weth += Number(s.wethLeft) / 1e18;
        usdc += Number(s.usdcLeft) / 1e6;
    }
    return { weth, usdc };
}

function isBalanceTick(t: PositionHistoryTick): boolean {
    if ((t.strategyCount ?? 0) > 0) return true;
    return (t.wethLeft ?? 0) > 0 || (t.usdcLeft ?? 0) > 0;
}

function markSample(
    at: number,
    spot: number,
    hold: { weth: number; usdc: number },
    inv: { weth: number; usdc: number },
): PnlSample {
    const holdUsdc = hold.weth * spot + hold.usdc;
    const positionUsdc = inv.weth * spot + inv.usdc;
    return {
        at,
        spot,
        holdUsdc,
        positionUsdc,
        pnlUsdc: positionUsdc - holdUsdc,
        wethLeft: inv.weth,
        usdcLeft: inv.usdc,
    };
}

/** Spot at or nearest to `at` from sorted price hours (prefer ≤ at, else next). */
function spotAt(hours: SpotHour[], at: number, fallback?: number | null): number | null {
    if (fallback != null && fallback > 0 && hours.length === 0) return fallback;
    let best: SpotHour | null = null;
    for (const h of hours) {
        if (h.at <= at) best = h;
        else break;
    }
    if (best) return best.usdcPerWeth;
    if (hours[0]) return hours[0].usdcPerWeth;
    return fallback != null && fallback > 0 ? fallback : null;
}

/**
 * Build Position vs HOLD series.
 * Price axis = full L1 hour history (so the chart keeps its shape).
 * Before ship / first inventory tick: Position = HOLD (deposit × spot).
 * After: Position follows carry-forward Aqua inventory; exact-time steps on ship/trade.
 * Both lines marked at the same L1 spot.
 */
export function buildPnlSeries(
    ticks: PositionHistoryTick[],
    hold: { weth: number; usdc: number; since?: number },
    position: { weth: number; usdc: number },
    tipReal?: SpotHour | null,
): PnlSample[] {
    if (!(hold.weth > 0 || hold.usdc > 0)) return [];

    const sorted = [...ticks]
        .filter((t) => t.usdcPerWeth > 0)
        .sort((a, b) => a.at - b.at);

    // Last spot per hour bucket (dense L1 price axis).
    const hourSpot = new Map<number, number>();
    for (const t of sorted) {
        const hour = Math.floor(t.at / HOUR_MS) * HOUR_MS;
        hourSpot.set(hour, t.usdcPerWeth);
    }
    const priceHours: SpotHour[] = [...hourSpot.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([at, usdcPerWeth]) => ({ at, usdcPerWeth }));

    const allBalance = sorted
        .filter(isBalanceTick)
        .map((t) => ({
            at: t.at,
            weth: t.wethLeft ?? 0,
            usdc: t.usdcLeft ?? 0,
            spot: t.usdcPerWeth,
        }));

    // Inventory steps only after the client's ship time. Price hours before that
    // still plot with Position = HOLD so the chart keeps its historical shape.
    const invStart = hold.since && hold.since > 0 ? hold.since : (allBalance[0]?.at ?? 0);

    const balanceSamples = allBalance.filter((b) => b.at >= invStart - 5_000);

    const depositInv = { weth: hold.weth, usdc: hold.usdc };
    const byAt = new Map<number, PnlSample>();

    const push = (s: PnlSample) => {
        byAt.set(s.at, s);
    };

    // Dense price hours: pre-ship Position=HOLD; post-ship carry-forward inventory.
    let inv = { ...depositInv };
    let balIdx = 0;
    for (const h of priceHours) {
        if (h.at >= invStart) {
            while (balIdx < balanceSamples.length && balanceSamples[balIdx]!.at <= h.at) {
                const b = balanceSamples[balIdx]!;
                inv = { weth: b.weth, usdc: b.usdc };
                balIdx++;
            }
        } else {
            inv = { ...depositInv };
        }
        push(markSample(h.at, h.usdcPerWeth, depositInv, inv));
    }

    // Deposit t0 marker (Position = HOLD) when we know ship time.
    if (invStart > 0) {
        const depositSpot = spotAt(
            priceHours,
            invStart,
            tipReal?.usdcPerWeth && tipReal.usdcPerWeth > 0 ? tipReal.usdcPerWeth : null,
        );
        if (depositSpot != null) {
            push(markSample(invStart, depositSpot, depositInv, depositInv));
        }
    }

    // Exact-time balance steps (ship / trade) for sharp inventory changes.
    inv = { ...depositInv };
    for (const b of balanceSamples) {
        inv = { weth: b.weth, usdc: b.usdc };
        push(markSample(b.at, b.spot, depositInv, inv));
    }

    // Live tip at current L1 spot + live inventory.
    const real = tipReal && tipReal.usdcPerWeth > 0 ? tipReal : null;
    if (real) {
        const latestKey = byAt.size ? Math.max(...byAt.keys()) : real.at;
        const tipAt = Math.max(real.at, invStart, latestKey);
        const tip = markSample(tipAt, real.usdcPerWeth, depositInv, position);
        // Replace near-duplicate tip rather than wiping a whole minute of history.
        if (byAt.has(tipAt)) byAt.delete(tipAt);
        else {
            for (const key of [...byAt.keys()]) {
                if (Math.abs(key - tipAt) < 15_000) byAt.delete(key);
            }
        }
        byAt.set(tipAt, tip);
    }

    let samples = [...byAt.values()].sort((a, b) => a.at - b.at);

    // Need ≥2 points to draw a line.
    if (samples.length === 1) {
        const only = samples[0]!;
        samples = [
            markSample(only.at - Math.min(HOUR_MS, 60_000), only.spot, depositInv, depositInv),
            only,
        ];
    }

    return samples;
}

export function samplesEqual(a: PnlSample[], b: PnlSample[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (
            x.at !== y.at
            || Math.abs(x.spot - y.spot) > 1e-4
            || Math.abs(x.positionUsdc - y.positionUsdc) > 0.05
            || Math.abs(x.holdUsdc - y.holdUsdc) > 0.05
        ) {
            return false;
        }
    }
    return true;
}

/** Pull full position history ticks from the Vite API. */
export async function fetchPositionHistory(): Promise<PositionHistoryTick[]> {
    try {
        const res = await fetch("/api/position-history", { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json() as {
            ticks?: PositionHistoryTick[];
            hours?: SpotHour[];
        };
        if (data.ticks?.length) return data.ticks;
        // Fallback: hours-only payload.
        return (data.hours ?? []).map((h) => ({
            at: h.at,
            usdcPerWeth: h.usdcPerWeth,
            strategyCount: 0,
            wethLeft: 0,
            usdcLeft: 0,
        }));
    } catch {
        return [];
    }
}

/** @deprecated use fetchPositionHistory */
export async function fetchSpotHours(): Promise<SpotHour[]> {
    const ticks = await fetchPositionHistory();
    const seen = new Map<number, SpotHour>();
    for (const t of ticks) {
        if (!(t.usdcPerWeth > 0)) continue;
        const hour = Math.floor(t.at / HOUR_MS) * HOUR_MS;
        seen.set(hour, { at: hour, usdcPerWeth: t.usdcPerWeth });
    }
    return [...seen.values()].sort((a, b) => a.at - b.at);
}

export type PostPositionTickInput = {
    at?: number;
    usdcPerWeth: number;
    wethLeft: number;
    usdcLeft: number;
    holdWeth: number;
    holdUsdc: number;
    strategyCount: number;
};

/** Append a live inventory tick (ship / trade / refresh). */
export async function postPositionTick(input: PostPositionTickInput): Promise<boolean> {
    try {
        const at = input.at ?? Date.now();
        const positionUsdc = input.wethLeft * input.usdcPerWeth + input.usdcLeft;
        const holdUsdcValue = input.holdWeth * input.usdcPerWeth + input.holdUsdc;
        const body: PositionHistoryTick = {
            at,
            usdcPerWeth: input.usdcPerWeth,
            routing: "client",
            wethLeft: input.wethLeft,
            usdcLeft: input.usdcLeft,
            holdWeth: input.holdWeth,
            holdUsdc: input.holdUsdc,
            positionUsdc,
            holdUsdcValue,
            pnlUsdc: positionUsdc - holdUsdcValue,
            strategyCount: input.strategyCount,
        };
        const res = await fetch("/api/position-history", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tick: body }),
        });
        return res.ok;
    } catch {
        return false;
    }
}
