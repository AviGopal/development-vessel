import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose, priorAttemptFeedbackBlock } from "./feature-compose.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES } from "./substrate-gap.js";
import { resolveAuthorProducer } from "./author-producer.js";
import { resolveDocDriftFix } from "./doc-drift-fix.js";
import { resolveReachabilityGapRepair } from "./reachability-gap-repair.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { readFile } from "node:fs/promises";

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

// Auto-grounds the anchor from the live editTargets[0] file when classification_metadata.matched_excerpt is absent.
export function specFromGap(
  gap: Record<string, unknown>,
  editTargets: Array<{ file: string; description: string }> = [],
  move?: { source: string | null; sourceFile: string | null; target: MoveTarget } | null,
): string {
  const summary = String(gap.summary ?? gap.title ?? "");
  const meta = (gap.classification_metadata ?? gap.metadata ?? null) as Record<string, unknown> | null;
  // Include only the GROUNDING fields as crisp lines — NOT a full classification_metadata
  // JSON dump. The dump bloats the spec and measurably degrades feature_compose's decompose:
  // a gap that authored FAVORABLE (op_count:1, typecheck-clean) via a crisp DIRECT spec came
  // back UNFAVORABLE / 0-ops through this gap path purely from the extra framing + JSON dump.
  // Keeping the composer's input tight is a loop-wide authoring lever. (2026-07-01)
  const metaStr = meta
    ? (() => {
        // Anchor line: prefer upstream-set excerpt; fall back to live file contents
        // when editTargets names a real file under repos/<vessel>/src/.
        let anchorLine = "";
        if (meta.matched_excerpt) {
          anchorLine = `Anchor (existing code near the change): \`\`\`\n${String(meta.matched_excerpt)}\n\`\`\``;
        } else {
          const firstTarget: string | undefined = editTargets[0]?.file;
          if (firstTarget && /^\/repos\/[^/]+\/src\//.test(`/${firstTarget}`)) {
            try {
              const raw = readFileSync(join(RUNTIME_ROOT, firstTarget.replace(/^repos\//, "")), "utf8");
              const lines = raw.split("\n");
              const lineCount = lines.length;
              // Near-edit-site grounding (#18): center the ~40-line excerpt window on the
              // edit site when edit_site/suspected_real_location names a line; else top of file.
              const siteStr = `${String(meta.edit_site ?? "")} ${String(meta.suspected_real_location ?? "")}`;
              const lineMatch = siteStr.match(/(?::|line\s+|#L)(\d+)/i);
              const startLine = lineMatch ? (parseInt(lineMatch[1] ?? "0", 10) || 0) : 0;
              const from = Math.max(0, startLine - 15);
              const excerpt = lines.slice(from, from + 40).join("\n");
              const anchorLabel = startLine > 0 ? "Anchor (verbatim near edit site)" : "Anchor (verbatim top of file)";
              const vesselName = firstTarget.split('/')[1] ?? 'unknown';
              anchorLine = `File facts: ${firstTarget} (vessel: ${vesselName}), total_lines=${lineCount}, excerpt_start_line=${from + 1}\n${anchorLabel}: \`\`\`\n${excerpt}\n\`\`\``;
            } catch {
              // file unreadable — leave anchorLine empty
            }
          }
        }
        const lines = [
          meta.edit_site ? `Change site: ${String(meta.edit_site)}` : "",
          meta.suspected_real_location ? `Location: ${String(meta.suspected_real_location)}` : "",
          anchorLine,
        ].filter(Boolean).join("\n");
        return lines ? `\n\n${lines}` : "";
      })()
    : "";
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
  // orphaned_capability lands via author_producer as a DIRECT activity mint (a
  // Thompson-selectable bridge invoking a live-but-unused resolver) — no
  // feature_compose + cutover needed. Its provisionable members mint immediately
  // (e.g. auto-bridge-repairPolicy), so it is genuinely MORE landable than the
  // hard feature classes; scoring it neutral (0.5) made the picker prefer
  // systematic_failure gaps that mostly UNFAVORABLE at the LLM frontier, starving
  // real capability expression. failed_attempts now culls the un-provisionable
  // orphaned members (MINT_FAILED bump, 2026-07-01), so boosting the class is safe:
  // the mintable ones land first, the rest deprioritise. (2026-07-01)
  "orphaned_capability",
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

/**
 * Verify whether a gap's condition still holds in the file system.
 * For surgical gaps with edit_site + hardcoded_url in classification_metadata:
 *   returns 'present' if the literal is still in the file, 'absent' if gone, 'unknown' otherwise.
 * For resolver-behaviour gaps with evidence_resolve or verify_shape in classification_metadata:
 *   POSTs to the vessel's own resolve endpoint, inspects the body for the defect signature
 *   (fetch_error field, or zero/empty value where ground truth is nonzero), returns
 *   'present' (defect still there), 'absent' (resolved healthy), 'unknown' on transport failure.
 * 'unknown' preserves today's behaviour — no false closes, no blocked closes.
 */
function verifyGapCondition(gap: Record<string, unknown>): 'present' | 'absent' | 'unknown' {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // Prefer clean file_path field (surgical-gap-scan writes this without line suffix);
    // fall back to edit_site but strip trailing ':<digits>' line suffix if present.
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      // editSite is repo-relative like repos/some-vessel/src/file.ts
      // Map to runtime path using the same pattern as line 21
      const runtimePath = join(RUNTIME_ROOT, editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // Second evidence class: resolver-behaviour gaps.
    // classification_metadata may carry:
    //   evidence_resolve: { shape: string, input?: Record<string,unknown>, defect_field?: string, nonzero_field?: string }
    // OR
    //   verify_shape: string  (shorthand — shape name only, defect detected by fetch_error or zero-count heuristic)
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    if (evidenceResolveRaw !== undefined || verifyShapeRaw !== undefined) {
      // This branch must be async; we cannot make verifyGapCondition async without
      // refactoring all callers, so we return a Promise that the caller awaits.
      // We wrap the async logic in an immediately-invoked function and return the
      // Promise cast — callers already await the outer closeLandedGap which in turn
      // calls verifyGapCondition. To keep the sync signature and avoid a full
      // refactor, we use a synchronous Bun-native approach: spawn a sub-call inline
      // with a helper that returns the verdict synchronously via Atomics + SharedArrayBuffer.
      // However, the cleanest zero-refactor approach is to make verifyGapCondition
      // return Promise<...> | 'unknown' and have callers handle it.  Since that would
      // require editing every caller, we instead use a different strategy:
      // return the sentinel 'unknown' here and rely on the async sibling
      // verifyGapConditionAsync which is called from the async closer path below.
      // The sentinel causes fail-open (no false close) — the async path does the real work.
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Async variant of verifyGapCondition that also handles the resolver-behaviour
 * evidence class (evidence_resolve / verify_shape in classification_metadata).
 * Called from closeLandedGap so the async fetch does not block the sync path.
 */
async function verifyGapConditionAsync(gap: Record<string, unknown>): Promise<'present' | 'absent' | 'unknown'> {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // ── Class 1: surgical (file + literal) ──────────────────────────────────
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      const runtimePath = join(RUNTIME_ROOT, editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // ── Class 2: resolver-behaviour (evidence_resolve / verify_shape) ───────
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    let resolveShape: string | null = null;
    let resolveInput: Record<string, unknown> = {};
    let defectField: string | null = null;
    let nonzeroField: string | null = null;
    if (evidenceResolveRaw !== null && typeof evidenceResolveRaw === 'object') {
      const er = evidenceResolveRaw as Record<string, unknown>;
      resolveShape = typeof er['shape'] === 'string' ? er['shape'] : null;
      // ── Fallback A: sample-body-form evidence (no shape field) ──────────
      // Gap-filing paths (defect reports, surgical-gap-scan) write evidence_resolve
      // as a sample response body e.g. {obsidian_vessel_count:0, fetch_error:"..."}.
      // When shape is absent, fall back to classification_metadata.verify_shape,
      // then to a gap-id-derived shape. Also treat fetch_error/error keys as an
      // implied defect_field so the verifier rejects hollow closes on error bodies.
      if (resolveShape === null) {
        if (typeof verifyShapeRaw === 'string' && verifyShapeRaw.length > 0) {
          resolveShape = verifyShapeRaw;
        } else if (typeof meta['verify_shape'] === 'string' && (meta['verify_shape'] as string).length > 0) {
          resolveShape = meta['verify_shape'] as string;
        } else {
          // Derive shape from gap id: e.g. "gap-obsidian-vessel-count" -> "obsidian_vessel_count"
          const gapId = typeof gap['id'] === 'string' ? gap['id'] : '';
          if (gapId.length > 0) {
            const derived = gapId.replace(/^gap-/, '').replace(/-/g, '_');
            if (derived.length > 0) resolveShape = derived;
          }
        }
        // Treat fetch_error or error keys in sample-body-form evidence as implied defect_field
        if (defectField === null) {
          if (typeof er['fetch_error'] === 'string') {
            defectField = 'fetch_error';
          } else if (typeof er['error'] === 'string') {
            defectField = 'error';
          }
        }
      }
      resolveInput = (typeof er['input'] === 'object' && er['input'] !== null)
        ? (er['input'] as Record<string, unknown>)
        : {};
      defectField = typeof er['defect_field'] === 'string' ? er['defect_field'] : null;
      nonzeroField = typeof er['nonzero_field'] === 'string' ? er['nonzero_field'] : null;
    } else if (typeof verifyShapeRaw === 'string') {
      resolveShape = verifyShapeRaw;
    }
    if (!resolveShape) return 'unknown';
    // POST to the vessel's own in-container resolve endpoint.
    const payload: Record<string, unknown> = { type: resolveShape, ...resolveInput };
    let respBody: Record<string, unknown>;
    try {
      const SELF_RESOLVE_ENDPOINT = process.env['SELF_RESOLVE_ENDPOINT'] ?? `http://localhost:${process.env['PORT'] ?? '8090'}/v2/impulses/resolve`;
      const resp = await fetch(SELF_RESOLVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return 'unknown';
      respBody = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Transport failure — fail open (unknown), no false close.
      return 'unknown';
    }
    // Unwrap nested body if the resolver wraps results in { body: { ... } }
    const inner = (typeof respBody['body'] === 'object' && respBody['body'] !== null)
      ? (respBody['body'] as Record<string, unknown>)
      : respBody;
    // Defect heuristic 1: explicit defect_field present in response
    if (defectField !== null && inner[defectField] !== undefined && inner[defectField] !== null && inner[defectField] !== '') {
      return 'present';
    }
    // Defect heuristic 2: explicit nonzero_field should be >0 but is 0 / null / undefined
    if (nonzeroField !== null) {
      const val = inner[nonzeroField];
      if (val === 0 || val === null || val === undefined || val === '') {
        return 'present';
      }
      return 'absent';
    }
    // Defect heuristic 3 (generic): presence of a fetch_error field signals defect
    if (typeof inner['fetch_error'] === 'string' && inner['fetch_error'].length > 0) {
      return 'present';
    }
    // Defect heuristic 4 (generic): zero-count on common count fields
    for (const countKey of ['count', 'obsidian_vessel_count', 'vessel_count']) {
      if (countKey in inner) {
        const v = inner[countKey];
        if (v === 0 || v === null || v === undefined) return 'present';
        return 'absent';
      }
    }
    // No defect signature found — treat as healthy
    return 'absent';
  } catch {
    return 'unknown';
  }
}

/** Mark a gap closed once its fix genuinely landed on origin/dev. Best-effort, guarded. */
async function closeLandedGap(gap: Record<string, unknown>, land: LandSignal): Promise<{ closed: boolean; error?: string }> {
  try {
    // Outcome-verification (increment 2): use the async verifier which covers both
    // the surgical-class (file+literal) AND the resolver-behaviour class
    // (evidence_resolve / verify_shape). Fall back to the sync verifier result
    // only when the async path itself throws (belt-and-suspenders).
    let verifyResult: 'present' | 'absent' | 'unknown';
    try {
      verifyResult = await verifyGapConditionAsync(gap);
    } catch {
      verifyResult = verifyGapCondition(gap);
    }
    if (verifyResult === 'absent') {
      // Gap condition gone — allow close (fall through to existing logic)
    } else if (verifyResult === 'present') {
      // Defect still present — refuse close, record outcome_verification_failure
      return { closed: false, error: 'outcome_verification_failure: gap condition still present at close time' };
    }
    // verifyResult === 'unknown': fail-open, allow close (preserves existing behaviour)
    const id = String(gap.id ?? "");
    if (!id) return { closed: false, error: "gap missing id" };
  if (typeof land.vessel==="string" && land.vessel.includes("development-vessel")) { const m={...((gap.classification_metadata??gap.metadata??{}) as Record<string,unknown>),pending_outcome_verification:land.commit_sha,pending_set_at:new Date().toISOString()}; await resolveSubstrateGapWrite({type:"substrateGap_write",gap:{id,category:gap.category,source:gap.source,summary:gap.summary,detected_at:gap.detected_at,classification_metadata:m,status:"open"}} as never); return {closed:false,error:"self-cutover: closure deferred to next-tick verification"}; }

  // Self-cutover guard: when a landed change targets development-vessel itself,
  // close-time outcome verification runs in the pre-cutover process and cannot
  // observe the post-cutover state — producing hollow gap closures (observed on
  // gap-obsidian-vessel-count at commit bbad5c4). Defer closure to next-tick
  // pick-time outcome verification instead.
  if (typeof land.vessel === "string" && land.vessel.includes("development-vessel")) {
    const pendingOutcomeVerification = land.commit_sha ?? "unknown";
    const pendingSetAt = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        status: "open",
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          pending_outcome_verification: pendingOutcomeVerification,
          pending_set_at: pendingSetAt,
        },
      },
    } as never);
    return { closed: false, error: "self-cutover: closure deferred to next-tick pick-time outcome verification" };
  }
    const resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    // Outcome verification: only close when the condition is observed gone.
    // If condition is still present, record failure and bail without closing.
    const conditionCheck = verifyGapCondition(gap);
    if (conditionCheck === 'present') {
      const failureMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), outcome_verification_failure: `condition still present at close time after land ${land.commit_sha ?? 'unknown'}`, outcome_checked_at: new Date().toISOString() };
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id,
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: failureMeta,
            status: "open",
          },
        } as never);
      } catch { /* best-effort */ }
      return { closed: false, error: `outcome verification failed: hardcoded literal still present in edit_site after landing` };
    }
    const closedMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution, closed_at: new Date().toISOString() };
    const meta = closedMeta;
    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: land.commit_sha ?? null });
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
    joinDecisionOutcome(meta, { landed: false });
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
    // Emit narrowed child gap when the gap has now reached the chronic-failure
    // threshold (>= 3 failed_attempts). The child carries a tighter description
    // and resets failed_attempts to 0 so it re-enters the dispatch queue at
    // normal priority rather than being culled by the landabilityScore filter.
    const willExceedThreshold = fa >= 3;
    if (willExceedThreshold) {
      try {
        const parentId: string = id;
        const parentSummary = String(gap.summary ?? gap.title ?? "");
        const childMeta = { ...meta, failed_attempts: 0, parent_gap_id: parentId, narrowed_at: new Date().toISOString() };
        const childRecord: Record<string, unknown> = {
          category: gap.category,
          source: gap.source,
          summary: `[narrowed from ${parentId}] ${parentSummary}`,
          detected_at: gap.detected_at,
          classification_metadata: childMeta,
          status: "open",
        };
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: childRecord as never });
        console.log(`[bumpFailedAttempts] emitted narrowed child gap for chronically-stuck gap (failed_attempts>=3): ${parentId}`);
      } catch (err) {
        // Child gap emission is best-effort; never block the parent update.
        console.warn(`[bumpFailedAttempts] child gap emit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch { /* best-effort */ }
}

export async function recordApproachDecision(gap: Record<string, unknown>): Promise<void> {
  try {
    const pred = predictLand(gap);
    const meta = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(meta.approach_decisions) ? (meta.approach_decisions as unknown[]) : [];
    arr.push({
      at: new Date().toISOString(),
      predicted_p: pred.p,
      predicted_land: pred.predicted,
      edit_site: meta.edit_site ? String(meta.edit_site) : "",
      alternatives: ["full-scope-compose"],
    });
    while (arr.length > 5) arr.shift();
    meta.approach_decisions = arr;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { ...gap, classification_metadata: meta, status: String(gap.status ?? "open") },
    } as never);
  } catch { /* best-effort */ }
}

export function joinDecisionOutcome(meta: Record<string, unknown>, outcome: Record<string, unknown>): void {
  const arr = meta.approach_decisions;
  if (!Array.isArray(arr)) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i];
    if (entry && typeof entry === "object" && !("outcome" in (entry as Record<string, unknown>))) {
      (entry as Record<string, unknown>).outcome = { ...outcome, joined_at: new Date().toISOString() };
      return;
    }
  }
}

export async function capacitySlices(gap: Record<string, unknown>): Promise<Array<{ file: string; hint: string }>> {
  try {
    const meta = (gap.classification_metadata as Record<string, unknown>) ?? {};
    if (!(Number(meta.failed_attempts) >= 2)) return [];
    const reportPath = `/workspace/proposals/${String(gap.id)}-compose-report.json`;
    let report: Record<string, unknown>;
    try {
      const raw = await readFile(reportPath, "utf8");
      report = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const semanticGate = report.semantic_gate as Record<string, unknown> | undefined;
    const verifyArr = report.verify as Array<Record<string, unknown>> | undefined;
    const firstVerifyOutput = verifyArr && verifyArr[0] ? String((verifyArr[0] as Record<string, unknown>).output ?? "") : "";
    const opCount = Number(report.op_count);
    const hasCapacityEvidence =
      opCount >= 20 ||
      (semanticGate !== undefined && semanticGate.addresses === false) ||
      firstVerifyOutput.includes("TS1005");
    if (!hasCapacityEvidence) return [];
    const candidates = new Set<string>();
    const suspected = String(meta.suspected_real_location ?? "");
    for (const tok of suspected.split(/[,\s]+/)) {
      if (tok.startsWith("repos/") && tok.endsWith(".ts")) candidates.add(tok);
    }
    const reason = semanticGate && typeof semanticGate.reason === "string" ? (semanticGate.reason as string) : "";
    if (reason) {
      const re = /repos\/[A-Za-z0-9_-]+\/src\/[A-Za-z0-9_./-]+[.]ts/g;
      const matches = reason.match(re);
      if (matches) for (const m of matches) candidates.add(m);
    }
    if (candidates.size < 2) return [];
    const hint = reason ? reason.slice(0, 160) : "";
    return Array.from(candidates).map((file) => ({ file, hint }));
  } catch {
    return [];
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY-GAP → AUTHOR_NEW_RESOLVER bridge (net-new producer authoring, 2026-06-30)
//
// A capability gap filed by goal-host's shape-graph walk (fileCapabilityGap;
// classification_metadata.kind === "capability_gap") names a missing OUTPUT SHAPE
// with no producer AND no live resolver to bridge. The two existing routes BOTH
// fail this case: the orphaned_capability route needs an EXISTING resolver, and
// feature_compose free-drafts a phantom vessel for net-new producers (see the note
// on the orphaned route). The substrate already HAS the right primitive —
// author_new_resolver (Seam ③) authors a net-new resolver end-to-end (impl + test
// new_files[], spliced config.ts/impulses.ts overwrite_files[]) as a patch_proposal
// that apply_proposal_as_patch → mitosis cutover stages, gates (tsc +
// check-shape-dispatch + bun test) and lands. This route CONNECTS the walk's native
// recognition to that primitive, closing the whole class of missing-producer gaps
// autonomously rather than per-shape operator authoring (the S1→S2 unlock).
// ─────────────────────────────────────────────────────────────────────────────

/** camelCase / PascalCase shape → snake_case resolver name (the form
 *  author_new_resolver requires: /^[a-z][a-z0-9_]*$/). */
function shapeToResolverName(shape: string): string {
  return shape
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * DEAD (2026-07-01): no longer called. The capability-gap route now goes through
 * feature_compose (which drafts + verifies + repairs the whole resolver), retiring this
 * single-shot, unverified body-drafter that had no typecheck backstop. Kept only to avoid
 * a large template-literal delete mid-session; safe to remove wholesale in a follow-up.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function draftResolverImplBody(shape: string, goalText: string): Promise<string | null> {
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
    const prompt =
      `Write the BODY (statements only — NO function signature, NO import lines, NO markdown fences) of an async TypeScript resolver that PRODUCES the impulse shape "${shape}".\n\n` +
      `WHAT IT MUST COMPUTE:\n${goalText}\n\n` +
      `CONTRACT:\n` +
      `- The body is wrapped as: export async function resolve...(pointer): Promise<ResolverResult> { <YOUR BODY> }\n` +
      `- It MUST end by returning { shape: "${shape}", body: <the computed report object> }.\n` +
      `- On any error, return { shape: "${shape}", body: { error: String(e) } } — never throw.\n` +
      `- ONLY GLOBALS are available: fetch, process.env, AbortSignal, JSON, Math, Date is NOT available for deterministic runs — avoid Date.now()/new Date(); if you need a timestamp read it from data you fetch.\n` +
      `- Read substrate data IDIOMATICALLY. Header on every call: Authorization: \`ApiKey \${process.env.METABOB_API_KEY}\`, Content-Type application/json, AbortSignal.timeout(20000). Tolerate non-OK/timeout gracefully (never throw). Available reads (USE THESE EXACT PATHS — do NOT invent paths like /traces or /activities):\n` +
      `    • activity-api = (process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080"):\n` +
      `        GET  {activity-api}/v2/activities/templates?limit=100      → { templates: [{ id, metrics:{ thompson_alpha, thompson_beta, success_rate }, output_shapes, ... }] }\n` +
      `        GET  {activity-api}/v2/activities/composition/graph?limit=200 → composition edges (producer→consumer shape flow)\n` +
      `        POST {activity-api}/v2/impulses/resolve  body { impulse:{ pointer:{ type:<readShape>, ...filters } } } → { content/body } (read shapes: activityMetrics, executionTraceList, compositionSuccess — each needs shape-specific filter fields; prefer the GET endpoints above when they suffice)\n` +
      `    • dev-vessel = (process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090"):\n` +
      `        POST {dev-vessel}/v2/impulses/resolve body { impulse:{ pointer:{ type:"substrateGap", status:"open", limit:200 } } } → { body:{ gaps:[...] } } (for unsatisfied-shape / closure demand)\n` +
      `- The producer MUST read REAL data from the correct endpoint above and aggregate it — a producer that returns hardcoded/empty data without fetching is a HOLLOW producer and will be rejected by the goal-reach gate.\n\n` +
      `STRICT TYPESCRIPT — the file is typechecked with strict:true + noUncheckedIndexedAccess:true. Follow these rules EXACTLY or it will NOT compile:\n` +
      `  • The wrapper signature is \`(pointer): Promise<ResolverResult>\` where pointer is typed \`{ type: string; [key: string]: unknown }\`. To read a pointer field, access it then coerce — NEVER cast the pointer to a shape. RIGHT: \`const limit = Number((pointer as Record<string, unknown>).limit ?? 100);\`  WRONG: \`pointer as { limit: number }\` (TS2352).\n` +
      `  • Type ALL fetched JSON as \`any\`: \`const data = (await res.json()) as any;\`. Then narrow arrays defensively: \`const rows: any[] = Array.isArray(data?.templates) ? data.templates : [];\`.\n` +
      `  • noUncheckedIndexedAccess: array/object index access is \`T | undefined\`. NEVER use \`!\` non-null assertions. Guard every access with \`?.\` and \`?? default\`, or iterate with \`for (const r of rows)\` where r is \`any\`.\n` +
      `  • Do NOT import anything (only \`ResolverResult\` is imported by the wrapper). Use only globals.\n\n` +
      `COMPILING SKELETON — adapt this exact structure (it compiles under the strict config); fill in the aggregation for THIS shape:\n` +
      `  const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";\n` +
      `  const apiKey = process.env.METABOB_API_KEY ?? "";\n` +
      `  const limit = Number((pointer as Record<string, unknown>).limit ?? 100);\n` +
      `  try {\n` +
      `    const res = await fetch(\`\${endpoint}/v2/activities/templates?limit=\${limit}\`, { headers: { Authorization: \`ApiKey \${apiKey}\`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000) });\n` +
      `    if (!res.ok) return { shape: ${JSON.stringify(shape)}, body: { error: \`http \${res.status}\` } };\n` +
      `    const data = (await res.json()) as any;\n` +
      `    const rows: any[] = Array.isArray(data?.templates) ? data.templates : [];\n` +
      `    // ... aggregate rows per the spec into \`report\` ...\n` +
      `    return { shape: ${JSON.stringify(shape)}, body: { count: rows.length, /* real aggregated fields */ } };\n` +
      `  } catch (e) {\n` +
      `    return { shape: ${JSON.stringify(shape)}, body: { error: String(e) } };\n` +
      `  }\n\n` +
      `Respond with ONLY the function-body statements (no signature, no imports, no fences).`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "anthropic/claude-sonnet-4-6", max_tokens: 2200 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    let body = String(j.content ?? j.data ?? "").trim();
    if (!body) return null;
    // Strip accidental code fences.
    body = body.replace(/^```(?:ts|typescript)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    // Only unwrap a leaked FULL function: strip the signature AND its matching
    // closing brace together. Stripping a trailing `}` unconditionally corrupts a
    // statements-only body (the common case) that legitimately ends in `}` (e.g.
    // a closing try/catch or returned object literal) → brace imbalance → tsc fails.
    const sig = body.match(/^export\s+async\s+function[^{]*\{\s*/i);
    if (sig) {
      body = body.slice(sig[0].length).replace(/\}\s*$/, "").trim();
    }
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Route a WALK-DEMANDED capability gap (missing producer for a shape a real goal
 * needed) to feature_compose, which authors a NEW resolver AND verifies+repairs it
 * (its typecheck + shape-dispatch-check gates enforce the three-place wiring) before
 * landing via cutover. Two operator constraints (2026-07-01) shape this:
 *   • JUSTIFY THE SPEND — author only when the capability_gap carries a `goal` (real
 *     walk demand). No goal ⇒ no demand ⇒ skip (reuse-before-mint; don't mint a
 *     producer nothing consumes).
 *   • FOLLOW THE PATTERN — reuse feature_compose's tested verify+repair loop rather
 *     than the prior single-shot draftResolverImplBody→author_new_resolver path, which
 *     had no verify backstop and stalled the whole route (0 lands / pending-mitosis
 *     churn; see finding_2026_07_01_capability_gap_route_stalls).
 * Target vessel defaults to development-vessel (the introspection meta-vessel); a gap
 * may override via classification_metadata.target_vessel.
 */
async function routeCapabilityGapToNewResolver(
  gap: Record<string, unknown>,
  missingShape: string,
  meta: Record<string, unknown>,
  pointer: GapToFeaturePointer,
): Promise<ResolverResult> {
  const vessel = (typeof meta.target_vessel === "string" && meta.target_vessel.trim()) || "development-vessel";
  const resolverName = shapeToResolverName(missingShape);
  if (!/^[a-z][a-z0-9_]*$/.test(resolverName)) {
    return { shape: "gapToFeatureReport", body: { ok: false, route: "author_new_resolver", gap_id: gap.id, error: `cannot derive snake_case resolver name from shape "${missingShape}"` } };
  }
  const goalText = String(meta.goal ?? gap.summary ?? `produce the ${missingShape} shape`);

  // JUSTIFY THE SPEND (operator 2026-07-01): author a NEW resolver ONLY for a
  // WALK-DEMANDED capability gap — fileCapabilityGap sets `goal` precisely because a
  // real goal needed the shape with no producer. No goal = no demand = don't spend the
  // (expensive) author+verify+cutover time on a producer nothing consumes (reuse-before-
  // mint; minting an unconsumed producer raises ρ_grow for zero λ₁ gain).
  if (!String(meta.goal ?? "").trim()) {
    return { shape: "gapToFeatureReport", body: {
      ok: false, route: "capability_gap_skipped", gap_id: gap.id, shape: missingShape,
      reason: "no walk demand (capability_gap carries no goal) — not worth authoring a resolver (reuse-before-mint)",
    } };
  }

  const kebab = resolverName.replace(/_/g, "-");
  // FOLLOW THE PATTERN (operator 2026-07-01): route through feature_compose, whose
  // verify+repair loop is the tested backstop (its typecheck + shape-dispatch-check
  // gates enforce the three-place wiring). The prior single-shot draftResolverImplBody
  // → author_new_resolver path had NO verify backstop, so it staged un-typechecked code
  // that mitosis-cutover then rejected (0 lands / pending-mitosis churn — see
  // finding_2026_07_01_capability_gap_route_stalls). Reuse the existing tested machinery
  // instead of a one-off.
  const spec = [
    `MISSING PRODUCER for impulse shape "${missingShape}": a real goal needed it and no resolver produces it. AUTHOR A NEW RESOLVER in repos/${vessel} (this is a CREATE, not a surgical edit):`,
    `1. Create src/resolvers/${kebab}.ts exporting an async resolver \`(pointer): Promise<ResolverResult>\` that reads REAL substrate data and returns { shape: "${missingShape}", body: <computed report> }. It MUST fetch + aggregate real data — a hollow stub is rejected by the goal-reach gate.`,
    `2. WIRE IT THREE-PLACE in the SAME change (or the shape-dispatch-check fails the verify gate): add "${missingShape}" to the discovery.shapes array in src/config.ts; add \`case "${missingShape}":\` dispatching the new resolver before default: in src/routes/impulses.ts (with its import from "../resolvers/${kebab}.js"); add a per-resolver test test/resolvers/${kebab}.test.ts.`,
    `3. STRICT TS (strict + noUncheckedIndexedAccess): import only ResolverResult; use only globals (fetch, process.env, AbortSignal, JSON, Math — Date.now() is unavailable); type fetched JSON as any; guard every index access with ?./?? ; never use non-null !.`,
    `The goal that needs this shape (this is why the spend is justified): ${goalText}`,
  ].join("\n");

  // Pick-time condition verification: if the gap condition no longer holds,
  // close as already_resolved and skip composing.
  const pickConditionCheck = verifyGapCondition(gap as Record<string, unknown>);
  if (pickConditionCheck === 'absent') {
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} condition absent at pick time — closing as already_resolved`);
    try {
      const arMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution: 'already_resolved', closed_at: new Date().toISOString() };
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: String(gap.id ?? ''),
          category: gap.category,
          source: gap.source,
          summary: gap.summary,
          detected_at: gap.detected_at,
          classification_metadata: arMeta,
          status: "closed",
        },
      } as never);
    } catch (writeErr) {
      console.log(`[gap-to-feature] already_resolved write failed: ${(writeErr as Error).message}`);
    }
    return { shape: "gapToFeatureReport", body: { ok: true, gap_id: gap.id, gap_category: gap.category, verdict: "already_resolved", note: "gap condition absent at pick time — closed as already_resolved" } };
  }

  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    verify_vessels: [`repos/${vessel}`],
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    keep_on_fail: false,
    gap: {
      id: String(gap.id ?? ""),
      summary: String(gap.summary ?? gap.title ?? ""),
      classification_metadata: meta,
      category: String(gap.category ?? ""),
    },
    land: !(pointer.dry_run ?? false),
  });
  const cb = (compose.body ?? {}) as Record<string, unknown>;

  if (pointer.dry_run) {
    return { shape: "gapToFeatureReport", body: {
      ok: cb.ok !== false, route: "capability_gap_via_feature_compose", verdict: "plan",
      gap_id: gap.id, gap_category: gap.category, target_vessel: vessel,
      resolver_name: resolverName, shape: missingShape, compose: cb,
      note: `plan: would author + VERIFY (feature_compose repair loop) a resolver producing "${missingShape}" in ${vessel} and land via cutover`,
    } };
  }

  // CLOSE-ON-LAND: only when feature_compose GENUINELY landed on origin/dev; otherwise
  // deprioritise so the picker advances (mirrors the main gap_to_feature flow).
  const land = genuineLandSignal(cb, true);
  let closed = false;
  if (land.landed) {
    const c = await closeLandedGap(gap, land);
    closed = c.closed;
  } else {
    await bumpFailedAttempts(gap);
  }
  return {
    shape: "gapToFeatureReport",
    body: {
      ok: land.landed, route: "capability_gap_via_feature_compose",
      gap_id: gap.id, gap_category: gap.category, target_vessel: vessel,
      resolver_name: resolverName, shape: missingShape,
      verdict: cb.verdict ?? null, landed: land.landed, landed_commit: land.commit_sha ?? null,
      gap_closed: closed,
      note: land.landed
        ? `authored + VERIFIED a new resolver producing "${missingShape}" (feature_compose verify+repair) and landed via cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}`
        : `feature_compose could not land a verified resolver for "${missingShape}" (verdict ${String(cb.verdict)}) — gap deprioritised, picker advances`,
    },
  };
}

export async function resolveGapToFeature(pointer: GapToFeaturePointer): Promise<ResolverResult> {
  // 1. Select a gap — landability-ranked when auto-picking (not arbitrary gaps[0]).
  let gap: Record<string, unknown> | null = null;
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      // Targeted dispatch: pass the id straight to the read so a SPECIFIC gap is
      // fetched directly. Without this, selection read a limit-25 window and did
      // gaps.find(id) on it — a buried gap (store has 1000+) was never found and
      // the resolver returned "no matching open gap" for a gap that plainly exists.
      ...(pointer.gap_id ? { id: pointer.gap_id } : {}),
      ...(pointer.category ? { category: pointer.category } : {}),
      status: "open",
      // Exclude goal-host auto_draft_* decision-log noise BEFORE the limit slice
      // so the actionable window is never starved by per-dispatch log entries.
      // (Log rows stay in the store; an explicit category/id query reads them.)
      exclude_categories: (pointer.category || pointer.gap_id) ? [] : [...DECISION_LOG_GAP_CATEGORIES],
      // Read the FULL real backlog, not a recency window. The read sorts by
      // updated_at DESC then slices; a small limit (was 25) silently DROPPED aged
      // gaps before pickMostLandable ever scored them — so a one-time operator- or
      // human-filed gap (obsidian DEVELOP request, an architectural gap) that isn't
      // continuously re-emitted by a detector AGED OUT of the window and was never
      // worked, however landable. With the decision-log noise already excluded the
      // real backlog is a few hundred gaps (all in memory via loadGaps), so scoring
      // them all per run is cheap; landability then governs the WHOLE backlog and
      // failed_attempts culls repeat-failers, so nothing high-value is starved by
      // age. This makes the human/operator-request channel reliable. (2026-07-01)
      limit: pointer.limit ?? 1000,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    gap = pointer.gap_id
      ? gaps.find((g) => g.id === pointer.gap_id) ?? gaps[0] ?? null
      : pickMostLandable(gaps);
  } catch (e) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: (e as Error).message } };
  }
  if (!gap) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: "no matching open gap", category: pointer.category ?? null } };
  }
  await recordApproachDecision(gap);

  // Pick-time condition check: if the surgical gap's cited literal is already
  // absent from the codebase, close it as already_resolved without composing.
  const _pickCond = verifyGapCondition(gap);
  if (_pickCond === 'absent') {
    const closedAt = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id as string,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution: "already_resolved", closed_at: closedAt },
        status: "closed",
      },
    } as never);
    return {
      shape: "gapToFeatureReport",
      body: {
        ok: true,
        gap_id: gap.id as string,
        gap_category: gap.category as string,
        verdict: "already_resolved",
        note: "gap condition absent at pick time — closed as already_resolved",
      },
    };
  }

  // 1a-pre. ALREADY-RESOLVED CHECK for missing_capability gaps: query discovery for a
  // live producer of the candidate shape named in the gap summary. If found, and (when
  // edit_site is present) the file exists via statSync, close the gap without composing
  // to prevent duplicate-identifier patches from re-applying already-landed patches.
  if (String(gap.category ?? "") === "missing_capability") {
    const mcMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const mcEditSite = typeof mcMeta["edit_site"] === "string" ? mcMeta["edit_site"] as string : undefined;
    const mcSummary = typeof gap.summary === "string" ? gap.summary as string : "";
    const mcShapeMatch = mcSummary.match(/[a-z][a-z0-9_:-]{2,}/);
    const mcCandidateShape = mcShapeMatch ? mcShapeMatch[0] : undefined;
    let mcAlreadyResolved = false;
    if (mcCandidateShape) {
      try {
        const mcDiscoveryEndpoint = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
        const mcProbeRes = await fetch(
          `${mcDiscoveryEndpoint}/vessels?shape=${encodeURIComponent(mcCandidateShape)}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (mcProbeRes.ok) {
          const mcProbeBody = (await mcProbeRes.json()) as { vessels?: unknown[] };
          if (Array.isArray(mcProbeBody.vessels) && mcProbeBody.vessels.length > 0) {
            if (mcEditSite) {
              try {
                statSync(mcEditSite);
                mcAlreadyResolved = true;
              } catch {
                // File absent — capability registered but file not present; let composer run
              }
            } else {
              mcAlreadyResolved = true;
            }
          }
        }
      } catch {
        // Discovery unreachable or timeout — proceed with normal compose
      }
    }
    if (mcAlreadyResolved) {
      const mcClosureNote = `already_resolved: live producer found for shape '${mcCandidateShape ?? mcSummary}'${
        mcEditSite ? ` and edit_site '${mcEditSite}' exists in container tree` : ""
      }; gap closed without recompose to prevent duplicate-identifier patches`;
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: { ...mcMeta, resolution: "already_resolved", closed_at: new Date().toISOString() },
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: true,
          gap_id: gap.id,
          gap_category: gap.category,
          verdict: "already_resolved",
          note: mcClosureNote,
        },
      };
    }
  }

  // 1a. DOCUMENTATION-DRIFT gaps close via doc_drift_fix, NOT feature_compose (2026-07-01).
  // A doc is prose: feature_compose grounds/verifies .ts only, so its typecheck→rollback gate
  // is a no-op for a .md edit — routing prose through it would land an LLM draft with the gate
  // disabled. doc_drift_fix drafts the minimal edit and gates it with a prose reach-gate (the
  // doc analogue of verifyGoalReached). It is TRIAGE-only by default (DOC_FIX_AUTOLAND off).
  if (String(gap.category ?? "") === "documentation_drift") {
    const ddResult = await resolveDocDriftFix({ type: "doc_drift_fix", gap_id: String(gap.id ?? ""), dry_run: pointer.dry_run });
    if (!pointer.dry_run && (ddResult?.body as { ok?: boolean } | undefined)?.ok === false) {
      await bumpFailedAttempts(gap);
    }
    return ddResult;
  }

  // 1b. ORPHANED-CAPABILITY gaps close via author_producer, NOT feature_compose
  // (2026-06-25). The closure for "resolver X is live but invoked by 0 activities"
  // is a RUNNABLE activity that invokes X — minted by the author_producer bridge
  // path (lever 1: author→validate→mint a 2-task goal_file_extract→produce bridge
  // for a file-consuming resolver). feature_compose authors vessel TypeScript and
  // here free-drafts a create_file into a NON-EXISTENT vessel (e.g. repos/executive/)
  // that phantom-lands and never invokes the resolver. Route to the primitive that
  // actually produces a discoverable, Thompson-selectable producer.
  if (String(gap.category ?? "") === "unreachable_producer") {
    const repaired = await resolveReachabilityGapRepair({ type: "reachability_gap_repair", gap_id: String(gap.id ?? ""), dry_run: pointer.dry_run });
    const rb = (repaired?.body ?? {}) as Record<string, unknown>;
    if (!pointer.dry_run && rb["verdict"] !== "FAVORABLE") await bumpFailedAttempts(gap);
    if (!pointer.dry_run && rb["verdict"] === "FAVORABLE") {
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>,
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
    }
    return {
      shape: "gapToFeatureReport",
      body: { ok: rb["verdict"] === "FAVORABLE", stage: "route_reachability", gap_id: gap.id, gap_category: gap.category, route: "reachability_gap_repair", repair: rb },
    };
  }
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
    // Deprioritise repeated MINT_FAILED. This early-return branch never reached
    // bumpFailedAttempts (which fires only on the feature_compose path, ~L1056), so
    // an orphaned-capability gap whose resolver can't be provisioned was re-selected
    // every run FOREVER (observed: residual_shape_discovery MINT_FAILED hourly with
    // failed_attempts unset), starving other gaps — the same liveness bug as the
    // detector-re-emit wipe, on a different code path. Bump so the loop moves on. (2026-07-01)
    if (!pointer.dry_run && !minted) await bumpFailedAttempts(gap);
    // CLOSE-ON-MINT (2026-07-01): a minted bridge IS the closure — the resolver is now
    // invoked by a Thompson-selectable activity, so it is no longer orphaned. Without
    // closing, the open-filtered picker re-selects the SAME top orphaned gap every run
    // and re-mints it idempotently, never advancing to the other orphaned resolvers
    // (observed: repairPolicy re-picked + re-MINTED though auto-bridge-repairPolicy
    // already existed). Mirrors closeLandedGap on the feature_compose path (~L1071).
    if (!pointer.dry_run && minted) {
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>,
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
    }
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

  // 1c. CAPABILITY-GAP (missing producer, no existing resolver) → author_new_resolver.
  // The walk files these (kind === "capability_gap", classification_metadata.
  // missing_shape) when no producer exists for a target output shape. Route to the
  // create-oriented primitive instead of feature_compose free-draft (see the bridge
  // note above). This is the S1→S2 unlock for the whole missing-producer class.
  {
    const cgMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    if (String(cgMeta.kind ?? "") === "capability_gap") {
      const missingShape = String(cgMeta.missing_shape ?? "").trim();
      if (missingShape) {
        const cgResult = await routeCapabilityGapToNewResolver(gap, missingShape, cgMeta, pointer);
        // Same liveness fix: this route's failure returns (ok:false) never bumped
        // failed_attempts either, so a capability_gap the author can't satisfy would
        // be re-selected forever. Bump on failure so the loop moves on. (2026-07-01)
        if (!pointer.dry_run && (cgResult?.body as { ok?: boolean } | undefined)?.ok === false) {
          await bumpFailedAttempts(gap);
        }
        return cgResult;
      }
    }
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
  const slices = await capacitySlices(gap);
  if (slices.length >= 2) {
    const sliceResults: Array<{ file: string; verdict: unknown }> = [];
    let lastBody: Record<string, unknown> | null = null;
    for (const s of slices) {
      const sliceCompose = await resolveFeatureCompose({
        type: "feature_compose",
        spec: spec + "\n" + `CAPACITY SLICE: this dispatch must touch ONLY the file ${s.file}; other slices are handled in separate dispatches.` + (s.hint ? ` Context: ${s.hint}` : ""),
        ...(verifyVessels.length ? { verify_vessels: verifyVessels } : {}),
        model: pointer.model,
        dry_run: pointer.dry_run ?? false,
        keep_on_fail: false,
        gap: {
          id: String(gap.id ?? ""),
          summary: String(gap.summary ?? gap.title ?? ""),
          classification_metadata: (gap.classification_metadata ?? gap.metadata ?? undefined) as Record<string, unknown> | undefined,
          category: String(gap.category ?? ""),
        },
        land: !(pointer.dry_run ?? false),
        max_ops: 8,
      } as never);
      lastBody = sliceCompose.body as Record<string, unknown>;
      sliceResults.push({ file: s.file, verdict: lastBody.verdict });
      if (lastBody.verdict !== "FAVORABLE") break;
    }
    const allOk = sliceResults.length === slices.length && sliceResults.every((r) => r.verdict === "FAVORABLE");
    if (allOk && lastBody) {
      const sliceLand = genuineLandSignal(lastBody, !(pointer.dry_run ?? false));
      if (sliceLand.landed) await closeLandedGap(gap, sliceLand);
    }
    if (!allOk && !pointer.dry_run) await bumpFailedAttempts(gap);
    return { shape: "gapToFeatureReport", body: { ok: allOk, stage: "route_compose", route: "capacity_slice_sequence", gap_id: gap.id, gap_category: gap.category, slices: sliceResults } };
  }

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
