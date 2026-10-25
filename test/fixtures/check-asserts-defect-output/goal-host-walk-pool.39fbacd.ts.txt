/**
 * THE WALK'S POOL CARRIES DATA FLOW, NOT JUST SHAPE NAMES (agentic-floor B1/B2/B4).
 *
 * MEASURED (agentic-floor track B, node 1, 09-10 → 10-01): every pool impulse's `producedBy` was the
 * constant "goal-host-walk"; pool ids `walk-<shape>-<n>` came from a per-walk counter and collided
 * across walks; no consumed ids were recorded; walk composites declared POSITIONAL edges (step i
 * consumes step i-1, whatever was bound — 9/178 named a template id as an input shape); and the
 * llm/terminal satisfier declared every chain-produced shape consumed on the shape NAME alone, so
 * the stored 10-01 08:57–08:59Z rows say `web_search` fed a goal-only prompt (CONSUMPTION-EDGE-
 * ANALYSIS: "declare consumption ONLY where a step was actually bound").
 *
 * This module holds the pieces the walk needs to record what it actually did, as pure functions
 * the walk's closures call (so the binding rule is testable without booting the server).
 */

/** A pool impulse as the walk holds it (structurally the engine's Impulse). */
export interface PoolImpulseLike {
  id: string;
  metadata?: Record<string, unknown>;
  content?: unknown;
}

import { isProvenanceStub, JUDGE_EXCLUDED_SHAPES } from "./judge-view";
import { ANSWER_SHAPES } from "./reach-date";

// ── B4: declare consumption only when bound ────────────────────────────────────

/**
 * The findings block a deferred terminal write / an llm_completion synthesis binds, AND the shapes
 * it actually put into it. "" / [] when nothing was bound — which is every re-frame (no terminal
 * shapes) and every pool with no content-bearing intermediate. The shape list is the ONLY source of
 * a consumption edge for these satisfiers.
 */
export function findingsDigest(pool: readonly PoolImpulseLike[], terminalShapes: ReadonlySet<string>): { text: string; shapes: string[] } {
  if (terminalShapes.size === 0) return { text: "", shapes: [] };
  const parts: string[] = [];
  const shapes: string[] = [];
  for (const imp of pool) {
    const sh = (imp.metadata as { shape?: string } | undefined)?.shape;
    if (!sh || terminalShapes.has(sh) || sh === "goal") continue;
    let c: string;
    try { c = typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content, null, 2); }
    catch { c = String(imp.content); } if (c === undefined || c === null) c = "";
    if (!c || c.trim().length === 0 || c.trim() === "{}" || c.trim() === "[]") continue;
    parts.push(`## ${sh}\n\n\`\`\`json\n${c.slice(0, 8000)}\n\`\`\``);
    shapes.push(sh);
  }
  if (parts.length === 0) return { text: "", shapes: [] };
  return { text: `# Findings\n\n${parts.join("\n\n")}\n`, shapes };
}

/** The consumption a satisfier step declares: exactly the shapes its resolve BOUND, limited to
 *  shapes an earlier chain step produced (seeds and the step's own output never count). */
export function boundConsumption(bound: Iterable<string>, chainProduced: ReadonlySet<string>, satisfied: string, terminalShapes: ReadonlySet<string>): string[] {
  return [...new Set([...bound])].filter((s) => s !== "goal" && s !== satisfied && !terminalShapes.has(s) && chainProduced.has(s));
}

// ── B1: pool impulses carry their producer, the producing execution, and what they consumed ───

let poolImpulseSeq = 0;
/** Per-process nonce: a requeued dispatch keeps its dispatch id across a restart while the counter
 *  resets, so without it a restarted process re-mints ids the store already holds (qa). */
const BOOT_NONCE = Math.random().toString(36).slice(2, 8).padEnd(6, "0");

/** A short stable digest of the WHOLE dispatch id (FNV-1a): a prefix collapses ids that share one
 *  (`dispatch-drop-*` all became `dispatch`). */
function dispatchDigest(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, "0");
}

