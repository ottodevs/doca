// SPDX-License-Identifier: MIT
//
// Doca MCP server: read-only agent surface over the Aqua fork.
//
// Why zero dependencies: every call this server makes is a `view` function with only static
// argument types (address / bytes32), so ABI encoding is four 32-byte words concatenated after a
// 4-byte selector. No encoder needed. Selectors below are precomputed keccak4s of the same
// signatures `web/src/lib/doca.ts` uses (see ABI arrays there); we don't recompute keccak at
// runtime, we just hardcode the well-known result. `bun`'s built-in `fetch` + `Bun.serve` cover
// the rest, so this file has no `bun add` footprint at all.
//
// The server never holds a key: it reads chain state and answers questions. Signing stays with
// whoever owns the wallet, so an agent can be given this endpoint without granting it custody.
//
// Discovery: Aqua's `Shipped` event has no indexed parameters, so `doca_strategies` scans logs by
// topic and decodes the static head of the payload (maker, app, strategyHash) rather than relying
// on an external indexer. `Docked` removes them again, so the tool returns what is actually live.

import deployment from "../web/src/deployment.json";

const RPC_URL = process.env.RPC_URL || deployment.rpcUrl || "http://127.0.0.1:8545";
const PORT = Number(process.env.MCP_PORT || 8420);
const PROTOCOL_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------------------------
// Minimal static-ABI encode/decode + eth_call. Mirrors the exact calls in web/src/lib/doca.ts.
// ---------------------------------------------------------------------------------------------

const SELECTORS = {
    // balanceOf(address)
    balanceOf: "0x70a08231",
    // rawBalances(address,address,bytes32,address), Aqua: maker, app, strategyHash, token
    rawBalances: "0x6d58b4cc",
    // remainingFraction(bytes32,address): InventorySkewProvider
    remainingFraction: "0x8fdc4b85",
    // feeBpsFor(bytes32,address): InventorySkewProvider
    feeBpsFor: "0x2a3d3680",
};

const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const bytes32Word = (h: string) => {
    const s = h.replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`not a bytes32 strategy hash: ${h}`);
    return s.toLowerCase();
};
const words = (hex: string) => {
    const s = hex.replace(/^0x/, "");
    const out: string[] = [];
    for (let i = 0; i < s.length; i += 64) out.push(s.slice(i, i + 64));
    return out;
};
const wordToBigInt = (w?: string) => BigInt("0x" + (w && w.length ? w : "0"));

async function ethCall(to: string, data: string): Promise<string> {
    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) throw new Error(`eth_call ${to} ${data.slice(0, 10)}: ${body.error.message}`);
    return body.result as string;
}

async function erc20BalanceOf(token: string, owner: string): Promise<bigint> {
    const out = await ethCall(token, SELECTORS.balanceOf + addrWord(owner));
    return wordToBigInt(words(out)[0]);
}

async function rawBalances(maker: string, app: string, hash: string, token: string) {
    const data = SELECTORS.rawBalances + addrWord(maker) + addrWord(app) + bytes32Word(hash) + addrWord(token);
    const out = words(await ethCall(deployment.aqua, data));
    return { balance: wordToBigInt(out[0]), tokensCount: wordToBigInt(out[1]) };
}

async function remainingFraction(hash: string, token: string): Promise<bigint> {
    const data = SELECTORS.remainingFraction + bytes32Word(hash) + addrWord(token);
    return wordToBigInt(words(await ethCall(deployment.skewProvider, data))[0]);
}

async function feeBpsFor(hash: string, token: string): Promise<bigint> {
    const data = SELECTORS.feeBpsFor + bytes32Word(hash) + addrWord(token);
    return wordToBigInt(words(await ethCall(deployment.skewProvider, data))[0]);
}

function normalizeHash(h: unknown): string {
    if (typeof h !== "string") throw new Error("strategy hash must be a string");
    return "0x" + bytes32Word(h);
}

