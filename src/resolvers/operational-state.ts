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
  /** Executions from arms the system has graded at least once — the reach-eligible population. */
  executionsOnGradedArms: number | null;
  /** Executions from arms it has NEVER graded: ticks, detectors, scheduled work with no goal. */
  executionsOnNeverGradedArms: number | null;
  neverGradedArms: number | null;
  /** Compose runs that recorded effect coverage, and the targets they examined/left uncovered. */
  effectComposes: number | null;
  effectTargetsExamined: number | null;
  effectTargetsUncovered: number | null;
  /** Compose runs recording which staged files any checker could read, and the counts. */
  examComposes: number | null;
  examExamined: number | null;
  examUnexamined: number | null;
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
  // Every check script in the static gate is a TypeScript tool, so a staged .json, .yaml, .md
  // or .sh passes with NOTHING having opened it while static_checks_pass is returned all the
  // same. The gate now reports which staged files it could actually read (CHECKED_EXTENSIONS
  // lives in the gate, not here, so the two cannot drift), and that is what this reads.
  rungs.push(
    obs.examComposes === null || obs.examComposes === 0 || obs.examExamined === null
      ? {
          rung: 2,
          question: "Does anything land unexamined — is there a checker that actually reads each staged artifact type?",
          measurable: false,
          holds: null,
          observed: { composes_reporting_examination: obs.examComposes ?? 0 },
          unmeasured_reason:
            "no compose trace carries the examination split yet — feature_compose records it " +
            "from this build onward. Absence of the field is absence of measurement, NOT " +
            "evidence that everything staged was read.",
        }
      : (() => {
          const examined = obs.examExamined ?? 0;
          const unexamined = obs.examUnexamined ?? 0;
          const total = examined + unexamined;
          const frac = total > 0 ? examined / total : null;
          return {
            rung: 2,
            question: "Does anything land unexamined — is there a checker that actually reads each staged artifact type?",
            measurable: frac !== null,
            // Nothing should land unread. This is stricter than the other rungs on purpose:
            // an unexamined artifact is not a weak signal, it is no signal, and the session
            // that produced this rung landed a database-breaking migration through exactly
            // that hole.
            holds: frac !== null ? unexamined === 0 : null,
            observed: {
              examined_fraction: frac === null ? null : Number(frac.toFixed(4)),
              staged_examined: examined,
              staged_unexamined: unexamined,
              composes_reporting_examination: obs.examComposes,
            },
            ...(frac === null
              ? { unmeasured_reason: "composes reported the split but staged zero files" }
              : {}),
          };
        })(),
  );

  // Every gate in the compose path READS the diff; only a test RUNS it. A FAVORABLE verdict on
  // a target with no test file means the change was reviewed, never executed — the condition
  // under which inert and actively harmful changes have landed here before. feature_compose
  // computed that coverage and only console.warn'd it, so the question was unanswerable; it is
  // now persisted on the compose trace and read here.
  rungs.push(
    obs.effectComposes === null || obs.effectComposes === 0 || obs.effectTargetsExamined === null
      ? {
          rung: 3,
          question: "Are landed changes known to DO something?",
          measurable: false,
          holds: null,
          observed: { composes_reporting_coverage: obs.effectComposes ?? 0 },
          unmeasured_reason:
            "no compose trace carries effect coverage yet — feature_compose persists it from " +
            "this build onward, so this becomes measurable once composes run with it. Absence " +
            "of the field is absence of measurement, NOT evidence that coverage is fine.",
        }
      : (() => {
          const examined = obs.effectTargetsExamined;
          const uncovered = obs.effectTargetsUncovered ?? 0;
          const coveredFrac = examined > 0 ? (examined - uncovered) / examined : null;
          return {
            rung: 3,
            question: "Are landed changes known to DO something?",
            measurable: coveredFrac !== null,
            // A majority of changed targets must have something able to execute them. The
            // threshold is a judgement; the counts beside it are not.
            holds: coveredFrac !== null ? coveredFrac >= 0.5 : null,
            observed: {
              covered_fraction: coveredFrac === null ? null : Number(coveredFrac.toFixed(4)),
              targets_examined: examined,
              targets_uncovered: uncovered,
              composes_reporting_coverage: obs.effectComposes,
            },
            ...(coveredFrac === null
              ? { unmeasured_reason: "composes reported coverage but examined zero targets" }
              : {}),
          };
        })(),
  );

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

  // NAME THE DENOMINATOR, OR THE RUNG CANNOT MOVE.
  //
  // Measured on the live store: 61.1% of executions (22,374 of 36,645) come from the 1,160
  // arms of 1,391 the system has NEVER graded — ticks, detectors and scheduled work that has
  // no goal to reach. Asking whether a cron tick "reached its goal" is a category error, so
  // dividing by them produced 0.2066 and made the rung unmovable by ANY amount of grading.
  // Over the arms the system actually grades, coverage is 0.5306.
  //
  // The correction must not bury what it corrects. The never-graded share is reported
  // alongside, because "most executions carry no goal-level signal" is a real condition — it
  // is simply a DIFFERENT condition from "grading is broken", and conflating them cost this
  // rung its ability to say anything.
  const eligible =
    obs.executionsOnGradedArms !== null && obs.executionsGraded !== null
      ? obs.executionsOnGradedArms
      : null;
  const gradedFrac = eligible && eligible > 0 ? (obs.executionsGraded ?? 0) / eligible : null;
  const neverShare =
    obs.executionsOnNeverGradedArms !== null && obs.executionsTotal && obs.executionsTotal > 0
      ? obs.executionsOnNeverGradedArms / obs.executionsTotal
      : null;
  rungs.push(
    gradedFrac === null
      ? {
          rung: 6,
          question: "Are outcomes graded often enough to learn from?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "per-arm graded/ungraded execution counts unavailable",
        }
      : {
          rung: 6,
          question: "Are outcomes graded often enough to learn from?",
          measurable: true,
          // Below a majority of the ELIGIBLE population, selection is trained on a proxy and
          // any claim about compounding is unfalsifiable. The 0.5 threshold is a judgement;
          // the numbers beside it are not, and are reported so the judgement can be argued.
          holds: gradedFrac >= 0.5,
          observed: {
            graded_fraction_of_eligible: Number(gradedFrac.toFixed(4)),
            graded: obs.executionsGraded,
            eligible: eligible,
            graded_fraction_of_all: obs.executionsTotal
              ? Number(((obs.executionsGraded ?? 0) / obs.executionsTotal).toFixed(4))
              : null,
            never_graded_arm_share_of_executions:
              neverShare === null ? null : Number(neverShare.toFixed(4)),
            never_graded_arms: obs.neverGradedArms,
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

export interface LadderSummary {
  rungs_total: number;
  rungs_measurable: number;
  rungs_holding: number;
  first_broken_rung: number | null;
  measurement_coverage: number;
  verdict: "broken" | "insufficient_measurement" | "holds";
  all_measurable_rungs_hold: boolean;
}

/**
 * PURE, and separated from the resolver deliberately.
 *
 * The first version of this logic lived inside resolveOperationalState and was tested by
 * CALLING that resolver — which performs I/O. The test therefore passed where the store was
 * unreachable and failed where it was reachable, and the pre-cutover gate caught it as a test
 * regression attributable to the commit and refused to converge. That refusal was correct: a
 * test whose outcome depends on whether a database answers is testing the environment.
 *
 * Summary logic is a pure function of the rungs, so it is tested as one.
 */
export function summariseLadder(rungs: Rung[]): LadderSummary {
  const measured = rungs.filter((r) => r.measurable);
  const holding = measured.filter((r) => r.holds === true);
  const firstBroken = measured.find((r) => r.holds === false)?.rung ?? null;
  return {
    rungs_total: rungs.length,
    rungs_measurable: measured.length,
    rungs_holding: holding.length,
    first_broken_rung: firstBroken,
    measurement_coverage:
      rungs.length === 0 ? 0 : Number((measured.length / rungs.length).toFixed(2)),
    // THE HEADLINE MUST NOT BE GREEN WHEN ALMOST NOTHING WAS CHECKED. An earlier version
    // exposed `all_measurable_rungs_hold`, which returned TRUE with one of seven rungs
    // measured — true to its own name and a green light to any reader, which is the exact
    // failure this resolver exists to detect. Broken outranks everything, because a rung
    // observed failing is a finding no amount of missing coverage softens.
    // `measured * 2 < total` is false for an empty ladder, which fell through to "holds" —
    // zero rungs measured reported as healthy, the maximal case of the very failure this
    // field exists to prevent. Nothing measured is never green.
    verdict:
      firstBroken !== null
        ? "broken"
        : measured.length === 0 || measured.length * 2 < rungs.length
          ? "insufficient_measurement"
          : "holds",
    all_measurable_rungs_hold: measured.length > 0 && holding.length === measured.length,
  };
}

/**
 * Per-arm graded/ungraded execution counts, used to separate the reach-ELIGIBLE population
 * from ticks and detectors that have no goal to reach. Returns null on any failure so the
 * caller reports UNMEASURED rather than inventing a denominator.
 */
async function armSplit(): Promise<
  { onGradedArms: number; onNeverGradedArms: number; neverGradedArms: number } | null
> {
  const rows = async (where: string): Promise<Map<string, number> | null> => {
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
        body: `SELECT activity_id, count() FROM execution WHERE ${where} GROUP BY activity_id;`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{ status?: string; result?: unknown }>;
      if (data[0]?.status !== "OK" || !Array.isArray(data[0].result)) return null;
      const m = new Map<string, number>();
      for (const r of data[0].result as Array<Record<string, unknown>>) {
        const id = r["activity_id"];
        const c = r["count"];
        if (typeof id === "string" && typeof c === "number") m.set(id, c);
      }
      return m;
    } catch {
      return null;
    }
  };
  const [g, u] = await Promise.all([rows("reached != NONE"), rows("reached IS NONE")]);
  if (!g || !u) return null;
  let onGraded = 0;
  let onNever = 0;
  let neverArms = 0;
  for (const [k, v] of u) {
    if (g.has(k)) onGraded += v;
    else {
      onNever += v;
      neverArms++;
    }
  }
  for (const v of g.values()) onGraded += v;
  return { onGradedArms: onGraded, onNeverGradedArms: onNever, neverGradedArms: neverArms };
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
      const dd = d["declaration_drift"] as { missing?: unknown[]; hazards?: unknown[] } | null | undefined;
      if (dd) {
        driftMissing = Array.isArray(dd.missing) ? dd.missing.length : null;
        driftHazards = Array.isArray(dd.hazards) ? dd.hazards.length : null;
      }
    } catch (e) {
      driftUnavailable = `drift_scan_failed: ${(e as Error).message}`;
    }
  }

  const split = pointer["skip_arm_split"] === true ? null : await armSplit();

  // Effect coverage over recent composes. Only traces written by a build that persists the
  // field are counted; older ones are absent, not zero.
  const [effectComposes, effectExamined, effectUncovered] = await Promise.all([
    count("SELECT count() FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
    count("SELECT math::sum(metadata.effect_targets_examined) AS count FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
    count("SELECT math::sum(metadata.effect_targets_uncovered) AS count FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
  ]);
  const [examComposes, examExamined, examUnexamined] = await Promise.all([
    count("SELECT count() FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
    count("SELECT math::sum(metadata.examination_examined) AS count FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
    count("SELECT math::sum(metadata.examination_unexamined) AS count FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
  ]);

  const rungs = deriveRungs({
    executionsRecent,
    gateRulesTotal,
    gateRulesFailing,
    driftMissing,
    driftHazards,
    driftUnavailable,
    executionsTotal,
    executionsGraded,
    executionsOnGradedArms: split?.onGradedArms ?? null,
    executionsOnNeverGradedArms: split?.onNeverGradedArms ?? null,
    neverGradedArms: split?.neverGradedArms ?? null,
    effectComposes,
    effectTargetsExamined: effectExamined,
    effectTargetsUncovered: effectUncovered,
    examComposes,
    examExamined,
    examUnexamined,
    armsSelectable,
    gradedPerDay,
  });

  return {
    shape: "operationalState",
    body: {
      rungs,
      ...summariseLadder(rungs),
      derived_at: new Date().toISOString(),
    },
  };
}
