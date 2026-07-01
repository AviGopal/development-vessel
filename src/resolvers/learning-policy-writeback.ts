/**
 * learning_policy_writeback — reflect tick that ACTUATES the learning policy
 * (seam 2b of the P2 actuation work: "reflect adjusts the learner").
 *
 * The `learning_policy` producer (resolvers/learning-policy.ts) emits
 * `recommended_hyperparameters` from live Thompson convergence evidence, but
 * nothing wrote those back — they were advisory. This tick closes the loop:
 *
 *   1. dispatch the existing `learning_policy` producer in-process,
 *   2. read recommended_hyperparameters + the evidence string,
 *   3. for the two learner-consumed hyperparameters (TD_LAMBDA, YIELD_FLOOR),
 *      CLAMP to the safe operating range, compare against the currently-authored
 *      value, and POST to activity-api `/v2/tuning-params` ONLY when the
 *      recommendation differs from the current value by more than a threshold.
 *
 * The activity-api `getTuningParam` reader picks the row up within one TTL
 * window (no restart). Low cadence + differ-by-threshold gating keep this from
 * thrashing the learner: a run that recommends the same value is a no-op.
 *
 * Endpoint: writes go to the SAME activity-api the learning-policy producer
 * READS from — TUNING_PARAM_ENDPOINT if set, else ACTIVITY_API_ENDPOINT (the
 * env the substrate's writers use), else METABOB_ENDPOINT, else localhost. This
 * keeps writer and reader on one substrate.
 */

import type { ResolverResult } from "./types.js";
import { resolveLearningPolicy } from "./learning-policy.js";
import { fetchWithRetry } from "./http-retry.js";

export interface LearningPolicyWritebackPointer {
  type: "learning_policy_writeback";
  /** Minimum absolute change vs the currently-authored value to bother writing. */
  min_delta?: number;
  [key: string]: unknown;
}

// Clamp ranges for the two learner-consumed hyperparameters (operator-set safe
// operating envelope). TD_LAMBDA is the eligibility-trace decay; YIELD_FLOOR is
// the exploration floor. Values outside these bands are never authored.
const CLAMPS: Record<string, { lo: number; hi: number }> = {
  TD_LAMBDA: { lo: 0.3, hi: 0.95 },
  YIELD_FLOOR: { lo: 0, hi: 1 },
};

function clamp(name: string, value: number): number {
  const c = CLAMPS[name];
  if (!c) return value;
  return Math.max(c.lo, Math.min(c.hi, value));
}

function tuningEndpoint(): string {
  return (
    process.env["TUNING_PARAM_ENDPOINT"] ??
    process.env["ACTIVITY_API_ENDPOINT"] ??
    process.env["METABOB_ENDPOINT"] ??
    "http://127.0.0.1:8080"
  );
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}`,
    "Content-Type": "application/json",
  };
}

/** Read the currently-authored value for a tuning param (null if unset). */
async function readCurrent(endpoint: string, name: string): Promise<number | null> {
  try {
    const res = await fetchWithRetry(
      `${endpoint}/v2/tuning-params/${encodeURIComponent(name)}`,
      { method: "GET", headers: authHeaders(), timeoutMs: 15000 },
      { attempts: 2 },
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as { value?: number | null };
    return typeof data.value === "number" && Number.isFinite(data.value) ? data.value : null;
  } catch {
    return null;
  }
}

export async function resolveLearningPolicyWriteback(
  pointer: LearningPolicyWritebackPointer,
): Promise<ResolverResult> {
  const minDelta = typeof pointer.min_delta === "number" && pointer.min_delta >= 0 ? pointer.min_delta : 0.02;
  const endpoint = tuningEndpoint();

  // 1. Dispatch the existing learning_policy producer in-process.
  const policy = await resolveLearningPolicy({ type: "learning_policy" });
  const body = (policy.body ?? {}) as {
    recommended_hyperparameters?: Record<string, unknown>;
    evidence?: unknown;
    rationale?: unknown;
  };
  const recommended = (body.recommended_hyperparameters ?? {}) as Record<string, unknown>;

  // Evidence string stored alongside each authored row for audit.
  const evidence = JSON.stringify({
    evidence: body.evidence ?? null,
    rationale: typeof body.rationale === "string" ? body.rationale : undefined,
    source: "learning_policy_writeback",
    at: new Date().toISOString(),
  });

  const results: Array<{
    name: string;
    recommended: number;
    clamped: number;
    current: number | null;
    action: "written" | "skipped_within_threshold" | "invalid" | "write_failed";
  }> = [];

  // 2/3. Only the two learner-consumed hyperparameters actuate.
  for (const name of Object.keys(CLAMPS)) {
    const raw = recommended[name];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      results.push({ name, recommended: NaN, clamped: NaN, current: null, action: "invalid" });
      continue;
    }
    const clamped = clamp(name, raw);
    const current = await readCurrent(endpoint, name);

    if (current !== null && Math.abs(clamped - current) < minDelta) {
      results.push({ name, recommended: raw, clamped, current, action: "skipped_within_threshold" });
      continue;
    }

    let action: "written" | "write_failed" = "write_failed";
    try {
      const res = await fetchWithRetry(
        `${endpoint}/v2/tuning-params`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ name, value: clamped, updated_by: "learning-policy-writeback", evidence }),
          timeoutMs: 15000,
        },
        { attempts: 2 },
      );
      if (res && res.ok) action = "written";
    } catch {
      action = "write_failed";
    }
    results.push({ name, recommended: raw, clamped, current, action });
  }

  return {
    shape: "learningPolicyWriteback",
    body: {
      endpoint,
      min_delta: minDelta,
      results,
      written: results.filter((r) => r.action === "written").map((r) => r.name),
      generated_at: new Date().toISOString(),
      pointer_type: pointer.type,
    },
  };
}
