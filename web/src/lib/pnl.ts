// SPDX-License-Identifier: MIT
//
// Position vs HOLD series for LP Desk (Beefy CLM-style).
// HOLD     = deposit inventory × real Base Uniswap spot
// Position = current inventory × local fork implied spot (tip); history uses real spots
import type { LiveStrategy } from "./lp-desk";
import { d } from "./lp-desk";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = `doca-pnl-v2-${d.maker}-${d.router}`.toLowerCase();

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

export type PnlSample = {
    at: number;
    /** Real Base spot (USDC/WETH) used for HOLD. */
    spot: number;
    /** Fork implied spot used for Position at the tip, if available. */
    forkSpot?: number;
    positionUsdc: number;
    holdUsdc: number;
    pnlUsdc: number;
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

/**
 * Build Position vs HOLD from hourly Uniswap spots.
 * Historical points mark both inventories at real Base spots.
 * Tip (if given) marks HOLD at realSpot and Position at forkSpot.
 *
 * Always plots the available Uniswap hour window (not only post-deposit).
 * Fresh ships often have zero post-deposit candles because hours are bucketed
 * to the hour floor, which can sit behind `shippedAt`.
 */
export function buildPnlSeries(
    hours: SpotHour[],
    hold: { weth: number; usdc: number; since?: number },
    position: { weth: number; usdc: number },
    tipReal?: SpotHour | null,
    tipFork?: SpotHour | null,
): PnlSample[] {
    if (!(hold.weth > 0 || hold.usdc > 0)) return [];

    const sortedHours = [...hours].filter((h) => h.usdcPerWeth > 0).sort((a, b) => a.at - b.at);
    const real = tipReal && tipReal.usdcPerWeth > 0 ? tipReal : null;
    const fork = tipFork && tipFork.usdcPerWeth > 0 ? tipFork : null;
    if (sortedHours.length === 0 && !real) return [];

    const samples: PnlSample[] = sortedHours.map((h) => {
        const holdUsdc = hold.weth * h.usdcPerWeth + hold.usdc;
        const positionUsdc = position.weth * h.usdcPerWeth + position.usdc;
        return {
            at: h.at,
            spot: h.usdcPerWeth,
            holdUsdc,
            positionUsdc,
            pnlUsdc: positionUsdc - holdUsdc,
        };
    });

    if (real) {
        const holdUsdc = hold.weth * real.usdcPerWeth + hold.usdc;
        const forkPx = fork?.usdcPerWeth ?? real.usdcPerWeth;
        const positionUsdc = position.weth * forkPx + position.usdc;
        const tipAt = Math.max(real.at, fork?.at ?? real.at, samples.at(-1)?.at ?? real.at);
        // Replace same-bucket tip rather than duplicating the last hour.
        if (samples.length && Math.abs(samples[samples.length - 1]!.at - tipAt) < 60_000) {
            samples.pop();
        }
        samples.push({
            at: tipAt,
            spot: real.usdcPerWeth,
            forkSpot: fork ? forkPx : undefined,
            holdUsdc,
            positionUsdc,
            pnlUsdc: positionUsdc - holdUsdc,
        });
    }

    // Need ≥2 points to draw a line — synthesize a flat prior if we only have a tip.
    if (samples.length === 1) {
        const only = samples[0]!;
        samples.unshift({ ...only, at: only.at - HOUR_MS, forkSpot: undefined });
    }

    return samples.sort((a, b) => a.at - b.at);
}

const HOUR_MS = 3_600_000;

export function samplesEqual(a: PnlSample[], b: PnlSample[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (
            x.at !== y.at
            || Math.abs(x.spot - y.spot) > 1e-4
            || Math.abs((x.forkSpot ?? x.spot) - (y.forkSpot ?? y.spot)) > 1e-4
            || Math.abs(x.positionUsdc - y.positionUsdc) > 0.05
            || Math.abs(x.holdUsdc - y.holdUsdc) > 0.05
        ) {
            return false;
        }
    }
    return true;
}

/** Pull hourly Uniswap spots from the Vite history API. */
export async function fetchSpotHours(): Promise<SpotHour[]> {
    try {
        const res = await fetch("/api/position-history", { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json() as {
            ticks?: { at: number; usdcPerWeth: number }[];
            hours?: SpotHour[];
        };
        if (data.hours?.length) return data.hours;
        const seen = new Map<number, SpotHour>();
        for (const t of data.ticks ?? []) {
            if (!(t.usdcPerWeth > 0)) continue;
            // Bucket to the hour so duplicate poll ticks collapse.
            const hour = Math.floor(t.at / 3_600_000) * 3_600_000;
            seen.set(hour, { at: hour, usdcPerWeth: t.usdcPerWeth });
        }
        return [...seen.values()].sort((a, b) => a.at - b.at);
    } catch {
        return [];
    }
}
