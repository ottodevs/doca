// SPDX-License-Identifier: MIT
//
// Uniswap v3 Base subgraph → 1-week hourly price history + occasional fork position snapshot.
// No Trading-API polling — subgraph already indexes candles.
//
//   cd web && bun run scripts/spot-poller.ts
//   (also auto-started by Vite `npm run dev`)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers, type EventLog, type Log } from "ethers";
import {
    appendPositionTick,
    mergeSubgraphHours,
    readPositionHistory,
    type PositionTick,
    type StoredBasis,
} from "./spot-history";
import { fetchWethUsdcHourly, fetchWethUsdcSubgraphSpot } from "./uniswap-subgraph";

const AQUA_ABI = [
    "function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
    "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)",
    "event Docked(address maker, address app, bytes32 strategyHash)",
    "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
];

/** Default: refresh once per hour (matches PoolHourData granularity). */
const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

export type PollerHandle = { stop: () => void };

type Deployment = {
    chainId?: number;
    forkBlock: number;
    rpcUrl: string;
    aqua: string;
    router: string;
    weth: string;
    usdc: string;
    maker: string;
};

function loadDeployment(): Deployment {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.resolve(here, "..", "src", "deployment.json");
    return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

function rpcUrl(d: Deployment): string {
    return process.env.RPC_URL || d.rpcUrl || "http://127.0.0.1:8545";
}

async function loadActivePositions(d: Deployment): Promise<{
    bases: StoredBasis[];
    wethLeft: number;
    usdcLeft: number;
    holdWeth: number;
    holdUsdc: number;
    strategyCount: number;
}> {
    const provider = new ethers.JsonRpcProvider(rpcUrl(d), d.chainId || 8453, { staticNetwork: true });
    const aqua = new ethers.Contract(d.aqua, AQUA_ABI, provider);
    const maker = d.maker.toLowerCase();
    const app = d.router.toLowerCase();
    const fromBlock = d.forkBlock ?? 0;

    const isEvent = (e: Log | EventLog): e is EventLog => "args" in e && e.args != null;

    const [shippedRaw, dockedRaw, pushedRaw] = await Promise.all([
        aqua.queryFilter(aqua.filters.Shipped(), fromBlock),
        aqua.queryFilter(aqua.filters.Docked(), fromBlock),
        aqua.queryFilter(aqua.filters.Pushed(), fromBlock),
    ]);
    const shipped = shippedRaw.filter(isEvent);
    const docked = dockedRaw.filter(isEvent);
    const pushed = pushedRaw.filter(isEvent);

    const dockedHashes = new Set(
        docked
            .filter((e) => String(e.args.maker).toLowerCase() === maker && String(e.args.app).toLowerCase() === app)
            .map((e) => String(e.args.strategyHash).toLowerCase()),
    );

    const initial: Record<string, { weth: number; usdc: number; shippedAt: number }> = {};
    for (const e of pushed) {
        if (String(e.args.maker).toLowerCase() !== maker) continue;
        if (String(e.args.app).toLowerCase() !== app) continue;
        const hash = String(e.args.strategyHash).toLowerCase();
        if (dockedHashes.has(hash)) continue;
        const token = String(e.args.token).toLowerCase();
        const amount = Number(e.args.amount);
        const slot = initial[hash] ?? { weth: 0, usdc: 0, shippedAt: Date.now() };
        if (token === d.weth.toLowerCase() && slot.weth === 0) slot.weth = amount / 1e18;
        if (token === d.usdc.toLowerCase() && slot.usdc === 0) slot.usdc = amount / 1e6;
        initial[hash] = slot;
    }

    const prevBases = readPositionHistory().bases;
    const prevByHash = new Map(prevBases.map((b) => [b.hash.toLowerCase(), b]));

    const activeHashes: string[] = [];
    for (const e of shipped) {
        if (String(e.args.maker).toLowerCase() !== maker) continue;
        if (String(e.args.app).toLowerCase() !== app) continue;
        const hash = String(e.args.strategyHash);
        if (dockedHashes.has(hash.toLowerCase())) continue;
        activeHashes.push(hash);
        const key = hash.toLowerCase();
        if (!initial[key]) initial[key] = { weth: 0, usdc: 0, shippedAt: Date.now() };
        const prev = prevByHash.get(key);
        if (prev) {
            initial[key]!.shippedAt = prev.shippedAt;
            if (initial[key]!.weth === 0) initial[key]!.weth = prev.weth;
            if (initial[key]!.usdc === 0) initial[key]!.usdc = prev.usdc;
        }
    }

    let wethLeft = 0;
    let usdcLeft = 0;
    for (const hash of activeHashes) {
        const [rawW, rawU] = await Promise.all([
            aqua.rawBalances(d.maker, d.router, hash, d.weth),
            aqua.rawBalances(d.maker, d.router, hash, d.usdc),
        ]);
        wethLeft += Number(ethers.formatEther(rawW[0]));
        usdcLeft += Number(ethers.formatUnits(rawU[0], 6));
        const inv = initial[hash.toLowerCase()]!;
        if (inv.weth === 0 && inv.usdc === 0) {
            inv.weth = Number(ethers.formatEther(rawW[0]));
            inv.usdc = Number(ethers.formatUnits(rawU[0], 6));
        }
    }

    const bases: StoredBasis[] = activeHashes.map((hash) => {
        const inv = initial[hash.toLowerCase()]!;
        return {
            hash,
            weth: inv.weth,
            usdc: inv.usdc,
            shippedAt: inv.shippedAt || Date.now(),
        };
    });

    return {
        bases,
        wethLeft,
        usdcLeft,
        holdWeth: bases.reduce((n, b) => n + b.weth, 0),
        holdUsdc: bases.reduce((n, b) => n + b.usdc, 0),
        strategyCount: activeHashes.length,
    };
}

/** Pull latest week of PoolHourData, then one fork position mark at subgraph spot. */
export async function refreshOnce(d = loadDeployment(), log = false): Promise<{ hours: number; ticks: number }> {
    const hours = await fetchWethUsdcHourly({ hours: 168 });

    let bases = readPositionHistory().bases;
    let posTick: PositionTick | null = null;
    try {
        const spot = await fetchWethUsdcSubgraphSpot();
        const pos = await loadActivePositions(d);
        bases = pos.bases;
        if (pos.strategyCount > 0) {
            const positionUsdc = pos.wethLeft * spot.usdcPerWeth + pos.usdcLeft;
            const holdUsdcValue = pos.holdWeth * spot.usdcPerWeth + pos.holdUsdc;
            posTick = {
                at: spot.at,
                usdcPerWeth: spot.usdcPerWeth,
                routing: "subgraph",
                wethLeft: pos.wethLeft,
                usdcLeft: pos.usdcLeft,
                holdWeth: pos.holdWeth,
                holdUsdc: pos.holdUsdc,
                positionUsdc,
                holdUsdcValue,
                pnlUsdc: positionUsdc - holdUsdcValue,
                strategyCount: pos.strategyCount,
            };
        }
    } catch (e: any) {
        if (log) console.warn(`[spot-poller] fork snapshot: ${e?.message ?? e}`);
    }

    const { ticks } = mergeSubgraphHours(hours, bases);
    if (posTick) appendPositionTick(posTick, bases);

    if (log) {
        const latest = readPositionHistory().ticks.at(-1);
        console.log(
            `[spot-poller] subgraph hours=${hours.length}  ticks=${ticks.length}`
            + (latest
                ? `  spot=$${latest.usdcPerWeth.toFixed(2)}  pos=$${latest.positionUsdc.toFixed(2)}`
                : ""),
        );
    }

    return { hours: hours.length, ticks: readPositionHistory().ticks.length };
}

/** @deprecated use refreshOnce */
export async function pollOnce(d = loadDeployment()) {
    await refreshOnce(d);
    return readPositionHistory().ticks.at(-1)!;
}

export function startSpotPoller(opts?: { intervalMs?: number; log?: boolean }): PollerHandle {
    const intervalMs = opts?.intervalMs
        ?? Number(process.env.SPOT_POLL_MS || process.env.SUBGRAPH_REFRESH_MS || DEFAULT_REFRESH_MS);
    const log = opts?.log ?? true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const d = loadDeployment();

    const run = async () => {
        if (stopped) return;
        try {
            await refreshOnce(d, log);
        } catch (e: any) {
            console.warn(`[spot-poller] ${e?.message ?? e}`);
        } finally {
            if (!stopped) timer = setTimeout(run, intervalMs);
        }
    };

    if (log) {
        console.log(`[spot-poller] Uniswap v3 Base subgraph — refresh every ${Math.round(intervalMs / 60_000)}m`);
        console.log(`[spot-poller] rpc=${rpcUrl(d)}  existing ticks=${readPositionHistory().ticks.length}`);
    }
    void run();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (log) console.log("[spot-poller] stopped");
        },
    };
}

const isMain = typeof process !== "undefined"
    && process.argv[1]
    && (process.argv[1].endsWith("spot-poller.ts") || process.argv[1].endsWith("spot-poller.js"));

if (isMain) {
    const handle = startSpotPoller();
    process.on("SIGINT", () => { handle.stop(); process.exit(0); });
    process.on("SIGTERM", () => { handle.stop(); process.exit(0); });
}
