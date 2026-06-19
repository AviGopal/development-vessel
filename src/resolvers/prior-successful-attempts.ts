import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * prior_successful_attempts — surface the substrate's RECENT LANDED proposal
 * attempts so the drafter can LEARN FROM SUCCESS while drafting, the symmetric
 * counterpart to prior_failed_attempts (2026-06-18).
 *
 * The drafter already learns what NOT to do (prior_failed_attempts) and has
 * diffuse success signal (concept priors + co-occurrence edges). What it lacked
 * was explicit recall of the WINNING proposal SHAPES — the concrete approaches
 * that actually staged/landed. This closes the failure/success asymmetry named
 * by the autonomy goal: "avoid its previous failures AND learn from its previous
 * success while drafting."
 *
 * Two learning channels, identical to the failure resolver:
 *   1. SAME-SCENARIO — a fix for THIS exact gap already landed (it may already be
 *      resolved; verify before re-drafting, or build on the landed approach).
 *   2. ORTHOGONAL transfer — successes on DIFFERENT scenarios/vessels whose trace
 *      is SIMILAR by class (shared TypeScript error code, shared reason category,
 *      shared subsystem keyword): REUSE the winning shape on the analogous target.
 *
 * Source: apply-proposal-as-patch's `.applied/` sentinel trail (sibling to the
 * `.rejected/` trail the failure resolver reads). A sentinel marks a SUCCESS when
 * it carries a staged-patch marker (`mitosis_version_id` / `multifile`) or a
 * non-error `outcome_shape` from patch_with_tools; sentinels carrying a `reason`
 * (file_path_hallucination) or `outcome_shape:"structuredError"` are skip-markers,
 * NOT successes, and are filtered out. The winning approach's summary/target is
 * joined from the matching `<name>` proposal report in `proposals_dir`.
 *
 * Tolerant by construction — absent/malformed history yields an empty (valid)
 * report, never an exception.
 */
export interface PriorSuccessfulAttemptsPointer {
  type: "prior_successful_attempts";
  /** Scenario being drafted; used to match same-scenario + score orthogonal similarity. */
  scenario_id?: string;
  /** Directory holding proposals + an `.applied/` subdir. Default /workspace/proposals. */
  proposals_dir?: string;
  /** Max attempts to surface per channel. Default 6 each. */
  limit?: number;
}

interface AppliedSentinel {
  // success markers
  mitosis_version_id?: string;
  multifile?: boolean;
  file_count?: number;
  delegated_to?: string;
  outcome_shape?: string;
  applied_at?: string;
  staged_at?: string;
  content_sha?: string;
  // failure/skip markers (presence => NOT a success)
  reason?: string;
  rejected_at?: string;
}

interface Win {
  proposal: string;
  won_summary: string;
  target_file: string;
  outcome: string;
  landed_at: string;
  provenance: "same_scenario" | "orthogonal_similar";
  similarity: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// Subsystem / failure-class keywords used for orthogonal trace similarity.
// Kept identical to prior-failed-attempts so the two channels score symmetrically.
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

/** A sentinel is a genuine SUCCESS iff it staged a patch and carries no failure marker. */
function isSuccess(s: AppliedSentinel): boolean {
  if (s.reason) return false;                              // file_path_hallucination etc.
  if (s.outcome_shape === "structuredError") return false; // patch_with_tools no-op/fail
  if (s.mitosis_version_id || s.multifile === true) return true;        // new_files staged
  if (s.delegated_to && s.outcome_shape) return true;      // delegated + non-error shape
  return false;                                            // legacy/ambiguous -> not surfaced
}

function extractWonSummary(reportRaw: string): { summary: string; target: string } {
  // Tolerant extraction — the report is usually {kind, summary, required_code_modifications[]}
  // or a new_files[] proposal. Never throw on malformed content.
  let summary = "";
  let target = "";
  try {
    const r = JSON.parse(reportRaw) as {
      summary?: string;
      target_file?: string;
      required_code_modifications?: Array<{ file?: string; description?: string }>;
      new_files?: Array<{ path?: string }>;
    };
    summary = (r.summary ?? "").slice(0, 180);
    target =
      r.target_file ??
      r.required_code_modifications?.find((m) => m.file)?.file ??
      r.new_files?.find((n) => n.path)?.path ??
      "";
  } catch {
    const m = reportRaw.match(/"summary"\s*:\s*"([^"]{0,180})/);
    summary = m?.[1] ?? "";
    const t = reportRaw.match(/"(?:file|path|target_file)"\s*:\s*"([^"]{0,160})/);
    target = t?.[1] ?? "";
  }
  return { summary, target };
}

