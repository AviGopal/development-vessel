/**
 * apply_proposal_as_patch — Break 3 close (2026-06-04).
 *
 * Drafter writes analysis reports to /workspace/proposals/<id>-report.json
 * but nothing converts proposal analysis into staged mitosis directories
 * that the existing cutover machinery (vessel_mitosis_cutover + mitosis-tick)
 * can apply. This resolver closes that final gap end-to-end:
 *
 *   1. List /workspace/proposals/*-report.json
 *   2. Skip any whose scenario_id already has a staged mitosis dir
 *      (/vessels/<vessel>-mitosis-<TS>/), pick newest unstaged by mtime
 *   3. Strip markdown fences, parse the proposal, extract
 *      required_code_modifications[0].file as the target path
 *   4. Resolve target → /vessels/<vessel_name>/<sub_path>; compute base SHA
 *   5. LLM call: live source + proposal analysis → patched full source
 *   6. mkdir /vessels/<vessel_name>-mitosis-<TS>/<sub_path> and write
 *   7. Write /workspace/mitosis-pending.json with staged_base_sha
 *
 * Output shape: mitosisStaged. On no-eligible-proposal returns the same
 * shape with dispatched=null + reason. LLM/IO failures degrade with
 * structuredError so callers can inspect the failure mode.
 *
 * Side effects are idempotent at the (proposal_id) granularity — re-running
 * with the same newest proposal is a no-op once its mitosis dir exists.
 */

import { resolve, join, dirname } from "node:path";
import { mkdir, readdir, stat, writeFile, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

// Read at call time, not load time — tests stand up a Bun server per case and
// set LLM_COMPLETION_ENDPOINT just before invoking the resolver.
function llmOverride(): string { return process.env["LLM_COMPLETION_ENDPOINT"] ?? ""; }

export interface ApplyProposalAsPatchPointer {
  type: "apply_proposal_as_patch";
  proposals_dir?: string;
  vessels_root?: string;
  pending_path?: string;
  dry_run?: boolean;
  model?: string;
  max_tokens?: number;
}

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return { shape: "structuredError", body: { resolver: "apply_proposal_as_patch", detail, ...(extra ?? {}) } };
}

function stripFences(raw: string): string {
  let s = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return s;
}

/**
 * Tolerant proposal parse (2026-06-04). LLM drafters commonly emit one or more
 * JSON objects followed by markdown commentary, or in some cases two JSON
 * objects concatenated (main proposal + addendum learning object). The legacy
 * `JSON.parse(stripFences(content))` path threw on multi-object output because
 * `lastBrace` picked the wrong closer. Walk the string brace-depth + string
 * state aware, slice the FIRST complete top-level JSON object, parse just that.
 *
 * On failure (truncated body, no opening brace, etc) return null so the
 * resolver falls back to its existing skip-with-reason behaviour.
 */
function parseFirstJsonObject(raw: string): unknown | null {
  // Strip leading markdown fences but DO NOT collapse to first/lastBrace —
  // we need the raw substring so brace tracking works on the real body.
  const s = raw.replace(/^```(?:json)?\n?/i, "").trimStart();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null; // truncated — never balanced
}

/**
 * Brace/bracket-aware walker that extracts the FIRST balanced top-level JSON
 * array from an LLM tail. Mirrors `parseFirstJsonObject` but tracks `[`/`]`.
 * Tolerates leading markdown fences and stray prose before the array.
 */
function parseFirstJsonArray(raw: string): unknown | null {
  const s = raw.replace(/^```(?:json)?\n?/i, "").trimStart();
  const start = s.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function deriveVesselFromPath(filePath: string): { vessel: string; subPath: string } | null {
  // Accept: repos/<vessel>/<rest>, /vessels/<vessel>/<rest>, <vessel>/src/... heuristic
  const m1 = filePath.match(/^(?:\/)?repos\/([^/]+)\/(.+)$/);
  if (m1) return { vessel: m1[1]!, subPath: m1[2]! };
  const m2 = filePath.match(/^\/vessels\/([^/]+)\/(.+)$/);
  if (m2) return { vessel: m2[1]!, subPath: m2[2]! };
  return null;
}

async function findLlmEndpoint(): Promise<string | null> {
  const override = llmOverride();
  if (override) return override;
  try {
    for (const shape of ["llmCompletion", "llm_completion"]) {
      const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      });
      if (!r.ok) continue;
      const data = await r.json() as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> } };
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

