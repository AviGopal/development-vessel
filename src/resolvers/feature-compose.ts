/**
 * feature_compose (2026-06-21) — the seed FEATURE composer.
 *
 * The substrate has two SURGICAL patchers (apply_proposal_as_patch,
 * patch_with_tools) and no FEATURE composer — so feature-sized self-improvement
 * proposals get drafted and then refused as non_surgical, and the operator fills
 * the gap by hand. This closes that gap WITHIN the framing: it composes the
 * existing surgical atoms (local-tools-vessel fs_write/fs_edit + code_verify_
 * typecheck) into a multi-file, multi-vessel change.
 *
 * Why it converges where patch_with_tools stalls: patch_with_tools is agentic
 * PER TURN (the LLM decides one tool call at a time and burns its turn budget
 * grazing the file). feature_compose PLANS ONCE (a single LLM call produces the
 * full ordered op list) then EXECUTES DETERMINISTICALLY — no per-step LLM
 * indecision. Verification (typecheck per touched vessel) gates the verdict;
 * UNFAVORABLE rolls the tree back so a bad plan never lands.
 *
 * Flow: decompose(spec) -> [ops] -> apply each (fs_write/fs_edit) -> verify
 * (typecheck each touched vessel) -> verdict FAVORABLE|UNFAVORABLE ->
 * rollback-on-fail. Landing (commit/push) is a SEPARATE downstream cutover step
 * — this resolver stages + reports, matching the mitosis-evaluate/cutover split.
 */
import { METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";
import { resolveVesselMitosisCutover } from "./vessel-mitosis-cutover.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";

const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
// In-container authoring targets the WRITABLE runtime (/vessels), like the
// surgical patchers (patch_with_tools/apply_proposal_as_patch use vessels_root
// "/vessels"). The host repo bind-mount is READ-ONLY from the container; a
// host-side poller bridges /vessels changes to git. Paths are repos/<vessel>/...
// in the plan and mapped to ${RUNTIME_ROOT}/<vessel>/... here.
const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
const REPO_ROOT = RUNTIME_ROOT;
const PER_CALL_TIMEOUT_MS = 90_000;

export interface FeatureComposePointer {
  type: "feature_compose";
  /** Free-text feature specification (what to build + concrete file/behaviour detail). */
  spec: string;
  /** Optional explicit vessel dirs to typecheck (relative to repo root, e.g. "repos/activity-api"). */
  verify_vessels?: string[];
  model?: string;
  /** If true: plan only, do not apply. */
  dry_run?: boolean;
  /** If true: keep edits on UNFAVORABLE instead of rolling back (for debugging). */
  keep_on_fail?: boolean;
  /** Hard cap on ops in a single plan (default 24). */
  max_ops?: number;
  /** On FAVORABLE, LAND each existing-vessel change through vessel-mitosis-cutover. */
  land?: boolean;
  /** Pass-through to the cutover: stage+commit but skip the actual git push (test). */
  skip_push?: boolean;
  /**
   * Gap context for the SEMANTIC cutover-verification gate (2026-06-25). When the
   * compose is driven by gap_to_feature, the gap is threaded through so the
   * semantic gate can (a) judge whether the diff GENUINELY addresses the gap on a
   * live path and (b) write `suspected_real_location` back onto the gap when the
   * drafter mis-localized. Absent (e.g. a free-text spec) → no gap-relative judge,
   * only the reachability hard-fail still applies.
   */
  gap?: { id?: string; summary?: string; classification_metadata?: Record<string, unknown>; category?: string };
}

interface PlanOp {
  kind: "create_file" | "edit";
  path: string;            // repo-relative, e.g. "repos/<vessel>/src/index.ts"
  content?: string;        // for create_file
  old_string?: string;     // for edit
  new_string?: string;     // for edit
  rationale?: string;
}

type Json = Record<string, unknown>;

async function llmCall(endpoint: string, prompt: string, model: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
    body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: 16000 }),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`llm fetch ${res.status}`);
  const j = (await res.json()) as { content?: string; data?: string; error?: string };
  if (j.error) throw new Error(`llm error: ${j.error}`);
  return (j.content ?? j.data ?? "").trim();
}

