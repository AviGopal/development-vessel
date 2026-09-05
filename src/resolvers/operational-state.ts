/**
 * operational_state — derive the substrate's operating condition from live observation.
 *
 * This exists because the alternative was a document. A document asserting the planes, the
 * states and a recovery ladder is a cache: it keeps answering after it stops being true, and
 * nothing in it can notice the divergence. That is the same defect as a gate reading a stale
 * file and reporting confidently from it. CLAUDE.md already settles the precedence — the
 * running system is authoritative and current state is queried, not memorised.
 *
 * So the ladder is not written down here as fact. Each rung is a QUESTION, and the answer is
 * measured when asked. Rungs compose existing producers wherever one exists (law 3) rather
 * than re-deriving their logic.
 *
 * THE MOST IMPORTANT PROPERTY IS THAT IT REFUSES TO GUESS. A rung with no available
 * measurement reports `measurable: false` and says why. It never reports a passing rung it
 * could not check, because "I could not look" and "there is nothing there" are the two states
 * this whole system keeps confusing, and the confusion is always expensive.
 *
 * Ordered by dependency: an upper rung failing makes the ones below it uninformative.
 */

import type { ResolverResult } from "./types.js";

const SURREALDB_URL = process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000";
const SURREALDB_USERNAME = process.env["SURREALDB_USERNAME"] ?? "root";
const SURREALDB_PASSWORD =
  process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "root";
const SURREALDB_NS = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
const SURREALDB_DB = process.env["SURREALDB_DATABASE"] ?? "learning_loop";

/** Returns null on any failure — the caller must treat null as UNMEASURED, never as zero. */
async function count(sql: string): Promise<number | null> {
  try {
    const res = await fetch(`${SURREALDB_URL}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "surreal-ns": SURREALDB_NS,
        "surreal-db": SURREALDB_DB,
        Authorization: "Basic " + btoa(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`),
      },
      body: sql,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ status?: string; result?: unknown }>;
    const first = data[0];
    if (first?.status !== "OK") return null;
    const rows = first.result;
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const c = (rows[0] as Record<string, unknown>)["count"];
    return typeof c === "number" ? c : null;
  } catch {
    return null;
  }
}

export interface Rung {
  rung: number;
  question: string;
  measurable: boolean;
  /** null whenever measurable is false — never a default that could read as a verdict. */
  holds: boolean | null;
  observed: Record<string, unknown>;
  /** Why it could not be measured, when it could not be. */
  unmeasured_reason?: string;
}

/**
 * Pure over its inputs so the shape of the answer is testable without a substrate.
 * Every argument is `number | null`, and null means UNMEASURED throughout.
 */
