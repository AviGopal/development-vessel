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
 *
 * Observability: the resolver returns a `skipped` array in its result when no eligible proposal
 * is found, listing each candidate's reason (already_applied_sentinel, already_staged, parse_failed,
 * no_required_code_modifications, read_failed) so operators can audit drain progress.
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
  /**
   * (d) Targeted selection. When set, apply this exact proposal
   * (`<id>` or `<id>-report.json`) instead of mtime-ranking the dir. Lets the
   * detector->gap->bridge chain drive a specific authored fix to completion
   * rather than hoping the mtime walk reaches it before newer churn buries it.
   */
  proposal_id?: string;
  /**
   * (d) Untargeted ordering when `proposal_id` is absent. Default `oldest`
   * (FIFO) so no proposal starves behind a stream of newer ones — the failure
   * mode of the prior newest-first (LIFO) default. `newest` restores LIFO.
   */
  prefer?: "oldest" | "newest";
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

/**
 * V35 (2026-06-09) — sanitize proposal content before feeding to the patcher LLM.
 * The drafter (LLM-A) routinely embeds hypothetical code fragments in the
 * proposal description illustrating the proposed change. The patcher (LLM-B)
 * then treats those hypothetical fragments as canonical search text — even
 * with opus + 3-turn feedback (V34), the search strings consistently
 * match the proposal's hypothetical code rather than the actual live source.
 *
 * Strip:
 *   - fenced code blocks (```lang ... ```)
 *   - inline code (`...`)
 *   - quoted multi-line strings that look like source (heuristic: 3+ consecutive
 *     newline-separated lines starting with whitespace)
 *
 * Keep:
 *   - kind, summary, file, plain-text description
 *
 * The patcher receives intent only; the live source is the sole ground truth.
 */
function sanitizeProposalForPatcher(raw: string): string {
  let parsed: unknown;
  try {
    const m = raw.indexOf("{");
    const j = m >= 0 ? raw.slice(m) : raw;
    parsed = JSON.parse(j.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, ""));
  } catch {
    return stripCodeFromText(raw).slice(0, 4000);
  }
  if (!parsed || typeof parsed !== "object") return stripCodeFromText(raw).slice(0, 4000);
  const p = parsed as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof p["kind"] === "string") lines.push(`kind: ${p["kind"]}`);
  if (typeof p["summary"] === "string") lines.push(`summary: ${stripCodeFromText(p["summary"]).slice(0, 600)}`);
  const mods = Array.isArray(p["required_code_modifications"]) ? p["required_code_modifications"] as Array<Record<string, unknown>> : [];
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i]!;
    if (typeof m["file"] === "string") lines.push(`required_code_modifications[${i}].file: ${m["file"]}`);
    if (typeof m["description"] === "string") {
      lines.push(`required_code_modifications[${i}].description: ${stripCodeFromText(m["description"]).slice(0, 1200)}`);
    }
  }
  return lines.join("\n");
}

