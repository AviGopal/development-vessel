import type { ResolverResult } from "./types.js";

/**
 * reach_rate_scan — the substrate's first reader of its own REACH statistic.
 *
 * WHY THIS EXISTS. CLAUDE.md's execution contract says an arbitrary goal walk
 * should reach with high probability (~90%) "regardless of priors". Measured
 * 2026-09-01 the fleet was reaching somewhere between 1.5% and 16.8% depending on
 * the population — 5x to 60x below its own stated contract — and it had NEVER
 * filed a gap about it. Not because the machinery was broken: because NOTHING
 * READ AN AGGREGATE REACH STATISTIC. A grep for reach_rate/reachRate across
 * activity-api, development-vessel, goal-host-vessel and obsidian-vessel returned
 * one hit, inside a goal prompt string. substrate-health-tick measures posterior
 * confidence / graph stability / optimality; coverage-tick's "reach" is shape
 * reachability in the graph; performance-reach-gate reads HTTP latency. The
 * contract had no instrument. This is the instrument.
 *
 * WHAT IT DOES. Consumes activity-api's `groupedExecutionStats` (per-activity
 * count / success_rate / reached_count / graded_count / reach_rate over a window)
 * and emits one substrateGap per family that is graded often enough to judge and
 * reaching below the floor.
 *
 * REACH IS NOT SUCCESS. success is the template's exit status; reached is the
 * goal verdict (activity-api src/lib/reach-classify.ts). This resolver reads
 * `reach_rate` and never `success_rate` — several composed activities computed
 * success_count/count and called it reach_rate, which is exactly the confusion
 * the reach column exists to end.
 *
 * VOLUME AND RATE, NEVER NAME. Modelled on gate_saturation_scan, with its one
 * defect deliberately not copied: that detector filters candidate ids through
 * `check|gate|valid|verify|comprehensib|filter|guard`, so it could never match an
 * activity called `composed-cap-…` — which is why nothing fired on a template
 * family that re-minted itself 79 times. A name is not evidence. This filters on
 * graded volume and reach rate only.
 *
 * THE VOLUME GATE IS ON GRADED RUNS, NOT ON RUNS. `reached` is option<bool> and
 * grading is asynchronous, so a family with 500 executions and 2 verdicts carries
 * almost no information about reach. Gating on `count` would let a 2-sample
 * verdict file a gap against a 500-run family.
 */

export interface ReachRateScanPointer {
  type: "reach_rate_scan";
  /** Aggregation window handed to groupedExecutionStats. Default 24. */
  window_hours?: number;
  /** A family is flagged when reach_rate <= this. Default 0.5. See MIN_REACH_RATE note. */
  min_reach_rate?: number;
  /** Minimum GRADED runs before a family can be judged. Default 8. */
  min_graded_volume?: number;
  /** Families to consider per scan (passed through as the aggregate's limit). Default 50. */
  limit?: number;
  /**
   * Restrict to one family. In this mode the resolver is a single-family
   * MEASUREMENT rather than a scan: it projects reach_rate to the top level of the
   * body so the gap sweep's Class-2 falsifier can read it. This is the mode the
   * emitted gaps' `evidence_resolve` re-runs.
   */
  activity_id?: string;
  /** activity-api base url (in-container). Default http://127.0.0.1:8080. */
  activity_api_url?: string;
  /** dev-vessel impulses url for substrateGap_write. Default :8090/v2/impulses/resolve. */
  dev_vessel_impulses_url?: string;
  /** dry_run = true: measure + report, emit nothing. Always true on a falsifier re-run. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 10. */
  max_emits?: number;
  /** Test hook: use these rows instead of calling groupedExecutionStats. */
  _rows?: StatsRow[];
}

export interface StatsRow {
  activity_id?: unknown;
  count?: unknown;
  success_rate?: unknown;
  reached_count?: unknown;
  graded_count?: unknown;
  ungraded_count?: unknown;
  reach_rate?: unknown;
}

interface ReachFinding {
  activity_id: string;
  count: number;
  graded_count: number;
  ungraded_count: number;
  reached_count: number;
  reach_rate: number;
  success_rate: number;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
}

