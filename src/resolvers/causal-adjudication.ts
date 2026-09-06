/**
 * causal-adjudication — turn an after-only reading into a before/after verdict.
 *
 * THE DEFECT THIS EXISTS FOR. A Class-2 falsifier names a shape the sweep can re-resolve and a
 * field to read. That answers "is the defect present NOW?" and nothing else. With no value
 * recorded when the gap was written, two very different worlds are indistinguishable:
 *
 *     was present, now absent   — the action changed something. The fix worked.
 *     never present at all      — the predicate was inert from the start. Closing on this is a
 *                                 FALSE CLOSE, and it looks exactly like success.
 *
 * substrate-gap.ts already records the danger in its own words: a derived literal "read
 * 'present' by construction and manufactured re-lands". The remedy it applied was to stop
 * deriving predicates. The remaining half is to stop reading them without a baseline.
 *
 * WHY THIS IS THE CAUSAL PIECE AND THE SNAPSHOT LEDGER IS NOT. A history of snapshots makes
 * CORRELATION visible: rung 3 broke at 23:43, and some composes landed near then. Correlation
 * over traces is partly effect-as-cause, because the system mints structure from its own
 * successes. What distinguishes the two is a counterfactual fixed BEFORE the action — a value
 * that could have come out either way, recorded when nobody yet knew which. That is what a
 * baseline is, and it is why the baseline must be stamped at write time rather than
 * reconstructed afterwards from whatever the store happens to hold.
 *
 * HORIZONS ARE PLURAL ON PURPOSE. An effect that appears within a minute and one that appears
 * after a day are different claims about mechanism, and a single deadline collapses them. An
 * unelapsed horizon is PENDING, never "refuted" — refusing to conclude early is the whole
 * value of having declared the horizon in advance.
 */

/** What the predicate read at a point in time. `null` means it could not be measured. */
export type Observation = { present: boolean } | null;

export type Verdict =
  | "confirmed" // present before, absent after — the action is associated with the change
  | "refuted" // present before, still present after — the action did not clear it
  | "never_present" // absent before AND after — the predicate was inert; closing here is a false close
  | "regressed" // absent before, present after — the action introduced the condition
  | "pending" // the horizon has not elapsed; concluding now would be guessing
  | "inconclusive"; // a reading is missing; absence of measurement is not a verdict

export interface Adjudication {
  verdict: Verdict;
  horizon: string;
  /** Plain statement of what was compared, so a verdict never has to be taken on trust. */
  detail: string;
  /** True only for "confirmed" — the single case that is evidence the action did something. */
  supports_causal_claim: boolean;
}

/**
 * PURE. Compare a baseline taken before the action against a reading taken after it.
 *
 * `horizonElapsed` is passed in rather than computed from a clock so the decision is testable
 * and so this file holds no hidden dependency on wall time.
 */
export function adjudicate(
  baseline: Observation,
  current: Observation,
  horizon: string,
  horizonElapsed: boolean,
): Adjudication {
  const mk = (verdict: Verdict, detail: string): Adjudication => ({
    verdict,
    horizon,
    detail,
    supports_causal_claim: verdict === "confirmed",
  });

  // Order matters. An unmeasurable reading outranks an unelapsed horizon: if we cannot see the
  // value at all, waiting longer changes nothing about THIS observation, and reporting
  // "pending" would promise a verdict that no amount of time can produce.
  if (baseline === null) {
    return mk(
      "inconclusive",
      "no baseline was recorded before the action — the after-reading alone cannot distinguish a fix from a condition that was never present",
    );
  }
  if (current === null) {
    return mk("inconclusive", "the predicate could not be measured now; absence of measurement is not a verdict");
  }
  if (!horizonElapsed) {
    return mk(
      "pending",
      `both readings exist but the ${horizon} horizon has not elapsed — concluding now would discard the reason for declaring a horizon`,
    );
  }
  if (baseline.present && !current.present) {
    return mk("confirmed", `present before the action, absent after it, at ${horizon}`);
  }
  if (baseline.present && current.present) {
    return mk("refuted", `present before AND after at ${horizon} — the action did not clear the condition`);
  }
  if (!baseline.present && !current.present) {
    return mk(
      "never_present",
      `absent before AND after at ${horizon} — the predicate was inert, and closing on it would be a false close that looks identical to success`,
    );
  }
  return mk("regressed", `absent before the action, present after it, at ${horizon} — the action introduced the condition`);
}

