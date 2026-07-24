import { observe } from "./observe";
import { decide } from "./decide";
import { execute } from "./execute";
import { loadConfig } from "./config";
import type { AquaClient } from "./aqua/client";
import type { StrategyRef } from "./aqua/types";

export interface RunnerOptions {
  client: AquaClient;
  strategies: StrategyRef[];
  intervalMs?: number;
  once?: boolean; // run a single pass then return — used by tests and manual invocations
}

// The engine loop: observe -> decide -> execute, repeated on an interval.
export async function runLoop(opts: RunnerOptions): Promise<void> {
  const interval = opts.intervalMs ?? loadConfig().loopIntervalMs;

  for (;;) {
    const states = await observe(opts.client, opts.strategies);
    const decisions = decide(states);
    const results = await execute(opts.client, decisions);

    for (const result of results) {
      console.log(`[engine] ${result.strategyHash.slice(0, 10)} applied=${result.applied} ${result.detail}`);
    }

    if (opts.once) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
