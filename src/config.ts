// Central env config. Bun auto-loads .env: no dotenv dependency needed.

import type { Address } from "./types";

export interface EngineConfig {
  rpcUrl: string;
  aquaAddress: Address;
  loopIntervalMs: number;
}

// TODO: replace with the real deployed Aqua registry address for the target chain.
// Left as the zero address on purpose. Never assume a canonical deployment without checking docs at the venue.
const DEFAULT_AQUA_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function loadConfig(): EngineConfig {
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    aquaAddress: (process.env.AQUA_ADDRESS as Address | undefined) ?? DEFAULT_AQUA_ADDRESS,
    loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 15_000),
  };
}
