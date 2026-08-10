/**
 * patch_with_tools — ReAct-style LLM patcher (V36, 2026-06-10).
 *
 * Replaces the monolithic apply-proposal-as-patch LLM block. The LLM no longer
 * free-styles search/replace JSON against a hallucinated copy of the source.
 * Instead it iterates over a fixed tool catalog (local-tools-vessel resolvers),
 * inspecting the live file with each tool call and composing a verifiable
 * mutation sequence.
 *
 * Tools available:
 *   - code_search(path, pattern, flags?)
 *   - code_find_function(path, name)
 *   - code_find_import(path, module)
 *   - code_insert_after_line(path, after_line, text)
 *   - code_replace_lines(path, start_line, end_line, text)
 *   - code_add_import(path, module, specifier)
 *   - code_verify_typecheck(cwd, script?)
 *
 * Each call is dispatched to local-tools-vessel via discovery. The full
 * plan + per-step results is recorded so Thompson learning can generalise.
 *
 * Returns mitosisStaged when the LLM declares done AND the live file changed
 * AND optional verification passes. Returns structuredError on iteration cap
 * or LLM failure (with the plan-so-far for post-mortem).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";
import { resolveVesselMitosisCutover } from "./vessel-mitosis-cutover.js";
import { staticEvaluate } from "./vessel-mitosis-evaluate.js";
import { noProgressStreak } from "./no-progress-streak.js";

const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
// Federation-transport egress (dev-vessel has no libp2p deps). Mirrors feature-compose /
// goal-host FED_TRANSPORT_EGRESS — the by-name egress path proven to serve llm_completion.
const FED_TRANSPORT_EGRESS = process.env.FED_TRANSPORT_EGRESS ?? "http://127.0.0.1:8401";
// V38 (2026-06-12): 8 was too tight — non-trivial single-file patches spend
// turns on search→edit→re-search-to-verify and hit the cap before declaring
// done (observed: code_replace_lines applied on turns 4-5, capped at 8 mid-verify).
// 16 gives headroom for inspect+edit+verify without unbounding cost.
const MAX_ITERATIONS = 30; // 2026-06-17: 16 capped mid-search (no_op); 30 is the memory-confirmed converging budget
const PER_CALL_TIMEOUT_MS = 60_000;

// Transient transport errors (the relay reservation self-heals at ~0.5 TTL, so a
// 502 / NO_RESERVATION during that window is momentary, NOT provider exhaustion).
// Retry the SAME endpoint a few times with backoff before cascading to another
// producer/model — otherwise a self-healing blip needlessly abandons a funded arm.
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_BACKOFF_MS = 750;
function isTransientTransportError(msg: string): boolean {
  return /NO_RESERVATION|no reservation|fetch 50[234]|p2p-circuit|circuit|relay|dial(?:ed)? failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

function isSemanticReject(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'type' in e && (e as { type?: string }).type === 'semantic_reject';
}

async function retryWithBackoff<T>(fn: () => Promise<T>, predicate: (e: unknown) => boolean): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= MAX_TRANSIENT_RETRIES) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // Retry on transient transport errors OR syntax_break failures OR semantic_reject failures
      const shouldRetry = predicate(e) || isTransientTransportError(String(e)) || (typeof e === 'object' && e !== null && 'type' in e && (e as { type?: string }).type === 'syntax_break') || isSemanticReject(e);
      if (!shouldRetry) throw e;
      attempt++
      if (attempt <= MAX_TRANSIENT_RETRIES) {
        await new Promise((r) => setTimeout(r, TRANSIENT_BACKOFF_MS * attempt));
      }
    }
  }
  throw lastError;
}

export interface PatchWithToolsPointer {
  type: "patch_with_tools";
  proposal_text: string; // sanitized proposal description (no code blocks)
  target_file: string; // repos/<vessel>/<subpath>
  /**
   * The region a gap names (a CSS class / marker the renderer emits). When present —
   * threaded explicitly, or recovered from the proposal's canonical
   * `in the region "<x>"` phrasing — the staged patch must be causally connected to
   * it or staging is refused. Absent → no location gate, as for any non-region gap.
   */
  region?: string;
  vessels_root?: string;
  workspace_root?: string;
  model?: string;
  max_iterations?: number;
  /** Bounded outer-retry attempts (default 3); resets to original between tries. */
  max_attempts?: number;
  /**
   * Seam ③ (net-new resolver authoring, 2026-06-19). When set, the target is a
   * NET-NEW file that must NOT already exist: the patcher authors its full
   * contents with a single fs_write rather than READ→fs_edit. The "live source
   * missing" guard is tolerated (absence is expected); a pre-existing target is
   * rejected. Per-attempt reset / fail-restore UNLINKS the file (writing "" back
   * leaves a stub that poisons the next attempt's existence check).
   */
  is_new_file?: boolean;
  /** Provenance threaded to the cutover's missing-provenance guard. */
  gap_id?: string;
  proposal_id?: string;
}

type ToolCall = { tool: string; args: Record<string, unknown> };
type ToolResult = { tool: string; args: Record<string, unknown>; result: unknown; ok: boolean };

function structuredError(detail: string, body: Record<string, unknown> = {}): ResolverResult {
  // V38 (2026-06-12): log every failure. Previously patch_with_tools failed
  // SILENTLY — the apply trace recorded error=null/failure_mode=null and only a
  // .applied sentinel's outcome_shape=structuredError survived, making the
  // cutover leg undebuggable. Surface the detail so the failure mode is
  // trace-inspectable, not opaque.
  console.error(`[patch-with-tools] FAIL: ${detail}`);
  return { shape: "structuredError", body: { resolver: "patch_with_tools", detail, ...body } };
}

// Fire mitosis-tick (evaluate→cutover) immediately after staging so a clean
// patch_with_tools patch does not STRAND. Previously patch_with_tools staged +
// wrote mitosis-pending.json but never triggered the cutover, and the goal-host
// escalation returned reached:true without dispatching vessel_mitosis_cutover —
// so a correct, typecheck-clean staged patch could sit unlanded indefinitely
// (the reach-on-rolled-back / staged-but-unlanded half of the cutover-reliability
// defect). Best-effort: if dispatch fails, boredom selects mitosis-tick later.
type MitosisLanding = { landed: boolean; new_git_sha: string | null; push_status: string | null };

/**
 * Resolve the vessel's ACTUAL check script for the landing gate. The gate previously
 * hard-defaulted staticEvaluate to `["lint"]`, but goal-host-vessel (and others) define
 * only `typecheck` — so `bun run lint` printed `Script not found "lint"` and exited
 * non-zero with NO `error TS` output. staticEvaluate then compared two EMPTY signature
 * sets (overlay vs base), found new=0, and delta-excused a tree it had NEVER TYPECHECKED
 * — the exact hole that let two broken commits (TS2451 redeclare, TS2345 cross-file async)
 * self-land. Prefer `lint` (superset: tsc + shape-dispatch check) then `typecheck`, and
 * return the FIRST that exists in the vessel's package.json. When neither exists, return
 * the preferred name anyway so staticEvaluate's script-missing guard FAILS CLOSED (refuse)
 * rather than silently skipping verification.
 */
async function resolveCheckScripts(vesselDir: string): Promise<string[]> {
  try {
    const pkgRaw = await readFile(join(vesselDir, "package.json"), "utf-8");
    const scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {};
    for (const name of ["lint", "typecheck"]) {
      if (typeof scripts[name] === "string" && scripts[name]) return [name];
    }
  } catch { /* unreadable package.json → fall through to fail-closed default */ }
  return ["typecheck"];
}