/** Pool impulse id, unique per dispatch, per process and per impulse:
 *  `walk-<boot>-<dispatch digest>-<shape>-<n>`. The old `walk-<shape>-<n>` restarted at 1 every walk,
 *  so two walks (or two retries inside one dispatch) minted the same id for different content. No
 *  reader parses the id; the extractor joins on it. */
export function poolImpulseId(dispatchId: unknown, shape: string): string {
  const d = typeof dispatchId === "string" && dispatchId ? dispatchDigest(dispatchId) : "nodisp";
  return `walk-${BOOT_NONCE}-${d}-${shape}-${++poolImpulseSeq}`;
}

/** Who put an impulse in the pool. `producedBy` is the real producer (`satisfier:<shape>`, a
 *  template id, `seed`), never the constant; the execution id and consumed ids are set when known. */
export interface PoolProvenance { producedBy: string; producerExecutionId?: string; consumedIds?: string[] }

/** The pool ids (first impulse per shape, the pool's first-wins rule) of the given shapes. */
export function poolIdsOf(pool: readonly PoolImpulseLike[], shapes: Iterable<string>): string[] {
  const want = new Set(shapes);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const imp of pool) {
    const sh = String((imp.metadata as { shape?: unknown } | undefined)?.shape ?? "");
    if (want.has(sh) && !seen.has(sh)) { seen.add(sh); out.push(imp.id); }
  }
  return out;
}

// ── B2: a composite's edges are the steps' recorded edges, not positions ────────────────

/** What one chain step bound and produced, recorded when the step ran. */
export interface StepEdge { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] }

/** Inputs a template step bound: its declared input shapes that the pool held before it ran. */
export function declaredBound(declaredInputs: readonly string[] | undefined, poolBefore: Iterable<string>): string[] {
  const have = new Set(poolBefore);
  return [...new Set((declaredInputs ?? []).filter((s) => s !== "goal" && have.has(s)))];
}

/** One step's edge record from the pool as it stands after the step. Output ids skip provenance
 *  stubs (`{producedBy, executionId}`): a template step that recovered no content produced no
 *  impulse a consumer could bind, so it contributes no output id — and so cannot count toward the
 *  composite's "≥ 2 tasks produced pool impulses" grounding on a stub. */
export function stepEdgeOf(pool: readonly PoolImpulseLike[], inputShapes: readonly string[], outputShapes: readonly string[]): StepEdge {
  return {
    inputShapes: [...inputShapes],
    inputImpulseIds: poolIdsOf(pool, inputShapes),
    outputShapes: [...outputShapes],
    outputImpulseIds: poolIdsOf(pool.filter((i) => !isProvenanceStub(i.content)), outputShapes),
  };
}

/** "≥ 2 tasks with real edges" (the slice's own criterion): some task consumed an impulse an EARLIER
 *  task of the same composite produced. Two output-bearing tasks with no such edge are two
 *  independent reads, not a recipe — they must not be minted as one. */
export function hasRealEdge(tasks: ReadonlyArray<{ inputImpulseIds?: readonly string[]; outputImpulseIds?: readonly string[] }>, firstNewStep = 0): boolean {
  // `firstNewStep`: steps before it were carried from a prior attempt (V8). An edge counts only when
  // its CONSUMER is a step this walk took — carried-to-carried edges were the prior attempt's.
  const produced = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    if (i >= firstNewStep && (t.inputImpulseIds ?? []).some((id) => produced.has(id))) return true;
    for (const id of t.outputImpulseIds ?? []) produced.add(id);
  }
  return false;
}

// ── V7 (output-shapes step 2): the LLM writer binds findings when there is no terminal ──────────

/**
 * The findings an llm_completion synthesis binds. With terminal shapes, exactly what a terminal write
 * binds (findingsDigest — unchanged). With NONE — every re-frame (388/388 passed no terminals), and
 * every walk once the dead `obsidian:write_note` terminal leaves the vocabulary — the writer itself
 * is the terminal, so the evidence already in the pool is bound instead of a goal-only prompt.
 * That new binding admits only shapes a chain step produced (never seeds), and no bookkeeping shapes
 * or provenance stubs (judge-view's exclusion set): `activity_template` catalogues and `error` rows
 * are not evidence.
 */
