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

/**
 * Competition-set sizes: how many selectable arms share each output-shape signature.
 * One grouped query (measured ~464ms) rather than scanning every arm. Returns null on failure
 * so rung 7 reports UNMEASURED rather than inventing a partition.
 */
async function familySizes(): Promise<number[] | null> {
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
      body:
        "SELECT output_shapes, count() FROM activity " +
        "WHERE retired = false OR retired IS NONE GROUP BY output_shapes;",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ status?: string; result?: unknown }>;
    if (data[0]?.status !== "OK" || !Array.isArray(data[0].result)) return null;
    return (data[0].result as Array<Record<string, unknown>>)
      .map((r) => (typeof r["count"] === "number" ? (r["count"] as number) : 0))
      .filter((n) => n > 0);
  } catch {
    return null;
  }
}

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
      // 15s per query meant one slow count could hold the whole derivation past any caller's
      // patience. A count that cannot answer in 6s under load is not going to produce a useful
      // reading, and null (UNMEASURED) is the honest result — far better than a timeout that
      // discards the ten readings that DID succeed.
      signal: AbortSignal.timeout(6_000),
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


/**
 * Partition arms by whether evidence about them can change a decision.
 *
 * Thompson only has a choice to make where two or more arms produce the shape the walk needs.
 * That makes "graded executions per arm per day" the wrong denominator over the whole fleet,
 * for two opposite reasons measured on the live store:
 *
 *   SINGLETONS (529 arms, 1 competitor)      evidence buys NOTHING — the arm is selected
 *                                            regardless of its posterior. They hold ~500
 *                                            graded outcomes, about a sixth of all evidence,
 *                                            purchasing no discrimination.
 *   INTRACTABLE (1,696 arms in 19 families    unreachable at any plausible rate. Separating
 *   of >20)                                  583 patch_proposal arms needs order 58,000
 *                                            observations; there are 14. Spending evidence
 *                                            here is not a shortfall, it is a category error.
 *   DISCRIMINABLE (2-20 competitors)         the band where an observation converts into a
 *                                            better decision.
 *
 * Reporting a single fleet-wide rate hides all of that behind one number, which is the same
 * defect rung 6 carried when it divided by ticks that structurally cannot be graded.
 *
 * PURE over the family sizes, so the partition is testable without a store.
 */
export function competitionBuckets(familySizes: number[]): {
  singleton_arms: number;
  discriminable_arms: number;
  intractable_arms: number;
  discriminable_families: number;
  intractable_families: number;
} {
  let singleton = 0, discriminable = 0, intractable = 0, dFam = 0, iFam = 0;
  for (const n of familySizes) {
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n === 1) singleton += 1;
    else if (n <= 20) { discriminable += n; dFam += 1; }
    else { intractable += n; iFam += 1; }
  }
  return {
    singleton_arms: singleton,
    discriminable_arms: discriminable,
    intractable_arms: intractable,
    discriminable_families: dFam,
    intractable_families: iFam,
  };
}

/**
 * Bumped whenever a rung's DEFINITION changes — its denominator, threshold, or what it counts.
 *
 * Rung 7 flipped broken -> holds the moment its denominator changed from all selectable arms
 * to the discriminable population. Nothing in the substrate improved; the measurement did. The
 * delta reported that transition in exactly the same shape as a real improvement, which is
 * effect-as-cause in the one instrument built to prevent it — anything reading the ledger to
 * judge whether an action helped would have credited an edit of mine as progress.
 *
 * Keyed by rung so a change to one does not invalidate comparisons of the others.
 */
export const RUNG_DEFINITION_VERSION: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 1,
  // 2 = graded over ELIGIBLE executions (arms the system grades at all), not over all
  // executions including ticks that structurally cannot carry a goal verdict.
  6: 2,
  // 2 = graded per DISCRIMINABLE arm (2-20 competitors), not per selectable arm — singletons
  // cannot use evidence and >20-arm families cannot be separated at any achievable rate.
  7: 2,
};

