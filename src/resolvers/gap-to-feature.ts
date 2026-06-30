import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose, priorAttemptFeedbackBlock } from "./feature-compose.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES } from "./substrate-gap.js";
import { resolveAuthorProducer } from "./author-producer.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";

// Mirror feature-compose's path model: repos/<vessel>/... maps to the writable
// runtime ${RUNTIME_ROOT}/<vessel>/..., and the drafter writes proposal reports
// to <workspace>/proposals/<gapId>-report.json.
const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
const PROPOSALS_DIR = process.env.PROPOSALS_DIR ?? "/workspace/proposals";

/** A repos/<vessel>/... path maps to an EXISTING file under the runtime root. */
function repoPathExists(repoRelative: string): boolean {
  try {
    return existsSync(join(RUNTIME_ROOT, repoRelative.replace(/^repos\//, "")));
  } catch {
    return false;
  }
}

/**
 * The unserved-quadrant fix (2026-06-23): a gap's drafter often writes a
 * patch_proposal naming the EXISTING file(s) that should change
 * (required_code_modifications[].file). Without surfacing those into the spec,
 * the composer's LLM freelances a NEW vessel (create_file ops) that has no
 * cutover clone and PHANTOM-lands. Reading the proposal and naming the concrete
 * existing targets in the spec steers the composer to `edit` ops on existing
 * source — which actually land. Only EXISTING files are returned; a proposal
 * naming a genuinely-new path is left for the composer to scaffold legitimately.
 */
function existingEditTargets(gapId: string): Array<{ file: string; description: string }> {
  try {
    const path = join(PROPOSALS_DIR, `${gapId}-report.json`);
    if (!existsSync(path)) return [];
    let raw = readFileSync(path, "utf8").trim();
    // Tolerant parse: drafters wrap JSON in ```json fences (sometimes multiple
    // concatenated objects — take the first balanced object).
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const end = raw.indexOf("}\n{");
    const firstObj = end > 0 ? raw.slice(0, end + 1) : raw;
    const parsed = JSON.parse(firstObj) as { required_code_modifications?: Array<{ file?: unknown; description?: unknown }> };
    const mods = Array.isArray(parsed.required_code_modifications) ? parsed.required_code_modifications : [];
    const out: Array<{ file: string; description: string }> = [];
    for (const m of mods) {
      const file = typeof m.file === "string" ? m.file : "";
      if (!file || !/^repos\/[^/]+\//.test(file)) continue;
      if (!repoPathExists(file)) continue; // only steer toward files that actually exist
      out.push({ file, description: typeof m.description === "string" ? m.description : "" });
    }
    return out;
  } catch {
    return [];
  }
}

// ───────────────────────────── LOCALIZATION (2026-06-28, intermediate task #5) ─────────────────────────────
// THE UNCLOG STEP. feature_compose LANDS FAVORABLE when handed a gap with a CONCRETE
// edit-site (a named existing file); it free-drafts un-verifiable code otherwise. But
// almost no gaps have a `/workspace/proposals/<id>-report.json` (existingEditTargets is
// usually empty), so the composer free-drafts and the autonomous loop never lands a real
// fix. localizeGap DERIVES a concrete edit-site from the gap's own text/metadata when no
// proposal file exists:
//   (a) identify the target vessel (gap.id like "responsibility-goal-host-vessel-…",
//       "performance-inefficiency-…", or metadata.vessel),
//   (b) SURFACE an edit-site already named in metadata (edit_site / file_path /
//       change_site / suspected_real_location) when the file actually exists — cheap, no
//       search; this is the high-confidence path,
//   (c) otherwise EXTRACT distinctive search terms (symbols, quoted strings, shape names)
//       from summary+metadata and grep the vessel's src/ for the best-matching file,
//   (d) return repos/<vessel>/<path> ONLY when a single confident file emerges (else NONE
//       — never fabricate; the composer free-drafts as before, behaviour unchanged).
// Optional: one llm-resolver call ranks among grep hits when several tie. Bounded
// (capped file walk, capped grep, timeouts, graceful on unreachable LLM). SAFE/ADDITIVE:
// only augments the empty-edit-target case.

const LOCALIZE_MAX_FILES = 1200;      // cap the src/ walk per vessel
const LOCALIZE_MAX_HITS = 12;         // cap candidate files scored
const LOCALIZE_LLM_TIMEOUT_MS = 12_000;

/** Resolve the vessel directory under the runtime root, returning the repos/<vessel> rel path. */
function vesselDirExists(vessel: string): boolean {
  try {
    return statSync(join(RUNTIME_ROOT, vessel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identify the target vessel for a gap. Order: explicit metadata.vessel, then an
 * edit-site/file_path's repos/<vessel>/ or /vessels/<vessel>/ prefix, then a vessel name
 * embedded in the gap id ("responsibility-<vessel>-…", "<…>-<vessel>-…"). Returns a
 * vessel dir name that EXISTS under the runtime root, else null.
 */
function identifyVessel(gap: Record<string, unknown>, meta: Record<string, unknown>): string | null {
  // 1. explicit metadata.vessel
  const mv = typeof meta.vessel === "string" ? meta.vessel.trim() : "";
  if (mv && vesselDirExists(mv)) return mv;
  // 2. a path field already names the vessel
  for (const f of ["edit_site", "file_path", "change_site", "path"]) {
    const v = meta[f];
    if (typeof v === "string") {
      const m = v.match(/(?:^|\/)(?:repos|vessels)\/([^/]+)\//);
      if (m && m[1] && vesselDirExists(m[1])) return m[1];
    }
  }
  // 3. vessel name embedded in the gap id. Match the LONGEST existing vessel dir whose
  //    name appears as a hyphen-bounded token run in the id (so "goal-host-vessel" wins
  //    over "vessel"). Only consider dirs that look like vessels (end with "-vessel" or
  //    "-api", or are a known top-level vessel) to avoid spurious single-word matches.
  const id = String(gap.id ?? "");
  let best: string | null = null;
  try {
    const dirs = readdirSync(RUNTIME_ROOT).filter((d) => {
      try { return statSync(join(RUNTIME_ROOT, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      if (!/-(vessel|api)$/.test(d) && !/^(activity-api|goal-host-vessel)$/.test(d)) continue;
      // hyphen-bounded: "-<dir>-" or "-<dir>" at end, or "<dir>-" at start
      if (new RegExp(`(?:^|-)${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-|$)`).test(id)) {
        if (!best || d.length > best.length) best = d;
      }
    }
  } catch { /* readdir best-effort */ }
  return best;
}

/** Extract distinctive search terms from a gap's summary + metadata. */
function localizeTerms(summary: string, meta: Record<string, unknown>): string[] {
  const terms = new Set<string>();
  // Quoted strings in the summary (the detectors quote symbol/endpoint/shape names).
  for (const m of summary.matchAll(/["'`]([^"'`]{3,60})["'`]/g)) {
    const t = (m[1] ?? "").trim();
    if (t) terms.add(t);
  }
  // High-signal metadata fields naming a symbol/shape/endpoint/pattern.
  for (const f of ["shape", "live_resolver", "probe", "matched_pattern", "matched_excerpt", "principle_name", "check", "detector"]) {
    const v = meta[f];
    if (typeof v === "string" && v.trim()) {
      // matched_excerpt/pattern can be a multi-token snippet — pull identifier-ish runs.
      for (const w of v.matchAll(/[A-Za-z_$][\w$]{4,}/g)) terms.add(w[0]!);
    }
  }
  // CamelCase / snake_case identifiers in the summary (≥5 chars, contains an upper or _).
  for (const w of summary.matchAll(/\b[A-Za-z_$][\w$]{4,}\b/g)) {
    const t = w[0]!;
    if (/[A-Z_]/.test(t) && !/^(should|which|every|never|always|cannot|substrate|activity|resolver|detector|capability|registered)$/i.test(t)) {
      terms.add(t);
    }
  }
  // Rank: prefer longer + symbol-shaped terms; cap.
  return [...terms]
    .filter((t) => t.length >= 4 && /[A-Za-z_]/.test(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
}

/** Recursively list .ts/.tsx files under a dir, bounded. */
function walkSrcFiles(absDir: string, cap: number): string[] {
  const out: string[] = [];
  const stack = [absDir];
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push(p);
    }
  }
  return out;
}

/** Score a vessel's src files by how many distinctive terms each contains; return top hits. */
function grepScoreFiles(srcAbs: string, vessel: string, terms: string[]): Array<{ file: string; score: number; matched: string[] }> {
  if (!terms.length) return [];
  const files = walkSrcFiles(srcAbs, LOCALIZE_MAX_FILES);
  const scored: Array<{ file: string; score: number; matched: string[] }> = [];
  for (const abs of files) {
    let content: string;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    const matched: string[] = [];
    let score = 0;
    for (const t of terms) {
      // word-ish containment; exact-symbol matches weigh more than substring.
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(content)) { score += 2; matched.push(t); }
      else if (content.includes(t)) { score += 1; matched.push(t); }
    }
    if (score > 0) {
      const rel = `repos/${vessel}/${abs.slice(abs.indexOf(`/${vessel}/`) + vessel.length + 2)}`;
      scored.push({ file: rel, score, matched });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, LOCALIZE_MAX_HITS);
}

async function rankWithLlm(summary: string, hits: Array<{ file: string; score: number; matched: string[] }>): Promise<string | null> {
  if (hits.length < 2) return null;
  try {
    // Discover the llm endpoint via the same contract feature-compose uses.
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
    const list = hits.map((h, i) => `${i}. ${h.file} (term-matches: ${h.matched.join(", ")})`).join("\n");
    const prompt = `A substrate gap needs the SINGLE existing source file most likely to be the change site.\n\nGAP: ${summary}\n\nCandidate files (already grep-matched on distinctive terms from the gap):\n${list}\n\nReturn ONLY the integer index of the single best file (the one whose responsibility the gap describes). If none is clearly the change site, return -1. Respond with JUST the number.`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "anthropic/claude-haiku-4-5", max_tokens: 16 }),
      signal: AbortSignal.timeout(LOCALIZE_LLM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    const txt = String(j.content ?? j.data ?? "").trim();
    const m = txt.match(/-?\d+/);
    if (!m) return null;
    const idx = parseInt(m[0], 10);
    if (idx < 0 || idx >= hits.length) return null;
    return hits[idx]!.file;
  } catch {
    return null;
  }
}

export interface LocalizeResult {
  file: string;
  description: string;
  vessel: string;
  method: "metadata_edit_site" | "grep_unique" | "grep_dominant" | "llm_ranked";
  candidates?: number;
}

/**
 * Derive a CONCRETE existing edit-site for a gap that has no proposal-report edit target.
 * Returns null when no confident single file emerges (NEVER fabricates). Bounded + graceful.
 */
export async function localizeGap(gap: Record<string, unknown>, opts?: { useLlm?: boolean }): Promise<LocalizeResult | null> {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const summary = String(gap.summary ?? gap.title ?? "");

  // (b) HIGH-CONFIDENCE: an edit-site already named in metadata that maps to a real file.
  for (const f of ["edit_site", "suspected_real_location", "change_site", "file_path"] as const) {
    let v = meta[f];
    if (typeof v !== "string" || !v.trim()) continue;
    let cand = v.trim();
    // Normalise /vessels/<v>/… and bare <v>/… into repos/<v>/…
    cand = cand.replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
    if (!/^repos\//.test(cand) && /^[^/]+\/(src|tests?)\//.test(cand)) cand = `repos/${cand}`;
    // strip a trailing :symbol / :line suffix
    cand = cand.replace(/:[A-Za-z0-9_$]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(cand) && repoPathExists(cand)) {
      const vesselDir = cand.match(/^repos\/([^/]+)\//)?.[1] ?? "";
      return { file: cand, description: `change site named by detector evidence (${f})`, vessel: vesselDir, method: "metadata_edit_site" };
    }
  }

  // (a) identify the target vessel.
  const vessel = identifyVessel(gap, meta);
  if (!vessel) return null;
  const srcAbs = join(RUNTIME_ROOT, vessel, "src");
  if (!existsSync(srcAbs)) return null;

  // (c) extract terms + grep the vessel src/ for the best-matching file.
  const terms = localizeTerms(summary, meta);
  if (!terms.length) return null;
  const hits = grepScoreFiles(srcAbs, vessel, terms);
  if (!hits.length) return null;

  // Confidence: a single hit, or a clearly dominant hit (top score ≥ 2× runner-up AND
  // matched ≥2 terms). Otherwise optionally ask the LLM to pick among the close hits.
  const top = hits[0]!;
  if (hits.length === 1 && top.matched.length >= 1) {
    return { file: top.file, description: `derived via code-search (sole match on: ${top.matched.join(", ")})`, vessel, method: "grep_unique", candidates: 1 };
  }
  const runner = hits[1]!;
  if (top.score >= 2 * runner.score && top.matched.length >= 2) {
    return { file: top.file, description: `derived via code-search (dominant match on: ${top.matched.join(", ")})`, vessel, method: "grep_dominant", candidates: hits.length };
  }
  if (opts?.useLlm !== false) {
    const picked = await rankWithLlm(summary, hits);
    if (picked) {
      const h = hits.find((x) => x.file === picked)!;
      return { file: picked, description: `derived via code-search + LLM rank (matched: ${h.matched.join(", ")})`, vessel, method: "llm_ranked", candidates: hits.length };
    }
  }
  // Low confidence (several comparable hits, LLM declined/unavailable) → no fabrication.
  return null;
}

// ───────────────────────── DUAL-SIDE LOCALIZATION (2026-06-29, Stage B part 1) ─────────────────────────
// A responsibility_misallocation gap is frequently a MOVE: "vessel X does work that
// belongs behind a Y endpoint on vessel Z." The single-side localizer above pins only
// the SOURCE vessel (where the pattern matched), so feature_compose grounds + typechecks
// only the source and authors only the DELETION half (calling a destination endpoint that
// doesn't exist yet → UNFAVORABLE). dual-side localization parses the DESTINATION vessel
// (and, when present, the receiving endpoint/capability name) out of the gap text so BOTH
// vessels are grounded and BOTH halves get authored. STRICTLY ADDITIVE: only fires for
// move-type gaps with a destination DIFFERENT from the source; surgical/same-vessel gaps
// are untouched (returns null → unchanged single-side path).

export interface MoveTarget {
  /** Destination vessel dir name (exists under the runtime root), e.g. "activity-api". */
  vessel: string;
  /** repos/<vessel> path for verify_vessels grounding. */
  repoPath: string;
  /** Named receiving capability/endpoint when the gap states one, e.g. "select-activity-for-goal". */
  endpoint: string | null;
}

/** All vessel-shaped dir names under the runtime root (cached per call site is fine — cheap). */
function listVesselDirs(): string[] {
  try {
    return readdirSync(RUNTIME_ROOT).filter((d) => {
      try {
        if (!statSync(join(RUNTIME_ROOT, d)).isDirectory()) return false;
      } catch { return false; }
      return /-(vessel|api)$/.test(d) || /^(activity-api|goal-host-vessel)$/.test(d);
    });
  } catch {
    return [];
  }
}

/**
 * For a move-type gap, infer the DESTINATION vessel + (optional) receiving endpoint from
 * the summary/metadata. Returns null when no destination DIFFERENT from `sourceVessel`
 * can be confidently named (→ caller keeps single-side behaviour). Pure text parse; no IO
 * beyond a cheap dir-listing.
 */
function inferMoveTarget(
  gap: Record<string, unknown>,
  meta: Record<string, unknown>,
  sourceVessel: string | null,
): MoveTarget | null {
  // Only responsibility_misallocation is a move candidate. (Other categories may move
  // logic too, but we gate conservatively on the one category the detector emits for it.)
  if (String(gap.category ?? "") !== "responsibility_misallocation") return null;

  const summary = String(gap.summary ?? gap.title ?? "");
  // An explicit destination field wins if the detector ever sets one.
  for (const f of ["destination_vessel", "target_vessel", "move_to"]) {
    const v = meta[f];
    if (typeof v === "string" && v.trim() && vesselDirExists(v.trim()) && v.trim() !== sourceVessel) {
      return { vessel: v.trim(), repoPath: `repos/${v.trim()}`, endpoint: inferEndpointName(summary) };
    }
  }

  // Otherwise parse a destination vessel name out of the summary. Prefer one that appears
  // in a MOVE phrase ("on <v>", "to <v>", "into <v>", "behind … <v>", "live in <v>"),
  // and is a real vessel dir DIFFERENT from the source. The detector phrasing for the
  // canonical case is: "…should live behind a select-activity-for-goal endpoint on activity-api."
  const dirs = listVesselDirs().filter((d) => d !== sourceVessel);
  if (!dirs.length) return null;

  // Score each candidate dir by whether it appears as a hyphen/space-bounded token in the
  // summary, boosted when preceded by a move-preposition. Longest match wins ties.
  let best: { vessel: string; score: number } | null = null;
  for (const d of dirs) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // token-bounded occurrence anywhere in the summary
    if (!new RegExp(`(?:^|[^A-Za-z0-9-])${esc}(?:$|[^A-Za-z0-9-])`).test(summary)) continue;
    let score = d.length; // prefer the most-specific dir name
    // move-preposition immediately before the vessel name = strong move signal
    if (new RegExp(`\\b(?:on|to|into|in|onto|behind[^.]*?\\bon)\\s+${esc}\\b`, "i").test(summary)) score += 100;
    if (!best || score > best.score) best = { vessel: d, score };
  }
  if (!best) return null;
  return { vessel: best.vessel, repoPath: `repos/${best.vessel}`, endpoint: inferEndpointName(summary) };
}

/** Pull a receiving endpoint/capability name when the summary states one (e.g. "select-activity-for-goal endpoint"). */
function inferEndpointName(summary: string): string | null {
  // "a <kebab-name> endpoint" / "<kebab-name> endpoint" / "a /<route> endpoint"
  const m =
    summary.match(/\b([a-z][a-z0-9-]{3,}(?:-[a-z0-9]+)+)\s+endpoint\b/i) ??
    summary.match(/\bendpoint\s+(?:called|named)\s+["'`]?([a-z][a-z0-9/_-]{3,})["'`]?/i) ??
    summary.match(/\b(\/[a-z0-9/_-]{3,})\s+endpoint\b/i);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * gap_to_feature (2026-06-21) — closes the autonomy loop: routes maintenance-
 * detector gaps THROUGH the feature composer.
 *
 * detect (detectors emit substrateGap) -> SPEC (this bridge) -> author
 * (feature_compose) -> verify (typecheck) -> stage. This is the piece that lets
 * the substrate maintain/upkeep what it writes: a gap a detector raises (incl.
 * the new db_contention gap, and the model-opportunity gaps that the surgical
 * gate used to REFUSE as non_surgical) now becomes an authored, verified change.
 *
 * SAFETY: FAVORABLE results are STAGED (left in the /vessels runtime), NOT
 * auto-pushed — landing flows through the existing cutover gate / operator.
 * UNFAVORABLE rolls back (feature_compose does this). So the loop is autonomous
 * up to a verified staged change; deploying AI-authored code stays gated.
 */
export interface GapToFeaturePointer {
  type: "gap_to_feature";
  /** Specific gap id to address; if absent, pick the first open gap (optionally filtered). */
  gap_id?: string;
  /** Filter open gaps by category when picking (e.g. "db_contention", "model-opportunity"). */
  category?: string;
  model?: string;
  /** Plan only (do not apply). */
  dry_run?: boolean;
  /** How many open gaps to consider when auto-picking. */
  limit?: number;
}

function specFromGap(
  gap: Record<string, unknown>,
  editTargets: Array<{ file: string; description: string }> = [],
  move?: { source: string | null; sourceFile: string | null; target: MoveTarget } | null,
): string {
  const summary = String(gap.summary ?? gap.title ?? "");
  const meta = (gap.classification_metadata ?? gap.metadata ?? null) as Record<string, unknown> | null;
  const metaStr = meta ? `\n\nDetector evidence:\n${JSON.stringify(meta, null, 2)}` : "";
  // PRIOR-ATTEMPT FEEDBACK: if the semantic gate already rejected a draft for this gap,
  // surface its findings as explicit, framed re-draft guidance (not just buried in the
  // detector-evidence JSON dump) so the next draft completes the partial fix. Additive.
  const priorFeedback = priorAttemptFeedbackBlock(meta);
  // When a prior analysis named concrete EXISTING files as the change site, make
  // them the mandated edit targets — this is what keeps the composer producing
  // `edit` ops that land instead of scaffolding a new vessel that phantom-lands.
  const targetStr = editTargets.length
    ? [
        "",
        "REQUIRED: this gap has a known change site in EXISTING source. EDIT these files IN PLACE.",
        "Do NOT create a new vessel, package.json, or any new file — emit `edit` ops on these exact paths only:",
        ...editTargets.map((t) => `  - ${t.file}${t.description ? ` — ${t.description}` : ""}`),
      ].join("\n")
    : "";

  // MOVE-AWARE BRANCH (2026-06-29): for a responsibility-MOVE gap, the right fix is NOT
  // the smallest surgical edit — it is a two-sided change: CREATE the receiving capability
  // in the destination vessel AND replace the inline logic in the source vessel with a
  // call to it. The "smallest surgical edit" framing biases AGAINST authoring both halves
  // (the planner deletes the source logic and calls a destination endpoint that doesn't
  // exist). This branch replaces that framing for move-type gaps only; surgical gaps fall
  // through to the unchanged instruction below (byte-identical).
  if (move) {
    const epName = move.target.endpoint ? ` named "${move.target.endpoint}"` : "";
    const srcLabel = move.sourceFile ?? (move.source ? `repos/${move.source}/src/` : "the source vessel");
    return [
      "This substrate gap is a RESPONSIBILITY MOVE between vessels — author BOTH halves of the move (this is NOT a single surgical edit):",
      `  HALF 1 (DESTINATION — ${move.target.repoPath}): CREATE the receiving capability${epName} in this vessel. Add it idiomatically — a resolver + its dispatch case + its discovery shape if the vessel exposes capabilities as impulse shapes, or a new HTTP route/handler if it exposes them as routes. Match how this vessel's existing capabilities are structured (read the grounded current contents to mirror its resolver/route pattern and return shape).`,
      `  HALF 2 (SOURCE — ${srcLabel}): REPLACE the inline logic that the detector flagged with a CALL to the new destination capability (e.g. a fetch to the new endpoint / a dispatch of the new impulse shape). Remove the misallocated inline implementation from the source; keep the source's behaviour intact by delegating to the destination.`,
      "Emit ops for BOTH vessels: at least one `create_file` or `edit` in the DESTINATION vessel AND at least one `edit` in the SOURCE vessel. Order destination ops before the source edit that references them.",
      "Both vessels MUST typecheck. Name real files under repos/<vessel>/src/ (the grounded file trees below show the real paths).",
      priorFeedback,
      "",
      `GAP: ${summary}`,
      metaStr,
    ].join("\n");
  }

  return [
    "Address the following substrate gap with the SMALLEST concrete, verifiable code change that resolves it.",
    "Prefer a minimal surgical edit to EXISTING vessel source. Only author a new file/vessel if the gap genuinely requires a capability no existing resolver provides, and then make it complete and dependency-free (Bun built-ins only).",
    "The change MUST typecheck. Name real files under repos/<vessel>/src/.",
    targetStr,
    priorFeedback,
    "",
    `GAP: ${summary}`,
    metaStr,
  ].join("\n");
}

// LANDABILITY-RANKED SELECTION (2026-06-28). gap_to_feature historically picked gaps[0]
// (arbitrary order), so the autonomous loop kept selecting hard META/ARCHITECTURAL gaps
// (stale-proposal-backlog, decision-without-action, performance-inefficiency) that
// feature_compose cannot author a verifying surgical diff for -> UNFAVORABLE, 0 lands.
// Rank open gaps by a landability prior — prefer a CONCRETE edit-site + surgically-
// authorable categories, deprioritise meta/architectural — so the loop spends its
// authoring budget on gaps it can actually LAND + push. This RAISES the autonomous land
// rate (the residual after the autonomous-commit-on-dev demonstration).
const HARD_CATEGORIES = new Set([
  "architectural_pattern", "performance_inefficiency", "decision_without_action",
  "responsibility_misallocation", "learning_signal_degeneracy", "resolver_distribution",
]);
const SURGICAL_CATEGORIES = new Set([
  "missing_capability", "systematic_failure", "reference_integrity", "service_failure",
  "forward_model_artifact",
]);
// Decision-log categories are LOGS, not work — hard-zero so even if one leaks
// into the candidate window (belt-and-suspenders to the read-side exclusion) the
// picker can never select it over a real gap.
const NONACTIONABLE_LOG_CATEGORIES = new Set<string>(DECISION_LOG_GAP_CATEGORIES);
function landabilityScore(gap: Record<string, unknown>): number {
  const cat0 = String(gap.category ?? "");
  if (NONACTIONABLE_LOG_CATEGORIES.has(cat0)) return 0;
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let s = 0.5;
  // A concrete change-site means feature_compose knows exactly where to edit (surgical).
  if (meta.edit_site || meta.suspected_real_location || meta.change_site || meta.failing_capability || meta.file_path) s += 0.3;
  if (typeof meta.edit_site === "string" || meta.single_file === true) s += 0.1;
  const cat = String(gap.category ?? "");
  if (HARD_CATEGORIES.has(cat)) s -= 0.4;
  if (SURGICAL_CATEGORIES.has(cat)) s += 0.15;
  // ids that empirically cycle UNFAVORABLE (meta/diagnostic; no surgical diff exists).
  if (/stale-proposal|demand-trace|forward[_-]chain|backlog|unknown/i.test(String(gap.id ?? ""))) s -= 0.3;
  // Deprioritise gaps that keep failing to land: each prior UNFAVORABLE attempt drops
  // the score, so the loop stops re-picking a stuck high-rank gap and moves to landable
  // work. Capped so a transient fail doesn't permanently bury a genuine gap.
  const fa = Number((meta as Record<string, unknown>).failed_attempts ?? 0);
  if (fa > 0) s -= Math.min(0.6, 0.2 * fa);
  return Math.max(0, Math.min(1, s));
}
function pickMostLandable(gaps: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!gaps.length) return null;
  // Learned category-level self-knowledge (expectation-setting step 3, 2026-06-29): strongly
  // deprioritise gaps in a category the substrate has EMPIRICALLY learned it cannot land
  // (>=8 attempts, 0 lands) — stop wasting cycles on a class it can't author, while leaving a
  // re-test path (penalty, not hard exclusion) if nothing better exists.
  const calib = readCalibration();
  const hopeless = (g: Record<string, unknown>): boolean => {
    const r = calib[String(g.category ?? "unknown")];
    return !!r && r.attempts >= 8 && r.lands === 0;
  };
  return gaps.map((g) => ({ g, s: landabilityScore(g) - (hopeless(g) ? 0.5 : 0) })).sort((a, b) => b.s - a.s)[0]!.g;
}

// CLOSE-ON-LAND (2026-06-29). A landed gap previously stayed status:open, so the
// landability-ranked picker could re-select the SAME (now-fixed) gap each tick — its
// staged fix re-applies as a no-op / fails to anchor (the change is already in source),
// wasting cycles and starving the OTHER open gaps. The fix: when a gap's fix GENUINELY
// LANDS on origin/dev, mark it status:"closed" so the open-filtered picker advances
// through the backlog. Genuine land is a HIGH bar — closing too eagerly would lose a
// real gap. We require ALL of:
//   - verdict === "FAVORABLE" (typecheck-clean, semantic-gate-passed), AND
//   - land was requested (pointer.land, i.e. NOT dry_run), AND
//   - at least one cutover whose result is a cutoverApplied shape with
//     push_status === "pushed" (a REAL push to origin/dev with a new commit sha).
// A merely-staged FAVORABLE (no push clone), a soft-refuse (applied:false), a
// local_only / host_sync_pending / skipped push (incl. skip_push test mode), or an
// UNFAVORABLE result is NOT a genuine land → the gap stays open. dry_run never closes.
interface LandSignal {
  landed: boolean;
  commit_sha: string | null;
  vessel: string | null;
  push_status: string | null;
}
function genuineLandSignal(composeBody: Record<string, unknown>, landRequested: boolean): LandSignal {
  const none: LandSignal = { landed: false, commit_sha: null, vessel: null, push_status: null };
  if (!landRequested) return none;
  if (composeBody?.verdict !== "FAVORABLE") return none;
  const cutovers = Array.isArray(composeBody.cutovers) ? composeBody.cutovers : [];
  for (const c of cutovers) {
    const co = (c ?? {}) as Record<string, unknown>;
    const result = (co.result ?? {}) as Record<string, unknown>;
    // A successful cutover returns the cutoverApplied body (push_status + new_git_sha).
    // The soft-refuse / no-op paths also carry shape:"cutoverApplied" but with
    // applied:false and push_status not "pushed" — so gate strictly on "pushed".
    if (result.push_status === "pushed") {
      const sha = typeof result.new_git_sha === "string" && result.new_git_sha.trim() ? result.new_git_sha.trim() : null;
      return {
        landed: true,
        commit_sha: sha,
        vessel: typeof co.vessel === "string" ? co.vessel : (typeof result.vessel_name === "string" ? result.vessel_name : null),
        push_status: "pushed",
      };
    }
  }
  return none;
}

/** Mark a gap closed once its fix genuinely landed on origin/dev. Best-effort, guarded. */
async function closeLandedGap(gap: Record<string, unknown>, land: LandSignal): Promise<{ closed: boolean; error?: string }> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return { closed: false, error: "gap missing id" };
    const resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    const meta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution, closed_at: new Date().toISOString() };
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "closed",
      },
    } as never);
    updateCalibration(String(gap.category ?? "unknown"), true);
    return { closed: true };
  } catch (e) {
    return { closed: false, error: (e as Error).message };
  }
}

// Increment a gap's failed_attempts counter when an authoring attempt does NOT land
// (UNFAVORABLE / staged-not-pushed). Feeds landabilityScore so a stuck gap drops in
// priority and the loop stops churning on it instead of reaching landable work. Best-effort.
// EXPECTATION-SETTING (closure primitive, 2026-06-29): commit an explicit prediction of
// whether a gap will LAND, from its features (the landability prior IS the self-model's point
// estimate). The prediction is measured against the actual outcome (surprise = prediction
// error) so the substrate accrues a CALIBRATED self-model instead of acting blind. The
// counterfactual baseline is the 0.5 no-signal prior; p above/below it is the discriminating
// expectation.
// Learned per-category COUNTERFACTUAL baselines (expectation-setting step 2, 2026-06-29):
// persist the empirical {attempts,lands} per gap category in the workspace volume so
// predictLand's baseline is the real land-rate for "a gap like this", not a static 0.5 prior.
// The gap-specific signal (landabilityScore p) is judged AGAINST that learned counterfactual.
const CALIB_PATH = process.env.EXPECTATION_CALIB_PATH ?? "/workspace/expectation-calibration.json";
type CalibRec = Record<string, { attempts: number; lands: number }>;
function readCalibration(): CalibRec {
  try { return existsSync(CALIB_PATH) ? (JSON.parse(readFileSync(CALIB_PATH, "utf8")) as CalibRec) : {}; }
  catch { return {}; }
}
function updateCalibration(category: string, landed: boolean): void {
  try {
    const c = readCalibration();
    const cat = category || "unknown";
    const rec = c[cat] ?? { attempts: 0, lands: 0 };
    rec.attempts += 1; if (landed) rec.lands += 1;
    c[cat] = rec;
    writeFileSync(CALIB_PATH, JSON.stringify(c));
  } catch { /* best-effort */ }
}
function predictLand(gap: Record<string, unknown>): { predicted: boolean; p: number; baseline: number } {
  const p = landabilityScore(gap);
  // Counterfactual baseline = empirical land-rate for this gap's category (>=5 samples),
  // else the 0.5 no-signal prior. Predict land only if the gap's signal beats its class.
  const c = readCalibration();
  const rec = c[String(gap.category ?? "unknown")];
  const baseline = rec && rec.attempts >= 5 ? rec.lands / rec.attempts : 0.5;
  return { predicted: p >= Math.max(0.4, baseline), p, baseline };
}

async function bumpFailedAttempts(gap: Record<string, unknown>, opts: { surprise?: boolean; predictedP?: number } = {}): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // A non-landing attempt the substrate PREDICTED would land is a high-information SURPRISE
    // (over-optimistic self-model) → deprioritise harder (x2) and tally the calibration miss so
    // the self-model is measurable. A correctly-predicted fail bumps normally.
    updateCalibration(String(gap.category ?? "unknown"), false);
    const weight = opts.surprise ? 2 : 1;
    const fa = Number(meta0.failed_attempts ?? 0) + weight;
    const mis = Number(meta0.mispredicted_lands ?? 0) + (opts.surprise ? 1 : 0);
    const meta = { ...meta0, failed_attempts: fa, last_failed_at: new Date().toISOString(), mispredicted_lands: mis, last_predicted_p: opts.predictedP ?? meta0.last_predicted_p };
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "open",
      },
    } as never);
  } catch { /* best-effort */ }
}

export async function resolveGapToFeature(pointer: GapToFeaturePointer): Promise<ResolverResult> {
  // 1. Select a gap — landability-ranked when auto-picking (not arbitrary gaps[0]).
  let gap: Record<string, unknown> | null = null;
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      ...(pointer.category ? { category: pointer.category } : {}),
      status: "open",
      // Exclude goal-host auto_draft_* decision-log noise BEFORE the limit slice
      // so the actionable window is never starved by per-dispatch log entries.
      // (Log rows stay in the store; an explicit category query can still read them.)
      exclude_categories: pointer.category ? [] : [...DECISION_LOG_GAP_CATEGORIES],
      limit: pointer.limit ?? 25,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    gap = pointer.gap_id
      ? gaps.find((g) => g.id === pointer.gap_id) ?? null
      : pickMostLandable(gaps);
  } catch (e) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: (e as Error).message } };
  }
  if (!gap) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: "no matching open gap", category: pointer.category ?? null } };
  }

  // 1b. ORPHANED-CAPABILITY gaps close via author_producer, NOT feature_compose
  // (2026-06-25). The closure for "resolver X is live but invoked by 0 activities"
  // is a RUNNABLE activity that invokes X — minted by the author_producer bridge
  // path (lever 1: author→validate→mint a 2-task goal_file_extract→produce bridge
  // for a file-consuming resolver). feature_compose authors vessel TypeScript and
  // here free-drafts a create_file into a NON-EXISTENT vessel (e.g. repos/executive/)
  // that phantom-lands and never invokes the resolver. Route to the primitive that
  // actually produces a discoverable, Thompson-selectable producer.
  if (String(gap.category ?? "") === "orphaned_capability") {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const shape = String(meta.shape ?? "").trim();
    if (!shape) {
      return {
        shape: "gapToFeatureReport",
        body: { ok: false, stage: "route_orphan", gap_id: gap.id, gap_category: gap.category, error: "orphaned_capability gap missing classification_metadata.shape" },
      };
    }
    // The summary already states "Author an activity that invokes resolver X"; pass
    // it as goal context so author_producer's validate step can lift a real file
    // path from a file-shaped pointer field (buildTestPointer reads the goal).
    const goal = String(gap.summary ?? `author an activity that invokes resolver ${shape} and routes its output onward`);
    const author = pointer.dry_run
      ? null
      : await resolveAuthorProducer({ type: "author_producer", shape, goal });
    const ab = (author?.body ?? {}) as Record<string, unknown>;
    const minted = author?.shape === "author_producer";
    return {
      shape: "gapToFeatureReport",
      body: {
        ok: pointer.dry_run ? true : minted,
        gap_id: gap.id,
        gap_category: gap.category,
        gap_summary: gap.summary,
        route: "author_producer",
        orphan_shape: shape,
        verdict: pointer.dry_run ? "plan" : (minted ? "MINTED" : "MINT_FAILED"),
        minted_activity_id: minted ? ab.minted_activity_id : null,
        two_task_bridge: minted ? ab.two_task_bridge : null,
        author: ab,
        note: pointer.dry_run
          ? `plan: would mint a runnable bridge activity invoking resolver "${shape}" via author_producer`
          : (minted
            ? `MINTED runnable bridge "${ab.minted_activity_id}" invoking previously-orphaned resolver "${shape}" — capability now expressed and Thompson-selectable`
            : `author_producer could not mint a validated invocation of "${shape}" (see author.last_error); the resolver may need an input the bridge can't yet provision`),
      },
    };
  }

  // 2. Build a spec and route THROUGH the composer. If the gap's drafter
  // already named EXISTING change sites, inject them so the composer edits
  // existing source (lands) instead of scaffolding a new vessel (phantom).
  let editTargets = existingEditTargets(String(gap.id ?? ""));
  // LOCALIZATION (task #5): when no proposal-report edit target exists, DERIVE a
  // concrete edit-site from the gap's own text/metadata via code-search so the
  // composer edits existing source instead of free-drafting. Only a CONFIDENT single
  // file is returned; low-confidence → editTargets stays empty (composer free-drafts
  // as before — behaviour unchanged in that case).
  let localized: LocalizeResult | null = null;
  if (editTargets.length === 0) {
    try {
      localized = await localizeGap(gap, { useLlm: true });
    } catch { localized = null; }
    if (localized) {
      editTargets = [{ file: localized.file, description: localized.description }];
    }
  }

  // DUAL-SIDE LOCALIZATION (2026-06-29): a responsibility-MOVE gap names a DESTINATION
  // vessel to move logic TO. localizeGap above pins only the SOURCE; without grounding the
  // destination the composer authors only the deletion half (calling an endpoint that does
  // not exist yet → UNFAVORABLE). Infer the destination here and add it to editTargets so
  // it is ALSO grounded + typechecked, and pass a move context to specFromGap so the spec
  // mandates authoring BOTH halves. STRICTLY ADDITIVE: inferMoveTarget returns null for
  // surgical / same-vessel gaps → behaviour below is byte-identical to before.
  const gapMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const sourceVessel = identifyVessel(gap, gapMeta);
  const sourceFile = editTargets[0]?.file ?? localized?.file ?? null;
  const moveTarget = inferMoveTarget(gap, gapMeta, sourceVessel);
  let move: { source: string | null; sourceFile: string | null; target: MoveTarget } | null = null;
  if (moveTarget) {
    move = { source: sourceVessel, sourceFile, target: moveTarget };
    // Add the destination vessel as an edit target so it is grounded + typechecked. Point
    // at its capability dispatch surface (src/) — feature_compose's grounding reads the
    // whole tree, so a vessel-level hint is enough; the planner picks the concrete file.
    const destFile = `${moveTarget.repoPath}/src`;
    if (!editTargets.some((t) => t.file.startsWith(`${moveTarget.repoPath}/`))) {
      editTargets = [
        ...editTargets,
        { file: destFile, description: `MOVE DESTINATION — create the receiving capability${moveTarget.endpoint ? ` "${moveTarget.endpoint}"` : ""} here` },
      ];
    }
  }

  const spec = specFromGap(gap, editTargets, move);
  // Thread the localized/known vessel(s) into verify_vessels so the composer GROUNDS its
  // plan on the real file tree+contents of those vessels and typechecks them. For a move
  // gap this is BOTH the source AND the destination vessel.
  const verifyVessels = [...new Set(editTargets.map((t) => t.file.match(/^repos\/[^/]+/)?.[0]).filter((v): v is string => !!v))];
  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    ...(verifyVessels.length ? { verify_vessels: verifyVessels } : {}),
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    keep_on_fail: false,
    // Thread the gap through so the semantic cutover-verification gate (lever 5)
    // can judge the patch AGAINST the gap on a live path and write
    // suspected_real_location back onto the gap when the drafter mis-localized.
    gap: {
      id: String(gap.id ?? ""),
      summary: String(gap.summary ?? gap.title ?? ""),
      classification_metadata: (gap.classification_metadata ?? gap.metadata ?? undefined) as Record<string, unknown> | undefined,
      category: String(gap.category ?? ""),
    },
    // Autonomous LAND: on FAVORABLE, push through vessel-mitosis-cutover (its
    // evidence+freshness gates are the self-verification; self-recovery is the
    // backstop). Suppressed in dry_run.
    land: !(pointer.dry_run ?? false),
  });

  const cb = compose.body as Record<string, unknown>;

  // CLOSE-ON-LAND: only when the fix GENUINELY landed on origin/dev (FAVORABLE +
  // a real "pushed" cutover, never dry_run / staged-only / soft-refuse). A
  // merely-staged or UNFAVORABLE result leaves the gap open so it (or another open
  // gap) is retried — closing on a non-land would lose a real, unfixed gap.
  const land = genuineLandSignal(cb, !(pointer.dry_run ?? false));
  let closure: { closed: boolean; error?: string; resolution?: string } = { closed: false };
  if (land.landed) {
    closure = await closeLandedGap(gap, land);
    if (closure.closed) {
      closure.resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    }
  } else if (!(pointer.dry_run ?? false)) {
    // Did not land. EXPECTATION-SETTING: measure the prediction-vs-outcome SURPRISE. A gap the
    // self-model predicted would land but didn't is over-optimistic (high-information) → bump
    // harder; a correctly-predicted fail bumps normally. Feeds the calibrated self-model.
    const pred = predictLand(gap);
    await bumpFailedAttempts(gap, { surprise: pred.predicted, predictedP: pred.p });
  }

  return {
    shape: "gapToFeatureReport",
    body: {
      ok: cb?.ok ?? cb?.verdict === "FAVORABLE",
      gap_id: gap.id,
      gap_category: gap.category,
      gap_summary: gap.summary,
      edit_targets: editTargets.map((t) => t.file),
      localized: localized
        ? { file: localized.file, vessel: localized.vessel, method: localized.method, candidates: localized.candidates ?? null }
        : null,
      verify_vessels: verifyVessels,
      verdict: cb?.verdict ?? cb?.stage,
      compose: cb,
      // Surface the genuine-land + closure decision so the loop's progress is observable.
      landed: land.landed,
      landed_commit: land.commit_sha,
      gap_closed: closure.closed,
      gap_close_error: closure.error ?? null,
      note: land.landed
        ? (closure.closed
          ? `LANDED on origin/dev${land.commit_sha ? ` (${land.commit_sha})` : ""} and gap marked CLOSED — picker advances to the next open gap`
          : `LANDED on origin/dev but gap-close write failed (${closure.error}); gap stays open and will be retried`)
        : (cb?.verdict === "FAVORABLE"
          ? "FAVORABLE but NOT pushed (staged only / push gated) — gap stays OPEN; self-recovery is the backstop"
          : "composer could not produce a verified change for this gap (see compose.applied/verify) — gap stays OPEN"),
    },
  };
}
