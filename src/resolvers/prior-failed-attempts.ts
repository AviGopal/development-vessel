import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * prior_failed_attempts — surface the substrate's RECENT FAILED proposal attempts
 * so the drafter can LEARN from them instead of re-drafting the same failing fix.
 *
 * Two learning channels (2026-06-18):
 *   1. SAME-SCENARIO replay — failures recorded against THIS exact gap.
 *   2. ORTHOGONAL transfer — failures on DIFFERENT scenarios/vessels whose trace
 *      is SIMILAR by failure class (shared TypeScript error code, shared reason
 *      category, shared subsystem keyword). This is the "learn orthogonally to
 *      other activities/vessels/resolvers based on similar traces" capability:
 *      a TS2459 import-fix that no-op'd on activity-api teaches the general lesson
 *      to a TS-class proposal on goal-host-vessel even though the scenarios differ.
 *
 * Source: apply-proposal-as-patch's `.rejected/` audit trail. Each record carries
 * `reason` (file_path_hallucination | patch_noop | patch_typecheck_fail |
 * patch_failed), optional `missing[]` / `target_file` / `detail`, and the proposal's
 * `original_content_preview`. Tolerant by construction — absent/malformed history
 * yields an empty (valid) report, never an exception.
 */
export interface PriorFailedAttemptsPointer {
  type: "prior_failed_attempts";
  /** Scenario being drafted; used to match same-scenario + score orthogonal similarity. */
  scenario_id?: string;
  /** Directory holding proposals + a `.rejected/` subdir. Default /workspace/proposals. */
  proposals_dir?: string;
  /** Max attempts to surface per channel. Default 6 each. */
  limit?: number;
}

interface RejectedRecord {
  reason?: string;
  missing?: string[];
  rejected_at?: string;
  target_file?: string;
  detail?: string;
  original_content_preview?: string;
}

interface Attempt {
  proposal: string;
  reason: string;
  missing: string[];
  target_file: string;
  prior_summary: string;
  rejected_at: string;
  provenance: "same_scenario" | "orthogonal_similar";
  similarity: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Subsystem / failure-class keywords used for orthogonal trace similarity.
const CLASS_KEYWORDS = [
  "typecheck", "import", "export", "auth", "401", "schema", "resolver", "dispatch",
  "mitosis", "cutover", "concept", "embedding", "validation", "composition",
  "lifecycle", "posterior", "thompson", "trace", "shape",
];

function classSignals(text: string): { tsCode: string | null; classes: Set<string> } {
  const t = text.toLowerCase();
  const tsCode = (t.match(/ts\d{3,4}/) ?? [])[0] ?? null;
  const classes = new Set<string>();
  for (const k of CLASS_KEYWORDS) if (t.includes(k)) classes.add(k);
  if (tsCode) classes.add("typecheck");
  return { tsCode, classes };
}

function extractPriorSummary(preview?: string): string {
  if (!preview) return "";
  const m = preview.match(/"summary"\s*:\s*"([^"]{0,180})/);
  return m?.[1] ?? "";
}

function whyLine(a: Attempt): string {
  const why = a.reason === "file_path_hallucination"
    ? `targeted NON-EXISTENT file(s) ${a.missing.join(", ")} — pick a file that actually exists`
    : a.reason === "patch_noop"
    ? "the patcher made NO edit (the proposed change was not actually present in the target file, the target file was wrong, or the change needs no edit) — re-examine the file/symbol and propose a concrete change that is genuinely present and needed"
    : a.reason === "patch_typecheck_fail"
    ? "the patch broke typecheck on the target — the proposed edit was wrong; propose a change that compiles"
    : a.reason === "patch_failed"
    ? "the patcher exhausted its attempts without a verified patch — the proposal was too vague or wrong; name the exact symbol/lines"
    : `rejected as ${a.reason}`;
  const tgt = a.target_file ? ` (target was ${a.target_file})` : "";
  return `${why}${tgt}.` + (a.prior_summary ? ` Prior (failed) approach: "${a.prior_summary}".` : "");
}

