// SPDX-License-Identifier: MIT
//
// Server-side Uniswap spot + fork position history (rolling 1 week).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One poll sample: live Uniswap spot + fork LP inventory. */
export type PositionTick = {
    at: number;
    usdcPerWeth: number;
    routing?: string;
    /** Sum of Aqua rawBalances across active strategies (human units). */
    wethLeft: number;
    usdcLeft: number;
    /** Hold inventory (initial promises) still active at this tick. */
    holdWeth: number;
    holdUsdc: number;
    positionUsdc: number;
    holdUsdcValue: number;
    pnlUsdc: number;
    strategyCount: number;
};

export type StoredBasis = {
    hash: string;
    weth: number;
    usdc: number;
    shippedAt: number;
};

type Stored = {
    bases: StoredBasis[];
    ticks: PositionTick[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_PATH = path.resolve(here, "..", ".data", "spot-history.json");

export function ensureDataDir() {
    mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
}

function readRaw(): Stored {
    try {
        if (!existsSync(HISTORY_PATH)) return { bases: [], ticks: [] };
        const raw = JSON.parse(readFileSync(HISTORY_PATH, "utf8")) as Partial<Stored> & { ticks?: any[] };
        // Migrate old spot-only ticks (no position fields).
        const ticks = (raw.ticks ?? [])
            .map((t: any): PositionTick | null => {
                if (typeof t?.at !== "number" || typeof t?.usdcPerWeth !== "number") return null;
                if (typeof t.positionUsdc === "number") return t as PositionTick;
                return {
                    at: t.at,
                    usdcPerWeth: t.usdcPerWeth,
                    routing: t.routing,
                    wethLeft: 0,
                    usdcLeft: 0,
                    holdWeth: 0,
                    holdUsdc: 0,
                    positionUsdc: 0,
                    holdUsdcValue: 0,
                    pnlUsdc: 0,
                    strategyCount: 0,
                };
            })
            .filter(Boolean) as PositionTick[];
        return { bases: raw.bases ?? [], ticks };
    } catch {
        return { bases: [], ticks: [] };
    }
}

export function readPositionHistory(): Stored {
    const stored = readRaw();
    const cutoff = Date.now() - WEEK_MS;
    return {
        bases: stored.bases,
        ticks: stored.ticks.filter((t) => t.at >= cutoff),
    };
}

/** @deprecated use readPositionHistory */
export function readSpotHistory() {
    return readPositionHistory().ticks.map((t) => ({
        at: t.at,
        usdcPerWeth: t.usdcPerWeth,
        routing: t.routing,
    }));
}

export function writePositionHistory(bases: StoredBasis[], ticks: PositionTick[]) {
    ensureDataDir();
    const cutoff = Date.now() - WEEK_MS;
    const trimmed = ticks.filter((t) => t.at >= cutoff).sort((a, b) => a.at - b.at);
    const payload: Stored = { bases, ticks: trimmed };
    writeFileSync(HISTORY_PATH, JSON.stringify(payload, null, 2) + "\n");
    return payload;
}

export function appendPositionTick(tick: PositionTick, bases: StoredBasis[]) {
    const stored = readPositionHistory();
    const last = stored.ticks[stored.ticks.length - 1];
    if (
        last
        && Math.abs(last.at - tick.at) < 15_000
        && Math.abs(last.usdcPerWeth - tick.usdcPerWeth) < 0.01
        && Math.abs(last.positionUsdc - tick.positionUsdc) < 0.05
        && Math.abs((last.wethLeft ?? 0) - (tick.wethLeft ?? 0)) < 1e-9
        && Math.abs((last.usdcLeft ?? 0) - (tick.usdcLeft ?? 0)) < 1e-6
    ) {
        return writePositionHistory(bases, stored.ticks);
    }
    return writePositionHistory(bases, [...stored.ticks, tick]);
}

/**
 * Seed / refresh hourly Uniswap subgraph candles into history.
 * Keeps existing poller ticks that carry real fork position balances.
 */
export function mergeSubgraphHours(
    hours: { at: number; usdcPerWeth: number }[],
    bases?: StoredBasis[],
): Stored {
    const stored = readPositionHistory();
    const nextBases = bases ?? stored.bases;
    const kept = stored.ticks.filter((t) => (t.strategyCount ?? 0) > 0 || t.routing !== "subgraph");

    const holdWeth = nextBases.reduce((n, b) => n + b.weth, 0);
    const holdUsdc = nextBases.reduce((n, b) => n + b.usdc, 0);

    const fromSubgraph: PositionTick[] = hours.map((h) => {
        const holdUsdcValue = holdWeth * h.usdcPerWeth + holdUsdc;
        return {
            at: h.at,
            usdcPerWeth: h.usdcPerWeth,
            routing: "subgraph",
            wethLeft: 0,
            usdcLeft: 0,
            holdWeth,
            holdUsdc,
            positionUsdc: 0,
            holdUsdcValue,
            pnlUsdc: 0,
            strategyCount: 0,
        };
    });

    // Drop subgraph hours that sit near a denser poller sample (±20 min).
    const filtered = fromSubgraph.filter((h) =>
        !kept.some((t) => Math.abs(t.at - h.at) < 20 * 60_000)
    );

    return writePositionHistory(nextBases, [...kept, ...filtered]);
}