export function writerFindings(pool: readonly PoolImpulseLike[], terminalShapes: ReadonlySet<string>, writerShape: string, chainProduced: ReadonlySet<string> = new Set()): { text: string; shapes: string[] } {
  if (terminalShapes.size > 0) return findingsDigest(pool, terminalShapes);
  // Only what a step of THIS chain produced is evidence: seeds (operator, endpoints, a standing-pool
  // row the dispatch was handed) are context, not findings (qa probe bound all three).
  const evidence = pool.filter((imp) => {
    const sh = String((imp.metadata as { shape?: unknown } | undefined)?.shape ?? "");
    return chainProduced.has(sh) && !JUDGE_EXCLUDED_SHAPES.has(sh) && !isProvenanceStub(imp.content);
  });
  return findingsDigest(evidence, new Set([writerShape]));
}

/** The frame the no-terminal writer reads its evidence under: a neutral answer frame. The
 *  gap-clustering frame (7bbd7e8) stays on the terminal-bound path it was written for. */
export const WRITER_EVIDENCE_FRAME = "Produce the FINAL answer NOW as your ENTIRE response — the actual result the goal asks for, fully written out. Do NOT reply with a plan or an intention to act. Base it ONLY on the evidence below; do not invent facts, items or sources that are not in it, and name the source (URL or record) each point comes from.";

// ── V8: walks are additive — a retry or re-frame continues from the pool already built ───────────

/** One recorded step of a prior attempt, with the impulses it produced, carried into the next walk. */
export interface CarriedStep {
  stepId: string;
  executionId: string;
  inputShapes: string[];
  impulses: PoolImpulseLike[];
  /** Shapes of `impulses` that a later step of the prior attempt consumed (intermediates there). */
  consumedLater: string[];
}

/**
 * The prior attempt's SUCCESSFUL INTERMEDIATES, grouped by the step that produced them: impulses a
 * recorded step produced (they carry `producerExecutionId` — seeds, injected impulses and post-
 * verdict renders do not), minus what must be re-derived: the answer/terminal shapes the verdict was
 * about, bookkeeping shapes, provenance stubs, and whatever the caller excludes (a suppressed
 * satisfier's output). Ids are kept: within one dispatch it is the same impulse.
 */
/** Content that records a FAILURE, not a result: a non-zero exit, `success:false`/`ok:false`, or an
 *  error envelope with no payload. Carrying it forward would hand the retry a broken input as done. */
export function isFailedContent(c: unknown): boolean {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
  if (typeof o.exitCode === "number" && o.exitCode !== 0) return true;
  if (o.success === false || o.ok === false) return true;
  const hasPayload = ["content", "body", "stdout", "results", "value", "data"].some((k) => o[k] !== undefined && o[k] !== null && o[k] !== "");
  return typeof o.error === "string" && o.error.length > 0 && !hasPayload;
}

/**
 * `targets`: the walk's target shapes. A target is carried only when a later step of the prior
 * attempt CONSUMED it (it served as an intermediate, like the news goal's `web_search` feeding the
 * writer). An unconsumed target was the attempt's answer — the thing the verdict judged — so it is
 * re-derived; carrying it would make targetMet() true and the retry would never run (qa: a carried
 * target `shellResult` turned FEEDBACK-RETRY into a no-op for compute goals).
 */
