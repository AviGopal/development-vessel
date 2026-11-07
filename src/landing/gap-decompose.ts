// Decomposing a gap into ordered child steps. Lifted as-is from gap-to-feature.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { attemptEvidenceBlock } from "../resolvers/retry-evidence.js";
import { noteGapLocalization } from "../resolvers/gap-localization.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { vesselsCloneRoot, autonomyScope, autonomyScopeExcludes, scopeHoldFor, gapInHoldLineage } from "../judge/gap-policy.js";
import { type DecomposeDeps, type WouldBeChild, decompositionRefusal, parentPredicate, armDecomposition } from "../judge/gap-admission.js";
import { gapDirected } from "../lib/operator-direct.js";
import { localizeGap } from "./gap-localize.js";

// DECOMPOSITION CONTRACT (contained-self-development 6.3). The investigation step used to dispatch
// a free-text "investigate and decompose" walk whose output was another gap with no falsifier
// (384 runs, 4 closures). Every verifiable gap left on 2026-09-27 was design-sized: autonomous
// single-file drafts on them were refused as incomplete, wrong-file, DESTROY-TO-SATISFY or a
// hollow literal write. This gives the step a structured output: one bounded LLM call proposes
// 1-3 single-file steps, each validated deterministically before it is written as a child gap
// `<parent>-step-<k>` (category `decomposed_step`, so the parent's sealed category does not
// seal it): the file exists outside the autonomy scope; a shape falsifier names a shape that
// discovery advertises; a literal falsifier is absent from the file now and names an existing
// reader in it. Proposals that silence a detector are refused. Depth 1: a step is never
// decomposed again. Graded by child closure.
// The decomposer used to see only the first 7000 characters of the edit site, so in a large file it never
// saw the code a gap names and invented readers from whatever sat at the top (goal-host index.ts: sites at
// lines 7457-15128, excerpt ending near line 150). Show numbered windows around every file line the gap
// quotes verbatim instead; with no quoted line, the head of the file as before.
export function quotedSiteExcerpt(text: string, summary: string, cap = 7000): string {
  const lines = text.split("\n");
  const quoted = new Set(summary.split("\n").map((l) => l.replace(/^\s*\d+:\s*/, "").trim()).filter((l) => l.length >= 25));
  const hits: number[] = [];
  lines.forEach((l, i) => { if (quoted.has(l.trim())) hits.push(i); });
  if (hits.length === 0) return text.slice(0, cap);
  let out = "";
  let last = -1;
  for (const h of hits) {
    const from = Math.max(h - 3, last + 1);
    const to = Math.min(lines.length - 1, h + 3);
    if (from > to) continue;
    const chunk = lines.slice(from, to + 1).map((l, j) => `${from + j + 1}: ${l}`).join("\n") + "\n...\n";
    if (out.length + chunk.length > cap) break;
    out += chunk;
    last = to;
  }
  return out || text.slice(0, cap);
}

