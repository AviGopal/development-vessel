import type { ResolverResult } from "./types.js";

/**
 * prior_seed_efficacy_scan — detector measuring whether concept-prior seeding of
 * Thompson cells is active and helping. Reads activity-api's
 * posterior_update_v1_conditional telemetry from the journal: each event carries
 * prior_seed_source ("fallback" = unseeded Beta(1,1)) and prior_seed_neighbors.
 * Compares first-attempt outcome (alpha_delta > beta_delta) for seeded vs
 * unseeded cells over the window. Files a substrateGap with a STABLE id when
 * seeding is inactive (gap-prior-seed-inactive) or measurably not helping over
 * at least minSamples seeded samples (gap-prior-seed-not-helping).
 */
export interface PriorSeedEfficacyScanPointer {
  type: "prior_seed_efficacy_scan";
  /** Lookback window in minutes for journalctl --since. Default 1440 (24h). */
  windowMinutes?: number;
  /** Minimum seeded samples before a not-helping verdict. Default 20. */
  minSamples?: number;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
}

export async function resolvePriorSeedEfficacyScan(
  pointer: PriorSeedEfficacyScanPointer,
): Promise<ResolverResult> {
  // SKELETON (2026-07-04): journal-scan behavior lands in the follow-up compose.
  return {
    shape: "priorSeedEfficacyReport",
    body: {
      scanned: false,
      verdict: "skeleton",
      window_minutes: pointer.windowMinutes ?? 1440,
      note: "skeleton only — journal-scan behavior lands in the follow-up compose",
    },
  };
}