async function triggerMitosisTick(a: {
  vessel: string;
  mitosisVersionId: string;
  mitosisRoot: string;
  stagedFiles: string[];
  baseSha: string;
  gapId: string;
  proposalId: string;
}): Promise<MitosisLanding> {
  // 2026-07-26 apply-reliability (keystone SPEC C): LAND the verified staged patch
  // by calling the cutover DIRECTLY with the FAVORABLE verdict patch_with_tools
  // already earned via its own delta-aware typecheck gates — the SAME in-process
  // path feature_compose uses. The prior light-dispatch to the mitosis-tick
  // TEMPLATE re-earned the verdict through vessel_mitosis_evaluate, whose overlay
  // typecheck failed/INSUFFICIENT_DATA on already-verified patches, so the cutover
  // soft-refused and NOTHING ever committed ("staged-not-landed"). The cutover
  // keeps its own freshness / provenance / scope-creep gates, so a bad tree still
  // refuses; boredom's later mitosis-tick is a no-op (this already landed).
  const none: MitosisLanding = { landed: false, new_git_sha: null, push_status: null };
  try {
    // GATE UNIFICATION (2026-07-30): path 2 previously fabricated a FAVORABLE verdict and
    // cut over on the strength of its own in-loop typecheck — which called a non-existent
    // tool name (code_typecheck) and failed OPEN, so syntax-broken/destructive patches
    // landed ungated (e.g. activity-api 9775bc8: a 12-line deletion, TS1128, reverted).
    // Earn the verdict through the SAME hardened static gate feature_compose uses
    // (staticEvaluate = delta-typecheck signature-subset + hasParseBail fail-closed on
    // TS1xxx + clean-base guard). Refuse on regression; DEFER (not refuse) on an
    // inconclusive timeout so the normal mitosis-tick re-evaluates in a quieter window.
    const bunCmd = Bun.which("bun") ?? "/root/.bun/bin/bun";
    const vesselsRootForEval = dirname(a.mitosisRoot);
    const baseRootForEval = join(vesselsRootForEval, a.vessel);
    // Run the vessel's REAL check script (not the ["lint"] default, which is absent in
    // goal-host-vessel and made the gate a silent no-op). Fails closed when neither exists.
    const checkScripts = await resolveCheckScripts(baseRootForEval);
    const ev = await staticEvaluate(a.mitosisRoot, bunCmd, baseRootForEval, a.stagedFiles, checkScripts);
    if (!ev.ok) {
      const status = ev.timed_out ? "evaluate_inconclusive" : `evaluate_refused:${ev.reason.slice(0, 120)}`;
      console.warn(`[patch-with-tools] cutover gated OUT for ${a.vessel}: ${status}`);
      return { landed: false, new_git_sha: null, push_status: status };
    }
    const citedChecks = ev.checks.map((c) => c.name).filter((n): n is string => typeof n === "string" && n.length > 0);
    const cut = await resolveVesselMitosisCutover({
      type: "vessel_mitosis_cutover",
      vessel_name: a.vessel,
      base_version_id: `${a.vessel}-live`,
      mitosis_version_id: a.mitosisVersionId,
      mitosis_root: a.mitosisRoot,
      staged_files: a.stagedFiles,
      staged_base_sha: a.baseSha,
      evaluation_evidence: { verdict: "FAVORABLE", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: citedChecks.length ? citedChecks : ["static_evaluate"] },
      gap_id: a.gapId,
      proposal_id: a.proposalId,
      skip_push: false,
    } as never);
    const b = (cut as { body?: Record<string, unknown> }).body ?? {};
    const ps = typeof b["push_status"] === "string" ? (b["push_status"] as string) : null;
    const sha = typeof b["new_git_sha"] === "string" && (b["new_git_sha"] as string).trim() ? (b["new_git_sha"] as string).trim() : null;
    if (ps === "pushed" && sha) return { landed: true, new_git_sha: sha, push_status: "pushed" };
    return { landed: false, new_git_sha: sha, push_status: ps };
  } catch { return none; }
}

type LlmProducer = { url: string; target?: string };

async function llmCall(producer: LlmProducer, prompt: string, model: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` };
  // Federated producers are reached via the transport egress with the peer
  // circuit multiaddr as target; the ingress proxies to the named arm over libp2p.
  if (producer.target) headers["X-Libp2p-Target"] = producer.target;
  const res = await fetch(producer.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: 4000, task_type: "patch_with_tools" }),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`llm fetch ${res.status}`);
  const j = (await res.json()) as any;
  // Local arm returns { content: "<text>" } | { error }. The federated egress
  // nests the result: { content: { value | content | body:{content|error}, ... } }.
  const c = j?.content;
  if (typeof c === "string") {
    if (j?.error) throw new Error(`llm error: ${j.error}`);
    return c.trim();
  }
  if (j?.error) throw new Error(`llm error: ${typeof j.error === "string" ? j.error : JSON.stringify(j.error)}`);
  if (c && typeof c === "object") {
    const inner = c.value ?? c.content ?? c.body?.content ?? c.body?.value;
    if (typeof inner === "string") return inner.trim();
    const innerErr = c.body?.error ?? c.error;
    if (innerErr) throw new Error(`llm error: ${typeof innerErr === "string" ? innerErr : JSON.stringify(innerErr)}`);
  }
  if (typeof j?.data === "string") return j.data.trim();
  throw new Error(`llm unparseable response: ${JSON.stringify(j).slice(0, 120)}`);
}

async function findLlmEndpoints(): Promise<LlmProducer[]> {
  try {
    for (const shape of ["llmCompletion", "llm_completion"]) {
      const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { content?: { vessels?: Array<{ vesselId?: string; endpoint: string; resolve_endpoint?: string; health_score?: number; libp2p_multiaddr?: string[] }> } };
      const vs = data.content?.vessels ?? [];
      if (vs.length === 0) continue;
      // Return ALL producers (not just [0]) so the caller can fail over across them.
      // A FEDERATED row (carries a libp2p circuit multiaddr) is only reachable via
      // the transport EGRESS path — its mirrored /v2/impulses/resolve resolves to the
      // LOCAL shape-owner, not the peer. So route federated rows through
      // /egress/resolve?vessel=<base> with the circuit multiaddr as X-Libp2p-Target;
      // route local rows to their plain resolve endpoint. Higher health_score first.
      const sorted = vs.slice().sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0));
      return sorted.map((v): LlmProducer => {
        const ma = Array.isArray(v.libp2p_multiaddr) ? v.libp2p_multiaddr[0] : undefined;
        if (ma) {
          const base = (v.vesselId ?? "").split("@")[0] ?? "";
          const root = v.endpoint.replace(/\/$/, "");
          return { url: `${root}/egress/resolve?vessel=${encodeURIComponent(base)}`, target: ma };
        }
        const ep = v.resolve_endpoint ?? "/resolve";
        const url = ep.startsWith("http") ? ep : `${v.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
        return { url };
      });
    }
  } catch { /* fall through */ }
  return [];
}

// Derive the outer model-failover list from the LIVE policy arms instead of a frozen
// literal. The prior frozen list went entirely credit-dead and omitted the live
// qwen/qwen3-32b arm, so once "auto" exhausted every outer fallback pinned a dead model.
// Resolve the llmModelPolicy shape off the SAME producers that serve llm_completion
// (passed in from findLlmEndpoints, incl. the hub-egress fallback so a spoke reads the
// hub's live pool) and return its arm model ids; fall back to a single live-verified
// literal only when the policy is unreachable. Best-effort: any failure yields the literal.
async function discoverFallbackModels(producers: LlmProducer[], exclude: string): Promise<string[]> {
  for (const p of producers) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` };
      if (p.target) headers["X-Libp2p-Target"] = p.target;
      // Short, dedicated timeout: this runs at startup on the happy path, so a hung policy
      // endpoint must not stall the whole patch. The list is only consumed if "auto" exhausts.
      const res = await fetch(p.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "llmModelPolicy" }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as any;
      // Direct vessel resolve returns { body: { arms:[{model}] } }; the federated egress
      // nests it under { content: { value | content | body } }. Probe both envelopes.
      const c = j?.content;
      const policy = j?.body ?? (c && typeof c === "object" ? (c.body ?? c.value ?? c) : undefined) ?? j;
      const arms = (policy as { arms?: unknown })?.arms;
      if (Array.isArray(arms)) {
        const models = (arms as unknown[])
          .map((a) => {
            const m = (a as { model?: unknown } | null)?.model;
            return typeof m === "string" ? m : null;
          })
          .filter((m): m is string => !!m && m !== exclude);
        const deduped = Array.from(new Set(models));
        if (deduped.length > 0) return deduped;
      }
    } catch { /* try next producer */ }
  }
  // Minimal live-verified literal — only when the policy is unreachable.
  return ["qwen/qwen3-32b"].filter((m) => m !== exclude);
}

async function findLocalToolsEndpoint(): Promise<string | null> {
  try {
    // local-tools-vessel advertises shellResult; use that to discover the vessel endpoint
    const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "shellResult" } }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> } };
    const vs = data.content?.vessels ?? [];
    if (vs.length === 0) return null;
    const best = vs.sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0))[0]!;
    const ep = best.resolve_endpoint ?? "/resolve";
    if (ep.startsWith("http")) return ep;
    return `${best.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
  } catch { return null; }
}

async function callTool(localToolsEndpoint: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(localToolsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: tool, ...args } } }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, body: { error: `HTTP ${res.status}` } };
    const body = await res.json();
    const bodyObj = body as Record<string, unknown>;
    const errored = typeof bodyObj?.error === "string" || (bodyObj as { shape?: string })?.shape === "structuredError" || bodyObj?.success === false;
    if (errored) {
      // PROPAGATE THE REAL CAUSE. This used to relabel EVERY tool failure — any error
      // body, any structuredError, any success:false, from any of the tools this loop
      // calls — as "Run refused due to poisoned baseline". That string names one
      // specific condition (live source diverged from its clone before an edit), and
      // it was being reported for causes that had nothing to do with it.
      //
      // Measured 2026-08-05: a code_search call failed here and the run was reported as
      // a poisoned baseline. The live tree was intact — vessel-daemon.ts was 14,629
      // bytes live and 14,629 in the clone, and a full scan of the vessel's src found
      // no truncated file at all. The real error was discarded, so the failure was not
      // just swallowed, it was actively misdirected: it points the reader at source
      // corruption and at the guard that detects it, instead of at the tool that broke.
      //
      // Keep the tool name so the failure is attributable, and cap the detail so a
      // large error body cannot flood the trace.
      const detail =
        typeof bodyObj?.error === "string" ? bodyObj.error
        : typeof (bodyObj as { detail?: unknown })?.detail === "string" ? String((bodyObj as { detail: string }).detail)
        : JSON.stringify(body ?? null).slice(0, 400);
      return { ok: false, body: { error: `${tool} failed: ${detail}` } };
    }
    return { ok: true, body };
  } catch (err) { return { ok: false, body: { error: (err as Error).message } }; }
}