// Same constants/formulas as web/src/lib/doca.ts (fmtWeth/fmtUsdc/fmtPct/fmtFee).
const FRAC = 10_000n;
const BPS = 1_000_000_000n;
const fmtWeth = (v: bigint) => (Number(v) / 1e18).toFixed(4);
const fmtUsdc = (v: bigint) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (v: bigint) => (Number(v) / Number(FRAC) * 100).toFixed(1);
const fmtFee = (v: bigint) => (Number(v) / Number(BPS) * 100).toFixed(2);

// Aqua event topics. Precomputed keccak256 of the signatures, same approach as SELECTORS above.
const TOPICS = {
    // Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)
    shipped: "0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0",
    // Docked(address maker, address app, bytes32 strategyHash)
    docked: "0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004",
};

async function rpc(method: string, params: unknown[]): Promise<any> {
    const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await res.json() as any;
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
}

/** Live strategy hashes for a maker: everything shipped, minus everything docked since. */
async function liveStrategies(maker: string, fromBlock: string): Promise<string[]> {
    const [shipped, docked] = await Promise.all([
        rpc("eth_getLogs", [{ address: deployment.aqua, topics: [TOPICS.shipped], fromBlock, toBlock: "latest" }]),
        rpc("eth_getLogs", [{ address: deployment.aqua, topics: [TOPICS.docked], fromBlock, toBlock: "latest" }]),
    ]);
    const mine = (log: any) => words(log.data)[0]?.slice(24) === maker.toLowerCase().replace(/^0x/, "");
    const hashOf = (log: any) => "0x" + words(log.data)[2];
    const gone = new Set(docked.filter(mine).map(hashOf));
    const live: string[] = [];
    for (const log of shipped.filter(mine)) {
        const h = hashOf(log);
        if (!gone.has(h) && !live.includes(h)) live.push(h);
    }
    return live;
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const TOOLS = [
    {
        name: "doca_market",
        description: "Where this server points: chain id, RPC, the canonical Aqua registry and the Doca contracts. Call this first to self-configure.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "doca_strategies",
        description: "Discover a maker's live strategies. Returns the strategy hashes still shipped (docked ones excluded), ready to pass to doca_positions or doca_health.",
        inputSchema: {
            type: "object",
            properties: {
                maker: { type: "string", description: `Address to scan. Defaults to ${deployment.maker}.` },
                fromBlock: { type: "string", description: "Hex or decimal block to scan from. Defaults to the deployment block." },
            },
        },
    },
    {
        name: "doca_wallet",
        description: "A maker's live WETH/USDC wallet balances, read with the same calls the Doca app makes.",
        inputSchema: {
            type: "object",
            properties: {
                maker: { type: "string", description: `Address to read. Defaults to the demo maker (${deployment.maker}).` },
            },
        },
    },
    {
        name: "doca_positions",
        description: "Strategy positions: WETH aboard, budget remaining, current fee surcharge. Omit hashes to read every live strategy the maker has.",
        inputSchema: {
            type: "object",
            properties: {
                hashes: { type: "array", items: { type: "string" }, description: "bytes32 strategy hashes (0x + 64 hex chars) from ship()/router.hash(order)." },
                maker: { type: "string", description: `Maker the strategies belong to. Defaults to the demo maker (${deployment.maker}).` },
            },
        },
    },
    {
        name: "doca_health",
        description: "The invariant: can the wallet cover every promise at once? Omit hashes to check the maker's whole book.",
        inputSchema: {
            type: "object",
            properties: {
                hashes: { type: "array", items: { type: "string" }, description: "bytes32 strategy hashes to sum. Omit to just report the wallet balance (trivially honorable)." },
                maker: { type: "string", description: `Maker to check. Defaults to the demo maker (${deployment.maker}).` },
            },
        },
    },
];

const ok = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

// eth_getLogs wants quantities hex-encoded; accept decimal or hex from callers and config.
const toBlockTag = (v: string | number) => {
    const s = String(v);
    if (/^(latest|earliest|pending|safe|finalized)$/.test(s)) return s;
    if (/^0x[0-9a-f]+$/i.test(s)) return s;
    return "0x" + BigInt(s).toString(16);
};
// Start one block past the fork point: a range that reaches into forked history is answered
// by the upstream node, which knows nothing about strategies shipped locally.
const DEPLOY_BLOCK = toBlockTag(BigInt((deployment as any).forkBlock ?? (deployment as any).deployedAt ?? 0) + 1n);

async function callTool(name: string, args: any) {
    const maker = typeof args?.maker === "string" && args.maker ? args.maker : deployment.maker;
    const fromBlock = args?.fromBlock ? toBlockTag(args.fromBlock) : DEPLOY_BLOCK;

    if (name === "doca_market") {
        return ok({
            chainId: deployment.chainId,
            rpc: RPC_URL,
            aquaRegistry: deployment.aqua,
            router: deployment.router,
            docaApp: deployment.docaApp,
            skewProvider: deployment.skewProvider,
            tokens: { weth: deployment.weth, usdc: deployment.usdc },
            defaultMaker: deployment.maker,
        });
    }

    if (name === "doca_strategies") {
        const hashes = await liveStrategies(maker, fromBlock);
        return ok({ maker, live: hashes.length, hashes });
    }

    if (name === "doca_wallet") {
        const [weth, usdc] = await Promise.all([
            erc20BalanceOf(deployment.weth, maker),
            erc20BalanceOf(deployment.usdc, maker),
        ]);
        return ok({
            maker,
            weth: { raw: weth.toString(), formatted: fmtWeth(weth), symbol: "WETH" },
            usdc: { raw: usdc.toString(), formatted: fmtUsdc(usdc), symbol: "USDC" },
            rpc: RPC_URL,
        });
    }

    if (name === "doca_positions") {
        const hashes: string[] = Array.isArray(args?.hashes) && args.hashes.length
            ? args.hashes
            : await liveStrategies(maker, fromBlock);
        const positions = await Promise.all(hashes.map(async (raw) => {
            const hash = normalizeHash(raw);
            const [bal, balUsdc, remaining, remainingUsdc, fee] = await Promise.all([
                rawBalances(maker, deployment.router, hash, deployment.weth),
                rawBalances(maker, deployment.router, hash, deployment.usdc),
                remainingFraction(hash, deployment.weth),
                remainingFraction(hash, deployment.usdc),
                feeBpsFor(hash, deployment.weth),
            ]);
            return {
                hash,
                wethAboard: { raw: bal.balance.toString(), formatted: fmtWeth(bal.balance) },
                usdcAboard: { raw: balUsdc.balance.toString(), formatted: fmtUsdc(balUsdc.balance) },
                strategyTokenCount: Number(bal.tokensCount),
                budgetRemaining: { raw: remaining.toString(), pct: `${fmtPct(remaining)}%`, note: "WETH-leg fraction of the waterline budget set at ship time, not an absolute token amount" },
                budgetRemainingUsdc: { raw: remainingUsdc.toString(), pct: `${fmtPct(remainingUsdc)}%`, note: "USDC-leg fraction of the waterline budget set at ship time" },
                surcharge: { pct: `${fmtFee(fee)}%`, note: "current AMM fee surcharge as the budget depletes (0% while healthy, rises toward the curve's max near the kink)" },
            };
        }));
        return ok({ maker, positions });
    }

    if (name === "doca_health") {
        const hashes: string[] = Array.isArray(args?.hashes) && args.hashes.length
            ? args.hashes
            : await liveStrategies(maker, fromBlock);
        const [wallet, walletUsdc] = await Promise.all([
            erc20BalanceOf(deployment.weth, maker),
            erc20BalanceOf(deployment.usdc, maker),
        ]);
        const committedAmounts = await Promise.all(hashes.map(async (raw) => {
            const hash = normalizeHash(raw);
            const [bal, balUsdc] = await Promise.all([
                rawBalances(maker, deployment.router, hash, deployment.weth),
                rawBalances(maker, deployment.router, hash, deployment.usdc),
            ]);
            return [bal.balance, balUsdc.balance] as const;
        }));
        const committed = committedAmounts.reduce((a, b) => a + b[0], 0n);
        const committedUsdc = committedAmounts.reduce((a, b) => a + b[1], 0n);
        // Health is the worse leg: both tokens are budgeted at ship time, so either side
        // outrunning the wallet makes the book unhonorable.
        const honorable = committed <= wallet && committedUsdc <= walletUsdc;
        const headroom = wallet - committed;
        const headroomUsdc = walletUsdc - committedUsdc;
        return ok({
            maker,
            checkedStrategies: hashes.length,
            walletWeth: { raw: wallet.toString(), formatted: fmtWeth(wallet) },
            walletUsdc: { raw: walletUsdc.toString(), formatted: fmtUsdc(walletUsdc) },
            committedWeth: { raw: committed.toString(), formatted: fmtWeth(committed) },
            committedUsdc: { raw: committedUsdc.toString(), formatted: fmtUsdc(committedUsdc) },
            headroomWeth: { raw: headroom.toString(), formatted: (headroom < 0n ? "-" : "") + fmtWeth(headroom < 0n ? -headroom : headroom) },
            headroomUsdc: { raw: headroomUsdc.toString(), formatted: (headroomUsdc < 0n ? "-" : "") + fmtUsdc(headroomUsdc < 0n ? -headroomUsdc : headroomUsdc) },
            honorable,
            note: "honorable=true means the wallet holds enough of BOTH legs (WETH and USDC) to cover "
                + "every checked strategy at once, with nothing deposited into Aqua. Health is the worse leg.",
        });
    }

    throw new Error(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC over HTTP POST /mcp: the MCP handshake subset (initialize, tools/list, tools/call).
// No SSE stream: every response here is a direct JSON-RPC reply, which the Streamable HTTP
// transport spec allows for requests that don't need server-initiated messages.
// ---------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200) =>
    json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

// Set DOCA_MCP_TOKEN to require `Authorization: Bearer <token>`; unset means local-only use.
const AUTH_TOKEN = process.env.DOCA_MCP_TOKEN || "";
const authorized = (req: Request) =>
    !AUTH_TOKEN || req.headers.get("authorization") === `Bearer ${AUTH_TOKEN}`;

Bun.serve({
    port: PORT,
    // Bind to loopback unless a host is given, so the default posture is not "exposed".
    hostname: process.env.MCP_HOST || "127.0.0.1",
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/" && req.method === "GET") {
            return new Response("doca-mcp: wallet, positions and budget health over Aqua. POST JSON-RPC to /mcp.\n");
        }
        if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
        if (!authorized(req)) return rpcError(null, -32001, "unauthorized", 401);
        if (req.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST" } });
        if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

        let body: any;
        try {
            body = await req.json();
        } catch {
            return rpcError(null, -32700, "parse error", 400);
        }
        if (Array.isArray(body)) return rpcError(null, -32600, "batch requests not supported", 400);

        const { id, method, params } = body ?? {};
        const isNotification = id === undefined;

        try {
            switch (method) {
                case "initialize": {
                    const result = {
                        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: "doca-mcp", version: "0.1.0" },
                        instructions: "Doca reads over Aqua: call doca_market to self-configure, doca_strategies to " +
                            "discover a maker's live positions, then doca_positions / doca_health. Signing stays with " +
                            "the wallet owner, so this endpoint can be shared without granting custody.",
                    };
                    return isNotification ? new Response(null, { status: 202 }) : rpcResult(id, result);
                }
                case "notifications/initialized":
                case "notifications/cancelled":
                    return new Response(null, { status: 202 });
                case "ping":
                    return isNotification ? new Response(null, { status: 202 }) : rpcResult(id, {});
                case "tools/list":
                    return rpcResult(id, { tools: TOOLS });
                case "tools/call": {
                    const toolName = params?.name;
                    if (!TOOLS.some((t) => t.name === toolName)) {
                        return rpcError(id, -32602, `unknown tool: ${toolName}`);
                    }
                    try {
                        const result = await callTool(toolName, params?.arguments ?? {});
                        return rpcResult(id, result);
                    } catch (e: any) {
                        return rpcResult(id, fail(String(e?.message ?? e)));
                    }
                }
                default:
                    return isNotification ? new Response(null, { status: 202 }) : rpcError(id, -32601, `method not found: ${method}`);
            }
        } catch (e: any) {
            return rpcError(id, -32603, String(e?.message ?? e), 500);
        }
    },
});

console.log(`doca-mcp listening on :${PORT} -> POST /mcp  (RPC ${RPC_URL})`);
