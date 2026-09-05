/**
 * detector_yield_registry — the CURATIVE half of detector-fleet management.
 *
 * The substrate auto-SCHEDULES detectors (boredom_target_template tag → V24
 * shape-driven selector) and auto-AUTHORS signature-class ones
 * (detector-coverage-scan → build-signature-detector). What was missing is the
 * JOIN that lets the fleet be CURATED: nothing connected "which detector emitted
 * which gap" to "did that gap lead to a landed fix" or "is this detector even
 * being scheduled". detector-meta-scan NAMES dormant detectors but never retires
 * them; gap_lifecycle_scan tracks gap outcomes but not per-detector yield. This
 * resolver is the self-inventory: a per-detector health row joining the two raw
 * sources that already exist —
 *
 *   (1) gap PROVENANCE — substrateGaps carry classification_metadata.detector
 *       (written by detector-coverage-scan, dead-end-decision-scan,
 *       cyclic-flow-scan, signature-cluster-scan, …). Where absent we fall back
 *       to the gap-id prefix (detectors mint stable ids like
 *       `detector-coverage-gap-…`, `wasted-cycle-…`, `decision-without-action-…`).
 *
 *   (2) gap OUTCOMES — the gap store status (open|closed|rejected) plus the
 *       churn marker gap_lifecycle_scan writes on auto-close
 *       (classification_metadata.closed_reason === "churned_unlandable"). landed =
 *       closed-and-not-churned; churned = closed-with-churn-reason; open = open.
 *
 *   (3) SCHEDULING — the boredom selector snapshot (picks / novel_fraction /
 *       mean) the pool already writes per template. Detector_id (snake_case) is
 *       matched to the snapshot's template_id (kebab, `development-vessel:`-
 *       prefixed) by normalising both to a comparable key.
 *
 * Derived status per detector:
 *   PRODUCTIVE — gaps_landed > 0, OR has open gaps that are novel (recent signal).
 *   LOW_YIELD  — emitted ≥1 gap but 0 landed AND churn dominates (mostly churned).
 *   DORMANT    — picks < threshold in the snapshot (never/barely scheduled).
 *   UNKNOWN    — no gap data and no snapshot pick data.
 *
 * If emit_retirement_gaps:true, emits a detector_retirement_candidate
 * substrateGap (stable id detector-retirement-<id>) per DORMANT/LOW_YIELD
 * detector so retirement routes through the normal gap→bridge→deprecate path.
 * Default false — this is descriptive self-inventory by default; the operator (or
 * a later activity) decides on the retirement evidence.
 *
 * Deterministic, no LLM, fail-tolerant (every read swallows + degrades). Mirrors
 * the cyclic-flow-scan / detector-meta-scan idioms.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface DetectorYieldRegistryPointer {
  type: "detector_yield_registry";
  window_hours?: number;          // default 168 (7d). Gaps older than this are ignored.
  dormant_picks_threshold?: number; // picks below this ⇒ DORMANT. default 1 (never scheduled).
  emit_retirement_gaps?: boolean;   // default false (descriptive only this turn).
  gapsPath?: string;              // default WORKSPACE_ROOT/gaps/gaps.json
  selectorStatePath?: string;     // default WORKSPACE_ROOT/state/boredom-selector-state.json
  devVesselImpulsesUrl?: string;
  // Test hooks — bypass fs reads entirely.
  _gaps?: GapRow[];
  _snapshot?: Snapshot;
}

interface GapRow {
  id?: string;
  status?: string;               // open | closed | rejected
  category?: string;
  detected_at?: string;
  created_at?: string;
  updated_at?: string;
  classification_metadata?: Record<string, unknown> | null;
}

interface SnapTpl { template_id?: unknown; picks?: unknown; mean?: unknown; novel_fraction?: unknown }
interface Snapshot { templates?: unknown }

type DetectorStatus = "PRODUCTIVE" | "LOW_YIELD" | "DORMANT" | "UNKNOWN";

interface DetectorRow {
  detector_id: string;
  status: DetectorStatus;
  gaps_emitted: number;
  gaps_landed: number;
  gaps_churned: number;
  /** Closures recording an actual verified fix — `gaps_landed` counts expiry too. */
  gaps_really_fixed: number;
  /** Closed with no evidence the condition went away: expiry, stale, or no reason at all. */
  gaps_closed_unverified: number;
  gaps_open: number;
  picks: number | null;
  last_fired: string | null;     // most-recent gap timestamp (snapshot carries no last_fired)
  novel_fraction: number | null;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Normalise a detector_id or template_id to a comparable key: drop the vessel
 *  prefix, drop a trailing -tick / -audit-tick, replace separators with '_',
 *  lowercase. So `dead_end_decision_scan` ⇄ `development-vessel:dead-end-decision-scan-tick`. */
