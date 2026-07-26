// SPDX-License-Identifier: MIT
//
// Live WETH/USDC price via Uniswap Trading API (real Base mainnet).
// Browser calls go through the Vite CORS proxy at /api/uniswap.
import { ethers } from "ethers";
import deployment from "../deployment.json";

const WETH = deployment.weth;
const USDC = deployment.usdc;
const CHAIN = String(deployment.chainId); // 8453 Base
const ONE_WETH = 10n ** 18n;
const SWAPPER = deployment.maker;

export type SpotPrice = {
    /** USDC per 1 WETH (human float) */
    usdcPerWeth: number;
    /** Raw USDC out for 1 WETH (6 decimals) */
    usdcOut: bigint;
    at: number;
    routing: string;
};

function apiBase(): string {
    // Dev: Vite proxy. Scripts: direct (needs UNISWAP_API in env).
    if (typeof window !== "undefined") return "/api/uniswap";
    return "https://trade-api.gateway.uniswap.org/v1";
}

function headers(): Record<string, string> {
    const h: Record<string, string> = {
        "Content-Type": "application/json",
        "x-universal-router-version": "2.0",
    };
    // Browser: proxy injects x-api-key. Node: read from env.
    if (typeof window === "undefined") {
        const key = process.env.UNISWAP_API || process.env.UNISWAP_API_KEY;
        if (!key) throw new Error("UNISWAP_API missing in environment");
        h["x-api-key"] = key;
    }
    return h;
}

type ClassicQuote = {
    routing: string;
    quote?: {
        output?: { amount?: string; token?: string };
        orderInfo?: { outputs?: { startAmount?: string }[] };
    };
    detail?: string;
    errorCode?: string;
};

function outputAmount(data: ClassicQuote): bigint {
    if (data.quote?.output?.amount) return BigInt(data.quote.output.amount);
    const xo = data.quote?.orderInfo?.outputs?.[0]?.startAmount;
    if (xo) return BigInt(xo);
    throw new Error(data.detail || data.errorCode || "Uniswap quote missing output amount");
}

/** Quote 1 WETH → USDC on live Base via Uniswap Trading API. */
export async function fetchWethUsdcSpot(): Promise<SpotPrice> {
    const res = await fetch(`${apiBase()}/quote`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
            swapper: SWAPPER,
            tokenIn: WETH,
            tokenOut: USDC,
            tokenInChainId: CHAIN,
            tokenOutChainId: CHAIN,
            amount: ONE_WETH.toString(),
            type: "EXACT_INPUT",
            slippageTolerance: 0.5,
            routingPreference: "FASTEST",
            protocols: ["V3", "V4"],
        }),
    });
    const data = (await res.json()) as ClassicQuote;
    if (!res.ok) {
        throw new Error(data.detail || data.errorCode || `Uniswap quote HTTP ${res.status}`);
    }
    const usdcOut = outputAmount(data);
    const usdcPerWeth = Number(ethers.formatUnits(usdcOut, 6));
    return { usdcPerWeth, usdcOut, at: Date.now(), routing: data.routing || "unknown" };
}
