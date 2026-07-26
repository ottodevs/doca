// SPDX-License-Identifier: MIT
//
// Dev-only: Uniswap Trading API proxy + subgraph history poller/API for LP Desk.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import { readPositionHistory } from "../scripts/spot-history";
import { startSpotPoller, type PollerHandle } from "../scripts/spot-poller";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ENV_KEYS = [
    "UNISWAP_API",
    "UNISWAP_API_KEY",
    "THE_GRAPH_API_KEY",
    "GRAPH_API_KEY",
    "SPOT_POLL_MS",
    "SUBGRAPH_REFRESH_MS",
    "RPC_URL",
] as const;

function applyEnv(env: Record<string, string>) {
    for (const key of ENV_KEYS) {
        if (env[key]) process.env[key] = env[key];
    }
}

function hoursFromTicks(ticks: { at: number; usdcPerWeth: number }[]) {
    const hoursMap = new Map<number, number>();
    for (const t of ticks) {
        if (!(t.usdcPerWeth > 0)) continue;
        const hour = Math.floor(t.at / 3_600_000) * 3_600_000;
        hoursMap.set(hour, t.usdcPerWeth);
    }
    return [...hoursMap.entries()]
        .map(([at, usdcPerWeth]) => ({ at, usdcPerWeth }))
        .sort((a, b) => a.at - b.at);
}

/** Uniswap CORS proxy + `/api/position-history` + subgraph poller. */
export function lpDeskDevPlugin(): Plugin {
    let env: Record<string, string> = {};
    let poller: PollerHandle | undefined;

    return {
        name: "lp-desk-dev",
        config(_user, { mode }) {
            env = loadEnv(mode, rootDir, "");
            const apiKey = env.UNISWAP_API || env.UNISWAP_API_KEY || "";
            return {
                envDir: rootDir,
                server: {
                    proxy: {
                        "/api/uniswap": {
                            target: "https://trade-api.gateway.uniswap.org/v1",
                            changeOrigin: true,
                            rewrite: (p) => p.replace(/^\/api\/uniswap/, ""),
                            configure: (proxy) => {
                                proxy.on("proxyReq", (proxyReq) => {
                                    if (apiKey) proxyReq.setHeader("x-api-key", apiKey);
                                    proxyReq.setHeader("x-universal-router-version", "2.0");
                                });
                            },
                        },
                    },
                },
            };
        },
        configureServer(server) {
            applyEnv(env);

            try {
                poller = startSpotPoller({
                    intervalMs: Number(env.SUBGRAPH_REFRESH_MS || env.SPOT_POLL_MS || 3_600_000),
                    log: true,
                });
            } catch (e: any) {
                console.warn(`[spot-poller] not started: ${e?.message ?? e}`);
            }

            const sendHistory = (
                _req: unknown,
                res: { setHeader: (k: string, v: string) => void; end: (b: string) => void },
            ) => {
                const { ticks, bases } = readPositionHistory();
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ticks, bases, hours: hoursFromTicks(ticks) }));
            };
            server.middlewares.use("/api/spot-history", sendHistory);
            server.middlewares.use("/api/position-history", sendHistory);

            return () => {
                poller?.stop();
                poller = undefined;
            };
        },
    };
}
