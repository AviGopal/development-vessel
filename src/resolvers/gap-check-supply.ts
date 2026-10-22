/**
 * gap_check_supply_tick — the substrate writes the failing test a gap needs before the lane can take it
 * (REALIGNMENT §2.3 supply contract). WIRING, NOT A NEW SUBSYSTEM (§2.0): every step is an organ that exists.
 *
 * The lane composes only ARMED gaps (composeEligibilitySkipReason: open, class1/class2, an edit site, not held).
 * A gap with no check of its own is excluded as needs_information on every pick, and until now the only way
 * out was an operator hand-writing a failing test and arming the gap from it. This tick does that work:
 *
 *   1. CLASSIFY (checkSupplyDisposition): an open, unheld gap with no class1/class2 check or no edit site, and
 *      no literal predicate of its own, is NEEDS-LOCALIZATION. Computed on read; the disposition
 *      (CHECK_SUPPLY_DISPOSITION, which the shared eligibility predicate holds) is written only on a row this
 *      tick dispatches for, never as a bulk label.
 *   2. DISPATCH: for at most the rhythm's max_per_tick such gaps, ONE edit-intent goal per gap through
 *      dispatch_goal, naming the gap's own OUT-OF-SUITE check file (B′): "Write ONE failing test in
 *      repos/<vessel>/test/checks/<slug>.check.ts that reproduces: <symptom>. …" (checkSupplyGoal: one test whose
 *      assertion fails because of the defect, the edit site imported as a namespace, no network, no src changes).
 *      bun's default discovery never runs a *.check.ts, so the intended red never reaches the pre-cutover suite, the
 *      post-land suite or pull-sync; the supply never APPENDS to an existing *.test.ts (a red there reads as a
 *      regression everywhere), and feature_compose's R3 gate lets a test_writing compose write that one path only.
 *      One file per goal. The row's check_supply ledger records the attempt and the titles the file already held; a gap is not asked
 *      again until its backoff (backoff_hours * 2^(attempts-1)) has passed, and after max_attempts it is marked
 *      exhausted, so the tick cannot livelock on a gap whose test never lands. CONTROL ARM: by hash(gap id)
 *      parity half the gaps are recorded (gap_check_supply_arm "control") and never sent a goal, so the supply's
 *      effect can be measured against gaps it did not touch.
 *   3. ARM: once new test titles exist in that file, they become a test_suite check. The test must IMPORT the
 *      edit site (the gap's own, the one its summary names, or, with none, an existing src module the test imports:
 *      check-supply-admission.ts checkImportsEditSite, the rule feature_compose's verify applies). The ONE judge
 *      (takeBirthVerdict, the birth seam's) runs it through test_suite (P0: ./<check path>) and its run report is
 *      read too: only 'present' with every named test among the run's failures AND each an ASSERTION by the shared
 *      classifier the report carries (red_reason, retry-evidence.ts classifyCheckRun: not a load error, a network
 *      call or a timeout) is written, through substrateGap_write with the verdict as the in-process trusted birth stamp,
 *      clearing the disposition in the same write. Green at HEAD, red for the wrong reason, a test that does
 *      not import the edit site, or one that reads a name its module does not export (check-supply-admission.ts
 *      missingExportRefusal: check_references_missing_export), or whose red asserts a shape or body field the function
 *      it calls never returns (contractMismatchRefusal: check_asserts_contract_mismatch) writes no check: the gap stays
 *      unarmed (fail closed). The first failure's error line and Expected/Received are kept on the ledger. No region is written, so
 *      the arm-time region gate has nothing to refuse; the write still passes through it.
 *
 * OUTCOME (the dispatch is read back; a dispatch alone earns no credit): every dispatch records the node that sent
 * it (dispatch_node, the substrate's bootstrap identity) and its goal-host. A gap still at goal_dispatched with no new
 * titles has its goal's outcome read from THAT node's goal-host (GET /executions/:id, the contract dispatch-goal.ts
 * reads): running waits; terminal and not reached is a FAILED attempt with the reach reason (state dispatch_failed);
 * terminal and reached with no new title after a grace is failed too. An outcome that cannot be read (not found on the
 * host, host unreachable, no dispatch id, a status this code does not know, a dispatch owned by another node that never
 * settles) is never read as failed: it waits, loudly, and only past a shaped staleness bound becomes dispatch_lost with
 * WHY it was lost. A settled gap (failed or lost) is retried after its backoff ahead of fresh gaps, and a gap whose
 * goal is in flight is never sent a second one. A gap whose target the live autonomyScope excludes gets no goal and one
 * skip record (state scope_excluded): the lane could never land it. Bounds are read from the family's rhythm body.
 * PLACEMENT (compose-placement.ts, law 11): with no free local compose slot of the supply's class, the goal goes through
 * the development-vessel of a peer that composes the vessel, sees the row, admits the targets and has a free slot, so
 * the compose runs where capacity is while the store holder stays authoritative for the row. Its ledger names that
 * peer as dispatch_node (placed_by this node); unread here, it settles by arming or, unsettled, by dispatch_timeout_hours.
 *
 * CADENCE IS A RHYTHM (law 5). The family's timeShapedRhythm impulse is read at use time: no rhythm means no
 * work (reason no_rhythm), a rhythm not due by the conductor's own formula (rhythmDueScore) means no DISPATCH (the
 * bookkeeping, ARM, OUTCOME, the own-check un-arm and the hold release, runs on every pass, at most once per shaped
 * bookkeeping_min_interval_s when undue), and the per-tick bound, backoff and attempt cap come from the same impulse's
 * body. The rhythm conductor fires the family through FAMILY_RESOLVERS and leaves it PENDING, and on its other passes
 * asks for the bookkeeping alone through FAMILY_BOOKKEEPING (bookkeeping_only); this resolver settles its family from
 * its REPORT when it completes (checkSupplySettlementLeg), whichever entry ran it, so no exit is ever credited as success.
 *
 * MEASURES (counters on the report, not traces): of the armed gaps whose check was born in the window, the
 * share whose check the system wrote (predicate_source gap_check_supply), and of those the share verified red
 * at HEAD (predicate_birth_verdict present).
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ResolverResult } from "./types.js";
import { birthTreeMoved, class2PredicateKey, DETECTOR_ROW_UNARMABLE_REASON, gapStoreIsLocal, predicateSuspect, resolveSubstrateGap, resolveSubstrateGapWrite, takeBirthVerdictWithReport, unrenderedBindingToken, type MintedBirthVerdict } from "./substrate-gap.js";
import {
  CHECK_SUPPLY_DISPOSITION,
  composeEligibilitySkipReason,
  EDIT_SITE_IS_OWN_CHECK,
  editSiteIsOwnCheck,
  gapEditSite,
  ownCheckUnarmMeta,
  isAwaitingLandVerification,
  isParkingDisposition,
} from "../judge/gap-eligibility.js";
import { autonomyScopeExcludes, identifyVessel, parseScopeExceptions, type AutonomyScope } from "../judge/gap-policy.js";
import { checkImportsEditSite, checkSupplyCheckPath, configEditSite, castCalleeRefusal, configSiteCheckGoal, consumerResolverModules, contractMismatchRefusal, exportGuardUnavailable, MISSING_EXPORT_STAGE, missingExportRefusal, moduleExports, srcReaderAt, vesselRelativeEditSite, type SrcReader } from "./check-supply-admission.js";
import { codeContract } from "./code-introspect.js";
import { readFamilyRhythm, rhythmDueScore, rhythmSettlementOverlay, type RhythmBody } from "./rhythm-conductor-tick.js";
// The check-run judge lives with the evaluator (scope-earn-in.ts, an excluded file): item 2 reads it from there.
import { coverageKnobs, redForTheRightReason, selectMutants, type Mutant } from "./scope-earn-in.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";
import { dispatchGoalOnPeer, placeCompose } from "./compose-placement.js";
import { armRedReasonRefusal, testTitleInSource, type CheckRunClass } from "./retry-evidence.js";
import { onlyTestsProblem, resolveTestSuite } from "./test-suite.js";
import { selfAuthHeaders } from "../lib/self-auth.js";
import { METABOB_API_KEY } from "../config.js";
import { gapCheckTimeoutMs } from "../judge/gap-check-judge.js";

export const CHECK_SUPPLY_FAMILY = "gap-check-supply";
/** The predicate_source a system-authored check carries: the discriminator the measures count. */
export const CHECK_SUPPLY_SOURCE = "gap_check_supply";

const DEV_SELF_ENDPOINT = process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";
const SELF_RESOLVE_URL = `${DEV_SELF_ENDPOINT}/v2/impulses/resolve`;

type Row = Record<string, unknown>;
type Ledger = {
  state?: string;
  attempts?: number;
  last_dispatch_at?: string;
  test_file?: string;
  vessel?: string;
  dispatch_id?: string | null;
  goal?: string;
  armed_at?: string;
  red_at_head?: boolean;
  last_verdict?: string;
  reason?: string;
  mode?: string;
  baseline_titles?: string[];
  edit_site?: string | null;
  /** The node that sent the goal (its bootstrap identity) and its goal-host: the only place its outcome can be read. */
  dispatch_node?: string;
  dispatch_host?: string;
  /** Set when THIS node placed the goal on a peer with a free compose slot (compose-placement.ts): the sender, and why. */
  placed_by?: string;
  placement?: string;
  /** The outcome read back for the last dispatch (status, reached, why it was lost, where and when it was read). */
  outcome?: Row;
  /** The settled attempts before the current one (state, reason, outcome), newest last, at most five. */
  history?: Row[];
  /** A NON-ATTEMPT (state non_attempt / send_refused) is not sent again before this instant (CHANGE-30). */
  not_before?: string;
  /** CONSECUTIVE non-attempts/refusals since the last SETTLED outcome (failed, lost, armed): each one doubles the
   *  wait up to the shaped cap, so a receiver that never takes the gap cannot be sent it without bound. */
  non_attempt_streak?: number;
  /** The new titles the arm step judged on the last attempt (kept so the next attempt can be told which check did not reproduce). */
  judged_titles?: string[];
  /** Set on an armed record when the missing-export guard could not run (typescript unavailable): it decided nothing. */
  guard_decided_nothing?: string;
  /** The edit-site mutation gate's reading at arm time (EDIT-SITE MUTATION GATE): mutants run, how many changed the red. */
  mutation_gate?: Row;
};
// A CHECK THAT WAS JUDGED AND NOT ARMED IS A SETTLED ATTEMPT TOO. Only failed and lost dispatches were kept, so a check
// that landed green at HEAD (or red for the wrong reason) left no trace and the next attempt was sent the same goal text.
const JUDGED_NOT_ARMED: ReadonlySet<string> = new Set(["green_at_head", "arm_refused", "existence_only"]);
const settledHistory = (l: Ledger): Row[] => {
  const prior = Array.isArray(l.history) ? l.history.slice(-4) : [];
  if (l.state === "dispatch_failed" || l.state === "dispatch_lost")
    return [...prior, { attempt: Number(l.attempts ?? 0), state: l.state, reason: l.reason ?? "", outcome: l.outcome ?? {} }];
  if (JUDGED_NOT_ARMED.has(String(l.state ?? "")))
    return [...prior, { attempt: Number(l.attempts ?? 0), state: l.state, reason: l.reason ?? "", titles: Array.isArray(l.judged_titles) ? l.judged_titles : [] }];
  return prior;
};

export interface GapCheckSupplyTickPointer {
  type: "gap_check_supply_tick";
  /** The tick's clock (ms). Tests pin it; production reads Date.now(). */
  now_ms?: number;
  /** Carried by the conductor's FAMILY_RESOLVERS entry ("report"): this resolver settles its family by its report. */
  settled_by?: string;
  /** Carried by the conductor's FAMILY_BOOKKEEPING entry: the bookkeeping steps only (arm, outcome, un-arm, hold
   *  release), never a dispatch, whatever the rhythm's due-ness. */
  bookkeeping_only?: boolean;
  dry_run?: boolean;
}

const metaOf = (row: Row): Row => {
  const m = row["classification_metadata"] ?? row["metadata"];
  return (m && typeof m === "object" ? m : {}) as Row;
};
const ledgerOf = (meta: Row): Ledger => (meta["check_supply"] && typeof meta["check_supply"] === "object" ? meta["check_supply"] : {}) as Ledger;
const falsifierClassOf = (meta: Row): string => {
  const f = meta["falsifier"];
  return String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
};
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
/** A check run's first failure from its red_reason (retry-evidence.ts classifyCheckRun): name, error line, and Expected/Received when it is an assertion. */
const firstFailureOf = (redReason: unknown): Row | null => {
  const c = redReason as { failures?: unknown; compared?: unknown } | null | undefined;
  const f = Array.isArray(c?.failures) ? (c!.failures[0] as { name?: unknown; error?: unknown } | undefined) : undefined;
  if (!f || typeof f !== "object") return null;
  const v = Array.isArray(c?.compared) ? (c!.compared as Array<{ name?: unknown; expected?: unknown; received?: unknown } | null>).find((x) => x?.name === f.name) : undefined;
  return { name: f.name ?? null, error: f.error ?? null, expected: v?.expected ?? null, received: v?.received ?? null };
};
const clonesRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";
const runtimeRoot = (): string => process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";

/**
 * NEEDS-LOCALIZATION: an open gap the lane cannot take only because it has no check of its own (or no edit site),
 * and that nothing else holds. null for every gap that is compose work already, held by a human or a landing,
 * closed, carrying a literal predicate of its own (a different repair), routed elsewhere (orphan producers), or a
 * detector row nothing can arm (substrate-gap.ts A DETECTOR ROW NOTHING CAN ARM: no site and no file to localize from).
 */
