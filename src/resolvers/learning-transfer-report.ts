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
        `SELECT count() FROM successor_features GROUP ALL;`,
    );
    const total = countOf(batch[0]);
    const uninformed = countOf(batch[1]);
    const sampleIds = rowsOf(batch[2]).map((r) => String(r["activity_id"] ?? "")).slice(0, limit);
    const genuineEdges = countOf(batch[3]);
    const chains = rowsOf(batch[4]);
    const sfCells = countOf(batch[5]);
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
          `ψ transfer vector (< floor ${(floor * 100).toFixed(0)}%). Most of the posterior space cannot borrow ` +
          `value across goals — cross-activity learning is failing to flow. Author a fix that raises successor_features ` +
          `coverage (compute/backfill ψ for uninformed and newly-composed cells) so the transfer machinery covers more cells.`;
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
