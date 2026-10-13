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
 *      clearing the disposition in the same write. Green at HEAD, red for the wrong reason, or a test that does
 *      not import the edit site writes no check: the gap stays unarmed (fail closed). No region is written, so
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
 *
 * CADENCE IS A RHYTHM (law 5). The family's timeShapedRhythm impulse is read at use time: no rhythm means no
 * work (reason no_rhythm), a rhythm not due by the conductor's own formula (rhythmDueScore) means no work, and
 * the per-tick bound, backoff and attempt cap come from the same impulse's body. The rhythm conductor fires the
 * family through FAMILY_RESOLVERS and leaves it PENDING; this resolver settles its family from its REPORT when it
 * completes (checkSupplySettlementLeg), whichever entry ran it, so no exit is ever credited as success.
 *
 * MEASURES (counters on the report, not traces): of the armed gaps whose check was born in the window, the
 * share whose check the system wrote (predicate_source gap_check_supply), and of those the share verified red
 * at HEAD (predicate_birth_verdict present).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, takeBirthVerdictWithReport } from "./substrate-gap.js";
import {
  CHECK_SUPPLY_DISPOSITION,
  composeEligibilitySkipReason,
  gapEditSite,
  isAwaitingLandVerification,
  isParkingDisposition,
} from "../judge/gap-eligibility.js";
import { autonomyScopeExcludes, identifyVessel, type AutonomyScope } from "../judge/gap-policy.js";
import { checkImportsEditSite, checkSupplyCheckPath, configEditSite, configSiteCheckGoal, consumerResolverModules, srcReaderAt, vesselRelativeEditSite, type SrcReader } from "./check-supply-admission.js";
import { readFamilyRhythm, rhythmDueScore, rhythmSettlementOverlay, type RhythmBody } from "./rhythm-conductor-tick.js";
// The check-run judge lives with the evaluator (scope-earn-in.ts, an excluded file): item 2 reads it from there.
import { redForTheRightReason } from "./scope-earn-in.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";
import { armRedReasonRefusal, testTitleInSource } from "./retry-evidence.js";
import { onlyTestsProblem } from "./test-suite.js";
import { selfAuthHeaders } from "../lib/self-auth.js";
import { METABOB_API_KEY } from "../config.js";

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
  /** The outcome read back for the last dispatch (status, reached, why it was lost, where and when it was read). */
  outcome?: Row;
  /** The settled attempts before the current one (state, reason, outcome), newest last, at most five. */
  history?: Row[];
};
const settledHistory = (l: Ledger): Row[] => {
  const prior = Array.isArray(l.history) ? l.history.slice(-4) : [];
  return l.state === "dispatch_failed" || l.state === "dispatch_lost"
    ? [...prior, { attempt: Number(l.attempts ?? 0), state: l.state, reason: l.reason ?? "", outcome: l.outcome ?? {} }]
    : prior;
};

