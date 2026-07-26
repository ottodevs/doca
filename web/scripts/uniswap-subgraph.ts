// SPDX-License-Identifier: MIT
//
// Uniswap v3 Base subgraph via The Graph gateway.
// Docs: https://developers.uniswap.org/docs/ecosystem/subgraphs/overview
// Base deployment: https://thegraph.com/explorer/subgraphs/43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG
import { WEEK_MS } from "./spot-history";

export const BASE_V3_SUBGRAPH_ID = "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG";

export const BASE_WETH_USDC_POOL = "0x6c561b446416e1a00e8e93e221854d6ea4171372";

export type SubgraphHour = {
    at: number;
    usdcPerWeth: number;
    open: number;
    high: number;
    low: number;
    close: number;
};

function graphKey(): string {
    return process.env.THE_GRAPH_API_KEY
        || process.env.GRAPH_API_KEY
        || "";
}

export function subgraphEndpoint(subgraphId = BASE_V3_SUBGRAPH_ID): string {
    const key = graphKey();
    if (!key) throw new Error("THE_GRAPH_API_KEY missing: set it in the repo .env");
    return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${subgraphId}`;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(subgraphEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json() as { data?: T; errors?: { message: string }[] };
    if (!res.ok || json.errors?.length) {
        throw new Error(json.errors?.[0]?.message || `subgraph HTTP ${res.status}`);
    }
    if (!json.data) throw new Error("subgraph returned empty data");
    return json.data;
}

/**
 * Fetch up to one week of hourly WETH→USDC closes from Uniswap v3 Base.
 * Uses PoolHourData.token1Price (USDC per WETH for the canonical pool).
 */
export async function fetchWethUsdcHourly(opts?: {
    pool?: string;
    /** Hours to fetch (default 168 = 1 week). Max ~1000 per request. */
    hours?: number;
}): Promise<SubgraphHour[]> {
    const pool = (opts?.pool || BASE_WETH_USDC_POOL).toLowerCase();
    const hours = Math.min(opts?.hours ?? 168, 1000);
    const since = Math.floor((Date.now() - WEEK_MS) / 1000);

    const data = await gql<{
        poolHourDatas: {
            periodStartUnix: number;
            token0Price: string;
            token1Price: string;
            open: string;
            high: string;
            low: string;
            close: string;
        }[];
    }>(
        `query Hours($pool: String!, $since: Int!, $first: Int!) {
          poolHourDatas(
            first: $first
            orderBy: periodStartUnix
            orderDirection: asc
            where: { pool: $pool, periodStartUnix_gte: $since }
          ) {
            periodStartUnix
            token0Price
            token1Price
            open
            high
            low
            close
          }
        }`,
        { pool, since, first: hours },
    );

    return data.poolHourDatas.map((h) => {
        const usdcPerWeth = Number(h.token1Price);
        return {
            at: h.periodStartUnix * 1000,
            usdcPerWeth,
            // OHLC fields are token0 prices (WETH per USDC); invert for USDC/WETH display.
            open: Number(h.open) > 0 ? 1 / Number(h.open) : usdcPerWeth,
            high: Number(h.low) > 0 ? 1 / Number(h.low) : usdcPerWeth, // inverted
            low: Number(h.high) > 0 ? 1 / Number(h.high) : usdcPerWeth,
            close: Number(h.close) > 0 ? 1 / Number(h.close) : usdcPerWeth,
        };
    }).filter((h) => Number.isFinite(h.usdcPerWeth) && h.usdcPerWeth > 0);
}

/** Live mid from the same pool (subgraph spot), useful as Trading-API fallback. */
export async function fetchWethUsdcSubgraphSpot(): Promise<{ at: number; usdcPerWeth: number; routing: string }> {
    const data = await gql<{
        pool: { token1Price: string } | null;
    }>(
        `query Spot($id: ID!) {
          pool(id: $id) { token1Price }
        }`,
        { id: BASE_WETH_USDC_POOL.toLowerCase() },
    );
    const usdcPerWeth = Number(data.pool?.token1Price);
    if (!Number.isFinite(usdcPerWeth) || usdcPerWeth <= 0) {
        throw new Error("subgraph pool missing token1Price");
    }
    return { at: Date.now(), usdcPerWeth, routing: "subgraph" };
}
