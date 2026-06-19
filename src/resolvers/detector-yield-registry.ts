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

function isChurned(g: GapRow): boolean {
  const m = g.classification_metadata ?? {};
  const reason = m["closed_reason"];
  return typeof reason === "string" && /churn/i.test(reason);
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
  interface Agg { emitted: number; landed: number; churned: number; open: number; novel_open: number; lastFired: number }
  const byDetector = new Map<string, Agg>();
  const ensure = (id: string): Agg => {
    let a = byDetector.get(id);
    if (!a) { a = { emitted: 0, landed: 0, churned: 0, open: 0, novel_open: 0, lastFired: NaN }; byDetector.set(id, a); }
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
      if (isChurned(g)) a.churned += 1; else a.landed += 1;
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
    const a = byDetector.get(det) ?? { emitted: 0, landed: 0, churned: 0, open: 0, novel_open: 0, lastFired: NaN };
    const matchKey = snapKeyMatchesDetector(det);
    const snap = matchKey ? snapByKey.get(matchKey) : undefined;
    const picks = snap ? snap.picks : null;
    const novel = snap ? snap.novel_fraction : null;

    let status: DetectorStatus;
    if (picks !== null && picks < dormantThreshold) {
      status = "DORMANT";
    } else if (a.landed > 0 || a.novel_open > 0) {
      status = "PRODUCTIVE";
    } else if (a.emitted > 0 && a.landed === 0 && a.churned >= a.open && a.churned > 0) {
      status = "LOW_YIELD";
    } else if (a.emitted > 0) {
      // emitted but no landed/novel-open and not churn-dominated — still low signal
      status = "LOW_YIELD";
    } else {
      status = "UNKNOWN";
    }

    rows.push({
      detector_id: det,
      status,
      gaps_emitted: a.emitted,
      gaps_landed: a.landed,
      gaps_churned: a.churned,
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
  if (emit) {
    for (const r of rows) {
      if (r.status === "DORMANT" || r.status === "LOW_YIELD") {
        if (await emitRetirementGap(emitUrl, apiKey, r)) retirement_gaps_emitted += 1;
      }
    }
  }

  const summary = {
    total: rows.length,
    productive: rows.filter((r) => r.status === "PRODUCTIVE").length,
    low_yield: rows.filter((r) => r.status === "LOW_YIELD").length,
    dormant: rows.filter((r) => r.status === "DORMANT").length,
    unknown: rows.filter((r) => r.status === "UNKNOWN").length,
  };

  return {
    shape: "detectorYieldReport",
    body: {
      window_hours: windowHours,
      dormant_picks_threshold: dormantThreshold,
      detectors: rows,
      summary,
      retirement_gaps_emitted: emit ? retirement_gaps_emitted : null,
      gaps_examined: gaps.length,
      completed_at: new Date().toISOString(),
    },
  };
}