// gap_falsify v2: the decomposer was starved (law 8). 786 of 903 proposals in 7 days were refused as "no valid
// step", mostly invented repos/ paths and shapes: it was never shown the vocabulary it had to name. It now sees
// (a) the advertised READ shapes with their descriptions (discovery /registry/shape-descriptions, the reader
// author_composed_capability already uses) and (b) the edit-site vessel's test files and the test names that
// match the gap's own words, so a check can name something that exists.
const DECOMPOSE_STOPWORDS = new Set(["about", "after", "again", "because", "before", "being", "between", "cannot", "could", "every", "never", "other", "should", "their", "there", "these", "those", "under", "where", "which", "while", "would", "substrate", "change", "gap", "gaps", "check", "still", "today", "without", "within"]);
export function decomposeSummaryTerms(summary: string): string[] {
  const out = new Set<string>();
  for (const m of summary.matchAll(/[A-Za-z_][A-Za-z0-9_]{4,}/g)) {
    const w = m[0].toLowerCase();
    if (!DECOMPOSE_STOPWORDS.has(w)) out.add(w);
    if (out.size >= 40) break;
  }
  return [...out];
}
const TEST_SUITE_CHECK_HELP = "runs named tests of a vessel in-container; input {vessel:\"repos/<v>\", test_file:\"<path in that vessel>\", only_tests:[\"<exact test title>\"]}; answers requested_not_passing = how many of the named tests do not pass (a missing test counts as not passing)";
export function advertisedReadShapesBlock(descriptions: Record<string, string>, terms: string[], cap = 40): string {
  const rows = Object.entries(descriptions)
    .filter(([shape]) => shape !== "test_suite" && !/_write$|_delete$|_deprecate$|^vessel_register|^systemd_/.test(shape))
    .map(([shape, desc]) => {
      const hay = (shape + " " + desc).toLowerCase();
      return { shape, desc, score: terms.filter((t) => hay.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score || a.shape.localeCompare(b.shape))
    .slice(0, Math.max(0, cap - 1));
  return [`- test_suite: ${TEST_SUITE_CHECK_HELP}`, ...rows.map((r) => `- ${r.shape}: ${r.desc.slice(0, 200)}`)].join("\n");
}
// The same walk lists the src files a step may name (the arming's own site pattern, tests excluded), under the same
// bounds as the test list: a step must change one EXISTING source file, and the drafter was never shown which exist.
export function vesselTestInventory(vessel: string, terms: string[]): { files: string[]; matches: Array<{ file: string; name: string }>; sources: string[] } {
  const root = join(vesselsCloneRoot(), vessel);
  const files: string[] = [];
  const sources: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 6 || (files.length >= 400 && sources.length >= 400)) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(e.name)) { if (files.length < 400) files.push(r); }
      else if (r.startsWith("src/") && /\.(ts|tsx|js|mjs)$/.test(e.name) && sources.length < 400) sources.push(r);
    }
  };
  walk("src", 0);
  walk("test", 0);
  walk("tests", 0);
  const matches: Array<{ file: string; name: string }> = [];
  for (const f of files) {
    if (matches.length >= 30) break;
    let text = "";
    try { text = readFileSync(join(root, f), "utf-8"); } catch { continue; }
    for (const m of text.matchAll(/\b(?:test|it)(?:\.(?:only|skip|todo|if\([^)]*\)))?\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const name = m[2] ?? "";
      const low = name.toLowerCase();
      if (name && terms.some((t) => low.includes(t))) matches.push({ file: f, name });
      if (matches.length >= 30) break;
    }
  }
  // Listed under the test list's bound: the files whose path carries the gap's own words first, so the cap drops
  // the unrelated ones.
  const norm = (f: string) => f.toLowerCase().replace(/[-_]/g, "");
  const pathHits = (f: string) => terms.filter((t) => norm(f).includes(t.replace(/_/g, ""))).length;
  const ranked = sources.map((f, i) => ({ f, i, h: pathHits(f) })).sort((a, b) => b.h - a.h || a.i - b.i).map((x) => x.f);
  return { files: files.slice(0, 80), matches, sources: ranked };
}

