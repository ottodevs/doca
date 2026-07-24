import type { AquaClient } from "../aqua/client";
import type { Decision, Hash32 } from "../types";

export interface ExecutionResult {
  strategyHash: Hash32;
  applied: boolean;
  detail: string;
}

// Apply decided allocations against Aqua. "hold" decisions are no-ops, logged for visibility.
export async function execute(client: AquaClient, decisions: Decision[]): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const decision of decisions) {
    if (decision.allocation.kind === "hold") {
      results.push({ strategyHash: decision.strategyHash, applied: false, detail: decision.reason });
      continue;
    }

    const detail = await client.applyAllocation(decision.strategyHash, decision.allocation);
    results.push({ strategyHash: decision.strategyHash, applied: true, detail });
  }

  return results;
}
