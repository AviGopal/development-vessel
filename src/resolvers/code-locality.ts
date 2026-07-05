/**
 * code_locality — substrate-authored resolver (Seam ③).
 * Output shape: code_locality_result
 */

import type { ResolverResult } from "./types.js";

export interface CodeLocalityPointer {
  type: "code_locality";
  family?: string;
  goal_hash?: string;
  gap_id?: string;
  indexPath?: string;
  max_files?: number;
}

// SHADOW MODE ONLY. Per the ratified causal-discipline principle (interventions
// over correlations: trace correlations are partly effect-as-cause), this
// resolver must initially only LOG what it would have retrieved alongside what
// the exploratory path actually used, as a decision-time counterfactual record.
// It must NOT gate or replace retrieval yet.
export async function resolveCodeLocality(pointer: CodeLocalityPointer): Promise<ResolverResult> {
  const family = pointer.family ?? (pointer.goal_hash ? `goal:${pointer.goal_hash}` : pointer.gap_id ? `gap:${pointer.gap_id}` : undefined);
  if (!family) {
    return { shape: "codeContext", body: { found: false, reason: "no family key provided", shadow_mode: true } };
  }
  const indexPath = pointer.indexPath ?? "/workspace/locality/code-locality-index.json";
  let parsed: unknown;
  try {
    const { readFileSync } = await import("node:fs");
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return { shape: "codeContext", body: { found: false, family, reason: "index unavailable", shadow_mode: true } };
  }
  const families = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["families"] : undefined;
  const entry = typeof families === "object" && families !== null ? (families as Record<string, unknown>)[family] : undefined;
  if (typeof entry !== "object" || entry === null) {
    return { shape: "codeContext", body: { found: false, family, reason: "family not in index", shadow_mode: true } };
  }
  const entryObj = entry as Record<string, unknown>;
  const reportCount = typeof entryObj["report_count"] === "number" ? entryObj["report_count"] : 0;
  const filesVal = entryObj["files"];
  const fileEntries: Array<{ path: string; edit_count: number; spans: Array<{ start_line: number; end_line: number; count: number }> }> = [];
  if (typeof filesVal === "object" && filesVal !== null) {
    for (const [path, fv] of Object.entries(filesVal as Record<string, unknown>)) {
      if (typeof fv !== "object" || fv === null) continue;
      const fo = fv as Record<string, unknown>;
      const editCount = typeof fo["edit_count"] === "number" ? fo["edit_count"] : 0;
      const spansRaw = fo["spans"];
      const spans: Array<{ start_line: number; end_line: number; count: number }> = [];
      if (Array.isArray(spansRaw)) {
        for (const s of spansRaw) {
          if (typeof s !== "object" || s === null) continue;
          const so = s as Record<string, unknown>;
          if (typeof so["start_line"] === "number" && typeof so["end_line"] === "number") {
            spans.push({ start_line: so["start_line"], end_line: so["end_line"], count: typeof so["count"] === "number" ? so["count"] : 1 });
          }
        }
      }
      fileEntries.push({ path, edit_count: editCount, spans });
    }
  }
  fileEntries.sort((a, b) => b.edit_count - a.edit_count);
  const pointers: Array<{ type: "file"; path: string; offset: number; limit: number; evidence_count: number }> = [];
  for (const f of fileEntries.slice(0, pointer.max_files ?? 5)) {
    const topSpans = [...f.spans].sort((a, b) => b.count - a.count).slice(0, 3);
    for (const s of topSpans) {
      pointers.push({ type: "file", path: f.path, offset: s.start_line, limit: Math.max(1, s.end_line - s.start_line + 1), evidence_count: s.count });
    }
  }
  return { shape: "codeContext", body: { found: true, family, report_count: reportCount, pointers, shadow_mode: true, note: "shadow-mode counterfactual — do not gate retrieval on this output" } };
}
