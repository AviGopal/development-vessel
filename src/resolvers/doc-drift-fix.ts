import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import { resolveApplyProposalAsPatch } from "./apply-proposal-as-patch.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";

/**
 * doc_drift_fix — CLOSURE authoring for documentation-as-expectation.
 *
 * A `documentation_drift` gap (emitted by docs-align-scan) carries a grounded drift_report:
 * the specific doc sentences a landed code change FALSIFIED. This resolver closes the loop:
 * draft the MINIMAL edit that removes/corrects exactly those claims, then GATE it with a
 * prose reach-gate — the doc analogue of goal-host's verifyGoalReached — that verifies the
 * REVISED doc no longer asserts the falsified claims AND did not falsify a previously-true
 * one (regression check). Prose has no typecheck backstop (feature_compose's typecheck→
 * rollback gate is a no-op for a .md edit), so the reach-gate IS the gate.
 *
 * We do NOT route prose through feature_compose (it grounds/verifies .ts only). We author the
 * edit here and reuse the PROVEN apply_proposal_as_patch → mitosis-cutover land primitive.
 *
 * AUTONOMY (staged, safe-by-default): DOC_FIX_AUTOLAND is OFF by default → TRIAGE mode: the
 * reach-gated proposed edit is RECORDED on the gap (classification_metadata.doc_fix) and the
 * gap stays open for review; nothing is pushed. Set DOC_FIX_AUTOLAND=1 to let a FAVORABLE fix
 * land autonomously via apply_proposal_as_patch (the operator flips this once reach-gate
 * precision is trusted; per the plan's cautious-start guidance). LLM work is dispatched to the
 * llm_completion resolver (never an inline SDK call), per dev-vessel discipline.
 *
 * Reach-gate UNFAVORABLE → the gap's failed_attempts is bumped so the landability picker
 * deprioritizes it (anti-thrash), mirroring gap-to-feature's bumpFailedAttempts.
 */

const DOC_ROOT = process.env.DOC_FIX_ROOT ?? "/workspace/git/super-repo";
const PROPOSALS_DIR = process.env.PROPOSALS_DIR ?? "/workspace/proposals";
const AUTOLAND = process.env.DOC_FIX_AUTOLAND === "1";
const LLM_MODEL = process.env.DOC_FIX_MODEL ?? "anthropic/claude-haiku-4-5";
const DOC_BUDGET = 9000;

export interface DocDriftFixPointer {
  type: "doc_drift_fix";
  gap_id?: string;
  dry_run?: boolean;
}

interface DriftClaim { quote: string; contradicted_by?: string; correction_hint?: string; }
interface Edit { old_string: string; new_string: string; }
interface ReachVerdict { reached: boolean; unresolved: string[]; regression: boolean; reason?: string; }

const report = (body: Record<string, unknown>): ResolverResult => ({ shape: "docDriftFixReport", body });