// THE REPLY'S ROOM IS SIZED FROM WHAT THE PROMPT ASKS FOR. max_tokens was 1200 whatever the prompt asked, so a reply
// could be cut off mid-JSON and read as "unparseable decomposition". The schema text below is the one the prompt
// embeds, so the budget follows it: per step, the step schema (both falsifier forms, though a step uses one) plus a
// value allowance for each of its <placeholder> fields; times the step bound the prompt states; plus the parent check
// schema when one is asked for and the cannot_falsify note (the arming keeps 200 chars of it). A field's allowance is
// one sentence at the bound this prompt quotes a failure lesson at (300 chars); chars to tokens as the vessel estimates
// them elsewhere (length / 4). max_tokens is a ceiling, not a spend: an over-allowance costs nothing unless used.
/** The steps the prompt asks for at most: the arming reads no more (armDecomposition's .slice(0, 3)). */
export const DECOMPOSE_MAX_STEPS = 3;
const DECOMPOSE_STEP_SCHEMA = `{"edit_site":"repos/<vessel>/src/<file>","change":"<one sentence>","falsifier":{"evidence_resolve":{"shape":"<shape>","input":{},"zero_field":"<numeric field in its answer that counts this defect: above 0 today, 0 after the change>"}} OR {"expected_literal":"<identifier the change introduces>","reader":"<existing function in that file that will read or call it>"}}`;
const decomposeParentCheckSchema = (vessel: string): string => `{"evidence_resolve":{"shape":"test_suite","input":{"vessel":"repos/${vessel || "<vessel>"}","test_file":"<a path from TEST FILES>","only_tests":["<an exact title from EXISTING TESTS>"]},"zero_field":"requested_not_passing"}}`;
const DECOMPOSE_FIELD_VALUE_CHARS = 300;
const DECOMPOSE_CANNOT_FALSIFY_CHARS = 200;
const schemaReplyChars = (schema: string): number => schema.length + (schema.match(/<[^>]*>/g)?.length ?? 0) * DECOMPOSE_FIELD_VALUE_CHARS;
export function decomposeReplyMaxTokens(parentCheck: boolean): number {
  const envelope = `{"parent_check":,"steps":[],"cannot_falsify":""}`.length + DECOMPOSE_CANNOT_FALSIFY_CHARS;
  const chars = envelope + DECOMPOSE_MAX_STEPS * (schemaReplyChars(DECOMPOSE_STEP_SCHEMA) + 1) + (parentCheck ? schemaReplyChars(decomposeParentCheckSchema("")) : 0);
  return Math.ceil(chars / 4);
}

