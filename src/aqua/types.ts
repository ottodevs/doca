import type { Address, Hash32 } from "../types";

// Identifies one strategy inside the Aqua registry — enough to query and act on it.
export interface StrategyRef {
  maker: Address;
  app: Address;
  strategyHash: Hash32;
  tokens: [Address, Address];
}