function whyLine(w: Win): string {
  const tgt = w.target_file ? ` (it edited ${w.target_file})` : "";
  const how = w.won_summary ? ` Winning approach: "${w.won_summary}".` : "";
  return `LANDED${tgt}.${how} REUSE this shape where the current trace is analogous.`;
}

export async function resolvePriorSuccessfulAttempts(
  pointer: PriorSuccessfulAttemptsPointer,
): Promise<ResolverResult> {
  const proposalsDir = pointer.proposals_dir ?? "/workspace/proposals";
  const appliedDir = join(proposalsDir, ".applied");
  const scenarioId = (pointer.scenario_id ?? "").trim();
  const sn = scenarioId ? norm(scenarioId).slice(0, 40) : "";
  const cur = classSignals(scenarioId);
  const limit = Math.max(1, pointer.limit ?? 6);

  interface Scored { w: Win; mtime: number; sameScenario: boolean; }
  const scored: Scored[] = [];
  try {
    const files = await readdir(appliedDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const path = join(appliedDir, f);
      let mtime = 0;
      try { mtime = (await stat(path)).mtimeMs; } catch { /* keep 0 */ }
      try {
        const sentinel = JSON.parse(await readFile(path, "utf8")) as AppliedSentinel;
        if (!isSuccess(sentinel)) continue;
        // Join to the proposal report (same filename in proposals_dir) for the won shape.
        let won = { summary: "", target: "" };
        try { won = extractWonSummary(await readFile(join(proposalsDir, f), "utf8")); } catch { /* report gone */ }
        const blob = `${f} ${won.summary} ${won.target}`;
        const sameScenario = sn.length > 0 && norm(blob).includes(sn);
        const sig = classSignals(blob);
        let similarity = 0;
        if (cur.tsCode && sig.tsCode === cur.tsCode) similarity += 3;
        for (const c of cur.classes) if (sig.classes.has(c)) similarity += 1;
        scored.push({
          mtime,
          sameScenario,
          w: {
            proposal: f,
            won_summary: won.summary,
            target_file: won.target,
            outcome: sentinel.outcome_shape ?? (sentinel.multifile ? "mitosisStaged(multifile)" : "staged"),
            landed_at: sentinel.applied_at ?? sentinel.staged_at ?? "",
            provenance: sameScenario ? "same_scenario" : "orthogonal_similar",
            similarity,
          },
        });
      } catch { /* skip malformed */ }
    }
  } catch { /* .applied absent -> no history */ }

  const same = scored.filter((s) => s.sameScenario).sort((x, y) => y.mtime - x.mtime).slice(0, limit).map((s) => s.w);
  const ortho = scored
    .filter((s) => !s.sameScenario && s.w.similarity > 0)
    .sort((x, y) => (y.w.similarity - x.w.similarity) || (y.mtime - x.mtime))
    .slice(0, limit)
    .map((s) => s.w);
  const recent = (same.length + ortho.length) === 0
    ? scored.sort((x, y) => y.mtime - x.mtime).slice(0, limit).map((s) => ({ ...s.w, provenance: "orthogonal_similar" as const }))
    : [];

  const sections: string[] = [];
  if (same.length > 0) {
    sections.push(
      "SUCCESSES ON THIS EXACT GAP (it may already be resolved — verify the current " +
      "state first; if a residual remains, BUILD ON the landed approach, do not restart):\n" +
      same.map((w, i) => `${i + 1}. ${whyLine(w)}`).join("\n"));
  }
  if (ortho.length > 0) {
    sections.push(
      "SUCCESSES ON SIMILAR GAPS — other activities/vessels/resolvers with a similar trace " +
      "(learn the GENERAL winning shape; the approach below LANDED there, so prefer the same " +
      "shape here on the analogous target):\n" +
      ortho.map((w, i) => `${i + 1}. ${whyLine(w)}`).join("\n"));
  }
  if (recent.length > 0) {
    sections.push(
      "RECENT SUCCESSES (general context — approaches that landed lately):\n" +
      recent.map((w, i) => `${i + 1}. ${whyLine(w)}`).join("\n"));
  }
  const summary_text = sections.length > 0
    ? sections.join("\n\n") +
      "\n\nLesson: when a prior approach (here or on a similar trace) LANDED a concrete " +
      "single-file edit, reuse that SHAPE — name the analogous existing file and the same kind " +
      "of minimal, anchored change; do not re-explore an approach the substrate has already proven."
    : "No prior successful proposal attempts on record (same-scenario or similar). Draft a " +
      "concrete minimal anchored edit; it can become a reusable winning shape for future drafts.";

  return {
    shape: "priorSuccessfulAttempts",
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