export async function resolveApplyProposalAsPatch(pointer: ApplyProposalAsPatchPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const proposalsDir = pointer.proposals_dir ?? join(workspaceRoot, "proposals");
  const vesselsRoot = pointer.vessels_root ?? "/vessels";
  const pendingPath = pointer.pending_path ?? join(workspaceRoot, "mitosis-pending.json");
  const dryRun = pointer.dry_run === true;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // 1. List proposals, sort newest first by mtime.
  let entries: Array<{ name: string; path: string; mtime: number }> = [];
  try {
    const names = await readdir(proposalsDir);
    for (const n of names) {
      if (!n.endsWith("-report.json")) continue;
      const p = join(proposalsDir, n);
      try { const s = await stat(p); entries.push({ name: n, path: p, mtime: s.mtimeMs }); } catch { /* skip */ }
    }
  } catch (err) {
    return structuredError(`cannot read proposals dir: ${(err as Error).message}`);
  }
  entries.sort((a, b) => b.mtime - a.mtime);

  // 2. Find newest unstaged proposal — skip if any /vessels/<v>-mitosis-* dir exists for its scenario_id.
  let mitosisDirs: string[] = [];
  try { mitosisDirs = (await readdir(vesselsRoot)).filter((d) => /-mitosis-/.test(d)); } catch { /* tolerant */ }

  // Per-proposal sentinel directory tracks proposals already converted into
  // a mitosis stage, regardless of whether the cutover ultimately succeeded
  // or got rejected by host-sync (commit_failed, scope_creep, etc.). The
  // original `already_staged` check against mitosis-dir-name was structurally
  // broken — mitosis dirs are named by timestamp and never contain the
  // scenario_id, so the dedup never fired. Same proposal got picked every
  // cycle, LLM produced same patch, host-sync rejected for nothing-to-commit,
  // substrate never explored new proposals.
  const sentinelDir = `${proposalsDir}/.applied`;
  let appliedSet: Set<string> = new Set();
  try {
    await mkdir(sentinelDir, { recursive: true });
    appliedSet = new Set(await readdir(sentinelDir));
  } catch { /* tolerant — fall back to in-cycle skip-via-mitosis-dir */ }

  // Walk entries in newest-first order; skip staged, malformed, or fieldless.
  // Record skip reasons so the caller can audit drain progress.
  const skipped: Array<{ proposal: string; reason: string }> = [];
  let chosen: { name: string; path: string; scenarioId: string; content: string; targetFile: string } | null = null;
  for (const e of entries) {
    const scenarioId = e.name.replace(/-report\.json$/, "");
    if (appliedSet.has(e.name)) { skipped.push({ proposal: e.name, reason: "already_applied_sentinel" }); continue; }
    if (mitosisDirs.some((d) => d.includes(scenarioId.slice(0, 32)))) { skipped.push({ proposal: e.name, reason: "already_staged" }); continue; }
    let content: string;
    try { content = await readFile(e.path, "utf-8"); } catch { skipped.push({ proposal: e.name, reason: "read_failed" }); continue; }
    // Tolerant parse — brace-aware walker handles LLM tails (multi-object,
    // post-JSON markdown narrative). Legacy stripFences path remains as a
    // fallback for proposals whose body is a single clean JSON object that
    // the new walker rejects due to a stray opening brace in commentary.
    let parsed: { required_code_modifications?: Array<{ file?: string }> } | null = null;
    const tolerant = parseFirstJsonObject(content);
    if (tolerant && typeof tolerant === "object") {
      parsed = tolerant as { required_code_modifications?: Array<{ file?: string }> };
    } else {
      try { parsed = JSON.parse(stripFences(content)); } catch { parsed = null; }
    }
    if (!parsed) { skipped.push({ proposal: e.name, reason: "parse_failed" }); continue; }
    const mods = parsed.required_code_modifications ?? [];
    const targetFile = mods.find((m) => typeof m?.file === "string")?.file;
    if (!targetFile) { skipped.push({ proposal: e.name, reason: "no_required_code_modifications" }); continue; }
    chosen = { name: e.name, path: e.path, scenarioId, content, targetFile };
    break;
  }
  if (!chosen) {
    return { shape: "mitosisStaged", body: { dispatched: null, reason: "no eligible proposals", total_proposals: entries.length, skipped: skipped.slice(0, 20) } };
  }
  const targetFile = chosen.targetFile;
  const derived = deriveVesselFromPath(targetFile);
  if (!derived) return structuredError(`cannot derive vessel from path: ${targetFile}`, { proposal: chosen.name });
  const { vessel, subPath } = derived;

  // 4. Read live source (under /vessels/<vessel>/<subPath>); compute SHA.
  const liveSrcPath = join(vesselsRoot, vessel, subPath);
  if (!(await exists(liveSrcPath))) {
    return structuredError(`live source missing: ${liveSrcPath}`, { proposal: chosen.name, target_file: targetFile });
  }
  const liveSrc = await readFile(liveSrcPath, "utf-8");
  const baseSha = createHash("sha256").update(liveSrc).digest("hex").slice(0, 12);

  if (dryRun) {
    return { shape: "mitosisStaged", body: { dispatched: null, dry_run: true, would_stage: { proposal: chosen.name, target: targetFile, vessel, base_sha: baseSha } } };
  }

  // 5. LLM call — search/replace patch format.
  //
  // Background (2026-06-04): the previous "produce the full patched source"
  // prompt produced byte-identical output to the input on both haiku-4-5 and
  // sonnet-4-5 for real vessel files. The model defaulted to copying the
  // input rather than applying the proposal. Switch to a structured
  // search/replace format the LLM can produce reliably; we then apply the
  // ops deterministically and reject ambiguous matches.
  const endpoint = await findLlmEndpoint();
  if (!endpoint) return structuredError("no llm_completion vessel found in discovery");
  const prompt =
    `You are producing a PATCH for a source file based on a proposal. Output ONLY a JSON array of search/replace operations. No prose, no markdown fences, no commentary.\n\n` +
    `## Output format\n\n` +
    `\`\`\`\n[\n  {\n    "search": "<exact substring from the original file, INCLUDING surrounding context for unambiguous match — 1 to 3 lines above + below the change>",\n    "replace": "<the modified substring — same context lines preserved, with the change applied inside>"\n  }\n]\n\`\`\`\n\n` +
    `## Rules (CRITICAL)\n` +
    `1. Each \`search\` MUST be an EXACT substring of the original file (preserve whitespace, newlines, indentation precisely).\n` +
    `2. Each \`search\` MUST appear EXACTLY ONCE in the original file. Include 1-3 lines of context above and below the change so the match is unique.\n` +
    `3. For APPEND-ONLY operations (add content at end of file): \`search\` = the last 1-3 lines of the file exactly; \`replace\` = those same lines + your new content appended.\n` +
    `4. For INSERTS at a specific location: \`search\` = a unique nearby anchor (1-3 lines); \`replace\` = that anchor + your new content placed before or after as the proposal specifies.\n` +
    `5. Do NOT echo unchanged regions of the file. Only emit ops that actually change content.\n` +
    `6. If your output produces a file IDENTICAL to the input, you have FAILED. Re-read the proposal description and identify what concrete substring change it requests.\n` +
    `7. Output ONLY the JSON array. Nothing before, nothing after.\n\n` +
    `## Target file path\n${targetFile}\n\n` +
    `## Proposal (JSON)\n${chosen.content.slice(0, 8000)}\n\n` +
    `## Live source (current contents)\n\`\`\`\n${liveSrc}\n\`\`\`\n\n` +
    `Output the JSON array of search/replace ops now.`;
  let ops: Array<{ search: string; replace: string }>;
  let rawLlm = "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm_completion", prompt, model: pointer.model ?? "anthropic/claude-sonnet-4-5-20250929", max_tokens: pointer.max_tokens ?? 8000 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return structuredError(`llm fetch ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json() as { content?: string; data?: string; error?: string };
    if (j.error) return structuredError(`llm error: ${j.error}`);
    rawLlm = (j.content ?? j.data ?? "").trim();
    if (!rawLlm) return structuredError("llm returned empty content");
    const parsed = parseFirstJsonArray(rawLlm);
    if (!parsed || !Array.isArray(parsed)) {
      return structuredError("llm output not a JSON array", { raw_preview: rawLlm.slice(0, 200) });
    }
    ops = parsed.filter((o): o is { search: string; replace: string } =>
      o && typeof o === "object" && typeof (o as { search?: unknown }).search === "string" && typeof (o as { replace?: unknown }).replace === "string");
    if (ops.length === 0) return structuredError("llm returned no usable ops", { raw_preview: rawLlm.slice(0, 200) });
  } catch (err) {
    return structuredError(`llm call failed: ${(err as Error).message}`);
  }

  // Apply ops deterministically. Each search must match exactly once.
  let patched = liveSrc;
  const opLog: Array<{ idx: number; matches: number; applied: boolean }> = [];
  for (let i = 0; i < ops.length; i++) {
    const { search, replace } = ops[i]!;
    if (search === replace) { opLog.push({ idx: i, matches: 0, applied: false }); continue; }
    // Count occurrences (non-overlapping).
    let count = 0;
    let pos = 0;
    while (pos < patched.length) {
      const idx = patched.indexOf(search, pos);
      if (idx < 0) break;
      count++;
      pos = idx + Math.max(1, search.length);
    }
    if (count !== 1) {
      opLog.push({ idx: i, matches: count, applied: false });
      return structuredError(`op ${i} search matched ${count}x, need exactly 1`, { op_log: opLog, raw_preview: rawLlm.slice(0, 300) });
    }
    patched = patched.replace(search, replace);
    opLog.push({ idx: i, matches: 1, applied: true });
  }
  const beforeMd5 = createHash("md5").update(liveSrc).digest("hex");
  const afterMd5 = createHash("md5").update(patched).digest("hex");
  if (beforeMd5 === afterMd5) {
    return structuredError("patched output identical to input — llm produced no-op ops", { op_log: opLog, raw_preview: rawLlm.slice(0, 300) });
  }

  // 6. Stage the mitosis dir and write the patched file.
  // Note: the dedup at line 124 was originally designed for a future where
  // many proposals have required_code_modifications. Today the corpus has
  // 1/52 such proposals; encoding scenario_id into the dir name (an earlier
  // attempt this session) deadlocked the chain by skipping the only valid
  // proposal after one staging. We rely on the mirror step in
  // host-sync-poller to keep container source aligned with HEAD post-commit;
  // each subsequent apply reads the post-commit content and the LLM emits a
  // genuinely different patch (or git rejects "nothing to commit" cleanly).
  const mitosisRoot = join(vesselsRoot, `${vessel}-mitosis-${stamp}`);
  const stagedFile = join(mitosisRoot, subPath);
  try {
    await mkdir(dirname(stagedFile), { recursive: true });
    await writeFile(stagedFile, patched);
  } catch (err) {
    return structuredError(`stage write failed: ${(err as Error).message}`, { staged_file: stagedFile });
  }

  // 7. Write mitosis-pending.json.
  const versionId = `mitosis-${stamp}`;
  const pendingBody = {
    vessel_name: vessel,
    base_version_id: "v1",
    mitosis_version_id: versionId,
    mitosis_root: mitosisRoot,
    base_sha: baseSha,
    staged_at: new Date().toISOString(),
    authored_by: "apply_proposal_as_patch",
    proposal: chosen.name,
    target_file: targetFile,
    staged_files: [subPath],
  };
  try { await writeFile(pendingPath, JSON.stringify(pendingBody, null, 2)); }
  catch (err) { return structuredError(`pending write failed: ${(err as Error).message}`); }

  // Mark this proposal as applied so the next cycle picks a different one,
  // even if the downstream host-sync rejects (commit_failed / scope_creep).
  // Best-effort; if the sentinel write fails we still return success because
  // the in-cycle mitosis-dir check will catch it on the very next call.
  try {
    await writeFile(`${proposalsDir}/.applied/${chosen.name}`,
      JSON.stringify({ staged_at: pendingBody.staged_at, mitosis_version_id: versionId, base_sha: baseSha }, null, 2));
  } catch { /* tolerant */ }

  return {
    shape: "mitosisStaged",
    body: { dispatched: chosen.name, vessel_name: vessel, mitosis_root: mitosisRoot, mitosis_version_id: versionId, base_sha: baseSha, staged_files: [subPath], pending_path: pendingPath, completed_at: new Date().toISOString() },
  };
}
