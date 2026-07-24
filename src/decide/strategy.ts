import type { Decision, StrategyState } from "../types";

// Rebalance threshold: act once a leg drifts more than this many bps from a 50/50 split.
const DRIFT_THRESHOLD_BPS = 500; // 5%
const BPS_DENOMINATOR = 10_000n;
const TARGET_BPS = 5_000;

// Placeholder policy: keep a two-token strategy near a 50/50 balance.
// TODO(hack): replace with the real alpha — this only exists so the engine loop has
// something concrete to decide on and the harness has something to test.
export function thresholdRebalancePolicy(state: StrategyState): Decision {
  if (!state.isActive || state.balances.length !== 2) {
    return {
      strategyHash: state.strategyHash,
      allocation: { kind: "hold" },
      reason: "not a 2-leg active strategy",
    };
  }

  const [a, b] = state.balances as [StrategyState["balances"][number], StrategyState["balances"][number]];
  const total = a.balance + b.balance;
  if (total === 0n) {
    return { strategyHash: state.strategyHash, allocation: { kind: "hold" }, reason: "empty strategy" };
  }

  const aBps = Number((a.balance * BPS_DENOMINATOR) / total);
  const driftBps = Math.abs(aBps - TARGET_BPS);

  if (driftBps < DRIFT_THRESHOLD_BPS) {
    return {
      strategyHash: state.strategyHash,
      allocation: { kind: "hold" },
      reason: `drift ${driftBps}bps under ${DRIFT_THRESHOLD_BPS}bps threshold`,
    };
  }

  const heavySide = aBps > TARGET_BPS ? a.token : b.token;
  return {
    strategyHash: state.strategyHash,
    allocation: { kind: "rebalance", token: heavySide, deltaBps: driftBps },
    reason: `drift ${driftBps}bps exceeds ${DRIFT_THRESHOLD_BPS}bps threshold`,
  };
}
