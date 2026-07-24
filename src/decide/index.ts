import type { Decision, StrategyState } from "../types";
import { thresholdRebalancePolicy } from "./strategy";

// Turn observed strategy states into allocation decisions.
// Swap thresholdRebalancePolicy for the real strategy logic during the hack —
// this is the one function build teams should be iterating on most.
export function decide(states: StrategyState[]): Decision[] {
  return states.map(thresholdRebalancePolicy);
}