const TOOL_CATALOG_HELP = `Available tools (call exactly one per turn):

1. code_search { path, pattern, flags?, limit? }
   - Regex search over the file. Returns matches with line numbers.
   - Use first to locate the region you want to edit.

2. code_find_function { path, name }
   - Locates a function/method definition by name. Returns start_line, end_line, signature.

3. code_find_import { path, module }
   - Locates an existing import for the given module. Returns line + specifiers if found.

4. code_insert_after_line { path, after_line, text }  ← AVOID unless adding a brand-new line
   - Inserts \`text\` as a new line after line \`after_line\` (1-indexed, 0 = top). It can
     only ADD a line — it can NEVER replace or delete one.
   - WARN: \`after_line\` is a RAW line number. Any earlier edit this run (or a number read
     from a stale search) SHIFTS the file, so the insert silently lands at the WRONG place.
     Prefer fs_edit (matches by verbatim text, so it is immune to line-number drift). Use
     code_insert_after_line ONLY to add a genuinely new line at a spot you re-read THIS turn.

4b. code_read_lines { path, start_line, end_line }  <- READ EXACT lines before a range replace
   - Returns the VERBATIM current content of lines [start_line..end_line] (1-indexed),
     plus a line-numbered view. Use this to get the EXACT text before code_replace_lines
     so your replacement preserves everything you are not changing. Reliable multi-line
     edit flow: code_read_lines(start,end) -> code_replace_lines(start,end, <that exact
     text with your minimal change applied>).

5. code_replace_lines { path, start_line, end_line, text }
   - Replaces lines [start_line..end_line] (inclusive, 1-indexed) with \`text\`.
   - DANGER: you must supply the FULL replacement text for that whole range. ALWAYS
     code_read_lines that exact range first and edit the returned text - never retype it
     from memory or a truncated search, or you WILL destroy code. For a single-line or
     single-token change, fs_edit is simpler.

5b. fs_edit { path, old_string, new_string }  ← ★ USE THIS FIRST — replace a UNIQUE anchor
   - The primary edit tool. Replaces old_string with new_string matched by CONTENT (a
     verbatim anchor), so it is IMMUNE to the line-number drift that breaks
     code_insert_after_line / code_replace_lines. Fails safely ("old_string not found")
     WITHOUT writing if old_string isn't present, so it can never destroy code you haven't
     read. Copy old_string VERBATIM from a code_search result and make new_string the
     minimal change. This is the safest way to edit.
   - WARN — FIRST OCCURRENCE ONLY: fs_edit changes ONLY the first match of old_string. If
     the text you are changing appears more than once (a common token, a repeated call),
     old_string MUST carry enough surrounding context to be UNIQUE to the exact site you
     mean, or the edit hits the wrong one. To change N sites, emit N fs_edit calls, each
     with its own uniquely-anchored old_string — a single call does NOT update every
     occurrence.

5c. fs_write { path, content }  ← ONLY for authoring a NET-NEW file
   - Writes the FULL contents of \`path\`, creating parent dirs. Use EXACTLY ONCE
     when the proposal declares a NEW file that does not yet exist. NEVER call it
     on an existing file (use fs_edit / code_replace_lines for those) — it
     overwrites the whole file.

6. code_add_import { path, module, specifier }
   - Idempotent. Adds an import; merges into existing brace-form imports.

7. code_verify_typecheck { cwd, script? }
   - Runs \`bun run <script>\` (default "typecheck") and returns error count.
   - Use to verify your changes before declaring done.

BE DECISIVE — your turn budget is small. The normal path is: code_search to READ
the exact current lines → fs_edit { old_string=<verbatim copy of those lines>,
new_string=<minimal change> } → emit done. NEVER call code_replace_lines on a
range whose content you have not just read verbatim — that destroys it. After an
edit tool returns OK, do NOT keep searching: at most ONE
confirming search, then emit done. Repeated searching wastes turns and the patch
is REJECTED if you hit the cap without declaring done. If an edit returns OK and
makes the described change, the patch is complete — declare done immediately.

When the file is in the desired state, emit { "action": "done", "summary": "<one-line>" }.
If you cannot complete the patch, emit { "action": "fail", "reason": "<why>" }.

Emit ONLY a JSON object per turn — either { "action": "call_tool", "tool": "<name>", "args": {...} } or { "action": "done", ... } or { "action": "fail", ... }.
NO prose, no markdown fences.`;

function parseFirstJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0; let inStr = false; let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) { if (ch === "\\") escape = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function deriveVesselFromPath(filePath: string): { vessel: string; subPath: string } | null {
  // Fail closed on a missing target rather than throwing. A caller passing an absent
  // field threw "undefined is not an object (evaluating 'filePath.match')" here, which
  // aborted the whole escalation before it began; returning null lets the caller report
  // "no target" honestly instead of surfacing as an unexplained crash.
  if (typeof filePath !== "string" || !filePath) return null;
  const m1 = filePath.match(/^(?:\/)?repos\/([^/]+)\/(.+)$/);
  if (m1) return { vessel: m1[1]!, subPath: m1[2]! };
  const m2 = filePath.match(/^\/vessels\/([^/]+)\/(.+)$/);
  if (m2) return { vessel: m2[1]!, subPath: m2[2]! };
  return null;
}

// Durable authoring-in-flight marker (an impulse other planes can consume, not a process-private PID):
// lifecycle actors like substrate-pull-sync consume it to defer vessel restarts while an authoring run is
// live, and the killed-run detector flags markers whose pid is dead.
export async function writeAuthoringMarker(workspaceRoot: string, vessel: string, targetFile: string, resolverName: string = 'patch_with_tools'): Promise<string | null> {
  try {
    const markerDir = join(workspaceRoot, 'authoring-inflight');
    await mkdir(markerDir, { recursive: true });
    const markerPath = join(markerDir, resolverName + '-' + vessel + '.json');
    await writeFile(markerPath, JSON.stringify({
      resolver: resolverName,
      vessel,
      target_file: targetFile,
      pid: process.pid,
      started_at: new Date().toISOString(),
    }, null, 2));
    return markerPath;
  } catch {
    return null;
  }
}

export async function clearAuthoringMarker(markerPath: string | null): Promise<void> {
  if (markerPath === null) return;
  try {
    await unlink(markerPath);
  } catch {
    // best-effort
  }
}

export async function resolvePatchWithTools(pointer: PatchWithToolsPointer): Promise<ResolverResult> {
  const workspaceRoot = pointer.workspace_root ?? process.env.WORKSPACE_ROOT ?? "/workspace";
  const vesselsRoot = pointer.vessels_root ?? "/vessels";
  const maxIters = pointer.max_iterations ?? MAX_ITERATIONS;
  const model = pointer.model ?? "auto";
  // fallbackModels (the outer model-failover list) is DERIVED from the live policy arms
  // below, once llmEndpoints is resolved — see discoverFallbackModels. The frozen literal
  // it replaced (llama-3.3-70b-versatile / mistral-small-latest / GLM-5.2-TEE / Kimi-K2.6-TEE
  // / DeepSeek-V3.2-TEE) went ENTIRELY credit-dead and omitted the live qwen/qwen3-32b arm,
  // so once "auto" exhausted every outer fallback pinned a dead model.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const derived = deriveVesselFromPath(pointer.target_file);
  if (!derived) return structuredError(`cannot derive vessel from path: ${pointer.target_file}`);
  const { vessel, subPath } = derived;
  const liveSrcPath = join(vesselsRoot, vessel, subPath);
  const isNewFile = pointer.is_new_file === true;

  const beforeSrc = await readFile(liveSrcPath, "utf-8").catch(() => null);
  if (!isNewFile && beforeSrc === null) return structuredError(`live source missing: ${liveSrcPath}`);
  // Seam ③: authoring a NET-NEW file — refuse if it ALREADY exists (the patcher
  // would clobber, not author). Absence is the expected state here.
  if (isNewFile && beforeSrc !== null) {
    return structuredError(`new-file target already exists: ${liveSrcPath} (use fs_edit, not is_new_file)`);
  }
  // baseContent is "" for a net-new file; the SHA/reset/restore logic downstream
  // uses it as the canonical "before" state.
  const baseContent = beforeSrc ?? "";
  const beforeSha = createHash("sha256").update(baseContent).digest("hex").slice(0, 12);
  // POISONED-BASELINE DETECTOR (2026-08-02). baseContent is snapshotted from the LIVE
  // file, and resetTarget()/touchedSnapshots restore to it — so if live source is
  // already corrupt when a run starts, every run adopts the corruption as its
  // "correct" state and faithfully restores it. The rollback machinery is correct and
  // useless. Observed: live feature-compose.ts held `llmCall(\n  llmEndpoint,endpoint,
  // prompt, model)` (an identifier not in scope) while the push clone and origin/dev
  // were clean; nothing noticed, because the vessel kept serving its in-memory module.
  //
  // Detect only — deliberately NOT auto-restoring from the clone. A mitosis cutover
  // copies staged files into /vessels BEFORE the clone pulls, so live is legitimately
  // ahead of the clone inside that window, and "restore from clone" there would revert
  // a just-landed change. That is the same shape as the freshness gate comparing the
  // mirror instead of origin. pull-sync owns the repair (it heals live-vs-clone drift
  // only when no authoring marker is in flight); this makes the condition visible at
  // the moment it would poison a run.
  if (!isNewFile) {
    const clonePath = join(process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels", vessel, subPath);
    const cloneSrc = await readFile(clonePath, "utf-8").catch(() => null);
    if (cloneSrc !== null && cloneSrc !== baseContent) {
      console.error(
        `[patch-with-tools] POISONED BASELINE: ${liveSrcPath} (${baseContent.length}B) differs from its clone ` +
        `${clonePath} (${cloneSrc.length}B) BEFORE any edit — rollback would restore the live state, not the git state. ` +
        `Either a prior run left un-reverted edits, or a cutover has landed and the clone has not pulled yet.`,
      );
      // REFUSE — do not merely report. Detecting and continuing is what turned this into
      // an outage on 2026-08-05: live gap-to-scenario-bridge.ts was 11,489B against a
      // 15,822B clone, no longer parsed, and development-vessel crash-looped for several
      // minutes — while this very line had already named the condition exactly. Worse,
      // resetTarget() writes baseContent back on rollback, so proceeding on a poisoned
      // baseline CEMENTS the corruption this message warns about.
      //
      // The detect-only stance above is right about the cutover window — live is
      // legitimately AHEAD of the clone until it pulls — so this deliberately does NOT
      // auto-restore. It refuses only when live is clearly DAMAGED rather than ahead: a
      // legitimately-ahead file still parses and is not dramatically smaller than the
      // clone it was built from. Repair stays owned by pull-sync / mirror-to-live.
      {
        return structuredError(
          `poisoned baseline: live ${liveSrcPath} is ${baseContent.length}B vs clone ${cloneSrc.length}B ` +
          `— refusing to edit on poisoned baseline; restore it with mirror-to-live`,
          { stage: "baseline", live_bytes: baseContent.length, clone_bytes: cloneSrc.length },
        );
      }
    }
  }
  const authoringMarkerPath = await writeAuthoringMarker(workspaceRoot, vessel, pointer.target_file);

  // resetTarget — restore the live path to its pre-attempt state. For a net-new
  // file that means UNLINK (writing "" back leaves a stub that poisons the next
  // attempt's existence check + makes the no-op guard pass on an empty file);
  // for an existing file, write the original content back.
  const resetTarget = async (): Promise<void> => {
    try {
      if (isNewFile) {
        await unlink(liveSrcPath).catch(() => { /* not yet created */ });
      } else {
        await writeFile(liveSrcPath, baseContent);
      }
    } catch { /* best-effort */ }
  };

  // DRIFT-PROOF SNAPSHOT/RESTORE (2026-07-30, gap
  // critical-patch-with-tools-edits-live-vessel-source). resetTarget only ever
  // restores the single declared target_file; a terminal that skipped it (the LLM
  // plane exhausting mid-run at the `llm failed turn` return, an uncaught throw, or
  // an edit the drafter aimed at a DIFFERENT path) stranded broken code in the LIVE
  // /vessels source — not in git — waiting to crash the next restart (observed
  // twice: goal-host index.ts left with a TS2451 walkTerminationReason redeclare).
  // Capture the pre-EDIT content of EVERY path any edit tool touches (baseline-
  // correct: the first touch of a path records its state BEFORE the first edit), and
  // on ANY non-landing terminal outcome restore ALL of them, verified by hash. The
  // target file is seeded up front so its baseline is correct even if it is the only
  // file touched. Overlay isolation remains the structural fix; this is the
  // deterministic backstop that makes a stranded corruption impossible.
  const touchedSnapshots = new Map<string, string | null>();
  touchedSnapshots.set(liveSrcPath, isNewFile ? null : baseContent);
  const snapshotBeforeEdit = async (p: string): Promise<void> => {
    if (touchedSnapshots.has(p)) return;
    const cur = await readFile(p, "utf-8").catch(() => null);
    touchedSnapshots.set(p, cur);
  };
  const restoreAllSnapshots = async (): Promise<void> => {
    for (const [p, content] of touchedSnapshots) {
      try {
        if (content === null) {
          // Path did not exist pre-op (net-new authoring): remove the stub so it
          // cannot poison a re-run's existence check and cannot ship as live source.
          await unlink(p).catch(() => { /* already absent */ });
          continue;
        }
        await writeFile(p, content);
        const back = await readFile(p, "utf-8").catch(() => null);
        const want = createHash("sha256").update(content).digest("hex");
        const got = back === null ? null : createHash("sha256").update(back).digest("hex");
        if (got !== want) {
          // Fail loud: a restore that did not take leaves drift on disk. This is the
          // exact failure the whole guard exists to prevent, so it must be visible.
          console.error(`[patch-with-tools] RESTORE FAILED — live ${p} still diverged after snapshot restore (drift on disk)`);
        }
      } catch (e) {
        console.error(`[patch-with-tools] restore threw for ${p}: ${(e as Error).message}`);
      }
    }
  };

  const llmEndpoints = await findLlmEndpoints();
  // Hub-egress fallback (law 11): when NO llm arm is discoverable locally (the local resolver
  // de-advertises llm_completion on quota/credit exhaustion; a spoke doesn't mirror the hub's
  // arms), a funded arm still lives on a peer. Route BY NAME through the federation egress — the
  // egress picks a LIVE hub circuit and lands on the owning vessel over libp2p. No target header
  // (by-name), matching feature_compose. The existing llmCall posts the unwrapped
  // {type:"llm_completion",...} body this endpoint accepts, and its response-unwrap already
  // handles the {content:{value}} envelope. The pushed producer is a first-class member of the
  // per-turn cascade below. Costs nothing when a local arm exists (branch skipped).
  llmEndpoints.push({ url: `${FED_TRANSPORT_EGRESS}/egress/resolve?vessel=llm-resolver-vessel` });
  if (llmEndpoints.length === 0) return structuredError("no llm_completion vessel found in discovery");
  const llmEndpoint = llmEndpoints[0]!;
  const toolsEndpoint = await findLocalToolsEndpoint();
  if (!toolsEndpoint) return structuredError("no local-tools vessel found in discovery");
  console.error(`[patch-with-tools] start vessel=${vessel} file=${subPath} model=${model} (auto→haiku hollow-lands hard edits; sonnet-5 is capable hub-served default) llm=${llmEndpoint.url} tools=${toolsEndpoint}`);
  // Outer model-failover list, derived NOW from the live policy arms (see
  // discoverFallbackModels). Reuses the resolved llmEndpoints (incl. hub-egress fallback)
  // so a spoke reads the hub's live arm pool rather than a frozen, credit-dead literal.
  const fallbackModels = await discoverFallbackModels(llmEndpoints, model);

  // The LLM must operate on the LIVE container path so its searches match what cutover
  // will actually stage. Stage into the mitosis tree at the end by copy.
  const containerPath = liveSrcPath; // already /vessels/<v>/<subPath>

  // Anti-confabulation (law 8, information-at-use-time): inject the target file's REAL
  // endpoint/base-URL constants so the drafter reuses them BY NAME instead of inventing a
  // literal URL from memory (the 0b80f1be class: a duplicate fetch to a hardcoded
  // https://concept-db.com while CONCEPT_DB_ENDPOINT sat imported in the file). The
  // MINIMAL-EDIT RULE only guards PRESERVING surrounding lines on an edit, not a
  // NEWLY-ADDED http call, and an advisory "go search first" instruction fights the
  // anti-search-loop nudge below. Network-free: reads the file the patcher already edits.
  let endpointFacts = "";
  if (!isNewFile) {
    try {
      const _epSrc = await readFile(containerPath, "utf8");
      const _epNames = new Set<string>();
      const _epRe = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_ENDPOINT|_URL|_BASE|_HOST|_ORIGIN))\b/g;
      let _epM: RegExpExecArray | null;
      while ((_epM = _epRe.exec(_epSrc)) !== null) {
        const _epN = _epM[1];
        if (_epN) _epNames.add(_epN);
        if (_epNames.size >= 20) break;
      }
      if (_epNames.size > 0) {
        endpointFacts =
          `## LIVE ENDPOINTS ALREADY IN THIS FILE - reuse these BY NAME for any HTTP call; NEVER invent a literal URL string:\n` +
          Array.from(_epNames).map((n) => `- ${n}`).join("\n") +
          `\nIf your change adds or moves an HTTP call, use one of the above constants with the file's existing Authorization header pattern. Write a NEW url literal ONLY if none of the above fits AND the proposal supplies the endpoint value verbatim.\n\n`;
      }
    } catch { /* best-effort; absence just omits the block */ }
  }

  const history: Array<{ turn: number; thought_or_action: string; tool_result?: ToolResult }> = [];
  // Counts identical failing (tool,args) calls so a stuck ReAct loop aborts early.
  const failedCallCounts = new Map<string, number>();
  // Counts identical verify-on-done typecheck failures so we don't burn cycles
  // re-producing the same broken patch.
  const verifyFailCounts = new Map<string, number>();
  let finalReason: string | null = null;
  let finished = false;
  // Outer retry (2026-06-14): a single ReAct attempt can strand itself (e.g. it
  // damages the function before reading it, then correctly refuses to
  // hallucinate the recovery). Reset to the ORIGINAL source and re-attempt,
  // injecting the prior failure so the next attempt produces a BETTER patch.
  // Abort as soon as two attempts fail similarly — re-failing identically wastes
  // cycles without improving coverage.
  const maxAttempts = pointer.max_attempts ?? 3;
  const attemptFailures: string[] = [];

  // BASELINE TYPECHECK (orphan-staged-edit fix): a large target file may carry pre-existing
  // unrelated TS errors; grading the terminal by ABSOLUTE cleanliness makes a CORRECT edit
  // un-finishable and the loop DISCARDS it. Snapshot the pre-edit target error set once so
  // the terminal + salvage grade by NEW errors.
  const targetBaseName = containerPath.split("/").pop() ?? containerPath;
  let baselineTargetErrors = new Set<string>();
  try {
    const tcBase = await callTool(toolsEndpoint, "code_verify_typecheck", { cwd: `${vesselsRoot}/${vessel}` });
    const tcBaseBody = tcBase.body as { error_lines?: string[] } | undefined;
    baselineTargetErrors = new Set((tcBaseBody?.error_lines ?? []).filter((l) => l.includes(targetBaseName)));
  } catch { /* best-effort; empty set == prior absolute grading */ }

  // DRIFT-PROOF: once true, the edit has been safely captured into the staged mitosis
  // tree and the live file was intentionally reset (the cutover owns the live landing
  // from here). Until then, ANY exit is non-landing and must restore the snapshots.
  let stagedForLanding = false;
  try {
  for (let attempt = 1; attempt <= maxAttempts && !finished; attempt++) {
    if (attempt > 1) {
      await resetTarget();
      history.length = 0;
      failedCallCounts.clear();
      verifyFailCounts.clear();
    }
  // Producer/model failover state persisted ACROSS turns: once a working
  // (endpoint, model) is found, keep it instead of re-cascading every turn.
  let activeEndpoint = llmEndpoints[0]!;
  let activeModel = model;
  for (let turn = 1; turn <= maxIters && !finished; turn++) {
    const lastHistIdx = history.length - 1;
    const historyBlock = history.length === 0
      ? "(no tool calls yet)"
      // Show the MOST RECENT tool result in full (cap 6000) so the patcher can
      // actually SEE the lines it just searched on a large file; older results are
      // truncated to keep context bounded. The prior flat 800-char cap starved the
      // patcher of the content it found -> it re-searched and exhausted the turn
      // budget on big files (goal-host index.ts = 2108 lines) without ever
      // constructing an edit. (2026-06-18)
      : history.map((h, i) => {
          const cap = i === lastHistIdx ? 6000 : 500;
          return `Turn ${h.turn}: ${h.thought_or_action}${h.tool_result ? `\n  → ${h.tool_result.ok ? "OK" : "ERR"}: ${JSON.stringify(h.tool_result.result).slice(0, cap)}` : ""}`;
        }).join("\n\n");

    // When the previous turn's tool call failed, surface the error LOUDLY with a
    // directive to FIX the args (not repeat them). The plain history line was too
    // easy for the LLM to ignore, causing identical-call retry loops.
    const last = history[history.length - 1];
    let correction = "";
    if (last?.tool_result && !last.tool_result.ok) {
      if (last.tool_result.tool === "code_typecheck") {
        // verify-on-done failure: the patch compiled-but-broke the target file.
        correction =
          `## ⚠ YOUR PATCH FAILED TYPECHECK — IT IS NOT DONE\n` +
          `Errors in the target file:\n${JSON.stringify(last.tool_result.result).slice(0, 500)}\n` +
          `These are caused by YOUR edit. Inspect the actual current file (code_search / code_find_function) ` +
          `and apply a MINIMAL corrected edit that fixes ONLY these errors — do NOT rewrite working code or ` +
          `invent identifiers/URLs/imports. A named export must be imported as { name }, not as a default. ` +
          `Do NOT declare done again until the change is correct; re-emitting the same broken patch aborts.\n\n`;
      } else {
        correction =
          `## ⚠ YOUR LAST CALL FAILED — DO NOT REPEAT IT\n` +
          `Tool: ${last.tool_result.tool}\nArgs you sent: ${JSON.stringify(last.tool_result.args).slice(0, 300)}\n` +
          `Error: ${JSON.stringify(last.tool_result.result).slice(0, 300)}\n` +
          `Re-read the tool catalog and emit a DIFFERENT, corrected call that supplies EVERY required argument ` +
          `(an error naming required fields means one was missing — code_replace_lines needs all of {path, start_line, end_line, text}). ` +
          `Repeating the same args will fail again and abort the patch.\n\n`;
      }
    }

    const priorBlock = attemptFailures.length
      ? `## ⚠ PRIOR ATTEMPTS FAILED — do something DIFFERENT this time\n${attemptFailures.join("\n")}\n` +
        `The file has been reset to its original state. READ the exact lines first; do not repeat the above mistake.\n\n`
      : "";

    // Anti-search-loop (2026-06-17): the dominant autonomous failure is burning the
    // turn budget on consecutive code_search / code_find_function calls without ever
    // emitting an edit (observed live: turns 6-10 all code_search -> cap -> no_op ->
    // nothing staged -> no cutover). After 3 consecutive read-only turns, escalate to
    // a hard "edit now or fail" so the loop converges instead of grazing the file.
    // 2026-08-10: this scan used to match only code_search / code_find_function and
    // `break` on anything else — including a turn with NO tool_result, which is what
    // an unrecognised action verb produces. Since the model loops by emitting the
    // tool name in the action slot, every turn of the loop had no tool_result, the
    // first one ended the scan, and the guard could never fire (observed: 24
    // consecutive code_read_lines, cap reached, nothing staged). Counted properly
    // in noProgressStreak().
    const searchStreak = noProgressStreak(history);
    const searchNudge = searchStreak >= 3
      ? `## ⚠ STOP — ${searchStreak} CONSECUTIVE TURNS MADE NO EDIT\n` +
        `Those turns either only READ the file or were rejected without running anything. ` +
        `You already have the file content. Do NOT call code_search, code_read_lines or ` +
        `code_find_function again. THIS TURN emit an EDIT: fs_edit { path, ` +
        `old_string=<verbatim lines you just read>, new_string=<minimal change> } (or ` +
        `code_replace_lines with exact line numbers). If you cannot construct the edit from ` +
        `what you have already read, emit { "action": "fail", "reason": "<why>" }. Another ` +
        `search wastes the budget and the patch is REJECTED at the cap.\n\n`
      : "";

    // Seam ③ decision rule: a net-new file is AUTHORED with one fs_write (full
    // content) then done — there is nothing to READ first. An existing file is
    // edited READ→fs_edit. Surface the right path so the patcher does not waste
    // turns code_search-ing a file that does not exist yet.
    const decisionRule = isNewFile
      ? `## ⚠ NET-NEW FILE — AUTHOR IT, DO NOT SEARCH\nThe target file does NOT exist yet; the proposal declares it as a new file. Do NOT call code_search / code_find_function (there is nothing to read). Your FIRST action MUST be fs_write { path: "${containerPath}", content: <the FULL file contents> }, then emit done. Write complete, well-formed TypeScript that typechecks; the file is typecheck-verified before done.\n\n`
      : `MINIMAL-EDIT RULE: make the SMALLEST edit that satisfies the proposal. First READ the exact current lines you will change (code_search / code_find_function), then change ONLY those. Preserve every surrounding URL, header, identifier, type, and import style EXACTLY as they appear — never retype code from memory or invent values. A named export is imported as { name } (not a default import). After your edit, the file is typecheck-verified; if it fails, you must fix it before declaring done.\n\n`;

    const prompt =
      `You are patching a source file via fine-grained code tools. The proposal describes what to change; you use the tools to inspect the file and apply the change.\n\n` +
      priorBlock +
      decisionRule +
      endpointFacts +
      `## Target file (container path)\n${containerPath}\n\n` +
      `## Proposal (intent — code samples may be illustrative, NOT the actual file contents)\n${pointer.proposal_text}\n\n` +
      `## Tool catalog\n${TOOL_CATALOG_HELP}\n\n` +
      correction +
      searchNudge +
      `## Tool call history\n${historyBlock}\n\n` +
      `## Turn ${turn} of ${maxIters}\n` +
      `Emit your next action as a JSON object only.`;

    let raw: string;
    const transientRetries = new Map<string, number>();
    for (;;) {
      try {
        raw = await llmCall(activeEndpoint, prompt, activeModel);
        break;
      } catch (err) {
        const msg = (err as Error).message;
        // Transient transport blip (relay re-reservation window): retry the SAME
        // endpoint a bounded number of times before treating it as a producer failure.
        if (isTransientTransportError(msg)) {
          const n = (transientRetries.get(activeEndpoint.url) ?? 0) + 1;
          if (n <= MAX_TRANSIENT_RETRIES) {
            transientRetries.set(activeEndpoint.url, n);
            console.error(`[patch-with-tools] transient transport error (${msg.slice(0, 60)}); retry ${n}/${MAX_TRANSIENT_RETRIES} same endpoint after ${TRANSIENT_BACKOFF_MS * n}ms`);
            await new Promise((r) => setTimeout(r, TRANSIENT_BACKOFF_MS * n));
            continue;
          }
        }
        // Producer failover: on ANY provider failure (429, credit-dead, no-provider,
        // 5xx), cascade to the next discovered llm_completion endpoint — including
        // the federated hub row, whose resolve_endpoint hops over libp2p to a funded
        // arm on the peer substrate. Only when every endpoint has failed for the
        // current model do we fall through the model list and reset the endpoints.
        const epIdx = llmEndpoints.indexOf(activeEndpoint);
        const nextEp = epIdx >= 0 ? llmEndpoints[epIdx + 1] : undefined;
        if (nextEp) {
          console.error(`[patch-with-tools] llm endpoint failed (${msg.slice(0, 80)}); failing over to next producer`);
          activeEndpoint = nextEp;
          continue;
        }
        const next = fallbackModels.shift();
        if (!next) {
          return structuredError(`llm failed turn ${turn}: ${msg}`, { history, before_sha: beforeSha });
        }
        console.error(`[patch-with-tools] all endpoints exhausted for ${activeModel}; falling back to model ${next}`);
        activeModel = next;
        activeEndpoint = llmEndpoints[0]!;
      }
    }
    const action = parseFirstJsonObject(raw);
    console.error(`[patch-with-tools] turn ${turn}: action=${action?.action ?? "UNPARSEABLE"}${action?.tool ? ` tool=${action.tool}` : ""}`);
    if (!action || typeof action.action !== "string") {
      // UNPARSEABLE-RECOVERY (2026-07-19): the old no-op push carried NO tool_result,
      // so the loud-correction block (gated on last.tool_result && !ok) never fired —
      // the model got zero feedback, repeated the bad emission, and burned the whole
      // turn budget dropping every remaining edit (the multi-hunk co-land killer).
      // Push a FAILED tool_result so the correction fires next turn, and abort the
      // attempt after 3 consecutive so a wedged model resets instead of looping.
      const un = (verifyFailCounts.get("__unparseable__") ?? 0) + 1;
      verifyFailCounts.set("__unparseable__", un);
      if (un >= 3) {
        attemptFailures.push(`attempt ${attempt}: ${un} consecutive unparseable LLM outputs — resetting attempt`);
        break;
      }
      history.push({
        turn,
        thought_or_action: `(unparseable LLM output: ${raw.slice(0, 200)})`,
        tool_result: { tool: "parse_guard", args: {}, result: { error: "Your previous output was NOT valid JSON and could not be parsed. Emit ONLY a single JSON object \u2014 no prose, no markdown fences, nothing before { or after }. Escape every newline inside a string value as \\n." }, ok: false },
      });
      continue;
    }
    // A valid action parsed: clear the consecutive-unparseable counter.
    verifyFailCounts.set("__unparseable__", 0);
    if (action.action === "done") {
      // No-op-done recovery (2026-06-18): the ReAct LLM commonly declares done
      // WITHOUT ever calling an edit tool (observed live on a surgical typecheck
      // fix: action=done at turn 2/5, file byte-unchanged -> post-loop reject with
      // no chance to recover). Catch it IN-LOOP: if the live file is identical to
      // the original, the patch is empty -> feed a hard correction and continue so
      // the LLM actually applies the edit, instead of wasting the whole attempt.
      const curSrcForNoop = await readFile(liveSrcPath, "utf-8").catch(() => baseContent);
      if (createHash("sha256").update(curSrcForNoop).digest("hex").slice(0, 12) === beforeSha) {
        const nn = (verifyFailCounts.get("__noop_done__") ?? 0) + 1;
        verifyFailCounts.set("__noop_done__", nn);
        if (nn >= 2) {
          return structuredError(
            `patch_with_tools: aborted — LLM declared done ${nn}x without making any edit (file unchanged). The proposal likely needs no change to this file, or the LLM will not act.`,
            { history, before_sha: beforeSha },
          );
        }
        history.push({
          turn,
          thought_or_action: `(no-op done) you declared done but the file is UNCHANGED — you made NO edit. You MUST call an edit tool (${isNewFile ? "fs_write to author the new file" : "fs_edit or code_replace_lines"}) to apply the change BEFORE declaring done.`,
          tool_result: { tool: "noop_done_guard", args: {}, result: { error: "file unchanged; no edit was made — call an edit tool" }, ok: false },
        });
        continue;
      }
      // VERIFY-ON-DONE (2026-06-14): never accept the patch on the LLM's word.
      // Typecheck the live (in-progress) edit and, if the TARGET FILE now has
      // errors, feed them straight back so the patcher FIXES its own mistake
      // instead of returning a broken patch that only fails later at the cutover
      // gate. The loud-correction block (above) surfaces these on the next turn.
      // Crucially: abort if the SAME typecheck failure recurs — re-producing an
      // identical broken patch wastes cycles without improving coverage.
      const vesselDir = `${vesselsRoot}/${vessel}`;
      const tc = await callTool(toolsEndpoint, "code_verify_typecheck", { cwd: vesselDir });
      const tcBody = tc.body as { error_lines?: string[] } | undefined;
      const targetBase = containerPath.split("/").pop() ?? containerPath;
      const targetErrors = (tcBody?.error_lines ?? []).filter((l) => l.includes(targetBase));
      if (targetErrors.length === 0) {
        finalReason = String(action.summary ?? "done");
        finished = true;
        break;
      }
      const sig = targetErrors.slice(0, 5).join("|");
      const vn = (verifyFailCounts.get(sig) ?? 0) + 1;
      verifyFailCounts.set(sig, vn);
      if (vn >= 2) {
        await resetTarget();
        return structuredError(
          `patch_with_tools: aborted — the patch keeps failing typecheck with the SAME ${targetErrors.length} error(s) in ${targetBase} (${vn}×). Not burning cycles re-producing a broken patch. Errors: ${targetErrors.slice(0, 3).join(" ; ")}`,
          { history, before_sha: beforeSha, verify_errors: targetErrors },
        );
      }
      history.push({
        turn,
        thought_or_action: `(verify-on-done) typecheck FAILED on ${targetBase}: patch is NOT complete — fix these errors`,
        tool_result: { tool: "code_typecheck", args: { cwd: vesselDir }, result: { error_lines: targetErrors }, ok: false },
      });
      continue;
    }
    if (action.action === "fail") {
      attemptFailures.push(`attempt ${attempt}: llm declared fail: ${String(action.reason ?? "no reason").slice(0, 200)}`);
      break; // reset + try a fresh attempt
    }
    if (action.action !== "call_tool") {
      // Record WHY it was rejected. Previously this pushed a bare note with no
      // tool_result, so the model got no correction and reissued the identical
      // malformed turn — the parse_guard branch above has always done this properly.
      history.push({
        turn,
        thought_or_action: `(unknown action: ${String(action.action)})`,
        tool_result: {
          tool: "action_guard",
          args: {},
          result: {
            error:
              `"${String(action.action)}" is not an action. The action field must be exactly one of ` +
              `"call_tool", "done", or "fail". To use a tool, put its NAME in the "tool" field: ` +
              `{ "action": "call_tool", "tool": "${String(action.action)}", "args": { … } }. ` +
              `This turn did nothing — do not repeat it.`,
          },
          ok: false,
        },
      });
      continue;
    }
    const tool = String(action.tool ?? "");
    const args = (action.args ?? {}) as Record<string, unknown>;
    console.error(`[patch-with-tools] turn ${turn} args=${JSON.stringify(args).slice(0, 240)}`);
    if (!tool) {
      history.push({
        turn,
        thought_or_action: "(missing tool name)",
        tool_result: {
          tool: "action_guard",
          args: {},
          result: { error: `You emitted "call_tool" with no "tool" field. Name the tool, e.g. { "action": "call_tool", "tool": "code_read_lines", "args": { … } }. This turn did nothing — do not repeat it.` },
          ok: false,
        },
      });
      continue;
    }
    // Force path arg to container path when not specified — protects against drafted absolute paths.
    if (typeof args.path === "string" && args.path.startsWith("repos/")) {
      args.path = args.path.replace(/^repos\/[^/]+\//, `${vesselsRoot}/${vessel}/`);
    }
    // RUN-ROOT CONTAINMENT: the drafter authors `args.path` freely, and the
    // rewrite above only normalises a `repos/<vessel>/` prefix — an absolute path
    // escapes the run root untouched, and nothing in the tool plane contains it.
    // REFUSE rather than silently redirect: a rewrite would hide the fact that the
    // model aimed outside its scope. Restricted to the edit tools; reads, greps and
    // typechecks stay untouched so the observe half of the walk is unaffected.
    let escapedRoot = false;
    if (typeof args.path === "string" && (tool === "fs_edit" || tool === "fs_write" || tool === "code_replace_lines" || tool === "code_insert_after_line" || tool === "code_add_import")) {
      const runRoot = `${vesselsRoot}/${vessel}`;
      const absPath = resolve(args.path.startsWith("/") ? args.path : `${runRoot}/${args.path}`);
      const relPath = relative(runRoot, absPath);
      if (relPath.startsWith("..") || isAbsolute(relPath)) {
        escapedRoot = true;
        console.error(`[patch-with-tools] turn ${turn} ${tool} REFUSED: path ${args.path} resolves to ${absPath}, outside the run root ${runRoot}`);
      }
    }
    // PREFIX-IDEMPOTENCE GUARD (2026-07-20): when old_string is a prefix of
    // new_string, a re-applied fs_edit "succeeds" again and stacks duplicates
    // until self-destruct. If the target already contains new_string, the edit
    // is already applied — report a no-op success instead of re-applying.
    let alreadyApplied = false;
    if (tool === "fs_edit" && typeof args.new_string === "string" && args.new_string.length > 0) {
      const guardNew = args.new_string;
      const guardOld = typeof args.old_string === "string" ? args.old_string : "";
      const editPath = typeof args.path === "string" ? args.path : liveSrcPath;
      const curForGuard = await readFile(editPath, "utf-8").catch(() => "");
      // Idempotence no-op ONLY when the edit already applied AND old_string survives
      // inside new_string (the prefix/superset case fs_edit's own "old_string not
      // found" fail-safe cannot catch). A FIRST edit whose new_string text merely
      // coincides with existing bytes must NOT be skipped, or a real change is dropped.
      alreadyApplied = guardNew.includes(guardOld) && curForGuard.includes(guardNew);
    }
    // CATASTROPHIC-TRUNCATION GUARD (2026-07-30): fs_write is for AUTHORING a
    // NET-NEW file (full contents). When the drafter issues fs_write against an
    // EXISTING non-trivial file, the LLM commonly emits a "full file" that
    // contains only the few functions it was reasoning about — silently deleting
    // thousands of lines of LIVE vessel source (observed 2026-07-30: goal-host
    // index.ts 9386 → 213 lines, then a 29-turn loop re-reading its own stub,
    // clobbering operator restores until development-vessel was restarted). An
    // fs_write must NEVER shrink an existing file below half its size; force a
    // surgical edit tool instead. Interim guard; overlay isolation is the
    // structural fix (gap critical-patch-with-tools-edits-live-vessel-source).
    let truncationBlocked = false;
    if (tool === "fs_write" && typeof args.content === "string") {
      const writePath = typeof args.path === "string" ? args.path : liveSrcPath;
      const curForTrunc = await readFile(writePath, "utf-8").catch(() => "");
      if (curForTrunc.length > 400 && args.content.length < curForTrunc.length * 0.5) {
        truncationBlocked = true;
        console.error(`[patch-with-tools] turn ${turn} fs_write BLOCKED: would shrink ${writePath} from ${curForTrunc.length} to ${args.content.length} chars (catastrophic truncation) — forcing surgical edit`);
      }
    }
    // DRIFT-PROOF: snapshot the pre-edit content of the exact path this edit tool is
    // about to mutate, BEFORE it runs (baseline-correct; a no-op guard means nothing
    // is written, so skip). Covers a drafter that aims an edit at a path other than
    // the declared target_file — restoreAllSnapshots then reverts it too.
    const isEditToolCall = tool === "fs_edit" || tool === "fs_write" || tool === "code_replace_lines" || tool === "code_insert_after_line" || tool === "code_add_import";
    if (isEditToolCall && !truncationBlocked && !alreadyApplied) {
      await snapshotBeforeEdit(typeof args.path === "string" ? args.path : liveSrcPath);
    }
    const result = escapedRoot
      ? { ok: false, body: { success: false, error: `path outside the run root ${vesselsRoot}/${vessel}; edit only files under the vessel you were given` } as unknown }
      : truncationBlocked
      ? { ok: false, body: { success: false, error: "fs_write REFUSED: it would replace an existing file with a much smaller full-file rewrite, DELETING most of the live source. fs_write is ONLY for authoring a NET-NEW file. To change an existing file use fs_edit { path, old_string, new_string } or code_replace_lines for a SURGICAL edit that preserves everything you are not changing." } as unknown }
      : alreadyApplied
      ? { ok: true, body: { success: true, noop: true, note: "new_string already present — edit already applied; do NOT re-apply it" } as unknown }
      : await callTool(toolsEndpoint, tool, args);
    console.error(`[patch-with-tools] turn ${turn} ${tool} -> ${result.ok ? "OK" : "ERR"}${alreadyApplied ? " (idempotent no-op)" : ""}: ${JSON.stringify(result.body).slice(0, 160)}`);
    history.push({ turn, thought_or_action: `call ${tool}(${JSON.stringify(args).slice(0, 200)})`, tool_result: { tool, args, result: result.body, ok: result.ok } });

    // VERIFIED-GREEN TERMINAL (2026-07-20, success-blindness fix): once an edit
    // has landed (applied or already-applied) and the vessel typechecks clean,
    // the patch IS done — terminate as success instead of waiting for the model
    // to emit done (it commonly keeps re-applying until the abort guards fire).
    const isEditTool = tool === "fs_edit" || tool === "code_replace_lines" || tool === "code_insert_after_line" || tool === "code_add_import" || tool === "fs_write";
    if (result.ok && isEditTool) {
      const curSrcAfterEdit = await readFile(liveSrcPath, "utf-8").catch(() => baseContent);
      if (createHash("sha256").update(curSrcAfterEdit).digest("hex").slice(0, 12) !== beforeSha) {
        const vesselDirVg = `${vesselsRoot}/${vessel}`;
        const tcVg = await callTool(toolsEndpoint, "code_verify_typecheck", { cwd: vesselDirVg });
        const tcVgBody = tcVg.body as { error_lines?: string[] } | undefined;
        const targetBaseVg = containerPath.split("/").pop() ?? containerPath;
        const targetErrorsVg = (tcVgBody?.error_lines ?? []).filter((l) => l.includes(targetBaseVg));
        // Grade by NEW errors vs the pre-edit baseline, not absolute cleanliness.
        const newTargetErrorsVg = targetErrorsVg.filter((l) => !baselineTargetErrors.has(l));
        if (newTargetErrorsVg.length === 0) {
          finalReason = `verified-green: ${tool} applied and typecheck clean (auto-done at turn ${turn})`;
          finished = true;
          console.error(`[patch-with-tools] turn ${turn} verified-green terminal — auto-done`);
          break;
        }
        history.push({
          turn,
          thought_or_action: `(verified-green check) edit applied but typecheck FAILED on ${targetBaseVg} — fix these errors before done`,
          tool_result: { tool: "code_typecheck", args: { cwd: vesselDirVg }, result: { error_lines: newTargetErrorsVg }, ok: false },
        });
        continue;
      }
    }

    // Loop-break on a stuck patcher (2026-06-14): the ReAct LLM can emit the
    // SAME malformed tool call (e.g. code_replace_lines missing `text`), get the
    // same error, and retry it identically until the iteration cap — burning the
    // whole budget without learning (observed: 11 identical code_replace_lines on
    // one line). Abort early when one (tool,args) signature fails >= 3 times so
    // the failure is reported promptly instead of masquerading as "cap reached".
    if (!result.ok) {
      const sig = `${tool}:${JSON.stringify(args)}`;
      const n = (failedCallCounts.get(sig) ?? 0) + 1;
      failedCallCounts.set(sig, n);
      if (n >= 3) {
        await resetTarget();
        return structuredError(
          `patch_with_tools: aborted — ${tool} failed ${n}× with the SAME args (likely a malformed call, e.g. a missing required field). Last error: ${JSON.stringify(result.body).slice(0, 200)}`,
          { history, before_sha: beforeSha, stuck_signature: sig },
        );
      }
    }
  }

    // Turn loop ended without finishing this attempt → record + maybe retry.
    if (!finished) {
      if (!attemptFailures.some((f) => f.startsWith(`attempt ${attempt}:`))) {
        attemptFailures.push(`attempt ${attempt}: iteration cap (${maxIters}) reached without done`);
      }
      // No-accumulation guard: if the two most recent attempts failed similarly,
      // stop — re-running won't improve coverage.
      if (attemptFailures.length >= 2) {
        const a = attemptFailures[attemptFailures.length - 1]!.replace(/^attempt \d+: /, "").slice(0, 50);
        const b = attemptFailures[attemptFailures.length - 2]!.replace(/^attempt \d+: /, "").slice(0, 50);
        if (a === b) break;
      }
    }
  }

  if (!finished) {
    // SALVAGE: the model may never emit `done` even after a CORRECT edit already landed
    // (LLM-plane flakiness, or a pre-dirty file that never grades absolutely clean). Before
    // discarding, if the live target now differs from baseline AND adds NO new target errors
    // vs baseline, treat it as verified and fall through to the SAME staging block below.
    const salvageSrc = await readFile(liveSrcPath, "utf-8").catch(() => baseContent);
    if (createHash("sha256").update(salvageSrc).digest("hex").slice(0, 12) !== beforeSha) {
      const tcSalvage = await callTool(toolsEndpoint, "code_verify_typecheck", { cwd: `${vesselsRoot}/${vessel}` });
      const tcSalvageBody = tcSalvage.body as { error_lines?: string[] } | undefined;
      const newErrs = (tcSalvageBody?.error_lines ?? []).filter((l) => l.includes(targetBaseName) && !baselineTargetErrors.has(l));
      if (newErrs.length === 0) {
        finished = true;
        finalReason = `salvaged: applied edit adds no new ${targetBaseName} errors vs baseline; staging despite no explicit done`;
        console.error(`[patch-with-tools] salvage terminal — staging applied edit despite no explicit done`);
      }
    }
  }

  if (!finished) {
    // RELIABLE REVERT: /vessels/<v> is NOT a git repo, so the old `git restore .` ALWAYS
    // failed and leaked half-applied edits into live (poisoning later runs). resetTarget()
    // is the deterministic revert (writeFile/unlink); assert it took, force a second pass.
    await resetTarget();
    const revertSrc = await readFile(liveSrcPath, "utf-8").catch(() => (isNewFile ? "" : baseContent));
    if (createHash("sha256").update(revertSrc).digest("hex").slice(0, 12) !== beforeSha) {
      await resetTarget();
      console.warn(`[patch-with-tools] live target still diverged after resetTarget — forced second revert (orphan-leak guard)`);
    }
    await clearAuthoringMarker(authoringMarkerPath);
    return structuredError(
      `patch_with_tools: ${attemptFailures.length} attempt(s) exhausted without a verified patch`,
      { history, before_sha: beforeSha, attempt_failures: attemptFailures },
    );
  }

  // Verify the live file actually changed.
  const afterSrc = await readFile(liveSrcPath, "utf-8");
  const afterSha = createHash("sha256").update(afterSrc).digest("hex").slice(0, 12);
  if (afterSha === beforeSha) {
    return structuredError("llm declared done but file unchanged", { history, before_sha: beforeSha, after_sha: afterSha });
  }

  // ORPHAN-INJECTION GATE (2026-07-27). The surgical patcher BYPASSES feature_compose's
  // dead-code / reachability gates and self-lands via triggerMitosisTick below, so a
  // hallucinated top-level declaration ships unchecked. EVIDENCE: a compose-report patch
  // injected an orphan `async function countAsyncFunctions()` into goal-host index.ts (wrong
  // path, dead on arrival) alongside a polluted regex. Reject when the patch ADDS a NEW,
  // column-0, NON-exported `function NAME` (name absent from the pre-patch file) that is
  // referenced NOWHERE else in the COMMENT/STRING/REGEX-stripped file. Scoped tightly to
  // FUNCTION declarations (const/let/var are ordinary values and too FP-prone); a genuine new
  // private helper has its call site (refs>=2); an exported helper starts with `export` and
  // never matches `^(async )?function`; a name appearing only inside a string/regex literal
  // (the observed regex pollution) is stripped, so the orphan's refs collapse to 1 and it is
  // caught. Fail-safe: revert live (nothing staged, nothing lands) + structuredError.
  if (!isNewFile) {
    const nameDecl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
    const beforeFns = new Set<string>();
    for (const bl of baseContent.split("\n")) { const m = nameDecl.exec(bl); if (m) beforeFns.add(m[1]!); }
    const codeOnly = afterSrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\n\\])+\/[gimsuy]*/g, "/RE/");
    for (const al of afterSrc.split("\n")) {
      const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(al); // NON-exported, column 0
      if (!m) continue;
      const name = m[1]!;
      if (beforeFns.has(name)) continue; // pre-existing function (modified body) — not a NEW injection
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refs = (codeOnly.match(new RegExp(`\\b${esc}\\b`, "g")) ?? []).length;
      if (refs <= 1) {
        await resetTarget();
        return structuredError("unrelated_diff_orphan_declaration", { target_file: pointer.target_file, orphan_symbol: name, before_sha: beforeSha, after_sha: afterSha });
      }
    }
  }

  // EXTERNAL-URL EGRESS GATE (2026-08-03). Like the orphan gate above, the surgical
