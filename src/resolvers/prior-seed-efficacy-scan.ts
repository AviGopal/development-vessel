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
  const windowMinutes = pointer.windowMinutes ?? 1440;
  const minSamples = pointer.minSamples ?? 20;
  const dryRun = pointer.dry_run === true;
  const emitUrl = pointer.devVesselImpulsesUrl ?? "http://127.0.0.1:8090/v2/impulses/resolve";
  let seeded = 0;
  let seededWins = 0;
  let unseeded = 0;
  let unseededWins = 0;
  let total = 0;
  try {
    const proc = Bun.spawn(
      ["journalctl", "--no-pager", "-u", "activity-api.service", "--since", `${windowMinutes} minutes ago`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) {
      const i = line.indexOf('{"event":"posterior_update_v1_conditional"');
      if (i < 0) continue;
      try {
        const ev = JSON.parse(line.slice(i)) as { prior_seed_source?: string; prior_seed_neighbors?: number; alpha_delta?: number; beta_delta?: number };
        total += 1;
        const isSeeded = ev.prior_seed_source !== undefined && ev.prior_seed_source !== "fallback" && (ev.prior_seed_neighbors ?? 0) > 0;
        const win = (ev.alpha_delta ?? 0) > (ev.beta_delta ?? 0);
        if (isSeeded) {
          seeded += 1;
          if (win) seededWins += 1;
        } else {
          unseeded += 1;
          if (win) unseededWins += 1;
        }
      } catch { continue; }
    }
  } catch (e) {
    console.warn(`[prior-seed-efficacy-scan] journal read failed: ${(e as Error).message}`);
  }
  const seededRate = seeded > 0 ? seededWins / seeded : null;
  const unseededRate = unseeded > 0 ? unseededWins / unseeded : null;
  let verdict = "insufficient_data";
  let gapId: string | null = null;
  if (total >= 10 && seeded === 0) {
    verdict = "seeding_inactive";
    gapId = "gap-prior-seed-inactive";
  } else if (seeded >= minSamples && seededRate !== null && unseededRate !== null && seededRate <= unseededRate) {
    verdict = "seeding_not_helping";
    gapId = "gap-prior-seed-not-helping";
  } else if (seeded >= minSamples) {
    verdict = "seeding_helping";
  } else if (seeded > 0) {
    verdict = "seeding_active_low_sample";
  }
  let posted = false;
  if (gapId && !dryRun) {
    try {
      const apiKey = process.env["METABOB_API_KEY"];
      const summary = verdict === "seeding_inactive"
        ? `Prior seeding is INACTIVE: ${total} posterior updates in ${windowMinutes}min and every cell fell back to Beta(1,1) (prior_seed_source=fallback, prior_seed_neighbors=0). The concept-prior seeding path never activates; wire or fix the seed source so new cells start from concept-derived priors.`
        : `Prior seeding is NOT HELPING: over ${seeded} seeded samples the first-attempt win rate (${seededRate === null ? "n/a" : seededRate.toFixed(3)}) is <= unseeded (${unseededRate === null ? "n/a" : unseededRate.toFixed(3)}). Re-examine neighbor selection and seed strength.`;
      const resp = await fetch(emitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", gap: {
          id: gapId,
          category: "learning_loop",
          source: "substrate_detected",
          status: "open",
          summary,
          detected_at: new Date().toISOString(),
          classification_metadata: { kind: "prior_seed_efficacy", window_minutes: windowMinutes, total_events: total, seeded_samples: seeded, unseeded_samples: unseeded, seeded_win_rate: seededRate, unseeded_win_rate: unseededRate },
        } } } }),
        signal: AbortSignal.timeout(15_000),
      });
      posted = resp.ok;
    } catch (e) {
      console.warn(`[prior-seed-efficacy-scan] gap post failed: ${(e as Error).message}`);
    }
  }
  return {
    shape: "priorSeedEfficacyReport",
    body: {
      scanned: true,
      verdict,
      window_minutes: windowMinutes,
      total_events: total,
      seeded_samples: seeded,
      unseeded_samples: unseeded,
      seeded_win_rate: seededRate,
      unseeded_win_rate: unseededRate,
      gap_id: gapId,
      gap_posted: posted,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