async function discover(shape: string): Promise<string | null> {
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> } };
    const vs = (data.content?.vessels ?? []).sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0));
    const best = vs[0];
    if (!best) return null;
    const ep = best.resolve_endpoint ?? "/resolve";
    return ep.startsWith("http") ? ep : `${best.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
  } catch { return null; }
}

async function callTool(endpoint: string, tool: string, args: Json): Promise<{ ok: boolean; body: Json }> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: tool, ...args } } }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    const errored =
      !res.ok || typeof body?.error === "string" || (body as { shape?: string })?.shape === "structuredError" || body?.success === false;
    return { ok: !errored, body };
  } catch (err) { return { ok: false, body: { error: (err as Error).message } }; }
}

function parseJsonObject(raw: string): Json | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
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

function vesselDirOf(repoRelPath: string): string | null {
  const m = repoRelPath.match(/^repos\/([^/]+)\//);
  return m ? `repos/${m[1]}` : null;
}

// ───────────────────────────── SEMANTIC CUTOVER-VERIFICATION GATE ─────────────────────────────
// (2026-06-25, lever 5) The orthogonal analogue of goal-host's reach-gate
// (`verifyGoalReached`): typecheck-clean ≠ gap-fixed, exactly as status=completed ≠
// goal-reached. After the typecheck/shape-dispatch verify PASSES and BEFORE the
// FAVORABLE/stage decision, judge whether the applied diff GENUINELY addresses the
// gap on a path that actually EXECUTES. A net-new `recordOutcome`/`isNoOpBody` with
// zero callers compiles fine yet changes nothing — that hollow landing is what this
// gate exists to reject. Two filters: (1) a deterministic, cheap reachability
// hard-fail (no LLM) when EVERY changed symbol is dead code, (2) an LLM semantic
// judge for the rest.

export const SEMANTIC_CUTOVER_GATE = (process.env.SEMANTIC_CUTOVER_GATE ?? "1") !== "0";

export interface ReachabilityFact {
  symbol: string;
  isNewFunction: boolean;     // function/const added by this diff (a `+` definition line)
  callerCount: number;        // call-sites in the touched vessel's src/, excluding the definition
  isEntrypoint: boolean;      // exported entrypoint / route handler / resolver dispatch case / lifecycle hook
  reachable: boolean;         // callerCount > 0 OR isEntrypoint
}

export interface SemanticGateVerdict {
  addresses: boolean;
  reason: string;
  on_live_path: boolean;
  suspected_real_location?: string;
  // provenance for logging/report
  hard_fail?: boolean;        // true when rejected by reachability alone (no LLM call made)
  llm_consulted: boolean;
}

/**
 * Parse a unified diff for the names of functions/consts the patch DEFINES or EDITS.
 * Cheap and grep-shaped (no full call-graph): we look at ADDED lines (`+`) for
 * `function NAME(`, `const NAME =`, `let NAME =`, method shorthand `NAME(...) {`,
 * and exported variants. A symbol seen on an added definition line is `isNewFunction`.
 * Symbols referenced inside an edited hunk (not as a new definition) still count as
 * "changed surface" so the judge sees them, but only added-definition symbols can be
 * the dead-code hard-fail trigger.
 */
export function extractChangedSymbols(diff: string): Array<{ symbol: string; isNewFunction: boolean }> {
  const out = new Map<string, boolean>(); // symbol -> isNewFunction (true wins)
  const defPatterns: RegExp[] = [
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/,
    /^\+\s*(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
    /^\+\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{/, // class/object method shorthand
  ];
  for (const rawLine of diff.split("\n")) {
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;
    for (const re of defPatterns) {
      const m = rawLine.match(re);
      if (m && m[1] && !RESERVED.has(m[1])) { out.set(m[1], true); break; }
    }
  }
  return [...out.entries()].map(([symbol, isNewFunction]) => ({ symbol, isNewFunction }));
}

const RESERVED = new Set(["if", "for", "while", "switch", "catch", "return", "function", "const", "let", "var", "async", "await", "new", "typeof"]);

/**
 * Decide the reachability hard-fail purely from the facts. HARD-FAIL (UNFAVORABLE,
 * no LLM) iff there is ≥1 changed symbol AND every changed symbol is unreachable
 * (callerCount===0 AND !isEntrypoint) — i.e. the patch only touches dead code. When
 * we could not extract any symbol from the diff, we do NOT hard-fail (the change may
 * be data/string/wiring the symbol extractor doesn't model); the LLM judge handles it.
 */
export function reachabilityHardFail(facts: ReachabilityFact[]): { hardFail: boolean; reason: string } {
  if (facts.length === 0) return { hardFail: false, reason: "no changed symbols extracted from diff (not a hard-fail)" };
  const reachable = facts.filter((f) => f.reachable);
  if (reachable.length === 0) {
    const names = facts.map((f) => f.symbol).join(", ");
    return {
      hardFail: true,
      reason: `dead-code-only patch: every changed symbol (${names}) has zero callers and is not an entrypoint — the change cannot execute`,
    };
  }
  return { hardFail: false, reason: `${reachable.length}/${facts.length} changed symbols reachable` };
}

function semanticJudgePrompt(
  gapSummary: string,
  gapMeta: Record<string, unknown> | undefined,
  diff: string,
  facts: ReachabilityFact[],
  codeContext: string,
): string {
  const metaStr = gapMeta ? `\n\nGap detector evidence:\n${JSON.stringify(gapMeta, null, 2)}` : "";
  return `You verify whether a self-authored CODE PATCH GENUINELY addresses a substrate gap, on a path that ACTUALLY EXECUTES. typecheck=clean does NOT mean the gap is fixed — many patches "compile" by adding dead code (a net-new function with zero callers) or by editing a path that never runs (hollow patch). This is the code analogue of hollow goal-completion.

GAP: ${gapSummary}${metaStr}

Reachability facts (deterministic, computed by grepping the touched vessel src/):
${JSON.stringify(facts, null, 2)}

Relevant existing code context (the symbol the gap names, and — if reachability found call-sites elsewhere — the live path):
${codeContext || "(none extracted)"}

Unified diff that was applied (and typechecked clean):
${diff.slice(0, 8000)}

Judge strictly. The patch ADDRESSES the gap only if it changes the behavior the gap describes AND that changed code is on a path that executes (called, routed, dispatched, or a lifecycle/entrypoint). If the patch edits a DIFFERENT symbol than the one the gap's real fix lives in (e.g. it adds \`recordOutcome\` when the live β-penalty path is \`penaliseHollowTemplate\`), report the right one in suspected_real_location.

Respond with ONLY JSON: {"addresses": boolean, "reason": "<1 sentence>", "on_live_path": boolean, "suspected_real_location": "<symbol or file:symbol the real fix belongs in, or empty>"}`;
}

/**
 * The semantic gate. Pure of I/O except for the injected `llm` call, so it is unit
 * testable. Computes the reachability hard-fail first (no LLM); if it survives,
 * consults the LLM judge. `llm` returns the raw model text; we JSON-extract it with
 * the same `{...}` slice goal-host uses. Any LLM failure is treated as a NON-block
 * (fail-open on the JUDGE only — the deterministic hard-fail already ran) so a flaky
 * haiku call cannot wedge the loop; the deterministic dead-code filter is the floor.
 */
export async function verifyPatchAddressesGap(args: {
  gapSummary: string;
  gapMeta?: Record<string, unknown>;
  diff: string;
  reachability: ReachabilityFact[];
  codeContext?: string;
  llm: (prompt: string) => Promise<string>;
}): Promise<SemanticGateVerdict> {
  const { hardFail, reason } = reachabilityHardFail(args.reachability);
  if (hardFail) {
    return { addresses: false, reason, on_live_path: false, hard_fail: true, llm_consulted: false };
  }
  let raw = "";
  try {
    raw = await args.llm(semanticJudgePrompt(args.gapSummary, args.gapMeta, args.diff, args.reachability, args.codeContext ?? ""));
  } catch (e) {
    // Judge unreachable: do NOT block on the judge alone (the deterministic floor
    // already passed). Treat as addresses=true-but-unverified so a flaky LLM cannot
    // wedge landing; log surfaces it.
    return { addresses: true, reason: `semantic judge unavailable (${(e as Error).message}); passed deterministic reachability floor`, on_live_path: true, llm_consulted: false };
  }
  const m = raw.match(/\{[\s\S]*\}/);
  const parsed = m ? (parseJsonObject(m[0]) as Partial<SemanticGateVerdict> | null) : null;
  if (!parsed || typeof parsed.addresses !== "boolean") {
    return { addresses: true, reason: "semantic judge returned unparseable verdict; passed deterministic reachability floor", on_live_path: true, llm_consulted: true };
  }
  const sus = typeof parsed.suspected_real_location === "string" && parsed.suspected_real_location.trim()
    ? parsed.suspected_real_location.trim()
    : undefined;
  return {
    addresses: parsed.addresses,
    reason: String(parsed.reason ?? ""),
    on_live_path: parsed.on_live_path !== false,
    ...(sus ? { suspected_real_location: sus } : {}),
    llm_consulted: true,
  };
}

function decomposePrompt(spec: string, maxOps: number, grounding: string, principles: string): string {
  return `You are a senior engineer decomposing a feature specification into a CONCRETE, ORDERED plan of file operations. Output is executed deterministically — there is no follow-up turn, so the plan must be COMPLETE and CORRECT.

Repo root contains vessels at repos/<vessel>/. Each vessel is a Bun + TypeScript project with its own tsconfig.json. Edits must compile (\`bun run typecheck\`).

FEATURE SPEC:
${spec}
${principles ? `
ARCHITECTURAL PRINCIPLES (the substrate's own, retrieved from its concept graph — your plan MUST respect these; e.g. reuse an existing producer before minting a new one, match existing contracts/return shapes, keep edits surgical):
${principles}
` : ""}
${grounding ? `
GROUND TRUTH — the ACTUAL files (and, where shown, their current contents) in the target vessel(s). Use this to bind to REALITY, not assumptions:
- For every \`edit\` op, \`path\` MUST be one of these real paths (an \`edit\` to a path NOT listed fails at apply, ENOENT). Only \`create_file\` may introduce a NEW path.
- Do NOT invent file names: if the spec says "the X endpoint" / "the Y handler / method", find the real file below that defines it and edit THAT one.
- Read the CURRENT CONTENTS before adding anything: do NOT add a field/key/method that already exists (it causes a duplicate-property or redeclaration error), and match the existing types, response interfaces, and call signatures shown. If the response is a typed object/interface, update BOTH the object literal AND its type declaration.
- Your \`old_string\` for an edit must be a verbatim substring of the content shown below.

${grounding}
` : ""}

Emit ONE JSON object, no markdown fences, with this exact schema:
{
  "summary": "<one line>",
  "touched_vessels": ["repos/<vessel>", ...],   // dirs to typecheck after applying
  "ops": [
    // create a NET-NEW file (full contents):
    { "kind": "create_file", "path": "repos/<vessel>/<subpath>", "content": "<FULL file contents>", "rationale": "<why>" },
    // edit an EXISTING file (exact-substring replace; old_string MUST be a verbatim unique substring of the current file):
    { "kind": "edit", "path": "repos/<vessel>/<subpath>", "old_string": "<verbatim current text>", "new_string": "<replacement>", "rationale": "<why>" }
  ]
}

RULES:
- At most ${maxOps} ops. Order them so dependencies come first (create files before editing references to them).
- create_file content must be COMPLETE and typecheck-clean on its own. Prefer ZERO external npm imports for net-new vessels (use Bun built-ins: Bun.serve, fetch, process.env) so no dependency install is needed. Include a tsconfig.json and package.json for any net-new vessel.
- edit old_string must be copied VERBATIM and be UNIQUE in the target file; keep it minimal but unambiguous. Preserve everything you are not changing.
- Do NOT invent file paths that must already exist without being sure; for edits, target real files named in the spec.
- STRICT TYPESCRIPT (the vessels compile with strict mode incl. \`noUncheckedIndexedAccess\`): every array/object index access (\`arr[i]\`, \`map[k]\`, \`str[i]\`) is typed \`T | undefined\` — you MUST guard it (\`?? fallback\`) or non-null-assert it (\`arr[i]!\`) when you know it is in-range, or tsc fails TS2532/TS18048. Avoid \`any\`. Type every function parameter and return.
- MATCH EXISTING CONTRACTS: when adding a resolver/handler to an existing vessel, make its return type match what the dispatch site expects — in these vessels a resolver returns \`{ shape: string, body: ... }\` (the \`ResolverResult\` shape), NOT a bespoke object; read the dispatch file's other cases and mirror their shape exactly.
- OUTPUT FORMAT IS STRICT: respond with ONLY the JSON object. Start your response with the character \`{\` and end with \`}\`. Do NOT write any reasoning, explanation, preamble, or markdown — not even before the JSON. Any prose wastes the output budget and can truncate the plan.`;
}

// CONSULTATION-ON-AUTHOR (2026-06-28): before planning, concept_search the substrate's
// own architectural principles (the docs ingested into concept-db, + any web evidence)
// and inject the top matches so the plan RESPECTS them — the active-consumption wire that
// makes the docs/web a LEARNED source, not just a stored one. Read-only; advisory.
const CONCEPT_DB_ENDPOINT = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
async function consultPrinciples(spec: string): Promise<string> {
  try {
    const params = new URLSearchParams({ query: spec.slice(0, 400), shape: "architecturePrinciple", limit: "4" });
    const res = await fetch(`${CONCEPT_DB_ENDPOINT}/concepts/search?${params.toString()}`, {
      headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { concepts?: Array<{ summary?: string; content?: string }> };
    const items = (j.concepts ?? []).slice(0, 4);
    if (!items.length) return "";
    return items
      .map((c, i) => `${i + 1}. ${String(c.summary ?? "").trim()}\n   ${String(c.content ?? "").replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n");
  } catch {
    return "";
  }
}

// SHAPE-GROUNDING (2026-06-28): resolve the target vessel's ACTUAL file tree
// BEFORE planning so the plan binds edits to real paths instead of hallucinating
// them (observed: the planner invented `registry-stats.ts`, which does not exist,
// → ENOENT → UNFAVORABLE rollback). The file tree IS the code-structure shape;
// resolving it pre-plan is the authoring analogue of the walk gating activities on
// `input_shapes ⊆ pool` — a file path becomes RESOLVED DATA, not an LLM guess.
// Best-effort: when the tree can't be read the planner falls back to ungrounded.
// Grounding resolves the code-structure shape at TWO resolutions (the finer/coarser
// dial): the COARSE level (the file tree) fixes hallucinated PATHS; the FINER level
// (current file CONTENTS) fixes API-level mistakes — duplicating a field that already
// exists (TS1117), calling a method that isn't there, mismatching a typed response.
// Content is injected only while a total byte budget holds, so small vessels get full
// content (finest grain) and large vessels degrade to tree-only (coarse) automatically.
const GROUND_CONTENT_BUDGET = 26_000;
async function groundVesselFiles(toolsEndpoint: string, verifyVessels: string[]): Promise<string> {
  const blocks: string[] = [];
  let contentBudget = GROUND_CONTENT_BUDGET;
  for (const v of verifyVessels.slice(0, 6)) {
    const vRel = v.replace(/^repos\//, "");
    const vAbs = `${REPO_ROOT}/${vRel}`;
    try {
      const sh = await callTool(toolsEndpoint, "shell", {
        command: `cd ${JSON.stringify(vAbs)} 2>/dev/null && find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) 2>/dev/null | sort | head -400`,
        cwd: REPO_ROOT,
      });
      const raw = String((sh.body as { stdout?: unknown })?.stdout ?? "").trim();
      if (!raw) continue;
      const files = raw.split("\n").filter(Boolean);
      const tree = files.map((f) => `  repos/${vRel}/${f}`).join("\n");
      // FINER grain: inject current contents while the byte budget holds. The
      // apply step already fs_reads for edits; this lets the PLANNER see existing
      // symbols/fields up front so it doesn't author a duplicate or a wrong call.
      const contentParts: string[] = [];
      for (const f of files) {
        if (contentBudget <= 0) break;
        try {
          const rd = await callTool(toolsEndpoint, "fs_read", { path: `${vAbs}/${f}` });
          const content = (rd.body as { content?: unknown })?.content;
          if (rd.ok && typeof content === "string") {
            const slice = content.slice(0, Math.min(content.length, contentBudget, 6000));
            contentBudget -= slice.length;
            const truncated = slice.length < content.length ? "\n… (truncated)" : "";
            contentParts.push(`----- repos/${vRel}/${f} -----\n${slice}${truncated}`);
          }
        } catch { /* per-file content best-effort */ }
      }
      const contentSection = contentParts.length ? `\n\nCURRENT CONTENTS:\n${contentParts.join("\n\n")}` : "";
      blocks.push(`repos/${vRel}/ FILES:\n${tree}${contentSection}`);
    } catch { /* grounding is advisory; an unreadable tree falls back to ungrounded planning */ }
  }
  return blocks.join("\n\n");
}

export async function resolveFeatureCompose(pointer: FeatureComposePointer): Promise<ResolverResult> {
  const model = pointer.model ?? "anthropic/claude-sonnet-4-6";
  const maxOps = pointer.max_ops ?? 24;
  const dryRun = pointer.dry_run ?? false;

  const llmEndpoint = await discover("llm_completion") ?? await discover("llmCompletion");
  const toolsEndpoint = await discover("shellResult");
  if (!llmEndpoint || !toolsEndpoint) {
    return { shape: "featureComposeReport", body: { ok: false, error: `endpoint discovery failed (llm=${!!llmEndpoint}, tools=${!!toolsEndpoint})` } };
  }

  // 1. DECOMPOSE (single planning call), GROUNDED in the target vessel's real
  // file tree so edits bind to paths that actually exist (no hallucinated paths).
  const verifyVessels = pointer.verify_vessels ?? [];
  let grounding = "";
  if (verifyVessels.length > 0) {
    try { grounding = await groundVesselFiles(toolsEndpoint, verifyVessels); } catch { grounding = ""; }
  }
  // CONSULT the substrate's own architectural principles (docs ingested as concepts)
  // so the plan respects them — the active-consumption wire for the docs/web channel.
  let principles = "";
  try { principles = await consultPrinciples(pointer.spec); } catch { principles = ""; }
  let planRaw: string;
  try {
    planRaw = await llmCall(llmEndpoint, decomposePrompt(pointer.spec, maxOps, grounding, principles), model);
  } catch (e) {
    return { shape: "featureComposeReport", body: { ok: false, stage: "decompose", error: (e as Error).message } };
  }
  const plan = parseJsonObject(planRaw);
  const ops = (plan?.ops as PlanOp[] | undefined) ?? [];
  if (!plan || !Array.isArray(ops) || ops.length === 0) {
    return { shape: "featureComposeReport", body: { ok: false, stage: "decompose", error: "plan had no ops", plan_raw: planRaw.slice(0, 1200) } };
  }
  if (ops.length > maxOps) ops.length = maxOps;

  const touched = new Set<string>((plan.touched_vessels as string[] | undefined) ?? []);
  for (const op of ops) { const d = vesselDirOf(op.path); if (d) touched.add(d); }

  const planView = ops.map((o) => ({ kind: o.kind, path: o.path, rationale: o.rationale }));
  if (dryRun) {
    return { shape: "featureComposeReport", body: { ok: true, stage: "plan", summary: plan.summary, touched_vessels: [...touched], ops: planView, op_count: ops.length } };
  }

  // 2. APPLY deterministically. Track created/edited for rollback.
  const created: string[] = [];
  const edited: string[] = [];
  // Pre-edit content snapshot (abs -> original bytes), captured the FIRST time we
  // touch a file, so an UNFAVORABLE verdict can RESTORE it. /vessels is NOT a git
  // repo, so the old `git checkout` rollback silently no-op'd and left broken
  // edits live in the runtime (defect #2). Snapshot+restore reverts only the
  // files we edited, exactly, with no git dependency.
  const preEditContent = new Map<string, string>();
  const applied: Array<{ path: string; kind: string; ok: boolean; repaired?: boolean; detail?: string }> = [];
  let applyFailed = false;
  for (const op of ops) {
    const abs = `${REPO_ROOT}/${op.path.replace(/^repos\//, "")}`;
    if (op.kind === "create_file") {
      // local-tools fs_write does not create parent dirs — mkdir -p first so
      // net-new vessel files (in a not-yet-existing dir) land.
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      await callTool(toolsEndpoint, "shell", { command: `mkdir -p ${JSON.stringify(dir)}`, cwd: REPO_ROOT });
      const r = await callTool(toolsEndpoint, "fs_write", { path: abs, content: op.content ?? "" });
      applied.push({ path: op.path, kind: op.kind, ok: r.ok, detail: r.ok ? undefined : JSON.stringify(r.body).slice(0, 200) });
      if (r.ok) created.push(abs); else { applyFailed = true; break; }
    } else {
      // Snapshot the original content BEFORE the first edit to this file, for a
      // reliable (non-git) rollback on UNFAVORABLE.
      if (!preEditContent.has(abs)) {
        const snap = await callTool(toolsEndpoint, "fs_read", { path: abs });
        const c = (snap.body as { content?: unknown })?.content;
        if (snap.ok && typeof c === "string") preEditContent.set(abs, c);
      }
      // GROUND THE OLD_STRING PROACTIVELY (2026-06-25). Plan-once decomposition
      // guesses old_string WITHOUT reading the file, so edits on existing files
      // (especially large ones — e.g. registering a resolver in a big switch) fail
      // "old_string not found" and the whole authoring rolls back. This was the
      // binding constraint on the leaf→authoring loop (a goal-discovered capability
      // gap could author a NEW file but never land the registration edit). We
      // already snapshotted the live content above; if the planned old_string is
      // absent verbatim, re-derive a matching SHORT anchor from the live content
      // up front — rather than waiting for the post-failure repair, which fires too
      // late and mis-parses multi-line strings. Only an old_string verified to
      // appear verbatim in the live content is used.
      const liveContent = preEditContent.get(abs) ?? "";
      let effOld = op.old_string ?? "";
      let groundedPre = false;
      if (liveContent && (!effOld || !liveContent.includes(effOld))) {
        try {
          const g = parseJsonObject(await llmCall(
            llmEndpoint,
            `Current full content of ${op.path}:\n\n${liveContent}\n\nMake this change: ${op.rationale ?? ""}\nIntended new content/behaviour:\n${op.new_string ?? ""}\n\nReturn ONE JSON object {"old_string":"<a SHORT, verbatim, UNIQUE substring copied EXACTLY from the content above — prefer a single line; it MUST appear verbatim>","new_string":"<replacement for that exact substring, preserving everything not being changed>"}. No prose, no fences. Escape newlines as \\n.`,
            model,
          ));
          if (g?.old_string && liveContent.includes(String(g.old_string))) {
            effOld = String(g.old_string);
            if (typeof g.new_string === "string") op.new_string = String(g.new_string);
            groundedPre = true;
          }
        } catch { /* fall through to the planned old_string + post-failure repair */ }
      }
      let r = await callTool(toolsEndpoint, "fs_edit", { path: abs, old_string: effOld, new_string: op.new_string ?? "" });
      let repaired = groundedPre && r.ok;
      if (!r.ok) {
        // Blind-edit repair: plan-once decomposition can guess an old_string that
        // does not match the LIVE file (it planned without reading it). Read the
        // real content and re-derive a verbatim old_string for the intended
        // change, then retry once. This grounds edits in reality.
        const cat = await callTool(toolsEndpoint, "shell", { command: `cat ${JSON.stringify(abs)}`, cwd: REPO_ROOT });
        const live = String((cat.body as { stdout?: unknown })?.stdout ?? "");
        if (live) {
          try {
            const fix = parseJsonObject(await llmCall(
              llmEndpoint,
              `Current full content of ${op.path}:\n\n${live}\n\nMake this change: ${op.rationale ?? ""}\nIntended replacement behaviour:\n${op.new_string ?? ""}\n\nEmit ONE JSON object {"old_string":"<verbatim UNIQUE substring copied from the content above>","new_string":"<replacement>"}. old_string MUST appear verbatim in the content above. No prose, no fences.`,
              model,
            ));
            if (fix?.old_string) {
              r = await callTool(toolsEndpoint, "fs_edit", { path: abs, old_string: String(fix.old_string), new_string: String(fix.new_string ?? op.new_string ?? "") });
              repaired = r.ok;
            }
          } catch { /* repair failed; r stays not-ok */ }
        }
      }
      applied.push({ path: op.path, kind: op.kind, ok: r.ok, repaired, detail: r.ok ? undefined : JSON.stringify(r.body).slice(0, 200) });
      if (r.ok) { if (!edited.includes(abs)) edited.push(abs); } else { applyFailed = true; break; }
    }
  }

  // 3. VERIFY: typecheck each touched vessel. FAIL-CLOSED on the AUTHORITATIVE
  // signal — the tool's own exit_code (tsc exits non-zero on ANY error) and its
  // ok flag. The old code trusted error_count (which was ALWAYS 0 because
  // code_verify_typecheck scanned stderr while tsc writes to stdout) and checked
  // the wrong key (`exitCode` vs the tool's `exit_code`), so verify ALWAYS passed
  // → typecheck-broken edits were committed as FAVORABLE (e.g. a stale-gap wiring
  // with 7 TS errors). Require: tool call ok AND tool ok===true AND exit_code===0
  // AND no parsed TS errors. Anything ambiguous (missing exit_code, failed call)
  // is treated as NOT ok so a bad/unverifiable edit cannot land.
  // Verify with the vessel's OWN lint contract (strict tsc + e.g. shape-dispatch
  // agreement), NOT just tsc. A missing dispatch-case registration is typecheck-
  // clean but lint-broken; that incompleteness must block the cutover, else the
  // system "authors" a shape it advertises but cannot route. Falls back to the
  // typecheck tool when a vessel has no lint script.
  // Verify = strict tsc PLUS the shared shape-dispatch agreement check (run
  // DIRECTLY from packages/, because the per-vessel `bun run lint` wrapper script
  // is not synced into the container). The dispatch check only constrains a vessel
  // that has the config.shapes↔impulses.ts switch pattern; if the shared checker is
  // absent or N/A it is treated as pass, so it never false-fails other vessels. The
  // point: a missing dispatch-case registration is typecheck-clean but a real
  // INCOMPLETE wiring — gating on it forces the system to author a ROUTABLE shape.
  const SHARED_DISPATCH_CHECK = "/vessels/packages/shape-dispatch-check/check.ts";
  const runVerify = async (v: string): Promise<{ vessel: string; errors: number | string; exit_code: number | null; ok: boolean; output: string }> => {
    const vAbs = `${REPO_ROOT}/${v.replace(/^repos\//, "")}`;
    const sh = await callTool(toolsEndpoint, "shell", {
      command: `cd ${JSON.stringify(vAbs)} && (echo "== typecheck =="; bun run typecheck 2>&1; echo "TC_EXIT=$?"; echo "== shape-dispatch =="; if [ -f ${SHARED_DISPATCH_CHECK} ] && [ -f src/config.ts ] && [ -f src/routes/impulses.ts ]; then bun ${SHARED_DISPATCH_CHECK} ${JSON.stringify(vAbs)} 2>&1; echo "SD_EXIT=$?"; else echo "SD_EXIT=0"; fi)`,
      cwd: REPO_ROOT,
    });
    const raw = String((sh.body as { stdout?: unknown })?.stdout ?? "");
    const tc = raw.match(/TC_EXIT=(\d+)/); const sd = raw.match(/SD_EXIT=(\d+)/);
    const tcExit = tc && tc[1] ? parseInt(tc[1], 10) : null;
    const sdExit = sd && sd[1] ? parseInt(sd[1], 10) : 0;
    const ok = tcExit === 0 && sdExit === 0;
    return { vessel: v, errors: ok ? 0 : "verify", exit_code: tcExit, ok, output: raw.trim() };
  };
  let verify: Array<{ vessel: string; errors: number | string; exit_code: number | null; ok: boolean; output: string }> = [];
  if (!applyFailed) { for (const v of touched) verify.push(await runVerify(v)); }

  // TYPECHECK-REPAIR loop (2026-06-25). LLM-authored code routinely carries 1-2
  // trivial strict-TS errors (TS2532 possibly-undefined, TS18048, etc.) that block
  // an otherwise-correct authoring from landing — observed as the binding
  // constraint on the leaf→authoring loop right after edit-grounding was fixed.
  // Feed the REAL tsc errors + current file content back to the LLM, rewrite the
  // offending file, re-verify; bounded. This is the verify-side analogue of the
  // edit-grounding fix and is what makes the loop reliably LAND, not just apply.
  // On failure to repair, verdict stays UNFAVORABLE and the existing rollback
  // fires — so worst case is unchanged.
  const MAX_REPAIR = 4;
  for (let attempt = 0; attempt < MAX_REPAIR && !applyFailed && verify.length > 0 && !verify.every((v) => v.ok); attempt++) {
    let anyFixed = false;
    for (const fv of verify.filter((v) => !v.ok)) {
      const errText = (fv.output || "").trim();
      if (!errText) continue;
      try {
        // One SURGICAL fix per round per failing vessel. The LLM names the file and
        // a verbatim old_string/new_string; we READ that file, confirm the anchor,
        // and apply. This fixes strict-TS errors AND completes wiring (e.g. adds a
        // missing dispatch case for an advertised shape) — multi-file lint failures
        // converge over successive rounds. Full-file rewrites corrupt large files,
        // so we never ask for them.
        const fix = parseJsonObject(await llmCall(
          llmEndpoint,
          `A change to vessel ${fv.vessel} fails \`bun run lint\` (strict tsc + shape-dispatch agreement: every advertised shape in src/config.ts MUST have a matching case in src/routes/impulses.ts and vice-versa). Lint output:\n\n${errText.slice(0, 4000)}\n\nPick the SINGLE most-blocking error and emit ONE JSON object {"file":"repos/${fv.vessel.replace(/^repos\//, "")}/<subpath>","old_string":"<a SHORT verbatim UNIQUE substring of that file's CURRENT content>","new_string":"<corrected replacement>"} that fixes it, changing as little else as possible. For a missing dispatch case, copy the shape into the switch next to a sibling case. old_string MUST appear verbatim. No prose, no fences. Escape newlines as \\n.`,
          model,
        ));
        const ef = typeof fix?.file === "string" ? String(fix.file) : "";
        const efAbs = ef ? `${REPO_ROOT}/${ef.replace(/^repos\//, "")}` : "";
        if (fix?.old_string && efAbs) {
          const cur = await callTool(toolsEndpoint, "fs_read", { path: efAbs });
          const curContent = (cur.body as { content?: unknown })?.content;
          if (cur.ok && typeof curContent === "string" && curContent.includes(String(fix.old_string))) {
            if (!preEditContent.has(efAbs) && !created.includes(efAbs)) preEditContent.set(efAbs, curContent);
            const w = await callTool(toolsEndpoint, "fs_edit", { path: efAbs, old_string: String(fix.old_string), new_string: String(fix.new_string ?? "") });
            if (w.ok) { anyFixed = true; if (!edited.includes(efAbs) && !created.includes(efAbs)) edited.push(efAbs); }
          }
        }
      } catch { /* repair attempt failed; verify stays not-ok */ }
    }
    if (!anyFixed) break;
    verify = [];
    for (const v of touched) verify.push(await runVerify(v));
  }

  const typecheckPass = !applyFailed && verify.every((v) => v.ok) && verify.length > 0;
  let verdict: "FAVORABLE" | "UNFAVORABLE" = typecheckPass ? "FAVORABLE" : "UNFAVORABLE";

  // 3b. SEMANTIC GATE (2026-06-25, lever 5 — the reach-gate applied to code). Only
  // a typecheck-clean patch reaches here. typecheck=clean ≠ gap-fixed: a net-new
  // dead-code function (zero callers) or an edit to a non-executing path compiles
  // fine yet changes nothing — the hollow landing this gate rejects. Reachability
  // hard-fail (deterministic, no LLM) first; LLM judge second. addresses=false OR
  // on_live_path=false → flip FAVORABLE→UNFAVORABLE (rolls back below, gap stays open
  // + informed). Skip when the gate is flag-disabled or there were no edits to judge.
  let semantic_gate: (SemanticGateVerdict & { skipped?: string }) | null = null;
  if (verdict === "FAVORABLE" && SEMANTIC_CUTOVER_GATE) {
    const editedTouched = touched && [...touched].length > 0;
    if (!editedTouched) {
      semantic_gate = { addresses: true, reason: "no touched vessel to judge", on_live_path: true, llm_consulted: false, skipped: "no_touched" };
    } else {
      // Build the unified diff from the pre-edit snapshots vs the live (post-edit)
      // content of each edited file (created files are net-new — diff them against
      // /dev/null). /vessels is not a git repo, so we reconstruct the diff with
      // `diff -u` against a temp copy of the original bytes rather than `git diff`.
      const diffParts: string[] = [];
      for (const [abs, original] of preEditContent) {
        const tmp = `/tmp/fc-orig-${Math.random().toString(36).slice(2)}`;
        await callTool(toolsEndpoint, "fs_write", { path: tmp, content: original });
        const d = await callTool(toolsEndpoint, "shell", { command: `diff -u ${JSON.stringify(tmp)} ${JSON.stringify(abs)} | sed '1,2s#.*#--- a/${abs.replace(/^.*\/repos\//, "").replace(/[#&]/g, "_")}#'; rm -f ${JSON.stringify(tmp)}`, cwd: REPO_ROOT });
        const dt = String((d.body as { stdout?: unknown })?.stdout ?? "");
        if (dt.trim()) diffParts.push(`### ${abs}\n${dt}`);
      }
      for (const abs of created) {
        const cur = await callTool(toolsEndpoint, "fs_read", { path: abs });
        const c = (cur.body as { content?: unknown })?.content;
        if (typeof c === "string") diffParts.push(`### NEW FILE ${abs}\n` + c.split("\n").map((l) => `+${l}`).join("\n"));
      }
      const diff = diffParts.join("\n\n");

      // Reachability facts: for each changed symbol, grep the touched vessels' src/
      // for call-sites (excluding the definition) + classify as entrypoint.
      const symbols = extractChangedSymbols(diff);
      const facts: ReachabilityFact[] = [];
      for (const { symbol, isNewFunction } of symbols) {
        let callerCount = 0;
        let isEntrypoint = false;
        let codeHit = "";
        for (const v of touched) {
          const vAbs = `${REPO_ROOT}/${v.replace(/^repos\//, "")}/src`;
          // Call-sites: `\bSYMBOL\s*(` across src/, minus the definition lines
          // (function/const/let/var/method NAME). Count distinct hit lines.
          const callQ = await callTool(toolsEndpoint, "shell", {
            command: `grep -rEn "\\b${symbol}[[:space:]]*\\(" ${JSON.stringify(vAbs)} 2>/dev/null | grep -vE "(function|const|let|var)[[:space:]]+${symbol}\\b" | grep -vE "^[^:]+:[0-9]+:[[:space:]]*${symbol}[[:space:]]*\\([^)]*\\)[[:space:]]*(:[^={]+)?\\{" || true`,
            cwd: REPO_ROOT,
          });
          const callOut = String((callQ.body as { stdout?: unknown })?.stdout ?? "").trim();
          if (callOut) { callerCount += callOut.split("\n").filter(Boolean).length; codeHit ||= callOut.split("\n").slice(0, 4).join("\n"); }
          // Entrypoint: exported, OR a route/dispatch/lifecycle reference to the symbol.
          const entQ = await callTool(toolsEndpoint, "shell", {
            command: `grep -rEn "(export[[:space:]]+(async[[:space:]]+)?(function|const|let)[[:space:]]+${symbol}\\b|case[[:space:]]+[\\"']${symbol}[\\"']|['\\"]${symbol}['\\"][[:space:]]*[:,)]|\\.(on|get|post|put|delete|use)\\([^)]*${symbol}|router\\.[a-z]+\\([^)]*${symbol})" ${JSON.stringify(vAbs)} 2>/dev/null || true`,
            cwd: REPO_ROOT,
          });
          if (String((entQ.body as { stdout?: unknown })?.stdout ?? "").trim()) isEntrypoint = true;
        }
        facts.push({ symbol, isNewFunction, callerCount, isEntrypoint, reachable: callerCount > 0 || isEntrypoint });
        void codeHit;
      }

      // Code context for the judge: include the function(s) the gap names + any live
      // call-site we found (so the judge can spot mis-localization).
      let codeContext = "";
      const gapSummary = String(pointer.gap?.summary ?? pointer.spec.split("\n").find((l) => l.trim()) ?? "");
      const gapNamed = (gapSummary.match(/\b[A-Za-z_$][\w$]{3,}\b/g) ?? []).filter((w) => /[A-Z_]/.test(w)).slice(0, 6);
      for (const name of new Set([...gapNamed, ...facts.filter((f) => f.reachable).map((f) => f.symbol)])) {
        for (const v of touched) {
          const vAbs = `${REPO_ROOT}/${v.replace(/^repos\//, "")}/src`;
          const g = await callTool(toolsEndpoint, "shell", { command: `grep -rEn "\\b${name}\\b" ${JSON.stringify(vAbs)} 2>/dev/null | head -8 || true`, cwd: REPO_ROOT });
          const gt = String((g.body as { stdout?: unknown })?.stdout ?? "").trim();
          if (gt) { codeContext += `\n# ${name} in ${v}:\n${gt}\n`; if (codeContext.length > 6000) break; }
        }
        if (codeContext.length > 6000) break;
      }

      const llmJudge = (prompt: string) => llmCall(llmEndpoint, prompt, model);
      semantic_gate = await verifyPatchAddressesGap({
        gapSummary,
        gapMeta: pointer.gap?.classification_metadata,
        diff,
        reachability: facts,
        codeContext,
        llm: llmJudge,
      });

      console.log(`[development-vessel] semantic-gate ${JSON.stringify({
        gap_id: pointer.gap?.id ?? null,
        reachable_symbols: facts.filter((f) => f.reachable).map((f) => f.symbol),
        unreachable_symbols: facts.filter((f) => !f.reachable).map((f) => f.symbol),
        addresses: semantic_gate.addresses,
        on_live_path: semantic_gate.on_live_path,
        hard_fail: semantic_gate.hard_fail ?? false,
        suspected_real_location: semantic_gate.suspected_real_location ?? null,
        reason: semantic_gate.reason,
      })}`);

      if (!semantic_gate.addresses || semantic_gate.on_live_path === false) {
        verdict = "UNFAVORABLE";
        // Mis-localization feedback: when the judge named the real fix site, write it
        // onto the gap so the next draft targets the right code. Best-effort.
        if (pointer.gap?.id && semantic_gate.suspected_real_location) {
          try {
            const read = await resolveSubstrateGap({ type: "substrateGap", id: pointer.gap.id, limit: 1 } as never);
            const g0 = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps ?? [])[0];
            if (g0) {
              const meta = { ...((g0.classification_metadata as Record<string, unknown>) ?? {}), suspected_real_location: semantic_gate.suspected_real_location, semantic_gate_reason: semantic_gate.reason };
              await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...(g0 as Record<string, unknown>), classification_metadata: meta } } as never);
            }
          } catch { /* gap writeback best-effort; verdict already UNFAVORABLE */ }
        }
      }
    }
  }

  // 4. ROLLBACK on UNFAVORABLE (restore edited, delete created) unless asked to keep.
  // Restore each edited file from its pre-edit snapshot (NOT `git checkout` —
  // /vessels is not a git repo, so the old git-checkout rollback silently failed
  // and left typecheck-broken edits live, which then ran on the next vessel
  // restart). fs_write the exact original bytes back; this is what makes the
  // (now-correct) verify gate actually PROTECT the runtime.
  let rolled_back = false;
  const restored: string[] = [];
  if (verdict === "UNFAVORABLE" && !pointer.keep_on_fail) {
    for (const [abs, original] of preEditContent) {
      const w = await callTool(toolsEndpoint, "fs_write", { path: abs, content: original });
      if (w.ok) restored.push(abs);
    }
    for (const f of created) {
      await callTool(toolsEndpoint, "shell", { command: `rm -f ${JSON.stringify(f)}`, cwd: REPO_ROOT });
    }
    rolled_back = true;
  }

  // 5. LAND (autonomous): on FAVORABLE, push each EXISTING-vessel change through
  // vessel-mitosis-cutover. Its evidence+freshness gates ARE the substrate's
  // self-verification; direct-push mode commits to the writable clone -> origin/dev
  // -> mirror -> /vessels + restart. One-shot compose->cutover has no drift window,
  // so the freshness gate passes legitimately. Net-new vessels (no push clone) are
  // skipped here and land via the scaffold path.
  const cutovers: unknown[] = [];
  if (verdict === "FAVORABLE" && pointer.land) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    for (const v of touched) {
      const vessel = v.replace(/^repos\//, "");
      const vBase = `${REPO_ROOT}/${vessel}`;
      const changedRel = [...created, ...edited]
        .filter((p) => p.startsWith(`${vBase}/`))
        .map((p) => p.slice(vBase.length + 1));
      if (changedRel.length === 0) continue;
      const clone = await callTool(toolsEndpoint, "shell", { command: `test -d /workspace/git/vessels/${vessel} && echo yes || echo no`, cwd: REPO_ROOT });
      if (!String((clone.body as { stdout?: unknown })?.stdout ?? "").includes("yes")) {
        cutovers.push({ vessel, landed: false, reason: "no push clone — net-new vessel, use scaffold path" });
        continue;
      }
      const mitosisRoot = `${REPO_ROOT}/${vessel}-mitosis-fc-${ts}`;
      for (const rel of changedRel) {
        const dir = `${mitosisRoot}/${rel.split("/").slice(0, -1).join("/")}`;
        await callTool(toolsEndpoint, "shell", { command: `mkdir -p ${JSON.stringify(dir)} && cp ${JSON.stringify(`${vBase}/${rel}`)} ${JSON.stringify(`${mitosisRoot}/${rel}`)}`, cwd: REPO_ROOT });
      }
      const shaRes = await callTool(toolsEndpoint, "shell", { command: `sha256sum ${JSON.stringify(`${vBase}/${changedRel[0]}`)} | cut -c1-12`, cwd: REPO_ROOT });
      const staged_base_sha = String((shaRes.body as { stdout?: unknown })?.stdout ?? "").trim().split(/\s+/)[0];
      const cut = await resolveVesselMitosisCutover({
        type: "vessel_mitosis_cutover",
        vessel_name: vessel,
        base_version_id: `${vessel}-live`,
        mitosis_version_id: `${vessel}-fc-${ts}`,
        mitosis_root: mitosisRoot,
        staged_files: changedRel,
        staged_base_sha,
        evaluation_evidence: { verdict: "FAVORABLE", base_success_rate: 1, mitosis_success_rate: 1, cited_trace_ids: [], cited_check_names: ["typecheck"] },
        skip_push: pointer.skip_push ?? false,
      } as never);
      cutovers.push({ vessel, result: cut.body });
    }
  }

  return {
    shape: "featureComposeReport",
    body: {
      ok: verdict === "FAVORABLE",
      verdict,
      summary: plan.summary,
      touched_vessels: [...touched],
      op_count: ops.length,
      applied,
      apply_failed: applyFailed,
      verify,
      semantic_gate,
      rolled_back,
      restored_files: restored.map((f) => f.replace(`${REPO_ROOT}/`, "")),
      created_files: created.map((f) => f.replace(`${REPO_ROOT}/`, "")),
      edited_files: edited.map((f) => f.replace(`${REPO_ROOT}/`, "")),
      cutovers: pointer.land ? cutovers : undefined,
      next: verdict === "FAVORABLE"
        ? "staged + typecheck-clean; dispatch a cutover (commit/push) to land"
        : "rolled back; inspect applied[].detail and verify[] then refine the spec",
    },
  };
}