export function deriveRungs(obs: {
  executionsRecent: number | null;
  gateRulesTotal: number | null;
  gateRulesFailing: number | null;
  driftMissing: number | null;
  driftHazards: number | null;
  driftUnavailable: string | null;
  executionsTotal: number | null;
  executionsGraded: number | null;
  armsSelectable: number | null;
  gradedPerDay: number | null;
}): Rung[] {
  const rungs: Rung[] = [];

  rungs.push(
    obs.executionsRecent === null
      ? {
          rung: 1,
          question: "Is the fleet up and writing traces?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "trace store did not answer a count query",
        }
      : {
          rung: 1,
          question: "Is the fleet up and writing traces?",
          measurable: true,
          holds: obs.executionsRecent > 0,
          observed: { executions_last_hour: obs.executionsRecent },
        },
  );

  // Rungs 2 and 3 are deliberately reported as unmeasured rather than assumed. Counting gate
  // activity would measure how often gates RAN, which is not the same claim and would read as
  // a passing verdict for a question nothing actually answered.
  rungs.push({
    rung: 2,
    question: "Does anything land unexamined — is there a checker that actually reads each staged artifact type?",
    measurable: false,
    holds: null,
    observed: {},
    unmeasured_reason:
      "no producer enumerates staged artifact types against the checkers able to parse them; " +
      "gate activity counts would measure how often gates ran, not whether every artifact was read",
  });

  rungs.push({
    rung: 3,
    question: "Are landed changes known to DO something?",
    measurable: false,
    holds: null,
    observed: {},
    unmeasured_reason:
      "effect verification exists per-rule inside the refusal chain, but nothing reports coverage " +
      "of landed diffs whose changed behaviour was actually executed",
  });

  rungs.push(
    obs.gateRulesTotal === null || obs.gateRulesFailing === null
      ? {
          rung: 4,
          question: "Are the gates known to still refuse what they were built to refuse?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "gate self-probe did not return",
        }
      : {
          rung: 4,
          question: "Are the gates known to still refuse what they were built to refuse?",
          measurable: true,
          holds: obs.gateRulesFailing === 0 && obs.gateRulesTotal > 0,
          observed: { rules_total: obs.gateRulesTotal, rules_failing: obs.gateRulesFailing },
        },
  );

  rungs.push(
    obs.driftUnavailable !== null || obs.driftMissing === null
      ? {
          rung: 5,
          question: "Is declared-vs-live drift detected rather than rediscovered?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: obs.driftUnavailable ?? "declaration drift scan did not return",
        }
      : {
          rung: 5,
          question: "Is declared-vs-live drift detected rather than rediscovered?",
          measurable: true,
          // The rung is about DETECTION working, and a clean store is the strongest evidence
          // that it ran and found nothing outstanding.
          holds: (obs.driftMissing ?? 0) === 0 && (obs.driftHazards ?? 0) === 0,
          observed: { missing: obs.driftMissing, confirmed_hazards: obs.driftHazards },
        },
  );

  const gradedFrac =
    obs.executionsTotal && obs.executionsTotal > 0 && obs.executionsGraded !== null
      ? obs.executionsGraded / obs.executionsTotal
      : null;
  rungs.push(
    gradedFrac === null
      ? {
          rung: 6,
          question: "Are outcomes graded often enough to learn from?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "execution counts unavailable",
        }
      : {
          rung: 6,
          question: "Are outcomes graded often enough to learn from?",
          measurable: true,
          // Below a majority, selection is being trained on a proxy and any claim about
          // compounding is unfalsifiable. The threshold is a judgement; the number is not.
          holds: gradedFrac >= 0.5,
          observed: {
            graded_fraction: Number(gradedFrac.toFixed(4)),
            graded: obs.executionsGraded,
            total: obs.executionsTotal,
          },
        },
  );

  // Posterior movement is a RATE requirement, not a bank: evidence decays, so what matters is
  // graded executions per arm per day, not the total ever accumulated.
  const perArmPerDay =
    obs.gradedPerDay !== null && obs.armsSelectable && obs.armsSelectable > 0
      ? obs.gradedPerDay / obs.armsSelectable
      : null;
  rungs.push(
    perArmPerDay === null
      ? {
          rung: 7,
          question: "Does evidence accumulate per arm faster than arms are minted?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "graded-per-day or selectable-arm count unavailable",
        }
      : {
          rung: 7,
          question: "Does evidence accumulate per arm faster than arms are minted?",
          measurable: true,
          holds: perArmPerDay >= 2.31,
          observed: {
            graded_per_arm_per_day: Number(perArmPerDay.toFixed(4)),
            required: 2.31,
            graded_per_day: obs.gradedPerDay,
            selectable_arms: obs.armsSelectable,
          },
        },
  );

  return rungs;
}

