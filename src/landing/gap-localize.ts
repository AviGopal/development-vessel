// Localizing a gap to the files and region it names. Lifted as-is from gap-to-feature.ts.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { evaluatorTreeRoot } from "../lib/evaluator-tree.js";
import { identifyVessel, autonomyScope, autonomyScopeExcludes } from "../judge/gap-policy.js";
import { repoPathExists, ownCheckCallPathTargets } from "../judge/gap-admission.js";
import { gapDirected } from "../lib/operator-direct.js";

// The evaluator's tree is ONE resolver (lib/evaluator-tree.ts), shared with the class-1 classifier in substrate-gap
// so the label and the measurement read the same file.
export const runtimeRoot = evaluatorTreeRoot;

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
  method: "metadata_edit_site" | "own_check_call_path" | "grep_unique" | "grep_dominant" | "llm_ranked";
  candidates?: number;
}

/** A metadata path field as a repos/<vessel>/…ts path that exists, else null: /vessels/<v>/… and a bare <v>/src|test/…
 *  become repos/<v>/…, and a trailing :symbol or :line suffix is stripped. */
function metadataSitePath(v: string): string | null {
  let cand = v.trim();
  // Normalise /vessels/<v>/… and bare <v>/… into repos/<v>/…
  cand = cand.replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
  if (!/^repos\//.test(cand) && /^[^/]+\/(src|tests?)\//.test(cand)) cand = `repos/${cand}`;
  // strip a trailing :symbol / :line suffix
  cand = cand.replace(/:[A-Za-z0-9_$]+$/, "").replace(/:\d+(?::\d+)?$/, "");
  return /^repos\/[^/]+\/.+\.(ts|tsx)$/.test(cand) && repoPathExists(cand) ? cand : null;
}
/**
 * Derive a CONCRETE existing edit-site for a gap that has no proposal-report edit target.
 * Returns null when no confident single file emerges (NEVER fabricates). Bounded + graceful.
 */
export async function localizeGap(gap: Record<string, unknown>, opts?: { useLlm?: boolean; directed?: boolean }): Promise<LocalizeResult | null> {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const summary = String(gap.summary ?? gap.title ?? "");

  // (b) HIGH-CONFIDENCE: an edit-site already named in metadata that maps to a real file.
  // suspected_real_location first: it is written back only by the semantic gate after it
  // refused a draft as mis-localized, so it is newer evidence than the original edit_site.
  // Trying edit_site first sent every retry back to the file the gate had just rejected.
  // A relocation hint (written when the gap's own check did not move under a draft) names the module the
  // failing assertion exercises: newer evidence than the edit_site the draft just failed at.
  const hinted = (meta.relocation_hint as { files?: unknown } | undefined)?.files;
  if (Array.isArray(hinted)) {
    for (const h of hinted) {
      if (typeof h !== "string" || !/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(h) || !repoPathExists(h)) continue;
      return { file: h, description: "change site named by the own check's failing assertion (relocation_hint)", vessel: h.match(/^repos\/([^/]+)\//)?.[1] ?? "", method: "metadata_edit_site" };
    }
  }
  for (const f of ["suspected_real_location", "edit_site", "change_site", "file_path"] as const) {
    let v = meta[f];
    if ((typeof v !== "string" || !v.trim()) && typeof (gap as Record<string, unknown>)[f] === "string") v = (gap as Record<string, unknown>)[f];
    if (typeof v !== "string" || !v.trim()) continue;
    const cand = metadataSitePath(v);
    if (cand) return { file: cand, description: `change site named by detector evidence (${f})`, vessel: cand.match(/^repos\/([^/]+)\//)?.[1] ?? "", method: "metadata_edit_site" };
    // THE GATE NAMES A SYMBOL, NOT A PATH (contained-self-development, drafting reliability). The
    // semantic gate writes `suspected_real_location` as a symbol or shape (`self_fact_reconcile`,
    // `self_fact_reconcile:authoring_root`); the path check above skipped it, so every retry went
    // back to the edit_site the gate had just rejected, and TARGET-FILE-SCOPE forbade the drafter
    // from editing where the gate pointed (relevance-sink: 4 attempts at patch-with-tools.ts while
    // the gate named self_fact_reconcile). Resolve the symbol to the resolver file named after it,
    // or to the single file in the gap's vessel that mentions it.
    if (f === "suspected_real_location") {
      const sym = v.trim().split(/[:\s]/)[0] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(sym)) {
        const vesselForSym = identifyVessel(gap, meta);
        if (vesselForSym) {
          const kebab = sym.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
          const byName = `repos/${vesselForSym}/src/resolvers/${kebab}.ts`;
          if (repoPathExists(byName)) return { file: byName, description: `change site named by the semantic gate (${sym}, resolver file)`, vessel: vesselForSym, method: "metadata_edit_site" };
          const mentions = grepScoreFiles(join(runtimeRoot(), vesselForSym, "src"), vesselForSym, [sym]).filter((h) => h.matched.length > 0);
          if (mentions.length === 1 && mentions[0]) return { file: mentions[0].file, description: `change site named by the semantic gate (${sym}, sole file mentioning it)`, vessel: vesselForSym, method: "metadata_edit_site" };
        }
      }
    }
  }

  // THE OWN CHECK'S CALL PATH, before any search (gap-admission ownCheckCallPathTargets, the reader admission grounds on):
  // a code-reachable red at the vessel's current origin/dev names the files the failing tests run through. Its first
  // in-scope existing file is the change site the row's own text did not name. Without it a row admission grounded on
  // its call path (a directory edit_site) went to the grep below, found no confident file and was marked
  // localization_failed, with a "needs a change-site" question and an escalation, on every pick.
  const directed = opts?.directed === true || gapDirected(meta);
  const onPath = await ownCheckCallPathTargets(gap, { directed });
  if (onPath[0]) return { file: onPath[0], description: "change site on the own check's code-reachable call path (own_check_baseline)", vessel: onPath[0].match(/^repos\/([^/]+)\//)?.[1] ?? "", method: "own_check_call_path" };
  // A search pick is held to the same autonomy scope (directed work: none): an excluded pick is no confident file, and
  // an unreadable scope excludes every pick (autonomyScopeExcludes), FAIL CLOSED: a consumer of the localized file can
  // fail open on an unreadable read (gap-check-supply writes the localized edit_site onto the row when its scope check
  // cannot run), so the localizer must not. Read only when a pick is about to be returned.
  let scopeForPick: Awaited<ReturnType<typeof autonomyScope>> | null = null;
  const pickInScope = async (file: string): Promise<boolean> => {
    if (directed) return true;
    scopeForPick ??= await autonomyScope();
    return autonomyScopeExcludes(scopeForPick, file) === null;
  };

  // THE DETECTOR'S STRUCTURED SITES (env-gate-scan writes classification_metadata.sites: [{vessel, file, line}], file
  // as a bare "<vessel>/src/…"). The named fields and the own check's call path above win; a row with neither was never
  // sited from its own evidence, and its investigation walk declined needs_information on every pass. The first
  // existing site is taken, held to the autonomy scope like a search pick (pickInScope: directed work none, fail closed).
  const sites = Array.isArray(meta.sites) ? meta.sites as Array<{ file?: unknown } | null> : [];
  for (const s of sites) {
    const cand = typeof s?.file === "string" ? metadataSitePath(s.file) : null;
    if (cand && await pickInScope(cand)) return { file: cand, description: "change site named by detector evidence (sites[].file)", vessel: cand.match(/^repos\/([^/]+)\//)?.[1] ?? "", method: "metadata_edit_site" };
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
    if (!(await pickInScope(top.file))) return null;
    return { file: top.file, description: `derived via code-search (sole match on: ${top.matched.join(", ")})`, vessel, method: "grep_unique", candidates: 1 };
  }
  const runner = hits[1]!;
  if (top.score >= 2 * runner.score && top.matched.length >= 2 && (await pickInScope(top.file))) {
    return { file: top.file, description: `derived via code-search (dominant match on: ${top.matched.join(", ")})`, vessel, method: "grep_dominant", candidates: hits.length };
  }
  if (opts?.useLlm !== false) {
    const picked = await rankWithLlm(summary, hits);
    if (picked && (await pickInScope(picked))) {
      const h = hits.find((x) => x.file === picked)!;
      return { file: picked, description: `derived via code-search + LLM rank (matched: ${h.matched.join(", ")})`, vessel, method: "llm_ranked", candidates: hits.length };
    }
  }
  // Low confidence (several comparable hits, LLM declined/unavailable) → no fabrication.
  return null;
}