export interface Rung {
  rung: number;
  question: string;
  /** The definition this reading was produced under. A change here is not a change in the world. */
  definition_version?: number;
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
  /** Competition-set sizes: how many arms produce each distinct output-shape signature. */
  familySizes: number[] | null;
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
  //
  // MEASURED AGAINST THE POPULATION WHERE EVIDENCE CAN CHANGE A DECISION. A fleet-wide rate
  // treats a singleton (no competitor, posterior irrelevant) and a 583-way family (unreachable
  // at any rate) as equally in need of the same evidence. Neither is. The buckets travel with
  // the verdict so the correction cannot hide what it excluded.
  const buckets = obs.familySizes ? competitionBuckets(obs.familySizes) : null;
  const denom = buckets ? buckets.discriminable_arms : obs.armsSelectable;
  const perArmPerDay =
    obs.gradedPerDay !== null && denom && denom > 0 ? obs.gradedPerDay / denom : null;
  rungs.push(
    perArmPerDay === null
      ? {
          rung: 7,
          question: "Does evidence accumulate per arm faster than arms are minted?",
          measurable: false,
          holds: null,
          observed: {},
          unmeasured_reason: "graded-per-day or the competition-set partition was unavailable",
        }
      : {
          rung: 7,
          question: "Does evidence accumulate per arm faster than arms are minted?",
          measurable: true,
          holds: perArmPerDay >= 2.31,
          observed: {
            graded_per_discriminable_arm_per_day: Number(perArmPerDay.toFixed(4)),
            required: 2.31,
            graded_per_day: obs.gradedPerDay,
            discriminable_arms: buckets?.discriminable_arms ?? null,
            // Reported, never silently dropped: 1,696 arms unreachable is the finding, not
            // an inconvenience to divide away.
            intractable_arms: buckets?.intractable_arms ?? null,
            intractable_families: buckets?.intractable_families ?? null,
            singleton_arms_no_competitor: buckets?.singleton_arms ?? null,
            arms_selectable_total: obs.armsSelectable,
            graded_per_arm_per_day_fleetwide:
              obs.gradedPerDay !== null && obs.armsSelectable
                ? Number((obs.gradedPerDay / obs.armsSelectable).toFixed(4))
                : null,
          },
        },
  );

  // Stamp the definition each reading was produced under.
  return rungs.map((r) => ({ ...r, definition_version: RUNG_DEFINITION_VERSION[r.rung] ?? 1 }));
}


/**
 * PERSIST EACH DERIVATION, AND REPORT THE DELTA FROM THE LAST ONE.
 *
 * Without this the resolver can say what is true NOW and nothing else, which means no action
 * the substrate takes can ever be associated with a subsequent change in its own condition.
 * A landing, a retirement, a gap closure — each disappears into a system that has no memory of
 * what it was like beforehand. Causal association needs two observations and an ordering; this
 * supplies the first half.
 *
 * Written as an impulse rather than to a new table: `impulse` already exists, is SCHEMAFULL
 * with a FLEXIBLE `pointer`, and is the same channel upkeepAuditLog uses. A new table would
 * need DDL, and DDL that never applied is how the six missing `activity` fields happened.
 *
 * Best-effort. A failure to record history must not cost the caller the current reading —
 * losing the measurement to protect the archive would be the wrong trade.
 */