export function checkSupplyDisposition(row: Row): typeof CHECK_SUPPLY_DISPOSITION | null {
  if (String(row["status"] ?? "open") !== "open") return null;
  const meta = metaOf(row);
  if (meta["operator_hold"] === true || isParkingDisposition(meta["disposition"]) || isAwaitingLandVerification(row)) return null;
  // Skip re-commit children: these summarize a discarded draft's failure, not a HEAD defect.
  // feature_compose files these with summary 'compose for gap X repeated already-recorded failure class <cls>: ...'
  // and classification_metadata { re_commit:true, source_gap_id, root_gap_id, failure_class, edit_site } (feature-compose.ts:5340-5358).
  // Fallback: if metadata is absent, use id prefix 'recommit-'.
  {
    const id = String(row["id"] ?? "");
    const isRecommit = id.startsWith("recommit-") || (meta["re_commit"] === true && nonEmpty(meta["failure_class"]));
    if (isRecommit) return null;
  }
  if (nonEmpty(meta["expected_literal"]) || nonEmpty(meta["hardcoded_url"])) return null;
  if (String(meta["falsifier_unresolvable_reason"] ?? "").startsWith(DETECTOR_ROW_UNARMABLE_REASON)) return null;
  const cat = String(row["category"] ?? "");
  if (cat === "orphaned_capability" || cat === "unreachable_producer") return null;
  const skip = composeEligibilitySkipReason(row);
  return skip === "unarmed" || skip === "no_edit_site" ? CHECK_SUPPLY_DISPOSITION : null;
}

/** The vessel a gap's test belongs in: the lane's own identification first, then a vessel named in the summary. */
export function checkSupplyVessel(row: Row): string | null {
  const meta = metaOf(row);
  const ledgerVessel = ledgerOf(meta).vessel;
  if (typeof ledgerVessel === "string" && /^[A-Za-z0-9_.-]+$/.test(ledgerVessel)) return ledgerVessel;
  const known = identifyVessel(row, meta);
  if (known) return known;
  const summary = String(row["summary"] ?? "");
  const exists = (v: string): boolean => existsSync(join(runtimeRoot(), v)) || existsSync(join(clonesRoot(), v));
  const named = /repos\/([A-Za-z0-9_.-]+)\//.exec(summary)?.[1];
  if (named && exists(named)) return named;
  for (const m of summary.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:vessel|api))\b/g)) {
    if (m[1] && exists(m[1])) return m[1];
  }
  return null;
}

/** The file a gap's check is written to: one per gap, OUT OF SUITE, test/checks/<checkSupplyCheckFile(gapId)> (the slug
 *  is defined once, in check-supply-admission.ts, where feature_compose's R3 gate allows exactly this path). */
export function checkSupplyTestFile(gapId: string): string {
  return checkSupplyCheckPath(gapId);
}

/** The split the control arm was born with: half of all gaps, by hash parity. */
export const HISTORICAL_CONTROL_FRACTION = 0.5;
/** A gap's experiment arm, stable for its id. Control-arm gaps are classified but get no goal, so the supply's effect
 *  on arming and closure can be measured against gaps it did not touch (law 12).
 *
 *  THE SPLIT IS SHAPED. It was a fixed half, an indefinite hold over about 41% of the system's own detections with no
 *  end date or review (user ruling 2026-10-14: lift it after the capacity window, the fraction moving into the supply
 *  rhythm's record with a default of 0, so the system can set it). The tick passes the record's control_fraction. The
 *  id's position is a stable value in [0,1) built so that at exactly 0.5 the arms are the historical parity arms (the
 *  earlier measurement stays comparable); 0 puts every gap in treatment, 1 every gap in control. */
export function checkSupplyArm(gapId: string, controlFraction: number = HISTORICAL_CONTROL_FRACTION): "treatment" | "control" {
  const b = createHash("sha256").update(gapId).digest()[0]!;
  const position = ((((b & 1) ^ 1) * 128) + (b >> 1)) / 256; // parity 1 (the historical control) falls in [0, 0.5)
  return position < controlFraction ? "control" : "treatment";
}

const symptomOf = (summary: string): string => summary
  .replace(/^(?:Close substrate gap [\w:.!-]+:\s*)+/, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 600)
  .replace(/[\s.]+$/, "");