// patcher self-lands via triggerMitosisTick and never runs feature_compose's
// detectArchitectureViolation — which is why 7ea7d52 landed a literal
// "https://new-llm-endpoint.com" into the drafter's own llmCall and passed every gate.
// REUSE that existing check rather than inventing a new one; only its L11 external-URL
// rule is hard-failed here (the other rules are advisory heuristics and would false-positive).
// The pseudo-diff prefixes the whole pre-image with "-" and the whole post-image with "+",
// which makes the check mean exactly "the host must already be present in the pre-image file".
// Corpus-tested over 200 substrate-authored commits: flags exactly 2 (7ea7d52 and 0b80f1b,
// both genuine fabricated-host egress), zero false positives — comment lines are skipped by
// the check, so revert commits quoting a bad URL do not trip it.
{
  const { detectArchitectureViolation } = await import("./feature-compose.js");
  const pseudoDiff =
    baseContent.split("\n").filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).map((l) => `-${l}`).join("\n") + "\n" +
    afterSrc.split("\n").map((l) => `+${l}`).join("\n");
  const egress = detectArchitectureViolation(pseudoDiff).filter((v) => v.law.includes("L11"));
  if (egress.length > 0) {
    await resetTarget();
    return structuredError("unsanctioned_external_egress", {
      target_file: pointer.target_file,
      law: egress[0]!.law,
      snippet: egress[0]!.snippet,
      detail: egress[0]!.detail,
      before_sha: beforeSha,
      after_sha: afterSha,
    });
  }
}

