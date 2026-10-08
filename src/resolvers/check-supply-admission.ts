/**
 * CHECK-SUPPLY ADMISSION (slice G of the supply->lane test-writing mode, 2026-10-08).
 *
 * gap-check-supply (gap-check-supply.ts) writes the failing test for an UNARMED gap: unarmed is its entry criterion.
 * It dispatches the test-writing goal with structured variables { gap_id, check_supply: true }, and records the
 * dispatchId /run-goal returned in the gap's ledger (classification_metadata.check_supply: state "goal_dispatched",
 * dispatch_id). goal-host's edit-intent route carries that as the pointer field check_supply: { gap_id, dispatch_id }.
 * feature_compose's admission (composeEligibilitySkipReason) refused every such compose "not compose work: unarmed":
 * measured node1+compose2 2026-10-05..10-08, 24 treatment dispatches, 0 reached.
 *
 * THE LEDGER IS THE AUTHORITY, NOT THE MARKER. Any caller can put fields on a pointer; only the supply writes its own
 * ledger after dispatching. So the unarmed reason is waived exactly when the STORED row's ledger says the supply
 * dispatched this gap with THIS dispatch id, and nothing else is waived: composeEligibilitySkipReason returns
 * "unarmed" before it looks at the edit site or the hold, so this predicate re-applies the hold checks itself (open,
 * no operator hold, no parking disposition, no landing awaiting its verdict), allowing only the supply's own
 * disposition (CHECK_SUPPLY_DISPOSITION), and skips the edit-site check (a test-writing target is the test file).
 *
 * The supply writes its ledger AFTER goal-host's 202, so a compose can read the store before the write lands (on a
 * retry it then reads the previous attempt's dispatch id). The marked path re-reads, bounded, before refusing.
 */
import { CHECK_SUPPLY_DISPOSITION, isAwaitingLandVerification, isParkingDisposition } from "./gap-to-feature.js";

/** The compose mode an admitted supply compose runs in: read by the R3 diff gates and the verify's check judgement (B′). */
export const CHECK_SUPPLY_COMPOSE_MODE = "test_writing";

export type CheckSupplyMarker = { gap_id: string; dispatch_id: string };

/** The structured marker on a feature_compose pointer, or null. Never derived from spec or goal text. */
export function checkSupplyMarkerOf(pointer: unknown): CheckSupplyMarker | null {
  const m = (pointer as { check_supply?: unknown } | null | undefined)?.check_supply;
  if (!m || typeof m !== "object") return null;
  const { gap_id, dispatch_id } = m as { gap_id?: unknown; dispatch_id?: unknown };
  if (typeof gap_id !== "string" || gap_id.length === 0 || typeof dispatch_id !== "string" || dispatch_id.length === 0) return null;
  return { gap_id, dispatch_id };
}

export type CheckSupplyAdmission =
  | { admit: true }
  | { admit: false; why: "marker_gap_mismatch" | "dispatch_id_mismatch" | "ledger_mismatch" | "not_unarmed" | "held" | "not_open" };

/**
 * Whether a stored row is test-writing work for the supply's dispatch named by `marker`. `skipReason` is the row's
 * composeEligibilitySkipReason; only "unarmed" can be waived. `composeGapId` is the pointer's gap id and
 * `authoringExecutionId` the pointer's dispatch id (goal-host sets both from the same variables).
 */
export function checkSupplyAdmission(
  stored: Record<string, unknown>,
  marker: CheckSupplyMarker,
  composeGapId: string,
  authoringExecutionId: unknown,
  skipReason: string | null,
): CheckSupplyAdmission {
  if (skipReason !== "unarmed") return { admit: false, why: "not_unarmed" };
  if (marker.gap_id !== composeGapId || String(stored["id"] ?? "") !== composeGapId) return { admit: false, why: "marker_gap_mismatch" };
  if (typeof authoringExecutionId === "string" && authoringExecutionId !== marker.dispatch_id) return { admit: false, why: "dispatch_id_mismatch" };
  if (String(stored["status"] ?? "open") !== "open") return { admit: false, why: "not_open" };
  const rawMeta = stored["classification_metadata"] ?? stored["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  if (meta["operator_hold"] === true || (meta["disposition"] !== CHECK_SUPPLY_DISPOSITION && isParkingDisposition(meta["disposition"])) || isAwaitingLandVerification(stored)) {
    return { admit: false, why: "held" };
  }
  const ledger = meta["check_supply"];
  if (!ledger || typeof ledger !== "object") return { admit: false, why: "ledger_mismatch" };
  const { state, dispatch_id } = ledger as { state?: unknown; dispatch_id?: unknown };
  if (state !== "goal_dispatched" || typeof dispatch_id !== "string" || dispatch_id !== marker.dispatch_id) return { admit: false, why: "ledger_mismatch" };
  return { admit: true };
}

