/**
 * Pure staleness report for substrate-native self-update.
 * Cadence of evaluation belongs to a pool rhythm impulse, never a timer.
 */
export interface SelfUpdateReport {
  vessel: string;
  running_ref: string;
  origin_ref: string;
  stale: boolean;
  behind_hint?: string;
}

export function buildSelfUpdateReport(vessel: string, runningRef: string, originRef: string): SelfUpdateReport {
  const stale = runningRef !== originRef;
  return {
    vessel,
    running_ref: runningRef,
    origin_ref: originRef,
    stale,
    behind_hint: stale ? `running ${runningRef} behind origin ${originRef}` : undefined,
  };
}
