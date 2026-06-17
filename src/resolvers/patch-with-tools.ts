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
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
// V38 (2026-06-12): 8 was too tight — non-trivial single-file patches spend
// turns on search→edit→re-search-to-verify and hit the cap before declaring
// done (observed: code_replace_lines applied on turns 4-5, capped at 8 mid-verify).
// 16 gives headroom for inspect+edit+verify without unbounding cost.
const MAX_ITERATIONS = 30; // 2026-06-17: 16 capped mid-search (no_op); 30 is the memory-confirmed converging budget
const PER_CALL_TIMEOUT_MS = 60_000;

export interface PatchWithToolsPointer {
  type: "patch_with_tools";
  proposal_text: string; // sanitized proposal description (no code blocks)
  target_file: string; // repos/<vessel>/<subpath>
  vessels_root?: string;
  workspace_root?: string;
  model?: string;
  max_iterations?: number;
  /** Bounded outer-retry attempts (default 3); resets to original between tries. */
  max_attempts?: number;
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

async function llmCall(endpoint: string, prompt: string, model: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
    body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: 4000 }),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`llm fetch ${res.status}`);
  const j = (await res.json()) as { content?: string; data?: string; error?: string };
  if (j.error) throw new Error(`llm error: ${j.error}`);
  return (j.content ?? j.data ?? "").trim();
}