/** The edit site as the check imports it: its path relative to the check file, without the extension. */
function importSpecifier(testFile: string, siteRel: string): string {
  const from = testFile.split("/").slice(0, -1);
  const to = siteRel.replace(/\.(?:[cm]?[jt]sx?)$/, "").split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(i).join("/")}`;
}

/**
 * The goal: the one check file to write, the symptom to reproduce, and what feature_compose's verify will enforce
 * (judgeTestWritingCheck): ONE test whose expect() assertion fails because of the defect, the edit site imported
 * (as a namespace, so a missing export is an assertion red, not a load error), no network, no src edits. The lead
 * sentence names only the check path (goal-host's edit-intent route targets the file the lead sentence names); the
 * edit site is named by its import specifier.
 */
/**
 * WHAT A CHECK MAY BE BUILT ON (C-invented-1). An EXISTENCE assertion is never a falsifier by itself: anything can be exported,
 * so a check that a symbol exists is closed by exporting it. The goal therefore never offers an example symbol, and a symbol
 * anchors a check only when it ALREADY RESOLVES in the code (used or declared in the edit site's code, or, with no edit site,
 * declared in the vessel's src), so its existence is already true and the red must come from its BEHAVIOUR.
 *  - symbol: a backticked, called (`x(`) or camelCase identifier from the evidence that resolves as above. A plain word is
 *    never one, even when the code exports it (an export is exactly what a hollow fix adds), and neither is a word that only
 *    the prose names (a shape name, a label) or that resolves only inside strings or comments;
 *  - text: an OBSERVED output in quotes (an error, a log line, a message, returned or printed text: said so by a nearby
 *    context word, or written in the falsifier_spec). A quoted goal or question is not an observed output;
 *  - behaviour: a stated actual-vs-expected pair ("returns 1; it must return 2").
 */
export type CheckAnchor = { kind: "symbol" | "text" | "behaviour"; value: string };
export const NO_ANCHOR_REASON = "evidence names no falsifiable anchor";
/** Code with comments and string literals blanked, so a name only quoted or commented does not resolve. */
const codeOnly = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
const DECLARATION = /\b(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
/** The names declared in a source file (code only). */
export function declaredNames(src: string): Set<string> {
  return new Set([...codeOnly(src).matchAll(DECLARATION)].map((m) => m[1]!));
}
const OUTPUT_CONTEXT = /\b(error|errors|throws?|thrown|logs?|logged|message|prints?|printed|returns?|returned|outputs?|says|reports?|responds?|answers?)\b[^."'`]{0,40}$/i;
export function falsifiableAnchors(evidence: string, siteSrc: string | null, spec = "", vesselDeclared: ReadonlySet<string> | null = null): CheckAnchor[] {
  const out: CheckAnchor[] = [];
  const add = (a: CheckAnchor) => { if (!out.some((x) => x.kind === a.kind && x.value === a.value)) out.push(a); };
  const ident = /^[A-Za-z_$][\w$]*$/;
  const siteCode = siteSrc !== null ? codeOnly(siteSrc) : null;
  const resolves = (name: string): boolean => siteCode !== null
    ? new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(siteCode)
    : !!vesselDeclared?.has(name);
  const candidates = new Set<string>();
  const all = `${evidence}\n${spec}`;
  for (const m of all.matchAll(/`([A-Za-z_$][\w$]*)`/g)) candidates.add(m[1]!);
  for (const m of all.matchAll(/\b([A-Za-z_$][\w$]{2,})\(/g)) candidates.add(m[1]!);
  for (const m of all.matchAll(/\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) if (m[1]!.length >= 5) candidates.add(m[1]!);
  for (const c of candidates) if (resolves(c)) add({ kind: "symbol", value: c });
  const quoted = (text: string, fromSpec: boolean) => {
    for (const m of text.matchAll(/`([^`\n]{1,200})`|"([^"\n]{1,200})"|'([^'\n]{1,200})'/g)) {
      const q = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (ident.test(q) || !/\s/.test(q) || q.length < 8 || /\?$/.test(q)) continue;
      if (fromSpec || OUTPUT_CONTEXT.test(text.slice(Math.max(0, m.index! - 60), m.index!))) add({ kind: "text", value: q });
    }
  };
  quoted(evidence, false);
  if (spec) quoted(spec, true);
  const b = /\b(returns?|yields?|produces?|gives?|is)\s+([^\s,;]+)[^.;]*[;,]?\s*(?:it\s+|but\s+)?(?:must|should)\s+(?:return|yield|produce|give|be)\s+([^\s,;.]+)/i.exec(all);
  if (b) add({ kind: "behaviour", value: b[0].trim() });
  return out;
}
const anchorText = (anchors: readonly CheckAnchor[]): string => anchors.map((a) => a.kind === "symbol" ? `symbol \`${a.value}\`` : a.kind === "text" ? `text ${JSON.stringify(a.value)}` : `behaviour "${a.value}"`).join("; ");

/**
 * QUOTE WHAT THE GATE WOULD READ AS AN UNRENDERED BINDING (CHANGE-32a). A check goal is built from a gap's own prose,
 * and a gap ABOUT placeholders quotes them ({{…}}, {{goal.id}}): pre-gate rows hold them unquoted. The gap-store write
 * gate (substrate-gap.ts unrenderedBindingToken) then refuses the whole ledger write that carries the goal, so the
 * supply could never record what it sent. The gate's own definition of a QUOTATION is a token wrapped in backticks;
 * this wraps exactly the tokens the gate flags, using the gate's own rule, until it flags none. One definition.
 */
export function quoteUnrenderedTokens(s: string): string {
  let out = s;
  for (let guard = 0; guard < 100; guard++) {
    const t = unrenderedBindingToken(out);
    if (t === null) return out;
    let i = out.indexOf(t);
    while (i >= 0 && out[i - 1] === "`" && out[i + t.length] === "`") i = out.indexOf(t, i + 1);
    if (i < 0) return out;
    out = `${out.slice(0, i)}\`${t}\`${out.slice(i + t.length)}`;
  }
  return out;
}
export function checkSupplyGoal(vessel: string, testFile: string, summary: string, site: string | null = null, reader?: SrcReader, anchors: readonly CheckAnchor[] = [], prior: readonly Row[] = []): string {
  return quoteUnrenderedTokens(checkSupplyGoalText(vessel, testFile, summary, site, reader, anchors, prior));
}
function checkSupplyGoalText(vessel: string, testFile: string, summary: string, site: string | null = null, reader?: SrcReader, anchors: readonly CheckAnchor[] = [], prior: readonly Row[] = []): string {
  const siteRel = vesselRelativeEditSite(site);
  // A CONFIG EDIT SITE (an activity seed or template) gets the consumer-behaviour goal (check-supply-admission.ts
  // configSiteCheckGoal): the arm step refuses a check that only reads the template's literals.
  const cfg = reader && siteRel ? configEditSite(siteRel, reader.read(siteRel)) : null;
  if (cfg && siteRel) {
    const consumerImports = consumerResolverModules(cfg.resolvers, reader!).map((module) => ({ module, spec: importSpecifier(testFile, module) }));
    return configSiteCheckGoal({ vessel, testFile, symptom: symptomOf(summary), siteRel, siteImport: importSpecifier(testFile, siteRel), templates: cfg.templates, resolvers: cfg.resolvers, consumerImports });
  }
  const imp = siteRel && /\.(?:[cm]?[jt]sx?)$/.test(siteRel)
    ? `Import the module the defect lives in as a namespace, import * as mod from "${importSpecifier(testFile, siteRel)}", and assert on it`
    : "Import the src module the defect lives in as a namespace (import * as mod from \"../../src/<file>\") and assert on it";
  const named = anchors.length
    ? `Build it on what the evidence names (${anchorText(anchors)}): call the code with an input and make the failing assertion on what it returns, throws, logs or prints (its behaviour, never its declaration). `
    : "";
  const exportsList = siteRel && /\.(?:[cm]?[jt]sx?)$/.test(siteRel) ? (reader ? exportListSentence(siteRel, reader, summary) : unreadSiteSentence(siteRel)) : "";
  return `Write ONE failing test in repos/${vessel}/${testFile} that reproduces: ${symptomOf(summary)}. ` +
    `Its expect() assertion fails because of the defect, not because the file fails to load: ${imp}. ` + exportsList + named +
    priorAttemptSentence(prior) +
    "No network, no services, no timers. Do not change src/ or any other file.";
}

/**
 * THE MODULE'S REAL EXPORTS, GIVEN TO THE CHECK WRITER (F-ARM). The writer drafted without them and invented one
 * (2f36f62, route-edit-bd252f8c: `mod["shellResult"]` on goal-host src/index.ts, where shellResult is a shape name):
 * the arm step now refuses such a check (check-supply-admission.ts missingExportRefusal), and this is the fact that
 * lets the writer avoid it. The list is read by the same extractor the refusal uses (moduleExports, over the clone the
 * goal's reader reads, the tree vesselTestInventory walks for the decompose prompt) and bounded like that prompt's
 * source list: at most EXPORT_LIST_MAX names, those the gap's own words name first, then source order, the rest
 * counted. The names are clamped by characters too (EXPORT_LIST_MAX_CHARS): dispatch_goal refuses a goal over
 * MAX_GOAL_LEN (8192), and 80 long names alone could pass it. Empty when the module exports nothing.
 * THE LIST IS THE MODULE'S CONTRACT (code-introspect.ts codeContract, the contract codeIntrospectResult returns with
 * include_contract, read in-process over this reader): each function is listed with its REAL signature (`name: kind
 * (parameters): ReturnType`), whatever route exports it (`export { … }`, a re-export, a default), and the `shape`
 * strings its returns carry where the return walk reads them.
 * Told only names and kinds, the writer invented call shapes: a row object where four numbers belong, `.shapes` read
 * off a function returning string[]. Signatures are clamped each (EXPORT_SIGNATURE_MAX) and in all
 * (EXPORT_SIGNATURES_MAX_CHARS), in the list's order; a name past either bound keeps its kind and loses only its
 * signature. A site that cannot be read is SAID to be unread (unreadSiteSentence), never silently left without a list.
 */
export const EXPORT_LIST_MAX = 80;
export const EXPORT_LIST_MAX_CHARS = 3000;
export const EXPORT_SIGNATURE_MAX = 200;
export const EXPORT_SIGNATURES_MAX_CHARS = 2000;
/** What the goal says when the edit site cannot be read here: no list, said plainly. */
export function unreadSiteSentence(siteRel: string): string {
  return `${siteRel} could not be read here, so its exports and their signatures are not listed: open it before writing the test, and call only what it exports, with the parameters each function declares. `;
}
export function exportListSentence(siteRel: string, reader: SrcReader, summary: string): string {
  const contract = codeContract(siteRel, reader);
  if ("unavailable" in contract) return contract.unavailable === "not readable" ? unreadSiteSentence(siteRel) : `${siteRel} could not be parsed here (${contract.unavailable}), so its exports and their signatures are not listed: open it before writing the test, and call only what it exports, with the parameters each function declares. `;
  const ex = { names: new Map(contract.exports.map((e) => [e.name, e.kind])), open: contract.open };
  if (ex.names.size === 0) return "";
  const words = summary.toLowerCase();
  const ranked = [...ex.names].map(([name, kind], i) => ({ name, kind, i, hit: name.length >= 3 && words.includes(name.toLowerCase()) ? 1 : 0 }))
    .sort((a, b) => b.hit - a.hit || a.i - b.i);
  const shown: typeof ranked = [];
  let chars = 0;
  for (const x of ranked) {
    if (shown.length >= EXPORT_LIST_MAX) break;
    const len = x.name.length + x.kind.length + 4; // "name: kind, "
    if (chars + len > EXPORT_LIST_MAX_CHARS) continue;
    shown.push(x);
    chars += len;
  }
  if (shown.length === 0) return "";
  const entries = new Map(contract.exports.map((e) => [e.name, e]));
  let sigChars = 0;
  const signed = new Map<string, string>();
  for (const x of shown) {
    const e = entries.get(x.name);
    if (!e?.signature) continue;
    const shapes = e.returned?.shapes?.length ? ` returning shape ${e.returned.shapes.map((s) => JSON.stringify(s)).join(" | ")}` : "";
    const v = `${e.signature}${shapes}`;
    const t = v.length > EXPORT_SIGNATURE_MAX ? `${v.slice(0, EXPORT_SIGNATURE_MAX - 1)}…` : v;
    if (sigChars + t.length + 1 > EXPORT_SIGNATURES_MAX_CHARS) continue;
    signed.set(x.name, t);
    sigChars += t.length + 1;
  }
  const more = ex.names.size - shown.length;
  return `${siteRel} exports ${more > 0 ? `${ex.names.size} names; ${shown.length} of them` : `exactly these ${shown.length} name${shown.length === 1 ? "" : "s"}`}${ex.open ? " (and what it re-exports from a module not readable here)" : ""} (name: kind${signed.size ? ", each function with its declared signature" : ""}): ` +
    `${shown.map((x) => `${x.name}: ${x.kind}${signed.has(x.name) ? ` ${signed.get(x.name)}` : ""}`).join(", ")}${more > 0 ? `, and ${more} more` : ""}. ` +
    "The test may reference only exports from this list: a name the module does not export (an internal function, a shape name, a label) is undefined on the import, so a check that reads one is refused; reach internal code through an export on the list. " +
    (signed.size ? "Call each function with the parameters its signature declares, and assert only on what its declared return type can hold (a property of an object, never of an array or a string). " : "");
}

/**
 * WHAT THE LAST JUDGED ATTEMPT SHOWED, said to the next one. Without it a check that landed green at HEAD was followed
 * by the same goal text, so the drafter wrote the same check again. The wording follows the dissent child's ("must
 * differ from … which already passes"): it names the check that did not reproduce and asks for a different one. The
 * reason is cut at 160 characters, or after the `check_references_missing_export:<symbol>` it carries when that ends
 * later (an existence_only reason puts it past 160), so the next attempt is told the name it must not read.
 */
export function priorAttemptSentence(prior: readonly Row[]): string {
  const last = [...prior].reverse().find((h) => JUDGED_NOT_ARMED.has(String(h?.["state"] ?? "")));
  if (!last) return "";
  const titles = (Array.isArray(last["titles"]) ? (last["titles"] as unknown[]) : []).filter((t): t is string => typeof t === "string" && t.length > 0);
  const named = titles.length ? titles.map((t) => JSON.stringify(t)).join(", ") : "the previous check";
  if (last["state"] === "green_at_head")
    return `An earlier attempt wrote ${named}, which already PASSES at HEAD, so it does not reproduce the defect: write a different test whose assertion fails because of the defect. Tests already in the file do not count. `;
  const reason = String(last["reason"] ?? "");
  const sym = new RegExp(`${MISSING_EXPORT_STAGE}:[\\w$]+`).exec(reason);
  return `An earlier attempt wrote ${named}, which was not accepted (${reason.slice(0, Math.max(160, sym ? sym.index + sym[0].length : 0))}): write a different test that avoids that. `;
}

/** The source of the call `test("<title>", …)` / `it(…)` from its opening parenthesis to the matching close (strings skipped). */
function testBody(src: string, title: string): string | null {
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b(?:test|it)(?:\\.only|\\.failing)?\\s*\\(\\s*(["'\`])${esc}\\1`).exec(src);
  if (!m) return null;
  let i = src.indexOf("(", m.index), depth = 0, q: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (q) { if (c === "\\") j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}
/** One expect(...) statement's text: the argument and the matcher chain, to the matcher's call. */
const EXPECTATIONS = /\bexpect\s*\(([\s\S]*?)\)\s*((?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*[A-Za-z]+\s*\(([^)]*)\))/g;
/**
 * AN EXISTENCE ASSERTION IS NEVER A FALSIFIER (C-invented-1 at the arm step). Each expect() in the named tests is
 * existence-only when it asserts only that a name exists, is defined, or has a type: `typeof x` against a type name,
 * toBeDefined / not.toBeUndefined / toBeTruthy on a bare or module member, `"x" in mod`, toHaveProperty, Object.keys
 * containment, toBeInstanceOf(Function). A check whose every assertion is one of those is refused; one behaviour assertion
 * (a call's result, a throw, an output) keeps it armable, and the red-for-the-right-reason judge decides as before.
 */
export function existenceOnlyCheck(src: string, titles: readonly string[]): { existence_only: boolean; assertions: number; existence: number } {
  let assertions = 0, existence = 0;
  const memberOrName = /^\s*[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\]))*\s*(?:as\s+[^)]*)?$/;
  // `(mod as any).x` / `(mod as Record<…>)["x"]` read as `mod.x` / `mod["x"]`: a cast does not make an access a behaviour.
  const unwrap = (a: string) => a.trim().replace(/^\((.*)\)$/s, "$1").replace(/\s+as\s+[\w<>\[\], |"]+$/, "").replace(/\(\s*([A-Za-z_$][\w$]*)\s+as\s+[^()]*(?:\([^()]*\)[^()]*)*\)/g, "$1").trim();
  for (const t of titles) {
    const body = testBody(src, t);
    if (!body) continue;
    for (const m of body.matchAll(EXPECTATIONS)) {
      assertions++;
      const arg = unwrap(m[1] ?? ""), chain = (m[2] ?? "").replace(/\s+/g, ""), val = (m[3] ?? "").trim();
      // `typeof <name or member>` asks only what a name is; `typeof f(x)` calls the code and is a behaviour.
      const typeofArg = /^typeof\s/.test(arg) && memberOrName.test(arg.replace(/^typeof\s+/, ""));
      const typeName = /^["'`](function|object|string|number|boolean|undefined|symbol|bigint)["'`]$/.test(val);
      const exists =
        (typeofArg && /\.(not\.)?(toBe|toEqual|toStrictEqual)\(/.test(chain) && typeName) ||
        (memberOrName.test(arg) && /\.(toBeDefined|toBeTruthy|not\.toBeUndefined|not\.toBeNull|not\.toBeFalsy)\(/.test(chain)) ||
        (/^["'`][\w$]+["'`]\s+in\s+/.test(arg) && /\.(toBe|toEqual)\(/.test(chain) && /^true$/.test(val)) ||
        /\.toHaveProperty\(/.test(chain) ||
        (/^Object\.(keys|getOwnPropertyNames)\(/.test(arg) && /\.(toContain|toContainEqual)\(/.test(chain)) ||
        (/\.toBeInstanceOf\(/.test(chain) && /^Function$/.test(val));
      if (exists) existence++;
    }
  }
  return { existence_only: assertions > 0 && existence === assertions, assertions, existence };
}

/** String-literal test titles declared in a test file (template titles with placeholders are not runnable names). */
export function declaredTestTitles(src: string): string[] {
  const titles: string[] = [];
  for (const m of src.matchAll(/\b(?:test|it)(?:\.only|\.failing)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const t = (m[2] ?? "").replace(/\\(.)/g, "$1");
    if (!t.trim() || (m[1] === "`" && t.includes("${"))) continue;
    if (testTitleInSource(src, t) && !titles.includes(t)) titles.push(t);
  }
  return titles;
}

/** The gap's localized edit site in its vessel: its own edit site, else a src file its summary names that exists. */
export function checkSupplySite(row: Row, vessel: string): string | null {
  const own = gapEditSite(row, metaOf(row))?.replace(/:\d+.*$/, "");
  if (own && own.startsWith(`repos/${vessel}/`) && existsSync(join(clonesRoot(), own.replace(/^repos\//, "")))) return own;
  for (const m of String(row["summary"] ?? "").matchAll(/(?:repos\/[A-Za-z0-9_.-]+\/)?(src\/[A-Za-z0-9_./-]+\.ts)\b/g)) {
    const rel = normalize(m[1] ?? "");
    if (!rel.startsWith("src/") || rel.includes("..")) continue;
    if (existsSync(join(clonesRoot(), vessel, rel))) return `repos/${vessel}/${rel}`;
  }
  return null;
}

/**
 * The repo paths the lane would write for a gap's check, as the autonomy scope names them: the edit site (vessel-relative,
 * prefixed ONCE — checkSupplySite already returns repos/<vessel>/<rel>) or the whole vessel, and the gap's check file.
 */
export function checkSupplyScopeTargets(vessel: string, site: string | null, testFile: string): string[] {
  const rel = vesselRelativeEditSite(site);
  return [rel ? `repos/${vessel}/${rel}` : `repos/${vessel}/`, `repos/${vessel}/${testFile}`];
}

/** The share measures over armed gaps whose check was born at or after sinceMs. */
export function checkSupplyMeasures(rows: Row[], sinceMs: number): Record<string, number | null> {
  let armed = 0, sys = 0, sysRed = 0;
  for (const row of rows) {
    const meta = metaOf(row);
    const cls = falsifierClassOf(meta);
    if (cls !== "class1" && cls !== "class2") continue;
    // When the gap was armed: the supply's own stamp for a check it wrote, else the check's birth, else its stamp.
    const at = Date.parse(String(ledgerOf(meta).armed_at ?? meta["predicate_birth_at"] ?? meta["falsifier_classified_at"] ?? ""));
    if (!Number.isFinite(at) || at < sinceMs) continue;
    armed += 1;
    if (meta["predicate_source"] !== CHECK_SUPPLY_SOURCE) continue;
    sys += 1;
    if (meta["predicate_birth_verdict"] === "present") sysRed += 1;
  }
  return {
    armed_in_window: armed,
    armed_system_authored: sys,
    system_authored_red_at_head: sysRed,
    system_authored_share: armed > 0 ? sys / armed : 0,
    red_at_head_share: sys > 0 ? sysRed / sys : 0,
  };
}

/**
 * GRADED BY THE REPORT, NOT BY THE EXIT (REALIGNMENT §2.2). Success when the tick dispatched or armed something;
 * failure when everything it tried came back refused (a dispatch refused, a check green at HEAD or red for the
 * wrong reason); nothing at all when it found nothing to do or is still waiting on a test to land.
 */
export function checkSupplySettlementLeg(c: { dispatched: number; armed: number; refused: number }): "alpha" | "beta" | null {
  // A dispatch is a promise, not a result: only an armed check is credit. A refusal, a failed or lost goal is a debit.
  if (c.armed > 0) return "alpha";
  return c.refused > 0 ? "beta" : null;
}

/**
 * ONE SETTLEMENT PER ATTEMPT: the key of one dispatch of one row (its dispatch id, or with none recorded, its send
 * instant). A failed or lost outcome whose key the rhythm already holds was settled before, and is never debited again.
 * Measured: a dispatch_failed write that the next tick undid left the row at goal_dispatched, so the same failure
 * was read back and debited on nearly every tick (one row 434 times), and the family's posterior fell to 16 against 1296.
 */
export function settledAttemptKey(rowId: string, l: { dispatch_id?: unknown; last_dispatch_at?: unknown }): string {
  const attempt = nonEmpty(l.dispatch_id) ? String(l.dispatch_id) : `@${String(l.last_dispatch_at ?? "")}`;
  return createHash("sha256").update(`${rowId}\n${attempt}`).digest("hex").slice(0, 16);
}
/** The attempt keys a rhythm body holds as settled, newest last (settled_attempts; anything else reads as none). */
export function settledAttemptsOf(body: Record<string, unknown>): string[] {
  const raw = body["settled_attempts"];
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}

// ─── the dispatch's outcome, read back ──────────────────────────────────────

const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
/** This node's identity in a ledger (bootstrap identity, the same one the lane's pick line names as owner). */
export const checkSupplyNode = (): string => process.env["SUBSTRATE_NAME"] ?? "substrate";
export const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "pending", "accepted", "queued", "dispatched", "in_progress", "started"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "error", "errored", "cancelled", "canceled", "timeout", "timed_out", "aborted", "refused"]);

/** What a node's goal-host said about one dispatch: an HTTP answer, or unreachable. null = not probed (another node's). */
export type DispatchProbe = { http: number; status?: unknown; reached?: unknown; reach_reason?: unknown; outcome?: unknown } | { http: "unreachable"; error: string };
export type LostWhy = "not_found_on_host" | "host_unreachable" | "no_dispatch_id" | "unrecognised_status" | "owning_node_never_settled" | "timed_out";
export type DispatchVerdict =
  | { kind: "running" }
  | { kind: "awaiting_titles" }
  | { kind: "failed"; reason: string }
  | { kind: "non_attempt"; reason: string; retry_after_s?: number }
  | { kind: "refused"; reason: string; retry_after_s?: number }
  | { kind: "lost"; why: LostWhy; reason: string }
  | { kind: "wait"; why: LostWhy; detail: string };
export interface OutcomeBounds { stale_ms: number; timeout_ms: number; title_grace_ms: number; foreign_stale_ms: number }
/** The outcome bounds a family's rhythm body sets (this family's defaults where it sets none). Also read by the drain
 *  observer, which bounds a goal-host remedy's "running" dispatch by the same dispatch_timeout_hours. */
export function outcomeBoundsOf(body: Record<string, unknown>): OutcomeBounds {
  return {
    stale_ms: posNum(body["dispatch_stale_hours"], 24) * 3600_000,
    timeout_ms: posNum(body["dispatch_timeout_hours"], 6) * 3600_000,
    title_grace_ms: posNum(body["title_grace_hours"], 2) * 3600_000,
    foreign_stale_ms: posNum(body["foreign_stale_hours"], 72) * 3600_000,
  };
}

/**
 * THE ONE CLASSIFICATION OF A NON-SUCCESS THAT IS NOT A FAILED ATTEMPT (CHANGE-30), read from the receiver's
 * STRUCTURED `outcome` (goal-host: GET /executions/:id and the /run-goal 429 body), never from goalReachReason prose:
 *   non_attempt: the receiver will take it later (compose capacity, a landing that deferred with its park kept);
 *   refused:     the receiver declined it (the spend-rate breaker), with its own retry_after_s when it said one.
 * Neither is charged as an attempt; each waits its own shaped delay. Anything else is null (today's semantics).
 */
export function outcomeKindOf(o: unknown): { kind: "non_attempt" | "refused"; retry_after_s?: number; refuse_class?: string; failure_kind?: string } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Row;
  const kind = r["kind"];
  if (kind !== "non_attempt" && kind !== "refused") return null;
  const ra = r["retry_after_s"];
  return {
    kind,
    ...(typeof ra === "number" && Number.isFinite(ra) && ra > 0 ? { retry_after_s: ra } : {}),
    ...(typeof r["refuse_class"] === "string" ? { refuse_class: r["refuse_class"] as string } : {}),
    ...(typeof r["failure_kind"] === "string" ? { failure_kind: r["failure_kind"] as string } : {}),
  };
}

/**
 * A SEND that did not dispatch, classified by the same rule: the receiver's structured outcome when its body carried
 * one, else its transport: 429 with refused:true is a refusal, 503 (draining) and no answer at all are non-attempts,
 * any other status is a failed send.
 */
export function classifySendFailure(r: ResolverResult): { kind: "non_attempt" | "refused" | "failed"; reason: string; retry_after_s?: number; http_status: number | null } {
  const body = ((r.body ?? {}) as Row);
  const http = typeof body["http_status"] === "number" ? (body["http_status"] as number) : null;
  const resp = (body["response"] && typeof body["response"] === "object" ? body["response"] : {}) as Row;
  const detail = String(body["detail"] ?? "").slice(0, 160);
  const why = typeof resp["goalReachReason"] === "string" ? `: ${String(resp["goalReachReason"]).slice(0, 160)}` : "";
  const named = outcomeKindOf(resp["outcome"]);
  if (named) return { kind: named.kind, reason: `${detail}${why}`, http_status: http, ...(named.retry_after_s ? { retry_after_s: named.retry_after_s } : {}) };
  if (http === 429 && resp["refused"] === true) return { kind: "refused", reason: `${detail}${why}`, http_status: http };
  if (http === 503 || http === null) return { kind: "non_attempt", reason: detail || "the goal-host did not answer", http_status: http };
  return { kind: "failed", reason: `${detail}${why}`, http_status: http };
}

/**
 * The wait before re-sending after the n-th CONSECUTIVE non-attempt (CHANGE-30): the kind's base delay (a refusal's
 * own retry_after_s when the receiver gave one) doubled per consecutive one, capped by the shaped maximum, and never
 * shorter than what the receiver asked for. Bounded by construction: the sends a never-taking receiver gets in any
 * window fall as the streak grows (with the defaults, 30 min doubling to a 6 h cap: at most 7 sends in 24 h).
 */
export function nonAttemptDelayMs(baseMs: number, streak: number, maxMs: number, receiverMinMs = 0): number {
  const n = Math.max(1, Math.floor(streak));
  const grown = Math.min(baseMs * 2 ** Math.min(n - 1, 30), Math.max(maxMs, baseMs));
  return Math.max(grown, receiverMinMs);
}
/** The ledger a non-attempt settles to: not charged (the send's attempt is given back), not sent before not_before. */
export function nonAttemptLedger(ledger: Ledger, kind: "non_attempt" | "refused", reason: string, delayMs: number, nowMs: number, outcome?: Row, streak?: number): Ledger {
  return {
    ...ledger,
    state: kind === "refused" ? "send_refused" : "non_attempt",
    attempts: Math.max(0, Number(ledger.attempts ?? 0) - 1),
    not_before: new Date(nowMs + delayMs).toISOString(),
    non_attempt_streak: streak ?? Number(ledger.non_attempt_streak ?? 0) + 1,
    reason,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * The verdict on one in-flight dispatch. Pure. An outcome that cannot be read is never "failed": it waits (and is
 * reported) until the staleness bound, then is lost with the reason it could not be read.
 */
export function dispatchVerdict(ledger: Ledger, probe: DispatchProbe | null, nowMs: number, bounds: OutcomeBounds, localNode: string): DispatchVerdict {
  const sent = Date.parse(String(ledger.last_dispatch_at ?? ""));
  const age = Number.isFinite(sent) ? nowMs - sent : Number.POSITIVE_INFINITY;
  const hours = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;
  const lostOr = (why: LostWhy, detail: string, bound = bounds.stale_ms): DispatchVerdict =>
    age > bound ? { kind: "lost", why, reason: `${why}: ${detail}; unsettled ${hours(age)} (bound ${hours(bound)})` } : { kind: "wait", why, detail };
  if (!nonEmpty(ledger.dispatch_id)) return lostOr("no_dispatch_id", "the dispatch recorded no id, so its outcome cannot be read");
  const owner = nonEmpty(ledger.dispatch_node) ? String(ledger.dispatch_node) : null;
  // A goal this node PLACED on a peer is read by nobody here; its compose (ceiling 15 min) is long over by the
  // dispatch timeout, so it settles by that shaped bound, not by the foreign one meant for another sender's dispatch.
  if (owner !== null && owner !== localNode) return ledger.placed_by === localNode
    ? lostOr("owning_node_never_settled", `placed on ${owner} by this node; only ${owner}'s goal-host can read the outcome`, bounds.timeout_ms)
    : lostOr("owning_node_never_settled", `dispatched by ${owner}; only its goal-host can read the outcome`, bounds.foreign_stale_ms);
  const where = owner === null ? `this node's goal-host (the dispatching node was not recorded)` : `${owner}'s goal-host`;
  if (probe === null || probe.http === "unreachable") return lostOr("host_unreachable", `${where} did not answer${probe && probe.http === "unreachable" ? ` (${probe.error.slice(0, 120)})` : ""}`);
  if (probe.http === 404) return lostOr("not_found_on_host", `${where} has no record of dispatch ${ledger.dispatch_id} (pruned, or sent from another node)`);
  if (probe.http !== 200) return lostOr("host_unreachable", `${where} answered HTTP ${probe.http}`);
  const status = String(probe.status ?? "").toLowerCase();
  if (RUNNING_STATUSES.has(status)) return age > bounds.timeout_ms ? { kind: "lost", why: "timed_out", reason: `timed_out: still ${status} ${hours(age)} after dispatch (bound ${hours(bounds.timeout_ms)})` } : { kind: "running" };
  if (TERMINAL_STATUSES.has(status)) {
    const why = typeof probe.reach_reason === "string" && probe.reach_reason.trim() ? `: ${probe.reach_reason.replace(/\s+/g, " ").trim().slice(0, 240)}` : "";
    if (probe.reached === true) {
      return age > bounds.title_grace_ms
        ? { kind: "failed", reason: `the goal ended ${status} and reached, but no new test title appeared in ${ledger.test_file ?? "the check file"} within ${hours(bounds.title_grace_ms)}` }
        : { kind: "awaiting_titles" };
    }
    const named = outcomeKindOf((probe as { outcome?: unknown }).outcome);
    if (named) return { kind: named.kind, reason: `the goal ended ${status}, not reached, as a ${named.kind === "refused" ? "refusal" : "non-attempt"}${named.refuse_class ? ` (${named.refuse_class})` : ""}${why}`, ...(named.retry_after_s ? { retry_after_s: named.retry_after_s } : {}) };
    return { kind: "failed", reason: `the goal ended ${status}, not reached${why}` };
  }
  return lostOr("unrecognised_status", `${where} reported status ${JSON.stringify(String(probe.status ?? "")).slice(0, 60)}, which this code does not know`);
}

/**
 * This node's live autonomyScope record, read from its own pool (the record's authority, as the rhythm is read). The
 * supply's skip is only a saving (it does not send a goal the lane could never land); the containment itself is the
 * lane's admission, which fails closed. So an absent or unreadable record here skips nothing and is reported.
 */
async function readScopeSelf(): Promise<AutonomyScope> {
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "autonomyScope", status: "open" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { excluded: [], readable: false, reason: `autonomyScope read HTTP ${res.status}` };
    const j = (await res.json()) as { body?: { impulses?: Array<{ body?: Row }> } };
    const body = j.body?.impulses?.[0]?.body;
    if (!body) return { excluded: [], readable: false, absent: true, reason: "no autonomyScope record" };
    const raw = body["excluded_paths"];
    const excluded = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : [];
    // excluded_path_exceptions too, read as the lane reads it: without it a lifted file under an excluded directory
    // would be skipped here as one "the lane could never land".
    const exceptions = parseScopeExceptions(body["excluded_path_exceptions"]);
    return { excluded, readable: true, reason: `autonomyScope: ${excluded.length} excluded path(s)`, ...(exceptions.length ? { exceptions } : {}) };
  } catch (err) {
    return { excluded: [], readable: false, reason: `autonomyScope unreadable: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}

/** Read one dispatch from this node's goal-host. Also the drain observer's outcome reader for a goal-host remedy. */
export async function probeDispatch(dispatchId: string): Promise<DispatchProbe> {
  try {
    const r = await fetch(`${GOAL_HOST_ENDPOINT}/executions/${encodeURIComponent(dispatchId)}`, { headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (r.status !== 200) return { http: r.status };
    const j = (await r.json().catch(() => ({}))) as Row;
    return { http: 200, status: j["status"], reached: j["reached"], reach_reason: j["goalReachReason"], outcome: j["outcome"] };
  } catch (err) {
    return { http: "unreachable", error: String((err as Error)?.message ?? err) };
  }
}

/**
 * THE CHECK'S RUN REPORT, READ WHERE ITS VERDICT WAS TAKEN. A node that forwards its gap store settles a handed-off
 * check from the holder's birth stamp, which carries a verdict and no report; the arm gates (red for the right reason,
 * the red-reason classifier, the contract rule, the first failure) need the report. So the check's own pointer is
 * resolved at the holder (the forward's endpoint, as forwardToGapStore sends it, under the judge's check timeout),
 * and its report is the holder's run on the holder's tree. A null report arms nothing.
 */
async function holderCheckReport(evidence: { shape: string; input: Row }): Promise<{ report: Row | null; detail: string }> {
  const ep = process.env["GAP_STORE_ENDPOINT"];
  if (!ep) return { report: null, detail: "no gap-store holder endpoint" };
  try {
    const r = await fetch(ep, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      body: JSON.stringify({ impulse: { pointer: { type: evidence.shape, ...evidence.input } } }),
      signal: AbortSignal.timeout(gapCheckTimeoutMs(evidence.shape, evidence.input)),
    });
    if (!r.ok) return { report: null, detail: `holder answered HTTP ${r.status}` };
    const j = (await r.json()) as Row;
    if (j["shape"] !== evidence.shape) return { report: null, detail: `holder answered ${String(j["shape"] ?? "no shape")}: ${JSON.stringify(j["body"] ?? null).slice(0, 160)}` };
    const body = j["body"];
    return typeof body === "object" && body !== null ? { report: body as Row, detail: "read" } : { report: null, detail: "holder answered no report body" };
  } catch (err) {
    return { report: null, detail: `holder unreachable: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
}

/**
 * EDIT-SITE MUTATION GATE. A check red for an assertion, on a contract its target has, can still be red whatever the
 * edit site does: it mocks the module it asserts on (activity-api 2138d94), its mock's key is never what the code sends
 * (goal-host 979b966d), it reads a field of a value the site never returns that way (goal-host 725638cc, `.shapes` on a
 * Promise), or it calls through a cast with arguments the site cannot use (2182d140). No fix of the site can turn such a
 * check green, so armed it makes a gap no landing closes. The arm step runs the check under operator mutants OF THE EDIT
 * SITE ITSELF (scope-earn-in selectMutants, applied by test_suite's mutate_edit through lib/apply-mutant.ts on the
 * committed tree), never of a helper it imports: a mutant that turns the named tests green, or changes the failing
 * assertion's error line, Expected or Received, shows the red depends on the site. A run that did not measure (the
 * mutant did not apply, the file did not load, a named test threw instead of asserting) tells nothing either way. When at least one mutant
 * measured and none changed anything, the red is not about the site: refused, `red_independent_of_edit_site`.
 *
 * COST, bounded: at most k extra runs of the check per arm (`mutants_per_file` on this family's rhythm record, read by
 * scope-earn-in's coverageKnobs: default 6, capped at 20), one at a time, stopping at the first mutant that changes the
 * red, so a check that depends on its site usually costs one or two. They run where the check's report was taken: here,
 * or at the gap-store holder on a node that forwards its store. A site with no mutable construct runs none.
 */
export type MutationGateOutcome =
  | { kind: "pass"; record: Row }
  | { kind: "refuse"; reason: string; record: Row }
  | { kind: "wait"; detail: string };
/** How a run's named tests fail: per title, pass, or the failing assertion's error line, Expected and Received. null
 *  when the run did not measure that: it did not run, the file did not load, or a named test failed on something other
 *  than an assertion (a mutant that makes the check throw shows the check reaches the site, not that it tests it). */
function redSignature(report: Row | null, titles: string[]): string | null {
  const c = (report?.["red_reason"] ?? null) as CheckRunClass | null;
  if (!report || report["ran"] !== true || !c || typeof c !== "object" || !Array.isArray(c.failures) || c.unhandled || !c.ran) return null;
  const compared = Array.isArray(c.compared) ? c.compared : [];
  const sig: unknown[] = [];
  for (const t of titles) {
    const f = c.failures.find((x) => x.name.includes(t));
    if (!f) { sig.push([t, "pass"]); continue; }
    if (f.cls !== "assertion") return null;
    const v = compared.find((x) => x?.name === f.name);
    sig.push([t, f.error ?? null, v?.expected ?? null, v?.received ?? null]);
  }
  return JSON.stringify(sig);
}
/** The gate's decision from the unmutated report and one report per mutant run (null: that run answered nothing). */
export function mutationGateVerdict(baseline: Row | null, runs: Array<{ mutant: Mutant; report: Row | null }>, titles: string[]): { measured: number; changed: number; unmeasured: number } {
  const base = redSignature(baseline, titles);
  let measured = 0, changed = 0, unmeasured = 0;
  for (const { report } of runs) {
    const applied = ((report?.["mutation"] ?? null) as Row | null)?.["applied"] === true;
    const green = applied && report?.["ran"] === true && report?.["requested_not_passing"] === 0;
    const sig = applied ? redSignature(report, titles) : null;
    if (!applied || (!green && sig === null) || base === null) { unmeasured += 1; continue; }
    measured += 1;
    if (green || sig !== base) changed += 1;
  }
  return { measured, changed, unmeasured };
}
/**
 * THE PART OF THE SITE THE CHECK EXERCISES. Operator mutants spread over a whole file land mostly in code a check never
 * reaches (one function of a large module), so a genuine check would read as unmoved and be refused. The mutants are
 * taken from the site's top-level declarations the check names (`ns.x` on any namespace import, or a named import) and
 * the same-file declarations those reach, transitively; everything else is blanked to spaces, so offsets and lines are
 * the file's own. The whole file when the check names nothing the site declares.
 */
export function siteRegionSource(siteSrc: string, checkSrc: string): string {
  let ts: typeof import("typescript");
  try { ts = createRequire(import.meta.url)("typescript") as typeof import("typescript"); } catch { return siteSrc; }
  const check = ts.createSourceFile("c.ts", checkSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nsNames = new Set<string>();
  const wanted = new Set<string>();
  check.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause || !ts.isStringLiteral(n.moduleSpecifier) || !n.moduleSpecifier.text.startsWith(".")) return;
    const nb = n.importClause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) nsNames.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) wanted.add((el.propertyName ?? el.name).text);
  });
  const reads = (n: import("typescript").Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      let e: import("typescript").Expression = n.expression;
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
      if (ts.isIdentifier(e) && nsNames.has(e.text)) wanted.add(n.name.text);
    }
    ts.forEachChild(n, reads);
  };
  reads(check);
  const site = ts.createSourceFile("s.ts", siteSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const decls = new Map<string, import("typescript").Statement>();
  for (const st of site.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) decls.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, st);
  }
  const keep = new Set<import("typescript").Statement>();
  const queue = [...wanted].filter((w) => decls.has(w));
  while (queue.length > 0) {
    const st = decls.get(queue.pop()!)!;
    if (keep.has(st)) continue;
    keep.add(st);
    const walk = (n: import("typescript").Node): void => { if (ts.isIdentifier(n) && decls.has(n.text) && !keep.has(decls.get(n.text)!)) queue.push(n.text); ts.forEachChild(n, walk); };
    walk(st);
  }
  if (keep.size === 0) return siteSrc;
  const chars: string[] = siteSrc.split("").map((ch) => (ch === "\n" || ch === "\r" ? ch : " "));
  for (const st of keep) for (let i = st.getStart(site); i < st.getEnd(); i += 1) chars[i] = siteSrc[i]!;
  return chars.join("");
}
async function editSiteMutationGate(a: { vessel: string; siteRel: string; testFile: string; checkSrc: string; titles: string[]; baseline: Row | null; k: number }): Promise<MutationGateOutcome> {
  let src: string | null = null;
  try { src = readFileSync(join(clonesRoot(), a.vessel, a.siteRel), "utf-8"); } catch { src = null; }
  if (src === null) return { kind: "refuse", reason: `red_independent_of_edit_site: the edit site ${a.siteRel} is not readable here, so no change to it can be shown to move the check`, record: { mutants: 0, site: a.siteRel } };
  const region = siteRegionSource(src, a.checkSrc);
  const mutants = selectMutants(region, a.k).map((m) => ({ ...m, original: src!.slice(m.start, m.end) }));
  const record: Row = { site: a.siteRel, k: a.k, selected: mutants.length, region: region === src ? "file" : "declarations_the_check_names" };
  if (mutants.length === 0) return { kind: "pass", record: { ...record, decided: "nothing: the edit site has no mutable construct" } };
  const runs: Array<{ mutant: Mutant; report: Row | null }> = [];
  for (const m of mutants) {
    const input: Row = { vessel: `repos/${a.vessel}`, test_file: a.testFile, only_tests: a.titles, base_ref: "HEAD", mutate_edit: { file: a.siteRel, start: m.start, end: m.end, original: m.original, replacement: m.replacement, operator: m.operator } };
    let report: Row | null;
    if (gapStoreIsLocal()) {
      const r = await resolveTestSuite(input).catch(() => null);
      report = r && r.shape === "test_suite" ? (r.body as Row) : null;
    } else {
      const held = await holderCheckReport({ shape: "test_suite", input });
      if (!held.report && /unreachable|HTTP/.test(held.detail)) return { kind: "wait", detail: `the mutant runs could not be read at the holder (${held.detail})` };
      report = held.report;
    }
    runs.push({ mutant: m, report });
    const v = mutationGateVerdict(a.baseline, runs, a.titles);
    if (v.changed > 0) return { kind: "pass", record: { ...record, ran: runs.length, ...v, changed_by: { operator: m.operator, line: m.line } } };
  }
  const v = mutationGateVerdict(a.baseline, runs, a.titles);
  const out = { ...record, ran: runs.length, ...v };
  if (v.measured === 0) return { kind: "pass", record: { ...out, decided: "nothing: no mutant run measured the check" } };
  return { kind: "refuse", reason: `red_independent_of_edit_site: the named test(s) fail the same way under all ${v.measured} measured mutant(s) of ${a.siteRel} (${mutants.map((m) => `${m.operator}@${m.line}`).join(", ")}), so no change to the site moves the check`, record: out };
}

/** Settle a report-graded family's rhythm (the conductor left it pending: directFamilySettlement). */
export async function settleFamily(rhythm: { id: string; body: RhythmBody & Row }, leg: "alpha" | "beta", d: { staleness: number; alpha: number; beta: number }, source = "gap-check-supply-tick", extra: Row = {}): Promise<void> {
  // `extra` lands in the SAME write as the leg (the settled attempt keys): a debit and its key are stored together or not at all.
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse_write", id: rhythm.id, shape: "timeShapedRhythm", source,
        body: { ...rhythm.body, ...rhythmSettlementOverlay(leg, d.alpha, d.beta, d.staleness), ...extra } } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[gap-check-supply] rhythm ${rhythm.id} ${leg} settlement not written: HTTP ${res.status}`);
  } catch (err) {
    // The next tick re-derives due-ness from whatever the registry holds; this tick's leg (and its keys) are lost.
    console.warn(`[gap-check-supply] rhythm ${rhythm.id} ${leg} settlement lost: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }
}

const posNum = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);

async function writeMeta(row: Row, meta: Row, opts?: Parameters<typeof resolveSubstrateGapWrite>[1]): Promise<ResolverResult> {
  return resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: meta },
  } as never, opts);
}

/**
 * I1, LOCALIZE BEFORE ADMISSION. An armed class2 gap whose ONLY compose skip is no_edit_site needs a site, not a test:
 * admission excludes it before any localizer runs, and a test-writing goal would replace a check it already has. The
 * site comes from the gap's own evidence (checkSupplySite: a src file its summary names that exists in the vessel
 * clone), else localizeGap without the LLM, the localizer the lane already runs after a pick. A class1 or literal row
 * is never sited here (a guessed site would make a literal measurable at the guess; checkSupplyDisposition already
 * drops expected_literal and hardcoded_url rows), and a row with any site field is never re-aimed.
 * Persisted as edit_site (what eligibility reads) plus the shaped localizationRecord (gap.localization, the record
 * compose admission reads), with localized_by and localization_method beside it, outside the record's closed key set.
 * History: af21e4fe wrote edit_site from localizeGap with a flat pointer the store refused; f77676f6 fixed the wrapper
 * and dropped the payload, so the site was never persisted.
 */
export function localizableBySupply(row: Row): boolean {
  const meta = metaOf(row);
  return composeEligibilitySkipReason(row) === "no_edit_site" && falsifierClassOf(meta) === "class2" && predicateSuspect(meta) === null
    && !nonEmpty(meta["expected_literal"]) && !nonEmpty(meta["hardcoded_url"]);
}
async function localizeForSupply(row: Row, vessel: string, site: string | null): Promise<{ file: string; method: string; evidence: Array<{ read: string; why: string }> } | null> {
  if (site) return { file: site, method: "check_supply_site", evidence: [{ read: "summary", why: `the gap's summary names ${site}, which exists in the ${vessel} clone` }] };
  const { localizeGap } = await import("./gap-to-feature.js");
  const loc = await localizeGap(row, { useLlm: false });
  if (!loc || !loc.file.startsWith(`repos/${vessel}/`) || !existsSync(join(clonesRoot(), loc.file.replace(/^repos\//, "")))) return null;
  return { file: loc.file, method: loc.method, evidence: [{ read: loc.method, why: loc.description }] };
}

// ONE PASS AT A TIME IN THIS PROCESS, AND AN UNDUE PASS AT MOST ONCE PER bookkeeping_min_interval_s. The conductor
// asks for the bookkeeping on every pass (a heartbeat drives it about twice a minute), and two overlapping passes
// would read the same settled_attempts and debit one attempt twice. Kept in process memory, never on the rhythm row:
// any write there resets the age its due score is measured from.
let passInFlight = false;
let lastBookkeepingAt: number | null = null;

export async function resolveGapCheckSupplyTick(pointer: GapCheckSupplyTickPointer): Promise<ResolverResult> {
  if (passInFlight) return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "in_progress", family: CHECK_SUPPLY_FAMILY } };
  passInFlight = true;
  try {
    return await supplyPass(pointer);
  } finally {
    passInFlight = false;
  }
}

async function supplyPass(pointer: GapCheckSupplyTickPointer): Promise<ResolverResult> {
  const now = typeof pointer.now_ms === "number" ? pointer.now_ms : Date.now();
  const nowIso = new Date(now).toISOString();

  // 1. CADENCE: this family's rhythm, read now. Seeding it is the bootstrap seeder's job, not this resolver's:
  // the conductor only calls a family it has read, so a self-seed here could never run.
  const rhythm = await readFamilyRhythm(CHECK_SUPPLY_FAMILY);
  if (!rhythm) return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "no_rhythm", family: CHECK_SUPPLY_FAMILY } };
  const due = rhythmDueScore(rhythm.body, rhythm.updated_at, now);
  const threshold = posNum(rhythm.body["due_threshold"], 1);
  // THE RHYTHM PACES THE DISPATCH, NOT THE BOOKKEEPING. Gated as a whole, an undue family read back no outcome, armed
  // no landed check and un-armed nothing until it came due again, so a family whose posterior sank under debits held a
  // failed goal at goal_dispatched for 18 to 50 hours, and the repair its outcome should have triggered waited with it. So ARM, OUTCOME, the
  // own-check un-arm and the hold release run on every pass; DISPATCH, localization and placement only when due. An
  // undue pass is not a fire: no credit, no staleness answered (a debit is still written, as the beta leg it is).
  // A PAUSED family does nothing at all, as before: the pause is a hold, and the arm step writes checks and runs suites.
  const dispatchDue = pointer.bookkeeping_only !== true && due.due_score >= threshold;
  const notDue = { fired: false, reason: "not_due", due_score: due.due_score, due_threshold: threshold };
  if (due.paused_by) return { shape: "gapCheckSupplyReport", body: { ...notDue, paused_by: due.paused_by } };
  const floorMs = posNum(rhythm.body["bookkeeping_min_interval_s"], 600) * 1000;
  if (!dispatchDue && lastBookkeepingAt !== null && now >= lastBookkeepingAt && now - lastBookkeepingAt < floorMs) {
    return { shape: "gapCheckSupplyReport", body: { ...notDue, bookkeeping: `skipped: the last pass was ${Math.round((now - lastBookkeepingAt) / 1000)} s ago (floor ${floorMs / 1000} s)` } };
  }
  lastBookkeepingAt = now;
  const perTick = Math.floor(posNum(rhythm.body["max_per_tick"], 1));
  const backoffMs = posNum(rhythm.body["backoff_hours"], 24) * 3600_000;
  const maxAttempts = Math.floor(posNum(rhythm.body["max_attempts"], 3));
  // A NON-ATTEMPT's wait and a REFUSAL's wait (CHANGE-30), read from the same shaped record; a refusal prefers the
  // receiver's own retry_after_s. The non-attempt default sits well inside the 24 h park TTL a deferred landing keeps.
  const nonAttemptDelayMsBase = posNum(rhythm.body["non_attempt_delay_s"], 1800) * 1000;
  const refusalDelayMs = posNum(rhythm.body["refusal_delay_s"], 3600) * 1000;
  const maxNonAttemptDelayMs = posNum(rhythm.body["max_non_attempt_delay_s"], 6 * 3600) * 1000;
  // The wait for the NEXT consecutive non-attempt of a gap: its kind's base, doubled per consecutive one, capped.
  const delayFor = (kind: "non_attempt" | "refused", ledger: Ledger, retryAfterS?: number): { ms: number; streak: number } => {
    const streak = Number(ledger.non_attempt_streak ?? 0) + 1;
    const receiverMs = kind === "refused" && retryAfterS ? retryAfterS * 1000 : 0;
    return { ms: nonAttemptDelayMs(kind === "refused" ? (receiverMs || refusalDelayMs) : nonAttemptDelayMsBase, streak, maxNonAttemptDelayMs, receiverMs), streak };
  };
  // The control split, read from the same shaped record; absent or unusable means no control arm.
  const cf = Number(rhythm.body["control_fraction"]);
  const controlFraction = Number.isFinite(cf) && cf >= 0 && cf <= 1 ? cf : 0;
  const windowMs = posNum(rhythm.body["measure_window_days"], 7) * 86_400_000;
  const bounds: OutcomeBounds = outcomeBoundsOf(rhythm.body);
  const maxOutcomeReads = Math.floor(posNum(rhythm.body["max_outcome_reads"], 50));
  // THE CANDIDATE ORDER, read from the same shaped record. "eligible_never_attempted_first" ranks a band ahead of the
  // rest: never attempted, filed by the system itself (substrate_detected) and with an edit site in the clone, so the
  // system's own writable rows are not starved behind operator retries. Absent, or any other value: today's order.
  const candidateOrder = rhythm.body["candidate_order"];
  const eligibleFirst = candidateOrder === "eligible_never_attempted_first";
  // "eligible_never_attempted_newest_first": the same band, ranked first, and ordered NEWEST first within it (the age key
  // today's order reads, reversed); the rows outside the band keep today's order and follow.
  const newestFirst = candidateOrder === "eligible_never_attempted_newest_first";
  const localNode = checkSupplyNode();

  const read = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  // AN UNREADABLE STORE IS NOT AN EMPTY ONE. On a node that forwards its gap store, a holder that did not answer read as
  // zero rows, and the pass would say "0 due": a pass marker for a pass that read nothing. Said by its own line instead.
  if (read.shape !== "substrateGap") {
    const detail = String(((read.body ?? {}) as Row)["detail"] ?? "").slice(0, 200);
    console.log(`[check-supply] bookkeeping: store_unreadable dispatch=${dispatchDue ? "due" : "undue"} node=${localNode} (${detail})`);
    return { shape: "gapCheckSupplyReport", body: { ...notDue, reason: "store_unreadable", dispatch: dispatchDue ? "due" : "undue", detail } };
  }
  const rows = (((read.body ?? {}) as { gaps?: Row[] }).gaps ?? []).filter((r) => typeof r["id"] === "string");
  const open = rows.filter((r) => String(r["status"] ?? "open") === "open");
  const touched = new Set<string>();
  const armed: string[] = [];
  const notArmed: Array<{ id: string; reason: string }> = [];
  const dispatched: Array<{ id: string; goal: string; dispatch_id: string | null }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const exhausted: string[] = [];
  const controlMarked: string[] = [];
  const localized: Array<{ id: string; edit_site: string; method: string }> = [];
  const outcomes: { not_attempts: Array<{ id: string; kind: string; reason: string; not_before: string }>; failed: Array<{ id: string; reason: string }>; lost: Array<{ id: string; why: LostWhy; reason: string }>; running: number; awaiting_titles: number; waiting: Array<{ id: string; why: LostWhy; detail: string }> } = { not_attempts: [], failed: [], lost: [], running: 0, awaiting_titles: 0, waiting: [] };
  let refused = 0;
  // Attempts the rhythm already holds as settled, and the ones this tick settles (stored by its settlement write).
  const settledBefore = new Set(settledAttemptsOf(rhythm.body));
  const settledNow: string[] = [];
  const resettled: Array<{ id: string; dispatch_id: string | null }> = [];

  // 2. ARM: a dispatched gap whose test has landed (new titles in its test file).
  let armBudget = perTick;
  for (const row of open) {
    // A forwarding node reads on past a spent budget: a row waiting on, or settled by, the holder spends none.
    if (armBudget <= 0 && gapStoreIsLocal()) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    // A failed or lost goal's test may still land late: its titles arm the gap all the same.
    if (!(ledger.state === "goal_dispatched" || ledger.state === "dispatch_failed" || ledger.state === "dispatch_lost" || ledger.state === "non_attempt" || ledger.state === "send_refused") || !ledger.test_file || !ledger.vessel) continue;
    const path = join(clonesRoot(), ledger.vessel, ledger.test_file);
    if (!existsSync(path)) continue;
    let src = "";
    try { src = readFileSync(path, "utf-8"); } catch { src = ""; }
    const baseline = Array.isArray(ledger.baseline_titles) ? ledger.baseline_titles : [];
    const titles = declaredTestTitles(src).filter((t) => !baseline.includes(t)).slice(0, 20);
    if (titles.length === 0) continue; // nothing appended yet: still waiting on the goal
    // The budget bounds the checks run for this tick: here, the ones this node runs; on a node that forwards its gap
    // store, the ones it hands to the holder (counted at the hand-off below), which bounds the holder's load. Waiting on
    // or reading back the holder's verdict spends nothing (a present's report read, below, runs the check once more at
    // the holder, one per settled row); spent on the judge's abstain, it let one row's re-judged unknown block every
    // other row on every tick.
    if (gapStoreIsLocal()) armBudget -= 1;
    touched.add(id);
    // W2, THE VERIFY'S RULE (check-supply-admission.ts checkImportsEditSite): the gap's edit site, imported in any
    // form testImportsFile reads; with none, an existing src module the test imports becomes it.
    const vesselDir = ledger.vessel;
    const vesselReader = srcReaderAt(join(clonesRoot(), vesselDir));
    const site = await checkImportsEditSite(src, ledger.test_file, ledger.edit_site ?? null, (rel) => existsSync(join(clonesRoot(), vesselDir, rel)), vesselReader);
    const editSite = site.ok ? `repos/${vesselDir}/${site.edit_site}` : null;
    const why = onlyTestsProblem(titles)?.detail ?? (site.ok ? null : `${site.stage}: ${site.reason}`);
    if (!site.ok && site.stage === EDIT_SITE_IS_OWN_CHECK) console.log(`[check-supply] refused ${id}: ${EDIT_SITE_IS_OWN_CHECK} (${site.edit_site})`);
    if (why) {
      refused += 1;
      notArmed.push({ id, reason: why });
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: why } });
      continue;
    }
    // F-ARM: a check that reads a name its module does not export is red for the invented name on every tree, never
    // for the defect (2f36f62, route-edit-bd252f8c: mod["shellResult"] on goal-host src/index.ts). Static, before anything
    // runs; the module's real exports come from the same clone the check imports (check-supply-admission.ts).
    const missing = missingExportRefusal(src, ledger.test_file, vesselReader);
    const unguarded = exportGuardUnavailable();
    // A check that only asserts a name exists (or is defined, or has a type) is closed by adding the name: never armed.
    const ex = existenceOnlyCheck(src, titles);
    if (ex.existence_only) {
      const reason = `existence_only: all ${ex.assertions} assertion(s) of the named test(s) only check that a name exists or has a type; a check must assert behaviour${missing ? `; ${missing.reason}` : ""}`;
      refused += 1;
      notArmed.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "existence_only", reason, judged_titles: titles } });
      continue;
    }
    if (missing) {
      refused += 1;
      notArmed.push({ id, reason: missing.reason });
      console.warn(`[gap-check-supply] ${id}: ${missing.reason.slice(0, 240)} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: missing.reason, judged_titles: titles } });
      continue;
    }
    const evidence_resolve = { shape: "test_suite", input: { vessel: `repos/${ledger.vessel}`, test_file: ledger.test_file, only_tests: titles }, zero_field: "requested_not_passing" };
    // THE BIRTH VERDICT IS TAKEN WHERE THE STORE IS HELD. Here, the one judge with its report. On a node that forwards
    // its gap store the judge abstains ('unknown'), so the row was re-judged on every tick and never armed; and the
    // minted stamp never crosses the forward anyway (gateThenForward sends the pointer only), so the holder's write seam
    // judges every forwarded check itself (applyBirthStamp: a new class-2 check is stamped pending and run there, through
    // the same judge, on the holder's tree). So this node HANDS THE CANDIDATE OFF: it writes the check, keeping the
    // needs-localization hold, and settles from the holder's stamp on a later tick. The row is held (not eligible, and
    // pending is predicate_suspect) until a measured 'present' for this exact check is read back here.
    let verdict: "present" | "absent" | "unknown";
    let report: Record<string, unknown> | null = null;
    let stamp: MintedBirthVerdict | undefined;
    if (gapStoreIsLocal()) {
      ({ verdict, report, stamp } = await takeBirthVerdictWithReport(id, { ...meta, evidence_resolve, edit_site: editSite }));
    } else {
      const atHolder = meta["predicate_birth_key"] === class2PredicateKey({ ...meta, evidence_resolve }) ? meta["predicate_birth_verdict"] : undefined;
      if (atHolder === undefined) {
        if (armBudget <= 0) { notArmed.push({ id, reason: "hand_off_deferred: this tick's max_per_tick hand-offs are spent; next tick" }); continue; }
        armBudget -= 1;
        notArmed.push({ id, reason: "birth_verdict_at_holder: the check was handed to the gap-store holder, which measures it" });
        if (pointer.dry_run) continue;
        const holdable = !nonEmpty(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION;
        const w = await writeMeta(row, { evidence_resolve, edit_site: editSite, predicate_source: CHECK_SUPPLY_SOURCE, ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}) });
        if (w.shape === "structuredError") console.warn(`[gap-check-supply] ${id}: hand-off to the gap-store holder refused: ${JSON.stringify(w.body).slice(0, 200)}`);
        else console.log(`[gap-check-supply] ${id}: check ${JSON.stringify(titles)} handed to the gap-store holder for its birth verdict; held until it reads present`);
        continue;
      }
      // An absent the holder re-labelled unknown because its tree moved is still the check passing at HEAD.
      verdict = atHolder === "present" ? "present" : atHolder === "absent" || (atHolder === "unknown" && birthTreeMoved(meta)) ? "absent" : "unknown";
      if (verdict === "unknown") { notArmed.push({ id, reason: `awaiting_holder_verdict: ${String(atHolder)}` }); continue; }
      // THE GATES BELOW RUN ON EVERY NODE. The holder's stamp carries no report, and without one every handed-off check
      // armed ungated here (a check red for the wrong reason, or on a contract its target lacks, armed hollow). A present
      // reads its report where it was measured (holderCheckReport); a report that cannot be read arms nothing, and the
      // row is read again on the next tick. Reading it is a settlement, not a hand-off: it spends no max_per_tick.
      if (verdict === "present") {
        const held = await holderCheckReport(evidence_resolve);
        if (!held.report) {
          notArmed.push({ id, reason: `awaiting_holder_report: ${held.detail}` });
          console.warn(`[gap-check-supply] ${id}: the holder's present is not armed until its run report is read (${held.detail})`);
          continue;
        }
        report = held.report;
      }
    }
    // RED FOR THE RIGHT REASON, BY THE SHARED CLASSIFIER: every named test among the failures (redForTheRightReason)
    // AND each an assertion in the report's red_reason (retry-evidence.ts), the rule feature_compose's verify applies.
    // A report without red_reason cannot attribute its red: nothing is armed. Wherever the store is held: a handed-off
    // check is judged from the holder's report of it, read above.
    // An assertion red on a contract the target does not have (333be5f: a shape and a body field the resolver never
    // returns) is red on every tree: contractMismatchRefusal, the verify's rule, judged from the same report.
    const redReason = (report as Record<string, unknown> | null)?.["red_reason"];
    const classified = verdict === "present" ? armRedReasonRefusal(redReason, titles) : null;
    const gateReason = verdict === "present" ? redForTheRightReason(report, titles) ?? (classified ? `${classified.cause ? `${classified.cause}: ` : ""}${classified.reason}` : null) ?? contractMismatchRefusal(src, ledger.test_file, redReason, vesselReader)?.reason ?? castCalleeRefusal(src, ledger.test_file, vesselReader)?.reason ?? null : null;
    // Last, as the costliest: is the red about the edit site at all (EDIT-SITE MUTATION GATE)?
    const mutation = verdict === "present" && !gateReason && site.ok
      ? await editSiteMutationGate({ vessel: vesselDir, siteRel: site.edit_site, testFile: ledger.test_file, checkSrc: src, titles, baseline: report, k: coverageKnobs(rhythm.body).k })
      : null;
    if (mutation?.kind === "wait") {
      notArmed.push({ id, reason: `awaiting_mutation_runs: ${mutation.detail}` });
      console.warn(`[gap-check-supply] ${id}: not armed until its edit-site mutant runs are read (${mutation.detail})`);
      continue;
    }
    const wrongReason = gateReason ?? (mutation?.kind === "refuse" ? mutation.reason : null);
    const mutationRecord = mutation ? { mutation_gate: mutation.record } : {};
    // What the red was at birth (the first failure's error line and the values it compared), kept on the ledger.
    const firstFailure = firstFailureOf(redReason);
    if (verdict !== "present" || wrongReason) {
      // GREEN AT HEAD, OR RED FOR THE WRONG REASON, ARMS NOTHING. An unknown keeps the row's state and is judged again:
      // turned back to goal_dispatched, a settled failure was read back and settled again on the next tick.
      const unknown = verdict === "unknown";
      const state = unknown ? ledger.state : verdict === "absent" ? "green_at_head" : "arm_refused";
      if (!unknown) refused += 1;
      notArmed.push({ id, reason: wrongReason ?? (verdict === "absent" ? "green_at_head" : "verdict_unknown") });
      if (state === "green_at_head") console.warn(`[gap-check-supply] ${id}: green_at_head — the new check(s) ${JSON.stringify(titles)} pass at HEAD, so they do not reproduce the defect; not armed (the next attempt is told)`);
      const judged = unknown ? {} : { judged_titles: titles, reason: wrongReason ?? "green_at_head: the new check(s) pass at HEAD", ...(firstFailure ? { first_failure: firstFailure } : {}), ...mutationRecord };
      // A handed-off check judged not to arm (green, or red for the wrong reason) is taken back off the row, so it reads
      // unarmed and is asked again, whichever node judges it: the holder's own tick may reach a handed-off row first.
      const handedOff = !unknown && meta["predicate_birth_key"] === class2PredicateKey({ ...meta, evidence_resolve });
      if (!pointer.dry_run) await writeMeta(row, { ...(handedOff ? { evidence_resolve: null } : {}), check_supply: { ...ledger, state, last_verdict: verdict, ...judged } });
      continue;
    }
    if (pointer.dry_run) { armed.push(id); continue; }
    const w = await writeMeta(row, {
      evidence_resolve,
      edit_site: editSite,
      predicate_source: CHECK_SUPPLY_SOURCE,
      disposition: meta["disposition"] === CHECK_SUPPLY_DISPOSITION ? "" : meta["disposition"] ?? "",
      check_supply: { ...ledger, state: "armed", armed_at: nowIso, red_at_head: true, last_verdict: verdict, non_attempt_streak: 0, ...(firstFailure ? { first_failure: firstFailure } : {}), ...(unguarded ? { guard_decided_nothing: unguarded } : {}), ...mutationRecord },
    }, stamp ? { birthVerdict: stamp } : undefined); // the verdict minted by the run above (the seam honours nothing else), or the holder's own
    if (w.shape === "structuredError") {
      const reason = `arm write refused: ${JSON.stringify(w.body).slice(0, 200)}`;
      refused += 1;
      notArmed.push({ id, reason });
      await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason } });
    } else {
      armed.push(id);
    }
  }

  // 2b. OUTCOME: read back each in-flight goal this tick did not arm from.
  let outcomeReads = 0;
  for (const row of open) {
    const id = String(row["id"]);
    if (touched.has(id)) continue;
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    if (ledger.state !== "goal_dispatched") continue;
    const owner = nonEmpty(ledger.dispatch_node) ? String(ledger.dispatch_node) : null;
    const mine = owner === null || owner === localNode;
    if (mine && nonEmpty(ledger.dispatch_id) && outcomeReads >= maxOutcomeReads) continue;
    let probe: DispatchProbe | null = null;
    if (mine && nonEmpty(ledger.dispatch_id)) { outcomeReads += 1; probe = await probeDispatch(String(ledger.dispatch_id)); }
    const v = dispatchVerdict(ledger, probe, now, bounds, localNode);
    if (v.kind === "running") { outcomes.running += 1; continue; }
    if (v.kind === "awaiting_titles") { outcomes.awaiting_titles += 1; continue; }
    if (v.kind === "wait") {
      outcomes.waiting.push({ id, why: v.why, detail: v.detail });
      console.warn(`[gap-check-supply] outcome unread for ${id}: ${v.why}: ${v.detail}`);
      continue;
    }
    const outcome: Row = { read_at: nowIso, read_by: localNode, ...(probe && probe.http !== "unreachable" ? { http: probe.http, status: probe.status ?? null, reached: probe.reached ?? null, ...(probe.outcome !== undefined ? { outcome: probe.outcome } : {}) } : {}), ...(v.kind === "lost" ? { lost_why: v.why } : {}) };
    if (v.kind === "non_attempt" || v.kind === "refused") {
      // NOT A FAILED ATTEMPT (CHANGE-30): no dispatch_failed, the attempt given back, the shaped wait recorded.
      const d = delayFor(v.kind, ledger, v.retry_after_s);
      const held = nonAttemptLedger(ledger, v.kind, v.reason, d.ms, now, outcome, d.streak);
      outcomes.not_attempts.push({ id, kind: v.kind, reason: v.reason, not_before: String(held.not_before) });
      console.log(`[gap-check-supply] outcome ${held.state} for ${id} (not charged; next not before ${held.not_before}): ${v.reason}`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: held });
      (meta as Row)["check_supply"] = held;
      continue;
    }
    const next: Ledger = { ...ledger, state: v.kind === "failed" ? "dispatch_failed" : "dispatch_lost", reason: v.reason, outcome, non_attempt_streak: 0 };
    const did = nonEmpty(ledger.dispatch_id) ? String(ledger.dispatch_id) : null;
    // ONE DEBIT PER ATTEMPT (settledAttemptKey): an attempt the rhythm already holds as settled is re-recorded, never re-debited.
    const key = settledAttemptKey(id, ledger);
    const again = settledBefore.has(key) || settledNow.includes(key);
    if (again) resettled.push({ id, dispatch_id: did });
    else { refused += 1; settledNow.push(key); }
    if (v.kind === "failed") outcomes.failed.push({ id, reason: v.reason }); else outcomes.lost.push({ id, why: v.why, reason: v.reason });
    console.log(`[gap-check-supply] outcome ${next.state} for ${id} (dispatch ${did ?? "none"}${again ? ", settled before: not debited again" : ""}): ${v.reason}`);
    if (!pointer.dry_run) {
      try {
        const w = await writeMeta(row, { check_supply: next });
        if (w.shape === "structuredError") console.warn(`[gap-check-supply] settlement write for ${id} (dispatch ${did ?? "none"}) refused, the row stays as read: ${JSON.stringify(w.body).slice(0, 200)}`);
      } catch (err) {
        console.warn(`[gap-check-supply] settlement write for ${id} (dispatch ${did ?? "none"}) lost: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
    // The same tick's dispatch step sees the settled ledger (a due retry may be sent now).
    (meta as Row)["check_supply"] = next;
  }
  const outcomesSettled = outcomes.failed.length + outcomes.lost.length + outcomes.not_attempts.length;

  // AN ARMED ROW WHOSE EDIT SITE IS ITS OWN CHECK IS UN-ARMED (gap-eligibility editSiteIsOwnCheck). No pick or compose
  // takes it (edit_site_is_own_check), but a row nothing else writes would stay labelled class2; this write lets the
  // write seam re-label its check unresolvable with the named reason, and records the decision on the row.
  const unarmedOwnCheck: string[] = [];
  for (const row of open) {
    const id = String(row["id"]);
    const own = touched.has(id) || falsifierClassOf(metaOf(row)) !== "class2" ? null : editSiteIsOwnCheck(row);
    if (!own) continue;
    touched.add(id);
    unarmedOwnCheck.push(id);
    console.log(`[check-supply] un-armed ${id}: ${EDIT_SITE_IS_OWN_CHECK} (${own.site})`);
    if (!pointer.dry_run) await writeMeta(row, ownCheckUnarmMeta(own, nowIso));
  }

  // A row marked needs_localization that something else has since armed: release the hold.
  let released = 0;
  for (const row of open) {
    const meta = metaOf(row);
    if (meta["disposition"] !== CHECK_SUPPLY_DISPOSITION || touched.has(String(row["id"]))) continue;
    const cls = falsifierClassOf(meta);
    // A check not yet measured present (a handed-off one still pending at the holder) has not armed the row.
    if ((cls === "class1" || cls === "class2") && predicateSuspect(meta) === null && !pointer.dry_run) {
      touched.add(String(row["id"]));
      released += 1;
      await writeMeta(row, { disposition: "" });
    }
  }
  const keep = Math.floor(posNum(rhythm.body["settled_attempts_kept"], 200));
  const settledKeys = (): Row => (settledNow.length > 0 ? { settled_attempts: [...settledAttemptsOf(rhythm.body), ...settledNow].slice(-keep) } : {});
  const bookkeepingLine = (dispatch: "due" | "undue"): void => {
    const counts = `armed=${armed.length} outcomes=${outcomesSettled} unarmed=${unarmedOwnCheck.length} released=${released}`;
    // THE PASS MARKER: exactly one per pass that ran (a floored, in-progress, paused or rhythm-less call logs none).
    console.log(`[check-supply] bookkeeping: ${armed.length + outcomesSettled + unarmedOwnCheck.length + released === 0 ? "0 due " : ""}${counts} waiting=${outcomes.waiting.length} dispatch=${dispatch} node=${localNode}`);
  };
  if (!dispatchDue) {
    // NOT DUE: the bookkeeping is the whole pass. Its debits (a refused check, a failed or lost goal, once per attempt
    // by settled_attempts) are written as today's beta leg, which persists the accrued staleness, so the family's due
    // clock moves only by the debit itself; an arm earns no credit here (credit and staleness are answered by a fire).
    const leg = refused > 0 ? "beta" : null;
    if (leg && !pointer.dry_run) await settleFamily(rhythm, leg, due, undefined, settledKeys());
    bookkeepingLine("undue");
    return {
      shape: "gapCheckSupplyReport",
      body: {
        ...notDue,
        dispatch: "undue",
        settlement: leg ?? "none",
        armed,
        not_armed: notArmed,
        refused,
        ...(resettled.length ? { resettled } : {}),
        ...(unarmedOwnCheck.length ? { unarmed_own_check: unarmedOwnCheck } : {}),
        released,
        outcomes,
        dry_run: pointer.dry_run === true,
      },
    };
  }

  // 3. DISPATCH: one test-writing goal per treatment-arm needs-localization gap, fewest attempts and oldest first.
  // A settled attempt (failed or lost) past its backoff is a DUE RETRY: it goes ahead of fresh gaps, or a steady inflow
  // of fresh gaps starves it forever (the backoff and max_attempts already bound how often it can come back).
  const dueRetry = (r: Row): boolean => {
    const l = ledgerOf(metaOf(r));
    if (l.state === "non_attempt" || l.state === "send_refused") { const nb = Date.parse(String(l.not_before ?? "")); return !Number.isFinite(nb) || now >= nb; }
    if (l.state !== "dispatch_failed" && l.state !== "dispatch_lost") return false;
    const n = Number(l.attempts ?? 0);
    const last = Date.parse(String(l.last_dispatch_at ?? ""));
    return n > 0 && n < maxAttempts && (!Number.isFinite(last) || now >= last + backoffMs * 2 ** (n - 1));
  };
  const neverAttemptedSystemSited = (r: Row): boolean => {
    const v = checkSupplyVessel(r);
    return Number(ledgerOf(metaOf(r)).attempts ?? 0) === 0 && r["source"] === "substrate_detected" && Boolean(v && checkSupplySite(r, v));
  };
  console.log(`[check-supply] candidate_order=${eligibleFirst ? "eligible_never_attempted_first" : newestFirst ? "eligible_never_attempted_newest_first" : candidateOrder === undefined ? "default" : `default (unrecognised ${JSON.stringify(candidateOrder)})`}`);
  const candidates = open
    .filter((r) => !touched.has(String(r["id"])) && checkSupplyDisposition(r) !== null)
    .sort((a, b) => {
      // The band first (candidate_order above), then today's order within each band.
      if (eligibleFirst) { const ba = neverAttemptedSystemSited(a); const bb = neverAttemptedSystemSited(b); if (ba !== bb) return ba ? -1 : 1; }
      if (newestFirst) {
        const ba = neverAttemptedSystemSited(a); const bb = neverAttemptedSystemSited(b);
        if (ba !== bb) return ba ? -1 : 1;
        // Within the band, newest first: today's age key, reversed. A tie falls through to today's order.
        if (ba) { const age = String(b["first_detected_at"] ?? b["detected_at"] ?? "").localeCompare(String(a["first_detected_at"] ?? a["detected_at"] ?? "")); if (age !== 0) return age; }
      }
      const ra = dueRetry(a); const rb = dueRetry(b);
      if (ra !== rb) return ra ? -1 : 1;
      // Priority after attempts: writable (existing edit site in clone) > stated falsifier_spec > oldest first
      const ma = metaOf(a); const mb = metaOf(b);
      const la = ledgerOf(ma); const lb = ledgerOf(mb);
      const attemptDiff = Number(la.attempts ?? 0) - Number(lb.attempts ?? 0);
      if (attemptDiff !== 0) return attemptDiff;
      const va = checkSupplyVessel(a); const vb = checkSupplyVessel(b);
      const hasSiteA = Boolean(va && checkSupplySite(a, va));
      const hasSiteB = Boolean(vb && checkSupplySite(b, vb));
      if (hasSiteA !== hasSiteB) return hasSiteA ? -1 : 1; // existing edit site FIRST
      const hasFalsifierA = typeof ma["falsifier_spec"] === "string" && String(ma["falsifier_spec"]).trim().length > 0;
      const hasFalsifierB = typeof mb["falsifier_spec"] === "string" && String(mb["falsifier_spec"]).trim().length > 0;
      if (hasFalsifierA !== hasFalsifierB) return hasFalsifierA ? -1 : 1; // stated falsifier FIRST
      return String(a["first_detected_at"] ?? a["detected_at"] ?? "").localeCompare(String(b["first_detected_at"] ?? b["detected_at"] ?? ""));
    });
  const anchorsOf = new Map<string, CheckAnchor[]>();
  const declCache = new Map<string, Set<string>>();
  /** With no edit site, a symbol resolves only if the vessel's own src declares it (cached per tick). */
  const vesselDeclarations = (vessel: string, reader: SrcReader): Set<string> => {
    const hit = declCache.get(vessel);
    if (hit) return hit;
    const names = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const rel of reader.list(dir)) {
        if (/\.(?:[cm]?[jt]sx?)$/.test(rel) && !/\.(?:test|check)\./.test(rel)) { const src = reader.read(rel); if (src) for (const n of declaredNames(src)) names.add(n); }
        else if (!/\.[A-Za-z0-9]+$/.test(rel)) walk(rel, depth + 1);
      }
    };
    walk("src", 0);
    declCache.set(vessel, names);
    return names;
  };
  let scopeRead: AutonomyScope | null = null;
  let scopeUnread: string | null = null;
  const scopeOnce = async (): Promise<AutonomyScope> => (scopeRead ??= await readScopeSelf());
  // Goals placed on each peer this tick: debited from the free slots it reports (a peek, not a claim).
  const placedThisTick = new Map<string, number>();
  for (const row of candidates) {
    if (dispatched.length >= perTick && controlMarked.length >= perTick) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    const holdable = !nonEmpty(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION;
    if (checkSupplyArm(id, controlFraction) === "control") {
      // CONTROL ARM: classified and recorded, never sent a goal.
      if (meta["gap_check_supply_arm"] === "control" || controlMarked.length >= perTick) continue;
      controlMarked.push(id);
      if (!pointer.dry_run) await writeMeta(row, { ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}), gap_check_supply_arm: "control" });
      continue;
    }
    if (dispatched.length >= perTick) continue;
    if (ledger.state === "armed" || ledger.state === "exhausted") continue;
    // A goal in flight is settled by the OUTCOME step (read back, or lost past the bound), never by sending another.
    if (ledger.state === "goal_dispatched") continue;
    const attempts = Number(ledger.attempts ?? 0);
    const last = Date.parse(String(ledger.last_dispatch_at ?? ""));
    if (ledger.state === "non_attempt" || ledger.state === "send_refused") {
      const nb = Date.parse(String(ledger.not_before ?? ""));
      if (Number.isFinite(nb) && now < nb) continue; // its own shaped wait (CHANGE-30), not the attempt backoff
    } else if (attempts > 0 && Number.isFinite(last) && now < last + backoffMs * 2 ** (attempts - 1)) continue;
    if (attempts >= maxAttempts) {
      exhausted.push(id);
      const hist = settledHistory(ledger);
      const whys = hist.map((h) => String((h["outcome"] as Row | undefined)?.["lost_why"] ?? h["state"] ?? "?")).join(", ");
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, history: hist, state: "exhausted", reason: `${attempts} test-writing goals did not yield a red check${whys ? ` (attempts settled as: ${whys})` : ""}` } });
      continue;
    }
    const vessel = checkSupplyVessel(row);
    if (!vessel) { skipped.push({ id, reason: "no_vessel" }); continue; }
    // ALWAYS THE GAP'S OWN CHECK FILE (B′), never an existing test and never an older ledger's discovered *.test.ts:
    // an intended red in a file bun discovers reads as a regression in every whole-suite run.
    const site = checkSupplySite(row, vessel);
    const testFile = checkSupplyTestFile(id);
    // SCOPE: a goal whose target (the edit site, or the vessel, and the check file) the live autonomyScope excludes can
    // never land through the lane. No goal; one skip record. An absent or unreadable record decides nothing here (the
    // lane's admission is the containment) and is reported once per tick.
    const scope = await scopeOnce();
    if (!scope.readable && !scopeUnread) { scopeUnread = scope.reason; console.warn(`[gap-check-supply] scope not applied this tick: ${scope.reason}`); }
    const targets = checkSupplyScopeTargets(vessel, site, testFile);
    const hit = scope.readable ? targets.map((t) => ({ t, e: autonomyScopeExcludes(scope, t) })).find((x) => x.e !== null) : undefined;
    if (hit) {
      const reason = `target ${hit.t} is excluded by the autonomy scope (${hit.e}); the lane could never land it`;
      skipped.push({ id, reason });
      if (!pointer.dry_run && !(ledger.state === "scope_excluded" && ledger.reason === reason)) await writeMeta(row, { check_supply: { ...ledger, state: "scope_excluded", reason } });
      continue;
    }
    // I1: a gap that has its check and lacks only a site is LOCALIZED, never sent a test-writing goal.
    if (localizableBySupply(row)) {
      if (localized.length >= perTick) continue; // the same shaped per-tick bound as a dispatch (max_per_tick)
      const loc = await localizeForSupply(row, vessel, site);
      const locExcl = loc && scope.readable ? autonomyScopeExcludes(scope, loc.file) : null;
      if (!loc || locExcl) {
        const reason = !loc ? "no_site: no src file named by the gap's evidence exists, and the localizer found no confident one" : `localized site ${loc.file} is excluded by the autonomy scope (${locExcl})`;
        skipped.push({ id, reason });
        continue;
      }
      if (pointer.dry_run) { localized.push({ id, edit_site: loc.file, method: loc.method }); continue; }
      const record = { gap_id: id, file: loc.file, evidence: loc.evidence, method: loc.method, created_at: nowIso };
      const lw = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: { id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open",
          classification_metadata: { edit_site: loc.file, localized_by: "gap-check-supply", localization_method: loc.method }, localization: record },
      } as never);
      if (lw.shape === "structuredError") { skipped.push({ id, reason: `localization write refused: ${JSON.stringify(lw.body).slice(0, 160)}` }); continue; }
      touched.add(id);
      localized.push({ id, edit_site: loc.file, method: loc.method });
      continue;
    }
    const mode = "check_file";
    // The titles the check file already holds (a previous attempt's landed, refused check): only titles added after
    // this dispatch can arm the gap.
    let baselineTitles: string[] = [];
    try { baselineTitles = declaredTestTitles(readFileSync(join(clonesRoot(), vessel, testFile), "utf-8")); } catch { baselineTitles = []; }
    const summary = String(row["summary"] ?? "");
    const reader = srcReaderAt(join(clonesRoot(), vessel));
    const siteRel = vesselRelativeEditSite(site);
    const siteSrc = siteRel ? reader.read(siteRel) : null;
    // A CODE site needs a falsifiable anchor from the evidence; never guess one (a config site's goal is built from the
    // template it names). No anchor: no goal, one loud skip record, re-read every tick in case the evidence grows.
    if (!configEditSite(siteRel, siteSrc)) {
      const spec = typeof meta["falsifier_spec"] === "string" ? String(meta["falsifier_spec"]) : "";
      const anchors = falsifiableAnchors(summary, siteSrc, spec, siteSrc === null ? vesselDeclarations(vessel, reader) : null);
      if (anchors.length === 0) {
        skipped.push({ id, reason: NO_ANCHOR_REASON });
        console.warn(`[gap-check-supply] ${id}: ${NO_ANCHOR_REASON}; no check goal (falsifier stays unknown)`);
        if (!pointer.dry_run && !(ledger.state === "no_anchor" && ledger.reason === NO_ANCHOR_REASON)) await writeMeta(row, { check_supply: { ...ledger, state: "no_anchor", reason: NO_ANCHOR_REASON } });
        continue;
      }
      anchorsOf.set(id, anchors);
    }
    const goal = checkSupplyGoal(vessel, testFile, summary, site, reader, anchorsOf.get(id) ?? [], settledHistory(ledger));
    if (pointer.dry_run) { dispatched.push({ id, goal, dispatch_id: null }); continue; }
    // RECORD BEFORE SEND (CHANGE-30): the in-flight record is written FIRST, without the goal text, so no send is ever
    // unrecorded. If even that write is refused, nothing is sent: a send this tick cannot record is a send the next
    // tick would repeat (the 455-a-day loop). A crash between this write and the send settles through the existing
    // no_dispatch_id path (lost past the staleness bound), so the record is safe to leave.
    // PLACEMENT (law 11, compose-placement.ts): with no free local slot of the class this compose is admitted as (a
    // supply compose is never armed: feature_compose's composeArmed), a peer that composes the vessel, sees the row,
    // admits the targets and has a free slot takes it. Decided before the record, so the record names where it went.
    const placement = await placeCompose({ gap_id: id, vessel, targets, armed: false }, localNode, placedThisTick);
    const placed = placement.where === "peer" ? placement : null;
    if (placed) console.log(`[gap-check-supply] ${id}: placed on ${placed.node}: ${placed.why}`);
    const { goal: _priorGoal, not_before: _priorNotBefore, placed_by: _priorPlacedBy, placement: _priorPlacement, ...ledgerRest } = ledger;
    void _priorGoal; void _priorNotBefore; void _priorPlacedBy; void _priorPlacement;
    const intent: Ledger = { ...ledgerRest, state: "goal_dispatched", attempts: attempts + 1, last_dispatch_at: nowIso, test_file: testFile, vessel, mode,
      baseline_titles: baselineTitles, edit_site: site, dispatch_id: null, dispatch_node: placed ? placed.node : localNode, dispatch_host: placed ? placed.via : GOAL_HOST_ENDPOINT,
      ...(placed ? { placed_by: localNode, placement: placed.why } : {}), reason: "", outcome: {}, history: settledHistory(ledger) };
    const arm = { ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}), gap_check_supply_arm: "treatment" };
    const iw = await writeMeta(row, { ...arm, check_supply: intent });
    if (iw.shape === "structuredError") {
      const reason = `not sent: the in-flight record could not be written (${String((iw.body as Row)?.["detail"] ?? (iw.body as Row)?.["failure_mode"] ?? "").slice(0, 120)})`;
      skipped.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason}`);
      // A REFUSED WRITE MAY STILL LAND. On a node that forwards its gap store, "unreachable: The operation timed out"
      // is this side's timeout, not the holder's refusal: five rows were left at goal_dispatched with no dispatch id
      // and no goal for a send that never happened. Nothing was sent, so if the store now holds THIS pass's in-flight
      // record it is put back as it was read; if it does not, nothing is written (the store has no conditional write,
      // and a write here could only race a late intent). Either way an intent that lands late cannot stay: OUTCOME
      // settles a goal_dispatched row with no dispatch id as dispatch_lost (no_dispatch_id) past dispatch_stale_hours.
      const reread = await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
      const stored = ledgerOf(metaOf((((reread.body ?? {}) as { gaps?: Row[] }).gaps ?? [])[0] ?? {}));
      if (stored.state === "goal_dispatched" && !nonEmpty(stored.dispatch_id) && stored.last_dispatch_at === nowIso) {
        const back = await writeMeta(row, { check_supply: ledger });
        console.warn(`[gap-check-supply] ${id}: the unsent in-flight record had landed; ${back.shape === "structuredError" ? "it could not be put back, so the no_dispatch_id bound settles it" : "put back as read"}`);
      }
      continue;
    }
    const send = { type: "dispatch_goal" as const, goal, variables: { gap_id: id, check_supply: true }, timeout_ms: 15_000 };
    const r = placed ? await dispatchGoalOnPeer(placed.via, send) : await resolveDispatchGoal(send);
    if (r.shape !== "goalDispatchResult") {
      // ONE classification of the send (CHANGE-30): a refusal or a non-attempt is recorded as what it is, with its wait;
      // only a genuine failed send is an attempt.
      const c = classifySendFailure(r);
      if (c.kind === "failed") {
        refused += 1;
        skipped.push({ id, reason: `dispatch failed: ${c.reason.slice(0, 120)}` });
        await writeMeta(row, { ...arm, check_supply: { ...intent, state: "dispatch_failed", reason: `dispatch failed: ${c.reason}`, outcome: { send_failed: true, http: c.http_status }, non_attempt_streak: 0 } });
      } else {
        const d = delayFor(c.kind, intent, c.retry_after_s);
        const held = nonAttemptLedger(intent, c.kind, `${c.kind === "refused" ? "send refused by the receiver" : "send not taken (non-attempt)"}: ${c.reason}`, d.ms, now, { send_failed: true, http: c.http_status, kind: c.kind }, d.streak);
        outcomes.not_attempts.push({ id, kind: c.kind, reason: String(held.reason), not_before: String(held.not_before) });
        skipped.push({ id, reason: String(held.reason).slice(0, 160) });
        console.warn(`[gap-check-supply] ${id}: ${held.state} (not charged; next not before ${held.not_before}): ${c.reason.slice(0, 160)}`);
        await writeMeta(row, { ...arm, check_supply: held });
      }
      continue;
    }
    const dispatchId = ((r.body ?? {}) as { dispatch_id?: string | null }).dispatch_id ?? null;
    dispatched.push({ id, goal, dispatch_id: dispatchId });
    const sent: Ledger = { ...intent, dispatch_id: dispatchId, goal };
    const w = await writeMeta(row, { ...arm, check_supply: sent });
    // The full record (with the goal text) refused: keep the dispatch id at least, so its outcome stays readable.
    if (w.shape === "structuredError") await writeMeta(row, { ...arm, check_supply: { ...intent, dispatch_id: dispatchId } });
  }

  // A localized gap is work done this tick (I1), graded as a dispatch is.
  const leg = checkSupplySettlementLeg({ dispatched: dispatched.length + localized.length, armed: armed.length, refused });
  if (leg && !pointer.dry_run) await settleFamily(rhythm, leg, due, undefined, settledKeys());
  bookkeepingLine("due");

  const after = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  const afterRows = ((after.body ?? {}) as { gaps?: Row[] }).gaps ?? [];
  const measures = checkSupplyMeasures(afterRows, now - windowMs);
  const arms = { treatment: 0, control: 0 };
  for (const r of afterRows) {
    const a = metaOf(r)["gap_check_supply_arm"];
    if (a === "treatment" || a === "control") arms[a] += 1;
  }
  return {
    shape: "gapCheckSupplyReport",
    body: {
      fired: dispatched.length + armed.length + localized.length > 0,
      reason: leg === "alpha" ? "due" : leg === "beta" ? "refused" : "nothing_to_do",
      settlement: leg ?? "none",
      due_score: due.due_score,
      needs_localization: open.filter((r) => checkSupplyDisposition(r) !== null).length,
      dispatched,
      armed,
      not_armed: notArmed,
      refused,
      ...(resettled.length ? { resettled } : {}),
      exhausted,
      control_marked: controlMarked,
      localized,
      ...(unarmedOwnCheck.length ? { unarmed_own_check: unarmedOwnCheck } : {}),
      outcomes,
      ...(scopeUnread ? { scope_unread: scopeUnread } : {}),
      arms,
      skipped: skipped.slice(0, 25),
      measures,
      dry_run: pointer.dry_run === true,
    },
  };
}
