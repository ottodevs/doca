import { createPublicClient, http } from "viem";
import { AquaClient } from "./src/aqua/client";
import { loadConfig } from "./src/config";
import { runLoop } from "./src/runner";
import type { StrategyRef } from "./src/aqua/types";

// Entry point: `bun run dev` boots the observe->decide->execute loop against RPC_URL.
async function main() {
  const config = loadConfig();
  console.log(`[engine] booting — rpc=${config.rpcUrl} aqua=${config.aquaAddress}`);

  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const client = new AquaClient({ aquaAddress: config.aquaAddress, publicClient });

  // TODO(hack): load real tracked strategies (from a config file or an on-chain registry
  // scan) once at least one is shipped on-chain. Empty means the loop skeleton is live but
  // idle — that's expected on first boot.
  const strategies: StrategyRef[] = [];

  if (strategies.length === 0) {
    console.log("[engine] no strategies configured yet — loop skeleton is live, wire STRATEGIES next");
    return;
  }

  await runLoop({ client, strategies });
}

main().catch((err) => {
  console.error("[engine] fatal:", err);
  process.exit(1);
});