/** Dispatch a prompt to the llm_completion resolver (discovered via discovery). Returns text. */
async function llm(prompt: string, maxTokens: number): Promise<string | null> {
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!dr.ok) return null;
    const dd = (await dr.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> } };
    const best = (dd.content?.vessels ?? [])[0];
    if (!best) return null;
    const ep0 = best.resolve_endpoint ?? "/resolve";
    const endpoint = ep0.startsWith("http") ? ep0 : `${best.endpoint.replace(/\/$/, "")}${ep0.startsWith("/") ? ep0 : `/${ep0}`}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: LLM_MODEL, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    return String(j.content ?? j.data ?? "").trim() || null;
  } catch {
    return null;
  }
}

/** Extract the first JSON object/array from an LLM response tolerant of fences/prose. */
export function parseJson<T>(text: string): T | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start < 0 || end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)) as T; } catch { return null; }
}

/** Apply old->new string edits to a doc. Reports which anchored and which missed. */
export function applyEdits(text: string, edits: Edit[]): { text: string; applied: Edit[]; missed: Edit[] } {
  let out = text;
  const applied: Edit[] = [];
  const missed: Edit[] = [];
  for (const e of edits) {
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string" || !e.old_string) { missed.push(e); continue; }
    if (out.includes(e.old_string)) { out = out.replace(e.old_string, e.new_string); applied.push(e); }
    else missed.push(e);
  }
  return { text: out, applied, missed };
}

async function draftEdits(docPath: string, docText: string, claims: DriftClaim[], humanDecision?: string): Promise<Edit[]> {
  const claimList = claims.map((c, i) => `${i + 1}. FALSIFIED CLAIM: "${c.quote}"\n   contradicted by: ${c.contradicted_by ?? "(recent code change)"}\n   fix hint: ${c.correction_hint ?? "(correct to match current reality)"}`).join("\n") + (humanDecision ? `\n\nOPERATOR DECISION (authoritative — follow it over the hints above): ${humanDecision}` : "");
  const prompt =
    `You correct a documentation file so it matches the current code. Below is the doc and a list ` +
    `of specific sentences a code change FALSIFIED. Produce the SMALLEST set of edits that removes/` +
    `corrects EXACTLY those falsified claims — change nothing else, do not rewrite surrounding prose, ` +
    `do not fix unrelated issues. Each edit is an EXACT substring replacement: old_string must appear ` +
    `VERBATIM in the doc (copy it exactly, including whitespace) and new_string is the corrected text.\n\n` +
    `DOC: ${docPath}\n----- DOC TEXT -----\n${docText.slice(0, DOC_BUDGET)}\n----- FALSIFIED CLAIMS -----\n${claimList}\n\n` +
    `Respond with STRICT JSON only: {"edits":[{"old_string":"<verbatim>","new_string":"<corrected>"}]}`;
  const raw = await llm(prompt, 1400);
  if (!raw) return [];
  const parsed = parseJson<{ edits?: Edit[] }>(raw);
  return Array.isArray(parsed?.edits) ? parsed!.edits!.filter((e) => e && typeof e.old_string === "string" && typeof e.new_string === "string") : [];
}

export async function reachGate(docPath: string, revised: string, claims: DriftClaim[]): Promise<ReachVerdict | null> {
  const claimList = claims.map((c, i) => `${i + 1}. "${c.quote}"`).join("\n");
  const prompt =
    `You verify a documentation fix. Here is the REVISED doc and the list of claims that were ` +
    `previously FALSE (asserted something the code no longer does). Decide: (a) does the revised doc ` +
    `NO LONGER assert each false claim (resolved), and (b) did the edit introduce a REGRESSION — ` +
    `falsify something that was previously TRUE or leave the doc self-contradictory?\n\n` +
    `DOC: ${docPath}\n----- REVISED DOC -----\n${revised.slice(0, DOC_BUDGET)}\n----- CLAIMS THAT MUST BE RESOLVED -----\n${claimList}\n\n` +
    `Respond with STRICT JSON only: {"reached": boolean, "unresolved": ["<claim still asserted>"], "regression": boolean, "reason": "<one sentence>"}`;
  const raw = await llm(prompt, 500);
  if (!raw) return null;
  const v = parseJson<ReachVerdict>(raw);
  if (!v || typeof v.reached !== "boolean") return null;
  v.unresolved = Array.isArray(v.unresolved) ? v.unresolved.map(String) : [];
  v.regression = Boolean(v.regression);
  return v;
}

/** Upsert the gap with merged metadata + status (best-effort). */
async function upsertGap(gap: Record<string, unknown>, metaPatch: Record<string, unknown>, status: string): Promise<void> {
  try {
    const meta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), ...metaPatch };
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { id: gap.id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at, classification_metadata: meta, status },
    } as never);
  } catch { /* best-effort */ }
}

export async function resolveDocDriftFix(pointer: DocDriftFixPointer): Promise<ResolverResult> {
  // 1. Select the target documentation_drift gap.
  let gap: Record<string, unknown> | null = null;
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      ...(pointer.gap_id ? { id: pointer.gap_id } : {}),
      category: "documentation_drift",
      status: "open",
      limit: pointer.gap_id ? 1 : 50,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    gap = pointer.gap_id ? gaps.find((g) => g.id === pointer.gap_id) ?? gaps[0] ?? null : gaps[0] ?? null;
  } catch (e) {
    return report({ ok: false, stage: "select", error: (e as Error).message });
  }
  if (!gap) return report({ ok: false, stage: "select", error: "no open documentation_drift gap" });

  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const docPath = String(meta.doc_path ?? meta.file_path ?? "");
  const claims = ((meta.drift_report as { claims?: DriftClaim[] } | undefined)?.claims ?? []).filter((c) => c && typeof c.quote === "string");
  if (!docPath || claims.length === 0) return report({ ok: false, stage: "read", gap_id: gap.id, error: "gap missing doc_path or drift_report.claims" });

  let docText = "";
  try { docText = readFileSync(join(DOC_ROOT, docPath), "utf8"); } catch (e) {
    return report({ ok: false, stage: "read", gap_id: gap.id, error: `cannot read ${join(DOC_ROOT, docPath)}: ${(e as Error).message}` });
  }

  // 2. Draft the minimal edit.
  const humanDecision = typeof meta.human_decision === "string" ? meta.human_decision : undefined;
  const edits = pointer.dry_run ? [] : await draftEdits(docPath, docText, claims, humanDecision);
  if (!pointer.dry_run && edits.length === 0) {
    await upsertGap(gap, { doc_fix: { status: "draft_failed", at: new Date().toISOString() }, failed_attempts: Number(meta.failed_attempts ?? 0) + 1 }, "open");
    return report({ ok: false, stage: "draft", gap_id: gap.id, error: "llm produced no usable edits" });
  }
  if (pointer.dry_run) {
    return report({ ok: true, stage: "plan", verdict: "plan", gap_id: gap.id, doc_path: docPath, claims: claims.length,
      note: `plan: would draft a minimal edit for ${claims.length} falsified claim(s) in ${docPath}, reach-gate it, and ${AUTOLAND ? "land via apply_proposal_as_patch" : "record it on the gap (triage; DOC_FIX_AUTOLAND off)"}` });
  }

  // 3. Apply to a scratch copy; an edit whose old_string does not anchor is dropped.
  const { text: revised, applied, missed } = applyEdits(docText, edits);
  if (applied.length === 0) {
    await upsertGap(gap, { doc_fix: { status: "no_anchor", missed: missed.length, at: new Date().toISOString() }, failed_attempts: Number(meta.failed_attempts ?? 0) + 1 }, "open");
    return report({ ok: false, stage: "apply", gap_id: gap.id, error: "no edit anchored in the doc (old_string not found)", missed: missed.length });
  }

  // 4. PROSE REACH-GATE — the doc analogue of verifyGoalReached; the only backstop for prose.
  const verdict = await reachGate(docPath, revised, claims);
  const favorable = !!verdict && verdict.reached && !verdict.regression;
  if (!favorable) {
    await upsertGap(gap, {
      doc_fix: { status: "reach_unfavorable", reason: verdict?.reason ?? "no verdict", unresolved: verdict?.unresolved ?? null, regression: verdict?.regression ?? null, at: new Date().toISOString() },
      failed_attempts: Number(meta.failed_attempts ?? 0) + 1,
    }, "open");
    return report({ ok: false, stage: "reach_gate", verdict: "UNFAVORABLE", gap_id: gap.id, doc_path: docPath, reach: verdict, applied: applied.length });
  }

  // 5. FAVORABLE. Always record the verified proposal on the gap (triage visibility).
  const editPreview = applied.map((e) => `- ${JSON.stringify(e.old_string.slice(0, 80))} -> ${JSON.stringify(e.new_string.slice(0, 80))}`).join("\n");
  await upsertGap(gap, { doc_fix: { status: AUTOLAND ? "landing" : "proposed", verdict: "FAVORABLE", edits: applied, edit_count: applied.length, reach_reason: verdict!.reason ?? null, at: new Date().toISOString() } }, "open");

  if (!AUTOLAND) {
    // TRIAGE (default): closure verified, held for review. No push.
    return report({ ok: true, stage: "triage", verdict: "FAVORABLE", gap_id: gap.id, doc_path: docPath,
      edits: applied.length, missed: missed.length, reach: verdict,
      note: `reach-gated fix RECORDED on gap (${applied.length} edit(s)); not landed (DOC_FIX_AUTOLAND off). Edits:\n${editPreview}` });
  }

  // 6. AUTOLAND (opt-in, experimental for super-repo doc paths): reuse the proven
  // apply_proposal_as_patch → mitosis-cutover primitive. Persist an anchored proposal
  // (required_code_modifications carry old_string as the concrete anchor), then apply.
  const proposalId = `docdrift-${String(gap.id).replace(/[^a-z0-9_-]/gi, "-")}`;
  const proposal = {
    summary: `Documentation drift fix for ${docPath}: correct ${applied.length} falsified claim(s).`,
    required_code_modifications: applied.map((e) => ({
      file: docPath,
      anchor: e.old_string.slice(0, 400),
      change: `replace the falsified text with: ${e.new_string.slice(0, 400)}`,
      old_string: e.old_string,
      new_string: e.new_string,
    })),
  };
  try {
    writeFileSync(join(PROPOSALS_DIR, `${proposalId}-report.json`), JSON.stringify(proposal, null, 2));
  } catch (e) {
    return report({ ok: false, stage: "autoland_persist", gap_id: gap.id, error: (e as Error).message });
  }
  const applyRes = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposal_id: proposalId } as never);
  const applyBody = (applyRes?.body ?? {}) as Record<string, unknown>;
  const pushed = applyBody.push_status === "pushed" || (applyBody.result as Record<string, unknown> | undefined)?.push_status === "pushed";
  if (pushed) await upsertGap(gap, { doc_fix: { status: "landed", at: new Date().toISOString() }, resolution: "landed via mitosis cutover (doc_drift_fix)" }, "closed");
  return report({ ok: applyRes?.shape !== "structuredError" && applyBody.ok !== false, stage: "autoland", verdict: "FAVORABLE",
    gap_id: gap.id, doc_path: docPath, edits: applied.length, proposal_id: proposalId, apply: applyBody, landed: !!pushed });
}
