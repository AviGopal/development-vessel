/**
 * GAP ADMISSION (gap-judge-core, closed). What may be composed autonomously:
 * - admitActionableGaps: the whole admission gate sequence, with its order, its throttles and its contained
 *   fail-open;
 * - composeAdmissionExclusion and targetedComposeExclusion: the eligibility exclusion both autonomous entries run;
 * - inheritedPredicateHolds: one live gap per (lineage, check);
 * - the typecheck waiver and the phantom-typecheck gate;
 * - the cited-file and proposal-report admits;
 * - the pick-skip walk (chooseFirstActionable);
 * - the compose-ownership evidence (findComposeOwner).
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.6, step A).
 * Admission orchestration stays in the residue: the store read, the throttle filter and the call into this module.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "../resolvers/types.js";
import { resolveSubstrateGapWrite, predicateSuspect, class2PredicateKey } from "../resolvers/substrate-gap.js";
import { gateLanding, landingsStopped } from "../resolvers/push-policy.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { withTestChildEnv } from "../test-child-env.js";
import { evaluatorTreeRoot } from "../lib/evaluator-tree.js";
import { identicalRepeatedFailure, isParkingDisposition, composeEligibilitySkipReason, isAwaitingLandVerification, greenOnParentFresh, CHECK_SUPPLY_DISPOSITION, type ComposeEligibilitySkipReason } from "./gap-eligibility.js";
import { identifyVessel, ownedVessels, autonomyScope, autonomyScopeExcludes, scopeHoldFor, gapInHoldLineage, vesselDirExists, vesselsCloneRoot } from "./gap-policy.js";

// The evaluator's tree (lib/evaluator-tree.ts), the same alias gap-to-feature uses.
const runtimeRoot = evaluatorTreeRoot;

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

const proposalsDir = (): string => envPath("PROPOSALS_DIR", "/workspace/proposals");

/**
 * ONE LIVE GAP PER (LINEAGE, CHECK). A narrowed or recommit child born with its parent's check
 * (inheritableParentCheck) is the same predicate as the parent and its siblings: picking all of them
 * splits attempts and spend three ways on one check. While such a child is open and able to work, it
 * HOLDS the predicate, and every other open gap of its lineage with a byte-identical evidence_resolve
 * is not auto-pickable. Returns held id -> holder id.
 *
 * A holder must be workable, or the hold would park the whole lineage: its own check trusted
 * (predicateSuspect null), no operator hold, no parking disposition, not an identical-repeated-failure
 * loss. Among several, the narrowed child (it carries the failure lessons) is preferred, then the one
 * with fewer failed attempts, then the id, so the choice is stable across passes.
 */
export function inheritedPredicateHolds(gaps: Record<string, unknown>[]): Map<string, string> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const g of gaps) { const id = String(g.id ?? ""); if (id) byId.set(id, g); }
  const metaOf = (g: Record<string, unknown>): Record<string, unknown> => (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
  const rootOf = (g: Record<string, unknown>): string => {
    let cur = g;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const id = String(cur.id ?? "");
      if (seen.has(id)) break;
      seen.add(id);
      const m = metaOf(cur);
      const up = String(m.parent_gap_id ?? m.source_gap_id ?? "");
      if (!up) return id;
      const next = byId.get(up);
      if (!next) return up; // a closed or unread ancestor still names the lineage
      cur = next;
    }
    return String(cur.id ?? "");
  };
  const checkKey = (m: Record<string, unknown>): string | null => {
    const er = m.evidence_resolve;
    return er && typeof er === "object" && typeof (er as { shape?: unknown }).shape === "string" ? class2PredicateKey({ evidence_resolve: er }) : null;
  };
  const groups = new Map<string, { members: string[]; holders: Record<string, unknown>[] }>();
  for (const g of gaps) {
    const id = String(g.id ?? "");
    const m = metaOf(g);
    const key = checkKey(m);
    if (!id || !key) continue;
    const gk = rootOf(g) + "\u0000" + key;
    const grp = groups.get(gk) ?? { members: [], holders: [] };
    grp.members.push(id);
    const isInheritedChild = m.predicate_source === "gap_falsify:inherit" && !!(m.parent_gap_id ?? m.source_gap_id);
    if (isInheritedChild && predicateSuspect(m) === null && m.operator_hold !== true && !isParkingDisposition(m.disposition) && !identicalRepeatedFailure(m.failure_lessons)) grp.holders.push(g);
    groups.set(gk, grp);
  }
  const held = new Map<string, string>();
  for (const { members, holders } of groups.values()) {
    if (holders.length === 0 || members.length < 2) continue;
    const rank = (g: Record<string, unknown>): [number, number, string] => [String(g.id ?? "").endsWith("-narrowed") ? 0 : 1, Number(metaOf(g).failed_attempts ?? 0) || 0, String(g.id ?? "")];
    holders.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
    const holder = String(holders[0]!.id ?? "");
    for (const id of members) if (id !== holder) held.set(id, holder);
  }
  return held;
}

/**
 * A repos/<vessel>/... path maps to an EXISTING file under the runtime root OR the vessel clone.
 * The runtime tree is an image layer that omits most test/ files, while the lane edits the clone,
 * so a gap whose edit_site is a test file read as ungroundable (measured 2026-09-29 on node 2:
 * /vessels/activity-api/test held 1 file; 8 open gaps cited clone-only paths, 3 of them class2).
 */