async function defaultDecomposeLlm(prompt: string, maxTokens: number): Promise<string> {
  const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }), signal: AbortSignal.timeout(6000) });
  const dd = (await dr.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> } };
  const best = (dd.content?.vessels ?? [])[0];
  if (!best) throw new Error("no llm_completion producer");
  const ep0 = best.resolve_endpoint ?? "/resolve";
  const endpoint = ep0.startsWith("http") ? ep0 : `${best.endpoint.replace(/\/$/, "")}${ep0.startsWith("/") ? ep0 : `/${ep0}`}`;
  const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` }, body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: maxTokens, caller: "development-vessel:gap_decompose" }), signal: AbortSignal.timeout(90_000) });
  const j = (await res.json()) as { content?: string; data?: string };
  return String(j.content ?? j.data ?? "");
}

export async function decomposeGap(
  parent: Record<string, unknown>,
  opts: { directed?: boolean; parentCheck?: boolean; deps?: DecomposeDeps; observe?: boolean } = {},
): Promise<{ written: string[]; reason: string; parent_check?: string; raw_len?: number; raw_tail?: string; observe?: true; would_be_children?: WouldBeChild[]; edit_site?: string; excerpt?: string }> {
  const parentId = String(parent.id ?? "");
  const meta = (parent.classification_metadata ?? {}) as Record<string, unknown>;
  { const refused = decompositionRefusal(parent); if (refused) return { written: [], reason: refused }; }
  let site = String(meta.edit_site ?? "").replace(/:\d+.*$/, "");
  // NO EDIT SITE, NO INVENTORY: the prompt said "EDIT SITE (none)" with no excerpt and no test files yet required
  // each step to change one existing file, and the arming refused every step for naming none. Localize the parent
  // from its own evidence and draft against that file; when nothing localises to a readable file in the clone, refuse
  // before the decomposer, as the scan's supply precondition does. The localiser runs WITH its LLM rank: without it, a
  // parent whose evidence matched comparable files was declined as needs_information although the rank (which runs
  // only when the cheap metadata and grep paths cannot choose, and writes nothing) could have sited it.
  if (!site) {
    const loc = await localizeGap(parent, { useLlm: true });
    await noteGapLocalization({ caller: "decompose", gap: parent, answer: loc });
    if (!loc || !existsSync(join(vesselsCloneRoot(), loc.file.replace(/^repos\//, "")))) return { written: [], reason: "needs_information: no readable edit site (no edit_site and nothing localises)" };
    site = loc.file;
  }
  const siteMatch = /^repos\/([^/]+)\/(.+)$/.exec(site);
  const siteVessel = siteMatch?.[1] ?? "";
  let excerpt = "";
  let siteRead = false;
  if (siteMatch) { try { excerpt = quotedSiteExcerpt(readFileSync(join(vesselsCloneRoot(), siteMatch[1] ?? "", siteMatch[2] ?? ""), "utf-8"), String(parent.summary ?? "")); siteRead = true; } catch { excerpt = ""; } }
  const predicate = parentPredicate(meta);
  const lessons = Array.isArray(meta.failure_lessons) ? (meta.failure_lessons as Array<Record<string, unknown>>).slice(-3).map((l) => "- " + String(l.class ?? "?") + ": " + String(l.reason ?? "").slice(0, 300)).join("\n") : "";
  // LAW-8 INPUTS: what exists to be named.
  const terms = decomposeSummaryTerms(String(parent.summary ?? ""));
  let descriptions: Record<string, string> = {};
  try {
    descriptions = opts.deps?.shapeDescriptions
      ? await opts.deps.shapeDescriptions()
      : await (await import("../resolvers/author-composed-capability.js")).fetchShapeDescriptions();
  } catch { descriptions = {}; }
  const inventory = siteVessel ? vesselTestInventory(siteVessel, terms) : { files: [], matches: [], sources: [] };
  // THE FILES IT MAY NAME AND THE SCOPE IT WILL BE HELD TO: the arming refuses a step that names a file that does not
  // exist or one the autonomy scope excludes, and the drafter was shown neither. The scope test is the arming's own
  // (armDecomposition's step loop: no scope for directed work, a hold exempts the repair of its own regression), over
  // the same cached read, so the list is what the arming will accept.
  // Honoured only with its provenance (lib/operator-direct.ts gapDirected), as the decomposer's own check.
  const childDirected = gapDirected(meta) || opts.directed === true;
  const scope = childDirected ? null : await autonomyScope();
  const scopeHit = (rel: string): string | null => {
    if (!scope) return null;
    const hit = autonomyScopeExcludes(scope, `repos/${siteVessel}/${rel}`);
    const hold = hit ? scopeHoldFor(scope, hit) : null;
    return hit && !(hold && gapInHoldLineage(parent, hold)) ? hit : null;
  };
  // The edit site leads whenever it was read, whether or not the walk's bounds reached it.
  const siteRel = siteRead && /^src\/.+\.(ts|tsx|js|mjs)$/.test(siteMatch?.[2] ?? "") && !/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(siteMatch?.[2] ?? "") ? siteMatch?.[2] ?? "" : "";
  const excludedHits = new Set<string>();
  const nameable = (siteRel ? [siteRel] : []).concat(inventory.sources.filter((f) => f !== siteRel))
    .filter((f) => { const hit = scopeHit(f); if (hit) excludedHits.add(hit); return !hit; })
    .slice(0, 80);
  const scopeLine = !scope ? "(directed work: the autonomy scope does not refuse its steps)"
    : !scope.readable ? `(the autonomy scope is unreadable, so every step is refused: ${scope.reason})`
    : [...excludedHits].join("\n") || "(none in this vessel)";
  const vocabularyBlock = `\n\nADVERTISED READ SHAPES (a shape check must name one of these; name: what it answers):\n${advertisedReadShapesBlock(descriptions, terms)}` +
    `\n\nTEST FILES IN repos/${siteVessel || "(none)"}:\n${inventory.files.join("\n") || "(none found)"}` +
    `\n\nEXISTING TESTS WHOSE NAMES MATCH THIS GAP (file :: exact title):\n${inventory.matches.map((m) => `${m.file} :: ${m.name}`).join("\n") || "(none)"}` +
    `\n\nSOURCE FILES IN repos/${siteVessel || "(none)"} A STEP MAY NAME (its edit_site is repos/${siteVessel || "<vessel>"}/<one of these>):\n${nameable.join("\n") || "(none found)"}` +
    `\n\nOUTSIDE THE AUTONOMY SCOPE (a step whose edit_site falls under one of these is refused):\n${scopeLine}`;
  const parentCheckAsk = opts.parentCheck
    ? `\n\nFIRST, "parent_check": ONE machine check for THIS GAP ITSELF that FAILS on today's tree because of this defect and passes once the defect is fixed. Two forms only. (a) an EXISTING test that fails today because of this defect: ${decomposeParentCheckSchema(siteVessel)}. (b) an ADVERTISED READ SHAPE whose answer has a numeric field counting this defect (above 0 today, 0 after the fix): {"evidence_resolve":{"shape":"<shape>","input":{},"zero_field":"<field>"}}. Never a word or literal check, never a write shape, never a test or shape you would have to create. The check is run before it is kept and is discarded unless it fails today. If no such check exists, "parent_check": null.`
    : "";
  const prompt = `A substrate gap could not be closed by one single-file code change. Decompose it into 1 to ${DECOMPOSE_MAX_STEPS} SMALL steps. Each step changes exactly ONE existing source file from SOURCE FILES below and has a machine-checkable falsifier.\n\nGAP ${parentId}:\n${String(parent.summary ?? "").slice(0, 1500)}\n\nITS FALSIFIER: ${JSON.stringify(predicate)}\n\nWHY ATTEMPTS FAILED (most recent last):\n${lessons || "(none recorded)"}\n${attemptEvidenceBlock(meta.failure_lessons)}\n\nEDIT SITE ${site || "(none)"} (excerpt):\n${excerpt}${vocabularyBlock}${parentCheckAsk}\n\nRespond with ONLY JSON: {${opts.parentCheck ? `"parent_check":{"evidence_resolve":{...}} or null,` : ""}"steps":[${DECOMPOSE_STEP_SCHEMA}],"cannot_falsify":"<only if no step can be given a machine check>"}\nRules: a shape falsifier must name a shape that ALREADY exists and answers today (it currently reports this defect and stops reporting it after the change); a shape the change itself would introduce cannot be a falsifier — for new behaviour use expected_literal with a reader; the reader must be an existing FUNCTION in that file that is called on a live path and will call or read the literal (not a type, interface or comment); never propose a logging-only, comment-only or observation-only step; never propose removing, weakening or silencing a detector or check; each step must change live behaviour ON ITS OWN when landed alone — never a step that only adds a helper, function or constant for a later step to call (a new function nothing calls is refused as hollow); when the same fix is needed at several sites, make each step fix ONE site completely, inline, the way any site that already does it correctly does; the steps together must close the gap.`;
  let raw = "";
  try {
    raw = opts.deps?.llm ? await opts.deps.llm(prompt) : await defaultDecomposeLlm(prompt, decomposeReplyMaxTokens(opts.parentCheck === true));
  } catch (err) {
    if (String(err).includes("no llm_completion producer")) return { written: [], reason: "no llm_completion producer" };
    return { written: [], reason: "llm call failed: " + String(err) };
  }
  let parsed: { steps?: Array<Record<string, unknown>>; cannot_falsify?: unknown; parent_check?: unknown } = {};
  try { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); parsed = JSON.parse(raw.slice(a, b + 1)); } catch {
    // The reason is pinned (judge-split); the reply's length and tail are the only evidence of why it failed (a
    // truncated reply ends mid-JSON), so they ride the answer, and the route's body, beside it.
    const rawTail = raw.slice(-300).replace(/[\x00-\x1f\x7f\s]+/g, " ").trim();
    console.log(`[gap-decompose] ${parentId}: unparseable decomposition (reply ${raw.length} chars, ends: ${rawTail})`);
    return { written: [], reason: "unparseable decomposition", raw_len: raw.length, raw_tail: rawTail, ...(opts.observe ? { observe: true as const, edit_site: site, excerpt: excerpt.slice(0, 1500) } : {}) };
  }
  // OBSERVE (opts.observe): the arming validates and judges every step and writes nothing (armDecomposition); the
  // answer also says which edit site and excerpt the draft was given.
  const armed = await armDecomposition(parent, parsed, opts);
  return opts.observe ? { ...armed, edit_site: site, excerpt: excerpt.slice(0, 1500) } : armed;
}
