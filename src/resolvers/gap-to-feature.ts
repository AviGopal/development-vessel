import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose, priorAttemptFeedbackBlock } from "./feature-compose.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES } from "./substrate-gap.js";
import { resolveAuthorProducer } from "./author-producer.js";
import { resolveDocDriftFix } from "./doc-drift-fix.js";
import { resolveReachabilityGapRepair } from "./reachability-gap-repair.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";
import { resolveUiWritePassthrough } from "./ui-write-passthrough.js";

const solicitedHumanGaps = new Set<string>();
import { DISCOVERY_ENDPOINT, METABOB_API_KEY, GOAL_HOST_VESSEL_ENDPOINT } from "../config.js";
import { readFile } from "node:fs/promises";

// Mirror feature-compose's path model: repos/<vessel>/... maps to the writable
// runtime ${MITOSIS_RUNTIME_DIR}/<vessel>/..., and the drafter writes proposal reports
// to <workspace>/proposals/<gapId>-report.json.
// READ AT CALL TIME, not frozen at module load. These were `const … = process.env.X ?? …`,
// which binds to whichever importer loaded this module FIRST. Under `bun test` the module
// registry is shared across test files, so a sibling that redirected these to its own tmp
// fixture won the binding and every later file silently inherited it — the admission test
// saw a sibling's MITOSIS_RUNTIME_DIR (whose tree happens to contain goal-host-vessel/src/index.ts,
// so the cited-file check passed) paired with a proposals dir that had none of its fixtures.
// It passed alone and failed in the suite, which reads as flake rather than as the ordering
// dependency it is. An empty string is treated as unset: exporting X="" is "no value", and
// `??` does not fall back on "" (same defect class as 3409fac in config.ts).
const envPath = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
};
const runtimeRoot = (): string => envPath("MITOSIS_RUNTIME_DIR", "/vessels");
const proposalsDir = (): string => envPath("PROPOSALS_DIR", "/workspace/proposals");

// COMPOSE-HORIZON DEDUP — the one selection primitive, applied at the compose horizon.
// Ports boredom-vessel's gapGoalLastDispatchAt + GAP_GOAL_COOLDOWN_MS (src/index.ts:3451-3485)
// and goal-host's /run-goal in-flight coalesce: a gap composed within the cooldown is
// guaranteed-redundant work (VoI~0 for the duplicate — same gap id, only a jittering residual
// float differs). Filter cooled gaps out of the AUTO-pick candidate set so the picker ADVANCES
// to the next-best gap instead of re-composing the same top gap every ~60-90s tick. This is the
// missing horizon that let cost-model-miscalibrated re-compose 17x/60min and starve self-authoring.
const GAP_COMPOSE_COOLDOWN_MS = parseInt(process.env.GAP_COMPOSE_COOLDOWN_MS ?? "300000", 10);
const gapComposeLastAttemptAt = new Map<string, number>();

