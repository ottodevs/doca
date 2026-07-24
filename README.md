# aqua-defi-engine

A pluggable DeFi strategy engine built on [1inch Aqua](https://1inch.com/aqua)'s shared
liquidity layer. One observe -> decide -> execute loop, one set of clean module
boundaries, any allocation policy you want to plug in.

Built for ETHGlobal Lisbon 2026.

## The pitch

Aqua lets multiple DeFi strategies draw on the *same* wallet balance concurrently,
without custody ever leaving the user's wallet — a liquidity provider approves a token
once, then any number of strategies can be "shipped" against that virtual balance. That
breaks the usual DeFi tradeoff where capital gets locked into one vault, one strategy, one
opportunity cost at a time.

This repo is the runtime for a strategy that lives on top of that model: a small,
typed engine that

1. **observes** the live virtual-balance state of one or more Aqua strategies,
2. **decides** an allocation move against a pluggable policy, and
3. **executes** that move back through Aqua — all without ever taking custody of funds.

The included policy (`src/decide/strategy.ts`) is a placeholder 50/50 drift-rebalancer.
It exists so the loop has something concrete to run and the test harness has something
to assert on. The real alpha goes here during the hack.

**Target prize:** 1inch Aqua bounty ($5k + $2k tracks).

## Architecture

```
                    ┌─────────────────────────────┐
                    │           runner.ts          │
                    │  observe -> decide -> execute │
                    │        (loop, interval)       │
                    └───────────────┬───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌──────────────────┐
│   observe/     │         │    decide/       │         │    execute/       │
│ read strategy  │         │ pure policy fn:  │         │ apply allocation  │
│ state via Aqua │         │ StrategyState[]  │         │ via AquaClient    │
│                │  ────►  │  -> Decision[]   │  ────►  │                   │
└───────┬────────┘         └──────────────────┘         └─────────┬────────┘
        │                                                          │
        └──────────────────────────┬───────────────────────────────┘
                                    ▼
                          ┌──────────────────┐
                          │   aqua/client.ts  │
                          │ viem-based wrapper│
                          │  over IAqua ABI   │
                          │ ship/push/dock/   │
                          │ safeBalances      │
                          └──────────────────┘
```

- `src/types.ts` — chain-library-agnostic domain types (`StrategyState`, `Decision`,
  `Allocation`). `decide/` only depends on these, so policies stay unit-testable without
  a chain.
- `src/aqua/` — the Aqua integration boundary: ABI fragment, ref types, and `AquaClient`.
  Everything chain-specific lives here.
- `src/observe/`, `src/decide/`, `src/execute/` — one responsibility each, wired together
  by `src/runner.ts`.
- `test/harness/anvilFork.ts` — spins up a local `anvil --fork-url` process and exposes
  snapshot/revert/impersonate through viem's test client actions, so strategies can be
  exercised against pinned real-chain state with zero real funds at risk.

## 1inch Aqua SDK status (read before wiring real calls)

Researched at scaffold time (2026-07-24):

- **Protocol repo:** [github.com/1inch/aqua](https://github.com/1inch/aqua) — public
  README documents the core `IAqua` interface: `ship()`, `push()`, `dock()`,
  `rawBalances()`, `safeBalances()`.
- **TypeScript SDK:** [github.com/1inch/sdks/tree/master/typescript/aqua](https://github.com/1inch/sdks/tree/master/typescript/aqua).
  Package name is reported as `@1inch/aqua-sdk` in secondary sources — **not independently
  verified by installing it**. Confirm the exact package name and export shape once you
  have venue wifi and can `bun add` it directly.
- **Deployed contract addresses** — not verified. Do not trust any address you find
  outside the official repo/docs; `src/config.ts` defaults `AQUA_ADDRESS` to the zero
  address on purpose so a wrong address can't be silently used.
- **Core concept:** liquidity providers `approve()` a token to Aqua once, then `ship()` a
  strategy which allocates a *virtual* balance from the LP's wallet — tokens never leave
  the wallet until a trade actually executes. `push()` is swap-execution-only (moves
  tokens in during a trade); it is not a top-up/rebalance primitive. Rebalancing between
  legs of a strategy requires an app-specific instruction (e.g. a SwapVM opcode, or a
  bespoke app's swap call) — this is the main open integration question for the hack.

**What's real vs. stubbed in this repo:**
- `src/aqua/abi.ts` — real ABI fragment, hand-transcribed from the public Aqua README.
- `AquaClient.getStrategyState()` — real `safeBalances()` read call via viem.
- `AquaClient.applyAllocation()` — **stubbed**. `hold` is a real no-op; `rebalance` and
  `withdraw` return TODO strings describing the exact call that needs wiring once the
  strategy app (SwapVM or custom) is chosen. Search `TODO(hack)` across the repo for
  every open wire-up point.

## Running it

```bash
bun install
cp .env.example .env   # fill in RPC_URL / AQUA_ADDRESS once confirmed
bun run dev             # boots the loop skeleton, logs and exits idle (no strategies yet)
bun run typecheck
bun test                 # pure decide/ tests always run; fork test skips without anvil+FORK_RPC_URL
```

To exercise the fork harness you need [Foundry](https://getfoundry.sh) installed
(`curl -L https://foundry.paradigm.xyz | bash && foundryup`, or `nix shell nixpkgs#foundry`
on NixOS) and a `FORK_RPC_URL` in `.env` pointing at a real RPC for the target chain.

## 36h build checklist

Rough priority order — top items unblock everything below them.

1. **Confirm the SDK.** `bun add @1inch/aqua-sdk` (or whatever the real package name
   turns out to be) at the venue; replace the hand-written ABI in `src/aqua/abi.ts` if
   the SDK ships one. Confirm deployed `AQUA_ADDRESS` for the target testnet/mainnet.
2. **Pick the strategy app.** Decide: build directly against `IAqua` with a custom app
   contract, or assemble via SwapVM opcodes. This decides what `applyAllocation()`'s
   `rebalance` case actually calls.
3. **Ship one real strategy on a fork.** Use `test/harness/anvilFork.ts` to fork the
   target chain, impersonate a funded whale, `ship()` a real 2-token strategy, and get
   `AquaClient.getStrategyState()` reading real non-zero balances.
4. **Replace the placeholder policy.** Swap `thresholdRebalancePolicy` in
   `src/decide/strategy.ts` for the actual strategy logic (yield-seeking, arb-capture,
   volatility-responsive sizing — whatever the demo narrative is).
5. **Wire `applyAllocation()` for real.** Turn the two `TODO(hack)` branches into actual
   `writeContract` calls once step 2 is settled.
6. **Demo path.** One scripted end-to-end run against the fork: ship -> drift the
   balance -> observe -> decide -> execute -> re-observe showing the rebalance. Record it
   early — don't leave the demo recording for the last hour.
7. **Polish only if time remains:** structured logging, multi-strategy tracking beyond
   one `StrategyRef`, a minimal status CLI/README GIF.
