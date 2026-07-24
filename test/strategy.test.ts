import { describe, expect, test } from "bun:test";
import { decide } from "../src/decide";
import type { StrategyState } from "../src/types";
import { startAnvilFork } from "./harness/anvilFork";

// Build a valid-shaped 20-byte address / 32-byte hash from a short suffix, so fixtures
// stay readable without hand-counting hex characters.
const addr = (suffix: string) => `0x${suffix.padStart(40, "0")}` as const;
const hash = (suffix: string) => `0x${suffix.padStart(64, "0")}` as const;

const FORK_RPC_URL = process.env.FORK_RPC_URL;
const hasAnvil = Boolean(Bun.which("anvil"));
const hasForkUrl = Boolean(FORK_RPC_URL);

function syntheticState(balanceA: bigint, balanceB: bigint, saltSuffix: string): StrategyState {
  return {
    maker: addr("dead"),
    app: addr("beef"),
    strategyHash: hash(saltSuffix),
    balances: [
      { token: addr("a1"), balance: balanceA },
      { token: addr("b2"), balance: balanceB },
    ],
    isActive: true,
  };
}

describe("decide: threshold rebalance policy", () => {
  // Pure logic, no chain — always runs, exercises decide/ in isolation.
  test("holds a balanced 50/50 strategy", () => {
    const state = syntheticState(1_000n, 1_000n, "1");
    const [decision] = decide([state]);
    expect(decision?.allocation.kind).toBe("hold");
  });

  test("flags a drifted strategy for rebalance", () => {
    const state = syntheticState(9_000n, 1_000n, "2");
    const [decision] = decide([state]);
    expect(decision?.allocation.kind).toBe("rebalance");
  });
});

describe("anvil fork harness", () => {
  // Needs foundry (anvil) on PATH and a FORK_RPC_URL pointing at a real RPC to pin state
  // against. Skips cleanly when either is missing so `bun test` still passes fresh-clone.
  test.skipIf(!hasAnvil || !hasForkUrl)(
    "boots a fork, snapshots, and reverts cleanly",
    async () => {
      const fork = await startAnvilFork(FORK_RPC_URL!);
      try {
        const snapshotId = await fork.snapshot();
        const blockBefore = await fork.client.getBlockNumber();

        // Strategies would read/write state here via AquaClient against fork.rpcUrl.

        await fork.revert(snapshotId);
        const blockAfter = await fork.client.getBlockNumber();
        expect(blockAfter).toBe(blockBefore);
      } finally {
        fork.stop();
      }
    },
  );
});