/**
 * Adjudicate one prediction across every horizon it declared.
 *
 * A claim confirmed at one hour and refuted at a day is not a contradiction — it is a
 * statement about how long the effect lasted, and collapsing it to a single verdict throws
 * that away. The summary therefore reports the horizons separately AND the earliest horizon at
 * which the claim was confirmed, which is the one that bounds the mechanism.
 */
export function adjudicateAll(
  baseline: Observation,
  readings: Array<{ horizon: string; elapsed: boolean; observation: Observation }>,
): {
  per_horizon: Adjudication[];
  confirmed_at: string | null;
  any_regression: boolean;
  all_pending: boolean;
} {
  const per_horizon = readings.map((r) => adjudicate(baseline, r.observation, r.horizon, r.elapsed));
  const firstConfirmed = per_horizon.find((a) => a.verdict === "confirmed");
  return {
    per_horizon,
    confirmed_at: firstConfirmed ? firstConfirmed.horizon : null,
    any_regression: per_horizon.some((a) => a.verdict === "regressed"),
    all_pending: per_horizon.length > 0 && per_horizon.every((a) => a.verdict === "pending"),
  };
}


// ─────────────────────── STAMPING THE COUNTERFACTUAL AT DECISION TIME ───────────────────────

const SURREALDB_URL = process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000";
const SURREALDB_USERNAME = process.env["SURREALDB_USERNAME"] ?? "root";
const SURREALDB_PASSWORD =
  process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "root";
const SURREALDB_NS = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
const SURREALDB_DB = process.env["SURREALDB_DATABASE"] ?? "learning_loop";

async function surreal(body: string): Promise<Array<{ status?: string; result?: unknown }> | null> {
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
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Array<{ status?: string; result?: unknown }>;
  } catch {
    return null;
  }
}

/**
 * Measure a Class-1 predicate: is the literal still present at its edit site?
 *
 * Returns null when the file cannot be read, because "I could not look" must not collapse into
 * "the literal is gone" — that collapse is precisely how a false close is manufactured.
 */
export async function measureClass1(
  repoRoot: string,
  editSite: string,
  literal: string,
): Promise<Observation> {
  if (!editSite || !literal) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const path = editSite.startsWith("/") ? editSite : `${repoRoot}/${editSite}`;
    const text = await readFile(path, "utf8");
    return { present: text.includes(literal) };
  } catch {
    return null;
  }
}

/**
 * Record the predicate's value BEFORE the action, keyed by gap id.
 *
 * Written as its own impulse rather than back onto the gap. substrateGap_write REPLACES rather
 * than merges, so a partial write would erase fields on a live gap — a hazard already paid for
 * five times in this store. A separate row cannot clobber anything, and the adjudicator only
 * ever needs to read it.
 *
 * Idempotent by gap id AND action id: re-picking the same gap for the same action must not
 * overwrite the original baseline, because the FIRST reading is the counterfactual. A later
 * one, taken after work has begun, is contaminated by the very action it is meant to judge.
 */
export async function stampBaseline(
  gapId: string,
  actionId: string,
  observation: Observation,
  predicateKind: "class1" | "class2",
): Promise<"stamped" | "already_stamped" | "failed"> {
  if (!gapId || !actionId) return "failed";
  const existing = await surreal(
    `SELECT id FROM impulse WHERE shape = 'falsifierBaseline' ` +
      `AND pointer.gap_id = '${gapId.replace(/'/g, "")}' ` +
      `AND pointer.action_id = '${actionId.replace(/'/g, "")}' LIMIT 1;`,
  );
  const rows = existing?.[0]?.result;
  if (Array.isArray(rows) && rows.length > 0) return "already_stamped";
  const pointer = {
    gap_id: gapId,
    action_id: actionId,
    predicate_kind: predicateKind,
    // null is recorded deliberately: an unmeasurable baseline is itself the finding, and it
    // makes the later verdict inconclusive rather than silently absent.
    baseline_present: observation === null ? null : observation.present,
    measurable: observation !== null,
    stamped_at: new Date().toISOString(),
  };
  const res = await surreal(
    `INSERT INTO impulse { id: 'fbase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', ` +
      `shape: 'falsifierBaseline', org_id: 'organizations:substrate', pointer: ${JSON.stringify(pointer)}, created_at: time::now(), budget: 0 };`,
  );
  return res ? "stamped" : "failed";
}

