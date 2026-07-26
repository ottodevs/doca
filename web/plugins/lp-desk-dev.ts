// SPDX-License-Identifier: MIT
//
// Dev-only: Uniswap Trading API proxy + subgraph history poller/API for LP Desk.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import {
    appendPositionTick,
    readPositionHistory,
    type PositionTick,
    type StoredBasis,
} from "../scripts/spot-history";
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

function parseBody(req: { on: (e: string, cb: (chunk?: Buffer) => void) => void }): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => { if (c) chunks.push(c); });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
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
                res: { setHeader: (k: string, v: string) => void; end: (b: string) => void; statusCode?: number },
            ) => {
                const { ticks, bases } = readPositionHistory();
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ ticks, bases, hours: hoursFromTicks(ticks) }));
            };

            const handlePositionHistory = async (
                req: {
                    method?: string;
                    on: (e: string, cb: (chunk?: Buffer) => void) => void;
                },
                res: {
                    setHeader: (k: string, v: string) => void;
                    end: (b: string) => void;
                    statusCode: number;
                },
            ) => {
                if (req.method === "POST") {
                    try {
                        const raw = await parseBody(req);
                        const parsed = JSON.parse(raw || "{}") as {
                            tick?: PositionTick;
                            bases?: StoredBasis[];
                        };
                        const tick = parsed.tick;
                        if (
                            !tick
                            || typeof tick.at !== "number"
                            || !(tick.usdcPerWeth > 0)
                        ) {
                            res.statusCode = 400;
                            res.setHeader("Content-Type", "application/json");
                            res.end(JSON.stringify({ error: "tick with at + usdcPerWeth required" }));
                            return;
                        }
                        const normalized: PositionTick = {
                            at: tick.at,
                            usdcPerWeth: tick.usdcPerWeth,
                            routing: tick.routing ?? "client",
                            wethLeft: Number(tick.wethLeft) || 0,
                            usdcLeft: Number(tick.usdcLeft) || 0,
                            holdWeth: Number(tick.holdWeth) || 0,
                            holdUsdc: Number(tick.holdUsdc) || 0,
                            positionUsdc: typeof tick.positionUsdc === "number"
                                ? tick.positionUsdc
                                : (Number(tick.wethLeft) || 0) * tick.usdcPerWeth + (Number(tick.usdcLeft) || 0),
                            holdUsdcValue: typeof tick.holdUsdcValue === "number"
                                ? tick.holdUsdcValue
                                : (Number(tick.holdWeth) || 0) * tick.usdcPerWeth + (Number(tick.holdUsdc) || 0),
                            pnlUsdc: typeof tick.pnlUsdc === "number" ? tick.pnlUsdc : 0,
                            strategyCount: Number(tick.strategyCount) || 0,
                        };
                        if (typeof normalized.pnlUsdc !== "number" || Number.isNaN(normalized.pnlUsdc)) {
                            normalized.pnlUsdc = normalized.positionUsdc - normalized.holdUsdcValue;
                        }
                        const bases = parsed.bases ?? readPositionHistory().bases;
                        const stored = appendPositionTick(normalized, bases);
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(JSON.stringify({
                            ok: true,
                            ticks: stored.ticks,
                            bases: stored.bases,
                            hours: hoursFromTicks(stored.ticks),
                        }));
                    } catch (e: any) {
                        res.statusCode = 500;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
                    }
                    return;
                }
                sendHistory(req, res);
            };

            server.middlewares.use("/api/spot-history", (req, res, next) => {
                if (req.method === "POST") {
                    void handlePositionHistory(req as any, res as any);
                    return;
                }
                sendHistory(req, res);
            });
            server.middlewares.use("/api/position-history", (req, res) => {
                void handlePositionHistory(req as any, res as any);
            });

            return () => {
                poller?.stop();
                poller = undefined;
            };
        },
    };
}
