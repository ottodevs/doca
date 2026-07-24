import type { PublicClient, WalletClient } from "viem";
import { aquaAbi } from "./abi";
import type { StrategyRef } from "./types";
import type { Allocation, Hash32, StrategyState } from "../types";

export interface AquaClientConfig {
  aquaAddress: `0x${string}`;
  publicClient: PublicClient;
  walletClient?: WalletClient; // only required for write calls (ship/push/dock)
}

// Thin wrapper over the on-chain IAqua registry.
//
// Talks to the interface directly via viem + the ABI in ./abi.ts. The official
// @1inch/aqua-sdk TS package (github.com/1inch/sdks/tree/master/typescript/aqua) is the
// preferred long-term dependency, but its exact export shape wasn't verified at scaffold
// time. Swap the internals for the real SDK client once confirmed — keep the public
// method signatures on this class stable so observe/decide/execute don't need to change.
export class AquaClient {
  constructor(private readonly config: AquaClientConfig) {}

  // Read the live virtual-balance state for a 2-token strategy via safeBalances().
  async getStrategyState(ref: StrategyRef): Promise<StrategyState> {
    const [token0, token1] = ref.tokens;
    const [balance0, balance1] = await this.config.publicClient.readContract({
      address: this.config.aquaAddress,
      abi: aquaAbi,
      functionName: "safeBalances",
      args: [ref.maker, ref.app, ref.strategyHash, token0, token1],
    });

    return {
      maker: ref.maker,
      app: ref.app,
      strategyHash: ref.strategyHash,
      balances: [
        { token: token0, balance: balance0 },
        { token: token1, balance: balance1 },
      ],
      isActive: balance0 + balance1 > 0n,
    };
  }

  // Apply a decided allocation on-chain.
  // TODO(hack): "rebalance" needs an app-specific instruction (a SwapVM opcode, or a bespoke
  // app's swap call) — push()/ship() alone only move funds in/out of a strategy, they don't
  // move funds between legs. Wire the real app call here once the strategy app is chosen.
  async applyAllocation(strategyHash: Hash32, allocation: Allocation): Promise<string> {
    if (!this.config.walletClient) {
      throw new Error("applyAllocation requires a walletClient (write access)");
    }

    switch (allocation.kind) {
      case "hold":
        return "hold: no-op";
      case "withdraw":
        return `TODO: aqua.dock(app, ${strategyHash}, [${allocation.tokens.join(", ")}])`;
      case "rebalance":
        return `TODO: app-specific swap for ${allocation.token} (drift ${allocation.deltaBps}bps)`;
    }
  }
}