export function carryForward(pool: readonly PoolImpulseLike[], rederive: ReadonlySet<string>, targets?: ReadonlySet<string>): CarriedStep[] {
  const shapeOfId = new Map<string, string>();
  for (const imp of pool) shapeOfId.set(imp.id, String((imp.metadata as { shape?: unknown } | undefined)?.shape ?? ""));
  const consumedShapes = new Set<string>();
  for (const imp of pool) {
    const ids = (imp.metadata as { consumedIds?: unknown } | undefined)?.consumedIds;
    if (Array.isArray(ids)) for (const id of ids) { const sh = shapeOfId.get(String(id)); if (sh) consumedShapes.add(sh); }
  }
  const steps = new Map<string, CarriedStep>();
  for (const imp of pool) {
    const m = (imp.metadata ?? {}) as { shape?: unknown; producedBy?: unknown; producerExecutionId?: unknown; consumedIds?: unknown };
    const shape = String(m.shape ?? "");
    const exec = typeof m.producerExecutionId === "string" ? m.producerExecutionId : "";
    const by = typeof m.producedBy === "string" ? m.producedBy : "";
    if (!shape || !exec || !by || by === "seed" || by === "goal-host-walk") continue;
    if (rederive.has(shape) || JUDGE_EXCLUDED_SHAPES.has(shape) || ANSWER_SHAPES.has(shape) || isProvenanceStub(imp.content)) continue;
    if (isFailedContent(imp.content)) continue;
    const key = `${by}\u0000${exec}`;
    let s = steps.get(key);
    if (!s) {
      const consumed = Array.isArray(m.consumedIds) ? (m.consumedIds as unknown[]).map(String) : [];
      s = { stepId: by, executionId: exec, inputShapes: [...new Set(consumed.map((id) => shapeOfId.get(id) ?? "").filter(Boolean))], impulses: [], consumedLater: [] };
      steps.set(key, s);
    }
    s.impulses.push(imp);
    if (consumedShapes.has(shape)) s.consumedLater.push(shape);
  }
  const all = [...steps.values()];
  return targets ? carryForTarget(all, targets) : all;
}

/**
 * The target rule, applied for the walk that RECEIVES the carry — its own target, not the target of
 * the attempt that produced it (qa7: a re-frame to [shellResult] was handed a shellResult that was
 * only an intermediate before, so targetMet() held at intake and nothing new ran). A shape that is a
 * target HERE is carried only if a later step consumed it in the prior attempt.
 */
export function carryForTarget(steps: readonly CarriedStep[], targets: ReadonlySet<string>): CarriedStep[] {
  return steps
    .map((s) => ({ ...s, impulses: s.impulses.filter((imp) => {
      const sh = String((imp.metadata as { shape?: unknown } | undefined)?.shape ?? "");
      return !targets.has(sh) || s.consumedLater.includes(sh);
    }) }))
    .filter((s) => s.impulses.length > 0);
}

// ── Acceptance fix 2: credit by involvement (APPROACH.md §9.3, the user's ruling) ───────────────

/** A write shape: its "success" is a claim about an effect somewhere else. */
export function isWriteShape(shape: string): boolean {
  return /_write$/.test(shape) || /(^|:)write_note$/.test(shape) || /^(fs_write|fs_edit|fileWriteResult|fileEditResult)$/.test(shape);
}

/**
 * The chain steps a reach credits: every step that produced a deliverable (the verdict's completion
 * shapes), and every step whose output reached one of those along a recorded edge (V4). Before this,
 * only the LAST pick was credited — on node 2 an empty "Untitled" panel write, while the
 * web_search → llm_completion steps that produced the report got nothing. With no recorded producer
 * of a deliverable, the last step stands in, as before. `uncreditable(i)` drops a step that must not
 * earn credit (a write whose effect was not independently read back); the walk still traverses
 * through it to the steps that fed it.
 */