async function findLlmEndpoint(): Promise<string | null> {
  try {
    for (const shape of ["llmCompletion", "llm_completion"]) {
      const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> } };
      const vs = data.content?.vessels ?? [];
      if (vs.length === 0) continue;
      const best = vs.sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0))[0]!;
      const ep = best.resolve_endpoint ?? "/resolve";
      if (ep.startsWith("http")) return ep;
      return `${best.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
    }
  } catch { /* fall through */ }
  return null;
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
    return { ok: !errored, body };
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

4. code_insert_after_line { path, after_line, text }
   - Inserts \`text\` as a new line after line \`after_line\` (1-indexed, 0 = top).

5. code_replace_lines { path, start_line, end_line, text }
   - Replaces lines [start_line..end_line] (inclusive, 1-indexed) with \`text\`.
   - DANGER: you must supply the FULL replacement text for that whole range. If
     you haven't read the exact current content, you WILL destroy it. Prefer fs_edit.

5b. fs_edit { path, old_string, new_string }  ← PREFERRED for surgical edits
   - Replaces the FIRST exact occurrence of old_string with new_string. Fails
     safely ("old_string not found") WITHOUT writing if old_string isn't present,
     so it can never destroy code you haven't read. Copy old_string VERBATIM from
     a code_search result (include enough surrounding context to be unique) and
     make new_string the minimal change. This is the safest way to edit.

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
  const m1 = filePath.match(/^(?:\/)?repos\/([^/]+)\/(.+)$/);
  if (m1) return { vessel: m1[1]!, subPath: m1[2]! };
  const m2 = filePath.match(/^\/vessels\/([^/]+)\/(.+)$/);
  if (m2) return { vessel: m2[1]!, subPath: m2[2]! };
  return null;
}

export async function resolvePatchWithTools(pointer: PatchWithToolsPointer): Promise<ResolverResult> {
  const workspaceRoot = pointer.workspace_root ?? process.env.WORKSPACE_ROOT ?? "/workspace";
  const vesselsRoot = pointer.vessels_root ?? "/vessels";
  const maxIters = pointer.max_iterations ?? MAX_ITERATIONS;
  const model = pointer.model ?? "anthropic/claude-opus-4-7";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const derived = deriveVesselFromPath(pointer.target_file);
  if (!derived) return structuredError(`cannot derive vessel from path: ${pointer.target_file}`);
  const { vessel, subPath } = derived;
  const liveSrcPath = join(vesselsRoot, vessel, subPath);

  const beforeSrc = await readFile(liveSrcPath, "utf-8").catch(() => null);
  if (beforeSrc === null) return structuredError(`live source missing: ${liveSrcPath}`);
  const beforeSha = createHash("sha256").update(beforeSrc).digest("hex").slice(0, 12);

  const llmEndpoint = await findLlmEndpoint();
  if (!llmEndpoint) return structuredError("no llm_completion vessel found in discovery");
  const toolsEndpoint = await findLocalToolsEndpoint();
  if (!toolsEndpoint) return structuredError("no local-tools vessel found in discovery");
  console.error(`[patch-with-tools] start vessel=${vessel} file=${subPath} model=${model} llm=${llmEndpoint} tools=${toolsEndpoint}`);

  // The LLM must operate on the LIVE container path so its searches match what cutover
  // will actually stage. Stage into the mitosis tree at the end by copy.
  const containerPath = liveSrcPath; // already /vessels/<v>/<subPath>

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

  for (let attempt = 1; attempt <= maxAttempts && !finished; attempt++) {
    if (attempt > 1) {
      try { await writeFile(liveSrcPath, beforeSrc); } catch { /* best-effort */ }
      history.length = 0;
      failedCallCounts.clear();
      verifyFailCounts.clear();
    }
  for (let turn = 1; turn <= maxIters && !finished; turn++) {
    const historyBlock = history.length === 0
      ? "(no tool calls yet)"
      : history.map((h, i) => `Turn ${h.turn}: ${h.thought_or_action}${h.tool_result ? `\n  → ${h.tool_result.ok ? "OK" : "ERR"}: ${JSON.stringify(h.tool_result.result).slice(0, 800)}` : ""}`).join("\n\n");

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
    let searchStreak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const tname = history[i]?.tool_result?.tool;
      if (tname === "code_search" || tname === "code_find_function") searchStreak++;
      else break;
    }
    const searchNudge = searchStreak >= 3
      ? `## ⚠ STOP SEARCHING — YOU HAVE READ ENOUGH (${searchStreak} consecutive searches)\n` +
        `You already have the file content from those searches. Do NOT call code_search or ` +
        `code_find_function again. THIS TURN emit an EDIT: fs_edit { path, ` +
        `old_string=<verbatim lines you just read>, new_string=<minimal change> } (or ` +
        `code_replace_lines with exact line numbers). If you cannot construct the edit from ` +
        `what you have already read, emit { "action": "fail", "reason": "<why>" }. Another ` +
        `search wastes the budget and the patch is REJECTED at the cap.\n\n`
      : "";

    const prompt =
      `You are patching a source file via fine-grained code tools. The proposal describes what to change; you use the tools to inspect the file and apply the change.\n\n` +
      priorBlock +
      `MINIMAL-EDIT RULE: make the SMALLEST edit that satisfies the proposal. First READ the exact current lines you will change (code_search / code_find_function), then change ONLY those. Preserve every surrounding URL, header, identifier, type, and import style EXACTLY as they appear — never retype code from memory or invent values. A named export is imported as { name } (not a default import). After your edit, the file is typecheck-verified; if it fails, you must fix it before declaring done.\n\n` +
      `## Target file (container path)\n${containerPath}\n\n` +
      `## Proposal (intent — code samples may be illustrative, NOT the actual file contents)\n${pointer.proposal_text}\n\n` +
      `## Tool catalog\n${TOOL_CATALOG_HELP}\n\n` +
      correction +
      searchNudge +
      `## Tool call history\n${historyBlock}\n\n` +
      `## Turn ${turn} of ${maxIters}\n` +
      `Emit your next action as a JSON object only.`;

    let raw: string;
    try {
      raw = await llmCall(llmEndpoint, prompt, model);
    } catch (err) {
      return structuredError(`llm failed turn ${turn}: ${(err as Error).message}`, { history, before_sha: beforeSha });
    }
    const action = parseFirstJsonObject(raw);
    console.error(`[patch-with-tools] turn ${turn}: action=${action?.action ?? "UNPARSEABLE"}${action?.tool ? ` tool=${action.tool}` : ""}`);
    if (!action || typeof action.action !== "string") {
      history.push({ turn, thought_or_action: `(unparseable LLM output: ${raw.slice(0, 200)})` });
      continue;
    }
    if (action.action === "done") {
      // VERIFY-ON-DONE (2026-06-14): never accept the patch on the LLM's word.
      // Typecheck the live (in-progress) edit and, if the TARGET FILE now has
      // errors, feed them straight back so the patcher FIXES its own mistake
      // instead of returning a broken patch that only fails later at the cutover
      // gate. The loud-correction block (above) surfaces these on the next turn.
      // Crucially: abort if the SAME typecheck failure recurs — re-producing an
      // identical broken patch wastes cycles without improving coverage.
      const vesselDir = `${vesselsRoot}/${vessel}`;
      const tc = await callTool(toolsEndpoint, "code_typecheck", { cwd: vesselDir });
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
        try { await writeFile(liveSrcPath, beforeSrc); } catch { /* best-effort */ }
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
      history.push({ turn, thought_or_action: `(unknown action: ${String(action.action)})` });
      continue;
    }
    const tool = String(action.tool ?? "");
    const args = (action.args ?? {}) as Record<string, unknown>;
    console.error(`[patch-with-tools] turn ${turn} args=${JSON.stringify(args).slice(0, 240)}`);
    if (!tool) { history.push({ turn, thought_or_action: "(missing tool name)" }); continue; }
    // Force path arg to container path when not specified — protects against drafted absolute paths.
    if (typeof args.path === "string" && args.path.startsWith("repos/")) {
      args.path = args.path.replace(/^repos\/[^/]+\//, `${vesselsRoot}/${vessel}/`);
    }
    const result = await callTool(toolsEndpoint, tool, args);
    console.error(`[patch-with-tools] turn ${turn} ${tool} -> ${result.ok ? "OK" : "ERR"}: ${JSON.stringify(result.body).slice(0, 160)}`);
    history.push({ turn, thought_or_action: `call ${tool}(${JSON.stringify(args).slice(0, 200)})`, tool_result: { tool, args, result: result.body, ok: result.ok } });

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
        try { await writeFile(liveSrcPath, beforeSrc); } catch { /* best-effort */ }
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
    // V38: the code tools edit liveSrcPath IN PLACE during the loop; restore the
    // original so a failed/capped patch never corrupts live source.
    try { await writeFile(liveSrcPath, beforeSrc); } catch { /* best-effort */ }
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
  // the container behind the freshness gate.
  try { await writeFile(liveSrcPath, beforeSrc); } catch { /* best-effort */ }

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

  return {
    shape: "mitosisStaged",
    body: {
      dispatched: true,
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
}
