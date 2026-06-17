import type { ResolverResult } from "./types.js";
import { readFileSync } from "node:fs";

/**
 * detector_meta_scan — an Nth-ORDER detector whose subject is the DETECTOR SET
 * itself (a detector over detectors). First-order detectors watch executions;
 * second-order ones (gap_lifecycle_scan) watch the gap store; this watches the
 * detectors. It answers "is the substrate's detection apparatus itself healthy?":
 *
 *  - dormant_detector: a detector-class template the boredom pool knows but has
 *    NEVER exercised (picks=0 over the window). A detector that never runs covers
 *    nothing — it must be exercised (exploration boost) or pruned. This is the
 *    completeness-critic move: detecting holes in detection, not in execution.
 *  - emits a detector-coverage-map meta-gap summarizing the apparatus.
 *
 * Reads the boredom selector snapshot the pool already writes (per-template picks +
 * mean) — deterministic, no LLM. Crucially it is RECURSIVELY COMPOSABLE: its own
 * tick (detector-meta-tick) appears in that same snapshot, so a meta-meta scan could
 * read detector_meta_scan's coverage output — the Nth-order ladder, bounded only by
 * the operator's appetite (each level is the same cheap snapshot-reader pattern).
 *
 * Note: a detector with mean≈0 is NOT flagged — finding nothing is correct when
 * there is no problem. Only NEVER-RUN (dormant) detectors are actionable here.
 */

interface SnapTpl { template_id?: unknown; picks?: unknown; mean?: unknown }
interface Snap { generated_at?: unknown; templates?: unknown }

export interface DetectorMetaScanPointer {
  type: "detector_meta_scan";
  selectorStatePath?: string;  // default /workspace/state/boredom-selector-state.json
  minPicks?: number;           // picks below this = dormant. default 1 (never run)
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
  _snapshot?: Snap;            // test hook
}

const DEFAULT_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_STATE = "/workspace/state/boredom-selector-state.json";
// Template-id patterns that mark a template as a DETECTOR (its job is to find gaps).
const DETECTOR_RE = /(^|:|-)(detect-|.*-scan$|.*-scan-tick$|.*audit-tick$|coverage|funnel|expectation|opportunity|lifecycle|consistency|orthogonality|health-tick)/i;
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function resolveDetectorMetaScan(p: DetectorMetaScanPointer): Promise<ResolverResult> {
  const minPicks = p.minPicks ?? 1;
  const dryRun = p.dry_run === true;
  const emitUrl = p.devVesselImpulsesUrl ?? DEFAULT_URL;

  let snap: Snap;
  if (p._snapshot) snap = p._snapshot;
  else {
    try { snap = JSON.parse(readFileSync(p.selectorStatePath ?? DEFAULT_STATE, "utf-8")) as Snap; }
    catch (err) { return { shape: "structuredError", body: { resolver: "detector_meta_scan", detail: `selector snapshot unreadable: ${(err as Error).message}` } }; }
  }

  const tpls: SnapTpl[] = Array.isArray(snap.templates) ? (snap.templates as SnapTpl[]) : [];
  const detectors = tpls.filter((t) => typeof t.template_id === "string" && DETECTOR_RE.test(t.template_id as string));
  const dormant = detectors.filter((t) => num(t.picks) < minPicks).map((t) => String(t.template_id));
  const active = detectors.filter((t) => num(t.picks) >= minPicks).map((t) => String(t.template_id));
  const productive = detectors.filter((t) => num(t.picks) >= minPicks && num(t.mean) > 0).length;

  const findings: Array<{ subtype: string; summary: string; metadata: Record<string, unknown> }> = [];
  if (dormant.length > 0) {
    findings.push({
      subtype: "dormant_detectors",
      summary:
        `Detector apparatus: ${detectors.length} detector-class templates known to the pool, ` +
        `${active.length} exercised (${productive} have found signal), but ${dormant.length} are DORMANT ` +
        `(never selected by the UCB → cover nothing): ${dormant.slice(0, 10).join(", ")}. ` +
        `Dormant detectors are blind spots-in-waiting — exercise them (exploration boost / scheduled tick) or prune. ` +
        `This is the substrate auditing its own detection coverage (Nth-order).`,
      metadata: {
        gap_subtype: "dormant_detectors",
        detectors_known: detectors.length, active: active.length, productive, dormant_count: dormant.length,
        dormant: dormant.slice(0, 30),
      },
    });
  }

  let posted: number | "error" | null = null;
  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
  if (!dryRun && findings.length > 0) {
    const f = findings[0]!;
    try {
      const resp = await fetch(emitUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: {
          id: "detector-coverage-dormant", category: "architectural_pattern", source: "substrate_detected",
          summary: f.summary, detected_at: new Date().toISOString(), status: "open", classification_metadata: f.metadata,
        } } } }),
        signal: AbortSignal.timeout(8_000),
      });
      posted = resp.status;
    } catch { posted = "error"; }
  }

  return {
    shape: "detectorMetaReport",
    body: {
      detectors_known: detectors.length, active: active.length, productive, dormant_count: dormant.length,
      dormant, finding_count: findings.length, findings, meta_gap_posted: posted,
      dry_run: dryRun, completed_at: new Date().toISOString(),
    },
  };
}
