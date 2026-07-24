import type { AquaClient } from "../aqua/client";
import type { StrategyRef } from "../aqua/types";
import type { StrategyState } from "../types";

// Pull current on-chain virtual-balance state for every tracked strategy.
export async function observe(client: AquaClient, refs: StrategyRef[]): Promise<StrategyState[]> {
  return Promise.all(refs.map((ref) => client.getStrategyState(ref)));
}