async function persistSnapshot(body: Record<string, unknown>): Promise<boolean> {
  try {
    const id = `opstate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify(body).replace(/'/g, "\\'");
    const res = await fetch(`${SURREALDB_URL}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "surreal-ns": SURREALDB_NS,
        "surreal-db": SURREALDB_DB,
        Authorization: "Basic " + btoa(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`),
      },
      body:
        `INSERT INTO impulse { id: '${id}', shape: 'operationalStateSnapshot', org_id: 'organizations:substrate', ` +
        `pointer: ${JSON.stringify(body)}, created_at: time::now(), budget: 0 };`,
      signal: AbortSignal.timeout(15_000),
    });
    void payload;
    return res.ok;
  } catch {
    return false;
  }
}

/** The previous snapshot's rung verdicts, for a delta. null when there is no history yet. */
async function previousSnapshot(): Promise<Record<string, unknown> | null> {
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
      body:
        "SELECT pointer, created_at FROM impulse WHERE shape = 'operationalStateSnapshot' " +
        "ORDER BY created_at DESC LIMIT 1;",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ status?: string; result?: unknown }>;
    if (data[0]?.status !== "OK" || !Array.isArray(data[0].result) || data[0].result.length === 0) return null;
    return (data[0].result[0] as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/**
 * What CHANGED since the last derivation. Pure, so the comparison is testable without history.
 *
 * Reports only rungs whose verdict actually moved, and states explicitly when there is no
 * prior snapshot — "nothing changed" and "nothing to compare against" are different claims and
 * conflating them is the failure this whole resolver exists to avoid.
 */
export function ladderDelta(
  current: Rung[],
  previous: Rung[] | null,
): {
  comparable: boolean;
  changed: Array<{ rung: number; from: string; to: string }>;
  redefined: Array<{ rung: number; from_version: number; to_version: number; from: string; to: string }>;
  reason?: string;
} {
  if (!previous || previous.length === 0) {
    return { comparable: false, changed: [], redefined: [], reason: "no prior snapshot — this is the first derivation on record" };
  }
  const verdict = (r: Rung) => (!r.measurable ? "unmeasured" : r.holds === true ? "holds" : "broken");
  const prev = new Map(previous.map((r) => [r.rung, r]));
  const changed: Array<{ rung: number; from: string; to: string }> = [];
  const redefined: Array<{ rung: number; from_version: number; to_version: number; from: string; to: string }> = [];
  for (const r of current) {
    const before = prev.get(r.rung);
    if (!before) continue; // a newly added rung has no 'from'; inventing one would fabricate history
    const bv = verdict(before);
    const av = verdict(r);
    if (bv === av) continue;
    // A READING TAKEN UNDER A DIFFERENT DEFINITION IS NOT A CHANGE IN THE WORLD. Reported
    // separately so nothing downstream can credit a redefinition as an improvement.
    const beforeVer = before.definition_version ?? 1;
    const afterVer = r.definition_version ?? 1;
    if (beforeVer !== afterVer) {
      redefined.push({ rung: r.rung, from_version: beforeVer, to_version: afterVer, from: bv, to: av });
    } else {
      changed.push({ rung: r.rung, from: bv, to: av });
    }
  }
  return { comparable: true, changed, redefined };
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
  // ONE PARALLEL GROUP, NOT THREE SEQUENTIAL ONES.
  //
  // Measured against the live store under load: individual counts run 140-911ms, and these
  // eleven were issued as three awaited groups, so their latencies added instead of
  // overlapping. The resolver then exceeded the caller's timeout even with every skip flag
  // set — a caller saw failure while the work succeeded and the snapshot was written, which is
  // this session's dominant defect inverted and just as misleading.
  //
  // They are all independent, so there is no ordering to preserve. One group bounds the whole
  // derivation by its SLOWEST query rather than the sum of them.
  const day = "time::now() - 1d";
  const [
    executionsRecent,
    executionsTotal,
    executionsGraded,
    armsSelectable,
    gradedPerDay,
    effectComposes,
    effectExamined,
    effectUncovered,
    examComposes,
    examExamined,
    examUnexamined,
  ] = await Promise.all([
      count("SELECT count() FROM execution WHERE executed_at > time::now() - 1h GROUP ALL;"),
      count("SELECT count() FROM execution GROUP ALL;"),
      count("SELECT count() FROM execution WHERE reached != NONE GROUP ALL;"),
      count("SELECT count() FROM activity WHERE retired = false OR retired IS NONE GROUP ALL;"),
      count(`SELECT count() FROM execution WHERE reached != NONE AND executed_at > ${day} GROUP ALL;`),
      count("SELECT count() FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
      count("SELECT math::sum(metadata.effect_targets_examined) AS count FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
      count("SELECT math::sum(metadata.effect_targets_uncovered) AS count FROM execution WHERE metadata.effect_targets_examined != NONE GROUP ALL;"),
      count("SELECT count() FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
      count("SELECT math::sum(metadata.examination_examined) AS count FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
      count("SELECT math::sum(metadata.examination_unexamined) AS count FROM execution WHERE metadata.examination_examined != NONE GROUP ALL;"),
    ]);
  const fams = pointer["skip_arm_split"] === true ? null : await familySizes();

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
    familySizes: fams,
  });

  const prevRow = pointer["skip_history"] === true ? null : await previousSnapshot();
  const prevRungs = (prevRow?.["pointer"] as { rungs?: Rung[] } | undefined)?.rungs ?? null;
  const delta = ladderDelta(rungs, prevRungs);

  const body = {
    rungs,
    ...summariseLadder(rungs),
    delta,
    previous_snapshot_at: (prevRow?.["created_at"] as string | undefined) ?? null,
    derived_at: new Date().toISOString(),
  };

  // Record AFTER computing the delta, so this derivation becomes the baseline for the next.
  const recorded = pointer["skip_history"] === true ? null : await persistSnapshot(body);
  return { shape: "operationalState", body: { ...body, snapshot_recorded: recorded } };
}