export function involvedSteps(edges: ReadonlyArray<StepEdge | undefined>, deliverables: ReadonlySet<string>, uncreditable: (i: number) => boolean = () => false, isStub: (i: number) => boolean = () => false): number[] {
  // `isStub(i)`: the step produced only bookkeeping (a receipt, no payload — isBookkeepingOnly). It
  // is neither a deliverable producer nor the stand-in, and it earns nothing.
  const n = edges.length;
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) if (!isStub(i) && (edges[i]?.outputShapes ?? []).some((s) => deliverables.has(s))) seeds.push(i);
  if (seeds.length === 0) { for (let i = n - 1; i >= 0; i--) if (!isStub(i)) { seeds.push(i); break; } }
  const seen = new Set<number>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (const id of edges[i]?.inputImpulseIds ?? []) {
      for (let j = i - 1; j >= 0; j--) {
        if ((edges[j]?.outputImpulseIds ?? []).includes(id)) { if (!seen.has(j)) { seen.add(j); stack.push(j); } break; }
      }
    }
  }
  return [...seen].filter((i) => !uncreditable(i) && !isStub(i)).sort((a, b) => a - b);
}

// ── Culpability: β goes to the step that produced the judged artifact (2026-10-10) ─────────────

/**
 * The chain steps that PRODUCED the artifact a not-reached verdict judged — the mirror, on the failure side,
 * of involvedSteps' seeds. A step produced it when one of its outputs is a deliverable shape (the shapes the
 * judge view rendered as the deliverable, plus the verdict's completion shapes). A WRITE step (isWriteShape)
 * that consumed an earlier step's output along a recorded edge did not author what it wrote — it recorded
 * it — so the upstream producer(s) stand in for it (followed through further carrying writes). A stub
 * (bookkeeping-only output) produced nothing. No deliverable named ⇒ every shape a step produced counts.
 *
 * Measured 10-10 (24h): 180 of 208 β charged to a walk's last pick landed on a memoryNote_write /
 * substrateGap_write / activity_metrics satellite that recorded or followed the answer, never produced it.
 */
