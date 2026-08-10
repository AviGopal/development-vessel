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
import { mkdir, readdir, stat, writeFile, readFile, access, rename } from "node:fs/promises";

import { createHash } from "node:crypto";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose } from "./feature-compose.js";

// ---------------------------------------------------------------------------
// Staleness-sweep configuration
// ---------------------------------------------------------------------------
const STALE_MAX_AGE_DAYS = Number(process.env["STALE_PROPOSAL_MAX_AGE_DAYS"] ?? "7");
const STALE_MAX_AGE_MS = STALE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Tags that indicate a proposal is no longer actionable. */
const STALE_TAGS = new Set([
  "freshness_violation",
  "precondition-rejection",
  "arch-pattern-bloat",
]);

/**
 * Returns true when a proposal should be swept as stale:
 *   - It carries at least one staleness tag, AND
 *   - Its creation timestamp is older than STALE_MAX_AGE_MS.
 */
function isStaleProposal(proposal: Record<string, unknown>): boolean {
  const tags: unknown = proposal["tags"];
  const tagArray: string[] = Array.isArray(tags)
    ? (tags as string[])
    : typeof tags === "string"
    ? [tags]
    : [];

  const hasStaleTag = tagArray.some((t) => STALE_TAGS.has(t));
  if (!hasStaleTag) return false;

  const created: unknown =
    proposal["created_at"] ?? proposal["createdAt"] ?? proposal["timestamp"];
  if (!created) return false;

  const createdMs =
    typeof created === "number"
      ? created
      : Date.parse(String(created));

  if (Number.isNaN(createdMs)) return false;

  return Date.now() - createdMs > STALE_MAX_AGE_MS;
}

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
   * Untargeted ordering when `proposal_id` is absent. Default `newest` — fresh
   * drafter output is the actionable stuff; `oldest` is FIFO. Anti-starvation is
   * handled by `proposal_id` targeting + the staleness window, not by ordering.
   */
  prefer?: "oldest" | "newest";
  /** Untargeted apply skips proposals older than this. Default 72h. A
   *  proposal_id-targeted apply bypasses it. */
  max_age_hours?: number;
  /** Re-attempt a content-matched sentinel older than this many hours (default 24). */
  retry_after_hours?: number;
  /** Re-attempt a FAILED (structuredError) sentinel sooner — default 2h. Failed attempts re-draft byte-identically, so a short TTL lets the improving patcher retry while the proposal is still in-window. */
  failed_retry_after_hours?: number;
  /** BOUNDED-RETRY: max proposals to ATTEMPT per untargeted invocation until one STAGES a
   *  mitosis (default 4). Before, a single anchor_not_found / semantic_reject / config-target
   *  reject ended the whole cycle with 0 throughput. proposal_id / dry_run force single-attempt. */
  max_apply_attempts?: number;
}

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return { shape: "structuredError", body: { resolver: "apply_proposal_as_patch", detail, ...(extra ?? {}) } };
}

/**
 * Self-propel the chain: a freshly staged mitosis-pending must not wait for the
 * boredom pool to re-select mitosis-tick — its UCB is low (it no_ops whenever no
 * pending exists), so a staged change can sit un-evaluated for ~an hour (observed
 * nudge-free: apply staged autonomously, then the pending idled 37min). Fire
 * mitosis-tick (evaluate→cutover) immediately, fire-and-forget, so apply→stage→
 * cutover is one continuous autonomous flow. Best-effort: if dispatch fails,
 * boredom still selects mitosis-tick eventually.
 */