/** Read back the baseline for a gap+action, or null when none was ever taken. */
export async function readBaseline(gapId: string, actionId: string): Promise<Observation> {
  const r = await surreal(
    `SELECT pointer FROM impulse WHERE shape = 'falsifierBaseline' ` +
      `AND pointer.gap_id = '${gapId.replace(/'/g, "")}' ` +
      `AND pointer.action_id = '${actionId.replace(/'/g, "")}' ORDER BY created_at ASC LIMIT 1;`,
  );
  const rows = r?.[0]?.result;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const p = (rows[0] as Record<string, unknown>)["pointer"] as Record<string, unknown> | undefined;
  if (!p || p["measurable"] !== true) return null;
  return { present: p["baseline_present"] === true };
}


// ───────────────────── THE ENVIRONMENT BASELINE: EVERY PICK IS AN EXPERIMENT ─────────────────────

/**
 * Stamp a before-reading of the ENVIRONMENT at decision time, for every pick.
 *
 * The predicate baseline above only fires for gaps that already carry a falsifier — 26 of
 * 2,376 gaps, about 1%. A mechanism that triggers once in a hundred picks cannot support a
 * claim about the system's behaviour; it waits on a coincidence and calls the wait evidence.
 *
 * The environment is measurable for EVERY pick, so every pick becomes an experiment. The
 * before-reading is the most recent operationalStateSnapshot: the ladder already derives and
 * persists itself, so referencing it costs one SELECT rather than re-deriving seven rungs. The
 * after-reading is whatever snapshot exists once the action has had time to land.
 *
 * Referenced by ID rather than copied. A copy would freeze a duplicate of the ladder at pick
 * time and start drifting from the series it was taken from; an id keeps one authority for
 * what the system's condition was at that instant.
 *
 * Records `baseline_snapshot_id: null` when no snapshot exists yet. That is honest and it is
 * also the state the ledger was in for its first hour, when every write was being rejected for
 * a missing org_id and reporting nothing — an absent baseline must read as absent, never as
 * "the environment was fine".
 */