export function judgedArtifactProducers(edges: ReadonlyArray<StepEdge | undefined>, deliverables: ReadonlySet<string>, isStub: (i: number) => boolean = () => false): number[] {
  const n = edges.length;
  const judged = deliverables.size > 0 ? deliverables : new Set(edges.flatMap((e) => e?.outputShapes ?? []));
  const out = new Set<number>();
  const visit = (i: number, seen: Set<number>): void => {
    if (seen.has(i)) return;
    seen.add(i);
    const e = edges[i];
    const outs = e?.outputShapes ?? [];
    const carrying = outs.length > 0 && outs.every((s) => isWriteShape(s));
    if (carrying) {
      const upstream: number[] = [];
      for (const id of e?.inputImpulseIds ?? []) {
        for (let j = i - 1; j >= 0; j--) {
          if ((edges[j]?.outputImpulseIds ?? []).includes(id)) { upstream.push(j); break; }
        }
      }
      if (upstream.length > 0) { for (const j of upstream) visit(j, seen); return; }
    }
    if (!isStub(i)) out.add(i);
  };
  for (let i = 0; i < n; i++) {
    if (isStub(i)) continue;
    if ((edges[i]?.outputShapes ?? []).some((s) => judged.has(s))) visit(i, new Set());
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Is the walk's LAST step culpable for a not-reached verdict? Yes when it failed itself (its own failure is
 * its own), or when it is among judgedArtifactProducers. No producer identifiable ⇒ not culpable: an
 * unavailable observation never becomes a negative outcome, so β is withheld rather than guessed.
 */
export function lastStepCulpability(edges: ReadonlyArray<StepEdge | undefined>, deliverables: ReadonlySet<string>, lastStepFailed: boolean, isStub: (i: number) => boolean = () => false): { culpable: boolean; producers: number[] } {
  const producers = judgedArtifactProducers(edges, deliverables, isStub);
  return { culpable: lastStepFailed || producers.includes(edges.length - 1), producers };
}

/**
 * ONE CHAIN-CREDIT CARRIER PER FAILED SATISFIER-LAST WALK, AND EACH ANCESTOR CHARGED ONCE PER DISPATCH (OP-1).
 *
 * activity-api propagates a graded trace's outcome to every execution in its composition_chain at λ^depth. A
 * not-reached satisfier-last walk handed it TWO such traces: the durable last-step trace (chain = the steps
 * before it, graded at insert by its reached:false tag) and the failed composite (chain = every step). The
 * same ancestor was charged by both — λ from the first, λ² from the second: db_admin β moved in steps of
 * 0.96 = 0.6 + 0.36. And a retry in the same dispatch carries the prior attempt's steps into its own chain, so
 * its carrier charged them again for the same execution.
 *
 * The carrier is the trace that stands for the judged deliverable (OP-1 a): the durable trace when it is
 * graded (its last step produced the artifact, or failed itself); otherwise — β withheld from a last step that
 * did not produce it — the failed composite, whose consumed provenance charges the real producer. The other
 * trace carries no chain. Ancestors this dispatch already charged are dropped from the carrier's chain; a
 * retry's carried steps sit at the root end of its chain, so dropping them leaves every other depth unchanged.
 */
export function chainCarrierChains(input: {
  chainExecIds: readonly string[];
  durableChain: readonly string[];
  durableGraded: boolean;
  compositeRecorded: boolean;
  alreadyCharged: ReadonlySet<string>;
}): { carrier: "durable" | "composite" | "none"; durable: string[]; composite: string[]; charged: string[] } {
  const fresh = (ids: readonly string[]): string[] => ids.filter((id) => !input.alreadyCharged.has(id));
  if (input.durableGraded) {
    const durable = fresh(input.durableChain);
    return { carrier: "durable", durable, composite: [], charged: durable };
  }
  if (input.compositeRecorded) {
    const composite = fresh(input.chainExecIds);
    return { carrier: "composite", durable: [...input.durableChain], composite, charged: composite };
  }
  return { carrier: "none", durable: [...input.durableChain], composite: [], charged: [] };
}

// ── Acceptance fix 1: a re-frame that CARRIED its retrieval did retrieve ───────────────────────

/**
 * Did the walk retrieve anything THAT FED ITS ANSWER? The judge's completion shapes name the
 * deliverable, not the steps that fed it, so they miss a retrieval that only fed the answer — and
 * under V8 the retrieval can be a step CARRIED from the prior attempt (node 1, dispatch 1e3cd499: the
 * re-frame continued from satisfier:web_search, reached, and was rejected as "answered WITHOUT
 * retrieving anything"). `fedDeliverable` is the output shapes of the walk's involved steps
 * (involvedSteps: producers of the deliverable plus everything that fed them along recorded edges),
 * so a retrieval that ran but that nothing consumed does not count (qa9).
 */
export function walkRetrieved(completionShapes: readonly string[], fedDeliverable: readonly string[], retrievalEvidence: ReadonlySet<string>): boolean {
  return [...completionShapes, ...fedDeliverable].some((sh) => retrievalEvidence.has(String(sh)));
}

// ── Search provenance: a fetch of a URL a same-walk web search returned ─────────────────────────

/**
 * The user's ruling for development-vessel's `web_resource` trust gate (10-02): "allow any https URL
 * that a web_search in the same walk returned". The gate must VERIFY that, not take the caller's word
 * for it, so the walk passes a REFERENCE (`provenance: {dispatch_id, impulse_id}`) and the resolver
 * re-reads the referenced impulse from where it lives — this walk's pool, through `goalWalkState`
 * (index.ts, the `impulseId` read) — and checks the URL is among that impulse's results.
 *
 * Only an impulse a SEARCH SATISFIER put in the pool qualifies: a `poolImpulse_write` injection is
 * open to any authenticated caller and lands with producedBy "goal-host-walk" and no producing
 * execution, so a forged search result cannot vouch for a URL. development-vessel applies the same
 * predicate (web-resource.ts) when it verifies; this side only chooses which reference to send.
 */
export const SEARCH_RESULT_SHAPES: ReadonlySet<string> = new Set(["webSearchResult", "web_search"]);
export const SEARCH_PRODUCERS: ReadonlySet<string> = new Set(["satisfier:webSearchResult", "satisfier:web_search"]);
/** The fetch shapes that accept a search-provenance reference (http_response delegates to web_resource). */
export const PROVENANCE_FETCH_SHAPES: ReadonlySet<string> = new Set(["web_resource", "http_response"]);

/** The result URLs a search impulse's content carries (`results: [{title, url, snippet}]`), tolerating a JSON string body. */
export function searchResultUrls(content: unknown): string[] {
  let c: unknown = content;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return []; } }
  if (!c || typeof c !== "object") return [];
  const o = c as Record<string, unknown>;
  const results = Array.isArray(o["results"]) ? o["results"] : (o["body"] && typeof o["body"] === "object" ? (o["body"] as Record<string, unknown>)["results"] : undefined);
  if (!Array.isArray(results)) return [];
  return results.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)["url"] : undefined)).filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** True iff the impulse is a search result a search satisfier of this walk produced. */