// REGION-CONTAINMENT GATE (2026-08-07). Same reasoning as the egress gate above, and
// the same reuse: this patcher self-lands via the mitosis cutover and never runs
// feature_compose's semantic gate, so a patch that edits the wrong part of the right
// file lands unjudged. EVIDENCE: 046d754 — a ui-feedback gap naming region
// "sub-fleet-elapsed" ("the elapsed column keeps counting after a run has finished")
// escalated here after a mechanical anchor failure and landed a patch on a DIFFERENT
// render site that HID the span after an hour. It fixes nothing (a finished run under
// an hour still counts up), it is the satisfy-by-destroying shape the compose judge
// exists to reject, and it reached the human's UI surface. Reverted as 78c675d.
//
// The escalation itself was legitimate — the trigger was `no_unique_anchor`, a
// mechanical failure, which is exactly what byte-anchored patching is for. What was
// missing is that the end of that route has no location check at all.
//
// Gated ONLY when the proposal names a region, so every other patch is unaffected.
{
  const { regionContainmentVerdict, regionFromProposalText } = await import("./feature-compose.js");
  const region = String(pointer.region ?? "").trim() || regionFromProposalText(String(pointer.proposal_text ?? ""));
  if (region) {
    // Touched lines = the multiset difference both ways. A line present in equal
    // counts on both sides was not touched, whatever moved around it.
    const count = (arr: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const beforeLines = baseContent.split("\n");
    const afterLines = afterSrc.split("\n");
    const bc = count(beforeLines);
    const ac = count(afterLines);
    const touched: string[] = [];
    for (const [l, n] of ac) { const d = n - (bc.get(l) ?? 0); for (let i = 0; i < d; i++) touched.push(l); }
    for (const [l, n] of bc) { const d = n - (ac.get(l) ?? 0); for (let i = 0; i < d; i++) touched.push(l); }
    const verdict = regionContainmentVerdict(touched, region, afterSrc);
    if (!verdict.contained) {
      await resetTarget();
      return structuredError("region_containment_failed", {
        target_file: pointer.target_file,
        region,
        detail: verdict.reason,
        before_sha: beforeSha,
        after_sha: afterSha,
      });
    }
  }
}

// Stage the modified file into a mitosis dir for the cutover machinery.
  const mitosisRoot = join(vesselsRoot, `${vessel}-mitosis-${stamp}`);
  const stagedFile = join(mitosisRoot, subPath);
  try {
    await mkdir(dirname(stagedFile), { recursive: true });
    await copyFile(liveSrcPath, stagedFile);
  } catch (err) {
    return structuredError(`stage write failed: ${(err as Error).message}`);
  }

  // Restore the live container file to its pre-patch state. The cutover will
  // apply the staged version via host-sync intent; we must not also mutate
  // the container behind the freshness gate. For a net-new file this UNLINKS
  // the just-authored file (resetTarget) — the staged copy is the source of
  // truth and cutover applies it; leaving the live stub would poison re-runs.
  await resetTarget();
  // Edit is now captured in the staged tree and live is deliberately at base; the
  // cutover owns the live landing. Suppress the finally snapshot-restore so it does
  // not clobber the cutover's applied content on the success path.
  stagedForLanding = true;

  const versionId = `mitosis-${stamp}`;
  const pendingPath = join(workspaceRoot, "mitosis-pending.json");
  const pendingBody = {
    vessel_name: vessel,
    base_version_id: "v1",
    mitosis_version_id: versionId,
    mitosis_root: mitosisRoot,
    base_sha: beforeSha,
    staged_at: new Date().toISOString(),
    authored_by: "patch_with_tools",
    gap_id: pointer.gap_id ?? `pwt-${vessel}-${subPath.split("/").pop() ?? subPath}-${createHash("sha256").update(`${pointer.target_file}\n${String(pointer.proposal_text ?? "").trim().replace(/\s+/g, " ")}`).digest("hex").slice(0, 8)}`,
    proposal: pointer.proposal_id ?? versionId,
    target_file: pointer.target_file,
    staged_files: [subPath],
    plan_turns: history.length,
    final_summary: finalReason,
  };
  try {
    await writeFile(pendingPath, JSON.stringify(pendingBody, null, 2));
  } catch (err) {
    return structuredError(`pending write failed: ${(err as Error).message}`);
  }

  await clearAuthoringMarker(authoringMarkerPath);
  const _landing = await triggerMitosisTick({ vessel, mitosisVersionId: versionId, mitosisRoot, stagedFiles: [subPath], baseSha: beforeSha, gapId: pendingBody.gap_id, proposalId: pendingBody.proposal }); // land the verified patch directly via the cutover
  return {
    shape: "mitosisStaged",
    body: {
      dispatched: true,
      landed: _landing.landed,
      landed_sha: _landing.new_git_sha,
      new_git_sha: _landing.new_git_sha,
      push_status: _landing.push_status,
      vessel_name: vessel,
      mitosis_root: mitosisRoot,
      mitosis_version_id: versionId,
      base_sha: beforeSha,
      staged_files: [subPath],
      pending_path: pendingPath,
      plan_turns: history.length,
      final_summary: finalReason,
      completed_at: new Date().toISOString(),
    },
  };
  } finally {
    // DRIFT-PROOF backstop: on ANY non-landing terminal outcome — gate reject,
    // drafter storm, exhausted attempts, an LLM-plane exhaustion `return`, or an
    // uncaught throw — restore EVERY touched file to its pre-op snapshot so a broken
    // edit can never strand in the LIVE /vessels source and crash the next restart.
    // Suppressed only once the edit is safely staged and the cutover owns the landing.
    if (!stagedForLanding) await restoreAllSnapshots();
  }
}
