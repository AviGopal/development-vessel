import type { ResolverResult } from "./types.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

export interface LearningTransferReportPointer {
  type: "learning_transfer_report";
  limit?: number;
  /** When true, file the worst finding as a substrateGap so gap-compose can author a fix. */
  emit_gap?: boolean;
  /** SF-coverage floor below which a performance_inefficiency gap is filed (default 0.5). */
  sf_coverage_floor?: number;
}

interface SurrealResult {
  status?: string;
  result?: unknown;
  detail?: string;
}

const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

function surrealHeaders(): Record<string, string> {
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "surreal-ns": process.env["SURREALDB_NAMESPACE"] ?? "activity-system",
    "surreal-db": process.env["SURREALDB_DATABASE"] ?? "learning_loop",
    "Authorization": "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
  };
}

async function sql(query: string): Promise<SurrealResult[]> {
  const url = (process.env["SURREALDB_URL"] ?? DEFAULT_SURREAL_URL).replace(/\/+$/, "");
  const res = await fetch(`${url}/sql`, { method: "POST", headers: surrealHeaders(), body: query });
  if (!res.ok) throw new Error(`surreal /sql http ${res.status}`);
  return (await res.json()) as SurrealResult[];
}

function rowsOf(r: SurrealResult | undefined): Array<Record<string, unknown>> {
  const v = r?.result;
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

function countOf(r: SurrealResult | undefined): number {
  const rs = rowsOf(r);
  const c = rs[0]?.["count"];
  return typeof c === "number" ? c : 0;
}

function normId(id: unknown): string {
  return String(id ?? "").replace(/^activity:/, "").replace(/[⟨⟩]/g, "");
}

/**
 * AN ARM CANNOT EXECUTE MORE OFTEN THAN IT IS SELECTED.
 *
 * `variant_performance_metrics.total_executions` is read by lifecycle decisions — notably
 * checkAndRetireTemplate, which requires >= 20 executions before it will retire a poor
 * performer. Measured 2026-09-05 that counter is inflated by orders of magnitude, so every
 * threshold keyed on it fires far too early:
 *
 *   sum(total_executions) over 4,089 arms : 2,158,161
 *   rows in `execution`                    :    34,314   (63x fewer)
 *   rows in `thompson_selection_log`       :    49,074
 *
 * Joined on a NORMALISED id (normId strips the `activity:` prefix and the corner brackets;
 * the naive join matches 0 arms and that 0 is an id-namespace artifact, not a finding), the
 * 66 matched arms with >= 500 claimed executions show 440,228 claims against 2,839
 * selections — 155x. Worst single arm: slot-binding, 243,063 claimed from 5 selections.
 *
 * Selection is the only route by which an arm runs, so ratio >> 1 is not a tuning question,
 * it is a broken counter. This check exists so the invariant is asserted continuously
 * instead of being rediscovered: it is the detector for the class, not a repair of it.
 *
 * ABSTAINS rather than accuses. An arm with no selection rows at all is NOT reported — the
 * selection log may simply be retained for a shorter window than the counter, and a
 * retention gap is indistinguishable from over-counting without a fixed comparison window.
 * Only arms with BOTH a positive selection count and a ratio above the threshold are named.
 */
export interface CounterIntegrityViolation {
  activity_id: string;
  total_executions: number;
  selections: number;
  ratio: number;
}

export function counterIntegrity(
  arms: ReadonlyArray<{ activity_id?: unknown; total_executions?: unknown }>,
  selectionsByArm: ReadonlyMap<string, number>,
  opts?: { minExecutions?: number; ratioThreshold?: number; limit?: number },
): { checked: number; violations: CounterIntegrityViolation[]; worst_ratio: number } {
  const minExec = opts?.minExecutions ?? 100;
  const thresh = opts?.ratioThreshold ?? 10;
  const limit = opts?.limit ?? 10;
  const violations: CounterIntegrityViolation[] = [];
  let checked = 0;
  let worst = 0;
  for (const a of arms) {
    const id = normId(a?.activity_id);
    const te = Number(a?.total_executions ?? 0);
    if (!id || !Number.isFinite(te) || te < minExec) continue;
    const sel = selectionsByArm.get(id);
    if (sel === undefined || sel <= 0) continue;   // abstain: cannot distinguish retention from over-count
    checked++;
    const ratio = te / sel;
    if (ratio > worst) worst = ratio;
    if (ratio > thresh) {
      violations.push({ activity_id: id, total_executions: te, selections: sel, ratio: Math.round(ratio) });
    }
  }
  violations.sort((x, y) => y.ratio - x.ratio);
  return { checked, violations: violations.slice(0, limit), worst_ratio: Math.round(worst) };
}

export async function resolveLearningTransferReport(
  pointer: LearningTransferReportPointer,
): Promise<ResolverResult> {
  const limit = typeof pointer.limit === "number" && pointer.limit > 0 ? pointer.limit : 10;
  try {
    const batch = await sql(
      `SELECT count() FROM variant_performance_metrics GROUP ALL;` +
        `SELECT count() FROM variant_performance_metrics WHERE total_executions = 0 GROUP ALL;` +
        `SELECT activity_id FROM variant_performance_metrics WHERE total_executions = 0 LIMIT ${limit};` +
        `SELECT count() FROM activity_composition_graph WHERE genuine = true GROUP ALL;` +
        `SELECT parent_activity_id, child_activity_id, success_count FROM activity_composition_graph WHERE genuine = true AND success_count > 0 LIMIT 200;` +
        `SELECT count() FROM successor_features GROUP ALL;` +
        `SELECT count() AS n, activity_id FROM thompson_selection_log GROUP BY activity_id;`,
    );
    const total = countOf(batch[0]);
    const uninformed = countOf(batch[1]);
    const sampleIds = rowsOf(batch[2]).map((r) => String(r["activity_id"] ?? "")).slice(0, limit);
    const genuineEdges = countOf(batch[3]);
    const chains = rowsOf(batch[4]);
    const sfCells = countOf(batch[5]);
    const selByArm = new Map<string, number>();
    for (const r of rowsOf(batch[6])) {
      const k = normId(r["activity_id"]);
      if (k) selByArm.set(k, Number(r["n"] ?? 0));
    }
    const fraction = total > 0 ? uninformed / total : 0;

    const parentKeys = Array.from(new Set(chains.map((c) => normId(c["parent_activity_id"]))));
    const alphaByParent = new Map<string, number>();
    if (parentKeys.length > 0) {
      const inList = JSON.stringify(parentKeys);
      const pr = await sql(`SELECT activity_id, thompson_alpha FROM variant_performance_metrics WHERE activity_id IN ${inList};`);
      for (const row of rowsOf(pr[0])) {
        alphaByParent.set(normId(row["activity_id"]), Number(row["thompson_alpha"] ?? 0));
      }
    }

    let stalledCount = 0;
    let matched = 0;
    const stalledSample: Array<Record<string, unknown>> = [];
    for (const c of chains) {
      const alpha = alphaByParent.get(normId(c["parent_activity_id"]));
      if (alpha === undefined) continue;
      matched++;
      const childSuccess = Number(c["success_count"] ?? 0);
      if (childSuccess > 0 && alpha <= 1.5) {
        stalledCount++;
        if (stalledSample.length < limit) {
          stalledSample.push({ parent: c["parent_activity_id"], child: c["child_activity_id"], child_success: childSuccess, parent_alpha: alpha });
        }
      }
    }

    const density = total > 0 ? genuineEdges / total : 0;
    const coverage = total > 0 ? sfCells / total : 0;
    // COUNTER INTEGRITY. An arm cannot execute more often than it is selected; see
    // counterIntegrity above for the measured 155x violation this exists to keep visible.
    const armBatch = await sql(
      `SELECT activity_id, total_executions FROM variant_performance_metrics WHERE total_executions >= 100;`,
    );
    const armRows = rowsOf(armBatch[0]);
    const integrity = counterIntegrity(
      armRows as ReadonlyArray<{ activity_id?: unknown; total_executions?: unknown }>,
      selByArm,
    );

    const body: Record<string, unknown> = {
      scanned: true,
      crystallized_cells: { total, uninformed, fraction, sample_ids: sampleIds },
      genuine_edge_density: {
        genuine_edges: genuineEdges,
        cells: total,
        density,
        uninformed_fraction: fraction,
        inequality_ok: total > 0 ? density >= fraction : false,
      },
      stalled_credit_chains: { stalled_count: stalledCount, chains_examined: chains.length, parents_matched: matched, sample: stalledSample },
      sf_coverage: { sf_cells: sfCells, variant_cells: total, coverage },
      counter_integrity: integrity,
      note: "descriptive; no posterior writes",
    };

    // Consumption seam: file the worst transfer-failure finding as a substrateGap so the
    // gap_to_feature -> feature_compose loop authors the fix. SF-coverage (fraction of the
    // posterior space carrying a successor-feature transfer vector) is the load-bearing lever.
    if (pointer.emit_gap && total > 0) {
      const floor = typeof pointer.sf_coverage_floor === "number" ? pointer.sf_coverage_floor : 0.5;
      if (coverage < floor) {
        const pct = (coverage * 100).toFixed(1);
        const summary =
          `Successor-feature transfer coverage is low: ${sfCells}/${total} variant cells (${pct}%) carry a ` +
          `ψ transfer vector (< floor ${(floor * 100).toFixed(0)}%). This is NOT a writer/backfill problem — ` +
          `updateSuccessorFeatures UPSERTs healthily on every trace store. The uncovered cells are STRUCTURALLY ` +
          `INELIGIBLE: their traces carry no v1 state-signature (gate lib/successor-features.ts:172) and/or no ` +
          `output_impulse_shapes (gate lib/successor-features.ts:181), so no ψ row is ever written for them. ` +
          `Canonical case: validator-dispatch has ~650k executions yet zero ψ rows (signature=null, ` +
          `output_impulse_shapes=null). The eligible (v1-signature × template) population is already ~fully covered, ` +
          `so the constant writes only re-UPSERT existing cells. LEVER — do NOT author a ψ backfill (the cells are ` +
          `ineligible, not un-computed); instead (a) attach v1 state-signatures to high-volume plumbing traces ` +
          `(validator-dispatch, sig-less slot-binding, …), (b) make those cells emit output_impulse_shapes, or ` +
          `(c) deliberately relax the two eligibility gates.`;
        try {
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              id: "learning-transfer-sf-coverage-low",
              category: "performance_inefficiency",
              source: "substrate_detected",
              summary,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                detector: "learning_transfer_report",
                sf_cells: sfCells,
                variant_cells: total,
                coverage,
                floor,
                genuine_edge_density: density,
                uninformed_fraction: fraction,
                lambda1_inequality_ok: total > 0 ? density >= fraction : false,
                diagnosis: "structural_ineligibility_not_writer",
                eligibility_gates: [
                  "lib/successor-features.ts:172 (no v1 state-signature)",
                  "lib/successor-features.ts:181 (no output_impulse_shapes)",
                ],
                canonical_uncovered_cell: "validator-dispatch (~650k executions, signature=null, output_impulse_shapes=null, 0 psi rows)",
                real_lever: "attach signatures + output-shapes to plumbing traces, or relax the two gates — NOT a psi backfill",
              },
            },
          });
          body["gap_emitted"] = "learning-transfer-sf-coverage-low";
        } catch (gapErr) {
          body["gap_emit_error"] = (gapErr as Error).message;
        }
      } else {
        body["gap_emitted"] = null;
      }
    }

    return { shape: "learningTransferReport", body };
  } catch (err) {
    return { shape: "learningTransferReport", body: { scanned: false, error: (err as Error).message } };
  }
}