const DEFAULT_API = "http://127.0.0.1:8080";
const DEFAULT_EMIT = "http://127.0.0.1:8090/v2/impulses/resolve";
/**
 * The CONTRACT is ~0.90. The FLOOR is 0.5 on purpose: at a 0.90 trigger nearly
 * every family in the fleet files a gap on the first tick, and a detector whose
 * first act is to flood the gap store gets muted rather than acted on. 0.5 is
 * "reaching fewer than half the goals it was graded on" — unambiguous, and it is
 * a pointer field so the activity template can ratchet it toward the contract as
 * the fleet climbs. The distance from 0.5 to 0.90 is recorded in every gap's
 * classification_metadata (`contract_reach_rate`) so nothing mistakes the floor
 * for the target.
 */
const DEFAULT_MIN_REACH_RATE = 0.5;
const CONTRACT_REACH_RATE = 0.9;
const DEFAULT_MIN_GRADED_VOLUME = 8;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_EMITS = 10;

/**
 * The shape name this resolver ADVERTISES (dev-vessel config.ts discovery.shapes),
 * which is what an emitted gap's evidence_resolve must name.
 *
 * WHY NOT `groupedExecutionStats` — the aggregate it reads. The gap sweep
 * (verifyGapConditionAsync, gap-to-feature.ts) POSTs the predicate to
 * SELF_RESOLVE_ENDPOINT, which defaults to dev-vessel's OWN :8090. dev-vessel's
 * resolvePointer throws "Unknown pointer type" for anything not in its switch, so
 * a predicate naming activity-api's shape would 500 -> `!resp.ok` -> 'unknown',
 * forever. It would also fail on the read: activity-api's impulse route returns
 * `{success, content: "<json string>"}`, and the sweep reads `nonzero_field` FLAT
 * off the body. Naming a shape dev-vessel serves is what makes the falsifier
 * actually run; classifyFalsifier still stamps it class2 because it checks the
 * FLEET vocabulary, and this name is in dev-vessel's config.ts.
 */
export const REACH_RATE_SCAN_SHAPE = "reach_rate_scan";