type LedgerWait = { attempts: number; delay_ms: number; read_timeout_ms: number };
/** Covers the supply's ledger write landing after goal-host's 202 (one self-resolve write): ~10 s in all. */
const DEFAULT_LEDGER_WAIT: LedgerWait = { attempts: 5, delay_ms: 2_000, read_timeout_ms: 10_000 };
let ledgerWait: LedgerWait = DEFAULT_LEDGER_WAIT;
export function checkSupplyLedgerWait(): LedgerWait { return ledgerWait; }
/** Test seam: shorten the bounded re-read; null restores the default. */
export function __setCheckSupplyLedgerWaitForTests(w: Partial<LedgerWait> | null): void {
  ledgerWait = w ? { ...DEFAULT_LEDGER_WAIT, ...w } : DEFAULT_LEDGER_WAIT;
}

/** A read that does not answer within `ms` is unreadable (null), never an admission. */
export async function readWithin<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * THE SUPPLY'S CHECK FILE NAME (B′): one per gap, defined once. gap-check-supply's checkSupplyTestFile places it at
 * test/checks/<this>; the R3 gate below allows a test_writing compose to write exactly that path and nothing else.
 * The gap id lower-cased, every non-alphanumeric run as "-", trimmed, at most 60 characters, suffix ".check.ts".
 * bun's default discovery collects only *.test.* / *.spec.* / *_test.* / *_spec.* names, so a .check.ts never runs
 * in a whole-suite run (pre-cutover, post-land, pull-sync); test_suite runs it as ./<path> (P0).
 */
