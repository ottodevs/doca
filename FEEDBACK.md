# Uniswap API — Developer Feedback

Written for the Uniswap Foundation "Best Uniswap API Integration" bounty at ETHGlobal
Lisbon 2026. Context: Doca uses the Trading API as the live market reference for an
autonomous maker built on 1inch Aqua — see [How we use the API](#how-we-use-the-api).

## How we use the API

- `web/src/lib/uniswap-price.ts` — the whole client. `POST /v1/quote` (EXACT_INPUT,
  WETH→USDC, chain 8453, protocols V3+V4) gives us the live Base mainnet price.
- `web/src/App.tsx` — the Harbormaster agent marks every dock/re-ship decision against
  that live price, and the header shows the reference so users see what the real market
  says while they trade on the practice fork.
- `web/src/LpDesk.tsx` + `web/src/lib/pnl.ts` — every Aqua position is valued
  mark-to-market against the Uniswap quote; the PnL chart and position history ticks
  are denominated in it.
- `web/plugins/lp-desk-dev.ts` — dev-server proxy that keeps the API key out of the
  browser bundle and polls the spot hourly for position history.

## What worked well

- Key issuance was instant — signed up and quoted inside the same hour.
- Quote latency from the venue was consistently sub-second for Base V3+V4 routes.
- Base (8453) coverage is solid; the CLASSIC route we get matches on-chain reality.
- One endpoint gave us everything we needed for valuation; we never had to touch a
  subgraph or run our own indexer for pricing.

## Friction we hit

1. **CORS**: the gateway rejects browser-origin calls, so a pure-frontend app cannot
   use the API without shipping the key in the bundle. We had to add a dev-server
   proxy that injects `x-api-key` server-side. A CORS-enabled quote-only tier, or
   short-lived browser tokens, would remove a whole class of hackathon plumbing.
2. **`x-universal-router-version` header**: easy to miss and the error when absent
   does not name the header. A clearer 4xx message would have saved us a debugging
   loop.
3. **Response shape varies by routing type**: `quote.output.amount` for CLASSIC vs
   `quote.orderInfo.outputs[].startAmount` for X. We handle both
   (`outputAmount()` in `uniswap-price.ts`); one normalized field would simplify
   clients that only care about the number.
4. **Minimal examples per chain**: the quote request has many optional fields; a
   copy-paste minimal body per chain (like the one in our `uniswap-price.ts`) would
   shorten time-to-first-quote.

## What we would build next

Quote-driven re-shipping: today the agent annotates its re-promise with the live
Uniswap price; the natural next step is sizing the re-promised legs from the quote so
the maker re-enters exactly at market, and routing the rebalancing leg through the
swap endpoint's calldata.