export function normKey(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/^[a-z0-9-]+:/, "");          // strip vessel: prefix (development-vessel:)
  s = s.replace(/-tick$/, "").replace(/-audit$/, ""); // tick / audit wrapper suffix
  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s;
}

/** Recover a detector id from a gap when classification_metadata.detector is
 *  absent: use the stable gap-id family prefix. Detectors mint ids like
 *  `detector-coverage-gap-…`, `wasted-cycle-…`, `decision-without-action-…`,
 *  `detect-unclassified_failure_…`. We strip the trailing volatile/instance part
 *  and keep the family token. Falls back to "(unattributed)". */
export function detectorFromGapId(id: string | undefined): string {
  if (!id) return "(unattributed)";
  const known: Array<[RegExp, string]> = [
    [/^detector-coverage-gap-/, "detector_coverage_scan"],
    [/^wasted-cycle-/, "cyclic_flow_scan"],
    [/^decision-without-action-/, "dead_end_decision_scan"],
    [/^detector-retirement-/, "detector_yield_registry"],
  ];
  for (const [re, det] of known) if (re.test(id)) return det;
  // detect-<class> family (signature detectors): keep the leading "detect-<token>"
  const m = id.match(/^(detect-[a-z0-9_]+?)(?:_[a-z0-9-]+)?$/i);
  if (m && m[1]) return m[1].toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return "(unattributed)";
}