export interface GapCheckSupplyTickPointer {
  type: "gap_check_supply_tick";
  /** The tick's clock (ms). Tests pin it; production reads Date.now(). */
  now_ms?: number;
  /** Carried by the conductor's FAMILY_RESOLVERS entry ("report"): this resolver settles its family by its report. */
  settled_by?: string;
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
const clonesRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";
const runtimeRoot = (): string => process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";

/**
 * NEEDS-LOCALIZATION: an open gap the lane cannot take only because it has no check of its own (or no edit site),
 * and that nothing else holds. null for every gap that is compose work already, held by a human or a landing,
 * closed, carrying a literal predicate of its own (a different repair), or routed elsewhere (orphan producers).
 */
export function checkSupplyDisposition(row: Row): typeof CHECK_SUPPLY_DISPOSITION | null {
  if (String(row["status"] ?? "open") !== "open") return null;
  const meta = metaOf(row);
  if (meta["operator_hold"] === true || isParkingDisposition(meta["disposition"]) || isAwaitingLandVerification(row)) return null;
  if (nonEmpty(meta["expected_literal"]) || nonEmpty(meta["hardcoded_url"])) return null;
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

/** A gap's experiment arm, stable for its id: hash parity. Control-arm gaps are classified but get no goal, so the
 *  supply's effect on arming and closure can be measured against gaps it did not touch (law 12). */
export function checkSupplyArm(gapId: string): "treatment" | "control" {
  return (createHash("sha256").update(gapId).digest()[0]! & 1) === 0 ? "treatment" : "control";
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

export function checkSupplyGoal(vessel: string, testFile: string, summary: string, site: string | null = null, reader?: SrcReader, anchors: readonly CheckAnchor[] = []): string {
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
  return `Write ONE failing test in repos/${vessel}/${testFile} that reproduces: ${symptomOf(summary)}. ` +
    `Its expect() assertion fails because of the defect, not because the file fails to load: ${imp}. ` + named +
    "No network, no services, no timers. Do not change src/ or any other file.";
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

// ─── the dispatch's outcome, read back ──────────────────────────────────────

const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
/** This node's identity in a ledger (bootstrap identity, the same one the lane's pick line names as owner). */
export const checkSupplyNode = (): string => process.env["SUBSTRATE_NAME"] ?? "substrate";
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "pending", "accepted", "queued", "dispatched", "in_progress", "started"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "error", "errored", "cancelled", "canceled", "timeout", "timed_out", "aborted", "refused"]);

/** What a node's goal-host said about one dispatch: an HTTP answer, or unreachable. null = not probed (another node's). */
export type DispatchProbe = { http: number; status?: unknown; reached?: unknown; reach_reason?: unknown } | { http: "unreachable"; error: string };
export type LostWhy = "not_found_on_host" | "host_unreachable" | "no_dispatch_id" | "unrecognised_status" | "owning_node_never_settled" | "timed_out";
export type DispatchVerdict =
  | { kind: "running" }
  | { kind: "awaiting_titles" }
  | { kind: "failed"; reason: string }
  | { kind: "lost"; why: LostWhy; reason: string }
  | { kind: "wait"; why: LostWhy; detail: string };
export interface OutcomeBounds { stale_ms: number; timeout_ms: number; title_grace_ms: number; foreign_stale_ms: number }

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
  if (owner !== null && owner !== localNode) return lostOr("owning_node_never_settled", `dispatched by ${owner}; only its goal-host can read the outcome`, bounds.foreign_stale_ms);
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
    return { excluded, readable: true, reason: `autonomyScope: ${excluded.length} excluded path(s)` };
  } catch (err) {
    return { excluded: [], readable: false, reason: `autonomyScope unreadable: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}

/** Read one dispatch from this node's goal-host. */
async function probeDispatch(dispatchId: string): Promise<DispatchProbe> {
  try {
    const r = await fetch(`${GOAL_HOST_ENDPOINT}/executions/${encodeURIComponent(dispatchId)}`, { headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (r.status !== 200) return { http: r.status };
    const j = (await r.json().catch(() => ({}))) as Row;
    return { http: 200, status: j["status"], reached: j["reached"], reach_reason: j["goalReachReason"] };
  } catch (err) {
    return { http: "unreachable", error: String((err as Error)?.message ?? err) };
  }
}

/** Settle a report-graded family's rhythm (the conductor left it pending: directFamilySettlement). */
export async function settleFamily(rhythm: { id: string; body: RhythmBody & Row }, leg: "alpha" | "beta", d: { staleness: number; alpha: number; beta: number }, source = "gap-check-supply-tick"): Promise<void> {
  try {
    await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse_write", id: rhythm.id, shape: "timeShapedRhythm", source,
        body: { ...rhythm.body, ...rhythmSettlementOverlay(leg, d.alpha, d.beta, d.staleness) } } }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* the next tick re-derives due-ness from whatever the registry holds */ }
}

const posNum = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);

async function writeMeta(row: Row, meta: Row, opts?: Parameters<typeof resolveSubstrateGapWrite>[1]): Promise<ResolverResult> {
  return resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: meta },
  } as never, opts);
}

export async function resolveGapCheckSupplyTick(pointer: GapCheckSupplyTickPointer): Promise<ResolverResult> {
  const now = typeof pointer.now_ms === "number" ? pointer.now_ms : Date.now();
  const nowIso = new Date(now).toISOString();

  // 1. CADENCE: this family's rhythm, read now. Seeding it is the bootstrap seeder's job, not this resolver's:
  // the conductor only calls a family it has read, so a self-seed here could never run.
  const rhythm = await readFamilyRhythm(CHECK_SUPPLY_FAMILY);
  if (!rhythm) return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "no_rhythm", family: CHECK_SUPPLY_FAMILY } };
  const due = rhythmDueScore(rhythm.body, rhythm.updated_at, now);
  const threshold = posNum(rhythm.body["due_threshold"], 1);
  if (due.due_score < threshold) {
    return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "not_due", due_score: due.due_score, due_threshold: threshold } };
  }
  const perTick = Math.floor(posNum(rhythm.body["max_per_tick"], 1));
  const backoffMs = posNum(rhythm.body["backoff_hours"], 24) * 3600_000;
  const maxAttempts = Math.floor(posNum(rhythm.body["max_attempts"], 3));
  const windowMs = posNum(rhythm.body["measure_window_days"], 7) * 86_400_000;
  const bounds: OutcomeBounds = {
    stale_ms: posNum(rhythm.body["dispatch_stale_hours"], 24) * 3600_000,
    timeout_ms: posNum(rhythm.body["dispatch_timeout_hours"], 6) * 3600_000,
    title_grace_ms: posNum(rhythm.body["title_grace_hours"], 2) * 3600_000,
    foreign_stale_ms: posNum(rhythm.body["foreign_stale_hours"], 72) * 3600_000,
  };
  const maxOutcomeReads = Math.floor(posNum(rhythm.body["max_outcome_reads"], 50));
  const localNode = checkSupplyNode();

  const read = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  const rows = (((read.body ?? {}) as { gaps?: Row[] }).gaps ?? []).filter((r) => typeof r["id"] === "string");
  const open = rows.filter((r) => String(r["status"] ?? "open") === "open");
  const touched = new Set<string>();
  const armed: string[] = [];
  const notArmed: Array<{ id: string; reason: string }> = [];
  const dispatched: Array<{ id: string; goal: string; dispatch_id: string | null }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const exhausted: string[] = [];
  const controlMarked: string[] = [];
  const outcomes: { failed: Array<{ id: string; reason: string }>; lost: Array<{ id: string; why: LostWhy; reason: string }>; running: number; awaiting_titles: number; waiting: Array<{ id: string; why: LostWhy; detail: string }> } = { failed: [], lost: [], running: 0, awaiting_titles: 0, waiting: [] };
  let refused = 0;

  // 2. ARM: a dispatched gap whose test has landed (new titles in its test file).
  let armBudget = perTick;
  for (const row of open) {
    if (armBudget <= 0) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    // A failed or lost goal's test may still land late: its titles arm the gap all the same.
    if (!(ledger.state === "goal_dispatched" || ledger.state === "dispatch_failed" || ledger.state === "dispatch_lost") || !ledger.test_file || !ledger.vessel) continue;
    const path = join(clonesRoot(), ledger.vessel, ledger.test_file);
    if (!existsSync(path)) continue;
    let src = "";
    try { src = readFileSync(path, "utf-8"); } catch { src = ""; }
    const baseline = Array.isArray(ledger.baseline_titles) ? ledger.baseline_titles : [];
    const titles = declaredTestTitles(src).filter((t) => !baseline.includes(t)).slice(0, 20);
    if (titles.length === 0) continue; // nothing appended yet: still waiting on the goal
    armBudget -= 1;
    touched.add(id);
    // W2, THE VERIFY'S RULE (check-supply-admission.ts checkImportsEditSite): the gap's edit site, imported in any
    // form testImportsFile reads; with none, an existing src module the test imports becomes it.
    const vesselDir = ledger.vessel;
    const site = await checkImportsEditSite(src, ledger.test_file, ledger.edit_site ?? null, (rel) => existsSync(join(clonesRoot(), vesselDir, rel)), srcReaderAt(join(clonesRoot(), vesselDir)));
    const editSite = site.ok ? `repos/${vesselDir}/${site.edit_site}` : null;
    const why = onlyTestsProblem(titles)?.detail ?? (site.ok ? null : `${site.stage}: ${site.reason}`);
    if (why) {
      refused += 1;
      notArmed.push({ id, reason: why });
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: why } });
      continue;
    }
    // A check that only asserts a name exists (or is defined, or has a type) is closed by adding the name: never armed.
    const ex = existenceOnlyCheck(src, titles);
    if (ex.existence_only) {
      const reason = `existence_only: all ${ex.assertions} assertion(s) of the named test(s) only check that a name exists or has a type; a check must assert behaviour`;
      refused += 1;
      notArmed.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "existence_only", reason } });
      continue;
    }
    const evidence_resolve = { shape: "test_suite", input: { vessel: `repos/${ledger.vessel}`, test_file: ledger.test_file, only_tests: titles }, zero_field: "requested_not_passing" };
    const { verdict, report, stamp } = await takeBirthVerdictWithReport(id, { ...meta, evidence_resolve, edit_site: editSite });
    // RED FOR THE RIGHT REASON, BY THE SHARED CLASSIFIER: every named test among the failures (redForTheRightReason)
    // AND each an assertion in the report's red_reason (retry-evidence.ts), the rule feature_compose's verify applies.
    // A report without red_reason cannot attribute its red: nothing is armed.
    const classified = verdict === "present" ? armRedReasonRefusal((report as Record<string, unknown> | null)?.["red_reason"], titles) : null;
    const wrongReason = verdict === "present" ? redForTheRightReason(report, titles) ?? (classified ? `${classified.cause ? `${classified.cause}: ` : ""}${classified.reason}` : null) : null;
    if (verdict !== "present" || wrongReason) {
      // GREEN AT HEAD, OR RED FOR THE WRONG REASON, ARMS NOTHING. An unknown stays dispatched and is judged again.
      const state = verdict === "unknown" ? "goal_dispatched" : verdict === "absent" ? "green_at_head" : "arm_refused";
      if (state !== "goal_dispatched") refused += 1;
      notArmed.push({ id, reason: wrongReason ?? (verdict === "absent" ? "green_at_head" : "verdict_unknown") });
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state, last_verdict: verdict, ...(wrongReason ? { reason: wrongReason } : {}) } });
      continue;
    }
    if (pointer.dry_run) { armed.push(id); continue; }
    const w = await writeMeta(row, {
      evidence_resolve,
      edit_site: editSite,
      predicate_source: CHECK_SUPPLY_SOURCE,
      disposition: meta["disposition"] === CHECK_SUPPLY_DISPOSITION ? "" : meta["disposition"] ?? "",
      check_supply: { ...ledger, state: "armed", armed_at: nowIso, red_at_head: true, last_verdict: verdict },
    }, { birthVerdict: stamp }); // the verdict minted by the run above: the seam honours nothing else
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
    const outcome: Row = { read_at: nowIso, read_by: localNode, ...(probe && probe.http !== "unreachable" ? { http: probe.http, status: probe.status ?? null, reached: probe.reached ?? null } : {}), ...(v.kind === "lost" ? { lost_why: v.why } : {}) };
    const next: Ledger = { ...ledger, state: v.kind === "failed" ? "dispatch_failed" : "dispatch_lost", reason: v.reason, outcome };
    refused += 1;
    if (v.kind === "failed") outcomes.failed.push({ id, reason: v.reason }); else outcomes.lost.push({ id, why: v.why, reason: v.reason });
    console.log(`[gap-check-supply] outcome ${next.state} for ${id}: ${v.reason}`);
    if (!pointer.dry_run) await writeMeta(row, { check_supply: next });
    // The same tick's dispatch step sees the settled ledger (a due retry may be sent now).
    (meta as Row)["check_supply"] = next;
  }

  // A row marked needs_localization that something else has since armed: release the hold.
  for (const row of open) {
    const meta = metaOf(row);
    if (meta["disposition"] !== CHECK_SUPPLY_DISPOSITION || touched.has(String(row["id"]))) continue;
    const cls = falsifierClassOf(meta);
    if ((cls === "class1" || cls === "class2") && !pointer.dry_run) {
      touched.add(String(row["id"]));
      await writeMeta(row, { disposition: "" });
    }
  }

  // 3. DISPATCH: one test-writing goal per treatment-arm needs-localization gap, fewest attempts and oldest first.
  // A settled attempt (failed or lost) past its backoff is a DUE RETRY: it goes ahead of fresh gaps, or a steady inflow
  // of fresh gaps starves it forever (the backoff and max_attempts already bound how often it can come back).
  const dueRetry = (r: Row): boolean => {
    const l = ledgerOf(metaOf(r));
    if (l.state !== "dispatch_failed" && l.state !== "dispatch_lost") return false;
    const n = Number(l.attempts ?? 0);
    const last = Date.parse(String(l.last_dispatch_at ?? ""));
    return n > 0 && n < maxAttempts && (!Number.isFinite(last) || now >= last + backoffMs * 2 ** (n - 1));
  };
  const candidates = open
    .filter((r) => !touched.has(String(r["id"])) && checkSupplyDisposition(r) !== null)
    .sort((a, b) => {
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
  for (const row of candidates) {
    if (dispatched.length >= perTick && controlMarked.length >= perTick) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    const holdable = !nonEmpty(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION;
    if (checkSupplyArm(id) === "control") {
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
    if (attempts > 0 && Number.isFinite(last) && now < last + backoffMs * 2 ** (attempts - 1)) continue;
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
    const targets = [site ? `repos/${vessel}/${site}` : `repos/${vessel}/`, `repos/${vessel}/${testFile}`];
    const hit = scope.readable ? targets.map((t) => ({ t, e: autonomyScopeExcludes(scope, t) })).find((x) => x.e !== null) : undefined;
    if (hit) {
      const reason = `target ${hit.t} is excluded by the autonomy scope (${hit.e}); the lane could never land it`;
      skipped.push({ id, reason });
      if (!pointer.dry_run && !(ledger.state === "scope_excluded" && ledger.reason === reason)) await writeMeta(row, { check_supply: { ...ledger, state: "scope_excluded", reason } });
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
    const goal = checkSupplyGoal(vessel, testFile, summary, site, reader, anchorsOf.get(id) ?? []);
    if (pointer.dry_run) { dispatched.push({ id, goal, dispatch_id: null }); continue; }
    const r = await resolveDispatchGoal({ type: "dispatch_goal", goal, variables: { gap_id: id, check_supply: true }, timeout_ms: 15_000 });
    if (r.shape !== "goalDispatchResult") {
      refused += 1;
      skipped.push({ id, reason: `dispatch failed: ${String((r.body as Row)?.["detail"] ?? "").slice(0, 120)}` });
      continue;
    }
    const dispatchId = ((r.body ?? {}) as { dispatch_id?: string | null }).dispatch_id ?? null;
    dispatched.push({ id, goal, dispatch_id: dispatchId });
    await writeMeta(row, {
      ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}),
      gap_check_supply_arm: "treatment",
      check_supply: { ...ledger, state: "goal_dispatched", attempts: attempts + 1, last_dispatch_at: nowIso, test_file: testFile, vessel, mode,
        baseline_titles: baselineTitles, edit_site: site, dispatch_id: dispatchId, goal, dispatch_node: localNode, dispatch_host: GOAL_HOST_ENDPOINT, reason: "", outcome: {}, history: settledHistory(ledger) },
    });
  }

  const leg = checkSupplySettlementLeg({ dispatched: dispatched.length, armed: armed.length, refused });
  if (leg && !pointer.dry_run) await settleFamily(rhythm, leg, due);

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
      fired: dispatched.length + armed.length > 0,
      reason: leg === "alpha" ? "due" : leg === "beta" ? "refused" : "nothing_to_do",
      settlement: leg ?? "none",
      due_score: due.due_score,
      needs_localization: open.filter((r) => checkSupplyDisposition(r) !== null).length,
      dispatched,
      armed,
      not_armed: notArmed,
      refused,
      exhausted,
      control_marked: controlMarked,
      outcomes,
      ...(scopeUnread ? { scope_unread: scopeUnread } : {}),
      arms,
      skipped: skipped.slice(0, 25),
      measures,
      dry_run: pointer.dry_run === true,
    },
  };
}