export async function resolveOperationalState(
  pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  const day = "time::now() - 1d";
  const [executionsRecent, executionsTotal, executionsGraded, armsSelectable, gradedPerDay] =
    await Promise.all([
      count("SELECT count() FROM execution WHERE executed_at > time::now() - 1h GROUP ALL;"),
      count("SELECT count() FROM execution GROUP ALL;"),
      count("SELECT count() FROM execution WHERE reached != NONE GROUP ALL;"),
      count("SELECT count() FROM activity WHERE retired = false OR retired IS NONE GROUP ALL;"),
      count(`SELECT count() FROM execution WHERE reached != NONE AND executed_at > ${day} GROUP ALL;`),
    ]);

  // Compose the existing producers rather than re-deriving them (law 3).
  let gateRulesTotal: number | null = null;
  let gateRulesFailing: number | null = null;
  if (pointer["skip_gate_probe"] !== true) {
    try {
      const { resolveGateSelfProbe } = await import("./gate-self-probe.js");
      const g = (await resolveGateSelfProbe({ emit_gap: false })).body as Record<string, unknown>;
      gateRulesTotal = typeof g["rules_total"] === "number" ? (g["rules_total"] as number) : null;
      gateRulesFailing =
        typeof g["rules_failing"] === "number" ? (g["rules_failing"] as number) : null;
    } catch {
      /* leave null — unmeasured, not passing */
    }
  }

  let driftMissing: number | null = null;
  let driftHazards: number | null = null;
  let driftUnavailable: string | null = null;
  if (pointer["skip_drift_scan"] !== true) {
    try {
      const { resolveSchemaAssertDriftScan } = await import("./schema-assert-drift-scan.js");
      const d = (await resolveSchemaAssertDriftScan({})).body as Record<string, unknown>;
      driftUnavailable = (d["declaration_unavailable"] as string | null) ?? null;
      const dd = d["declaration_drift"] as
        | { missing?: unknown[]; hazards?: unknown[] }
        | null
        | undefined;
      if (dd) {
        driftMissing = Array.isArray(dd.missing) ? dd.missing.length : null;
        driftHazards = Array.isArray(dd.hazards) ? dd.hazards.length : null;
      }
    } catch (e) {
      driftUnavailable = `drift_scan_failed: ${(e as Error).message}`;
    }
  }

  const rungs = deriveRungs({
    executionsRecent,
    gateRulesTotal,
    gateRulesFailing,
    driftMissing,
    driftHazards,
    driftUnavailable,
    executionsTotal,
    executionsGraded,
    armsSelectable,
    gradedPerDay,
  });

  const measured = rungs.filter((r) => r.measurable);
  const holding = measured.filter((r) => r.holds === true);
  // The first non-holding measured rung: rungs below it are uninformative, because an upper
  // rung failing invalidates what the lower ones appear to say.
  const firstBroken = measured.find((r) => r.holds === false)?.rung ?? null;

  return {
    shape: "operationalState",
    body: {
      rungs,
      rungs_total: rungs.length,
      rungs_measurable: measured.length,
      rungs_holding: holding.length,
      first_broken_rung: firstBroken,
      measurement_coverage: Number((measured.length / rungs.length).toFixed(2)),
      // THE HEADLINE FIELD MUST NOT BE GREEN WHEN ALMOST NOTHING WAS CHECKED.
      //
      // The first version exposed `all_measurable_rungs_hold`, which returned TRUE with one of
      // seven rungs measured — true to its own name and a green light to anyone reading it.
      // That is the exact failure this resolver exists to detect: a component reporting
      // success about something it did not examine. A caller wants one field, and it has to
      // be the honest one.
      //
      // INSUFFICIENT_MEASUREMENT outranks HOLDS. Broken still outranks both, because a rung
      // observed to fail is a finding no amount of missing coverage softens.
      verdict:
        firstBroken !== null
          ? "broken"
          : measured.length * 2 < rungs.length
            ? "insufficient_measurement"
            : "holds",
      // Kept for callers that want the raw conjunction, but never as the headline.
      all_measurable_rungs_hold: measured.length > 0 && holding.length === measured.length,
      derived_at: new Date().toISOString(),
    },
  };
}