function stripCodeFromText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "[code-block-stripped]")
    .replace(/`[^`\n]+`/g, "[inline-code-stripped]")
    .replace(/((?:\n[ \t]+\S.*){3,})/g, "\n[multi-line-indented-block-stripped]")
    .replace(/\s+/g, " ")
    .trim();
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

  // (e) Singleton-pending guard: do NOT clobber an in-flight staged mitosis.
  // Overwriting mitosis-pending.json while a prior staging awaits cutover
  // orphans that staged tree (the abandoned -mitosis- dirs seen in the field).
  // Serialize instead: refuse while a FRESH pending exists; a stale one (older
  // than MITOSIS_PENDING_STALE_MS, default 30m) is treated as abandoned —
  // prune-stale-mitosis reaps it — and we proceed.
  if (!dryRun) {
    try {
      const curRaw = await readFile(pendingPath, "utf-8");
      const cur = JSON.parse(curRaw) as { staged_at?: string; mitosis_version_id?: string };
      const ageMs = cur.staged_at ? Date.now() - Date.parse(cur.staged_at) : Number.POSITIVE_INFINITY;
      const staleMs = Number(process.env["MITOSIS_PENDING_STALE_MS"] ?? 1800000);
      if (Number.isFinite(ageMs) && ageMs < staleMs) {
        return structuredError("pending mitosis in flight — refusing to clobber", {
          pending_path: pendingPath,
          pending_mitosis_version_id: cur.mitosis_version_id ?? null,
          pending_age_ms: Math.round(ageMs),
          stale_after_ms: staleMs,
        });
      }
    } catch {
      /* no pending file (or unreadable/parse-fail) -> safe to proceed */
    }
  }

  // 1. List proposals.
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
  // (d) Default FIFO (oldest-first) so no proposal starves behind newer churn;
  // `prefer:"newest"` restores the prior LIFO behaviour.
  const prefer = pointer.prefer ?? "oldest";
  entries.sort((a, b) => (prefer === "newest" ? b.mtime - a.mtime : a.mtime - b.mtime));

  // (d) Targeted selection: when proposal_id is given, restrict to that exact
  // proposal so the detector->gap->bridge chain can drive a specific authored
  // fix to completion regardless of how much newer churn exists.
  if (pointer.proposal_id) {
    const want = pointer.proposal_id.endsWith("-report.json")
      ? pointer.proposal_id
      : `${pointer.proposal_id}-report.json`;
    entries = entries.filter(
      (e) => e.name === want || e.name.replace(/-report\.json$/, "") === pointer.proposal_id,
    );
    if (entries.length === 0) {
      return structuredError(`targeted proposal not found: ${pointer.proposal_id}`, {
        proposal_id: pointer.proposal_id,
      });
    }
  }

  // 2. Find next unstaged proposal — skip if any /vessels/<v>-mitosis-* dir exists for its scenario_id.
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
    // Multi-file proposal (2026-06-05): proposals carrying `new_files[]` skip
    // the required_code_modifications check; the multi-file branch below picks
    // them up and writes each file's full content into the staged mitosis dir.
    const pFull = parsed as { kind?: string; required_code_modifications?: Array<{ file?: string }>; new_files?: Array<{ path?: string; content?: string }>; vessel_shape_coverage?: unknown; trace_family_distribution?: unknown; [k: string]: unknown };
    // V4 fix (2026-06-06): kind discriminator. The /workspace/proposals/ dir
    // mixes patch_proposals (with required_code_modifications[] or new_files[])
    // and legacy vessel_shape_coverage analytic reports (under a wrapper key
    // like `autoDraftedOutput_*` whose value contains vessel_shape_coverage +
    // trace_family_distribution). Pre-filter the analytic reports so the
    // probe sees a cleaner skipped-reason stream and S4 isn't dominated by
    // legacy artifacts.
    //   - Explicit kind: respect it.
    //   - Implicit: any nested vessel_shape_coverage or trace_family_distribution
    //     key (root or one level deep under an `autoDraftedOutput_*` wrapper)
    //     marks the report as an analytic non-patch.
    const explicitKind = typeof pFull.kind === "string" ? pFull.kind : null;
    let isAnalyticReport = false;
    if (explicitKind && explicitKind !== "patch_proposal") {
      isAnalyticReport = true;
    } else if (!explicitKind) {
      const hasCoverageKey = (obj: unknown): boolean =>
        obj != null && typeof obj === "object" && (
          "vessel_shape_coverage" in (obj as Record<string, unknown>) ||
          "trace_family_distribution" in (obj as Record<string, unknown>)
        );
      if (hasCoverageKey(pFull)) {
        isAnalyticReport = true;
      } else {
        for (const k of Object.keys(pFull)) {
          if (k.startsWith("autoDraftedOutput_") && hasCoverageKey(pFull[k])) {
            isAnalyticReport = true;
            break;
          }
        }
      }
    }
    if (isAnalyticReport) {
      skipped.push({ proposal: e.name, reason: "analytic_report_not_patch_proposal" });
      continue;
    }
    const hasNewFiles = Array.isArray(pFull.new_files) && pFull.new_files.some((f) => typeof f?.path === "string" && typeof f?.content === "string");
    const mods = pFull.required_code_modifications ?? [];
    // V13 fix (2026-06-06): drafter prompts variants emit the target under
    // `required_modifications.primary_target.file` (singular, nested) instead
    // of the canonical `required_code_modifications[].file`. Accept both —
    // 193 proposals on disk all use the nested form, so without this fallback
    // the chain reports 100% no_op despite the drafter doing real work.
    const nestedTarget = (pFull as { required_modifications?: { primary_target?: { file?: string } } }).required_modifications?.primary_target?.file;
    // V14 fix (2026-06-06): the drafter writes proposals shaped as
    // `{autoDraftedOutput_<id>: {required_code_modifications: [...], ...}}` —
    // the LLM tail wraps its output under that key. Scan one level deep for
    // required_code_modifications / required_modifications / new_files when
    // the top level lacks them. This unwraps the natural-cycle drafter output
    // so apply→cutover→commit can run from autonomous traces, not just
    // operator-seeded canonical proposals.
    let wrappedTarget: string | undefined;
    let wrappedNewFiles: Array<{ path?: string; content?: string }> | undefined;
    if (!mods.length && !nestedTarget && !hasNewFiles) {
      for (const k of Object.keys(pFull)) {
        if (!k.startsWith("autoDraftedOutput_")) continue;
        const inner = (pFull as Record<string, unknown>)[k];
        if (!inner || typeof inner !== "object") continue;
        const innerObj = inner as { required_code_modifications?: Array<{ file?: string }>; required_modifications?: { primary_target?: { file?: string } }; new_files?: Array<{ path?: string; content?: string }> };
        if (Array.isArray(innerObj.required_code_modifications)) {
          const t = innerObj.required_code_modifications.find((m) => typeof m?.file === "string")?.file;
          if (typeof t === "string") { wrappedTarget = t; break; }
        }
        const nt = innerObj.required_modifications?.primary_target?.file;
        if (typeof nt === "string") { wrappedTarget = nt; break; }
        if (Array.isArray(innerObj.new_files) && innerObj.new_files.some((f) => typeof f?.path === "string" && typeof f?.content === "string")) {
          wrappedNewFiles = innerObj.new_files;
          break;
        }
      }
    }
    const targetFile = mods.find((m) => typeof m?.file === "string")?.file
      ?? (typeof nestedTarget === "string" ? nestedTarget : undefined)
      ?? wrappedTarget;
    const effectiveHasNewFiles = hasNewFiles || (Array.isArray(wrappedNewFiles) && wrappedNewFiles.length > 0);
    if (!targetFile && !effectiveHasNewFiles) { skipped.push({ proposal: e.name, reason: "no_required_code_modifications" }); continue; }
    // V29 (2026-06-09): in-loop file-existence validation. Reject proposals that
    // cite non-existent source paths so the next-newest unstaged proposal gets
    // a chance. Without this gate, a hallucinated-path proposal blocks the
    // queue forever — the resolver picks it, fails at the live-source-missing
    // check (line 428), returns structuredError, and on the next apply cycle
    // picks the SAME proposal again. Archive bad proposals into .rejected/
    // (parallel to .applied/) so future cycles skip them via mtime walk.
    const filesToVerify: string[] = [];
    if (targetFile) filesToVerify.push(targetFile);
    if (Array.isArray(wrappedNewFiles)) {
      for (const nf of wrappedNewFiles) if (typeof nf.path === "string") filesToVerify.push(nf.path);
    }
    if (hasNewFiles) {
      for (const nf of pFull.new_files!) if (typeof nf.path === "string") filesToVerify.push(nf.path);
    }
    let allFilesExist = true;
    const missingFiles: string[] = [];
    for (const f of filesToVerify) {
      const d = deriveVesselFromPath(f);
      if (!d) {
        allFilesExist = false;
        missingFiles.push(`${f} (cannot derive vessel)`);
        break;
      }
      const livePath = join(vesselsRoot, d.vessel, d.subPath);
      if (!(await exists(livePath))) {
        allFilesExist = false;
        missingFiles.push(f);
      }
    }
    if (!allFilesExist) {
      // Archive to .rejected/ so next cycle's mtime walk treats it as already-handled.
      const rejectedDir = `${proposalsDir}/.rejected`;
      try { await mkdir(rejectedDir, { recursive: true }); } catch { /* tolerant */ }
      try {
        await writeFile(`${rejectedDir}/${e.name}`,
          JSON.stringify({ rejected_at: new Date().toISOString(), reason: "file_path_hallucination", missing: missingFiles, original_content_preview: content.slice(0, 500) }, null, 2));
        // Move the original out of the active dir so the mtime-sort doesn't keep re-selecting it.
        // We can't unlink/rename across the resolver boundary safely, so write a sentinel into
        // .applied/ — apply-loop reads .applied/ and skips matching entries (see appliedSet).
        await writeFile(`${proposalsDir}/.applied/${e.name}`,
          JSON.stringify({ rejected_at: new Date().toISOString(), reason: "file_path_hallucination", missing: missingFiles }, null, 2));
      } catch { /* tolerant */ }
      skipped.push({ proposal: e.name, reason: `file_path_hallucination: ${missingFiles.join(", ").slice(0, 120)}` });
      continue;
    }
    chosen = { name: e.name, path: e.path, scenarioId, content, targetFile: targetFile ?? "" };
    break;
  }
  if (!chosen) {
    // No work done = not a success. Boredom Thompson posteriors must record
    // this as a no-op outcome so momentum decays and other goals (drafter,
    // mitosis-tick) get score, instead of looping on apply-proposal because
    // it always returns success regardless of whether it actually staged
    // anything. structuredError makes the dispatcher record failure_count++
    // without polluting α with empty wins.
    return structuredError("no eligible proposals", { total_proposals: entries.length, skipped: skipped.slice(0, 20) });
  }
  // Multi-file proposals path (2026-06-05): if proposal carries `new_files[]`
  // (each {path, content} starting with `repos/<vessel>/`), write all of them
  // into the staged mitosis dir without LLM-patching. Same-vessel constraint:
  // all new_files must share a vessel root. This is how the resolver-author
  // chain ships new-resolver scaffolds; vessel-mitosis-cutover already accepts
  // N staged_files via host-sync intent. The search/replace path below remains
  // the canonical single-file flow.
  type ParsedFull = { new_files?: Array<{ path?: string; content?: string }>; required_code_modifications?: Array<{ file?: string }> };
  let parsedFull: ParsedFull | null = null;
  const tolerantFull = parseFirstJsonObject(chosen.content);
  if (tolerantFull && typeof tolerantFull === "object") parsedFull = tolerantFull as ParsedFull;
  const newFiles = ((parsedFull?.new_files ?? []) as Array<{ path?: string; content?: string }>).filter(
    (f): f is { path: string; content: string } =>
      f != null && typeof f.path === "string" && typeof f.content === "string",
  );
  if (newFiles.length > 0) {
    // Verify all share a vessel root and none escape the staging tree.
    const vesselRoots = new Set<string>();
    const fileEntries: Array<{ vessel: string; subPath: string; content: string; absSource: string }> = [];
    for (const nf of newFiles) {
      if (nf.path.includes("..") || nf.path.startsWith("/")) {
        return structuredError(`new_files[] path escape: ${nf.path}`, { proposal: chosen.name });
      }
      const d = deriveVesselFromPath(nf.path);
      if (!d) return structuredError(`new_files[] path cannot derive vessel: ${nf.path}`, { proposal: chosen.name });
      vesselRoots.add(d.vessel);
      fileEntries.push({ vessel: d.vessel, subPath: d.subPath, content: nf.content, absSource: nf.path });
    }
    if (vesselRoots.size !== 1) {
      return structuredError(`new_files[] must target a single vessel; got: ${[...vesselRoots].join(",")}`, { proposal: chosen.name });
    }
    const vesselOnly = [...vesselRoots][0]!;
    if (dryRun) {
      return {
        shape: "mitosisStaged",
        body: {
          dispatched: null,
          dry_run: true,
          would_stage: {
            proposal: chosen.name,
            vessel: vesselOnly,
            file_count: fileEntries.length,
            files: fileEntries.map((e) => e.absSource),
          },
          multifile: true,
        },
      };
    }
    const mitosisRoot = join(vesselsRoot, `${vesselOnly}-mitosis-${stamp}`);
    const stagedFiles: string[] = [];
    for (const e of fileEntries) {
      const stagedFile = join(mitosisRoot, e.subPath);
      try {
        await mkdir(dirname(stagedFile), { recursive: true });
        await writeFile(stagedFile, e.content);
        stagedFiles.push(e.subPath);
      } catch (err) {
        return structuredError(`stage write failed: ${(err as Error).message}`, { staged_file: stagedFile });
      }
    }
    const versionId = `mitosis-${stamp}`;
    const pendingBody = {
      vessel_name: vesselOnly,
      base_version_id: "v1",
      mitosis_version_id: versionId,
      mitosis_root: mitosisRoot,
      staged_at: new Date().toISOString(),
      authored_by: "apply_proposal_as_patch:multifile",
      proposal: chosen.name,
      staged_files: stagedFiles,
      multifile: true,
    };
    try { await writeFile(pendingPath, JSON.stringify(pendingBody, null, 2)); }
    catch (err) { return structuredError(`pending write failed: ${(err as Error).message}`); }
    try {
      await writeFile(`${proposalsDir}/.applied/${chosen.name}`,
        JSON.stringify({ staged_at: pendingBody.staged_at, mitosis_version_id: versionId, multifile: true, file_count: stagedFiles.length }, null, 2));
    } catch { /* tolerant */ }
    return {
      shape: "mitosisStaged",
      body: {
        dispatched: chosen.name,
        vessel_name: vesselOnly,
        mitosis_root: mitosisRoot,
        mitosis_version_id: versionId,
        staged_files: stagedFiles,
        pending_path: pendingPath,
        multifile: true,
        completed_at: new Date().toISOString(),
      },
    };
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

  // V36 (2026-06-10) — delegate the actual patching to patch_with_tools,
  // a ReAct-style loop over fine-grained code-tool resolvers in
  // local-tools-vessel. The free-styled search/replace monolith that lived
  // here (V25→V35) consistently hallucinated search strings even with opus +
  // 3-turn feedback (V34) and proposal sanitization (V35), because the LLM
  // had no way to inspect the file before writing ops. The tool-using loop
  // is structured by construction — every change is a verifiable primitive
  // (code_find_function, code_insert_after_line, code_replace_lines, etc.).
  const { resolvePatchWithTools } = await import("./patch-with-tools.js");
  const result = await resolvePatchWithTools({
    type: "patch_with_tools",
    proposal_text: sanitizeProposalForPatcher(chosen.content),
    target_file: targetFile,
    vessels_root: vesselsRoot,
    workspace_root: workspaceRoot,
  });
  // Mark this proposal applied regardless of outcome so the next cycle
  // picks a different one; downstream cutover/host-sync decide whether the
  // staged patch lands.
  try {
  if (result.shape === "structuredError") {
    console.error(`[apply_proposal_as_patch] patch_with_tools failed for ${chosen.name}: ${(result.body as Record<string, unknown>).detail}`);
  }
    await writeFile(`${proposalsDir}/.applied/${chosen.name}`,
      JSON.stringify({ delegated_to: "patch_with_tools", outcome_shape: result.shape, applied_at: new Date().toISOString() }, null, 2));
  } catch { /* tolerant */ }
  return result;
}
