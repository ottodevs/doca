// SPDX-License-Identifier: MIT
//
// Doca MCP server — read-only agent surface over the Aqua fork.
//
// Why zero dependencies: every call this server makes is a `view` function with only static
// argument types (address / bytes32), so ABI encoding is four 32-byte words concatenated after a
// 4-byte selector — no encoder needed. Selectors below are precomputed keccak4s of the same
// signatures `web/src/lib/doca.ts` uses (see ABI arrays there); we don't recompute keccak at
// runtime, we just hardcode the well-known result. `bun`'s built-in `fetch` + `Bun.serve` cover
// the rest, so this file has no `bun add` footprint at all.
//
// Why read-only: shipping/docking a strategy needs a signature. Handing an agent the maker's
// private key (even the anvil demo key) so it can *write* is a custody decision this project isn't
// making unilaterally — see mcp/README.md "Roadmap" for what an authenticated write path looks
// like. Until then, agents get read access and can advise a human who holds the keys.
//
// Why `doca_positions`/`doca_health` require strategy hashes as input: Aqua's `Shipped` event
// (`Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)`) has no `indexed`
// parameters, so there's no cheap `eth_getLogs` filter by maker — only a full log scan + manual
// ABI decode of a dynamic `bytes` tail, which is indexer-shaped work, not a minimal MCP server.
// Callers already have the hash: it's the return value of `ship()`/`router.hash(order)` in
// `web/src/lib/doca.ts`, or shown in the Doca app after a strategy is shipped.

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
    // rawBalances(address,address,bytes32,address) — Aqua: maker, app, strategyHash, token
    rawBalances: "0x6d58b4cc",
    // remainingFraction(bytes32,address) — InventorySkewProvider
    remainingFraction: "0x8fdc4b85",
    // feeBpsFor(bytes32,address) — InventorySkewProvider
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

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const TOOLS = [
    {
        name: "doca_wallet",
        description: "Read a maker's live WETH/USDC wallet balances (same ERC20 balanceOf calls the Doca app uses). Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                maker: { type: "string", description: `Address to read. Defaults to the demo maker (${deployment.maker}).` },
            },
        },
    },
    {
        name: "doca_positions",
        description: "Read Doca strategy positions by strategy hash: WETH aboard, budget-remaining fraction, current fee surcharge. Call with no hashes to get instructions for obtaining them.",
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
        description: "Invariant check: can the maker's actual wallet balance cover the WETH committed across the given strategies simultaneously? honorable=true is the whole point of Doca's budget primitive.",
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

async function callTool(name: string, args: any) {
    const maker = typeof args?.maker === "string" && args.maker ? args.maker : deployment.maker;

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
        const hashes: string[] = Array.isArray(args?.hashes) ? args.hashes : [];
        if (hashes.length === 0) {
            return ok({
                maker,
                positions: [],
                note: "No strategy hashes provided. Doca doesn't index strategies by maker on-chain " +
                    "(Aqua's Shipped event has no indexed args — see the header comment in mcp/server.ts). " +
                    "Get the hash from whoever shipped the strategy: it's the return value of " +
                    "aqua.ship(...)/router.hash(order) in web/src/lib/doca.ts, or shown in the Doca app " +
                    'after a strategy goes live. Then call again with hashes: ["0x..."].',
            });
        }
        const positions = await Promise.all(hashes.map(async (raw) => {
            const hash = normalizeHash(raw);
            const [bal, remaining, fee] = await Promise.all([
                rawBalances(maker, deployment.router, hash, deployment.weth),
                remainingFraction(hash, deployment.weth),
                feeBpsFor(hash, deployment.weth),
            ]);
            return {
                hash,
                wethAboard: { raw: bal.balance.toString(), formatted: fmtWeth(bal.balance) },
                strategyTokenCount: Number(bal.tokensCount),
                budgetRemaining: { raw: remaining.toString(), pct: `${fmtPct(remaining)}%`, note: "fraction of the waterline budget set at ship time, not an absolute token amount" },
                surcharge: { pct: `${fmtFee(fee)}%`, note: "current AMM fee surcharge as the budget depletes (0% while healthy, rises toward the curve's max near the kink)" },
            };
        }));
        return ok({ maker, positions });
    }

    if (name === "doca_health") {
        const hashes: string[] = Array.isArray(args?.hashes) ? args.hashes : [];
        const wallet = await erc20BalanceOf(deployment.weth, maker);
        const committedAmounts = await Promise.all(hashes.map(async (raw) => {
            const hash = normalizeHash(raw);
            const bal = await rawBalances(maker, deployment.router, hash, deployment.weth);
            return bal.balance;
        }));
        const committed = committedAmounts.reduce((a, b) => a + b, 0n);
        const honorable = committed <= wallet;
        const headroom = wallet - committed;
        return ok({
            maker,
            checkedStrategies: hashes.length,
            walletWeth: { raw: wallet.toString(), formatted: fmtWeth(wallet) },
            committedWeth: { raw: committed.toString(), formatted: fmtWeth(committed) },
            headroomWeth: { raw: headroom.toString(), formatted: (headroom < 0n ? "-" : "") + fmtWeth(headroom < 0n ? -headroom : headroom) },
            honorable,
            note: hashes.length === 0
                ? "No strategy hashes were checked — this only reports the wallet balance; the invariant is trivially honorable with zero commitments."
                : "honorable=true means the wallet actually holds enough WETH to cover every checked strategy's committed amount at once, even though nothing was ever deposited into Aqua.",
        });
    }

    throw new Error(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC over HTTP POST /mcp — the MCP handshake subset (initialize, tools/list, tools/call).
// No SSE stream: every response here is a direct JSON-RPC reply, which the Streamable HTTP
// transport spec allows for requests that don't need server-initiated messages.
// ---------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200) =>
    json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/" && req.method === "GET") {
            return new Response("doca-mcp: read-only Doca position/wallet/health tools. POST JSON-RPC to /mcp.\n");
        }
        if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
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
                        instructions: "Read-only Doca position/wallet/health tools against an Aqua fork or live deployment. " +
                            "No write actions (ship/dock) are exposed — see mcp/README.md for why.",
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