/** A repos/<vessel>/... path maps to an EXISTING file under the runtime root. */
function repoPathExists(repoRelative: string): boolean {
  try {
    return existsSync(join(runtimeRoot(), repoRelative.replace(/^repos\//, "")));
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
    const path = join(proposalsDir(), `${gapId}-report.json`);
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
    return statSync(join(runtimeRoot(), vessel)).isDirectory();
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
/**
 * The file a gap says it is about, in the order the rest of this file already trusts:
 * `edit_site` first, then the legacy aliases, then a top-level field.
 *
 * `gap.file_path` alone is not enough — measured 2026-08-10 over the live store, 0 of
 * 360 gaps carried a top-level `file_path` while 104 carried
 * `classification_metadata.edit_site`. Reading only the former handed `undefined`
 * downstream and threw.
 */
export function gapEditSite(gap: Record<string, unknown>, meta: Record<string, unknown>): string | undefined {
  for (const f of ["edit_site", "file_path", "change_site", "path"] as const) {
    const v = meta?.[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const top = gap?.["file_path"];
  return typeof top === "string" && top.trim() ? top.trim() : undefined;
}

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
    const dirs = readdirSync(runtimeRoot()).filter((d) => {
      try { return statSync(join(runtimeRoot(), d)).isDirectory(); } catch { return false; }
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

/**
 * Read a bounded source excerpt around the first matched terms (else the file head) so the
 * ranking LLM picks the change-site by READING code, not guessing from a filename. Bounded
 * (≤2 windows, ≤1200 chars) to stay within weak-model context budgets; "" on any error, so
 * the caller degrades gracefully to filename-only ranking. This adds INFORMATION at the
 * moment of use — it does not add localization heuristics.
 */
function siteExcerpt(repoRel: string, terms: string[]): string {
  try {
    const abs = join(runtimeRoot(), repoRel.replace(/^repos\//, ""));
    const lines = readFileSync(abs, "utf8").split("\n");
    const marks: number[] = [];
    for (const t of terms) {
      const i = lines.findIndex((l) => l.includes(t));
      if (i >= 0 && !marks.includes(i)) marks.push(i);
      if (marks.length >= 2) break;
    }
    const anchors = marks.length ? marks : [0];
    const windows = anchors.slice(0, 2).map((m) => {
      const a = Math.max(0, m - 4);
      const b = Math.min(lines.length, m + 10);
      return lines.slice(a, b).map((l, k) => `${a + k + 1}: ${l}`).join("\n");
    });
    return windows.join("\n  …\n").slice(0, 1200);
  } catch {
    return "";
  }
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
    // Rank among the top candidates WITH source excerpts (bounded for weak-model budgets),
    // so the pick is made by reading code rather than guessing from a filename.
    const top = hits.slice(0, 5);
    const list = top.map((h, i) => `[${i}] ${h.file} (matched: ${h.matched.join(", ")})\n${siteExcerpt(h.file, h.matched)}`).join("\n\n");
    const prompt = `A substrate gap needs the SINGLE existing source file that is the change site. READ the code excerpts below and pick the file whose logic the gap describes.\n\nGAP: ${summary}\n\nCandidates:\n${list}\n\nReturn ONLY the integer index [0..${top.length - 1}] of the change-site file. If none fits, return -1. Respond with JUST the number.`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: 24 }),
      signal: AbortSignal.timeout(LOCALIZE_LLM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    const txt = String(j.content ?? j.data ?? "").trim();
    const m = txt.match(/-?\d+/);
    if (!m) return null;
    const idx = parseInt(m[0], 10);
    if (idx < 0 || idx >= top.length) return null;
    return top[idx]!.file;
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
  const srcAbs = join(runtimeRoot(), vessel, "src");
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
    return readdirSync(runtimeRoot()).filter((d) => {
      try {
        if (!statSync(join(runtimeRoot(), d)).isDirectory()) return false;
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

/**
 * Return a REAL line from the live target file that occurs EXACTLY ONCE — a
 * deterministic MATCH ANCHOR the drafter can localize on. The drafter obeys the
 * spec anchor over the actual file, so a SCHEMATIC (non-existent) gap-derived
 * line mis-directs the edit and a NON-UNIQUE line fails closed. Selection order:
 *   1. the most-distinctive line drawn FROM the excerpt hint that is unique in
 *      the file — keeps the detector's intended context when the excerpt was
 *      accurate, and REJECTS it when schematic (no excerpt line exists uniquely);
 *   2. else the most-distinctive unique line in the edit-site window (±20 lines
 *      when a line number is known, else the whole file).
 * Returns the ORIGINAL file line (verbatim, with its indentation), or null when
 * nothing clears the uniqueness bar. Only ever returns text that literally
 * exists in the live file.
 */
export function groundedUniqueAnchor(
  liveLines: string[],
  excerptHint: string | null,
  startLine: number,
): string | null {
  const norm = (s: string) => s.trim();
  const MIN_LEN = 12;   // ignore short/boilerplate lines (braces, keywords)
  const MAX_LEN = 240;  // avoid quoting a minified/huge line as the anchor
  const counts = new Map<string, number>();
  const original = new Map<string, string>(); // norm -> first original (indented) line
  for (const l of liveLines) {
    const t = norm(l);
    if (t.length < MIN_LEN || t.length > MAX_LEN) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (!original.has(t)) original.set(t, l);
  }
  const uniqueOriginal = (t: string): string | null =>
    counts.get(t) === 1 ? (original.get(t) ?? null) : null;
  // (1) a unique line taken from the excerpt hint — most distinctive first.
  if (excerptHint) {
    const cand = excerptHint.split("\n").map(norm).filter((t) => t.length >= MIN_LEN);
    cand.sort((a, b) => b.length - a.length);
    for (const t of cand) {
      const o = uniqueOriginal(t);
      if (o) return o;
    }
  }
  // (2) a unique line inside the edit-site window.
  const from = startLine > 0 ? Math.max(0, startLine - 20) : 0;
  const to = startLine > 0 ? Math.min(liveLines.length, startLine + 20) : liveLines.length;
  const win = liveLines.slice(from, to).filter((l) => norm(l).length >= MIN_LEN);
  win.sort((a, b) => norm(b).length - norm(a).length);
  for (const l of win) {
    const o = uniqueOriginal(norm(l));
    if (o) return o;
  }
  return null;
}

// Grounds the spec anchor in the LIVE target file: hands the drafter real file
// text (a verbatim window + a proven-UNIQUE match line) instead of a gap-derived
// matched_excerpt that may be schematic or non-unique. matched_excerpt is used
// only as a HINT to select the unique line, never emitted verbatim unless the
// live target file cannot be read.
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
        // Ground the anchor against the LIVE target file. The drafter obeys the
        // spec anchor over the real file, so a SCHEMATIC (non-existent) or
        // NON-UNIQUE gap-derived excerpt mis-localizes the edit — the drafter's
        // binding-constraint failure. Whenever the target is a readable
        // repos/<vessel>/src file we hand the drafter ONLY real file text: a
        // verbatim window for context PLUS a line proven to occur EXACTLY ONCE in
        // the live file to anchor on. matched_excerpt is used only as a HINT to
        // pick that unique line (excerpt-first, then edit-site window), never
        // emitted verbatim unless the live file cannot be read.
        let anchorLine = "";
        const firstTarget: string | undefined = editTargets[0]?.file;
        const excerptHint = meta.matched_excerpt != null ? String(meta.matched_excerpt) : "";
        let liveLines: string[] | null = null;
        if (firstTarget && /^\/repos\/[^/]+\/src\//.test(`/${firstTarget}`)) {
          try {
            liveLines = readFileSync(join(runtimeRoot(), firstTarget.replace(/^repos\//, "")), "utf8").split("\n");
          } catch {
            liveLines = null; // file unreadable — fall back below
          }
        }
        if (liveLines && firstTarget) {
          // Near-edit-site grounding (#18): center the ~40-line window on the edit
          // site when edit_site/suspected_real_location names a line; else top of file.
          const siteStr = `${String(meta.edit_site ?? "")} ${String(meta.suspected_real_location ?? "")}`;
          const lineMatch = siteStr.match(/(?::|line\s+|#L)(\d+)/i);
          let startLine = lineMatch ? (parseInt(lineMatch[1] ?? "0", 10) || 0) : 0;
          // REGION -> LINE. A ui-feedback gap names the surface's file but not a line, so
          // this window fell back to the TOP OF FILE and the drafter anchored on whatever
          // happened to be there. Observed: a complaint about `sub-card sub-card--fleet`
          // produced a plan anchored on `sub-step-shadowline`, an unrelated region, twice
          // over with the identical old_string.
          //
          // The region IS the literal CSS class the renderer passes to createDiv, so it is
          // greppable in the file we were just told to edit. Resolve it here — this code
          // runs in development-vessel, which HAS the repo; the filing vessel (an Obsidian
          // plugin) does not and cannot. Prefer the LAST occurrence: these views build a
          // compact row first and the expanded detail later, and a complaint about content
          // legibility is about the rendered detail.
          if (startLine === 0) {
            const region = String(meta.region ?? "").trim();
            if (region) {
              const idx = liveLines.map((l, i) => (l.includes(region) ? i : -1)).filter((i) => i >= 0);
              if (idx.length > 0) {
                startLine = (idx[idx.length - 1] ?? 0) + 1;
                console.log(`[gap-to-feature] region->line: "${region}" found at ${idx.length} site(s) in ${firstTarget}; grounding on line ${startLine} (last occurrence)`);
              } else {
                console.warn(`[gap-to-feature] region->line: "${region}" NOT FOUND in ${firstTarget} — grounding falls back to top of file, drafter will likely anchor on the wrong code`);
              }
            }
          }
          const from = Math.max(0, startLine - 15);
          const windowText = liveLines.slice(from, from + 40).join("\n");
          const anchorLabel = startLine > 0 ? "Anchor (verbatim near edit site)" : "Anchor (verbatim top of file)";
          const vesselName = firstTarget.split('/')[1] ?? 'unknown';
          const unique = groundedUniqueAnchor(liveLines, excerptHint || null, startLine);
          const uniqueNote = unique
            ? `\nMATCH ANCHOR (this REAL line occurs EXACTLY ONCE in ${firstTarget} — locate your edit relative to it, verbatim): \`\`\`\n${unique}\n\`\`\``
            : "";
          anchorLine = `File facts: ${firstTarget} (vessel: ${vesselName}), total_lines=${liveLines.length}, excerpt_start_line=${from + 1}\n${anchorLabel}: \`\`\`\n${windowText}\n\`\`\`${uniqueNote}`;
        } else if (excerptHint) {
          // Target is not a readable repos/<vessel>/src file — cannot ground.
          // Keep the upstream excerpt as-is (unchanged legacy behaviour).
          anchorLine = `Anchor (existing code near the change): \`\`\`\n${excerptHint}\n\`\`\``;
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
  if (move && move.source && move.target && move.target.repoPath) {
    const epName = move.target.endpoint ?? "";
    const srcLabel = move.source;
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
  // documentation_drift lands via doc_drift_fix as a DIRECT single-file prose edit
  // with no feature_compose draft and no mitosis cutover — more landable than
  // hard feature classes, not less. (2026-08-26)
  "documentation_drift",
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
  if (meta.edit_site || meta.suspected_real_location || meta.change_site || meta.failing_capability || meta.file_path || meta.doc_path) s += 0.3;
  if (typeof meta.edit_site === "string" || meta.single_file === true || typeof meta.doc_path === "string") s += 0.1;
  const cat = String(gap.category ?? "");
  if (HARD_CATEGORIES.has(cat)) s -= 0.4;
  if (SURGICAL_CATEGORIES.has(cat)) s += 0.15;
  if (cat === "documentation_drift") s += 0.2;
  // ids that empirically cycle UNFAVORABLE (meta/diagnostic; no surgical diff exists).
  if (/stale-proposal|demand-trace|forward[_-]chain|backlog|unknown/i.test(String(gap.id ?? ""))) s -= 0.3;
  // Deprioritise gaps that keep failing to land: each prior UNFAVORABLE attempt drops
  // the score, so the loop stops re-picking a stuck high-rank gap and moves to landable
  // work. Capped so a transient fail doesn't permanently bury a genuine gap.
  const fa = Number((meta as Record<string, unknown>).failed_attempts ?? 0);
  // Gaps with a concrete edit_site are surgical — each failure is a bad LLM
  // draft, not evidence the gap is unlandable. Cap the per-attempt penalty at
  // 0.1 (vs 0.2) for surgical gaps so the picker keeps revisiting them after
  // a transient UNFAVORABLE rather than burying them behind meta/diagnostic
  // gaps that have no failed attempts only because they were never picked.
  const hasConcreteSite = Boolean(meta.edit_site || meta.change_site || meta.single_file);
  // Per-gap failure lessons capture the exact mistake so the next LLM draft
  // avoids it — a gap with lessons is MORE landable on re-pick, not less.
  const hasLessons = Boolean((meta as Record<string, unknown>).per_gap_failure_lessons);
  const penalty = Math.min(fa * (hasConcreteSite ? 0.1 : 0.2), 0.4) - (hasLessons ? 0.05 : 0);
  s -= penalty;
  // Penalise gaps whose metadata points at the picker/composer itself — selecting
  // them creates a self-referential loop that never lands. blockingWeight > 1
  // means the gap targets core infrastructure; discount proportionally so the
  // picker deprioritises them relative to ordinary capability gaps.
  const bw = blockingWeight(gap);
  if (bw > 1) s -= Math.min(0.3, 0.1 * (bw - 1));
  return Math.max(0, Math.min(1, s));
}
function blockingWeight(gap: Record<string, unknown>): number {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let w = 1.0;
  const hay = [meta.edit_site, meta.failing_capability, meta.file_path, meta.root_cause]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/gap-to-feature|feature-compose|feature_compose|mitosis|cutover|drafter|fetchposteriorsforsignature|boredom-vessel/.test(hay)) w += 0.6;
  if (String(gap.category ?? "") === "self_development_reliability") w += 0.3;
  return Math.min(2.0, w);
}

/** Bounded so the pick cannot spawn a git subprocess per pooled gap. See chooseFirstActionable. */
export const PENDING_SCAN_MAX = 20;

/**
 * Walk a score-ranked candidate list and return the highest-ranked entry that is NOT pending.
 *
 * Split out of pickMostLandable so the skip can be tested with an injected predicate instead of
 * a real git history. `isPending` is evaluated LAZILY and at most PENDING_SCAN_MAX times: the
 * real predicate (verifyGapCondition -> landedCommitVerdict) spawns `git log` per clone, so
 * evaluating a ~330-gap pool on every pick would cost hundreds of subprocesses.
 *
 * Fail-open: if every candidate inside the scan window is pending, the top entry is returned
 * unchanged and the post-selection guard refuses it exactly as before. That preserves today's
 * behaviour rather than returning null and starving the tick.
 */
export function chooseFirstActionable<T>(
  ranked: Array<{ g: T; s: number }>,
  isPending: (g: T) => boolean,
  scanMax: number = PENDING_SCAN_MAX,
): { chosen: { g: T; s: number }; skippedPending: number } {
  let skippedPending = 0;
  const limit = Math.min(ranked.length, scanMax);
  for (let i = 0; i < limit; i++) {
    const cand = ranked[i]!;
    if (isPending(cand.g)) { skippedPending++; continue; }
    return { chosen: cand, skippedPending };
  }
  return { chosen: ranked[0]!, skippedPending };
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
    if (!r || r.attempts < 8 || r.lands !== 0) return false;
    // HUMAN-AUTHORIZED EXEMPTION (2026-08-28). 143212a traded the automatic re-test path
    // ("leaving a re-test path", d1bb37a) for a HUMAN DECISION, and predicated this
    // exclusion on the row being "already escalated" — the human IS the designed escape.
    // Until escalation_disposition_apply existed nothing applied the answer, so the trade
    // was one-directional and the seal was permanent. A gap whose escalation a human has
    // ANSWERED carries a bounded exemption; it is per-GAP and decrements, so the category
    // stays sealed for every other member and the flood 143212a deliberately closed cannot
    // reopen. Not a threshold change: without an answered escalation this is a no-op.
    const gm = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    if (Number(gm.human_exemption_attempts_remaining ?? 0) > 0) return false;
    return true;
  };
  // Escalate hopeless gaps to a HUMAN and exclude them from selection.
  // The escalation is the uiQuestion_write and nothing else. This branch used to ALSO call
  // resolveDispatchGoal({ goalShape: "substrate_gap_decompose", payload: {...} }). That call
  // could never dispatch: DispatchGoalPointer has no `goalShape` and no `payload` (see
  // repos/development-vessel/src/resolvers/dispatch-goal.ts @ `export interface DispatchGoalPointer`),
  // so resolveDispatchGoal read an empty `pointer.goal` and RETURNED a structuredError at
  // `if (!goal) return { shape: "structuredError"` — a resolved promise, which the attached
  // .catch() can never observe. The `as never` cast hid the type error and the error value was
  // discarded, so the failure was invisible. It is not repaired, because repairing it needs a
  // producer for `substrate_gap_decompose` and none exists: discovery advertises 332 shapes and
  // zero match /decompos/ (measured 2026-08-06 against http://localhost:18100/registry/shapes).
  // A dispatch to a shape nothing serves is confabulation with a dispatch id attached.
  const actionableGaps: Record<string, unknown>[] = [];
  for (const g of gaps) {
    if (hopeless(g)) {
      const gid = String((g as Record<string,unknown>).id ?? (g as Record<string,unknown>).gap_id ?? "");
      if (gid && !solicitedHumanGaps.has(gid)) {
        solicitedHumanGaps.add(gid);
        resolveUiWritePassthrough({ type: "uiQuestion_write", id: "needs-human-" + gid, title: "Gap needs a human decision", body: "Gap " + gid + " (" + String((g as Record<string,unknown>).category ?? "?") + ") has failed auto-repair 8+ times with 0 lands. It likely needs a human response: redefine the goal, provide missing information, grant access, or drop it. Summary: " + String((g as Record<string,unknown>).summary ?? "").slice(0, 300), kind: "gap_needs_human", importance: "high" } as never)
          .then((r) => {
            // An escalation that silently failed is indistinguishable from one that was never
            // attempted. Log ALL THREE outcomes so the absence of a line means "hopeless() never
            // fired", not "the escalation was eaten". Baseline before this change: 0 lines in 7d.
            const shape = (r as { shape?: unknown } | undefined)?.shape;
            if (shape === "structuredError") {
              console.warn(`[gap-escalation] uiQuestion_write REJECTED for hopeless gap ${gid}: ${JSON.stringify((r as { body?: unknown }).body).slice(0, 400)} — no human was asked`);
            } else {
              console.log(`[gap-escalation] uiQuestion_write accepted for hopeless gap ${gid} (shape=${String(shape)})`);
            }
          })
          .catch((e: unknown) => {
            console.warn(`[gap-escalation] uiQuestion_write THREW for hopeless gap ${gid}: ${String(e)} — no human was asked`);
          });
      }
      continue;
    }
    actionableGaps.push(g);
  }
  const scoredGaps = actionableGaps;
  // IMPACT-RANKED SELECTION (2026-07-09): landability alone drains the easiest gaps
  // first and lets a blocking gap starve behind them. Impact = how many OTHER open
  // gaps cite this gap (by id or by its failing_capability) in their summaries or
  // failure lessons — a cited blocker outranks its dependents, so a broken sensor
  // (missing_capability others depend on) self-prioritizes because it blocks
  // everything downstream. Computed from the gaps already in hand: no extra reads.
  // IMPACT MUST BE INDEPENDENT EVIDENCE (2026-08-06). `cited` counted ANY other open gap
  // whose summary contains this gap's id. The goal-host routing path mints children whose
  // summary IS the parent's goal text prefixed `Close substrate gap <parent-id>:`, so an
  // 80-generation prefix chain made every member cite its own ancestors. Measured on the
  // live store (651 admitted): 179 gaps sat at the x2.0 impact cap and ALL 179 were
  // edit_intent_route citing each other, while 0 of the 334 non-route gaps ever reached it.
  // A term meant to surface a BLOCKER was surfacing the one family that manufactures its
  // own citations. A citer in the SAME category is not independent evidence; count only
  // cross-category citations, which is exactly the "other kinds of work are blocked on
  // this" signal the term was introduced for.
  const impactOf = (g: Record<string, unknown>): number => {
    const id = String(g.id ?? "").toLowerCase();
    const gm = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    const cap = String(gm.failing_capability ?? "").toLowerCase();
    const myCat = String(g.category ?? "");
    let cited = 0;
    for (const other of gaps) {
      if (other === g || String(other.category ?? "") === myCat) continue;
      const om = (other.classification_metadata ?? other.metadata ?? {}) as Record<string, unknown>;
      const hay = (String(other.summary ?? "") + " " + JSON.stringify(om.per_gap_failure_lessons ?? om.failure_lessons ?? om.gap_lessons ?? "")).toLowerCase();
      if ((id.length > 8 && hay.includes(id)) || (cap.length > 3 && hay.includes(cap))) cited++;
    }
    return 1 + Math.min(1.0, 0.25 * cited);
  };
  // SIGN FIX + DEAD-FILTER FIX (2026-08-06). `* blockingWeight(g)` multiplied the score by
  // up to 1.6 for gaps whose metadata points at the picker/composer itself — the exact
  // OPPOSITE of the intent documented at the `bw > 1` branch of landabilityScore, which
  // already applies the intended -0.06 penalty. Net effect was +40% for self-targeting
  // gaps. And the map ran over `gaps`, so `scoredGaps` (hopeless-category rows escalated
  // and meant to be excluded) was computed and then discarded — the escalated gap was
  // selected anyway. When EVERY candidate is hopeless, return null so the caller emits its
  // documented graceful "no matching open gap" instead of selecting a gap the calibration
  // has already proven unlandable (and instead of ranked[0]! throwing on an empty array).
  if (!scoredGaps.length) return null;
  const selectionPool = scoredGaps;
  // A HUMAN'S REPORT OUTRANKS A MACHINE-GENERATED ROUTING RECORD.
  //
  // Nothing in the score distinguished who filed a gap, so a person's complaint about
  // the interface competed on equal terms with the substrate's own bookkeeping. Measured
  // today: 54 gaps tied at the identical top score of 0.9, the great majority of them
  // route-edit rows the routing path mints about itself. A reopened human complaint lost
  // that draw repeatedly and simply never got picked.
  //
  // Human input is the scarce signal here. The substrate can mint route-edit gaps
  // without limit and does; a person types a complaint once and it is the only evidence
  // of what they actually experience. Law 13 puts humans on the resolver side of this
  // system, not the preprocessor side — their reports are input to be acted on, and a
  // tie-break that ignores provenance quietly discards them.
  //
  // A 1.5x multiplier, not an override: it breaks ties and outranks equal-scored machine
  // rows, while a genuinely more landable or more blocking gap still wins on merit. This
  // does not make human gaps unconditionally first, and it must not — a syntax break
  // that wedges a vessel outranks a legibility complaint, and did so correctly today.
  const HUMAN_REPORT_PRIORITY = 1.5;
  // A LIVE HUMAN EXEMPTION COUNTS AS HUMAN ENDORSEMENT (2026-08-29). The bounded exemption granted
  // by escalation_disposition_apply bought immunity from the CATEGORY SEAL but nothing in
  // selection, so a gap the operator had just answered took one attempt and then lost the queue.
  // Measured: the lift-gate gap sat with 2 of its 3 exemption attempts UNSPENT and was picked ZERO
  // times in 25 minutes, while three competitors carrying failed_attempts of 122, 82 and 64 were
  // picked 8 times each — they were not winning on a reset penalty, they simply outranked it.
  //
  // An operator answering an escalation is the substrate's most expensive input: the one fact it
  // cannot derive for itself. Spending it on a single attempt and then stranding the remainder
  // wastes it, and leaves the seal's only designed escape opening onto a full room.
  //
  // A gap the operator has just ANSWERED is at least as human-endorsed as one the operator merely
  // REPORTED, so it earns the same 1.5x — a tie-breaker, not an override. Everything the comment
  // above says still holds: a genuinely more landable or more blocking gap still wins on merit.
  //
  // Self-limiting by construction: bumpFailedAttempts decrements the counter on every non-landing
  // attempt, so the preference expires after the three granted attempts and the gap returns to
  // ordinary ranking WITH ITS REAL HISTORY INTACT. Deliberately NOT done by zeroing
  // failed_attempts — that is the narrowing defect (a verbatim child with failed_attempts:0
  // outranking its own parent forever), which this store already carries a closed gap for.
  const hasLiveHumanExemption = (g: Record<string, unknown>): boolean => {
    const m = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    return Number(m.human_exemption_attempts_remaining ?? 0) > 0;
  };
  const humanWeight = (g: Record<string, unknown>): number =>
    String(g.source ?? "") === "human_reported" || hasLiveHumanExemption(g) ? HUMAN_REPORT_PRIORITY : 1;
  const ranked = selectionPool
    .map((g) => ({ g, s: landabilityScore(g) * impactOf(g) * humanWeight(g) }))
    .sort((a, b) => b.s - a.s);
  // A GAP THAT CANNOT BE COMPOSED MUST NOT CONSUME THE PICK (2026-08-28).
  //
  // The eligibility test ran only AFTER selection: the branches at `pickConditionCheck ===
  // 'pending'` (~2300) and `_pickCond === 'pending'` (~2501) correctly refuse to re-compose a
  // gap that landed once but is unmeasured — a second landing would manufacture the re-land the
  // close-oracle scores as a false close. But by then the pick was already spent, so the cycle
  // ended in a no-op and the next tick re-selected the same gap.
  //
  // Self-sustaining, because a skipped pick does no work and therefore records no failed
  // attempt: the score never decays, so the same gap wins again. Measured over 6h on
  // recommit-route-edit-9077062c-typecheck_dangling_reference-narrowed: 50 picks, 0 composes,
  // failed_attempts 0, landability 1.0, open since 2026-08-16 — roughly one wasted cycle every
  // 7 minutes. Over the same window seven eligible operator-filed gaps were never picked once.
  //
  // Filter on the SAME predicate the post-selection branches use. Do NOT filter on the stored
  // classification_metadata.disposition field: markPendingVerification writes it, but the
  // livelocked gap does not carry it (verified — disposition was null on that record while it
  // logged PENDING on every pick). 'pending' here is DERIVED at pick time by verifyGapCondition
  // from landed-commit provenance, so a disposition-based filter would have excluded ten
  // unrelated gaps and missed the one actually burning the slot.
  //
  // Walked lazily rather than applied pool-wide: verifyGapCondition -> landedCommitVerdict
  // spawns `git log --grep` per clone plus `git log -1` per matching sha, so evaluating all
  // ~330 pooled gaps every pick would be hundreds of subprocesses. Walking the ranked list
  // costs one evaluation per pending gap actually encountered, normally one or two.
  //
  // Only 'pending' is skipped. 'absent' must still be selected — the post-selection branch
  // closes those as already_resolved, which is real work, not a no-op.
  // Extracted as a pure function with an injected predicate so the skip is unit-testable
  // without a git checkout — the same reason computeNewlyFailing was extracted in the cutover
  // resolver. A selection change that only a diff-reader has inspected is the inert-landing
  // risk fc-coverage warns about: only a test actually runs it.
  const { chosen, skippedPending } = chooseFirstActionable(ranked, (g) => verifyGapCondition(g) === 'pending');
  const targetOf = (g: Record<string, unknown>): string =>
    String(((g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>).edit_site ?? "(no-target)");
  // TRACED SELECTION DECISION (law 12: record the counterfactual AT decision time). Without
  // this line a 90-way tie at one score over one target file is invisible at every
  // observation point, which is why the sign error above survived beside its own comment.
  console.log(`[gap-to-feature] pick ${JSON.stringify({
    gap_id: String(chosen.g.id ?? ""),
    category: String(chosen.g.category ?? ""),
    target: targetOf(chosen.g),
    score: Number(chosen.s.toFixed(4)),
    landability: Number(landabilityScore(chosen.g).toFixed(4)),
    human_reported: String(chosen.g.source ?? "") === "human_reported",
    impact: Number(impactOf(chosen.g).toFixed(4)),
    pool: selectionPool.length,
    hopeless_excluded: gaps.length - selectionPool.length,
    skipped_pending: skippedPending,
    tied_at_top: ranked.filter((r) => Math.abs(r.s - chosen.s) < 1e-9).length,
    distinct_targets_top20: new Set(ranked.slice(0, 20).map((r) => targetOf(r.g))).size,
    runner_up: ranked[1] ? { gap_id: String(ranked[1].g.id ?? ""), target: targetOf(ranked[1].g), score: Number(ranked[1].s.toFixed(4)) } : null,
  })}`);
  return chosen.g;
}

// ─────────────────── ACTIONABILITY ADMISSION GATE (auto-pick only, 2026-07-30) ───────────────────
// The autonomous loop's PROVEN-landable path is a gap that carries a CONCRETE edit target:
// EITHER (a) a metadata-cited EXISTING repos/<vessel>/src file, OR (b) a proposal report naming
// required_code_modifications[].file. The selection pool, however, gets FLOODED with candidates
// that can never land — they hollow every dispatch and starve the proven path:
//   • orphaned_capability / unreachable_producer gaps that demand a PRODUCER for a capability with
//     none. author_producer returns "zero producers" / "empty activities list", so once one has
//     failed to mint it is structurally un-provisionable — yet it keeps out-scoring real work and
//     re-selecting each tick (failed_attempts alone caps the penalty at 0.4 — not enough).
//   • PHANTOM typecheck gaps whose id/summary encode a TSxxxx at a vessel file that NO LONGER
//     errors (e.g. "…_goal_host_vessel_src_index_l619_ts2322_variant" while `bun run typecheck`
//     is EXIT=0 clean). The referenced defect is gone but the gap re-selects and re-drafts forever.
// This gate ADMITS a gap to the auto-pick set only when it is actionable, and RETIRES a typecheck
// gap whose error has already been fixed. Gaps are NOT deleted: an excluded orphan stays OPEN in the
// store, reachable by a targeted pointer.gap_id dispatch — it is only kept out of AUTO selection.
// CONSERVATIVE by design: the two structurally-unclosable classes above are the only HARD
// exclusions. A gap with genuinely-unknown actionability (a feature_compose-routed gap with no
// cited file/proposal) is LEFT ADMITTED — the downstream localizer (localizeGap) may still derive a
// site, and hard-excluding it here would regress the working grep-localized band.

const EXCLUDE_ORPHAN_AFTER_FAILS = 1; // an orphan/unreachable gap that already failed to mint = no producer
const TYPECHECK_CACHE_TTL_MS = parseInt(process.env.GAP_TYPECHECK_CACHE_TTL_MS ?? "300000", 10);
const TYPECHECK_MAX_RUNS_PER_PASS = parseInt(process.env.GAP_TYPECHECK_MAX_RUNS_PER_PASS ?? "3", 10);
const typecheckCleanCache = new Map<string, { clean: boolean; at: number }>();

/** (a) CHEAP: does the gap's metadata cite a concrete repos/<vessel>/src file that exists on disk? */
export function citedExistingFile(gap: Record<string, unknown>): string | null {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  for (const f of ["edit_site", "file_path", "change_site", "suspected_real_location"]) {
    const v = meta[f];
    if (typeof v !== "string" || !v.trim()) continue;
    let cand = v.trim().replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
    if (!/^repos\//.test(cand) && /^[^/]+\/(src|tests?)\//.test(cand)) cand = `repos/${cand}`;
    cand = cand.replace(/:[A-Za-z0-9_$]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(cand) && repoPathExists(cand)) return cand;
  }
  return null;
}

/** (b): the gap carries a proposal report naming required_code_modifications[].file that EXISTS. */
export function hasProposalReport(gapId: string): boolean {
  return existingEditTargets(gapId).length > 0;
}

/**
 * Parse a typecheck-class gap: one whose id/summary encodes a TSxxxx error at a specific vessel
 * source file (the phantom-churn shape). Returns { vessel, tsCode } when both a TS code and an
 * EXISTING vessel dir are derivable, else null (→ not a typecheck-class gap; no tsc run).
 */
export function typecheckClassOf(gap: Record<string, unknown>): { vessel: string; tsCode: string } | null {
  const id = String(gap.id ?? "");
  const summary = String(gap.summary ?? gap.title ?? "");
  const hay = `${id}\n${summary}`;
  // TSxxxx as a token — underscore-delimited ("_ts2322_") or spaced ("TS2322"); NOT inside a word
  // like "artifacts123". Underscore counts as a boundary here, so \b cannot be used.
  const tsm = hay.match(/(?:^|[^a-z0-9])ts[_\s-]?(\d{4})(?![0-9])/i);
  if (!tsm || !tsm[1]) return null;
  const tsCode = `TS${tsm[1]}`;
  let vessel: string | null = null;
  // underscore form embedded in the id: "…_typecheck_goal_host_vessel_src_index_l619_ts2322_variant".
  // Take the token run immediately BEFORE _src_ and walk suffixes so the LONGEST existing vessel dir
  // wins ("goal-host-vessel"), never a spurious superset ("typecheck-goal-host-vessel").
  const srcIdx = id.search(/_src[_/]/i);
  if (srcIdx > 0) {
    const parts = id.slice(0, srcIdx).split(/[_/]/).filter(Boolean);
    for (let start = 0; start < parts.length; start++) {
      const cand = parts.slice(start).join("-");
      if (/-(vessel|api)$/.test(cand) && vesselDirExists(cand)) { vessel = cand; break; }
    }
  }
  // repos/<vessel>/src path in id or summary
  if (!vessel) {
    const pm = hay.match(/repos\/([^/\s]+)\/src\//);
    if (pm && pm[1] && vesselDirExists(pm[1])) vessel = pm[1];
  }
  if (!vessel) {
    const iv = identifyVessel(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>);
    if (iv) vessel = iv;
  }
  if (!vessel) return null;
  return { vessel, tsCode };
}

export type TypecheckRunner = (vessel: string) => { ran: boolean; clean: boolean };
/** Default runner: `bun run typecheck` in the vessel's runtime dir. Bounded by a wall timeout. */
function defaultTypecheckRunner(vessel: string): { ran: boolean; clean: boolean } {
  try {
    const cwd = join(runtimeRoot(), vessel);
    if (!existsSync(join(cwd, "package.json"))) return { ran: false, clean: false };
    const res = Bun.spawnSync(["bun", "run", "typecheck"], { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    return { ran: true, clean: res.exitCode === 0 };
  } catch {
    return { ran: false, clean: false };
  }
}

export interface AdmissionResult {
  admitted: Record<string, unknown>[];
  excluded: Array<{ id: string; reason: string }>;
}

/**
 * Filter the AUTO-pick candidate set to actionable gaps. Excludes the two structurally-unclosable
 * classes (no-producer orphans, phantom typecheck-clean gaps) and RETIRES the phantom typecheck
 * gaps whose error is already fixed. See the block comment above for the full rationale. The
 * typecheckRunner is injectable for tests; the default shells `bun run typecheck` per vessel,
 * cached (TTL) and bounded (TYPECHECK_MAX_RUNS_PER_PASS) so tsc is never run per-gap.
 */
export async function admitActionableGaps(
  gaps: Record<string, unknown>[],
  opts?: { typecheckRunner?: TypecheckRunner },
): Promise<AdmissionResult> {
  const runner = opts?.typecheckRunner ?? defaultTypecheckRunner;
  const admitted: Record<string, unknown>[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  let tscRuns = 0;
  const passCache = new Map<string, boolean | null>(); // vessel -> clean? (this pass; null = unknown)
  const vesselTypecheckClean = (vessel: string): boolean | null => {
    if (passCache.has(vessel)) return passCache.get(vessel) ?? null;
    const now = Date.now();
    const cached = typecheckCleanCache.get(vessel);
    if (cached && now - cached.at < TYPECHECK_CACHE_TTL_MS) { passCache.set(vessel, cached.clean); return cached.clean; }
    if (tscRuns >= TYPECHECK_MAX_RUNS_PER_PASS) { passCache.set(vessel, null); return null; } // budget spent → unknown
    tscRuns++;
    const r = runner(vessel);
    if (!r.ran) { passCache.set(vessel, null); return null; }
    typecheckCleanCache.set(vessel, { clean: r.clean, at: now });
    passCache.set(vessel, r.clean);
    return r.clean;
  };

  for (const g of gaps) {
    const id = String(g.id ?? "");
    const cat = String(g.category ?? "");
    const meta = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    const failedAttempts = Number(meta.failed_attempts ?? 0);

    // (E2) PHANTOM TYPECHECK — retire when the referenced error is already gone.
    const tc = typecheckClassOf(g);
    if (tc) {
      const clean = vesselTypecheckClean(tc.vessel);
      if (clean === true) {
        excluded.push({ id, reason: `typecheck_clean_phantom(${tc.vessel}:${tc.tsCode})` });
        try {
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              id, category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at,
              classification_metadata: { ...meta, resolution: "already_resolved_typecheck_clean", closed_at: new Date().toISOString(), typecheck_verified_vessel: tc.vessel },
              status: "closed",
            },
          } as never);
        } catch { /* retire is best-effort; exclusion still holds */ }
        continue;
      }
      // clean === false (error still present) or null (unknown / over budget) → fall through:
      // a typecheck gap that still errors and cites a real file is genuinely actionable.
    }

    // (b) PROPOSAL-BACKED — the proven-landable path. ALWAYS admit (route unchanged).
    if (hasProposalReport(id)) { admitted.push(g); continue; }
    // (a) metadata cites a real EXISTING repos/<vessel>/src file.
    if (citedExistingFile(g)) { admitted.push(g); continue; }

    // (E1) ORPHAN / UNREACHABLE PRODUCER — no editable target; closes via author_producer /
    // reachability_gap_repair, not feature_compose. Admit a FRESH one for its single mint attempt,
    // but exclude once it has already failed to mint (structurally un-provisionable = "no producer")
    // or lacks the `shape` its route needs.
    const isOrphanClass = cat === "orphaned_capability" || cat === "unreachable_producer" || /orphaned[_-]capability/i.test(id);
    if (isOrphanClass) {
      const shape = String(meta.shape ?? "").trim();
      if (failedAttempts >= EXCLUDE_ORPHAN_AFTER_FAILS) { excluded.push({ id, reason: `orphan_no_producer(failed=${failedAttempts})` }); continue; }
      if (cat === "orphaned_capability" && !shape) { excluded.push({ id, reason: "orphan_missing_shape" }); continue; }
      admitted.push(g); // one auto-shot for a provisionable-looking orphan
      continue;
    }

    // UNKNOWN actionability (feature_compose-routed, no cited file/proposal) → keep existing
    // behavior (do NOT hard-exclude; the localizer may still derive a site downstream).
    admitted.push(g);
  }

  if (excluded.length) {
    const byReason: Record<string, number> = {};
    for (const e of excluded) { const k = e.reason.replace(/\(.*$/, ""); byReason[k] = (byReason[k] ?? 0) + 1; }
    console.log(`[gap-to-feature] auto-pick admission: ${gaps.length} candidates → ${admitted.length} admitted, ${excluded.length} excluded ${JSON.stringify(byReason)}`);
  }
  return { admitted, excluded };
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
function verifyGapCondition(gap: Record<string, unknown>): 'present' | 'absent' | 'pending' | 'unknown' {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): if this gap declares a Class-2
    // measurement predicate (evidence_resolve / verify_shape), the async sibling must run it —
    // do NOT let the sync landed-commit provenance short-circuit a measurable gap. Defer to async.
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
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
      const runtimePath = join(runtimeRoot(), editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // ── Class 3 (sync): landed commit — a substrate-authored commit referencing this gap id already exists ──
    const gapIdForLandedSync = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    // THIS IS THE SECOND COPY OF THE SAME CHECK IN THIS FUNCTION, and it runs FIRST.
    //
    // I fixed the copy ~100 lines below (018fd05, 81d8474) and never looked for another.
    // This one kept the original behaviour — every clone, no revert awareness — so it
    // returned 'absent' before the corrected copy was ever reached, and the gap kept
    // closing as already_resolved five seconds after every pick while I verified fix
    // after fix as "deployed and running". Duplicated logic means a fix applied to one
    // site is not a fix.
    //
    // Same two corrections as the other copy: scope to the vessel the gap names, since
    // only that repo's history can show the change landing (a commit elsewhere is
    // discussion — my own fix commit in development-vessel was closing this very gap);
    // and refuse a match that IS a revert or WAS reverted, since git is append-only and
    // undoing a change adds a commit rather than removing one.
    const landedSiteSync = typeof ((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'] === 'string'
      ? String(((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'])
      : '';
    // Class 3 centralized (2026-08-14): a single non-reverted landing => 'pending' (landed,
    // UNVERIFIED — provenance, not measurement), a RE-LAND (>=2) => 'present'. Only runs when the
    // gap has no measurement predicate (else the async measurer owns the verdict).
    if (gapIdForLandedSync.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      const verdict = landedCommitVerdict(gapIdForLandedSync, landedSiteSync);
      if (verdict !== null) return verdict;
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
async function verifyGapConditionAsync(gap: Record<string, unknown>): Promise<'present' | 'absent' | 'pending' | 'unknown'> {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): a Class-2 measurement predicate
    // (evidence_resolve / verify_shape) must be RUN before the Class-3 landed-commit provenance is
    // consulted. Previously Class 3 ran first and a gap with a real predicate closed on the commit
    // count without its predicate ever executing. When a predicate exists, skip provenance here and
    // let Class 2 below own the verdict (measured present/absent, or 'unknown'-abstain if unmeasurable).
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
    // ── Class 1: surgical (file + literal) ──────────────────────────────────
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      const runtimePath = join(runtimeRoot(), editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // ── Class 3: landed commit — provenance (single landing => 'pending', NOT measurement) ──
    // Only consulted when no Class-2 predicate exists (measurement-before-provenance, above).
    const gapIdForLanded = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    if (gapIdForLanded.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      // EVIDENCE MUST COME FROM THE REPO THE GAP IS ABOUT.
      //
      // This scanned EVERY clone, so a commit in an unrelated vessel that merely
      // MENTIONS the gap id counted as resolving it. The instance that exposed it is
      // hard to improve on: commit 018fd05 in development-vessel — whose message
      // explains that quoting a gap id is not evidence of a fix — became the false
      // evidence closing the very gap it was written about. My documentation resolved
      // the complaint it was documenting.
      //
      // A gap names its target through edit_site. Only that vessel's history can show
      // the change landing; a commit anywhere else is discussion, not resolution.
      const landedMeta = (gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>;
      const landedSiteRaw = typeof landedMeta['edit_site'] === 'string' ? String(landedMeta['edit_site']) : '';
      // Class 3 centralized (2026-08-14): a single non-reverted landing => 'absent'; a RE-LAND
      // (>=2 non-reverted commits) => 'present' — the referent persisted despite landing, so a
      // commit naming the gap is not proof it is fixed. Revert-awareness + vessel scoping live in
      // landedCommitVerdict (the prior inline copies' revert lessons are folded into it).
      const verdict = landedCommitVerdict(gapIdForLanded, landedSiteRaw);
      if (verdict !== null) return verdict;
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
    // fall through to landed-commit evidence class
  }
  // ── Class 3: landed-commit evidence (centralized 2026-08-14 — now revert- and re-land-aware) ──
  // This copy was previously unscoped and NOT revert-aware; routing it through
  // landedCommitVerdict strengthens it to match the other sites and closes the same hole.
  try {
    const gapId = typeof gap.id === 'string' ? gap.id : '';
    const editSite = typeof (gap.classification_metadata as Record<string, unknown> | undefined)?.['edit_site'] === 'string'
      ? String((gap.classification_metadata as Record<string, unknown>)['edit_site'])
      : '';
    const verdict = landedCommitVerdict(gapId, editSite);
    if (verdict !== null) return verdict;
  } catch {
    // fail open
  }
  return 'unknown';
}

/** Mark a gap closed once its fix genuinely landed on origin/dev. Best-effort, guarded. */
async function closeLandedGap(gap: Record<string, unknown>, land: LandSignal): Promise<{ closed: boolean; error?: string }> {
  try {
    // Outcome-verification (increment 2): use the async verifier which covers both
    // the surgical-class (file+literal) AND the resolver-behaviour class
    // (evidence_resolve / verify_shape). Fall back to the sync verifier result
    // only when the async path itself throws (belt-and-suspenders).
    let verifyResult: 'present' | 'absent' | 'pending' | 'unknown';
    try {
      verifyResult = await verifyGapConditionAsync(gap);
    } catch {
      verifyResult = verifyGapCondition(gap);
    }
    const gidV = String(gap.id ?? "");
    if (verifyResult === 'present') {
      // Defect still present — refuse close. If this 'present' is a RE-LAND (>=2 non-reverted
      // landings, none of which resolved it), the close-oracle is out of coverage: abstain ->
      // escalate to the human (§12.6 step 1) rather than leave it to re-compose inertly forever.
      const editSitePresent = gapEditSite(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) ?? "";
      if (landedCommitVerdict(gidV, editSitePresent) === 'present') {
        escalateRelandToHuman(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""));
      }
      return { closed: false, error: 'outcome_verification_failure: gap condition still present at close time' };
    }
    if (verifyResult === 'pending') {
      // SINGLE landing, unverified — provenance, not measurement. This is the inert-diff (bafd83d)
      // hole: a no-op diff typechecks, lands, and used to close green here. Abstain: hold PENDING
      // (do not close, do not re-compose) and ask the human. No false-close label — pending is not
      // yet a failure. If a measurement predicate later becomes available the sweep closes/refuses it.
      await markPendingVerification(gap, land.commit_sha ?? undefined, "landed once; awaiting outcome verification (no measurement predicate)");
      escalatePendingVerification(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""), land.commit_sha ?? undefined);
      return { closed: false, error: 'close-oracle abstains: single landing is provenance, not measured resolution — held pending verification' };
    }
    if (verifyResult === 'unknown' && !closeOracleEarnedTrust('landed_commit')) {
      // Unmeasured, and the landed-commit class has NOT earned fail-open trust (Beta(1,1) or a
      // poor track record never earns — trust is held closes, not assumed). Abstain: leave open for
      // the next tick rather than close on no evidence. No escalation — 'unknown' here is transient/
      // unmeasurable (e.g. clone not converged), distinct from 'pending' (which HAS a landing to verify).
      await markPendingVerification(gap, land.commit_sha ?? undefined, "unmeasured at close; landed-commit class has not earned fail-open trust");
      return { closed: false, error: 'close-oracle abstains: unmeasured close on a class without earned trust' };
    }
    // verifyResult === 'absent' (measured resolved) OR 'unknown' with EARNED trust: allow close.
    const id = gidV;
    if (!id) return { closed: false, error: "gap missing id" };
  if (typeof land.vessel==="string" && land.vessel.includes("development-vessel")) { await resolveSubstrateGapWrite({type:"substrateGap_write",gap:{id,category:gap.category,source:gap.source,summary:gap.summary,detected_at:gap.detected_at,classification_metadata:{...((gap['classification_metadata'] as Record<string,unknown>)??{}),pending_outcome_verification:land.commit_sha,pending_set_at:new Date().toISOString()},status:"open"}} as never); return {closed:false,error:"self-cutover: closure deferred to next-tick verification"}; }

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
    // Refuse on 'present' (still broken) AND 'pending' (single landing, unmeasured — provenance,
    // not resolution; the top-of-function gate already abstained on it, this is belt-and-suspenders).
    const conditionCheck = verifyGapCondition(gap);
    if (conditionCheck === 'present' || conditionCheck === 'pending') {
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
    // CLOSURE-CREDIT: reward the filing detector for gap closure (not just filing).
    // Best-effort — never throw; wrapped in its own try/catch.
    try {
      const detectorName: unknown = (gap as Record<string, unknown>).classification_metadata &&
        typeof (gap as Record<string, unknown>).classification_metadata === "object"
        ? ((gap as Record<string, unknown>).classification_metadata as Record<string, unknown>).detector
        : undefined;
      if (typeof detectorName === "string" && detectorName.length > 0) {
        const ledgerPath: string = process.env.DETECTOR_CLOSURE_LEDGER_PATH ?? "/workspace/detector-closure-credit.json";
        type LedgerEntry = { closures: number; last_closed_at: string };
        type Ledger = Record<string, LedgerEntry>;
        let ledger: Ledger = {};
        if (existsSync(ledgerPath)) {
          try {
            ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
          } catch {
            ledger = {};
          }
        }
        const existing: LedgerEntry | undefined = ledger[detectorName];
        ledger[detectorName] = {
          closures: (existing?.closures ?? 0) + 1,
          last_closed_at: new Date().toISOString(),
        };
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
      }
    } catch {
      // best-effort ledger write — never propagate
    }
    return { closed: true };
  } catch (e) {
    return { closed: false, error: (e as Error).message };
  }
}

// ── Pending-land verification sweep (land→close continuity) ──────────────────
// Self-cutover lands defer closure: closeLandedGap stamps
// classification_metadata.pending_outcome_verification = <landed SHA> and leaves the
// gap open, expecting a "next-tick verification" that never existed — so gaps with
// genuinely-landed commits stayed open and were picked and re-landed (observed on
// gap-transport-health-observer-reads-lying-signals-2026-07-29 and the
// service-failure-model-reality-audit duplicate re-lands). This sweep completes the
// deferred path: at gap_to_feature tick start (an EXISTING rhythm — no new timer),
// every open gap carrying a pending SHA is checked deterministically against the same
// in-container clones this file already reads; when the SHA is an ancestor of a
// clone's HEAD, the land is observable post-cutover and the gap flips to closed via
// substrateGap_write (shape-flow preserved) with closed_reason=landed_verified.
// Bounded like gap-lifecycle; best-effort; a still-'present' condition refuses close.
const PENDING_VERIFY_SWEEP_LIMIT = 25;
// Call-time (not module-load) so tests can point at a fixture clone tree; production
// never sets the override and uses the same path as the other clone readers here.
const vesselsCloneRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";

/** Deterministic land evidence: is `sha` an ancestor of HEAD in ANY vessel clone? */
function shaIsAncestorOfAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "merge-base", "--is-ancestor", sha, "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

/**
 * Has this landed commit been REVERTED since it landed?
 *
 * shaIsAncestorOfAnyClone cannot tell: `git revert` adds a NEW commit that undoes the
 * change and leaves the original in history, so the reverted sha stays an ancestor of
 * HEAD forever. The sweep's own comment claimed the ancestor check covered "the land
 * was reverted" — it never did.
 *
 * Measured 2026-08-07: ad706ce landed a wrong-region UI patch, was reverted in 1812ee7,
 * and the sweep still closed the gap as `landed_verified` on a commit whose change no
 * longer exists. A human's UI complaint was marked resolved with the code containing no
 * trace of it — and a closed gap is never re-routed, so it could never be retried. That
 * is worse than leaving it open: the store asserts a resolution that the tree denies.
 *
 * `git revert` writes "This reverts commit <full-sha>." into the message, so look for a
 * descendant carrying it. Cheap, and it only has to catch the mechanised case; a manual
 * undo that rewrites the change by hand is not detectable here and is not claimed to be.
 */
function shaWasRevertedInAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const full = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", sha], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (full.exitCode !== 0) continue;
      const fullSha = new TextDecoder().decode(full.stdout).trim();
      if (!fullSha) continue;
      // Match BOTH forms. `git revert` writes the trailer "This reverts commit <full-sha>."
      // but that message is routinely REWRITTEN — an operator amending the revert to
      // explain WHY drops the trailer entirely. That is not hypothetical: the revert this
      // detector was written for (1812ee7) says "This reverts ad706ce" in prose and
      // carries no trailer, so a trailer-only grep misses the exact case that motivated
      // it. I asserted I had verified against that pair and had not; the query returned
      // empty. Accept "reverts <sha>" with a 7+ hex prefix as well, which survives an
      // amended message, and search the SHORT sha too since prose uses it.
      const shortSha = fullSha.slice(0, 12);
      // Allow arbitrary words between "reverts" and the sha, not only an optional "commit ".
      // An operator amending the revert message ("Reverts substrate-authored commit <sha>")
      // inserts words the fixed `(commit )?` alternative cannot absorb, and the trailer-only
      // form is defeated the same way. Measured 2026-08-23 on route-edit-56849210.
      const pattern = `reverts (\\w+ ){0,4}(commit )?(${fullSha}|${shortSha}|${sha})`;
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "log", "-E", "--grep", pattern, "-i", "--format=%H", `${sha}..HEAD`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim().length > 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

/**
 * Landed-commit evidence for a gap, with RE-LAND awareness (§12.6, 2026-08-14).
 *
 * Class 3 previously returned 'absent' whenever ONE non-reverted substrate-authored commit
 * referenced the gap id (`git log --grep <gapId> -1`). That certifies closure on a
 * producer-authored string — the commit message names the gap — rather than on a measured
 * condition. Demonstrated hole: gap-env-gated-write-allowlist "closed" on bafd83d, an inert
 * rename (WRITE_ALLOWLIST -> WRITE_ALLOWLIST_ENV) that left process.env["WRITE_ALLOWLIST"]
 * and thus the env-gate intact — and that gap had already been re-detected and re-landed once
 * (69d680b at 05:39, then bafd83d at 07:34: two non-reverted commits reference it).
 *
 * The re-detection is the referent's persistence signal. Count non-reverted commits:
 *   0  -> null      (no landed evidence — caller falls through, unchanged)
 *   1  -> 'pending' (first landing — PROVENANCE, NOT MEASUREMENT. A commit naming the gap is
 *          proof a change LANDED, not proof it DID ANYTHING. This is exactly the inert-diff
 *          (bafd83d) hole: a syntactically-valid no-op typechecks, lands, and — when this
 *          returned 'absent' — closed the gap green while the condition it named still held.
 *          'pending' means "landed, unverified": the close-oracle abstains (out of coverage
 *          for provenance-only evidence), so the caller must NOT close and must NOT re-compose
 *          (a second landing would read as a re-land and manufacture the false-close the oracle
 *          is calibrated against). Only a MEASUREMENT predicate (Class 1 literal / Class 2
 *          resolver-behaviour) can return 'absent' = positively-observed resolved.)
 *   >=2 -> 'present' (landed, re-detected, re-landed => prior landing did not resolve the
 *          condition => refuse close; callers refuse close on 'present')
 *
 * Scoped to the gap's target vessel (from editSite): a mention elsewhere is discussion, not
 * evidence — the same rule the three former inline copies carried. Uses vesselsCloneRoot() so
 * it is testable against a fixture clone tree; the inline copies hardcoded the path and were
 * therefore untested. Replaces the duplicated Class-3 blocks the authors were burned by
 * ("a fix applied to one site is not a fix").
 */
export function landedCommitVerdict(gapId: string, editSite: string): 'pending' | 'present' | null {
  if (typeof gapId !== 'string' || gapId.length < 8) return null;
  const landedVessel = (typeof editSite === 'string' ? editSite : '').match(/^repos\/([^/]+)\//)?.[1] ?? '';
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return null; }
  let nonReverted = 0;
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, '.git'))) continue;
    if (landedVessel && cloneName !== landedVessel) continue;
    try {
      // ALL matching commits (no -1) so re-lands are countable, not just the most recent.
      const gitLog = Bun.spawnSync(['git', '-C', cloneDir, 'log', '--grep', gapId, '--fixed-strings', '--format=%H', '--since=14.days'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      const shas = gitLog.exitCode === 0 ? new TextDecoder().decode(gitLog.stdout).trim().split(/\s+/).filter(Boolean) : [];
      for (const sha of shas) {
        const subjRaw = Bun.spawnSync(['git', '-C', cloneDir, 'log', '-1', '--format=%s', sha], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
        const subj = subjRaw.exitCode === 0 ? new TextDecoder().decode(subjRaw.stdout).trim() : '';
        // Accept git's default subject `Revert "<subject>"` AND the conventional-commits
        // forms `revert(scope): ...` / `revert: ...`. The default-only test /^Revert[\s"']/i
        // missed a `revert(scope):` subject whose body named the gap id, so that revert was
        // counted as a SECOND landing and flipped the verdict to 'present' — closing the gap it
        // was reverting as already_resolved. Measured 2026-08-23 on route-edit-56849210; pinned
        // by gap-to-feature-reland-verdict.test.ts ("conventional-commits revert(scope):").
        if (/^Revert[\s"']/i.test(subj) || /^revert(\([^)]*\))?:/i.test(subj)) continue;      // the match IS a revert
        if (shaWasRevertedInAnyClone(sha)) continue;     // the match WAS reverted
        nonReverted += 1;
      }
    } catch { /* per-repo failure — continue */ }
  }
  if (nonReverted === 0) return null;
  if (nonReverted >= 2) return 'present';
  return 'pending';
}

// ── Close-oracle EARNED-TRUST gate (§12.6 step 1, 2026-08-14) ────────────────────────────────
// The fail-open direction — closing a gap on an UNMEASURED verdict ('unknown') — is permitted ONLY
// when the close-oracle has EARNED that trust for the evidence class: enough samples AND a
// reliability floor. This is the inverse of satisfierProvenBad (satisfier-pick.ts) and reuses its
// constants. CRITICAL: a fresh class at Beta(1,1) (zero evidence) must NOT earn fail-open — "trust
// assumed" is exactly what the program forbids; trust is earned by holding closes. landed_commit at
// {closes:0,false_closes:8} => 8 samples < floor and reliability 0.1 < 0.3 => never earns => abstains.
const CLOSE_ORACLE_TRUST_FLOOR = 0.7;   // a class must hold >=70% of its closes to fail-open on unknown
const CLOSE_ORACLE_MIN_SAMPLES = 10;    // and have >=10 graded closes; below this it has no earned trust
export function closeOracleEarnedTrust(evidenceClass: string): boolean {
  const r = closeOracleReliability(evidenceClass);
  const samples = r.closes + r.false_closes;
  return samples >= CLOSE_ORACLE_MIN_SAMPLES && r.reliability >= CLOSE_ORACLE_TRUST_FLOOR;
}

/**
 * Abstain -> escalate (§12.6 step 1, 2026-08-14). The close-oracle refuses to close a gap on a
 * RE-LAND (>=2 non-reverted landings, none of which resolved the condition) — it is OUT OF
 * COVERAGE: repeated landing without closure means the automated fix is inert or wrong. Unlike
 * the category-hopeless escalation (which keys on lands===0 and therefore never fires for a gap
 * that DOES land), this fires per-gap at the close-refusal point and asks the human. The
 * uiQuestion_write is the durable escalation record and, once answered, an operator-verdict
 * corpus entry that calibrates the oracle. Deduped via solicitedHumanGaps; fire-and-forget.
 */
function escalateRelandToHuman(gapId: string, category: string, summary: string): void {
  if (!gapId || solicitedHumanGaps.has(gapId)) return;
  solicitedHumanGaps.add(gapId);
  // A re-land is the retrospective FALSE-CLOSE label for the landed-commit class: grade the oracle.
  recordCloseVerdict("landed_commit", true);
  const rel = closeOracleReliability("landed_commit");
  const relNote = ` [close-oracle landed-commit reliability so far: ${(rel.reliability * 100).toFixed(0)}% (${rel.closes} closes, ${rel.false_closes} re-lands)]`;
  void resolveUiWritePassthrough({ type: "uiQuestion_write", id: "reland-needs-human-" + gapId, title: "Gap re-lands without closing — needs a human decision", body: "Gap " + gapId + " (" + category + ") has had multiple substrate-authored landings, none of which resolved its condition (the close-oracle abstains — out of coverage). The automated fix keeps landing an inert or wrong change. It likely needs a human: redefine the goal, supply the missing fact, grant access, or drop it. Summary: " + summary.slice(0, 300) + relNote, kind: "gap_reland_needs_human", importance: "high" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] reland uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] reland uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] reland uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

// Dedup for pending-verification escalations, separate from re-land dedup: a gap can escalate as
// 'pending' (one landing, unverified) and LATER as 're-land' (>=2 landings) — distinct signals.
const pendingVerificationEscalated = new Set<string>();

/**
 * Abstain on a SINGLE landing (§12.6 step 1, 2026-08-14). A single non-reverted commit naming the
 * gap is PROVENANCE (a change landed), not MEASUREMENT (the condition resolved) — the inert-diff
 * (bafd83d) hole. The close-oracle abstains: it neither closes (an inert diff would close green)
 * nor labels a false-close (pending is not yet a failure — the landing may be genuine). It asks the
 * human to confirm the landed change actually did the thing. Deduped; fire-and-forget. NOTE: unlike
 * escalateRelandToHuman this records NO close-verdict — a pending gap has not failed, so labelling it
 * would poison the posterior with a verdict reality has not yet delivered.
 */
function escalatePendingVerification(gapId: string, category: string, summary: string, sha?: string): void {
  if (!gapId || pendingVerificationEscalated.has(gapId)) return;
  pendingVerificationEscalated.add(gapId);
  const shaNote = sha ? ` (landed ${String(sha).slice(0, 12)})` : "";
  void resolveUiWritePassthrough({ type: "uiQuestion_write", id: "pending-verify-" + gapId, title: "Gap landed but is unverified — did the change actually fix it?", body: "Gap " + gapId + " (" + category + ") had a single substrate-authored landing" + shaNote + ", but the close-oracle has no way to MEASURE whether the change resolved the condition (no literal/resolver predicate — provenance only). Rather than close it green on the commit alone (the inert-diff hole), it is held PENDING. Please confirm: did the landed change actually fix this, or is it inert/wrong? Summary: " + summary.slice(0, 300), kind: "gap_pending_verification", importance: "medium" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] pending-verify uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] pending-verify uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] pending-verify uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

/**
 * Mark a gap PENDING-VERIFICATION: keep it open, stamp pending_outcome_verification (so the
 * sweep re-checks it) and disposition:'pending_verification' (so the PICKER skips re-composing it —
 * a second landing would read as a re-land and manufacture the false-close the oracle is calibrated
 * against). Best-effort; never throws into the caller.
 */
async function markPendingVerification(gap: Record<string, unknown>, sha: string | undefined, note: string): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at,
        classification_metadata: {
          ...meta0,
          pending_outcome_verification: sha ?? meta0['pending_outcome_verification'] ?? "unknown",
          pending_set_at: new Date().toISOString(),
          disposition: "pending_verification",
          pending_note: note,
        },
        status: "open",
      },
    } as never);
  } catch { /* best-effort */ }
}

export async function sweepPendingLandVerifications(): Promise<{ checked: number; closed: number }> {
  const out = { checked: 0, closed: 0 };
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      status: "open",
      limit: 1000,
      exclude_categories: [...DECISION_LOG_GAP_CATEGORIES],
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    const pending = gaps
      .filter((g) => {
        const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
        return typeof m.pending_outcome_verification === "string" && (m.pending_outcome_verification as string).length >= 7;
      })
      .slice(0, PENDING_VERIFY_SWEEP_LIMIT);
    for (const g of pending) {
      out.checked += 1;
      const meta = { ...((g.classification_metadata ?? {}) as Record<string, unknown>) };
      const sha = String(meta.pending_outcome_verification);
      // Not yet observable in a clone (pull-sync hasn't converged, or the land was
      // reverted) — leave open; the sweep retries on every tick.
      if (!shaIsAncestorOfAnyClone(sha)) continue;
      // A REVERTED land is not a land. The ancestor check above passes forever once the
      // commit exists, revert or not, so ask explicitly.
      if (shaWasRevertedInAnyClone(sha)) {
        console.warn(`[gap-sweep] gap ${String(g.id)} NOT closed: landed sha ${sha.slice(0, 12)} was REVERTED — the change is gone from HEAD, so the gap is unresolved and stays open for another attempt`);
        continue;
      }
      // Post-cutover: the async verifier CAN now observe the landed state. Close ONLY on a
      // positively-MEASURED 'absent' (a Class-1 literal or Class-2 resolver-behaviour predicate
      // observed the condition gone). Everything else abstains (§12.6 step 1):
      //   'present'  -> defect still there; a RE-LAND (>=2) is out of coverage -> escalate.
      //   'pending'  -> SINGLE landing, no measurement predicate: PROVENANCE, not resolution.
      //                 This is the inert-diff (bafd83d) hole — a no-op diff landed and used to
      //                 close green HERE. Hold pending, ask the human, do NOT close, do NOT
      //                 re-compose (disposition set so the picker skips it -> no manufactured re-land).
      //   'unknown'  -> unmeasured; close only if the landed-commit class has EARNED fail-open trust
      //                 (it never does on provenance alone -> abstain, retry next tick).
      const verdict = await verifyGapConditionAsync(g);
      const gidSweep = String(g.id ?? "");
      if (verdict === "present") {
        const editSitePresent = gapEditSite(g, (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>) ?? "";
        if (landedCommitVerdict(gidSweep, editSitePresent) === 'present') {
          escalateRelandToHuman(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""));
        }
        continue;
      }
      if (verdict === "pending") {
        await markPendingVerification(g, sha, "pending sweep: single landing, no measurement predicate");
        escalatePendingVerification(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""), sha);
        continue;
      }
      if (verdict === "unknown" && !closeOracleEarnedTrust("landed_commit")) {
        continue; // unmeasured and untrusted — leave open for the next tick
      }
      // verdict === 'absent' (MEASURED resolved) OR 'unknown' with earned trust -> close.
      joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: sha });
      // SUCCESS label for the close-oracle (§12.6 1a): a MEASURED close builds the trustworthy
      // "measured" class posterior. Provenance-only closes no longer happen here, so landed_commit
      // never accrues a fake success from a commit count — it earns trust only via human confirmation
      // (solicitation-outcome-scan) and loses it on re-lands. That asymmetry is deliberate.
      recordCloseVerdict("measured", false);
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: String(g.id),
          category: g.category,
          source: g.source,
          summary: g.summary,
          detected_at: g.detected_at,
          classification_metadata: {
            ...meta,
            closed_reason: "landed_verified",
            resolution: `landed via mitosis cutover ${sha} (verified ancestor of clone HEAD)`,
            closed_at: new Date().toISOString(),
          },
          status: "closed",
        },
      } as never);
      updateCalibration(String(g.category ?? "unknown"), true);
      out.closed += 1;
    }
  } catch { /* sweep is best-effort — never block the tick */ }
  return out;
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

// ── Close-oracle posterior (§12.6 step 1(a), 2026-08-14) ────────────────────────────────
// The close-oracle is graded like any other activity: its per-evidence-class reliability accrues
// from ground truth, so its trust is EARNED, not assumed. A single-landing close via the
// landed-commit class is a provisional SUCCESS; a later RE-LAND on that class is the retrospective
// FALSE-CLOSE label (the prior close did not hold — reality re-detected the gap). Both labels are
// recorded at the close/refuse decision points, so the posterior is calibrated against the
// UN-AUTHORABLE REFERENT (re-detection) without instrumenting the re-open path. Per class the
// posterior is Beta(closes_that_held + 1, false_closes + 1); closeOracleReliability reads its mean.
// One label per gap (the callers dedup), so a single thrashing gap cannot dominate the posterior.
// Call-time (not module-load) so tests can point at a fixture file; production never sets it.
const closeOracleCalibPath = (): string => process.env["CLOSE_ORACLE_CALIB_PATH"] ?? "/workspace/close-oracle-calibration.json";
type CloseOracleCalib = Record<string, { closes: number; false_closes: number; operator_engaged?: number }>;
function readCloseOracleCalib(): CloseOracleCalib {
  try { const p = closeOracleCalibPath(); return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CloseOracleCalib) : {}; }
  catch { return {}; }
}
function recordCloseVerdict(evidenceClass: string, falseClose: boolean): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    if (falseClose) rec.false_closes += 1; else rec.closes += 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
// Operator-verdict-corpus calibration (§12.6 step 1b): when a HUMAN answers a re-land escalation
// (read back via solicitation_outcome_scan over obsidian interaction episodes), that engagement is
// an operator verdict corroborating the abstain — the oracle calibrating against the operator
// corpus, not just against reality's re-detection. Tracked honestly as engagement (met/unmet), not
// folded into the reliability posterior as a fake polar verdict, since met/unmet carries no polarity.
export function recordOperatorEngagement(evidenceClass: string): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    rec.operator_engaged = (rec.operator_engaged ?? 0) + 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
/** Beta-mean reliability of the close-oracle at an evidence class: P(a close of this class holds). */
export function closeOracleReliability(evidenceClass: string): { alpha: number; beta: number; reliability: number; closes: number; false_closes: number; operator_engaged: number } {
  const rec = readCloseOracleCalib()[evidenceClass || "unknown"] ?? { closes: 0, false_closes: 0 };
  const held = Math.max(0, rec.closes - rec.false_closes); // closes that did NOT later re-land
  const alpha = held + 1;                                  // Beta(1,1) prior
  const beta = rec.false_closes + 1;
  return { alpha, beta, reliability: alpha / (alpha + beta), closes: rec.closes, false_closes: rec.false_closes, operator_engaged: rec.operator_engaged ?? 0 };
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

/**
 * A compose that never RAN is not a compose that FAILED.
 *
 * feature-compose returns `verdict: "BUSY"` / `stage: "capacity"` when the slot cap is
 * hit, and its own comment marks the distinction as load-bearing: "BUSY, not REFUSED.
 * Capacity is TRANSIENT — the work is fine, the host is full — whereas REFUSED means
 * this should not be done." goal-host honours it (backs off 45s and retries). This file
 * did not: the word BUSY appeared nowhere in it, so a capacity refusal fell through as
 * a plain `ok:false` into bumpFailedAttempts, which BOTH decays the gap's score and
 * calls updateCalibration(category, false). Since hopeless() excludes a category at
 * attempts >= 8 with lands === 0, a run of capacity refusals could seal an ENTIRE
 * CATEGORY without a single compose ever having run — a non-attempt recorded as a
 * failed attempt.
 *
 * Measured 2026-08-29: `reach_grounding_gap` went from absent (attempts 0) to
 * attempts=5 / lands=0 in ~6h on refusals alone, three short of sealing, while five
 * gaps sat at failed_attempts=2 with `approach_decisions[].outcome.joined_at` within
 * 200-800ms of the pick — orders of magnitude too fast for a compose to have run.
 *
 * `environment` was already excluded at the main call site for exactly this reason;
 * capacity is the same class, so both live here and every call site asks one question.
 */
export function isNonAttemptComposeResult(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  if (String(cb.failure_kind ?? "") === "environment") return true;
  if (String(cb.verdict ?? "") === "BUSY") return true;
  if (String(cb.stage ?? "") === "capacity") return true;
  return false;
}

/**
 * The same principle, applied to SELECTION rather than to credit.
 *
 * `isNonAttemptComposeResult` above already keeps a compose that never ran out of
 * `failed_attempts` and out of the category calibration. The compose COOLDOWN was never
 * given the same treatment, and that asymmetry is the bug: the stamp is written at
 * PICK-START (`gapComposeLastAttemptAt.set` below, before feature_compose is called, so it
 * "covers the whole compose wall time"), and nothing clears it when the compose comes back
 * BUSY. So a capacity refusal — work the host declined to start — cost the gap a full
 * GAP_COMPOSE_COOLDOWN_MS of exclusion from the auto-pick candidate set.
 *
 * Measured 2026-08-29: the autonomous lane holds exactly one slot
 * (`compose-slots.ts` `effectiveCap = max(1, cap - 1)`, one reserved for directed work) and
 * composes run for minutes, so most autonomous picks return BUSY. One gap was picked at
 * 19:26:31.9 / 19:31:46.5 / 19:36:52.6 / 19:41:56.7 / 19:47:01.5 — deltas of 5:14.6, 5:06.1,
 * 5:04.1, 5:04.8, i.e. cooldown-limited to the second rather than tick-limited — and every
 * one of those picks logged `verdict=BUSY stage=capacity`. Zero composes ran. Meanwhile the
 * picker walked the ranked backlog cooling one gap after another that had never been tried,
 * so the highest-priority gap was repeatedly selected, repeatedly refused for capacity, and
 * repeatedly penalised in selection for a refusal it did not cause.
 *
 * Takes the map as a parameter so the behaviour is unit-testable without a live pool — the
 * same reason `chooseFirstActionable` was extracted with an injected predicate. Returns
 * whether a stamp was actually rewritten, so a caller (or a test) can assert the effect
 * rather than infer it.
 *
 * DELIBERATELY NOT DONE HERE: nothing touches `failed_attempts` or `updateCalibration`. That
 * accounting is already correct for a non-attempt and must stay untouched — this only
 * restores eligibility.
 *
 * REQUEUE, NOT RELEASE (2026-08-30). The first version of this DELETED the stamp, making the
 * gap instantly re-eligible. That over-corrected: this map is not only a penalty, it is the
 * ONLY rotation pressure in the picker (`eligible` filters on it at the auto-pick site), and
 * the autonomous lane holds exactly one slot, so BUSY is the majority outcome — 45 of ~80
 * composes (56%) in a 4h window measured by the compose-lane-capacity gap. Releasing on the
 * majority path therefore removes rotation pressure: the top-ranked gap is refused,
 * immediately re-admitted, and re-picked.
 *
 * MEASURED CONCENTRATION, corrected 2026-08-30. An earlier version of this note claimed 88%
 * (73 of 83 picks). That was WRONG — it counted each pick line's `runner_up.gap_id` as a
 * second pick, roughly doubling the top-gap tally. Counting only the primary gap_id, the
 * real trend over 2026-08-30 04:00-07:00 is a steady narrowing rather than a monopoly:
 *
 *     hour    picks   distinct gaps   top-gap share
 *     04:00     114        13              16%
 *     05:00     115        14              13%
 *     06:00     114        12              21%
 *     07:00      89         9              35%
 *
 * Distinct gaps per hour falling 13 -> 9 while the top share rises 16% -> 35% is the signal
 * this change targets. It is a real degradation and worth fixing; it is NOT the 88% monopoly
 * first reported, and the fix should be judged against these numbers.
 *
 * Both extremes starve the backlog, in opposite directions:
 *   - full cooldown on BUSY  → cools gaps that were never tried (the bug this function fixed)
 *   - no cooldown on BUSY    → the highest-ranked gap monopolises every tick
 * So a non-attempt costs a SHORT requeue instead: long enough for the picker to advance to
 * the next candidate, far short of penalising the gap for work the host declined to start.
 * REQUEUE_MS matches the 45s backoff goal-host already applies to a BUSY verdict, so the two
 * lanes wait the same amount for the same signal.
 */
export const GAP_BUSY_REQUEUE_MS = 45_000;

export function requeueAfterNonAttempt(
  stamps: Map<string, number>,
  gapId: string,
  cb: Record<string, unknown> | null | undefined,
  opts: { nowMs?: number; cooldownMs?: number; requeueMs?: number } = {},
): boolean {
  if (!isNonAttemptComposeResult(cb)) return false;
  if (!gapId) return false;
  if (!stamps.has(gapId)) return false;
  const now = opts.nowMs ?? Date.now();
  const cooldown = opts.cooldownMs ?? GAP_COMPOSE_COOLDOWN_MS;
  const requeue = opts.requeueMs ?? GAP_BUSY_REQUEUE_MS;
  // Backdate the stamp so the remaining exclusion is `requeue`, not the full cooldown. A
  // requeue >= cooldown must never EXTEND the exclusion, hence the clamp at 0.
  stamps.set(gapId, now - Math.max(0, cooldown - requeue));
  return true;
}

// Decide whether a chronically-failing gap should be narrowed into a fresh child.
//
// Only narrow a ROOT gap; an already-narrowed child (parent_gap_id set) must not spawn
// grandchildren, else chronic failure produces an unbounded -narrowed-narrowed chain.
// A recommit- gap (feature-compose.ts's own retry-cap mechanism) records its lineage as
// re_commit/source_gap_id, never parent_gap_id, so without this check it looks like a
// root to THIS guard and gets narrowed too — then, if the narrowed result fails compose
// again, feature-compose wraps it in another recommit- layer (which again omits
// parent_gap_id), making it eligible for narrowing all over again. Each narrowing resets
// failed_attempts to 0 (and with it landability back to 1.0), so the two caps alternate
// forever instead of either ever holding — confirmed via the recommit-*-syntax_break-
// -narrowed chain measured on 2026-08-07 (id: route-edit-2206dec0:1's lineage).
export function shouldNarrowForChronicFailure(failedAttempts: number, meta: Record<string, unknown>): boolean {
  return failedAttempts >= 3 && !meta.parent_gap_id && !meta.re_commit && !meta.source_gap_id;
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
    // SPEND THE HUMAN-AUTHORIZED EXEMPTION (2026-08-28). The exemption granted by
    // escalation_disposition_apply is BOUNDED, and this is the only place the bound can
    // bind: a non-landing attempt consumes one. Without this decrement "bounded" would be
    // a word in a comment — the gap would re-enter selection forever on one human answer
    // and re-open the flood 143212a deliberately closed. At zero the seal applies again
    // and the gap re-escalates, which is the correct end state: the human's answer was
    // tried, it did not land, and the human should be asked again rather than the loop
    // grinding on it.
    const exRem = Number(meta0.human_exemption_attempts_remaining ?? 0);
    const exemptionPatch = exRem > 0
      ? { human_exemption_attempts_remaining: exRem - 1, human_exemption_spent_at: new Date().toISOString() }
      : {};
    const meta = { ...meta0, ...exemptionPatch, failed_attempts: fa, last_failed_at: new Date().toISOString(), mispredicted_lands: mis, last_predicted_p: opts.predictedP ?? meta0.last_predicted_p };
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
    const willExceedThreshold = shouldNarrowForChronicFailure(fa, meta0);
    if (willExceedThreshold) {
      try {
        const parentId: string = id;
        const parentSummary = String(gap.summary ?? gap.title ?? "");
        const childMeta = { ...meta, failed_attempts: 0, parent_gap_id: parentId, narrowed_at: new Date().toISOString() };
        const childRecord: Record<string, unknown> = {
          // Deterministic id so re-narrowing the SAME parent upserts one idempotent child
          // (gapClassKey has no volatile token to strip here) instead of throwing on a
          // missing id or spawning a new row every failure.
          id: `${parentId}-narrowed`,
          category: gap.category,
          source: gap.source,
          summary: `[narrowed from ${parentId}] ${parentSummary.replace(/^\[narrowed from [\w:.!-]+\]\s*/g, "")}`,
          detected_at: gap.detected_at,
          classification_metadata: childMeta,
          status: "open",
        };
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: childRecord as never });
        const childId = String((childRecord as Record<string,unknown>).id ?? "");
        console.log(`[gap-to-feature] emitted narrowed child gap for chronically-stuck gap ${parentId}: ${childId}`);
        void fetch(GOAL_HOST_VESSEL_ENDPOINT + "/run-goal", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: "ApiKey " + METABOB_API_KEY } : {}) },
          body: JSON.stringify({
            goal: "investigate and decompose gap " + parentId + ": " + parentSummary.replace(/^(?:Close substrate gap [\w:.!-]+:\s*)+/, "").replace(/^(?:investigate and decompose (?:gap|goal)[:\s]+(?:[\w:.!-]+[:\s]+)?)+/i, "").slice(0, 400),
            tags: ["escalated_from:" + parentId],
          }),
        }).catch(() => { });
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
      body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: 2200 }),
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
  const targetVessel = typeof meta.target_vessel === "string" ? meta.target_vessel.trim() : "";
  // Validate target_vessel against the runtime root (module-level vesselDirExists, absolute
  // path); fall back to development-vessel when the named vessel does not exist.
  const vessel = targetVessel && vesselDirExists(targetVessel) ? targetVessel : "development-vessel";
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
  if (pickConditionCheck === 'pending') {
    // A single non-reverted landing already exists for this gap (provenance), but the close-oracle
    // cannot MEASURE that it resolved the condition. Do NOT re-compose: a second landing would read
    // as a re-land and manufacture the false-close the oracle is calibrated against (§12.6 step 1).
    // The pending-verify sweep + human escalation own this gap now; skip composing.
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} PENDING verification at pick time (landed once, unmeasured) — skipping re-compose to avoid a manufactured re-land`);
    return { shape: "gapToFeatureReport", body: { ok: true, gap_id: gap.id, gap_category: gap.category, verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" } };
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
  } else if (!isNonAttemptComposeResult(cb)) {
    // A capacity refusal here is a retry, not a failure — see isNonAttemptComposeResult.
    await bumpFailedAttempts(gap);
  }
  // ...and a retry must be RETRYABLE: release the cooldown the pick stamped, or the "retry"
  // is a five-minute exclusion for a compose that never ran.
  requeueAfterNonAttempt(gapComposeLastAttemptAt, String(gap.id ?? ""), cb);
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
  // 0. Land→close continuity: complete deferred self-cutover closures BEFORE selection,
  // so an already-landed gap cannot be re-picked and re-landed. Cheap, bounded, best-effort.
  try { await sweepPendingLandVerifications(); } catch { /* never block the tick */ }
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
    // Exclude gaps composed within the cooldown from AUTO-pick (per-candidate filter, exactly
    // boredom's cooling-candidate skip) so the picker advances to the next-landable gap. Targeted
    // picks (pointer.gap_id) BYPASS — the caller explicitly chose this gap (same carve-out as the
    // goal-host coalesce skipping requeues, and boredom not throttling explicit requests).
    const nowMs = Date.now();
    const eligible = gaps.filter((g) => nowMs - (gapComposeLastAttemptAt.get(String(g.id ?? "")) ?? 0) >= GAP_COMPOSE_COOLDOWN_MS);
    if (pointer.gap_id) {
      // Targeted dispatch BYPASSES the admission gate — the caller explicitly chose this gap
      // (same carve-out as the cooldown filter and boredom not throttling explicit requests).
      gap = gaps.find((g) => g.id === pointer.gap_id) ?? gaps[0] ?? null;
    } else {
      // ACTIONABILITY ADMISSION (auto-pick only): keep structurally-unclosable candidates
      // (no-producer orphans; phantom typecheck gaps whose error is already fixed) OUT of the
      // auto-pick set so they stop hollowing dispatches and starving the proven-landable path.
      const { admitted } = await admitActionableGaps(eligible);
      // Empty admitted (whole pool non-actionable — the common all-orphan case) → null,
      // which flows to the graceful "no matching open gap" path, not pickMostLandable([])'s throw.
      gap = admitted.length ? pickMostLandable(admitted) : null;
    }
  } catch (e) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: (e as Error).message } };
  }
  if (!gap) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: "no matching open gap", category: pointer.category ?? null } };
  }
  // Stamp the cooldown at pick-start (covers the whole compose wall time), auto-picks only —
  // a targeted pointer.gap_id must be re-runnable on demand. Mirrors boredom's set-after-select.
  if (!pointer.gap_id && gap.id) gapComposeLastAttemptAt.set(String(gap.id), Date.now());
  await recordApproachDecision(gap);
  // SURPRISE-ROUTED EXPLORE/EXPLOIT (2026-07-09): when-to-work-on-what is a measured
  // policy, not a habit. Low-confidence picks are NOT composed on a guess — they route
  // to investigation first. A high-confidence MISS (predicted land >= 0.7 but the last
  // attempt did not land) means the self-model's mapping is wrong — investigate before
  // recommitting. Calibrated confidence exploits (compose as usual). Targeted
  // dispatches (pointer.gap_id) bypass routing: the caller explicitly chose this gap.
  if (!pointer.gap_id) {
    try {
      const predR = predictLand(gap);
      const mR = (gap.classification_metadata ?? {}) as Record<string, unknown>;
      const decs = Array.isArray(mR.approach_decisions) ? mR.approach_decisions as Array<Record<string, unknown>> : [];
      const last = decs.length ? decs[decs.length - 1] : undefined;
      const lastOutcome = last ? last.outcome as Record<string, unknown> | undefined : undefined;
      const highConfMiss = !!(last && Number(last.predicted_p ?? 0) >= 0.7 && lastOutcome && lastOutcome.landed === false);
      const lowConf = predR.p < 0.35;
      const alreadyInvestigated = mR.investigated_at !== undefined;
      if ((lowConf || highConfMiss) && !alreadyInvestigated) {
        const reason = highConfMiss ? "high_confidence_miss" : "low_confidence_pick";
        await resolveDispatchGoal({ type: "dispatch_goal", goal: "investigate gap " + String(gap.id) + " before composing (" + reason + ", predicted_p=" + predR.p.toFixed(2) + "): " + String(gap.summary ?? "").slice(0, 240) } as never);
        const invMeta = { ...mR, investigated_at: new Date().toISOString(), investigation_reason: reason, last_predicted_p: predR.p };
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...gap, classification_metadata: invMeta, status: String(gap.status ?? "open") } } as never);
        return { shape: "gapToFeatureReport", body: { ok: true, stage: "route", routed: "investigation", gap_id: gap.id, reason, predicted_p: predR.p } };
      }
    } catch { /* routing is best-effort; fall through to compose */ }
  }

  // RECOMMIT SOURCE-GAP LOCALIZATION (gap recommit-composer-mislocalized-edit-site):
  // A re_commit gap's id (e.g. "recommit-route-edit-535ee072-verify_failed") should be treated as a new gap for lineage tracking
  // repo/vessel path; deriving the edit_site from it mis-localizes to a non-existent
  // repos/<gap-id>/ (ENOENT, failure_class mis_localized_path). The real edit site lives
  // on the SOURCE gap named in classification_metadata.source_gap_id. Fetch that source
  // gap and inherit its edit_site (and file_path/change_site/suspected_real_location) so
  // localizeGap below targets the actual file, not the recommit id. Best-effort.
  {
    const rcMeta = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const sourceGapId = typeof rcMeta.source_gap_id === "string" ? rcMeta.source_gap_id : "";
    const hasOwnSite = !!(rcMeta.edit_site || rcMeta.file_path || rcMeta.change_site || rcMeta.suspected_real_location);
    if (sourceGapId && !hasOwnSite) {
      try {
        const srcRead = await resolveSubstrateGap({ type: "substrateGap", id: sourceGapId, limit: 1 } as never);
        const srcGaps = ((srcRead?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
        const src = srcGaps.find((g) => g.id === sourceGapId) ?? srcGaps[0];
        const srcMeta = (src?.classification_metadata ?? {}) as Record<string, unknown>;
        for (const f of ["edit_site", "file_path", "change_site", "suspected_real_location"] as const) {
          if (!rcMeta[f] && typeof srcMeta[f] === "string" && srcMeta[f]) rcMeta[f] = srcMeta[f];
        }
        gap.classification_metadata = rcMeta;
      } catch { /* best-effort: fall through to normal localization */ }
    }
  }

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
  if (_pickCond === 'pending') {
    // Landed once but unmeasured — do NOT re-compose (a second landing manufactures a re-land the
    // close-oracle would score as a false-close). The sweep + human escalation own it. (§12.6 step 1)
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} PENDING verification at pick time — skipping re-compose`);
    return {
      shape: "gapToFeatureReport",
      body: { ok: true, gap_id: gap.id as string, gap_category: gap.category as string, verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" },
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
    const _quotedMatch = mcSummary.match(/"([^"]+)"/);
    const _metaShape = typeof (gap as Record<string, unknown>).classification_metadata === "object" && (gap as Record<string, unknown>).classification_metadata !== null
      ? ((gap as Record<string, unknown>).classification_metadata as Record<string, unknown>).shape as string | undefined
      : undefined;
    const candidateShape: string = (_quotedMatch?.[1]) ?? (_metaShape ?? "") ?? (mcSummary.match(/[a-z][a-z0-9_:-]{2,}/)?.[0] ?? "");
    const mcCandidateShape = candidateShape || undefined;
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

  // 1a0. TRACE-STORE-RECONCILIATION gaps dispatch the seeded
  // development-vessel:trace-store-reconcile activity via goal-host, NOT
  // feature_compose (2026-07-08, openspec
  // 2026-07-08-substrate-self-managed-db-reconciliation). This is an
  // operational DB-maintenance swap (acquire lease -> db_admin
  // reconcile_trace_store -> verify -> release lease), not a code change —
  // feature_compose's typecheck-verify gate has nothing to typecheck here.
  // Dispatching by targetTemplateId (rather than freeform goal text) pins the
  // exact activity so goal-host's shape-graph walk doesn't have to infer it,
  // and the reach-gate still produces an honest `reached` verdict for the
  // learning loop (canonical loop: run_goal -> goal_status -> goal_reasoning
  // -> provide_feedback).
  if (String(gap.category ?? "") === "trace_store_reconciliation") {
    if (pointer.dry_run) {
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: true,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          dry_run: true,
          plan: "POST goal-host /run-goal targetTemplateId=development-vessel:trace-store-reconcile",
        },
      };
    }
    try {
      const auth: Record<string, string> = METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {};
      const res = await fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/run-goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          goal: "reconcile the trace store back under its configured cap",
          targetTemplateId: "development-vessel:trace-store-reconcile",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => "");
      const dispatched = res.ok;
      if (dispatched) {
        // Mark dispatched (classification_metadata only; status stays "open"
        // — the trace-store-health-observer stops re-emitting once row_count
        // drops back under cap, and gap-lifecycle-tick auto-closes stale
        // non-reproducing gaps; this resolver does not assert the swap
        // succeeded, only that it was handed off).
        try {
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              id: String(gap.id ?? ""),
              category: gap.category,
              source: gap.source,
              summary: gap.summary,
              detected_at: gap.detected_at,
              classification_metadata: {
                ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>),
                dispatched_at: new Date().toISOString(),
                dispatch_route: "trace-store-reconcile",
              },
              status: "open",
            },
          } as never);
        } catch {
          /* best-effort marker write */
        }
      } else {
        await bumpFailedAttempts(gap);
      }
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: dispatched,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          dispatch_status: res.status,
          dispatch_detail: text.slice(0, 300),
        },
      };
    } catch (e) {
      await bumpFailedAttempts(gap);
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: false,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          error: e instanceof Error ? e.message : String(e),
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
    // doc_drift_fix records its own failure bookkeeping (doc_fix status + failed_attempts);
    // re-upserting from the stale pre-run gap object here clobbered that write (lost update).
    return resolveDocDriftFix({ type: "doc_drift_fix", gap_id: String(gap.id ?? ""), dry_run: pointer.dry_run });
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
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        status: gap.status,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          localized: true,
          localized_at: new Date().toISOString(),
        },
      },
    });
    }
  }
  if (editTargets.length === 0) {
    const gapId = String(gap.id ?? "");
    console.log("[gap-to-feature] no existing edit targets found for gap", gapId, "— composer will scaffold new file");
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        status: gap.status,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          localization_failed: true,
          localization_failed_at: new Date().toISOString(),
        },
      },
    });
    await resolveUiWritePassthrough({
      type: "uiQuestion_write",
      id: "needs-localization-" + gapId,
      title: "Gap needs a change-site",
      body: "Localization failed for gap " + gapId + ": name the concrete repos/<vessel>/src file this gap should change, or say it is out of code reach. Summary: " + String(gap.summary ?? "").slice(0, 300),
      kind: "gap_needs_localization",
      importance: "medium",
    });
    void fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      body: JSON.stringify({ type: "substrateGap", filter: { id: gapId } }),
    }).catch((e: unknown) => {
      console.warn("[gap-to-feature] escalation fetch failed:", e instanceof Error ? e.message : String(e));
    });
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
    const priorSliceFlow: string[] = [];
    let lastBody: Record<string, unknown> | null = null;
    for (const s of slices) {
      const sliceCompose = await resolveFeatureCompose({
        type: "feature_compose",
        spec: spec + "\n" + `CAPACITY SLICE: this dispatch must touch ONLY the file ${s.file}; other slices are handled in separate dispatches.` + (s.hint ? ` Context: ${s.hint}` : "") + (priorSliceFlow.length ? "\nPRIOR SLICES ALREADY LANDED in this same gap (build on them, they are in the tree now, do not redo or contradict them): " + priorSliceFlow.join("; ") : ""),
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
      if (lastBody.verdict === "FAVORABLE") { priorSliceFlow.push(s.file + " landed" + (typeof lastBody.commit_sha === "string" ? " (commit " + lastBody.commit_sha + ")" : "") + (typeof lastBody.summary === "string" ? ": " + String(lastBody.summary).slice(0, 120) : "")); }
      if (lastBody.verdict !== "FAVORABLE") break;
    }
    const allOk = sliceResults.length === slices.length && sliceResults.every((r) => r.verdict === "FAVORABLE");
    if (allOk && lastBody) {
      const sliceLand = genuineLandSignal(lastBody, !(pointer.dry_run ?? false));
      if (sliceLand.landed) await closeLandedGap(gap, sliceLand);
    }
    // A slice sequence cut short by a capacity refusal never got its attempt either.
    if (!allOk && !pointer.dry_run && !isNonAttemptComposeResult(lastBody)) await bumpFailedAttempts(gap);
    // ...so it must not serve the cooldown either. Same reasoning as the credit exemption above.
    requeueAfterNonAttempt(gapComposeLastAttemptAt, String(gap.id ?? ""), lastBody);
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
    if (isNonAttemptComposeResult(cb)) {
      // Credit was already exempt here; SELECTION was not. Release the pick-start cooldown
      // stamp so the gap is re-pickable after a SHORT requeue instead of sitting out five
      // minutes for a compose the host never started — and instead of being re-pickable
      // instantly, which handed the top-ranked gap 88% of picks (see requeueAfterNonAttempt).
      const cooled = requeueAfterNonAttempt(gapComposeLastAttemptAt, String(gap.id ?? ""), cb);
      console.log("[gap-to-feature] non-attempt (failure_kind=" + String(cb.failure_kind ?? "-") + " verdict=" + String(cb.verdict ?? "-") + " stage=" + String(cb.stage ?? "-") + ") — gap credit not bumped, category calibration untouched, cooldown " + (cooled ? "released" : "not held"));
    } else {
      const pred = predictLand(gap);
      // Bounded one-shot patch_with_tools escalation on an APPLY failure (anchor_not_found /
      // localization miss — ~40% of autonomous compose failures). feature_compose already rolled
      // back on applyFailed (nothing to double-land); pwt reads-then-edits the target agentically
      // where blind-draft could not match old_string. One-shot PER GAP LINEAGE via pwt_escalated
      // (no cross-tick loop); fires ONLY on apply_failed (never on semantic/verify rejects); any
      // error or non-land falls through to bumpFailedAttempts unchanged. NB classification_metadata
      // is an OBJECT — the coaxed draft (daf6d36) used .includes/.push on it (runtime crash) + a
      // bogus threading string; corrected here to property access + the real resolver signature.
      const _gm = ((gap as { classification_metadata?: Record<string, unknown> }).classification_metadata ??= {});
      let _pwtLanded = false;
      if (cb.apply_failed && !_gm.pwt_escalated) {
        _gm.pwt_escalated = true; // one-shot BEFORE the attempt: a crash/retry can never re-escalate
        try {
          const { resolvePatchWithTools } = await import('./patch-with-tools.js');
          const result = await resolvePatchWithTools({
            type: "patch_with_tools",
            proposal_text: spec + `\n\nPRIOR FEATURE-COMPOSE APPLY FAILURE ON THIS FILE (do not repeat it): op_count=${cb.op_count}, apply_failed, rolled_back=${cb.rolled_back}`,
            // `gap.file_path` is ALWAYS undefined — measured 0 of 360 live gaps carry a
            // top-level file_path, while 104 carry classification_metadata.edit_site. So
            // this handed patch_with_tools `undefined`, deriveVesselFromPath threw
            // "undefined is not an object (evaluating 'filePath.match')", and the
            // escalation had never once run. Worse, pwt_escalated is set one-shot ABOVE
            // this line, so every gap that reached here was permanently marked escalated
            // by a crash. Same field order identifyVessel() already uses.
            target_file: gapEditSite(gap, _gm),
            gap_id: gap.id,
            proposal_id: gap.id,
            // Explicit, not the resolver's silent `?? "/vessels"` default: the value
            // becomes visible in the trace, which is the point of threading it.
            vessels_root: process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
          } as never);
          const rb = (((result as unknown as Record<string, unknown>)?.body ?? result ?? {}) as Record<string, unknown>);
          const _land = (rb.landing ?? {}) as Record<string, unknown>;
          const _sha = (rb.new_git_sha ?? rb.commit_sha ?? _land.new_git_sha) as string | undefined;
          const _pushed = rb.push_status === "pushed" || _land.push_status === "pushed" || _land.landed === true;
          if (rb.mitosisStaged && _pushed && _sha) {
            await closeLandedGap(gap, { landed: true, commit_sha: String(_sha), vessel: "development-vessel", push_status: "pushed" });
            _pwtLanded = true;
          }
        } catch (e) {
          console.warn("[gap-to-feature] pwt escalation error: " + (e as Error).message);
        }
      }
      if (!_pwtLanded) await bumpFailedAttempts(gap, { surprise: pred.predicted, predictedP: pred.p });
    }
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