export async function resolvePriorFailedAttempts(
  pointer: PriorFailedAttemptsPointer,
): Promise<ResolverResult> {
  const proposalsDir = pointer.proposals_dir ?? "/workspace/proposals";
  const rejectedDir = join(proposalsDir, ".rejected");
  const scenarioId = (pointer.scenario_id ?? "").trim();
  const sn = scenarioId ? norm(scenarioId).slice(0, 40) : "";
  const cur = classSignals(scenarioId);
  const limit = Math.max(1, pointer.limit ?? 6);

  interface Scored { a: Attempt; mtime: number; sameScenario: boolean; }
  const scored: Scored[] = [];
  try {
    const files = await readdir(rejectedDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const path = join(rejectedDir, f);
      let mtime = 0;
      try { mtime = (await stat(path)).mtimeMs; } catch { /* keep 0 */ }
      try {
        const rec = JSON.parse(await readFile(path, "utf8")) as RejectedRecord;
        const prior = extractPriorSummary(rec.original_content_preview);
        const blob = `${f} ${prior} ${(rec.missing ?? []).join(" ")} ${rec.target_file ?? ""} ${rec.detail ?? ""}`;
        const sameScenario = sn.length > 0 && norm(blob).includes(sn);
        // Orthogonal similarity: shared TS error code (strong) + shared class keywords (weak).
        const sig = classSignals(blob);
        let similarity = 0;
        if (cur.tsCode && sig.tsCode === cur.tsCode) similarity += 3;
        for (const c of cur.classes) if (sig.classes.has(c)) similarity += 1;
        scored.push({
          mtime,
          sameScenario,
          a: {
            proposal: f,
            reason: rec.reason ?? "unknown",
            missing: rec.missing ?? [],
            target_file: rec.target_file ?? "",
            prior_summary: prior,
            rejected_at: rec.rejected_at ?? "",
            provenance: sameScenario ? "same_scenario" : "orthogonal_similar",
            similarity,
          },
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* .rejected absent -> no history */ }

  const same = scored.filter((s) => s.sameScenario).sort((x, y) => y.mtime - x.mtime).slice(0, limit).map((s) => s.a);
  // Orthogonal channel: similar-by-class, different scenario, only when we have a
  // class signal to match on and the attempt actually shares it (similarity > 0).
  const ortho = scored
    .filter((s) => !s.sameScenario && s.a.similarity > 0)
    .sort((x, y) => (y.a.similarity - x.a.similarity) || (y.mtime - x.mtime))
    .slice(0, limit)
    .map((s) => s.a);

  // Recent fallback: when there is no same-scenario and no class-similar history,
  // still surface the most-recent failures as general context (the drafter should
  // always see SOMETHING about what has been failing).
  const recent = (same.length + ortho.length) === 0
    ? scored.sort((x, y) => y.mtime - x.mtime).slice(0, limit).map((s) => ({ ...s.a, provenance: "orthogonal_similar" as const }))
    : [];

  const sections: string[] = [];
  if (same.length > 0) {
    sections.push(
      "FAILURES ON THIS EXACT GAP (do NOT repeat):\n" +
      same.map((a, i) => `${i + 1}. ${whyLine(a)}`).join("\n"));
  }
  if (ortho.length > 0) {
    sections.push(
      "FAILURES ON SIMILAR GAPS — other activities/vessels/resolvers with a similar trace " +
      "(learn the GENERAL lesson; the fix approach below failed there, so avoid the same shape here):\n" +
      ortho.map((a, i) => `${i + 1}. ${whyLine(a)}`).join("\n"));
  }
  if (recent.length > 0) {
    sections.push(
      "RECENT FAILURES (general context — approaches that did not land lately):\n" +
      recent.map((a, i) => `${i + 1}. ${whyLine(a)}`).join("\n"));
  }
  const summary_text = sections.length > 0
    ? sections.join("\n\n") +
      "\n\nLesson: ensure the target file EXISTS and the symbol/change is genuinely present there; " +
      "if a prior approach (here or on a similar trace) targeted the wrong file or an imported-not-declared " +
      "symbol, target the CONSUMER or the real declaring module instead, and name the exact lines."
    : "No prior failed proposal attempts on record (same-scenario or similar). Draft freely, but still name a CONCRETE, EXISTING target file and a precise minimal edit.";

  return {
    shape: "priorFailedAttempts",
    body: {
      scenario_id: scenarioId,
      same_scenario_count: same.length,
      orthogonal_count: ortho.length,
      count: same.length + ortho.length + recent.length,
      attempts: [...same, ...ortho, ...recent],
      summary_text,
    },
  };
}