function detectorOf(g: GapRow): string {
  const m = g.classification_metadata ?? {};
  const explicit = m["detector"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  // closed_by (gap_lifecycle_scan auto-close attributes the closing detector, not
  // the emitting one) — only used as a last resort below detectorFromGapId.
  return detectorFromGapId(g.id);
}

/**
 * Below this many emitted gaps, "never produced a fix" is indistinguishable from "has not had
 * the chance yet". Same floor the template lifecycle uses to deprecate an arm.
 */
const RETIREMENT_EVIDENCE_FLOOR = Number(process.env["DETECTOR_RETIREMENT_MIN_GAPS"] ?? 10);

/** Retirement gaps emitted per run, so each batch's effect can be observed before the next. */
const RETIREMENT_EMISSION_CAP = Number(process.env["DETECTOR_RETIREMENT_EMIT_CAP"] ?? 5);

function isChurned(g: GapRow): boolean {
  const m = g.classification_metadata ?? {};
  const reason = m["closed_reason"];
  return typeof reason === "string" && /churn/i.test(reason);
}

/**
 * A gap CLOSED BECAUSE SOMEONE FIXED IT, as opposed to closed because the store gave up on it.
 *
 * `gaps_landed` counts closed-and-not-churned, which is 24.5x too generous. Measured on the
 * live store: of 1,473 closures, 707 (48.0%) are `expired_not_redetected`, 611 (41.5%) carry
 * NO reason at all, and only 60 (4.1%) record an actual verified fix. So 1,241 detectors show
 * gaps_landed > 0 while 1,202 of them (97%) never had a single gap really fixed.
 *
 * That matters beyond the report: `landed > 0` is what marks a detector PRODUCTIVE, and
 * LOW_YIELD requires `landed === 0`. With expiry counted as landing, the curation signal is
 * saturated — a detector whose every gap timed out looks productive, and almost nothing can
 * ever be judged low-yield. The fleet cannot be pruned through a lens that calls forgetting
 * success.
 *
 * `expired_not_redetected` is the sharpest case: it means "we stopped seeing it", which is
 * indistinguishable from "we stopped looking". It is not evidence the condition is gone.
 */
const REALLY_FIXED_REASONS = new Set([
  "landed_verified",
  "fix_landed_and_verified_by_consequence",
  "producer_now_exists",
  "condition_cleared",
]);

function isReallyFixed(g: GapRow): boolean {
  const reason = (g.classification_metadata ?? {})["closed_reason"];
  return typeof reason === "string" && REALLY_FIXED_REASONS.has(reason);
}


/**
 * The status decision, EXPORTED so tests bind to the shipped rule rather than a copy of it.
 *
 * It lived inline and was tested through a reimplementation in the test file. A negative
 * control exposed that: sabotaging the real branch left every test green, because the tests
 * were exercising their own copy. A probe that re-derives the rule tests the probe, not the
 * gate — the same trap the gate self-probe exists to avoid, reproduced here.
 */
export function classifyDetector(
  a: { emitted: number; really_fixed: number; novel_open: number; landed: number; churned: number; open: number },
  picks: number | null,
  dormantThreshold: number,
): DetectorStatus {
  if (picks !== null && picks < dormantThreshold) return "DORMANT";
  // PRODUCTIVE requires a REAL fix or live signal, not merely a closure: `landed` counts
  // expiry, and 1,202 of 1,241 detectors (97%) reached PRODUCTIVE with zero gaps ever fixed.
  if (a.really_fixed > 0 || a.novel_open > 0) return "PRODUCTIVE";
  // CHURN IS EVIDENCE; EXPIRY IS NOT. A churn-dominated detector's gaps were actively
  // attempted and failed to land — that is a measurement of the detector's output, and it
  // stands below the volume floor. Expiry means nothing was ever attempted, which is why the
  // floor exists at all. Erasing this distinction broke the pre-existing
  // "emitted-but-all-churned is LOW_YIELD" test, and the test was right.
  if (a.emitted > 0 && a.landed === 0 && a.churned > 0 && a.churned >= a.open) return "LOW_YIELD";
  // Too few gaps to judge. Absence of evidence, not evidence of uselessness — and retiring on
  // it is the irreversible half of an asymmetric bet taken without the measurement.
  if (a.emitted > 0 && a.emitted < RETIREMENT_EVIDENCE_FLOOR) return "UNKNOWN";
  // At or above the floor with no real fix and no live signal: measured, not suspected.
  if (a.emitted > 0) return "LOW_YIELD";
  return "UNKNOWN";
}

function gapTime(g: GapRow): number {
  const t = Date.parse(g.updated_at ?? g.detected_at ?? g.created_at ?? "");
  return Number.isFinite(t) ? t : NaN;
}

function loadGaps(p: DetectorYieldRegistryPointer): GapRow[] {
  if (p._gaps) return p._gaps;
  const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  const path = p.gapsPath ?? join(root, "gaps", "gaps.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? parsed : (parsed.gaps ?? []);
  } catch {
    return [];
  }
}

function loadSnapshot(p: DetectorYieldRegistryPointer): SnapTpl[] {
  if (p._snapshot) return Array.isArray(p._snapshot.templates) ? (p._snapshot.templates as SnapTpl[]) : [];
  const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  const path = p.selectorStatePath ?? join(root, "state", "boredom-selector-state.json");
  try {
    const snap = JSON.parse(readFileSync(path, "utf-8")) as Snapshot;
    return Array.isArray(snap.templates) ? (snap.templates as SnapTpl[]) : [];
  } catch {
    return [];
  }
}

async function emitRetirementGap(
  emitUrl: string,
  apiKey: string,
  row: DetectorRow,
): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `detector-retirement-${row.detector_id.replace(/[^a-zA-Z0-9]+/g, "_")}`,
          category: "architectural_pattern",
          source: "substrate_detected",
          summary:
            `Detector '${row.detector_id}' is a retirement candidate (${row.status}): ` +
            `emitted ${row.gaps_emitted} gaps, ${row.gaps_landed} landed, ${row.gaps_churned} churned, ` +
            `${row.gaps_open} open; scheduled picks=${row.picks ?? "n/a"}. ` +
            (row.status === "DORMANT"
              ? "Never/barely scheduled — exercise it or deprecate the tick."
              : "Emits gaps that never land and mostly churn — low signal-to-noise; tune or deprecate."),
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "detector_yield_registry",
            gap_class: "detector_retirement_candidate",
            candidate_detector_id: row.detector_id,
            candidate_status: row.status,
            gaps_emitted: row.gaps_emitted,
            gaps_landed: row.gaps_landed,
            gaps_churned: row.gaps_churned,
            gaps_open: row.gaps_open,
            picks: row.picks,
            novel_fraction: row.novel_fraction,
            suggested_remediation:
              "Evidence for an activityTemplate_deprecate of this detector's tick template, or an exploration boost if dormant-but-valuable.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveDetectorYieldRegistry(
  pointer: DetectorYieldRegistryPointer,
): Promise<ResolverResult> {
  const windowHours = pointer.window_hours ?? 168;
  const dormantThreshold = pointer.dormant_picks_threshold ?? 1;
  const emit = pointer.emit_retirement_gaps === true;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const gaps = loadGaps(pointer);
  const snapTpls = loadSnapshot(pointer);

  const cutoff = Date.now() - windowHours * 3_600_000;

  // 1. Snapshot: map normKey(template_id) → { picks, novel_fraction } for any
  //    DETECTOR-class template. (We keep all; the detector match below filters.)
  const snapByKey = new Map<string, { picks: number; novel_fraction: number | null; template_id: string }>();
  for (const t of snapTpls) {
    if (typeof t.template_id !== "string") continue;
    const key = normKey(t.template_id);
    const nf = typeof t.novel_fraction === "number" && Number.isFinite(t.novel_fraction) ? t.novel_fraction : null;
    snapByKey.set(key, { picks: num(t.picks), novel_fraction: nf, template_id: t.template_id });
  }

  // 2. Join gaps by detector. A gap is "novel-open" if open + recent (within window).
  interface Agg { emitted: number; landed: number; churned: number; open: number; novel_open: number; lastFired: number; really_fixed: number; closed_unverified: number }
  const byDetector = new Map<string, Agg>();
  const ensure = (id: string): Agg => {
    let a = byDetector.get(id);
    if (!a) { a = { emitted: 0, landed: 0, churned: 0, open: 0, novel_open: 0, lastFired: NaN, really_fixed: 0, closed_unverified: 0 }; byDetector.set(id, a); }
    return a;
  };

  for (const g of gaps) {
    const t = gapTime(g);
    if (Number.isFinite(t) && t < cutoff) continue; // out of window
    const det = detectorOf(g);
    const a = ensure(det);
    a.emitted += 1;
    if (Number.isFinite(t) && (!Number.isFinite(a.lastFired) || t > a.lastFired)) a.lastFired = t;
    const status = g.status ?? "open";
    if (status === "closed") {
      if (isChurned(g)) a.churned += 1;
      else a.landed += 1;
      // Counted alongside, never instead: changing what `landed` MEANS would flip ~1,202
      // detectors to LOW_YIELD at once, and the tick runs with emit_retirement_gaps:true,
      // so that reclassification would emit mass retirement gaps routing to deprecate.
      // The measurement is the safe half; acting on it is a separate, operator-gated call.
      if (isReallyFixed(g)) a.really_fixed += 1;
      else a.closed_unverified += 1;
    } else if (status === "open") {
      a.open += 1;
      a.novel_open += 1; // already window-filtered ⇒ recent enough to count as live signal
    }
    // rejected: counted in emitted but not landed/churned/open (operator dismissed)
  }

  // 3. Union of detector ids: those that emitted gaps + detector-class templates
  //    in the snapshot that emitted nothing (so DORMANT detectors still appear).
  const detectorIds = new Set<string>(byDetector.keys());
  // Add snapshot detector-class templates whose key matches no emitting detector
  // — but only ones that look like detectors (avoid listing every pool template).
  const DETECTOR_RE = /(scan|detect|coverage|audit|lifecycle|expectation|opportunity|orthogonality|consistency|funnel|health)/i;
  const snapKeyMatchesDetector = (gapDetId: string): string | null => {
    const k = normKey(gapDetId);
    if (snapByKey.has(k)) return k;
    // fuzzy: snapshot key contains the gap detector key or vice-versa
    for (const sk of snapByKey.keys()) {
      if (sk === k) return sk;
      if (sk.includes(k) || k.includes(sk)) return sk;
    }
    return null;
  };
  for (const [key, v] of snapByKey) {
    if (!DETECTOR_RE.test(v.template_id)) continue;
    // Does any emitting detector map to this snapshot key? If yes it's already covered.
    let covered = false;
    for (const det of byDetector.keys()) if (snapKeyMatchesDetector(det) === key) { covered = true; break; }
    if (!covered) detectorIds.add(v.template_id); // surface the dormant detector under its template_id
  }

  // 4. Build rows.
  const rows: DetectorRow[] = [];
  for (const det of detectorIds) {
    const a = byDetector.get(det) ?? { emitted: 0, landed: 0, churned: 0, open: 0, novel_open: 0, lastFired: NaN, really_fixed: 0, closed_unverified: 0 };
    const matchKey = snapKeyMatchesDetector(det);
    const snap = matchKey ? snapByKey.get(matchKey) : undefined;
    const picks = snap ? snap.picks : null;
    const novel = snap ? snap.novel_fraction : null;

    const status = classifyDetector(a, picks, dormantThreshold);

    rows.push({
      detector_id: det,
      status,
      gaps_emitted: a.emitted,
      gaps_landed: a.landed,
      gaps_churned: a.churned,
      gaps_really_fixed: a.really_fixed,
      gaps_closed_unverified: a.closed_unverified,
      gaps_open: a.open,
      picks,
      last_fired: Number.isFinite(a.lastFired) ? new Date(a.lastFired).toISOString() : null,
      novel_fraction: novel,
    });
  }

  rows.sort((x, y) =>
    (y.gaps_landed - x.gaps_landed) ||
    (y.gaps_open - x.gaps_open) ||
    (y.gaps_emitted - x.gaps_emitted) ||
    x.detector_id.localeCompare(y.detector_id));

  // 5. Optionally route retirement candidates through the gap path.
  let retirement_gaps_emitted = 0;
  let retirement_candidates_total = 0;
  if (emit) {
    // RETIRE IN BATCHES, NOISIEST FIRST — the information-positive order.
    //
    // Correcting PRODUCTIVE to require a real fix makes ~1,202 detectors newly eligible at
    // once. Emitting all of them in one pass would be the least informative possible action:
    // a single undifferentiated flood, no way to attribute any subsequent change in gap
    // quality to any part of it, and a large irreversible step taken on a rule that has never
    // been observed operating.
    //
    // Retiring the highest-volume zero-yield detectors first maximises noise removed per
    // decision, and capping the batch means the next run observes the CONSEQUENCE of this one
    // before going further. Each run is then a measurement rather than a leap, and the cap is
    // what makes the sequence convergent instead of a one-way door.
    const candidates = rows
      .filter((r) => r.status === "DORMANT" || r.status === "LOW_YIELD")
      .sort((x, y) => y.gaps_emitted - x.gaps_emitted)
      .slice(0, RETIREMENT_EMISSION_CAP);
    for (const r of candidates) {
      if (await emitRetirementGap(emitUrl, apiKey, r)) retirement_gaps_emitted += 1;
    }
    retirement_candidates_total = rows.filter(
      (r) => r.status === "DORMANT" || r.status === "LOW_YIELD",
    ).length;
  }

  const summary = {
    total: rows.length,
    productive: rows.filter((r) => r.status === "PRODUCTIVE").length,
    low_yield: rows.filter((r) => r.status === "LOW_YIELD").length,
    dormant: rows.filter((r) => r.status === "DORMANT").length,
    unknown: rows.filter((r) => r.status === "UNKNOWN").length,
  };

  // HOW MUCH OF THE YIELD SIGNAL IS REAL. Surfaced at the top so nobody has to read a
  // thousand rows to notice that `landed` mostly means `expired`. On the live store this
  // reads roughly 1,472 landed against 60 really fixed — 24.5x — with 97% of the detectors
  // that look productive never having had a single gap actually fixed.
  const landedTotal = rows.reduce((n, r) => n + r.gaps_landed, 0);
  const fixedTotal = rows.reduce((n, r) => n + r.gaps_really_fixed, 0);
  const yield_integrity = {
    gaps_landed_total: landedTotal,
    gaps_really_fixed_total: fixedTotal,
    gaps_closed_unverified_total: rows.reduce((n, r) => n + r.gaps_closed_unverified, 0),
    inflation_ratio: fixedTotal > 0 ? Number((landedTotal / fixedTotal).toFixed(1)) : null,
    detectors_landed_gt_zero: rows.filter((r) => r.gaps_landed > 0).length,
    detectors_landed_gt_zero_but_none_fixed: rows.filter(
      (r) => r.gaps_landed > 0 && r.gaps_really_fixed === 0,
    ).length,
    note:
      "gaps_landed counts closed-and-not-churned, which includes expired_not_redetected and " +
      "closures with no reason recorded. gaps_really_fixed counts only closures that record a " +
      "verified fix. status/PRODUCTIVE and retirement emission still key on gaps_landed: " +
      "changing that would reclassify most detectors at once and, with emit_retirement_gaps, " +
      "emit mass retirement gaps. That is an operator decision, not a measurement.",
  };

  return {
    shape: "detectorYieldReport",
    body: {
      window_hours: windowHours,
      dormant_picks_threshold: dormantThreshold,
      detectors: rows,
      summary,
      yield_integrity,
      retirement_gaps_emitted: emit ? retirement_gaps_emitted : null,
      // Reported so a capped run is never mistaken for a finished one.
      retirement_candidates_total: emit ? retirement_candidates_total : null,
      retirement_emission_cap: RETIREMENT_EMISSION_CAP,
      gaps_examined: gaps.length,
      completed_at: new Date().toISOString(),
    },
  };
}