function asNum(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Fetch per-activity stats from activity-api. Returns null (never throws) on any failure. */
async function fetchStats(
  apiBase: string,
  pointer: Record<string, unknown>,
): Promise<{ rows: StatsRow[]; top: Record<string, unknown> } | { error: string }> {
  const apiKey = process.env["METABOB_API_KEY"];
  try {
    const r = await fetch(`${apiBase.replace(/\/$/, "")}/v2/impulses/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
      },
      // THE ROUTE REQUIRES AN ENVELOPE. A flat {type,...} body is HTTP 400 — the
      // mismatch that silently disabled every Class-2 predicate in the fleet.
      body: JSON.stringify({ impulse: { pointer: { type: "groupedExecutionStats", ...pointer } } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { error: `groupedExecutionStats HTTP ${r.status}` };
    const env = (await r.json()) as { content?: unknown; success?: unknown };
    // activity-api returns the report JSON-encoded in `content`.
    const raw = typeof env.content === "string" ? env.content : JSON.stringify(env.content ?? {});
    const report = JSON.parse(raw) as Record<string, unknown>;
    const rows = Array.isArray(report["rows"]) ? (report["rows"] as StatsRow[]) : [];
    return { rows, top: report };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function resolveReachRateScan(
  pointer: ReachRateScanPointer,
): Promise<ResolverResult> {
  const windowHours = asNum(pointer.window_hours, 24);
  const minReachRate = asNum(pointer.min_reach_rate, DEFAULT_MIN_REACH_RATE);
  const minGraded = asNum(pointer.min_graded_volume, DEFAULT_MIN_GRADED_VOLUME);
  const limit = asNum(pointer.limit, DEFAULT_LIMIT);
  const maxEmits = asNum(pointer.max_emits, DEFAULT_MAX_EMITS);
  const apiBase = pointer.activity_api_url ?? process.env["ACTIVITY_API_URL"] ?? DEFAULT_API;
  const emitUrl = pointer.dev_vessel_impulses_url ?? DEFAULT_EMIT;
  const scopedTo = typeof pointer.activity_id === "string" && pointer.activity_id.trim()
    ? pointer.activity_id.trim()
    : null;
  // A single-family measurement never emits: it exists to be RE-RUN by the gap
  // sweep, and a verifier that mints gaps as a side effect of verifying is a loop.
  const dryRun = pointer.dry_run === true || scopedTo !== null;

  let rows: StatsRow[] = [];
  let fetchError: string | null = null;
  if (pointer._rows) {
    rows = pointer._rows;
  } else {
    const got = await fetchStats(apiBase, {
      window_hours: windowHours,
      limit,
      ...(scopedTo ? { activity_id: scopedTo } : {}),
    });
    if ("error" in got) fetchError = got.error;
    else rows = got.rows;
  }

  // ── Single-family measurement mode (the falsifier's read) ──────────────────
  if (scopedTo !== null) {
    const row = rows.find((r) => r.activity_id === scopedTo);
    const gradedCount = row ? asNum(row.graded_count) : 0;
    // reach_rate is NULL when nothing was graded — never 0. `nonzero_field` reads
    // zero/null/undefined as 'present' (defect stands), so an ungraded family
    // holds its gap open rather than closing it on absent evidence. That is the
    // conservative side: a false close is worse than a slow one.
    // ENFORCE THE VOLUME FLOOR ON THE RE-READ TOO. gradedCount > 0 is not enough: a
    // single graded run is not evidence the shortfall is gone, and treating it as such
    // closes the gap on n=1. Below the floor we return null, which reads as 'present'
    // and holds the gap open until there is enough evidence to decide either way.
    const enoughVolume = gradedCount >= minGraded;
    const reachRate = row && enoughVolume ? asNum(row.reach_rate) : null;
    // defect_field is checked BEFORE nonzero_field and is the precise predicate:
    // nonzero_field alone cannot tell 0.04 from 0.95 (both nonzero), so a badly
    // reaching family would close its own gap. This string is present ONLY while
    // the defect stands, and is omitted entirely once reach clears the floor.
    const stillBelow = reachRate !== null && reachRate <= minReachRate;
    const body: Record<string, unknown> = {
      activity_id: scopedTo,
      window_hours: windowHours,
      min_reach_rate: minReachRate,
      contract_reach_rate: CONTRACT_REACH_RATE,
      count: row ? asNum(row.count) : 0,
      reached_count: row ? asNum(row.reached_count) : 0,
      graded_count: gradedCount,
      ungraded_count: row ? asNum(row.ungraded_count) : 0,
      success_rate: row ? asNum(row.success_rate) : 0,
      reach_rate: reachRate,
      measured: row !== undefined && fetchError === null,
      generated_at: new Date().toISOString(),
    };
    if (fetchError) body["fetch_error"] = fetchError;
    if (stillBelow) {
      body["reach_below_floor"] =
        `reach_rate=${reachRate!.toFixed(3)} over ${gradedCount} graded runs (floor ${minReachRate}, contract ${CONTRACT_REACH_RATE})`;
    }
    return { shape: "reachRateReport", body };
  }

  // ── Scan mode ──────────────────────────────────────────────────────────────
  const findings: ReachFinding[] = [];
  let evaluated = 0;
  let skipped_ungraded = 0;
  for (const r of rows) {
    const activityId = typeof r.activity_id === "string" ? r.activity_id : "";
    if (!activityId) continue;
    const gradedCount = asNum(r.graded_count);
    // reach_rate null means "no verdict", not "never reached". Skipping is the
    // whole reason the aggregate reports null instead of 0.
    if (typeof r.reach_rate !== "number" || gradedCount <= 0) {
      skipped_ungraded += 1;
      continue;
    }
    if (gradedCount < minGraded) {
      skipped_ungraded += 1;
      continue;
    }
    evaluated += 1;
    if (r.reach_rate > minReachRate) continue;
    findings.push({
      activity_id: activityId,
      count: asNum(r.count),
      graded_count: gradedCount,
      ungraded_count: asNum(r.ungraded_count),
      reached_count: asNum(r.reached_count),
      reach_rate: r.reach_rate,
      success_rate: asNum(r.success_rate),
      gap_id: `reach-rate-${activityId}`.replace(/[^a-zA-Z0-9._-]/g, "_"),
      posted: false,
    });
    if (findings.length >= maxEmits) break;
  }

  if (!dryRun) {
    for (const f of findings) {
      const gapBody = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "execution_contract_shortfall",
              source: "substrate_detected",
              summary:
                `Activity family '${f.activity_id}' reaches its goal ` +
                `${(f.reach_rate * 100).toFixed(1)}% of the time (${f.reached_count}/${f.graded_count} ` +
                `GRADED runs over ${windowHours}h; ${f.ungraded_count} of its ${f.count} runs are ungraded). ` +
                `The execution contract expects ~${(CONTRACT_REACH_RATE * 100).toFixed(0)}% regardless of priors; ` +
                `the detector floor is ${(minReachRate * 100).toFixed(0)}%. ` +
                `NOTE the exit status disagrees: success_rate=${(f.success_rate * 100).toFixed(1)}% — ` +
                `this family exits cleanly and does not reach, which is precisely what the ` +
                `\`reached\` verdict exists to expose.`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "reach_rate_shortfall",
                activity_id: f.activity_id,
                reach_rate: f.reach_rate,
                success_rate: f.success_rate,
                reached_count: f.reached_count,
                graded_count: f.graded_count,
                ungraded_count: f.ungraded_count,
                execution_count: f.count,
                min_reach_rate: minReachRate,
                contract_reach_rate: CONTRACT_REACH_RATE,
                window_hours: windowHours,
                // THE FALSIFIER. Re-runs the exact single-family measurement that
                // produced this gap, against dev-vessel's own resolve endpoint (the
                // only one the sweep POSTs to). `reach_below_floor` is present only
                // while the defect stands (defect_field, evaluated first);
                // `reach_rate` is nonzero when healthy and null when ungraded, so an
                // ungraded family abstains rather than false-closing.
                evidence_resolve: {
                  shape: REACH_RATE_SCAN_SHAPE,
                  input: {
                    activity_id: f.activity_id,
                    window_hours: windowHours,
                    min_reach_rate: minReachRate,
                    // CARRY THE VOLUME FLOOR INTO THE RE-READ (2026-09-02, review finding).
                    // Without it the scoped branch applied no volume gate, so a gap filed
                    // on 0/255 closed the moment ONE later window contained a single graded
                    // run that reached: 1/1 = 1.0 -> no reach_below_floor -> reach_rate 1.0
                    // -> heuristic 2 returns 'absent' -> closed. That is the exact polarity
                    // failure this resolver's own comments claim to avoid, and a false close
                    // is the one outcome the close-oracle cannot afford (landed_commit sits
                    // at 0 closes / 772 false for precisely this class).
                    min_graded_volume: minGraded,
                    dry_run: true,
                  },
                  defect_field: "reach_below_floor",
                  nonzero_field: "reach_rate",
                },
                remediation_hint:
                  "Read the walk's reasoning for this family before touching the template: a reach " +
                  "shortfall is usually information starvation at a decision point (the load-bearing " +
                  "fact was not an impulse at the moment of use), not a missing capability. Compare " +
                  "success_rate to reach_rate — a large gap means the family exits cleanly while " +
                  "producing nothing the goal asked for (hollow completion).",
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env["METABOB_API_KEY"]
              ? { Authorization: `ApiKey ${process.env["METABOB_API_KEY"]}` }
              : {}),
          },
          body: JSON.stringify(gapBody),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  // Fleet roll-up over the graded slice only, so the report answers the question
  // that had no reader: "is the substrate reaching its goals?"
  let fleetReached = 0;
  let fleetGraded = 0;
  for (const r of rows) {
    fleetReached += asNum(r.reached_count);
    fleetGraded += asNum(r.graded_count);
  }

  return {
    shape: "reachRateReport",
    body: {
      families_evaluated: evaluated,
      families_skipped_insufficient_grading: skipped_ungraded,
      finding_count: findings.length,
      findings,
      fleet_reached_count: fleetReached,
      fleet_graded_count: fleetGraded,
      fleet_reach_rate: fleetGraded > 0 ? fleetReached / fleetGraded : null,
      contract_reach_rate: CONTRACT_REACH_RATE,
      min_reach_rate: minReachRate,
      min_graded_volume: minGraded,
      window_hours: windowHours,
      dry_run: dryRun,
      ...(fetchError ? { fetch_error: fetchError } : {}),
      completed_at: new Date().toISOString(),
    },
  };
}