export function isSatisfierSearchImpulse(imp: PoolImpulseLike): boolean {
  const m = (imp.metadata ?? {}) as { shape?: unknown; producedBy?: unknown; producerExecutionId?: unknown };
  return SEARCH_RESULT_SHAPES.has(String(m.shape ?? ""))
    && SEARCH_PRODUCERS.has(String(m.producedBy ?? ""))
    && typeof m.producerExecutionId === "string" && m.producerExecutionId.length > 0;
}

/** The pool id of the first satisfier-produced search impulse whose results contain `url`, else null. */
export function searchProvenanceFor(pool: readonly PoolImpulseLike[], url: string): string | null {
  if (typeof url !== "string" || !url) return null;
  for (const imp of pool) {
    if (isSatisfierSearchImpulse(imp) && searchResultUrls(imp.content).includes(url)) return imp.id;
  }
  return null;
}

/** One pool impulse in full, as `goalWalkState {impulseId}` serves it (the 2000-char preview cannot vouch for a URL past the cut). */
export function walkStateImpulse(pool: readonly PoolImpulseLike[] | undefined, impulseId: string): { id: string; shape: string | null; producedBy: string | null; producerExecutionId: string | null; content: unknown } | null {
  const imp = (pool ?? []).find((i) => i.id === impulseId);
  if (!imp) return null;
  const m = (imp.metadata ?? {}) as { shape?: unknown; producedBy?: unknown; producerExecutionId?: unknown };
  return {
    id: imp.id,
    shape: typeof m.shape === "string" ? m.shape : null,
    producedBy: typeof m.producedBy === "string" ? m.producedBy : null,
    producerExecutionId: typeof m.producerExecutionId === "string" ? m.producerExecutionId : null,
    content: imp.content,
  };
}

/**
 * The live pools by dispatch id, so `goalWalkState` can serve a search result in full. The walk's
 * pool is a closure local; the record mirrored onto executionStore holds only capped previews.
 * runGoalAsPoolWalk registers its pool at start and forgets it in its `finally`, so the map holds
 * RUNNING walks only. LIVE_POOL_CAP is a backstop far above walk concurrency, not the lifetime
 * mechanism: reaching it means a walk leaked its registration, and is logged.
 */
const LIVE_POOL_CAP = 256;
const livePools = new Map<string, readonly PoolImpulseLike[]>();
export function rememberLivePool(dispatchId: unknown, pool: readonly PoolImpulseLike[]): void {
  if (typeof dispatchId !== "string" || !dispatchId) return;
  livePools.delete(dispatchId);
  livePools.set(dispatchId, pool);
  while (livePools.size > LIVE_POOL_CAP) {
    const oldest = livePools.keys().next().value; if (oldest === undefined) break;
    livePools.delete(oldest);
    console.warn(`[walk-pool] live pool registry over ${LIVE_POOL_CAP}: evicted ${oldest} — a walk did not unregister its pool`);
  }
}
/** Called from the walk's `finally`: the pool stops being served the moment the walk ends. */
export function forgetLivePool(dispatchId: unknown): void {
  if (typeof dispatchId === "string") livePools.delete(dispatchId);
}
export function livePool(dispatchId: string): readonly PoolImpulseLike[] | undefined {
  return livePools.get(dispatchId);
}