export function checkSupplyCheckFile(gapId: string): string {
  const slug = String(gapId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return `${slug || "unnamed"}.check.ts`;
}

/** The vessel-relative path of a gap's check: test/checks/<checkSupplyCheckFile(gapId)>. */
export function checkSupplyCheckPath(gapId: string): string {
  return `test/checks/${checkSupplyCheckFile(gapId)}`;
}

/** A diff path in its vessel-relative form (after repos/<vessel>/ or .../vessels/<vessel>/), or null for a '..' path. */
function vesselRelativePath(path: string): string | null {
  const p = String(path ?? "").replace(/:\d+.*$/, "").trim().replace(/\\/g, "/");
  if (!p || p.split("/").includes("..")) return null;
  return /(?:^|\/)repos\/[^/]+\/(.+)$/.exec(p)?.[1] ?? /\/vessels\/[^/]+\/(.+)$/.exec(p)?.[1] ?? p.replace(/^(?:\.\/)+/, "");
}

/**
 * A TEST-WRITING COMPOSE LANDS ITS ONE CHECK FILE ONLY (slice G revision R3, narrowed by B′ P1). An admitted
 * test_writing compose runs land:true with no falsifier of its own, and "Do not change src/." is goal prose the
 * drafter can ignore. THE RULE: a path is resolved to its vessel-relative form (after repos/<vessel>/, or after
 * .../vessels/<vessel>/ for an absolute runtime or clone path; a bare relative path is taken as vessel-relative), and
 * the ONLY path allowed is exactly test/checks/<checkSupplyCheckFile(gapId)>. Every other path is refused: another
 * gap's check, any discovered *.test.ts (an intended red there reads as a regression in every whole-suite run),
 * fixtures, src, package.json, config, a '..' path. No gap id allows nothing (fail closed). Which vessel a path may
 * touch stays the verify_vessels gate's job.
 */
export function testWritingPathAllowed(path: string, gapId: unknown): boolean {
  if (typeof gapId !== "string" || gapId.length === 0) return false;
  return vesselRelativePath(path) === checkSupplyCheckPath(gapId);
}

/** The paths a compose in `composeMode` may not land: every path but the gap's check when the mode is test_writing, else none. */
export function testWritingDiffOutsideTests(composeMode: unknown, paths: string[], gapId?: unknown): string[] {
  if (composeMode !== CHECK_SUPPLY_COMPOSE_MODE) return [];
  return [...new Set(paths.filter((p) => !testWritingPathAllowed(p, gapId)))];
}

/**
 * W2: THE CHECK MUST IMPORT THE GAP'S EDIT SITE (B′). A red that does not load the module the gap names reproduces
 * nothing the lane can fix (expect(1).toBe(2) is red for every gap). The rule, shared by feature_compose's verify and
 * gap-check-supply's arm step so they agree:
 *   - an edit site is given (vessel-relative after stripping repos/<vessel>/ and any :line suffix): it must be a TS/JS
 *     module (.ts .tsx .js .jsx .mts .cts .mjs .cjs, not .d.ts), else edit_site_not_importable; and the check must
 *     import it (scope-earn-in.ts testImportsFile: static `from`, bare `import "…"`, a namespace import, dynamic
 *     `import(…)`, `require(…)`; comments stripped; extension optional, /index allowed), else
 *     test_writing_check_misses_edit_site.
 *   - no edit site: the check must import an EXISTING src/ module of its vessel (the first one found becomes the edit
 *     site), else test_writing_check_misses_edit_site.
 * Known limit (v1, accepted): a check importing the edit site only through a re-export or barrel module is refused.
 */
export type EditSiteImport = { ok: true; edit_site: string } | { ok: false; stage: "edit_site_not_importable" | "test_writing_check_misses_edit_site"; reason: string; edit_site: string | null };
const IMPORTABLE_RE = /\.(?:[cm]?[jt]sx?)$/;
export function vesselRelativeEditSite(editSite: unknown): string | null {
  if (typeof editSite !== "string" || !editSite.trim()) return null;
  const s = editSite.trim().replace(/:\d+.*$/, "").replace(/\\/g, "/");
  return (/(?:^|\/)repos\/[^/]+\/(.+)$/.exec(s)?.[1] ?? /\/vessels\/[^/]+\/(.+)$/.exec(s)?.[1] ?? s.replace(/^(?:\.\/)+/, "")) || null;
}
export async function checkImportsEditSite(source: string, checkRel: string, editSite: unknown, srcExists: (rel: string) => boolean): Promise<EditSiteImport> {
  const { testImportsFile } = await import("./scope-earn-in.js");
  const rel = vesselRelativeEditSite(editSite);
  if (rel) {
    if (rel.split("/").includes("..") || !IMPORTABLE_RE.test(rel) || /\.d\.[cm]?ts$/.test(rel)) {
      return { ok: false, stage: "edit_site_not_importable", edit_site: rel, reason: `the gap's edit site ${rel} is not an importable TS/JS module, so no check can import it; a test-writing compose cannot reproduce it (the gap needs a different check)` };
    }
    if (!testImportsFile(source, checkRel, rel)) {
      return { ok: false, stage: "test_writing_check_misses_edit_site", edit_site: rel, reason: `the check does not import the edit site ${rel}: import it (e.g. import * as mod from "${posixRelative(checkRel, rel)}") and assert on what it does` };
    }
    return { ok: true, edit_site: rel };
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+)\1/g)) {
    const resolved = posixJoin(checkRel, m[2]!).replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (!resolved.startsWith("src/")) continue;
    for (const cand of [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}.mts`]) {
      if (srcExists(cand) && testImportsFile(source, checkRel, cand)) return { ok: true, edit_site: cand };
    }
  }
  return { ok: false, stage: "test_writing_check_misses_edit_site", edit_site: null, reason: "the gap names no edit site and the check imports no existing src/ module of its vessel: import the module the defect lives in and assert on it" };
}
function posixJoin(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
}
function posixRelative(fromFile: string, toRel: string): string {
  const from = fromFile.split("/").slice(0, -1), to = toRel.replace(IMPORTABLE_RE, "").split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(i).join("/")}`;
}

/** W1: how many times the verify runs the check (every run must be the same assertion red). */
export const TEST_WRITING_CHECK_RUNS = 3;

export type TestWritingJudgement = {
  ok: boolean;
  stage: null | "test_writing_check_not_red" | "test_writing_check_wrong_reason" | "test_writing_check_flaky" | "test_writing_check_misses_edit_site" | "edit_site_not_importable";
  cause?: string;
  reason: string;
  check_file: string;
  edit_site: string | null;
  runs: Array<{ verdict: string; keys: string[]; red: string[]; unhandled: boolean }>;
};

/**
 * B′ P2: THE VERIFY OF A test_writing COMPOSE. The check file test/checks/<checkSupplyCheckFile(gapId)> must exist in
 * the vessel root, import the gap's edit site (W2, checkImportsEditSite: static, before anything runs), and, run ALONE
 * `runs` times through `run` (feature_compose's shell; the caller supplies the command), be the same assertion red
 * every time (retry-evidence.ts testWritingRunsVerdict: the shared classifier). ok only then.
 */
export async function judgeTestWritingCheck(input: { gapId: string; vesselRoot: string; editSite: unknown; run: (checkRel: string) => Promise<string>; runs?: number }): Promise<TestWritingJudgement> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { testWritingRunsVerdict } = await import("./retry-evidence.js");
  const checkRel = checkSupplyCheckPath(input.gapId);
  const abs = `${input.vesselRoot}/${checkRel}`;
  const out = (stage: TestWritingJudgement["stage"], reason: string, extra: Partial<TestWritingJudgement> = {}): TestWritingJudgement => ({ ok: stage === null, stage, reason, check_file: checkRel, edit_site: vesselRelativeEditSite(input.editSite), runs: [], ...extra });
  let source: string | null = null;
  try { source = existsSync(abs) ? readFileSync(abs, "utf8") : null; } catch { source = null; }
  if (source === null) return out("test_writing_check_not_red", `the check file ${checkRel} was not written in this vessel: the supply's goal asks for exactly that file`);
  const site = await checkImportsEditSite(source, checkRel, input.editSite, (rel) => existsSync(`${input.vesselRoot}/${rel}`));
  if (!site.ok) return out(site.stage, site.reason, { edit_site: site.edit_site });
  const raws: string[] = [];
  const n = Math.max(1, Math.floor(input.runs ?? TEST_WRITING_CHECK_RUNS));
  for (let i = 0; i < n; i++) raws.push(await input.run(checkRel).catch((err) => `RUN_FAILED ${String(err).slice(0, 200)}`));
  const v = testWritingRunsVerdict(raws);
  const runs = v.runs.map((r) => ({ verdict: r.verdict, keys: r.keys.map((k) => k.replace("\u0000", " :: ")), red: r.red.slice(0, 10), unhandled: r.unhandled }));
  if (!v.ok) return out(v.stage, v.reason, { edit_site: site.edit_site, runs, ...(v.cause ? { cause: v.cause } : {}) });
  return out(null, `the check is the same assertion red on ${n} runs and imports ${site.edit_site}`, { edit_site: site.edit_site, runs });
}

/**
 * The detail line a refused check adds to the verify output. It never carries bun's "timed out after <n>ms" text:
 * composeFailureKind reads that pattern in a verify output as an ENVIRONMENT non-attempt, and a check refused for
 * timing out is the draft's fault.
 */
export function testWritingDetail(j: TestWritingJudgement): string {
  if (j.ok) return "";
  const text = ` | THE TEST-WRITING CHECK ${j.check_file} IS REFUSED (${j.stage}${j.cause ? `: ${j.cause}` : ""}): ${j.reason}`;
  return text.replace(/timed out after (\d+)\s*ms/gi, "timed out ($1 ms budget)").slice(0, 1200);
}