function triggerMitosisTick(): void {
  try {
    const url = process.env["LIGHT_DISPATCH_URL"] ?? "http://127.0.0.1:8280/dispatch";
    const apiKey = process.env["METABOB_API_KEY"];
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({ template_id: "development-vessel:mitosis-tick", variables: {} }),
      signal: AbortSignal.timeout(180_000),
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
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
 * (Seam ③ / Change 5, 2026-06-19) Net-new resolver rate-limit. Authoring a
 * brand-new resolver expands the vessel's capability surface and touches the
 * three-place wiring (config + impulses + resolver file); a runaway author loop
 * could flood the staging tree. Count `.applied/` sentinels marked
 * `new_resolver:true` whose timestamp falls in the last hour; the caller skips
 * staging when the count is at/over MAX_NEW_RESOLVERS_PER_HOUR. Best-effort:
 * an unreadable sentinel dir returns 0 (fail-open — never block on IO error).
 */
async function countRecentNewResolverApplications(sentinelDir: string): Promise<number> {
  const oneHourAgo = Date.now() - 3_600_000;
  let count = 0;
  let names: string[];
  try { names = await readdir(sentinelDir); } catch { return 0; }
  for (const n of names) {
    try {
      const sj = JSON.parse(await readFile(`${sentinelDir}/${n}`, "utf-8")) as { new_resolver?: boolean; applied_at?: string; staged_at?: string };
      if (sj.new_resolver !== true) continue;
      const tsStr = sj.applied_at ?? sj.staged_at ?? null;
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      if (Number.isFinite(ts) && ts >= oneHourAgo) count++;
    } catch { /* tolerant */ }
  }
  return count;
}

/** True when any staged subPath authors a NET-NEW resolver source file. */
function stagesNewResolver(subPaths: string[]): boolean {
  return subPaths.some((p) => /(^|\/)src\/resolvers\/[^/]+\.ts$/.test(p));
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
    if (typeof m["inline-code-stripped"] === "string" && (m["inline-code-stripped"] as string).length > 0) {
      lines.push(`required_code_modifications[${i}].inline-code-stripped: ${(m["inline-code-stripped"] as string).slice(0, 4000)}`);
    }
    if (typeof m["anchor"] === "string" && m["anchor"].length > 0) {
      lines.push(`required_code_modifications[${i}].anchor: ${(m["anchor"] as string).slice(0, 4000)}`);
    }
    if (typeof m["verbatim"] === "string" && (m["verbatim"] as string).length > 0) {
      lines.push(`required_code_modifications[${i}].verbatim: ${(m["verbatim"] as string).slice(0, 4000)}`);
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

// Surgical pre-gate (2026-06-18). patch_with_tools is a SURGICAL editor: it
// applies one minimal, anchored edit to ONE file via fs_edit / code_replace_lines.
// Feature-sized proposals ("add a forward-model subsystem", "introduce a
// prediction pipeline") have no minimal edit, so the patcher correctly declares
// `fail` — but only AFTER burning up to max_attempts(3) x max_iterations(30) opus
// turns. In the 12h before this gate, patch_with_tools started 86x and failed
// 100x / succeeded 0x, uniformly on feature-sized proposals — a pure budget bleed
// that produced zero cutovers. This gate cheaply (regex, no LLM) skips proposals
// that read as new infrastructure with no concrete code anchor, so the expensive
// patcher only runs on proposals it can actually land. Feature-sized gaps stay
// OPEN and VISIBLE (skipped[] reason=non_surgical_proposal) instead of being
// silently burned — they await a feature-authoring capability the substrate does
// not yet have (the real S1->S2 boundary). Conservative by design: a proposal is
// skipped ONLY when it BOTH reads as a feature AND carries no concrete anchor.
const SURGICAL_MAX_DESC_LEN = 300;
const FEATURE_SCOPE_RE = /\b(subsystem|framework|infrastructure|pipeline|architecture|new\s+(model|system|module|engine|capability|abstraction)|forward[-\s]?model|predictor|forecast(ing)?|introduce\s+a\b|build\s+a\b|implement\s+a\s+(new\s+)?(model|system|framework|engine|pipeline))\b/i;
// Anchor signals that a proposal names a CONCRETE, minimal edit the surgical
// patcher can land. Conservative on purpose — every alternative is a marker of
// edit-locality, NOT of mere topic mention. The 2026-06-18 widening (export /
// comment-or-jsdoc / named-file / ALL_CAPS_UNDERSCORE constant) was added because
// genuinely-surgical proposals ("Add explicit export of WebSocketMessage type
// from the websocket/broadcaster module", "Add a JSDoc comment above the
// MAX_GOAL_LEN constant") were over-refused as `non_surgical_proposal`, starving
// the funnel (apply_proposal_as_patch skipped 50/50, flat `landed`). The new
// alternatives are chosen to NOT match feature prose, which references symbols
// only in lowercase snake/kebab form ("gap_landability backward model",
// "patch_proposal") and never names a concrete .ts file, an `export`, or an
// ALL_CAPS_WITH_UNDERSCORE constant.
const CONCRETE_ANCHOR_RE = /(`[^`]+`|===|!==|=>|\breturn\s+[\w'"{[]|\breplace\s+.{1,40}\bwith\b|\brename\b|\bimport\s*\{|\bexport\b|\bif\s*\(\s*\w|\bset\s+\w+\s*=|\bchange\s+.{1,50}\s+to\s+[\w'"]|\badd\s+(a\s+|an\s+)?(field|parameter|argument|guard|null[-\s]?check|early\s+return|case|branch|export|import|comment|jsdoc|doc[-\s]?comment|annotation|type\s+annotation|return\s+type|log(ging)?\s+statement|assertion)\b|\b[\w./-]+\.(ts|tsx|js|jsx|json|sql|sh|md|py)\b)/i;
// Named ALL_CAPS_WITH_UNDERSCORE constant (e.g. MAX_GOAL_LEN). Kept as a SEPARATE
// case-SENSITIVE regex: folding it into CONCRETE_ANCHOR_RE (which carries /i) made
// `[A-Z]` match lowercase, so feature prose with snake_case symbols
// ("gap_landability", "patch_proposal", "fs_list") falsely read as anchored. The
// underscore + true-uppercase requirement keeps this specific to named constants
// and excludes bare acronyms (HTTP, API, JSON) which have no underscore.
const CONSTANT_ANCHOR_RE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
export function assessProposalSurgical(descriptionText: string): { surgical: boolean; reason: string } {
  const text = (descriptionText ?? "").trim();
  if (!text) return { surgical: true, reason: "surgical" }; // no description to judge -> don't over-block
  const feature = FEATURE_SCOPE_RE.test(text);
  const anchor = CONCRETE_ANCHOR_RE.test(text) || CONSTANT_ANCHOR_RE.test(text);
  // Length is the robust signal: feature descriptions are verbose multi-clause
  // prose ("integrate P(...) prediction model, extract features, store pairs,
  // wire residuals back..."), surgical edits are short and concrete. Vocabulary
  // alone is whack-a-mole — drafters reword "forward model" -> "prediction model"
  // to evade a keyword list. A long description with NO concrete code anchor is
  // almost certainly a feature, regardless of wording.
  const verbose = text.length > SURGICAL_MAX_DESC_LEN;
  if ((feature || verbose) && !anchor) {
    return {
      surgical: false,
      reason: `non_surgical_proposal: ${feature ? "feature-scoped" : "verbose"} intent, no concrete code anchor — "${text.slice(0, 90).replace(/\s+/g, " ")}"`,
    };
  }
  return { surgical: true, reason: "surgical" };
}

// ---------------------------------------------------------------------------
// Staleness sweep helper — moves dead proposals out of the active backlog
// before the FIFO apply loop runs, so rare selection slots go to fresh work.
// ---------------------------------------------------------------------------
async function sweepStaleProposals(
  proposalsDir: string
): Promise<void> {
  let names: string[];
  try { names = await readdir(proposalsDir); } catch { return; }

  let swept = 0;
  for (const name of names) {
    if (!name.endsWith("-report.json")) continue;
    const filePath = join(proposalsDir, name);

    // Skip proposals already in a terminal state (path contains .rejected / .applied).
    if (
      filePath.includes(".rejected") ||
      filePath.includes(".applied")
    ) {
      continue;
    }

    let ageMs = 0;
    try { ageMs = Date.now() - (await stat(filePath)).mtimeMs; } catch { /* age unknown — do not sweep */ }

    let proposal: Record<string, unknown>;
    try {
      const raw = await readFile(filePath, "utf-8");
      proposal = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparseable (e.g. fence-wrapped JSON): once older than the staleness
      // window, rename into the terminal .rejected state so it stops being
      // rescanned; selection already ignores names not ending in -report.json.
      if (ageMs > STALE_MAX_AGE_MS) {
        try { await rename(filePath, `${filePath}.rejected`); swept++; } catch { /* non-fatal */ }
      }
      continue;
    }

    // Tag+created_at predicate first; legacy proposals carry neither, so fall
    // back to the staleness class in the filename plus file mtime.
    const staleByName = /(freshness_violation|precondition|analytic)/i.test(name);
    if (!isStaleProposal(proposal) && !(staleByName && ageMs > STALE_MAX_AGE_MS)) continue;

    // Mark the proposal as rejected due to staleness.
    const updated: Record<string, unknown> = {
      ...proposal,
      state: "rejected",
      rejection_reason: "staleness-sweep",
      swept_at: new Date().toISOString(),
      swept_by: "apply-proposal-as-patch/staleness-sweep",
    };

    try {
      await writeFile(filePath, JSON.stringify(updated, null, 2));
      swept++;
    } catch {
      // Non-fatal — log and continue so fresh proposals still get processed.
      console.warn(
        `[staleness-sweep] Failed to write rejected state to ${filePath}`
      );
    }
  }

  if (swept > 0) {
    console.log(
      `[staleness-sweep] Swept ${swept} stale proposal(s) older than ${STALE_MAX_AGE_DAYS} day(s) to rejected state.`
    );
  }
}

// Single attempt: select ONE eligible proposal (newest-first, skipping .applied sentinels and
// stale/staged), dispatch patch_with_tools once, and DURABLY mark the chosen proposal in
// .applied/ before returning — so a subsequent attempt deterministically skips it and picks the
// NEXT eligible proposal. Wrapped by resolveApplyProposalAsPatch (bounded-retry) below.
async function attemptApplyOnce(pointer: ApplyProposalAsPatchPointer): Promise<ResolverResult> {
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
      const cur = JSON.parse(curRaw) as { staged_at?: string; mitosis_version_id?: string; mitosis_root?: string };
      const ageMs = cur.staged_at ? Date.now() - Date.parse(cur.staged_at) : Number.POSITIVE_INFINITY;
      const staleMs = Number(process.env["MITOSIS_PENDING_STALE_MS"] ?? 1800000);
      if (Number.isFinite(ageMs) && ageMs < staleMs) {
        // Fresh pending: verify the staged_dir actually exists. If orphaned (dir gone),
        // treat as abandoned and allow overwriting.
        if (cur.mitosis_root) {
          try {
            await access(cur.mitosis_root);
            // Directory exists and pending is fresh -> refuse to clobber
            return structuredError("pending mitosis in flight — refusing to clobber", {
              pending_path: pendingPath,
              pending_mitosis_version_id: cur.mitosis_version_id ?? null,
              pending_age_ms: Math.round(ageMs),
              stale_after_ms: staleMs,
            });
          } catch {
            // Directory doesn't exist -> orphaned pending record, safe to proceed
          }
        } else {
          // No mitosis_root in pending JSON -> refuse as a precaution
          return structuredError("pending mitosis in flight — refusing to clobber", {
            pending_path: pendingPath,
            pending_mitosis_version_id: cur.mitosis_version_id ?? null,
            pending_age_ms: Math.round(ageMs),
            stale_after_ms: staleMs,
          });
        }
      }
    } catch {
      /* no pending file (or unreadable/parse-fail) -> safe to proceed */
    }
  }

  // Sweep stale proposals before FIFO iteration so they don't consume selection slots.
  await sweepStaleProposals(proposalsDir);

  // 1. List proposals.
  let entries: Array<{ name: string; path: string; mtime: number }> = [];
  try {
    const names = await readdir(proposalsDir);
    for (const n of names) {
      if (!n.endsWith("-report.json")) continue;
      // CHURN GUARD (2026-07-27, self-alteration-throughput-zero root). `*-compose-report.json`
      // files are feature_compose RESULT artifacts (verdict/ok/apply_failed — written to
      // /workspace/proposals so consumers like goal-host read the edit-intent outcome), NOT patch
      // proposals. The apply scan was ingesting ALL of them as candidates: measured 1588
      // compose-reports (2 actionable) vs 85 real proposals (83 actionable) — the churn buried the
      // actionable work so newest-first never reached it. Skip them in the UNTARGETED scan; a
      // targeted apply (proposal_id) can still address one explicitly.
      if (!pointer.proposal_id && n.endsWith("-compose-report.json")) continue;
      const p = join(proposalsDir, n);
      try { const s = await stat(p); entries.push({ name: n, path: p, mtime: s.mtimeMs }); } catch { /* skip */ }
    }
  } catch (err) {
    return structuredError(`cannot read proposals dir: ${(err as Error).message}`);
  }
  // (funnel) Default NEWEST-first: the funnel detector showed apply was stuck
  // because FIFO chewed a ~968-deep mostly-stale backlog before reaching fresh
  // drafter output. Fresh proposals are the actionable ones — try them first.
  // Anti-starvation is handled by `proposal_id` targeting, not FIFO ordering.
  const prefer = pointer.prefer ?? "newest";
  entries = entries.filter((p) => {
    const raw = p as unknown as { status?: string; stale?: boolean };
    const statusStale =
      raw.status === 'stale' ||
      raw.status === 'precondition_failed' ||
      raw.status === 'analytic';
    const boolStale = raw.stale === true;
    return !statusStale && !boolStale;
  });
  entries.sort((a, b) => (prefer === "oldest" ? a.mtime - b.mtime : b.mtime - a.mtime));
  // (funnel) staleness window for untargeted selection.
  const maxAgeMs = (pointer.max_age_hours ?? 72) * 3_600_000;
  const staleBefore = Date.now() - maxAgeMs;

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
  let chosen: { name: string; path: string; scenarioId: string; content: string; targetFile: string; isNewFile?: boolean } | null = null;
  // Capture the first FEATURE-scoped (non-surgical) proposal we skip, so that when
  // no surgical proposal is eligible we can route it through feature_compose
  // instead of dropping it (2026-06-22 routing wire — see the !chosen block below).
  let firstFeatureProposal: { name: string; spec: string; contentSha: string } | null = null;
  for (const e of entries) {
    const scenarioId = e.name.replace(/-report\.json$/, "");
    if (mitosisDirs.some((d) => d.includes(scenarioId.slice(0, 32)))) { skipped.push({ proposal: e.name, reason: "already_staged" }); continue; }
    // (funnel) skip the stale backlog so the ancient dead-proposal pile
    // (freshness/precondition/analytic reports) doesn't starve fresh actionable
    // drafter output. A proposal_id-targeted apply bypasses this.
    if (!pointer.proposal_id && e.mtime < staleBefore) { skipped.push({ proposal: e.name, reason: "stale_beyond_window" }); continue; }
    let content: string;
    try { content = await readFile(e.path, "utf-8"); } catch { skipped.push({ proposal: e.name, reason: "read_failed" }); continue; }
    // Content-aware applied-sentinel (2026-06-17). The sentinel was keyed by
    // FILENAME and written on stage-ATTEMPT (not on land); the drafter reuses a
    // scenario's filename on every re-draft, so a recurring gap whose prior
    // attempt never landed was blocked FOREVER — the dominant cause of flat
    // landing throughput. Skip only if this EXACT content was already attempted
    // (content_sha match); a re-draft with NEW content is a fresh attempt and
    // falls through. Legacy sentinels (no content_sha) are treated as applied
    // to avoid re-flooding the historical backlog — a recurring gap is unblocked
    // by clearing its legacy sentinel once, after which content_sha governs.
    const contentSha = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (appliedSet.has(e.name)) {
      let priorSha: string | null = null;
      let priorTs: number | null = null;
      let priorOutcome: string | null = null;
      try {
        const sj = JSON.parse(await readFile(`${sentinelDir}/${e.name}`, "utf-8")) as { content_sha?: string; applied_at?: string; staged_at?: string; outcome_shape?: string };
        priorSha = sj.content_sha ?? null;
        const tsStr = sj.applied_at ?? sj.staged_at ?? null;
        priorTs = tsStr ? Date.parse(tsStr) : null;
        priorOutcome = sj.outcome_shape ?? null;
      } catch { priorSha = null; priorTs = null; priorOutcome = null; }
      // Retry TTL (2026-06-18): a content_sha match normally means "already attempted,
      // skip". But a PERSISTENT real issue (e.g. a typecheck error whose first patch
      // attempt failed) is re-drafted with IDENTICAL content forever, so it was
      // sentinel-blocked PERMANENTLY — the substrate could never land a fix for any
      // error whose first attempt failed, even after the patcher itself improved (e.g.
      // the no-op-done recovery). Expire the sentinel after retry_after_hours so
      // persistent work becomes re-attemptable. Feature-sized re-attempts are cheaply
      // re-skipped by the surgical pre-gate; already-fixed ones abort fast via the
      // no-op-done guard. This is what keeps the autonomous loop SUPPLIED with landable
      // work instead of starving once every fresh proposal has been tried once.
      const retryAfterMs = (priorOutcome === "structuredError"
        ? (pointer.failed_retry_after_hours ?? 2)
        : (pointer.retry_after_hours ?? 24)) * 3_600_000;
      const sentinelExpired = priorTs !== null && (Date.now() - priorTs) > retryAfterMs;
      if ((priorSha === null || priorSha === contentSha) && !sentinelExpired) { skipped.push({ proposal: e.name, reason: "already_applied_sentinel" }); continue; }
      // else: drafter produced NEW content (fresh attempt) OR the sentinel expired
      // (retry persistent work that may now be landable) — do NOT skip.
    }
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
    const pFull = parsed as { kind?: string; required_code_modifications?: Array<{ file?: string }>; new_files?: Array<{ path?: string; content?: string }>; overwrite_files?: Array<{ path?: string; content?: string }>; vessel_shape_coverage?: unknown; trace_family_distribution?: unknown; [k: string]: unknown };
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
    // (Seam ③ / Change 2, 2026-06-19) Split file-existence verification by
    // intent. Cited EDIT targets (required_code_modifications[].file) MUST
    // exist — an absent one is still a path hallucination. Declared NEW files
    // (new_files[].path) MUST NOT exist — absence is now EXPECTED/accepted
    // (the prior single-list gate rejected every genuinely-new file as a
    // hallucination, the dead-gate). A "new" file that ALREADY exists is a
    // distinct error (new_file_collision). Both still require derive-vessel +
    // path-escape protection.
    const filesMustExist: string[] = [];
    if (targetFile) filesMustExist.push(targetFile);
    const filesMustBeNew: string[] = [];
    if (Array.isArray(wrappedNewFiles)) {
      for (const nf of wrappedNewFiles) if (typeof nf.path === "string") filesMustBeNew.push(nf.path);
    }
    if (hasNewFiles) {
      for (const nf of pFull.new_files!) if (typeof nf.path === "string") filesMustBeNew.push(nf.path);
    }
    // (Seam ③ / Change 3) overwrite_files[] — paths the proposal declares as
    // MODIFICATION targets to be staged with full spliced content (e.g. the
    // author-new-resolver chain's spliced config.ts + impulses.ts). They MUST
    // EXIST (they are overwrites, not new files) and are therefore EXEMPT from
    // the new_file_collision check. Bounded strictly to these declared paths.
    const overwriteFilesRaw = Array.isArray(pFull.overwrite_files)
      ? pFull.overwrite_files.filter((f): f is { path: string; content: string } => f != null && typeof f.path === "string" && typeof f.content === "string")
      : [];
    const filesToOverwriteInStaging = overwriteFilesRaw.map((f) => f.path);
    let gateFail = false;
    let gateReason: "file_path_hallucination" | "new_file_collision" = "file_path_hallucination";
    const offendingFiles: string[] = [];
    for (const f of [...filesMustExist, ...filesToOverwriteInStaging]) {
      if (f.includes("..") || f.startsWith("/")) { gateFail = true; gateReason = "file_path_hallucination"; offendingFiles.push(`${f} (path escape)`); break; }
      const d = deriveVesselFromPath(f);
      if (!d) { gateFail = true; offendingFiles.push(`${f} (cannot derive vessel)`); break; }
      const livePath = join(vesselsRoot, d.vessel, d.subPath);
      if (!(await exists(livePath))) { gateFail = true; offendingFiles.push(f); }
    }
    if (!gateFail) {
      const overwriteSet = new Set(filesToOverwriteInStaging);
      for (const f of filesMustBeNew) {
        if (overwriteSet.has(f)) continue; // declared as overwrite — handled above, exempt
        if (f.includes("..") || f.startsWith("/")) { gateFail = true; gateReason = "file_path_hallucination"; offendingFiles.push(`${f} (path escape)`); break; }
        const d = deriveVesselFromPath(f);
        if (!d) { gateFail = true; gateReason = "file_path_hallucination"; offendingFiles.push(`${f} (cannot derive vessel)`); break; }
        const livePath = join(vesselsRoot, d.vessel, d.subPath);
        if (await exists(livePath)) { gateFail = true; gateReason = "new_file_collision"; offendingFiles.push(f); }
        // ABSENT is expected for a NEW file — accept.
      }
    }
    if (gateFail) {
      // Archive to .rejected/ so next cycle's mtime walk treats it as already-handled.
      const rejectedDir = `${proposalsDir}/.rejected`;
      try { await mkdir(rejectedDir, { recursive: true }); } catch { /* tolerant */ }
      try {
        await writeFile(`${rejectedDir}/${e.name}`,
          JSON.stringify({ rejected_at: new Date().toISOString(), reason: gateReason, offending: offendingFiles, original_content_preview: content.slice(0, 500) }, null, 2));
        // Move the original out of the active dir so the mtime-sort doesn't keep re-selecting it.
        // We can't unlink/rename across the resolver boundary safely, so write a sentinel into
        // .applied/ — apply-loop reads .applied/ and skips matching entries (see appliedSet).
        await writeFile(`${proposalsDir}/.applied/${e.name}`,
          JSON.stringify({ rejected_at: new Date().toISOString(), reason: gateReason, offending: offendingFiles, content_sha: contentSha }, null, 2));
      } catch { /* tolerant */ }
      skipped.push({ proposal: e.name, reason: `${gateReason}: ${offendingFiles.join(", ").slice(0, 120)}` });
      continue;
    }
    // Surgical pre-gate (2026-06-18): only the single-file patch_with_tools path
    // is gated (new_files[] proposals write full content directly, no patcher).
    // Skips feature-sized proposals cheaply so the expensive patcher only runs on
    // proposals it can land; feature gaps stay visible in skipped[].
    if (targetFile && !effectiveHasNewFiles) {
      const descText = mods
        .map((m) => { const d = (m as { description?: string }).description; return typeof d === "string" ? d : ""; })
        .filter(Boolean)
        .join(" \n ") || content;
      let surg = assessProposalSurgical(descText);
      if (!surg.surgical) {
        // Feature-scoped: too big for the single-patch path. Capture the first one
        // so the !chosen block can route it to feature_compose (decompose→atoms).
        if (!firstFeatureProposal && descText.trim()) firstFeatureProposal = { name: e.name, spec: descText, contentSha };
        console.error(`[apply-proposal-as-patch] skip non_surgical_proposal: ${e.name} reason=${surg.reason}`); skipped.push({ proposal: e.name, reason: surg.reason }); continue;
      }
    }
    // (Seam ③) Description-only NET-NEW file: proposal cites exactly one new
    // file (a new_files[] path with NO full content, so the multi-file
    // full-content path below does not pick it up) and NO edit target. Route it
    // through the single-file patcher with is_new_file:true so the patcher
    // AUTHORS the file via fs_write. (A new_files[] entry WITH content is handled
    // by the multi-file direct-write path; effectiveHasNewFiles guards that.)
    let effectiveTarget = targetFile ?? "";
    let chosenIsNew = false;
    if (!targetFile && !effectiveHasNewFiles && filesMustBeNew.length === 1) {
      effectiveTarget = filesMustBeNew[0]!;
      chosenIsNew = true;
    }
    chosen = { name: e.name, path: e.path, scenarioId, content, targetFile: effectiveTarget, isNewFile: chosenIsNew };
    break;
  }
  if (!chosen) {
    // No work done = not a success. Boredom Thompson posteriors must record
    // this as a no-op outcome so momentum decays and other goals (drafter,
    // mitosis-tick) get score, instead of looping on apply-proposal because
    // it always returns success regardless of whether it actually staged
    // anything. structuredError makes the dispatcher record failure_count++
    // without polluting α with empty wins.
    // ROUTING WIRE (2026-06-22): no surgical proposal was eligible this drain.
    // Rather than DROP the feature-scoped proposals (which the surgical pre-gate
    // skips as non_surgical), route the first one THROUGH feature_compose — it
    // decomposes the feature spec into surgical atoms, applies with edit-repair,
    // typecheck-verifies (FAVORABLE→stage via the existing cutover gate /
    // UNFAVORABLE→rollback). This closes the gap where feature-gaps never reached
    // the composer. Bounded to one per drain so the LLM cost is paid only when
    // there is no cheaper surgical work; landing safety stays with the cutover
    // gate. Disable with ROUTE_FEATURE_PROPOSALS_TO_COMPOSE=0.
    if (firstFeatureProposal && process.env["ROUTE_FEATURE_PROPOSALS_TO_COMPOSE"] !== "0") {
      try {
        const fc = await resolveFeatureCompose({
          type: "feature_compose",
          spec: firstFeatureProposal.spec,
          dry_run: false,
          keep_on_fail: false,
          land: true,
        } as Parameters<typeof resolveFeatureCompose>[0]);
        const fb = (fc.body ?? {}) as Record<string, unknown>;
        try { await writeFile(join(sentinelDir, firstFeatureProposal.name), JSON.stringify({ content_sha: firstFeatureProposal.contentSha, applied_at: new Date().toISOString(), outcome_shape: fb["verdict"] === "FAVORABLE" ? "featureRouted" : "structuredError" })); } catch { /* tolerant */ }
        return {
          shape: "featureRoutedReport",
          body: {
            resolver: "apply_proposal_as_patch",
            routed_to: "feature_compose",
            proposal: firstFeatureProposal.name,
            verdict: fb["verdict"] ?? null,
            ok: fb["ok"] ?? (fb["verdict"] === "FAVORABLE"),
            touched_vessels: fb["touched_vessels"] ?? null,
            note: "no surgical proposal eligible — routed first feature-scoped proposal through feature_compose (decompose→verify→stage)",
            total_proposals: entries.length,
            skipped: skipped.slice(0, 50),
          },
        };
      } catch (err) {
        return structuredError("feature_compose routing failed", { proposal: firstFeatureProposal.name, error: (err as Error).message, total_proposals: entries.length });
      }
    }
    return {
      shape: "mitosisStaged",
      body: {
        resolver: "apply_proposal_as_patch",
        dispatched: null,
        skipped: true,
        skip_reason: "no_eligible_proposals",
        total_proposals: entries.length,
        skipped_proposals: skipped.slice(0, 50),
      },
    };
  }
  // Multi-file proposals path (2026-06-05): if proposal carries `new_files[]`
  // (each {path, content} starting with `repos/<vessel>/`), write all of them
  // into the staged mitosis dir without LLM-patching. Same-vessel constraint:
  // all new_files must share a vessel root. This is how the resolver-author
  // chain ships new-resolver scaffolds; vessel-mitosis-cutover already accepts
  // N staged_files via host-sync intent. The search/replace path below remains
  // the canonical single-file flow.
  type ParsedFull = { new_files?: Array<{ path?: string; content?: string }>; overwrite_files?: Array<{ path?: string; content?: string }>; required_code_modifications?: Array<{ file?: string }> };
  let parsedFull: ParsedFull | null = null;
  const tolerantFull = parseFirstJsonObject(chosen.content);
  if (tolerantFull && typeof tolerantFull === "object") parsedFull = tolerantFull as ParsedFull;
  const newFiles = ((parsedFull?.new_files ?? []) as Array<{ path?: string; content?: string }>).filter(
    (f): f is { path: string; content: string } =>
      f != null && typeof f.path === "string" && typeof f.content === "string",
  );
  // (Seam ③ / Change 3) Spliced MODIFICATION targets — existing files (config.ts,
  // impulses.ts) staged with full content. They co-stage with new_files in the
  // same mitosis tree; the gate above already verified they EXIST (exempt from
  // new_file_collision). Tagged so the staging loop and rate-limit see them.
  const overwriteFiles = ((parsedFull?.overwrite_files ?? []) as Array<{ path?: string; content?: string }>).filter(
    (f): f is { path: string; content: string } =>
      f != null && typeof f.path === "string" && typeof f.content === "string",
  );
  if (newFiles.length + overwriteFiles.length > 0) {
    // Verify all share a vessel root and none escape the staging tree.
    const vesselRoots = new Set<string>();
    const fileEntries: Array<{ vessel: string; subPath: string; content: string; absSource: string }> = [];
    for (const nf of [...newFiles, ...overwriteFiles]) {
      if (nf.path.includes("..") || nf.path.startsWith("/")) {
        return structuredError(`multi-file path escape: ${nf.path}`, { proposal: chosen.name });
      }
      const d = deriveVesselFromPath(nf.path);
      if (!d) return structuredError(`multi-file path cannot derive vessel: ${nf.path}`, { proposal: chosen.name });
      vesselRoots.add(d.vessel);
      fileEntries.push({ vessel: d.vessel, subPath: d.subPath, content: nf.content, absSource: nf.path });
    }
    if (vesselRoots.size !== 1) {
      return structuredError(`new_files[] must target a single vessel; got: ${[...vesselRoots].join(",")}`, { proposal: chosen.name });
    }
    const vesselOnly = [...vesselRoots][0]!;
    // (Seam ③ / Change 5) Net-new resolver rate-limit. A multi-file proposal that
    // authors a new src/resolvers/*.ts file is bounded per hour so a runaway
    // author loop cannot flood the staging tree with capability-surface growth.
    const multifileSubPaths = fileEntries.map((e) => e.subPath);
    if (stagesNewResolver(multifileSubPaths)) {
      const maxPerHour = Number(process.env["MAX_NEW_RESOLVERS_PER_HOUR"] ?? 2);
      const recent = await countRecentNewResolverApplications(sentinelDir);
      if (recent >= maxPerHour) {
        return structuredError("new_resolver_rate_limited", {
          proposal: chosen.name,
          recent_new_resolver_applications: recent,
          max_per_hour: maxPerHour,
        });
      }
    }
    // NEW-CAPABILITY-STUB GATE (multifile self-landing path). apply_proposal_as_patch
    // self-cutovers via mitosis with NO semantic judge and NO stub check
    // (verifyPatchAddressesGap is not on this path — see the note by the single-file
    // patcher call below), which is how a net-new resolver STUB (shellResult, 9a019a0)
    // shipped green. REUSE detectNewCapabilityStub on the AUTHORED net-new files: the
    // "diff" of an added file is its whole content, each line `+`-prefixed under a
    // `### NEW FILE` header (the form feature-compose builds → diffIsCreateHeavy true).
    // Overwrite edits are excluded (whole-content `+`-prefixing would misread an edit).
    if (newFiles.length > 0) {
      const { detectNewCapabilityStub } = await import("./feature-compose.js");
      const newFileDiff = newFiles
        .map((nf) => `### NEW FILE ${nf.path}\n` + String(nf.content ?? "").split("\n").map((l) => `+${l}`).join("\n"))
        .join("\n\n");
      const stub = detectNewCapabilityStub(newFileDiff);
      if (stub.isStub) {
        try {
          await writeFile(`${proposalsDir}/.applied/${chosen.name}`, JSON.stringify({
            rejected_at: new Date().toISOString(),
            reason: "new_capability_stub",
            multifile: true,
            marker: stub.marker ?? null,
            symbol: stub.symbol ?? null,
            stub_reason: stub.reason,
          }, null, 2));
        } catch { /* tolerant */ }
        return structuredError("new_capability_stub", {
          proposal: chosen.name,
          vessel: vesselOnly,
          marker: stub.marker,
          symbol: stub.symbol,
          detail: `refusing to stage/cutover a net-new capability that is a stub, not a functional implementation — ${stub.reason}`,
        });
      }
    }
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
    // A WRITE THAT SUCCEEDS IS NOT AN EDIT (task #54, 2026-08-10).
    //
    // stagedFiles recorded a name whenever writeFile did not throw — it never
    // asked whether the content DIFFERS from what is live. A proposal that
    // reproduces the current file byte-for-byte therefore staged "successfully"
    // and returned mitosisStaged, and the operator then went looking for an edit
    // that does not exist on disk. That is the reported symptom exactly.
    //
    // The downstream cost is worse than the confusion: a no-op staging occupies
    // the mitosis slot, drives evaluate→cutover, and lands a commit whose diff is
    // empty — consuming a change window and a Thompson observation for nothing.
    //
    // Counting changed files (not written ones) also makes the returned
    // file_count honest, which the cutover's freshness anchor reads.
    let unchangedCount = 0;
    for (const e of fileEntries) {
      const stagedFile = join(mitosisRoot, e.subPath);
      try {
        // Compare against the LIVE file, which is what a cutover would overwrite.
        // Missing (net-new) counts as changed — that is the whole point of a new file.
        const livePath = join(vesselsRoot, vesselOnly, e.subPath);
        let liveContent: string | null = null;
        try { liveContent = await readFile(livePath, "utf8"); } catch { liveContent = null; }
        if (liveContent !== null && liveContent === e.content) {
          unchangedCount++;
          continue; // staged on disk for inspection, but NOT counted as an edit
        }
        await mkdir(dirname(stagedFile), { recursive: true });
        await writeFile(stagedFile, e.content);
        stagedFiles.push(e.subPath);
      } catch (err) {
        return structuredError(`stage write failed: ${(err as Error).message}`, { staged_file: stagedFile });
      }
    }
    if (stagedFiles.length === 0) {
      // Every file in the proposal already matches live. Refusing here is what
      // stops an empty commit from consuming a change window, and it names the
      // reason so the drafter's redundancy is visible rather than silent.
      return structuredError("proposal is a no-op: every file already matches the live tree", {
        proposal: chosen.name,
        vessel: vesselOnly,
        files_examined: fileEntries.length,
        files_unchanged: unchangedCount,
      });
    }
    const versionId = `mitosis-${stamp}`;
    // FRESHNESS ANCHOR (2026-06-30). The cutover's freshness gate hashes the LIVE
    // staged_files[0] and requires it to equal staged_base_sha ("did the file we're
    // about to overwrite drift since staging?"). new_files sort first in
    // fileEntries, but a NET-NEW file is absent live → currentLiveSha=null → the
    // gate can never pass; and this multifile path previously omitted base_sha
    // entirely, so the cutover refused with missing_base_sha BEFORE reaching the
    // direct-push path (why goal-host's single-file stagings land but multifile/
    // net-new-resolver stagings did not). Anchor freshness on an EXISTING overwrite
    // file: hash its live content as base_sha and order it first so the cutover's
    // staged_files[0] sentinel is that existing file. Mirrors patch-with-tools.ts
    // (base_sha: beforeSha) and feature-compose.ts (sha256sum of the live file).
    let baseSha = createHash("sha256").update("").digest("hex").slice(0, 12);
    let orderedStagedFiles = stagedFiles;
    const sentinelSubPath = overwriteFiles.length > 0
      ? fileEntries[newFiles.length]?.subPath // first overwrite entry (existing file)
      : stagedFiles[0];
    if (sentinelSubPath) {
      try {
        const liveSentinel = join(vesselsRoot, vesselOnly, sentinelSubPath);
        if (await exists(liveSentinel)) {
          baseSha = createHash("sha256").update(await readFile(liveSentinel)).digest("hex").slice(0, 12);
        }
      } catch { /* keep sha256("") fallback */ }
      orderedStagedFiles = [sentinelSubPath, ...stagedFiles.filter((f) => f !== sentinelSubPath)];
    }
    const pendingBody = {
      vessel_name: vesselOnly,
      base_version_id: "v1",
      mitosis_version_id: versionId,
      mitosis_root: mitosisRoot,
      staged_at: new Date().toISOString(),
      authored_by: "apply_proposal_as_patch:multifile",
      proposal: chosen.name,
      staged_files: orderedStagedFiles,
      base_sha: baseSha,
      multifile: true,
    };
    try { await writeFile(pendingPath, JSON.stringify(pendingBody, null, 2)); }
    catch (err) { return structuredError(`pending write failed: ${(err as Error).message}`); }
    try {
      await writeFile(`${proposalsDir}/.applied/${chosen.name}`,
        JSON.stringify({ staged_at: pendingBody.staged_at, mitosis_version_id: versionId, multifile: true, file_count: stagedFiles.length, new_resolver: stagesNewResolver(multifileSubPaths), content_sha: createHash("sha256").update(chosen.content).digest("hex").slice(0, 16) }, null, 2));
    } catch { /* tolerant */ }
    triggerMitosisTick(); // self-propel: evaluate→cutover without boredom latency
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

  // UNRELATED-CONFIG-TARGET GATE (2026-07-27). apply_proposal_as_patch dispatches the SURGICAL
  // patcher (which self-lands via mitosis cutover) with NO check that the diff ADDRESSES the
  // proposal — verifyPatchAddressesGap (feature-compose) is NOT on this path. EVIDENCE: a
  // "route-edit ... compose-report" proposal landed a patch that ONLY bumped package.json
  // "version" 1.20.9->1.20.10 (activity-api 2f4093c). Deterministically REJECT when the cited
  // target is a package.json / lockfile / .yaml / .sh / scripts/ file AND the proposal never
  // names that file nor mentions version/bump/dependency/script/manifest — a config edit the
  // proposal does not actually describe. A legit "bump dep X" / "add build script" proposal
  // names the file or a keyword and passes; a source (.ts/.tsx/.js) target never trips this.
  {
    const isNonSourceTarget =
      /(^|\/)(package(-lock)?\.json|bun\.lockb?|yarn\.lock)$/.test(subPath) ||
      /\.(lock|ya?ml)$/.test(subPath) ||
      /(^|\/)scripts\//.test(subPath) ||
      /\.sh$/.test(subPath);
    if (isNonSourceTarget) {
      const intentLc = String(chosen.content).toLowerCase();
      const base = (subPath.split("/").pop() ?? subPath).toLowerCase();
      const namesTarget = intentLc.includes(base) ||
        /(version|bump|semver|\brelease\b|dependenc|devdependenc|package\.json|lock\s*file|lockfile|\bscript\b|manifest)/i.test(String(chosen.content));
      if (!namesTarget) {
        try { await writeFile(`${proposalsDir}/.applied/${chosen.name}`, JSON.stringify({ rejected_at: new Date().toISOString(), reason: "unrelated_config_target", target_file: targetFile }, null, 2)); } catch { /* tolerant */ }
        return structuredError("unrelated_config_target", {
          proposal: chosen.name,
          target_file: targetFile,
          detail: `cited target ${subPath} is a non-source config/lock/script the proposal never names (nor version/dependency/script/manifest) — refusing to land an edit unrelated to the proposal`,
        });
      }
    }
  }

  // 4. Read live source (under /vessels/<vessel>/<subPath>); compute SHA.
  // (Seam ③) For a NET-NEW file the live source is EXPECTED absent — tolerate it
  // and thread is_new_file through to the patcher (which authors via fs_write).
  const liveSrcPath = join(vesselsRoot, vessel, subPath);
  const isNewFileTarget = chosen.isNewFile === true;
  if (!isNewFileTarget && !(await exists(liveSrcPath))) {
    return structuredError(`live source missing: ${liveSrcPath}`, { proposal: chosen.name, target_file: targetFile });
  }
  const liveSrc = isNewFileTarget ? "" : await readFile(liveSrcPath, "utf-8");
  const baseSha = createHash("sha256").update(liveSrc).digest("hex").slice(0, 12);

  // (Seam ③ / Change 5) Net-new resolver rate-limit on the patcher-authored path.
  if (isNewFileTarget && stagesNewResolver([subPath])) {
    const maxPerHour = Number(process.env["MAX_NEW_RESOLVERS_PER_HOUR"] ?? 2);
    const recent = await countRecentNewResolverApplications(`${proposalsDir}/.applied`);
    if (recent >= maxPerHour) {
      return structuredError("new_resolver_rate_limited", {
        proposal: chosen.name,
        target_file: targetFile,
        recent_new_resolver_applications: recent,
        max_per_hour: maxPerHour,
      });
    }
  }

  if (dryRun) {
    return { shape: "mitosisStaged", body: { dispatched: null, dry_run: true, would_stage: { proposal: chosen.name, target: targetFile, vessel, base_sha: baseSha, is_new_file: isNewFileTarget } } };
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
  let result: Awaited<ReturnType<typeof resolvePatchWithTools>> = await resolvePatchWithTools({
    type: "patch_with_tools",
    proposal_text: sanitizeProposalForPatcher(chosen.content),
    target_file: targetFile,
    is_new_file: isNewFileTarget,
    vessels_root: vesselsRoot,
    workspace_root: workspaceRoot,
    gap_id: chosen.name.replace(/-report\.json$/, ""),
    proposal_id: pointer.proposal_id ?? chosen.name.replace(/-report\.json$/, ""),
  });
  // Observability (operator-demo-apply-observability): log apply failures. Re-anchored AFTER the
  // call — the original landing mis-inserted this block inside the argument literal (syntax break).
  if (result.shape === "structuredError") {
    console.error(`Proposal ${chosen.name} failed to apply: ${JSON.stringify((result.body as Record<string, unknown>).detail)}`);
  }
  // FAVORABLE-gate semantic no-op guard: when the RAW proposal (backticks intact)
  // says replace `A` with `B`, the staged file MUST contain B verbatim. Otherwise
  // the patcher wrote a typecheck-clean anchor deviation (e.g. told outcome_shape,
  // wrote sj.outcome) that passes tests but is a no-op against intent.
  if (result.shape === "mitosisStaged" && result.body && typeof (result.body as { mitosis_root?: unknown }).mitosis_root === "string") {
    const raw = chosen.content;
    const replaceRe = /replace\s+`([^`\n]+)`\s+with\s+`([^`\n]+)`/gi;
    const required: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = replaceRe.exec(raw)) !== null) {
      if (m[2]) required.push(m[2]);
    }
    if (required.length > 0) {
      try {
        const stagedPath = join((result.body as { mitosis_root: string }).mitosis_root, subPath);
        const stagedContent = await readFile(stagedPath, "utf-8");
        const missing = required.filter((r) => !stagedContent.includes(r));
        if (missing.length > 0) {
          result = structuredError("verbatim_anchor_missing_post_stage", {
            proposal: chosen.name,
            target_file: targetFile,
            missing_anchors: missing,
          }) as typeof result;
        }
      } catch { /* if we cannot read the staged file, leave result as-is */ }
    }
  }
  // NEW-CAPABILITY-STUB GATE (single-file net-new). The patcher authors a net-new file into
  // the mitosis dir, then this path self-cutovers with no stub check. Read the STAGED file
  // (like the verbatim-anchor guard above) and reject before cutover if the authored capability
  // is a stub. Scoped to isNewFileTarget: a whole-file `+` diff only represents a NET-NEW file
  // correctly; surgical edits to existing files are untouched.
  if (isNewFileTarget && result.shape === "mitosisStaged" && result.body) {
    try {
      const stubMitosisRoot = (result.body as { mitosis_root?: string }).mitosis_root;
      if (stubMitosisRoot) {
        const { detectNewCapabilityStub } = await import("./feature-compose.js");
        const stagedContent = await readFile(join(stubMitosisRoot, subPath), "utf-8");
        const newFileDiff = `### NEW FILE ${subPath}\n` + stagedContent.split("\n").map((l) => `+${l}`).join("\n");
        const stub = detectNewCapabilityStub(newFileDiff);
        if (stub.isStub) {
          try {
            await writeFile(`${proposalsDir}/.applied/${chosen.name}`, JSON.stringify({
              rejected_at: new Date().toISOString(),
              reason: "new_capability_stub",
              target_file: targetFile,
              marker: stub.marker ?? null,
              symbol: stub.symbol ?? null,
              stub_reason: stub.reason,
            }, null, 2));
          } catch { /* tolerant */ }
          result = structuredError("new_capability_stub", {
            proposal: chosen.name,
            target_file: targetFile,
            marker: stub.marker,
            symbol: stub.symbol,
            detail: `refusing to cutover a net-new capability that is a stub, not a functional implementation — ${stub.reason}`,
          }) as typeof result;
        }
      }
    } catch { /* if we cannot read the staged file, leave result as-is (do not false-fail) */ }
  }
  // Self-propel evaluate→cutover the moment patch_with_tools stages a mitosis.
  if (result.shape === "mitosisStaged") triggerMitosisTick();
  // Mark this proposal applied regardless of outcome so the next cycle
  // picks a different one; downstream cutover/host-sync decide whether the
  // staged patch lands.
  try {
  if (result.shape === "structuredError") {
    const patchDetail = String((result.body as Record<string, unknown>).detail ?? "");
    console.error(`[apply_proposal_as_patch] patch_with_tools failed for ${chosen.name}: ${patchDetail}`);
    // Record the patch no-op/failure in .rejected/ so the drafter's
    // prior_failed_attempts resolver surfaces it and the drafter stops
    // re-proposing un-landable fixes. patch_with_tools no-op ("LLM declared
    // done without editing") + verify-fail are the dominant landing-killers;
    // only file_path_hallucination was captured here before, so the drafter
    // was blind to them. (2026-06-18)
    const patchReason = /without making any edit|no-?op|needs no change/i.test(patchDetail)
      ? "patch_noop"
      : /failing typecheck|verify/i.test(patchDetail)
      ? "patch_typecheck_fail"
      : "patch_failed";
    const patchRejectedDir = `${proposalsDir}/.rejected`;
    try { await mkdir(patchRejectedDir, { recursive: true }); } catch { /* tolerant */ }
    try {
      await writeFile(`${patchRejectedDir}/${chosen.name}`,
        JSON.stringify({ rejected_at: new Date().toISOString(), reason: patchReason, target_file: targetFile, detail: patchDetail.slice(0, 300), original_content_preview: chosen.content.slice(0, 500) }, null, 2));
    } catch { /* tolerant */ }
  }
    await writeFile(`${proposalsDir}/.applied/${chosen.name}`,
      JSON.stringify({ delegated_to: "patch_with_tools", outcome_shape: result.shape, applied_at: new Date().toISOString(), new_resolver: isNewFileTarget && stagesNewResolver([subPath]) && result.shape === "mitosisStaged", content_sha: createHash("sha256").update(chosen.content).digest("hex").slice(0, 16) }, null, 2));
  } catch { /* tolerant */ }
  return result;
}

// BOUNDED-RETRY (2026-07-27, closes self-alteration-throughput-zero-apply). The substrate's own
// funnel showed apply landed 0 cutovers in 6h despite 16 proposals authored: attemptApplyOnce
// picks ONE proposal and, on ANY per-proposal failure (anchor_not_found / patch_noop /
// semantic_reject / config-target or orphan gate reject / malformed target), archives it to
// .applied/ and RETURNS — never trying the next actionable proposal. Because each attempt DURABLY
// marks its proposal in .applied/ BEFORE returning (and the selection loop at line ~611 skips
// appliedSet members), re-invoking attemptApplyOnce deterministically advances to the NEXT
// eligible proposal. Try up to K per invocation until one genuinely STAGES a mitosis, then stop.
// STOP (no further attempt) on: a real stage (mitosisStaged), no_eligible_proposals (also
// mitosisStaged, skipped:true), feature_compose routing (featureRoutedReport), any GLOBAL/fatal
// error (structuredError not naming a proposal), a rate-limit / targeted-not-found / dir-read
// error, or a repeated proposal (anti-spin). proposal_id-targeted and dry_run keep single-attempt
// semantics — targeting must NEVER skip to a different proposal. K bounds per-cycle patch_with_tools
// (LLM) cost; most non-actionable proposals are rejected cheaply before reaching the patcher.
export async function resolveApplyProposalAsPatch(pointer: ApplyProposalAsPatchPointer): Promise<ResolverResult> {
  const maxAttempts = (pointer.proposal_id || pointer.dry_run) ? 1 : Math.max(1, pointer.max_apply_attempts ?? 4);
  let last: ResolverResult | null = null;
  const tried = new Set<string>();
  for (let i = 0; i < maxAttempts; i++) {
    const res = await attemptApplyOnce(pointer);
    last = res;
    // Any non-error outcome is terminal: a real stage (success), no_eligible_proposals
    // (mitosisStaged skipped:true), or a feature_compose routing report. Stop.
    if (res.shape !== "structuredError") return res;
    const body = (res.body ?? {}) as Record<string, unknown>;
    // A GLOBAL/fatal error names no proposal (e.g. "cannot read proposals dir") — retrying a
    // different proposal cannot help. Stop.
    if (typeof body.proposal !== "string") return res;
    const reason = `${String(body.detail ?? "")} ${String(body.reason ?? "")}`.toLowerCase();
    // Errors where advancing to another proposal is wrong or futile this cycle. Stop.
    if (/rate_limited|targeted proposal not found|cannot read proposals dir|feature_compose routing failed/.test(reason)) return res;
    // Anti-spin: a proposal that failed WITHOUT being marked (rare malformed-target early
    // returns) would be re-selected; stop the moment we see the same proposal twice.
    if (tried.has(String(body.proposal))) return res;
    tried.add(String(body.proposal));
    // Retryable per-proposal failure: it was archived to .applied/ — loop to the NEXT proposal.
  }
  return last as ResolverResult;
}