// ── goalWalkOutput: one walk output's FULL content, read back by (dispatch id, pool id) ────────────

/**
 * goalWalkState's `poolProvenance[]` carries a 2000-char PREVIEW of each pool impulse (`contentPreview`, `chars`,
 * `truncated`), and the live pool is forgotten when the walk ends, so a finished run's output past the cut could not be
 * read by anyone (a surface drew a cut page as whole). The walk's state mirror now also keeps each output's content,
 * bounded, on the dispatch record beside the preview (`poolOutputs`, keyed by pool id), from the SAME serialized string
 * the preview is cut from, so `chars` agrees between the two reads. It lives exactly as long as the preview: pruneStore
 * clears both when it compacts a record, and both persist with the dispatch store.
 *
 * Two declared bounds, both reported (`chars` is always the full length, `truncated` says the kept text is shorter):
 * WALK_OUTPUT_CAP_CHARS per output, and WALK_OUTPUTS_RECORD_CAP_CHARS across one record's outputs in pool order, since
 * the whole dispatch store is rewritten every few seconds.
 */
export const WALK_OUTPUT_CAP_CHARS = 1_000_000;
export const WALK_OUTPUTS_RECORD_CAP_CHARS = 2_000_000;

/** One kept output: the text (a prefix when truncated), its full length, and whether it was a string or JSON. */
export interface WalkOutputText { text: string; chars: number; truncated: boolean; contentType: "text" | "json" }

/** A keeper for ONE mirror pass: each call keeps the next output in pool order, under both caps. */
export function walkOutputKeeper(): (serialized: string, isText: boolean) => WalkOutputText {
  let left = WALK_OUTPUTS_RECORD_CAP_CHARS;
  return (serialized, isText) => {
    const keep = Math.max(0, Math.min(serialized.length, WALK_OUTPUT_CAP_CHARS, left));
    left -= keep;
    return { text: keep === serialized.length ? serialized : serialized.slice(0, keep), chars: serialized.length, truncated: keep < serialized.length, contentType: isText ? "text" : "json" };
  };
}

/** What `goalWalkOutput {dispatchId, impulseId}` serves for one pool id of a dispatch record, or null when the record
 *  holds no such output (unknown id, or a record pruneStore compacted). An output with no content (the preview's
 *  `chars: 0` row) is served as empty text. A record mirrored before outputs were kept has only the preview: it is
 *  served as the preview, `truncated` when it is shorter than `chars`, so this read never denies an output
 *  goalWalkState lists. */
export function walkOutputOf(rec: { dispatchId: string; status?: unknown; poolProvenance?: unknown; poolOutputs?: unknown }, impulseId: string): {
  dispatchId: string; status: unknown; impulseId: string; shape: string | null; producedBy: string | null; producerExecutionId: string | null;
  contentType: "text" | "json" | null; content: string; chars: number; truncated: boolean;
} | null {
  const prov = Array.isArray(rec.poolProvenance) ? (rec.poolProvenance as Array<Record<string, unknown>>).find((p) => p && p["id"] === impulseId) : undefined;
  if (!prov) return null;
  const outputs = rec.poolOutputs && typeof rec.poolOutputs === "object" ? (rec.poolOutputs as Record<string, WalkOutputText | undefined>) : {};
  const kept = Object.prototype.hasOwnProperty.call(outputs, impulseId) ? outputs[impulseId] : undefined;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    dispatchId: rec.dispatchId,
    status: rec.status ?? null,
    impulseId,
    shape: str(prov["shape"]),
    producedBy: str(prov["producedBy"]),
    producerExecutionId: str(prov["producerExecutionId"]),
    ...(kept
      ? { contentType: kept.contentType, content: kept.text, chars: kept.chars, truncated: kept.truncated }
      : (() => {
          const preview = typeof prov["contentPreview"] === "string" ? prov["contentPreview"] : "";
          const chars = Math.max(preview.length, Number(prov["chars"] ?? 0) || 0);
          return { contentType: null, content: preview, chars, truncated: preview.length < chars };
        })()),
  };
}
