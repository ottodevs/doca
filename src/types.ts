// Shared domain types for the strategy engine.
// Kept chain-library-agnostic (no viem types here) so decide/ stays testable in isolation.

export type Address = `0x${string}`;
export type Hash32 = `0x${string}`;

// One ERC20 leg tracked by Aqua for a strategy.
export interface TokenBalance {
  token: Address;
  balance: bigint;
}

// Snapshot of one strategy's virtual-balance state, as seen by observe/.
export interface StrategyState {
  maker: Address;
  app: Address;
  strategyHash: Hash32;
  balances: TokenBalance[];
  isActive: boolean;
}

// A single allocation move the engine wants to make against one strategy.
export type Allocation =
  | { kind: "hold" }
  | { kind: "rebalance"; token: Address; deltaBps: number }
  | { kind: "withdraw"; tokens: Address[] };

// Decision output: one allocation per observed strategy, with the reasoning that produced it.
export interface Decision {
  strategyHash: Hash32;
  allocation: Allocation;
  reason: string;
}
