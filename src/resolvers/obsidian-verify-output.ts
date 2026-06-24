import type { ResolverResult } from "./types.js";

/**
 * obsidian_verify_output (2026-06-15) — INDEPENDENT output verification.
 *
 * "It's easy to hallucinate to ourselves." An activity reporting status:completed
 * proves nothing — the writer's own success flag is not independent evidence. This
 * resolver re-derives whether a claimed vault output ACTUALLY EXISTS and is REAL,
 * by reading it back through obsidian-vessel (a different vessel than whatever
 * dispatched the work) and applying SEVERAL INDEPENDENT constraints. Each
 * constraint can fail on its own; the verdict requires ALL of them. Stacking
 * independent constraints is how uncertainty drops — one check can be fooled, the
 * conjunction is hard to fool by accident.
 *
 * Constraints (each independent, each cheap/deterministic):
 *   1. exists        — obsidian-vessel returns the note (independent of the writer).
 *   2. not_stub      — content length >= minChars (a 50-byte placeholder is not output).
 *   3. not_hedge     — content does NOT read as a self-undermining non-answer
 *                      ("I need more data", "please provide", "I cannot", "no content"
 *                      …). This is the exact failure that slipped through this session:
 *                      a note that "completed" while actually refusing to do the work.
 *   4. on_topic      — the request's significant terms actually appear in the output
 *                      (a note about something else is not this goal's output).
 *
 * verified = exists ∧ not_stub ∧ not_hedge ∧ on_topic. Read-only.
 */

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

// Self-undermining phrases: if the output leans on these, the activity produced a
// non-answer (hallucinated completion), not the expected artifact.
const HEDGE_PATTERNS = [
  "i need more", "please provide", "i don't have access", "i do not have access",
  "no content", "not include the actual", "metadata only",
  "unable to", "i apologize", "as an ai", "limitation with the provided",
  "share the expanded", "provide the full", "provide more", "i'm not able to",
  "cannot generate", "can't generate", "insufficient data", "to proceed",
];

export interface ObsidianVerifyOutputPointer {
  type: "obsidian_verify_output";
  /** Vault path the activity claims it produced. */
  path: string;
  /** The request/goal text — used for the on-topic constraint. */
  request?: string;
  obsidianEndpoint?: string;
  apiKey?: string;
  minChars?: number;
  /** Min fraction of significant request terms that must appear in the output. */
  minTermOverlap?: number;
  /**
   * When true (the in-activity default an author should set), an UNVERIFIED output
   * returns a structuredError shape — so the goal-host dev-vessel proxy throws and
   * the engine records the activity as FAILED. This is what makes the substrate
   * stop crediting hallucinated completions: a verify task that fails closed turns
   * "I reported success" into "the output independently checked out, or I failed".
   * Default false so standalone probing returns the verdict body instead of throwing.
   */
  strict?: boolean;
  timeoutMs?: number;
}

const STOPWORDS = new Set(["the","a","an","my","your","into","of","and","to","for","with","from","that","this","what","i","me","we","in","on","by","as","is","are","be","please","substrate","note","obsidian"]);

function significantTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w)))];
}

export async function resolveObsidianVerifyOutput(
  pointer: ObsidianVerifyOutputPointer,
): Promise<ResolverResult> {
  const obsidian = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const path = pointer.path;
  const request = pointer.request ?? "";
  const minChars = pointer.minChars ?? 200;
  const minTermOverlap = pointer.minTermOverlap ?? 0.34;
  const timeoutMs = pointer.timeoutMs ?? 8_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) };

  if (!apiKey) return { shape: "obsidianOutputVerification", body: { verified: false, error: "missing_api_key" } };
  if (!path) return { shape: "obsidianOutputVerification", body: { verified: false, error: "missing_path" } };

  // CONSTRAINT 1 (exists): read the note back through obsidian-vessel.
  let content = "";
  let exists = false;
  try {
    const res = await fetch(`${obsidian}/resolve`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { success?: boolean; content?: string };
    exists = json.success === true && typeof json.content === "string" && json.content.length > 0;
    content = json.content ?? "";
  } catch (err) {
    return { shape: "obsidianOutputVerification", body: { verified: false, unreachable: true, path, detail: err instanceof Error ? err.message.slice(0, 120) : "err", generated_at: generatedAt } };
  }

  // CONSTRAINT 2 (not_stub): substantive length.
  const trimmed = content.trim();
  const not_stub = trimmed.length >= minChars;

  // CONSTRAINT 3 (not_hedge): not a self-undermining non-answer. A real non-answer
  // LEADS with the hedge (it's the point of the note) or REPEATS it — a single
  // incidental "can't" in otherwise-substantive prose is not a non-answer. So
  // disqualify only when a hedge appears EARLY (first 300 chars) or is REPEATED
  // (≥2 distinct phrases). This avoids false-rejecting legitimate notes.
  const lower = trimmed.toLowerCase();
  const head = lower.slice(0, 300);
  const hedgeHits = HEDGE_PATTERNS.filter((p) => lower.includes(p));
  const earlyHedge = HEDGE_PATTERNS.some((p) => head.includes(p));
  const not_hedge = !earlyHedge && hedgeHits.length < 2;

  // CONSTRAINT 4 (on_topic): request's significant terms appear in the output.
  const terms = significantTerms(request);
  let termOverlap = 1;
  let matchedTerms: string[] = [];
  if (terms.length > 0) {
    matchedTerms = terms.filter((t) => lower.includes(t));
    termOverlap = matchedTerms.length / terms.length;
  }
  const on_topic = terms.length === 0 ? true : termOverlap >= minTermOverlap;

  const verified = exists && not_stub && not_hedge && on_topic;
  const failed: string[] = [];
  if (!exists) failed.push("exists");
  if (!not_stub) failed.push(`not_stub(len=${trimmed.length}<${minChars})`);
  if (!not_hedge) failed.push(`not_hedge(${hedgeHits.slice(0, 3).join("|")})`);
  if (!on_topic) failed.push(`on_topic(overlap=${(termOverlap * 100).toFixed(0)}%<${(minTermOverlap * 100).toFixed(0)}%)`);

  // Fail-closed for in-activity use: an unverified output becomes a structuredError
  // so the dispatching proxy throws and the engine records the activity as FAILED —
  // the learning loop then penalises (not credits) the hallucinated completion.
  if (!verified && (pointer.strict ?? false)) {
    return {
      shape: "structuredError",
      body: {
        failure_mode: "verifier_negative",
        status: 422,
        detail: `obsidian_verify_output: ${path} did not independently verify — failed [${failed.join(", ")}]`,
        failed_constraints: failed,
        constraints: { exists, not_stub, not_hedge, on_topic },
        path,
        generated_at: generatedAt,
      },
    };
  }

  return {
    shape: "obsidianOutputVerification",
    body: {
      verified,
      path,
      constraints: { exists, not_stub, not_hedge, on_topic },
      failed_constraints: failed,
      content_chars: trimmed.length,
      hedge_hits: hedgeHits,
      term_overlap: Number(termOverlap.toFixed(2)),
      matched_terms: matchedTerms.slice(0, 8),
      reason: verified
        ? `independently verified: note exists (${trimmed.length} chars), substantive, no hedge, ${(termOverlap * 100).toFixed(0)}% on-topic`
        : `NOT verified — failed [${failed.join(", ")}]; the activity reported success but the output does not independently check out (likely hallucinated completion)`,
      generated_at: generatedAt,
    },
  };
}