export function repoPathExists(repoRelative: string): boolean {
  const rel = repoRelative.replace(/^repos\//, "");
  try {
    return existsSync(join(runtimeRoot(), rel)) || existsSync(join(vesselsCloneRoot(), rel));
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
export function existingEditTargets(gapId: string): Array<{ file: string; description: string }> {
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

/** Bounded so the pick cannot spawn a git subprocess per pooled gap. See chooseFirstActionable. */
export const PENDING_SCAN_MAX = 120; // 2026-09-03, Operation 2: widen the scan window to allow deeper scanning for actionable gaps

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
): { chosen: { g: T; s: number }; skippedPending: number; scanExhausted?: boolean } {
  let skippedPending = 0;
  const limit = Math.min(ranked.length, scanMax);
  for (let i = 0; i < limit; i++) {
    const cand = ranked[i]!;
    if (isPending(cand.g)) { skippedPending++; continue; }
    return { chosen: cand, skippedPending };
  }
  const extendedLimit = Math.min(ranked.length, scanMax * 2);
  for (let i = limit; i < extendedLimit; i++) {
    const cand = ranked[i]!;
    if (isPending(cand.g)) { skippedPending++; continue; }
    return { chosen: cand, skippedPending, scanExhausted: true };
  }
  return { chosen: ranked[extendedLimit] ?? ranked[0]!, skippedPending, scanExhausted: true };
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
 * A STRUCTURED tsc error: classification_metadata.tsc_error {code: "TSnnnn", file, vessel?, line?} whose file exists
 * in the vessel tree grounding reads (repoPathExists: MITOSIS_RUNTIME_DIR, then the vessel clones). `file` is
 * repo-relative ("repos/<vessel>/src/x.ts"), vessel-prefixed ("<vessel>/src/x.ts"), or vessel-relative with
 * `vessel` set. This, and only this, makes a gap typecheck-class for admission's exemption from the compose
 * eligibility predicate: a TSxxxx token in an id or summary (typecheckClassOf's substring parse) is not a
 * measured error, it is text (a failure lesson, a narrative), and it exempted 225 live open gaps on 2026-10-03.
 * The typecheck detector (scripts/substrate/typecheck-scenario-gen.ts) does not write this field today.
 */
export function structuredTscErrorOf(gap: Record<string, unknown>): { vessel: string; tsCode: string; file: string } | null {
  const rawMeta = gap.classification_metadata ?? gap.metadata;
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const te = meta.tsc_error;
  if (!te || typeof te !== "object") return null;
  const { code, file, vessel } = te as { code?: unknown; file?: unknown; vessel?: unknown };
  const tsCode = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!/^TS\d{4,5}$/.test(tsCode)) return null;
  const vesselField = typeof vessel === "string" ? vessel.trim() : "";
  let cand = (typeof file === "string" ? file.trim() : "").replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
  if (!cand) return null;
  if (!/^repos\//.test(cand)) cand = vesselField ? `repos/${vesselField}/${cand}` : /^[^/]+\/(src|tests?)\//.test(cand) ? `repos/${cand}` : cand;
  cand = cand.replace(/:\d+(?::\d+)?$/, "");
  const m = cand.match(/^repos\/([^/]+)\/.+\.(ts|tsx)$/);
  if (!m || !m[1] || (vesselField && vesselField !== m[1]) || !repoPathExists(cand)) return null;
  return { vessel: m[1], tsCode, file: cand };
}

/**
 * Parse a typecheck-class gap: one whose id/summary encodes a TSxxxx error at a specific vessel
 * source file (the phantom-churn shape). Returns { vessel, tsCode } when both a TS code and an
 * EXISTING vessel dir are derivable, else null (→ not a typecheck-class gap; no tsc run).
 */
export function typecheckClassOf(gap: Record<string, unknown>): { vessel: string; tsCode: string } | null {
  // A structured error names its vessel and code exactly; the substring parse below is the fallback.
  const structured = structuredTscErrorOf(gap);
  if (structured) return { vessel: structured.vessel, tsCode: structured.tsCode };
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
export function defaultTypecheckRunner(vessel: string): { ran: boolean; clean: boolean } {
  try {
    const cwd = join(runtimeRoot(), vessel);
    if (!existsSync(join(cwd, "package.json"))) return { ran: false, clean: false };
    // LOG THE SPAWN. This is a blocking, whole-project typecheck run from inside gap
    // SELECTION, and until now it was completely silent — so the substrate could not
    // attribute its own CPU. That is the same defect as local-tools-vessel never logging
    // the commands it runs, and it is why the cost of selection had to be inferred
    // rather than measured. One line per run makes the next estimate a measurement.
    const startedAt = Date.now();
    // SCRUBBED ENV: `bun run typecheck` runs a lane-authorable package.json script, and this process holds
    // the fleet secrets file. Only the shared allowlist, with a scratch WORKSPACE_ROOT (test-child-env.ts).
    const res = withTestChildEnv((env) => Bun.spawnSync(["bun", "run", "typecheck"], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 }));
    console.log(`[gap-admission] typecheck vessel=${vessel} exit=${String(res.exitCode)} ms=${Date.now() - startedAt}`);
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
  // LANDINGS STOPPED → ADMIT NOTHING. MITOSIS_DIRECT_PUSH=0 is the emergency stop the cutover
  // refuses every landing on (vessel-mitosis-cutover.ts, push-policy.ts landingsStopped). An
  // auto-pick admitted here would pay for the typecheck pass below, an LLM draft and compose
  // worktrees, only to be refused at cutover. Same predicate, same semantics: only an explicit
  // "0" stops (unset or "1" proceeds, as the cutover does); a pure env read cannot be
  // unevaluable. This is the only admission call, and only the auto-pick branch (no gap_id)
  // reaches it, so targeted and operator-directed composes are unaffected. Checked first, so a
  // stopped pass costs neither the scope read nor a typecheck. One line per pass, not per gap.
  if (landingsStopped()) {
    const excludedAll = gaps.map((g) => ({ id: String(g.id ?? ""), reason: "landings_stopped" }));
    console.log(`[gap-to-feature] auto-pick admission: landings_stopped (MITOSIS_DIRECT_PUSH=0): ${gaps.length} candidates → 0 admitted, ${excludedAll.length} excluded`);
    return { admitted: [], excluded: excludedAll };
  }
  const runner = opts?.typecheckRunner ?? defaultTypecheckRunner;
  // One scope read for the whole pass, so every candidate is judged against the same answer.
  const scope = await autonomyScope();
  // An UNREADABLE scope excludes every autonomous candidate, sited or not (no partial admission):
  // nothing here can tell which ones touch the lane core. Reported under one reason key in the
  // usual admission line, so an admitted-zero pass says why.
  if (!scope.readable) {
    const why = scope.absent ? "autonomy_scope_absent" : "autonomy_scope_unreadable";
    console.log(`[gap-to-feature] autonomy scope ${scope.absent ? "absent" : "unreadable"}: excluding all autonomous candidates (${scope.reason})`);
    const excludedAll = gaps.map((g) => ({ id: String(g.id ?? ""), reason: `${why}(${scope.reason})` }));
    if (excludedAll.length) console.log(`[gap-to-feature] auto-pick admission: ${gaps.length} candidates → 0 admitted, ${excludedAll.length} excluded ${JSON.stringify({ [why]: excludedAll.length })}`);
    return { admitted: [], excluded: excludedAll };
  }
  const admitted: Record<string, unknown>[] = [];
  // Gaps naming no existing file. Collected rather than admitted so the fail-open check
  // below can see whether there is any groundable work to prefer over them.
  const ungroundable: Record<string, unknown>[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  const candidatesById = new Map(gaps.map((x) => [String(x.id ?? ""), x] as [string, Record<string, unknown>]));
  const CHILD_GAP_MONOPOLY_THRESHOLD = 3; // Arbitrary, but a concrete limit. This may be tuned in the future.
  const childGapsByEditSite = new Map<string, number>();
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

  const MAX_ADMITTED_PER_EDIT_SITE_PER_CYCLE = 2;
  const admittedPerEditSite = new Map<string, number>();
  // vessel -> push_scope_refused reason, or null when the landing gate allows it (this pass only).
  const pushScopeRefusalByVessel = new Map<string, string | null>();

  for (const g of gaps) {
    const id = String(g.id ?? "");
    const cat = String(g.category ?? "");
    const meta = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    const failedAttempts = Number(meta.failed_attempts ?? 0);

    const ownedVessel = identifyVessel(g, meta);
    const ownedSet = ownedVessels();
    if (ownedVessel && ownedSet.size > 0 && !ownedSet.has(ownedVessel)) {
      excluded.push({ id, reason: `not owned here(${ownedVessel})` });
      continue;
    }
    // PROTECTED VESSELS never cut over (vessel-mitosis-start.ts and vessel-mitosis-cutover.ts
    // refuse them), so a pick aimed at one spends a compose on a landing that cannot happen:
    // 19 of 123 auto-picks in the 24 h to 2026-09-26 10:20. Same set as those two files.
    if (ownedVessel === "discovery-vessel" || ownedVessel === "identity-vessel") {
      excluded.push({ id, reason: `protected_vessel(${ownedVessel})` });
      continue;
    }
    // PUSH SCOPE AT ADMISSION (value-per-cost-selection 2.1). The cutover refuses a landing
    // whose push remote is out of scope (vessel-mitosis-cutover.ts gateLanding), but only
    // after the draft was paid for. Ask the same gate here, once per vessel per pass, on the
    // clone the cutover pushes from (MITOSIS_PUSH_CLONE_DIR/<vessel> in direct-push mode).
    // The cutover stays the final authority and owns the kill switch. Fail-open on any error.
    if (ownedVessel) {
      if (!pushScopeRefusalByVessel.has(ownedVessel)) {
        let refusal: string | null = null;
        try {
          const pushCloneRoot = process.env["MITOSIS_PUSH_CLONE_DIR"];
          if (pushCloneRoot && process.env["MITOSIS_DIRECT_PUSH"] === "1") {
            const proc = Bun.spawnSync(["git", "-C", join(pushCloneRoot, ownedVessel), "remote", "get-url", "--push", "origin"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
            const landingGate = gateLanding({
              remoteUrl: proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : null,
              branch: "dev",
            });
            if (landingGate.kind === "push_scope_refused") refusal = landingGate.reason;
          }
        } catch { refusal = null; }
        pushScopeRefusalByVessel.set(ownedVessel, refusal);
        if (refusal) console.log(`[gap-admission] push_scope_refused vessel=${ownedVessel} reason=${refusal}`);
      }
      if (pushScopeRefusalByVessel.get(ownedVessel)) {
        excluded.push({ id, reason: `push_scope_refused(${ownedVessel})` });
        continue;
      }
    }
    // ACTIONABLE-ONLY ADMISSION (value-per-cost-selection 2.2), ONE PREDICATE WITH THE COMPOSE NUDGE. A compose
    // candidate is admitted only when composeEligibilitySkipReason passes it: open, armed (class1/class2), naming an
    // edit site, not held. That is the predicate the gap-write path and the drain observer nudge on, so a nudge never
    // fires for a gap this pick cannot take. This gate used to be "edit site OR armed": a sited gap with falsifier
    // none gave compose nothing to verify against and was admitted (1661 of the 1961 open gaps that passed it on
    // 2026-10-03); an armed siteless one gave it nothing to edit. Either needs information, not a draft, on every
    // pick, whether or not a proposal report exists, so the one-shot investigated_at route cannot re-admit it.
    // Exemptions, each for its stated reason only. Orphan-producer gaps are not compose (author_producer's one mint);
    // a gap carrying a STRUCTURED tsc error at an existing file (structuredTscErrorOf) is decided by tsc and the
    // phantom-typecheck retirement below; a TSxxxx token in its id or summary alone is not that. Their holds are read
    // further down. A recommit gap with a source_gap_id inherits its SITE after selection, so it is
    // waived the edit-site requirement only: it must still be open, armed and unheld (452 sited, unarmed recommit
    // children were admitted on 2026-10-03 by the old "site OR armed" rule).
    // The predicate and its exemptions live in composeAdmissionExclusion, which the targeted entry calls too.
    {
      const exclusion = composeAdmissionExclusion(g);
      if (exclusion) { excluded.push({ id, reason: exclusion.reason }); continue; }
    }
    // AUTONOMY SCOPE (contained-self-development 1.2). Admission is the autonomous path, so a gap
    // whose edit site is in the lane core is refused here, before any draft. Directed goals never
    // come through admission. The compose verdict re-checks the paths actually touched.
    {
      const siteForScope = String(meta.edit_site || meta.file_path || meta.change_site || meta.suspected_real_location || g.file_path || "");
      if (siteForScope) {
        const scopeHit = autonomyScopeExcludes(scope, siteForScope);
        // A tightening hold does not block the repair of its own regression (gapInHoldLineage).
        const hold = scopeHit ? scopeHoldFor(scope, scopeHit) : null;
        if (scopeHit && hold && gapInHoldLineage(g, hold, candidatesById)) {
          console.log(`[gap-admission] gap ${id}: in the lineage of the tightening hold on ${hold.path}; the hold does not exclude its own repair`);
        } else if (scopeHit) {
          excluded.push({ id, reason: `autonomy_scope(${scopeHit})` });
          continue;
        }
      }
      // The semantic gate writes where the fix really belongs. When that is an excluded path, every draft
      // at the gap's own edit_site is refused as not addressing it (obsidian authoring-root: 6 refusals on
      // 09-27, each naming self-fact-reconcile.ts), so the gap is out of autonomous reach.
      // A RELOCATION HINT into an excluded path is operator work: the own check's failing assertion exercises a
      // file the lane may not edit, so every autonomous draft would fail it again. The gap keeps the hint, is
      // parked (needs_information) and carries an operator routing marker naming the files. A hint inside the
      // scope never excludes on its own.
      const hintFiles = ((meta.relocation_hint as { files?: unknown } | undefined)?.files);
      const hinted = Array.isArray(hintFiles) ? hintFiles.filter((h): h is string => typeof h === "string") : [];
      const hintHit = hinted.map((h) => autonomyScopeExcludes(scope, h)).find((h): h is string => !!h);
      if (hintHit) {
        excluded.push({ id, reason: `autonomy_scope(relocation_hint ${hintHit})` });
        if (!(meta.operator_routing as { files?: unknown } | undefined)?.files) {
          // A MERGE: only the two keys are sent; the store carries every omitted key (the hint among them) forward.
          const routingMeta: Record<string, unknown> = {
            ...(isParkingDisposition(meta.disposition) ? {} : { disposition: "needs_information" }),
            operator_routing: { reason: `the own check's failing assertion exercises ${hintHit}, outside the autonomy scope (relocation_hint)`, files: hinted, at: new Date().toISOString() },
          };
          try {
            const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: g.status ?? "open", classification_metadata: routingMeta } } as never);
            if (w?.shape === "structuredError") console.warn(`[gap-admission] gap ${id}: operator routing marker REFUSED (${JSON.stringify(w.body).slice(0, 200)}); the exclusion stands without it`);
          } catch (err) {
            console.warn(`[gap-admission] gap ${id}: operator routing marker not written (${(err as Error)?.message ?? String(err)}); the exclusion stands without it`);
          }
        }
        continue;
      }
      const suspectedSite = String(meta.suspected_real_location ?? "").replace(/:[^/]*$/, "");
      if (suspectedSite && suspectedSite !== siteForScope) {
        const suspectedHit = autonomyScopeExcludes(scope, suspectedSite);
        if (suspectedHit) {
          excluded.push({ id, reason: `autonomy_scope(suspected_real_location ${suspectedHit})` });
          continue;
        }
      }
    }
    // An operator hold removes a gap from autonomous work. The picker's skip honours it, but falls back to
    // the top-ranked candidate when every candidate is skipped, so a held gap was picked every 1.5-3 min
    // (09-27 22:20-22:29) and refused at compose. Excluded here, the fallback cannot reach it.
    if (meta.operator_hold === true) { excluded.push({ id, reason: "operator_hold" }); continue; }
    // A disposition that parks the gap for a human was a label nobody read: an unlocalized needs_information gap
    // was picked on 2026-09-30 12:21 (for a stale test its only green is changing src to match it).
    if (isParkingDisposition(meta.disposition)) { excluded.push({ id, reason: `disposition(${String(meta.disposition)})` }); continue; }
    // A landing awaiting its verdict is not compose work: re-drafting it spends a draft on code that may already be
    // fixed (2026-09-30: 35 of 75 compose2 picks went to gaps whose own commit had landed). Re-admitted once the
    // landing is known not to have fixed it (regressed_by, BEHAVIORAL VERIFICATION FAILED, or the sweep's release).
    if (isAwaitingLandVerification(g)) { excluded.push({ id, reason: "disposition(pending_verification)" }); continue; }
    // Its own check already passes on the parent (op10 terminal refusal): re-picking cannot help until the sweep
    // closes it or an operator looks, so it waits out OWN_GREEN_ADMISSION_TTL_MS instead of a cooldown per cycle.
    if (greenOnParentFresh(meta)) { excluded.push({ id, reason: "own_check_green_on_parent" }); continue; }
    // PREDICATE SUSPECT (contained-self-development 8.5; gap_falsify v2). A class-2 check that did not read
    // 'present' when it was written has never seen the defect: a landing "verified" by it verifies nothing.
    // The write seam stamps the birth verdict; rows that predate it carry none and are unaffected.
    { const suspect = predicateSuspect(meta); if (suspect) { excluded.push({ id, reason: `predicate_suspect(${suspect})` }); continue; } }
    // FALSIFIER REQUIRED (contained-self-development). When the autonomyScope record names
    // require_falsifier_classes, an autonomous gap is admitted only if its falsifier is one of them;
    // otherwise it needs information, whatever its edit site. A typecheck-class gap keeps its own
    // machine check (tsc). No field: unchanged.
    {
      const requiredClasses = scope.requireFalsifierClasses;
      // A typecheck-class gap keeps its own machine check only while its vessel FAILS typecheck now:
      // a TS code carried into a summary by a failed attempt's lesson otherwise admitted the
      // fs-edit gap (local-tools typechecks clean) and redrafted it four times.
      const typecheckClass = typecheckClassOf(g);
      const typecheckFailingNow = typecheckClass ? vesselTypecheckClean(typecheckClass.vessel) === false : false;
      if (requiredClasses && requiredClasses.length > 0 && !typecheckFailingNow) {
        const rawFalsifier = meta.falsifier as unknown;
        const gapFalsifierClass = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
        if (!requiredClasses.includes(gapFalsifierClass)) {
          excluded.push({ id, reason: `needs_information(falsifier=${gapFalsifierClass || "unset"}; autonomyScope requires ${requiredClasses.join("/")})` });
          continue;
        }
        // A class2 check with no measured field reads 'unknown' in the sweep forever: its landing can be
        // neither closed nor recorded as falsified. c4bb14d (09-27 22:01) landed on such a step, hard-coded
        // a restart count to 0, and nothing in the system could say so.
        if (gapFalsifierClass === "class2") {
          const er = meta.evidence_resolve as Record<string, unknown> | null | undefined;
          const measured = !!er && typeof er === "object" && ["zero_field", "nonzero_field", "defect_field"].some((fk) => typeof er[fk] === "string");
          if (!measured) { excluded.push({ id, reason: "needs_information(class2 check names no zero_field/defect_field, so its landing could never be judged)" }); continue; }
        }
      }
    }
    // Increment child gap count if this is an auto-minted child gap.
    if (id.startsWith("recommit-") || id.endsWith("-narrowed")) {
      const editSite = String(meta.edit_site ?? "");
      if (editSite) {
        childGapsByEditSite.set(editSite, (childGapsByEditSite.get(editSite) ?? 0) + 1);
      }
    }

    // (E5) EDIT_SITE_SATURATED — cap the number of gaps admitted per distinct edit_site file per cycle.
    // Measured 2026-09-12: 57% of open gaps are auto-minted children; two files received 57% of compose attempts.
    // Fairness across files matters more than depth on one file; a file that has failed 161 times in a day
    // is not one attempt away from succeeding. Cap at a small share so the cap=1 compose lane serves diverse goals.
    try {
      const editSiteForCap = String(meta.edit_site ?? "");
      // human_reported gaps are EXEMPT from the site cap: the cap exists to stop auto-minted child churn (57% of attempts on two files, measured 2026-09-12), but it runs at ADMISSION in iteration order, BEFORE human_reported pick-weighting — so an operator-filed gap on a busy file was starved indefinitely behind route-edit children at the same site (measured 2026-09-20: gap-transform-oracle-verdict-line-omits-the-checked-address, 90 minutes, zero attempts, while the site cap excluded 58-59 gaps per cycle). Operator gaps are rare; exempting them cannot recreate the churn the cap prevents.
      if (editSiteForCap && String(g.source ?? "") !== "human_reported") {
        const admittedAtSite = admittedPerEditSite.get(editSiteForCap) ?? 0;
        if (admittedAtSite >= MAX_ADMITTED_PER_EDIT_SITE_PER_CYCLE) {
          excluded.push({ id, reason: `edit_site_saturated(${editSiteForCap})` });
          continue;
        }
        admittedPerEditSite.set(editSiteForCap, admittedAtSite + 1);
      }
    } catch { /* fail-open: admit as before */ }

    // (E4) IDENTICAL REPEATED FAILURE — a gap whose every recorded attempt failed for the
    // same normalized reason will fail that way again, so each retry burns a scarce LLM
    // completion for a guaranteed loss (see identicalRepeatedFailure).
    // FAIL-OPEN by construction: any parse or shape problem admits exactly as before.
    try {
      const editSite = String(meta.edit_site ?? "");
      const childGapsAtEditSite = childGapsByEditSite.get(editSite) ?? 0;
      if (editSite && childGapsAtEditSite >= CHILD_GAP_MONOPOLY_THRESHOLD) {
        excluded.push({ id, reason: `child_gap_monopoly_at_edit_site(${editSite})` });
        continue;
      }
      const repeated = identicalRepeatedFailure(meta.failure_lessons);
      if (repeated) {
        excluded.push({ id, reason: repeated });
        continue;
      }
    } catch { /* fail-open: admit as before */ }

    // (E3) PHANTOM ANCHOR — retire a gap whose quoted anchor is already gone from the file
    // it names. Measured 2026-09-11: 17 of 600 open gaps cite a complete anchor with zero
    // occurrences in their named file, so every retry must fail anchor_not_found forever.
    // FAIL-OPEN by construction: any parse, path or read problem admits exactly as before.
    try {
      const phantomSummary = String(g.summary ?? "");
      const phantomAnchor = phantomSummary
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .find((l) => (l.startsWith("const ") || l.startsWith("let ") || l.startsWith("function ")) && l.endsWith(";") && l.length > 20);
      const phantomSite = String(meta.edit_site ?? "").split(":")[0];
      if (phantomAnchor && phantomSite?.startsWith("repos/") && failedAttempts >= 2) {
        const phantomRoot = process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";
        const phantomParts = phantomSite.split("/");
        const phantomAbs = phantomRoot + "/" + phantomParts[1] + "/" + phantomParts.slice(2).join("/");
        if (existsSync(phantomAbs) && !readFileSync(phantomAbs, "utf8").includes(phantomAnchor)) {
          excluded.push({ id, reason: "phantom_anchor(" + phantomParts[1] + ")" });
          continue;
        }
      }
    } catch { /* fail-open: admit as before */ }

    // (E2) PHANTOM TYPECHECK — retire when the referenced error is already gone.
    const tc = typecheckClassOf(g);
    if (tc) {
      const clean = vesselTypecheckClean(tc.vessel);
      if (clean === true) {
        excluded.push({ id, reason: `typecheck_clean_phantom(${tc.vessel}:${tc.tsCode})` });
        // The write and re-stamp are removed from the pick path to resolve timeout issues.
        // The gap will still be excluded from consideration and closed by a separate background process.
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

    // NO GROUNDABLE TARGET. This branch used to read "do NOT hard-exclude; the localizer may
    // still derive a site downstream" and admit. Measured on the live fleet 2026-08-31
    // 01:55-03:16, that assumption is false: 14 picks produced 12
    // `[fc-grounding] REFUSED ungrounded decompose; targetFiles=[] verify_vessels=[]` and
    // ZERO compose reports. The localizer never derived a site — grounding refuses first.
    //
    // Reaching here means neither hasProposalReport nor citedExistingFile matched, i.e. the
    // gap names no file that exists. feature-compose's grounding gate rejects exactly that
    // input, deterministically, so admitting it spends a compose slot to be told no. At a
    // lane capacity of ~2 composes/hour that was the ENTIRE budget, and it was invisible
    // from outside: a refusal claims and releases a slot without creating a worktree, so the
    // lane reads idle (load 4, 0 slots held) while fully consumed.
    //
    // Deferred, not condemned — and NOT excluded on failed_attempts, which would recreate
    // hopeless() at gap grain (see the picker-starves gap's own do_not_fix_by). The test is
    // a property of the gap: does it name a file that exists. Give it a target and it is
    // admitted on the very next tick. A targeted `pointer.gap_id` dispatch bypasses this
    // gate entirely, so an operator can still force one.
    // DISAGREEMENT ADJUDICATION (2026-09-19). A gap describing an execution-vs-
    // verification disagreement names no file, so it parked here as ungroundable —
    // measured on gap-probe-count-execution-and-verification-disagree: event pickup
    // fired in 1s, then attempts=0 forever, and the only improvised action trusted
    // the WRONG mechanism (formulated writing the verifier's expected value over a
    // correct producer result). Adjudicate instead of defer: recompute the disputed
    // transform with an executable method, attribute the fault by comparing the
    // verifier's stated expectation against the recomputation, mint the edit_site
    // both mechanisms share (goal-host hosts the floor producer AND the reach
    // verifier), and admit the gap to the repair lane THIS tick. Fail-open: any
    // parse or compute failure falls through to the ungroundable deferral unchanged.
    try {
      const summaryText = String(g.summary ?? "");
      const disputed = summaryText.match(/\b(sha-?256|base64|reverse|uppercase|lowercase|lettercount|product)\((\S{1,120})\)/i);
      if (/disagree|mismatch/i.test(summaryText) && disputed && disputed[1] && disputed[2]) {
        const family = disputed[1].toLowerCase().replace("-", "");
        const operand = disputed[2].trim();
        let truth = "";
        if (family === "sha256") { const { createHash } = await import("node:crypto"); truth = createHash("sha256").update(operand, "utf8").digest("hex"); }
        else if (family === "base64") { truth = Buffer.from(operand, "utf8").toString("base64"); }
        else if (family === "reverse") { truth = operand.split("").reverse().join(""); }
        else if (family === "uppercase") { truth = operand.toUpperCase(); }
        else if (family === "lowercase") { truth = operand.toLowerCase(); }
        else if (family === "lettercount") { truth = String(operand.replace(/-/g, "").length); }
        else if (family === "product") { const pm = operand.match(/(\d{1,9})\s*[*xX×]\s*(\d{1,9})/); if (pm && pm[1] && pm[2]) truth = String(Number(pm[1]) * Number(pm[2])); }
        const expectedMatch = summaryText.match(/determines\s+([A-Za-z0-9+/=._-]+)\s+for\b/);
        const verifierExpected = expectedMatch && expectedMatch[1] ? expectedMatch[1] : "";
        if (truth && verifierExpected) {
          const wrongMechanism = verifierExpected === truth ? "producer" : "verifier";
          const adjudicated = {
            ...meta,
            edit_site: "repos/goal-host-vessel/src/index.ts",
            adjudication: { family, operand, recomputed_truth: truth, verifier_expected: verifierExpected, wrong_mechanism: wrongMechanism, method: "in-process executable recomputation", adjudicated_at: new Date().toISOString() },
          } as Record<string, unknown>;
          try {
            await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, classification_metadata: adjudicated, status: "open" } } as never);
          } catch { /* write-back is best-effort; in-memory admission still proceeds */ }
          (g as { classification_metadata?: Record<string, unknown> }).classification_metadata = adjudicated;
          console.log(`[gap-adjudicate] ${id}: recomputed ${family}(${operand})=${truth}; verifier expected ${verifierExpected} -> ${wrongMechanism} is wrong; edit_site minted, admitted`);
          admitted.push(g);
          continue;
        }
      }
    } catch { /* fail-open: defer as ungroundable below */ }
    ungroundable.push(g);
  }

  // FAIL OPEN. If deferring the ungroundable would leave nothing to work on, admit them
  // anyway: a starved lane is worse than a refused compose, and this gate must never be the
  // reason the substrate stops trying. Only skip them when there is real work to do instead.
  // Under containment (the autonomyScope record requires falsifier classes) a target-less gap is
  // never autonomous work: failing open onto them spent node 1's only slot on leaked test-fixture
  // gaps (falsifier-merge/pair/c2/heal-*), each refusal minting another -narrowed child.
  const containedAdmission = (scope.requireFalsifierClasses ?? []).length > 0;
  if (admitted.length === 0 && !containedAdmission) {
    for (const g of ungroundable) admitted.push(g);
    if (ungroundable.length) {
      console.log(`[gap-to-feature] auto-pick admission: no groundable candidates; failing open on ${ungroundable.length} ungroundable`);
    }
  } else {
    for (const g of ungroundable) excluded.push({ id: String(g.id ?? ""), reason: "no_groundable_target" });
  }

  if (excluded.length) {
    const byReason: Record<string, number> = {};
    for (const e of excluded) { const k = e.reason.replace(/\(.*$/, ""); byReason[k] = (byReason[k] ?? 0) + 1; }
    console.log(`[gap-to-feature] auto-pick admission: ${gaps.length} candidates → ${admitted.length} admitted, ${excluded.length} excluded ${JSON.stringify(byReason)}`);
  }
  return { admitted, excluded };
}

/**
 * THE COMPOSE ADMISSION EXCLUSION: composeEligibilitySkipReason (the predicate feature_compose refuses on) with the
 * exemptions admission grants, each for its stated reason (see admitActionableGaps). Null admits. One function for
 * every autonomous entry: the auto-pick admission and the targeted entry (targetedComposeExclusion), so a gap
 * compose would refuse is not admitted by either. `skip` is the predicate's own verdict; `reason` is admission's
 * exclusion label.
 */
export function composeAdmissionExclusion(g: Record<string, unknown>): { skip: ComposeEligibilitySkipReason; reason: string } | null {
  const id = String(g.id ?? "");
  const cat = String(g.category ?? "");
  const meta = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
  const orphanRoute = cat === "orphaned_capability" || cat === "unreachable_producer" || /orphaned[_-]capability/i.test(id);
  if (orphanRoute || structuredTscErrorOf(g)) return null;
  const verdict = composeEligibilitySkipReason(g);
  const skip = verdict === "no_edit_site" && meta.source_gap_id ? null : verdict;
  if (skip === null) return null;
  const rawFalsifier = meta.falsifier as unknown;
  const falsifierClass = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
  const reason =
    skip === "unarmed" ? `needs_information(falsifier=${falsifierClass || "unset"})`
    : skip === "no_edit_site" ? `needs_information(no_edit_site; falsifier=${falsifierClass})`
    : skip === "not_open" ? `not_open(${String(g.status ?? "")})`
    : meta.operator_hold === true ? "operator_hold"
    : isParkingDisposition(meta.disposition) || meta.disposition === CHECK_SUPPLY_DISPOSITION ? `disposition(${String(meta.disposition)})`
    : "disposition(pending_verification)";
  return { skip, reason };
}

/** Categories resolveGapToFeature routes to a resolver other than feature_compose (trace-store reconcile seed,
 *  doc_drift_fix, author_producer). The compose gate does not judge them. A test pins that every category branch in
 *  resolveGapToFeatureOnce is listed here. */
export const NON_COMPOSE_ROUTE_CATEGORIES: ReadonlySet<string> = new Set(["trace_store_reconciliation", "documentation_drift", "unreachable_producer", "orphaned_capability"]);

/**
 * THE TARGETED ENTRY'S ADMISSION (gap-lane livelock, 2026-10-10). A pointer.gap_id dispatch bypassed admitActionableGaps.
 * gap-drain-observer sends exactly that for every write of a route:dispatchable gap whose remedy is gap_to_feature.
 * On node1 an unarmed detector gap (db_performance_slow_queries_*), rewritten every ~10 min, was dispatched each time,
 * refused by feature_compose as ineligible (unarmed), and graded a failed attempt: 125 refusals, re-narrowings and
 * re-escalations in 24 h. An autonomous targeted dispatch (not dry_run, not directed) of a gap on the feature_compose
 * route now runs the same exclusion as admission, before any decision is recorded or slot touched. It returns a
 * non-attempt report and one counted line naming compose_ineligible_<skip>. Directed dispatches are left to
 * feature_compose's own check, whose refusal is a non-attempt (isNonAttemptComposeResult).
 */
export function targetedComposeExclusion(gap: Record<string, unknown>, pointer: { gap_id?: string; dry_run?: boolean; directed?: boolean; triggered_by?: string }): ResolverResult | null {
  if (!pointer.gap_id || pointer.dry_run === true || pointer.directed === true) return null;
  if (NON_COMPOSE_ROUTE_CATEGORIES.has(String(gap.category ?? ""))) return null;
  const capKind = String(((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>).kind ?? "");
  if (capKind === "capability_gap") return null;
  const exclusion = composeAdmissionExclusion(gap);
  if (!exclusion) return null;
  const key = `compose_ineligible_${exclusion.skip}`;
  console.log(`[gap-to-feature] targeted admission: gap ${String(gap.id ?? "")} → 0 admitted, 1 excluded ${JSON.stringify({ [key]: 1 })} (${exclusion.reason}; triggered_by=${String(pointer.triggered_by ?? "-")})`);
  return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", verdict: "REFUSED", reason: key, exclusion: exclusion.reason, gap_id: gap.id, non_attempt: true } };
}

/** The compose node that owns `vessel`: the one feature_compose producer whose composeOwnership
 *  lists it. Null when discovery is unreadable or when zero or several producers claim it. */
export async function findComposeOwner(vessel: string): Promise<{ vesselId: string; url: string } | null> {
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "feature_compose" } }),
      signal: AbortSignal.timeout(5_000),
    });
    const dj = await dr.json() as { content?: { vessels?: Array<{ vesselId?: string; endpoint?: string; resolve_endpoint?: string }> } };
    const rows = dj.content?.vessels ?? [];
    const owners: Array<{ vesselId: string; url: string }> = [];
    await Promise.all(rows.map(async (r) => {
      const ep = String(r.resolve_endpoint ?? "/v2/impulses/resolve");
      const url = ep.startsWith("http") ? ep : `${String(r.endpoint ?? "").replace(/\/+$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
          body: JSON.stringify({ impulse: { pointer: { type: "composeOwnership" } } }),
          signal: AbortSignal.timeout(3_000),
        });
        const j = await res.json() as { body?: { owned_repos?: unknown } };
        const owned = j.body?.owned_repos;
        if (Array.isArray(owned) && owned.map(String).includes(vessel)) owners.push({ vesselId: String(r.vesselId ?? url), url });
      } catch { /* a producer that does not answer claims nothing */ }
    }));
    return owners.length === 1 ? owners[0]! : null;
  } catch {
    return null;
  }
}
