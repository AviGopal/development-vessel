import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * prior_failed_attempts — surface the substrate's RECENT FAILED proposal attempts
 * so the drafter can LEARN from them instead of re-drafting the same failing fix.
 *
 * WHY (2026-06-18): the gap-closing drafter (draft-gap-closing-activity) primes its
 * LLM on concept-db memory + co-occurrence edges + the scenario, but it has NO
 * visibility into which prior proposals FAILED to land and why. So it repeats the
 * same class of un-landable proposal — e.g. for the live TS2459 gap it kept
 * proposing "add export of WebSocketMessage to broadcaster" when broadcaster
 * IMPORTS (not declares) the symbol, so the patcher made no edit (no-op). The
 * landing rate stays flat because the drafter never sees its own failures.
 *
 * This resolver reads apply-proposal-as-patch's `.rejected/` audit trail (each
 * record carries `reason`, `missing[]`, and the proposal's `original_content_preview`)
 * and, when a scenario_id is given, prioritises records whose proposal text or
 * filename references that scenario. Returns a compact `summary_text` the drafter
 * injects into its draft prompt as "approaches that already failed — do not repeat".
 *
 * Tolerant by construction: missing `.rejected/` dir or malformed records yield an
 * empty (but valid) report, never an exception — a drafter run must not break
 * because the failure-history is absent.
 */
export interface PriorFailedAttemptsPointer {
  type: "prior_failed_attempts";
  /** Scenario being drafted; used to prioritise matching prior failures. Optional. */
  scenario_id?: string;
  /** Directory holding proposals + a `.rejected/` subdir. Default /workspace/proposals. */
  proposals_dir?: string;
  /** Max attempts to surface. Default 8. */
  limit?: number;
}

interface RejectedRecord {
  reason?: string;
  missing?: string[];
  rejected_at?: string;
  original_content_preview?: string;
}

interface Attempt {
  proposal: string;
  reason: string;
  missing: string[];
  prior_summary: string;
  rejected_at: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function extractPriorSummary(preview?: string): string {
  if (!preview) return "";
  const m = preview.match(/"summary"\s*:\s*"([^"]{0,180})/);
  return m?.[1] ?? "";
}

export async function resolvePriorFailedAttempts(
  pointer: PriorFailedAttemptsPointer,
): Promise<ResolverResult> {
  const proposalsDir = pointer.proposals_dir ?? "/workspace/proposals";
  const rejectedDir = join(proposalsDir, ".rejected");
  const scenarioId = (pointer.scenario_id ?? "").trim();
  const sn = scenarioId ? norm(scenarioId).slice(0, 40) : "";
  const limit = Math.max(1, pointer.limit ?? 8);

  const all: Array<Attempt & { _mtime: number; _matchesScenario: boolean }> = [];
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
        const hay = `${norm(f)} ${norm(prior)} ${(rec.missing ?? []).map(norm).join(" ")}`;
        all.push({
          proposal: f,
          reason: rec.reason ?? "unknown",
          missing: rec.missing ?? [],
          prior_summary: prior,
          rejected_at: rec.rejected_at ?? "",
          _mtime: mtime,
          _matchesScenario: sn.length > 0 && hay.includes(sn),
        });
      } catch { /* skip malformed record */ }
    }
  } catch { /* .rejected absent -> no history */ }

  // Scenario-matching records first, then most-recent. Cap at limit.
  all.sort((a, b) => (Number(b._matchesScenario) - Number(a._matchesScenario)) || (b._mtime - a._mtime));
  const attempts: Attempt[] = all.slice(0, limit).map(({ _mtime, _matchesScenario, ...a }) => a);

  const summary_text = attempts.length === 0
    ? "No prior failed proposal attempts on record. Draft freely, but still name a CONCRETE, EXISTING target file and a precise minimal edit."
    : "PRIOR FAILED ATTEMPTS (do NOT repeat these — they were drafted and did not land):\n" +
      attempts.map((a, i) => {
        const why = a.reason === "file_path_hallucination"
          ? `targeted NON-EXISTENT file(s) ${a.missing.join(", ")} — pick a file that actually exists`
          : a.reason === "patch_noop"
          ? "the patcher made NO edit (the proposed change was not actually present in the target file, the target file was wrong, or the change needs no edit) — re-examine the file/symbol and propose a concrete change that is genuinely present and needed"
          : a.reason === "patch_typecheck_fail"
          ? "the patch broke typecheck on the target — the proposed edit was wrong; propose a change that compiles"
          : `rejected as ${a.reason}`;
        return `${i + 1}. ${why}.` + (a.prior_summary ? ` Prior (failed) approach: "${a.prior_summary}".` : "");
      }).join("\n") +
      "\nLesson: before proposing an edit to a file, ensure the file EXISTS and that the symbol/change you describe is actually present there; if a prior approach targeted the wrong file or a symbol that is imported-not-declared, target the CONSUMER or the real declaring module instead.";

  return {
    shape: "priorFailedAttempts",
    body: { scenario_id: scenarioId, count: attempts.length, attempts, summary_text },
  };
}