export async function stampEnvironmentBaseline(
  gapId: string,
  actionId: string,
): Promise<"stamped" | "already_stamped" | "failed"> {
  if (!gapId || !actionId) return "failed";
  // NOTE FOR ANY PREDICATE WRITTEN AGAINST THIS SHAPE: in SurrealDB, NONE and NULL are
  // DISTINCT, so `field != NONE` is TRUE for a field explicitly set to null. A watcher counting
  // "linked" baselines with `pointer.baseline_snapshot_id != NONE` reported every null-
  // referencing row as linked and declared the chain closed while zero snapshots existed. Use
  // `type::is::string(...)` when the question is "does this hold a real id".
  const dup = await surreal(
    `SELECT id FROM impulse WHERE shape = 'environmentBaseline' ` +
      `AND pointer.action_id = '${actionId.replace(/'/g, "")}' LIMIT 1;`,
  );
  const dupRows = dup?.[0]?.result;
  if (Array.isArray(dupRows) && dupRows.length > 0) return "already_stamped";

  let snap = await surreal(
    "SELECT id, created_at FROM impulse WHERE shape = 'operationalStateSnapshot' " +
      "ORDER BY created_at DESC LIMIT 1;",
  );

  // SEED THE SERIES IF IT DOES NOT EXIST YET.
  //
  // The baseline references the newest snapshot, and operational_state only persists when
  // something invokes it. Nothing does on a cadence, so the series stayed empty and every
  // baseline pointed at null — honest, and useless. A reference to a series that is never
  // written can never become a before/after.
  //
  // Derived CHEAPLY on purpose: skip_gate_probe, skip_drift_scan and skip_arm_split are all
  // set, so this costs a handful of counts rather than re-running the gate corpus and a
  // per-arm group-by over 36k executions on the selection path. The rungs those flags cover
  // report UNMEASURED, which is the correct reading — a cheap snapshot must not claim to have
  // measured what it declined to look at.
  //
  // Seeding only when the series is EMPTY, not on every pick: picks run every few minutes and
  // a snapshot per pick would bury the signal in its own noise. The scheduled derivation, once
  // one exists, is what should keep the series current.
  // THE SEED CHECK IS NOT ATOMIC, SO BOUND WHAT LOSING THE RACE COSTS.
  //
  // Observed: two picks 1.2s apart both found an empty series and both seeded, producing two
  // near-identical snapshots. Harmless individually, but a burst of picks would fill the
  // series with readings taken moments apart, and a delta between two such snapshots measures
  // nothing while looking exactly like a measurement — the same shape as counting expiry as a
  // landing.
  //
  // Not fixed with a lock: a lock on the selection path can wedge selection, and this repo has
  // already paid for a gate that "WEDGED autonomous landings within the hour". A re-check
  // after the derivation is cheap, cannot block anything, and turns a duplicate into a no-op
  // reference to whichever snapshot won.
  // SEED WHEN THE SERIES IS EMPTY **OR STALE**.
  //
  // Seeding only-when-empty made the series a single origin point: after the first snapshot it
  // never grew, so every later baseline referenced an increasingly old reading and a delta
  // measured hours of drift rather than the action. An organ that silently stops updating is
  // worse than one that was never built, because its output keeps looking current.
  //
  // The staleness bound is the compromise between that and seeding per pick, which would fill
  // the series with readings taken moments apart — a delta between two of those measures
  // nothing while looking exactly like a measurement.
  const staleMs = Number(process.env["OPSTATE_SNAPSHOT_MAX_AGE_MS"] ?? 30 * 60 * 1000);
  const snapRowsPre = snap?.[0]?.result;
  const newestAt =
    Array.isArray(snapRowsPre) && snapRowsPre.length > 0
      ? Date.parse(String((snapRowsPre[0] as Record<string, unknown>)["created_at"] ?? ""))
      : NaN;
  // NaN (unparseable timestamp) counts as stale, not as fresh: an unreadable age must not be
  // taken as proof the snapshot is current.
  const isStale = !Number.isFinite(newestAt) || Date.now() - newestAt > staleMs;
  if (!Array.isArray(snapRowsPre) || snapRowsPre.length === 0 || isStale) {
    try {
      // Re-check first: another pick may have seeded while this one was deciding to.
      const recheck = await surreal(
        "SELECT id, created_at FROM impulse WHERE shape = 'operationalStateSnapshot' " +
          "ORDER BY created_at DESC LIMIT 1;",
      );
      const recheckRows = recheck?.[0]?.result;
      const recheckAt =
        Array.isArray(recheckRows) && recheckRows.length > 0
          ? Date.parse(String((recheckRows[0] as Record<string, unknown>)["created_at"] ?? ""))
          : NaN;
      // Only accept the re-check if another pick produced a FRESH snapshot. Accepting a stale
      // one would let the race silently cancel the refresh it was meant to deduplicate.
      if (Number.isFinite(recheckAt) && Date.now() - recheckAt <= staleMs) {
        snap = recheck;
      } else {
        const { resolveOperationalState } = await import("./operational-state.js");
        await resolveOperationalState({ skip_gate_probe: true, skip_drift_scan: true, skip_arm_split: true });
        snap = await surreal(
          "SELECT id, created_at FROM impulse WHERE shape = 'operationalStateSnapshot' " +
            "ORDER BY created_at DESC LIMIT 1;",
        );
      }
    } catch {
      /* leave snap as-is; a null baseline_snapshot_id is honest and the adjudicator handles it */
    }
  }
  const snapRows = snap?.[0]?.result;
  const latest =
    Array.isArray(snapRows) && snapRows.length > 0
      ? (snapRows[0] as Record<string, unknown>)
      : null;

  const pointer = {
    gap_id: gapId,
    action_id: actionId,
    baseline_snapshot_id: latest ? String(latest["id"]) : null,
    baseline_snapshot_at: latest ? String(latest["created_at"]) : null,
    stamped_at: new Date().toISOString(),
  };
  const res = await surreal(
    `INSERT INTO impulse { id: 'ebase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}', ` +
      `shape: 'environmentBaseline', org_id: 'organizations:substrate', ` +
      `pointer: ${JSON.stringify(pointer)}, created_at: time::now(), budget: 0 };`,
  );
  return res ? "stamped" : "failed";
}
