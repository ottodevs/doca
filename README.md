# Plimsoll

**Keep your wallet. Put it to work anyway.**

Your money stays in your wallet and earns. Spend it whenever you want, there is nothing to
withdraw, and your positions resize themselves so you keep earning without watching them. And you
never promise more liquidity than you can actually honor.

Built at ETHGlobal Lisbon 2026 on [1inch Aqua](https://1inch.com/aqua).

---

## The problem we picked

Aqua is a shared-liquidity settlement layer. A maker does not deposit anything: they approve Aqua
once, then `ship` a promise, which is a record saying "this strategy may sell up to this much of my
wallet, under these price rules". Tokens only move during a fill, straight out of the maker's
wallet. `dock` cancels the promise. Nothing is ever custodied.

That design lets one wallet balance back several strategies at once, which is where the capital
efficiency comes from. It also creates a failure mode nobody was handling, and it is not
speculative: `Aqua.ship` writes the promise **without checking the wallet balance or the
allowance** ([`Aqua.sol:40-52`](https://github.com/1inch/aqua)), so promises can exceed what the
maker holds, by design.

When flow turns directional, the wallet empties while every strategy's virtual book still
advertises inventory. Takers get quotes that revert, and the maker's next refill is arbitraged at a
stale price. The Aqua whitepaper names exactly this, in §3, and prescribes a manual fix:

> "While Aqua doesn't automatically pause illiquid positions, Makers are strongly recommended to
> manually dock strategies that become chronically underfunded to prevent accumulating unfavorable
> price exposure."

Nobody does that by hand at 3am. One week before this hackathon, 1inch's own commissioned research
put numbers on the same gap: 85% of concentrated liquidity sat idle in H1 2026, and 82-94% of that
idle capital was in wallets managed by people rather than by contracts
([CoinDesk, 2026-07-18](https://www.coindesk.com/web3/2026/07/18/here-is-why-a-massive-usd1-6-billion-in-crypto-liquidity-is-sitting-idle-and-wasting-away)).

## What Plimsoll is

Two pieces and one invariant.

**The invariant.** A *promise* may exceed your wallet, and that is the whole point of Aqua. A
*budget* may not. Every strategy carries a budget of how much it may actually consume, the budgets
sum to what you really hold, and therefore every quote you publish can be honored.

**On-chain: `InventorySkewProvider`.** An `IProtocolFeeProvider` plugged into SwapVM's stock
`AquaDynamicProtocolFeeAmountIn` instruction (opcode 30). It returns a fee that is flat while a
strategy's budget is healthy and rises quadratically as the budget runs out. Three properties
matter:

- **Directional.** The fee is a function of the outgoing token only, so draining the scarce side
  costs progressively more while the direction that refills you stays at the base rate. Takers are
  paid, in price, to rebalance you.
- **It de-leverages.** SwapVM pulls the surcharge from the maker's Aqua balance and forwards it to
  a recipient of the maker's choosing, so value leaves the shared pool exactly when
  oversubscription risk peaks, instead of being re-committed to the position.
- **No new pricing inputs.** It reads only `AQUA.rawBalances`, never the real wallet balance or
  allowances, which is what the Aqua whitepaper says an app should price against.

**Off-chain: the agent.** Watches every strategy a maker has shipped, and when one goes under its
waterline it docks it and re-promises against the balances the wallet actually holds now. It is the
whitepaper's manual recommendation, automated, and it is what makes "set it and forget it" true.

## What is ours and what is 1inch's

Everything settling value is 1inch's own live code. We deploy two small contracts.

| Contract | Address on Base | Whose |
|---|---|---|
| Aqua registry | `0x499943e74fb0ce105688beee8ef2abec5d936d31` | 1inch, canonical, live |
| SwapVM router | official `AquaSwapVMRouter` code, unmodified | 1inch code, our deployment |
| `InventorySkewProvider` | 159 lines | ours |
| `PlimsollApp` | 93 lines, builds the SwapVM program | ours |

Why our own deployment of the router and not the live one at
`0x8fdd04dbf6111437b44bbca99c28882434e0958f`? Version skew, and it is documented: the live routers
(deployed across 12 chains in June, `eip712Domain()` says `1.0.0`) predate the order-data layout the
hackathon template targets. On July 24 — the morning of day 1 — 1inch updated `swap-vm-template` to
pin `swap-vm#b44977a1` (release-1.2 line), which prefixes order data with the 40-byte token pair and
adds new taker flags, so orders built with the current template revert against the June router by
design. The template's own deploy flow ships a fresh router. We do exactly what the official
template does: deploy the unmodified official router code and wire it to the canonical live Aqua
registry, which the bounty explicitly permits. Our extension point is untouched by the skew: opcode
30 is `_aquaDynamicProtocolFeeAmountInXD` in both revisions.

## Measurements

Prior art on this track demonstrates mechanisms. We measured outcomes, with a paired control: two
strategies shipped from the same wallet, same curve, same liquidity, same taker flow, one
instruction of difference.

**`contracts/scripts/waterline-scenario.ts`** — 30 fills into a 100/100 strategy, curve capped at
50%:

| | plain | with the skew |
|---|---:|---:|
| Inventory left | 6.25 (6.3%) | **8.08 (8.1%)** |
| Realized price for the LP | 16.0000 | **16.3187** |
| Pulled out of the shared pool | 0 | 362.54 |

29% more inventory still standing, and 1.99% better realized price on the drained leg. The 362 is
de-leveraging, not profit: it moves from committed liquidity to free balance, and the maker owns
both sides.

**`contracts/scripts/amplification-experiment.ts`** — a trending market, price-sensitive ordinary
flow, and an arbitrageur that only trades when a quote is stale. Same market at 1x, 2x and 4x
amplification, with and without management:

| N | arm | flow fills | **unhonored fills** | LP end value | vs holding |
|---:|---|---:|---:|---:|---:|
| 1 | unmanaged | 12 | 0 | 283.11 | -5.63% |
| 1 | managed | 12 | 0 | 283.11 | -5.63% |
| 2 | unmanaged | 24 | 0 | 266.22 | -11.26% |
| 2 | managed | 24 | 0 | 266.22 | -11.26% |
| 4 | unmanaged | 43 | **43** | 234.62 | -21.79% |
| 4 | managed | 40 | **0** | **241.05** | -19.65% |

Three findings, in order of strength:

1. **Unmanaged amplification publishes quotes it cannot honor.** At 4x, 43 of 86 attempted fills
   reverted, because the wallet was empty while every strategy still advertised inventory. With
   budgets: zero. That is binary, and it is the aggregator's problem as much as the maker's.
2. **Amplification multiplies impermanent loss close to linearly**: -5.6%, -11.3%, -21.8% versus
   holding, at 1x, 2x, 4x. Each strategy sells the same real inventory into the same move.
3. **Management recovers 2.74%** of the maker's value at 4x, at a cost of 3 of 43 fills of lost
   volume, because a taker who wanted to buy cheap walks away.

At 1x and 2x the mechanism does nothing at all. That is correct: the budgets are never exhausted, so
it costs nothing when it is not needed.

## Using it with a real wallet

The app is not locked to the demo signer. If an injected wallet (MetaMask, Rabby, …) is present,
a **Connect wallet** button appears in the header: your account becomes the maker, and every
`ship`, `dock` and waterline configuration is signed by your wallet. On the anvil fork the app
offers one-click seeding (WETH + USDC + approvals) so any empty account can try the whole journey.
The demo signer remains the default when no wallet is installed, so the recorded flow is reproducible.

## Running it

Everything runs against a fork of Base, where the canonical Aqua is live and WETH and USDC are the
real token contracts. No funds are spent.

```bash
# 1. a node forking Base at a pinned block
anvil --fork-url https://mainnet.base.org --fork-block-number 49093600 --chain-id 8453

# 2. contracts: install, compile, test
cd contracts && yarn && npx hardhat test

# 3. deploy our side and seed the demo wallet
npx hardhat run scripts/deploy-for-web.ts --network localhost

# 4. the app
cd ../web && bun install && bun run dev     # http://127.0.0.1:5273

# the same flow, headless
bun run scripts/smoke.ts
```

Other scripts: `demo-flow-base.ts` (the whole loop against the canonical Aqua registry),
`waterline-scenario.ts` and `amplification-experiment.ts` (the measurements above).

## Tests

`npx hardhat test` runs 7, three of them the official template's own:

- healthy budget quotes the base fee, so ordinary flow is untouched
- the surcharge ramps quadratically past the kink and caps at the waterline, asserted against the
  closed form rather than a magic number
- the fee is directional: taking the scarce leg is surcharged, refilling it is not
- identical taker flow through a skewed and a plain program, shipped from the same wallet, leaves
  strictly more inventory standing in the skewed one, and the exact surcharge lands outside the
  pool, asserted with real ERC20 balance changes

## How this differs from the prior art

**RiverSwap** (1st, ETHGlobal New York 2026) uses the same extension point, an
`IProtocolFeeProvider` on opcode 30, with an auction deciding the fee: whoever wins an epoch pays
rent and sets `feeBps`. Same slot, opposite input. Theirs is an auction winner, ours is how much
budget is left. Theirs is market design, ours is balance-sheet risk.

**`progressiveFeeIn`** (opcode 37, `FeeExperimental.sol`) already makes draining a reserve cost
more, via `dx_eff = dx / (1 + λ·dx/x)` on `balanceIn`. It prices *trade size* against the inbound
reserve, so a thousand small fills drain you without it noticing, and it is not wired into
`AquaOpcodes` at all, so it is unreachable from the Aqua-backed router. We price *cumulative
consumption* against a budget. They compose rather than compete.

## Honest limitations

- Aqua has no frontend or indexer yet, so there is no organic flow. The taker side of the demo is
  executed by us. The transactions, tokens and balances are real; the market is not.
- The agent runs in the browser for the demo. In production it is a service, and the authorization
  pattern for a keeper acting on a maker's behalf is an open question for 1inch.
- The demo signs with a local development key. On a public chain this is a wallet connector.
- The curve parameters are sane defaults, not tuned economics. Tuning them per pair is exactly what
  the agent should learn to do.

## Team

Otto ([@aerovalencia](https://x.com/aerovalencia), github.com/ottodevs) and Henrik.

AI usage: Claude Code was used for scaffolding, the measurement harnesses and documentation. The
mechanism, the design decisions and the economics are ours, and every number in this README comes
from a script in this repo that you can run.
