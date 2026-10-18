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
import { CHECK_SUPPLY_DISPOSITION, isAwaitingLandVerification, isParkingDisposition } from "../judge/gap-eligibility.js";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type TS from "typescript";
import { planPathProblem, underVesselRoot, vesselRelativePath } from "./vessel-paths.js";

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

export { planPathProblem, vesselRelativePath };

/**
 * A TEST-WRITING COMPOSE LANDS ITS ONE CHECK FILE ONLY (slice G revision R3, narrowed by B′ P1). An admitted
 * test_writing compose runs land:true with no falsifier of its own, and "Do not change src/." is goal prose the
 * drafter can ignore. THE RULE: a path is resolved to its vessel-relative form (under one of VESSEL_ROOTS, each anchored
 * at the path start: a compose worktree, a push clone, the runtime root, repos/<vessel>/; a bare path only when it starts
 * with test/ or src/; anything else resolves to nothing), and
 * the ONLY path allowed is exactly test/checks/<checkSupplyCheckFile(gapId)>. Every other path is refused: another
 * gap's check, any discovered *.test.ts (an intended red there reads as a regression in every whole-suite run),
 * fixtures, src, package.json, config, a '..' path. No gap id allows nothing (fail closed). Which vessel a path may
 * touch stays the verify_vessels gate's job.
 */
export function testWritingPathAllowed(path: string, gapId: unknown): boolean {
  if (typeof gapId !== "string" || gapId.length === 0) return false;
  return vesselRelativePath(path) === checkSupplyCheckPath(gapId);
}

/** An out-of-suite check (vessel-relative): bun's default discovery never collects a .check.ts under test/checks/. */
const OUT_OF_SUITE_CHECK_RE = /^test\/checks\/[^/]+\.check\.ts$/;
/**
 * AN ARMING-ONLY LANDING IS NOT A FIX. A landing whose diff touches nothing but the gap's OWN check (the supply's
 * test/checks/<checkSupplyCheckFile(gap id)>, or the out-of-suite test/checks/<name>.check.ts its test_suite
 * evidence_resolve names) arms the gap: it adds the red-by-design check the fix is then composed against. An in-suite
 * test_file is not an arming check: a landing that edits only that is a self-authored check edit, held for operator
 * review by the sweep as before. Stamped as a fix landing, it held the gap pending
 * (the picker and admission skip a landing awaiting its verdict, so the fix was never composed) and the next sweep read
 * the check 'present', which it is by design, and falsified the landing (regressed_by, an UNFAVORABLE settlement, a
 * class-posterior miss). Every changed path (vessel-relative or under a vessel root) must be one of those paths; an
 * empty or unreadable diff is not arming-only (the caller's existing behaviour stands). When both the landing's vessel
 * and the check's vessel are known and differ, the evidence_resolve path is another vessel's file and does not count.
 */
export function armingOnlyLanding(changedPaths: readonly string[] | null | undefined, gap: Record<string, unknown>, landingVessel?: string): boolean {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  const own = new Set<string>();
  const gapId = gap["id"];
  if (typeof gapId === "string" && gapId.length > 0) own.add(checkSupplyCheckPath(gapId));
  const meta = (gap["classification_metadata"] ?? gap["metadata"] ?? {}) as Record<string, unknown>;
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown } } | null | undefined;
  if (er && typeof er === "object" && er.shape === "test_suite" && typeof er.input?.test_file === "string") {
    const checkVessel = typeof er.input.vessel === "string" ? er.input.vessel.replace(/^repos\//, "").replace(/\/+$/, "") : "";
    const sameVessel = !checkVessel || !landingVessel || checkVessel === landingVessel;
    const rel = vesselRelativePath(er.input.test_file.replace(/^\/+/, ""));
    if (sameVessel && rel && OUT_OF_SUITE_CHECK_RE.test(rel)) own.add(rel);
  }
  if (own.size === 0) return false;
  return changedPaths.every((p) => {
    const rel = typeof p === "string" ? vesselRelativePath(p.replace(/^\/+(?=(?:test|src)\/)/, "")) : null;
    return rel !== null && own.has(rel);
  });
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
 *   - an edit site is given (vessel-relative after stripping one of VESSEL_ROOTS and any :line suffix): it must be a TS/JS
 *     module (.ts .tsx .js .jsx .mts .cts .mjs .cjs, not .d.ts), else edit_site_not_importable; and the check must
 *     import it (scope-earn-in.ts testImportsFile: static `from`, bare `import "…"`, a namespace import, dynamic
 *     `import(…)`, `require(…)`; comments stripped; extension optional, /index allowed; a TYPE-ONLY import —
 *     `import type …`, `export type … from`, braces whose every specifier is `type X` — is erased at runtime, so it
 *     never loads the module and does not count), else test_writing_check_misses_edit_site.
 *   - no edit site: the check must import an EXISTING src/ module of its vessel (the first one found becomes the edit
 *     site), else test_writing_check_misses_edit_site.
 * Known limit (v1, accepted): a check importing the edit site only through a re-export or barrel module is refused.
 *   - the edit site (given or found) is CONFIGURATION (configEditSite: src/seed/**, or a module exporting an
 *     ActivityTemplate): the check must also RUN the template's consumer, by configSiteCheckRefusal, reading the tree
 *     through `reader`; a check that only reads the template's literals is refused (test_writing_check_reads_literals_only).
 *     Without a reader a config site is refused (fail closed). Non-config sites are judged exactly as before.
 */
export type EditSiteImport = { ok: true; edit_site: string } | { ok: false; stage: "edit_site_not_importable" | "test_writing_check_misses_edit_site" | "test_writing_check_reads_literals_only"; reason: string; edit_site: string | null };

/**
 * A READ-ONLY VIEW OF ONE VESSEL'S SOURCE TREE (vessel-relative paths), so the config-site rules below can read the edit
 * site and find the resolver that consumes it. srcReaderAt(root) is the real one; a test passes a fixture tree.
 */
export type SrcReader = { read: (rel: string) => string | null; list: (relDir: string) => string[] };
export function srcReaderAt(root: string): SrcReader {
  const safe = (rel: string): string | null => (rel.split("/").includes("..") ? null : `${root}/${rel}`);
  return {
    read: (rel) => { const p = safe(rel); if (!p) return null; try { return readFileSync(p, "utf8"); } catch { return null; } },
    list: (relDir) => { const p = safe(relDir); if (!p) return []; try { return readdirSync(p).map((n) => `${relDir.replace(/\/+$/, "")}/${n}`); } catch { return []; } },
  };
}

/**
 * A CONFIG EDIT SITE: an activity seed template (src/seed/**) or any module exporting an ActivityTemplate. What such a
 * file holds is DATA a resolver reads at run time, so a check that only reads its literals (template.tasks[i].config.x
 * === y) passes on an edit that changes nothing the runtime does: the template may never be delivered (seed delivery
 * re-uploads a seed only on a metadata.seed_version bump), and a flag on a task's config can change what the task does
 * (a mode flag on an activity's only task replaced its function). The only check that measures such a gap runs the
 * CONSUMER: the template's task resolver, with the template's config, on a fixture.
 *
 * `resolvers` are the task resolver names the site's templates declare (`resolver: "<name>"`), in order of appearance.
 */
export type ConfigEditSite = { site: string; templates: string[]; resolvers: string[] };
const TEMPLATE_DECL_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*:\s*ActivityTemplate\b/g;
export function configEditSite(siteRel: string | null, source: string | null): ConfigEditSite | null {
  if (!siteRel) return null;
  const templates = source ? [...source.matchAll(TEMPLATE_DECL_RE)].map((m) => m[1]!) : [];
  if (!siteRel.startsWith("src/seed/") && templates.length === 0) return null;
  const resolvers: string[] = [];
  for (const m of (source ?? "").matchAll(/\bresolver\s*:\s*(["'])([A-Za-z0-9_.:-]+)\1/g)) if (!resolvers.includes(m[2]!)) resolvers.push(m[2]!);
  return { site: siteRel, templates, resolvers };
}

/**
 * THE MODULES THAT CONSUME A RESOLVER NAME, in this vessel (vessel-relative src/resolvers/*.ts): the file named after the
 * resolver (gap_x_scan -> gap-x-scan.ts) when it exists, else every resolver module declaring the pointer type
 * (`type: "<name>";`, an interface field, not an object literal that merely CALLS the resolver). A resolver served by
 * another vessel has no module here, and then no check in this vessel can run it.
 */
export function consumerResolverModules(resolvers: readonly string[], reader: SrcReader): string[] {
  const files = reader.list("src/resolvers").filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.ts$/.test(f));
  const out: string[] = [];
  for (const name of resolvers) {
    const named = `src/resolvers/${name.replace(/_/g, "-")}.ts`;
    if (files.includes(named) && reader.read(named) !== null) { if (!out.includes(named)) out.push(named); continue; }
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const decl = new RegExp(`\\btype\\s*\\??\\s*:\\s*["']${esc}["']\\s*;`);
    for (const f of files) { const src = reader.read(f); if (src && decl.test(src) && !out.includes(f)) out.push(f); }
  }
  return out;
}

/** Names a module exports as callables (function declarations and const arrow/function bindings). */
function exportedCallables(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) out.add(m[1]!);
  return out;
}

/**
 * DOES THE CHECK RUN THE CONSUMER? Static and conservative (a false refusal leaves the gap unarmed for another attempt;
 * a false admission arms a check that can pass on an inert edit). Comments are stripped; then the check must bind one
 * of `modules` by a relative import (static `import … from`, or `const x = await import(…)` / `const { f } = await
 * import(…)`) and CALL a name that module exports as a function: `f(` for a named binding, `ns.f(` or `ns["f"](` for a
 * namespace or default binding. Anything else (an import used only for its constants, a call through a re-export, a
 * barrel, an alias assigned later, `require`) does not count. Returns the first module and function it calls, or null.
 */
export function checkInvokesConsumer(source: string, checkRel: string, modules: readonly string[], reader: SrcReader): { module: string; fn: string } | null {
  if (modules.length === 0) return null;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const strip = (p: string): string => p.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
  const want = new Map(modules.map((m) => [strip(m), m]));
  const bindings: Array<{ local: string; spec: string; kind: "named" | "ns"; imported: string }> = [];
  for (const m of code.matchAll(/\bimport\s+(?!type\b)([\s\S]*?)\s+from\s+(["'])([^"'\n]+)\2/g)) {
    const clause = m[1] ?? "", spec = m[3] ?? "";
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "";
    for (const part of named.split(",")) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const [imported, local] = p.split(/\s+as\s+/).map((s) => s.trim());
      if (imported) bindings.push({ local: local ?? imported, spec, kind: "named", imported });
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (ns) bindings.push({ local: ns, spec, kind: "ns", imported: "*" });
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*\(?\s*await\s+import\s*\(\s*(["'])([^"'\n]+)\2/g)) {
    const lhs = m[1] ?? "", spec = m[3] ?? "";
    if (lhs.startsWith("{")) {
      for (const part of lhs.slice(1, -1).split(",")) {
        const [imported, local] = part.split(":").map((s) => s.trim());
        if (imported && /^[A-Za-z_$][\w$]*$/.test(local ?? imported)) bindings.push({ local: local ?? imported, spec, kind: "named", imported });
      }
    } else bindings.push({ local: lhs, spec, kind: "ns", imported: "*" });
  }
  for (const b of bindings) {
    if (!b.spec.startsWith(".")) continue;
    const mod = want.get(strip(posixJoin(checkRel, b.spec)));
    if (!mod) continue;
    const exported = exportedCallables(reader.read(mod) ?? "");
    const esc = b.local.replace(/[$]/g, "\\$");
    if (b.kind === "named") {
      if (exported.has(b.imported) && new RegExp(`(?<![\\w$.])${esc}\\s*\\(`).test(code.replace(/\bimport\s+[\s\S]*?\s+from\s+["'][^"'\n]+["']/g, ""))) return { module: mod, fn: b.imported };
      continue;
    }
    for (const c of code.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*["']([A-Za-z_$][\\w$]*)["']\\s*\\])\\s*\\(`, "g"))) {
      const fn = c[1] ?? c[2] ?? "";
      if (exported.has(fn)) return { module: mod, fn };
    }
  }
  return null;
}

/**
 * THE CONFIG-SITE ADMISSION RULE (applied by checkImportsEditSite once the check imports its site): a check for a config
 * edit site must RUN the consumer (checkInvokesConsumer over consumerResolverModules of the site's task resolvers). A
 * check that only reads the site's literals is refused (stage test_writing_check_reads_literals_only), and so is any
 * check for a config site when no source reader was given (fail closed: the consumer cannot be found) or when no
 * consumer module exists in this vessel. null = admitted (not a config site, or the consumer is called).
 */
export function configSiteCheckRefusal(source: string, checkRel: string, siteRel: string, reader: SrcReader | undefined): Extract<EditSiteImport, { ok: false }> | null {
  const cfg = configEditSite(siteRel, reader ? reader.read(siteRel) : null);
  if (!cfg) return null;
  const refuse = (reason: string): Extract<EditSiteImport, { ok: false }> => ({ ok: false, stage: "test_writing_check_reads_literals_only", edit_site: siteRel, reason });
  if (!reader) return refuse(`the edit site ${siteRel} is configuration (an activity seed or template), and no source reader was given to find the resolver that consumes it, so the check cannot be shown to run that consumer`);
  const modules = consumerResolverModules(cfg.resolvers, reader);
  if (modules.length === 0) {
    return refuse(`the edit site ${siteRel} is configuration (an activity seed or template) whose task resolver${cfg.resolvers.length === 1 ? "" : "s"} (${cfg.resolvers.join(", ") || "none declared"}) ha${cfg.resolvers.length === 1 ? "s" : "ve"} no module in this vessel, so no check here can run the consumer; a check that only reads the template's literals passes on an edit that changes nothing at runtime`);
  }
  if (checkInvokesConsumer(source, checkRel, modules, reader)) return null;
  return refuse(`the check reads the configuration in ${siteRel} but never runs the resolver that consumes it (${modules.join(", ")}): a check on the template's literals passes on an edit that changes nothing at runtime. Import the resolver module and call its exported resolver with the template task's config on a fixture, asserting the behaviour it had before AND the new behaviour`);
}

/**
 * THE SUPPLY GOAL FOR A CONFIG EDIT SITE (gap-check-supply.ts checkSupplyGoal delegates here when its site is one). The
 * goal asks for a CONSUMER-BEHAVIOUR check: the template's task resolver, run with the template's config on a fixture,
 * asserting first that the behaviour it had before persists, then the new behaviour. ONE test with both assertions in
 * that order, because the arm step requires every new test to be red at HEAD (the prior-behaviour assertion passes at
 * HEAD and must keep passing; the new-behaviour one is the red). `siteImport` / `consumerImports` are the import
 * specifiers from the check file. Pure.
 */
export function configSiteCheckGoal(input: { vessel: string; testFile: string; symptom: string; siteRel: string; siteImport: string; templates: readonly string[]; resolvers: readonly string[]; consumerImports: ReadonlyArray<{ module: string; spec: string }> }): string {
  const tpl = input.templates[0] ? `site.${input.templates[0]}` : "the exported ActivityTemplate";
  const consumer = input.consumerImports.length > 0
    ? `the resolver that runs it, ${input.resolvers.join(" / ") || "its task resolver"} (import * as consumer from "${input.consumerImports[0]!.spec}")`
    : `the resolver that runs it, ${input.resolvers.join(" / ") || "the template task's resolver"} (import its module from src/resolvers/ as a namespace)`;
  return `Write ONE failing test in repos/${input.vessel}/${input.testFile} that reproduces: ${input.symptom}. ` +
    `The defect's edit site ${input.siteRel} is configuration (an activity template the runtime reads), so a test that only reads its literals passes on an edit that changes nothing at runtime and is refused. ` +
    `Test the CONSUMER'S BEHAVIOUR instead: import the template (import * as site from "${input.siteImport}") and ${consumer}, ` +
    `call the resolver's exported function with the template task's config (${tpl}.tasks[i].config, pointing only its store and file paths at fixtures you create under a temp dir) on a fixture store, and assert on what it returns. ` +
    "ONE test, two expect() assertions in this order: FIRST that the behaviour the resolver had before still happens (for example the work it did on a stale fixture item is still done and reported), which passes today and must keep passing; " +
    "THEN the new behaviour the defect says is missing, which fails today because of the defect. No network, no services, no timers. Do not change src/ or any other file.";
}
const IMPORTABLE_RE = /\.(?:[cm]?[jt]sx?)$/;
export function vesselRelativeEditSite(editSite: unknown): string | null {
  if (typeof editSite !== "string" || !editSite.trim()) return null;
  const s = editSite.trim().replace(/:\d+.*$/, "").replace(/\\/g, "/");
  // Under no root the site is kept as given: null would mean "no edit site", which lets the check import ANY src module.
  return (underVesselRoot(s) ?? s.replace(/^(?:\.\/)+/, "")) || null;
}
export async function checkImportsEditSite(source: string, checkRel: string, editSite: unknown, srcExists: (rel: string) => boolean, reader?: SrcReader): Promise<EditSiteImport> {
  const { testImportsFile } = await import("./scope-earn-in.js");
  const rel = vesselRelativeEditSite(editSite);
  if (rel) {
    if (rel.split("/").includes("..") || !IMPORTABLE_RE.test(rel) || /\.d\.[cm]?ts$/.test(rel)) {
      return { ok: false, stage: "edit_site_not_importable", edit_site: rel, reason: `the gap's edit site ${rel} is not an importable TS/JS module, so no check can import it; a test-writing compose cannot reproduce it (the gap needs a different check)` };
    }
    if (!testImportsFile(source, checkRel, rel, { runtimeOnly: true })) {
      return { ok: false, stage: "test_writing_check_misses_edit_site", edit_site: rel, reason: `the check does not import the edit site ${rel}: import it (e.g. import * as mod from "${posixRelative(checkRel, rel)}") and assert on what it does` };
    }
    return configSiteCheckRefusal(source, checkRel, rel, reader) ?? { ok: true, edit_site: rel };
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]+)\1/g)) {
    const resolved = posixJoin(checkRel, m[2]!).replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (!resolved.startsWith("src/")) continue;
    for (const cand of [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}.mts`]) {
      if (srcExists(cand) && testImportsFile(source, checkRel, cand, { runtimeOnly: true })) return configSiteCheckRefusal(source, checkRel, cand, reader) ?? { ok: true, edit_site: cand };
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

/**
 * WHAT A MODULE EXPORTS, read from its source with the TypeScript parser (no type checker, no execution): every
 * `export` declaration (function, class, const/let/var including destructured names, enum, interface, type, namespace),
 * `export default`, `export import Z = …`, `export { a, b as c }` (kind from the local declaration), `export { a } from`,
 * `export * as ns from`, and `export * from "./x"` followed through `reader` (cycle-safe). Type-only exports count as present: bun erases them,
 * so naming one is not what makes a red hollow. `open` says why the list may be incomplete (an `export *` from a module
 * this reader cannot read); null when the module itself cannot be read. A caller treats both as "unknown", never as absent.
 */
export type ModuleExports = { names: Map<string, string>; open: string | null };
const MODULE_CANDIDATES = (base: string): string[] => [base.replace(/\.[cm]?js$/, ".ts"), base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mts`, `${base}/index.ts`];
function resolveModule(fromRel: string, spec: string, reader: SrcReader): { rel: string; source: string } | null {
  const base = posixJoin(fromRel, spec);
  if (!base || base.split("/").includes("..")) return null;
  for (const c of MODULE_CANDIDATES(base)) {
    if (!IMPORTABLE_RE.test(c) || /\.d\.[cm]?ts$/.test(c)) continue;
    const source = reader.read(c);
    if (source !== null) return { rel: c, source };
  }
  return null;
}
type TsModule = typeof import("typescript");
let tsMod: TsModule | null | undefined;
/** The TypeScript parser, loaded once on first use as scope-earn-in.ts loads it (typescript is a devDependency); null
 *  when it is not installed, and then nothing below can read a module or a check, so the guard decides nothing. */
function loadTs(): TsModule | null {
  if (tsMod === undefined) {
    try { tsMod = createRequire(import.meta.url)("typescript") as TsModule; } catch { tsMod = null; }
  }
  return tsMod;
}
const hasExport = (ts: TsModule, n: TS.Node): boolean => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (ts: TsModule, n: TS.Node): boolean => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
function bindingNames(ts: TsModule, name: TS.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) { out.push(name.text); return; }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, out);
}
const moduleName = (n: TS.ModuleExportName): string => n.text;
export function moduleExports(siteRel: string, reader: SrcReader, seen: Set<string> = new Set()): ModuleExports | null {
  const ts = loadTs();
  const source = reader.read(siteRel);
  if (source === null || !ts) return null;
  seen.add(siteRel);
  const sf = ts.createSourceFile(siteRel, source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(siteRel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Map<string, string>();
  const local = new Map<string, string>();
  let open: string | null = null;
  const declKind = (s: TS.Statement): Array<[string, string]> => {
    if (ts.isFunctionDeclaration(s) && s.name) return [[s.name.text, "function"]];
    if (ts.isClassDeclaration(s) && s.name) return [[s.name.text, "class"]];
    if (ts.isEnumDeclaration(s)) return [[s.name.text, "enum"]];
    if (ts.isInterfaceDeclaration(s)) return [[s.name.text, "interface"]];
    if (ts.isTypeAliasDeclaration(s)) return [[s.name.text, "type"]];
    if (ts.isModuleDeclaration(s) && ts.isIdentifier(s.name)) return [[s.name.text, "namespace"]];
    if (ts.isImportEqualsDeclaration(s)) return [[s.name.text, "alias"]];
    if (ts.isVariableStatement(s)) {
      const kind = s.declarationList.flags & ts.NodeFlags.Const ? "const" : s.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      const out: string[] = [];
      for (const d of s.declarationList.declarations) bindingNames(ts, d.name, out);
      return out.map((n) => [n, kind]);
    }
    return [];
  };
  for (const s of sf.statements) {
    for (const [n, k] of declKind(s)) local.set(n, k);
    // An imported name exported again (`import { a } from "./x"; export { a }`) is a re-export.
    const nb = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) local.set(el.name.text, "re-export");
  }
  for (const s of sf.statements) {
    if (hasExport(ts, s)) {
      if (hasDefault(ts, s)) names.set("default", ts.isClassDeclaration(s) ? "class" : "function");
      else for (const [n, k] of declKind(s)) names.set(n, k);
      continue;
    }
    if (ts.isExportAssignment(s)) { names.set("default", "default"); continue; }
    if (!ts.isExportDeclaration(s)) continue;
    const spec = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null;
    if (s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) names.set(moduleName(el.name), spec ? "re-export" : local.get(moduleName(el.propertyName ?? el.name)) ?? "re-export");
    } else if (s.exportClause && ts.isNamespaceExport(s.exportClause)) {
      names.set(moduleName(s.exportClause.name), "namespace");
    } else if (spec) {
      // export * from "./x": the names of x (but never its default).
      const target = spec.startsWith(".") ? resolveModule(siteRel, spec, reader) : null;
      if (!target) { open ??= `export * from ${JSON.stringify(spec)} is not readable here`; continue; }
      if (seen.has(target.rel)) continue;
      const sub = moduleExports(target.rel, reader, seen);
      if (!sub) { open ??= `export * from ${JSON.stringify(spec)} is not readable here`; continue; }
      for (const [n, k] of sub.names) if (n !== "default" && !names.has(n)) names.set(n, k);
      open ??= sub.open;
    }
  }
  // A module with no ESM import or export syntax at all (CommonJS module.exports, say) exports what this parser cannot
  // see: its list is open, never empty.
  const esm = sf.statements.some((s) => ts.isImportDeclaration(s) || ts.isExportDeclaration(s) || ts.isExportAssignment(s) || ts.isImportEqualsDeclaration(s) || hasExport(ts, s));
  if (!esm) open ??= "the module has no ESM import or export syntax (CommonJS exports cannot be read statically)";
  return { names, open };
}

/**
 * THE NAMES A CHECK READS OFF EACH MODULE IT IMPORTS (relative specifiers only), statically: `import { a, b as c }`
 * (a, b; type-only specifiers are erased and skipped), a default import ("default"), and every member read off a
 * namespace binding, `import * as ns` or `const ns = await import("…")` (also through `.catch(…)` / `.finally(…)` on the
 * import, and the parameter of `import("…").then((ns) => …)`): `ns.x`, `ns["x"]`, `const { x } = ns`, through any
 * cast, parenthesis or non-null wrapper (`(ns as unknown as Record<string, unknown>)["x"]`), plus
 * `(await import("…")).x` and `const { x } = await import("…")`. A method of the import's promise is not a name. A computed key that is not a string literal is not a
 * name and is skipped. A use is attributed to the binding IN SCOPE (a shadowing local of the same name is not the
 * module), and a named or default import that is used only as a type, or not at all, is erased by bun and names nothing.
 *
 * `absence` marks a member read whose only use is an assertion that the name is NOT there (qa ruling on control (a)):
 * `expect(typeof R).toBe("undefined")` (toEqual / toStrictEqual too), `expect(R).toBeUndefined()`,
 * `expect(R).toBe(undefined)`, `expect(typeof R === "undefined").toBe(true)` and `expect(typeof R !== "undefined").toBe(false)`
 * (and the same with `R === undefined`), none of them negated by `.not`. Every other read, a named or default import
 * and a destructured name REQUIRE the name.
 */
export function checkModuleReferences(source: string, checkRel: string): Array<{ spec: string; symbol: string; absence?: true }> {
  const ts = loadTs();
  if (!ts) return [];
  const sf = ts.createSourceFile(checkRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<{ spec: string; symbol: string; absence?: true }> = [];
  const add = (spec: string, symbol: string, absence = false): void => {
    if (!out.some((r) => r.spec === spec && r.symbol === symbol && (r.absence === true) === absence)) out.push({ spec, symbol, ...(absence ? { absence: true as const } : {}) });
  };
  /** Namespace bindings by their DECLARING identifier, so a use resolves to the binding in scope (a local of the same
   *  name shadows it, and two tests' `const mod = await import(…)` of different modules stay apart). */
  const namespaces = new Map<TS.Node, string>();
  const nsNames = new Set<string>();
  const bindNamespace = (id: TS.Identifier, spec: string): void => { namespaces.set(id, spec); nsNames.add(id.text); };
  const fromBinding = (b: TS.BindingName, name: string): TS.Identifier | null => {
    if (ts.isIdentifier(b)) return b.text === name ? b : null;
    for (const el of b.elements) if (!ts.isOmittedExpression(el)) { const r = fromBinding(el.name, name); if (r) return r; }
    return null;
  };
  const fromList = (l: TS.VariableDeclarationList, name: string): TS.Identifier | null => {
    for (const d of l.declarations) { const r = fromBinding(d.name, name); if (r) return r; }
    return null;
  };
  /** The identifier that declares `name` directly in `scope`, or null. */
  const declIn = (scope: TS.Node, name: string): TS.Identifier | null => {
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) { const r = fromBinding(p.name, name); if (r) return r; }
      if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope.name;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) return fromBinding(scope.variableDeclaration.name, name);
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) return fromList(scope.initializer, name);
    const stmts = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : null;
    for (const s of stmts ?? []) {
      if (ts.isVariableStatement(s)) { const r = fromList(s.declarationList, name); if (r) return r; }
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) return s.name;
      if (ts.isImportDeclaration(s) && s.importClause) {
        const c = s.importClause, nb = c.namedBindings;
        if (c.name?.text === name) return c.name;
        if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return nb.name;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (el.name.text === name) return el.name;
      }
    }
    return null;
  };
  const resolveName = (id: TS.Identifier): TS.Identifier | null => {
    for (let a: TS.Node | undefined = id.parent; a; a = a.parent) { const d = declIn(a, id.text); if (d) return d; }
    return null;
  };
  /** A use bun erases: inside a type (an annotation, a type argument, `typeof X` in a type), but not a class's `extends`. */
  const inTypePosition = (id: TS.Node): boolean => {
    for (let a: TS.Node | undefined = id.parent; a; a = a.parent) {
      if (ts.isExpressionWithTypeArguments(a) && a.parent && ts.isHeritageClause(a.parent) && a.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(a.parent.parent)) return false;
      if (ts.isTypeNode(a)) return true;
    }
    return false;
  };
  /** Is the import binding `decl` used as a VALUE anywhere (a binding used only as a type, or not at all, is erased)? */
  const valueUsed = (decl: TS.Identifier): boolean => {
    let hit = false;
    const visit = (n: TS.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(n) && n !== decl && n.text === decl.text && !(n.parent && (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent)) && n.parent.name === n) && resolveName(n) === decl && !inTypePosition(n)) { hit = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hit;
  };
  const isWrapper = (n: TS.Node): boolean => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n) || ts.isAwaitExpression(n);
  const outermost = (n: TS.Node): TS.Node => { let e = n; while (e.parent && isWrapper(e.parent)) e = e.parent; return e; };
  const isUndefined = (n: TS.Node | undefined): boolean => !!n && ts.isIdentifier(n) && n.text === "undefined";
  const isUndefinedText = (n: TS.Node | undefined): boolean => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "undefined";
  const isBool = (n: TS.Node | undefined, v: boolean): boolean => !!n && n.kind === (v ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
  /** `expect(arg)…<matcher>(args)` around `arg`: the matcher, whether `.not` negates it, and its arguments. */
  const matcherOf = (arg: TS.Node): { name: string; negated: boolean; args: readonly TS.Expression[] } | null => {
    const call = arg.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== arg || !ts.isIdentifier(call.expression) || call.expression.text !== "expect") return null;
    let n: TS.Node = call;
    let negated = false;
    while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) {
      const name = n.parent.name.text;
      if (name === "not") { negated = !negated; n = n.parent; continue; }
      const c = n.parent.parent;
      return c && ts.isCallExpression(c) && c.expression === n.parent ? { name, negated, args: c.arguments } : null;
    }
    return null;
  };
  const EQ = new Set(["toBe", "toEqual", "toStrictEqual"]);
  /** Is the member read `r` used only to assert the name is absent? */
  const assertsAbsence = (r: TS.Node): boolean => {
    let e = outermost(r);
    let typeOf = false;
    if (e.parent && ts.isTypeOfExpression(e.parent)) { typeOf = true; e = outermost(e.parent); }
    const p = e.parent;
    if (p && ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const other = p.left === e ? p.right : p.left;
      if (!(typeOf ? isUndefinedText(other) : isUndefined(other))) return false;
      const m = matcherOf(outermost(p));
      const want = p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
      return !!m && !m.negated && EQ.has(m.name) && isBool(m.args[0], want);
    }
    const m = matcherOf(e);
    if (!m || m.negated) return false;
    if (typeOf) return EQ.has(m.name) && isUndefinedText(m.args[0]);
    return m.name === "toBeUndefined" || (EQ.has(m.name) && isUndefined(m.args[0]));
  };
  /** What the expression `e` (a namespace value) has read off it at its use site. */
  const readsOff = (e: TS.Node, spec: string, bindAs: boolean): void => {
    const o = outermost(e);
    const p = o.parent;
    if (!p) return;
    if (ts.isPropertyAccessExpression(p) && p.expression === o) add(spec, p.name.text, assertsAbsence(p));
    else if (ts.isElementAccessExpression(p) && p.expression === o && (ts.isStringLiteral(p.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(p.argumentExpression))) add(spec, p.argumentExpression.text, assertsAbsence(p));
    else if (ts.isVariableDeclaration(p) && p.initializer === o) {
      if (ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          if (el.dotDotDotToken) continue;
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) add(spec, key.text);
        }
      } else if (bindAs && ts.isIdentifier(p.name)) bindNamespace(p.name, spec);
    }
  };
  /**
   * import() is a PROMISE of the module until it is awaited: a property read on it before any `await` is a Promise
   * method (then / catch / finally), never a module member. `.catch(…)` and `.finally(…)` on it are wrappers (the
   * vessels' own idiom `const mod = await import("…").catch(() => null)` still binds the module, so `mod.x` stays
   * checked). Returns the outermost node that is still the module (or its promise) and whether it was awaited.
   */
  const promiseClimb = (call: TS.Node): { node: TS.Node; awaited: boolean } => {
    let e = call;
    let awaited = false;
    for (;;) {
      const p = e.parent;
      if (!p) break;
      if (isWrapper(p)) { if (ts.isAwaitExpression(p)) awaited = true; e = p; continue; }
      if (!awaited && ts.isPropertyAccessExpression(p) && p.expression === e && (p.name.text === "catch" || p.name.text === "finally") && p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p) { e = p.parent; continue; }
      break;
    }
    return { node: e, awaited };
  };
  /** `import("…").then((m) => …)`: the callback's first parameter is the module (an identifier binds it as a namespace,
   *  a destructuring pattern names what it reads). Any other use of an un-awaited import() reads nothing. */
  const thenCallback = (promise: TS.Node, spec: string): void => {
    const p = promise.parent;
    if (!p || !ts.isPropertyAccessExpression(p) || p.expression !== promise || p.name.text !== "then" || !p.parent || !ts.isCallExpression(p.parent) || p.parent.expression !== p) return;
    const cb = p.parent.arguments[0];
    const param = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0] : undefined;
    if (!param) return;
    if (ts.isIdentifier(param.name)) bindNamespace(param.name, spec);
    else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (el.dotDotDotToken) continue;
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) add(spec, key.text);
      }
    }
  };
  const relSpec = (n: TS.Expression | undefined): string | null => (n && ts.isStringLiteral(n) && n.text.startsWith(".") ? n.text : null);
  const collect = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = relSpec(n.moduleSpecifier);
      const c = n.importClause;
      if (spec && c && !c.isTypeOnly) {
        if (c.name && valueUsed(c.name)) add(spec, "default");
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) bindNamespace(nb.name, spec);
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly && valueUsed(el.name)) add(spec, moduleName(el.propertyName ?? el.name));
      }
      return;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = relSpec(n.arguments[0]);
      if (spec) {
        const { node, awaited } = promiseClimb(n);
        if (awaited) readsOff(node, spec, true);
        else thenCallback(node, spec);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const uses = (n: TS.Node): void => {
    if (ts.isIdentifier(n) && nsNames.has(n.text) && !namespaces.has(n)) {
      const p = n.parent;
      const notAUse = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isImportSpecifier(p) || ts.isBindingElement(p);
      const decl = notAUse ? null : resolveName(n);
      const spec = decl ? namespaces.get(decl) : undefined;
      if (spec !== undefined) readsOff(n, spec, false);
    }
    ts.forEachChild(n, uses);
  };
  uses(sf);
  return out;
}

/**
 * A CHECK THAT NAMES AN EXPORT ITS MODULE DOES NOT HAVE IS NOT A FALSIFIER (F-ARM). The supply's check writer drafts
 * without the target module's export list, so it can invent a symbol (2f36f62, route-edit-bd252f8c: `mod["shellResult"]`
 * on goal-host src/index.ts, where shellResult is a shape name, not an export). Such a check is red for the invented
 * name on every tree, never for the defect, and the arm step attached it as the gap's falsifier. Each name the check
 * reads off a src module of its vessel (checkModuleReferences) is compared with that module's real exports
 * (moduleExports); the first one missing refuses, `check_references_missing_export:<symbol>`. A read that only asserts
 * the name is ABSENT (checkModuleReferences `absence`) requires nothing and never refuses. A module the reader cannot
 * read, or whose export list is open, decides nothing; a check that reads no module member (behaviour through a spawned
 * process, say) is unaffected. null = no refusal. Applied at attach (gap-check-supply's arm step) and at the verify of
 * a test_writing compose (judgeTestWritingCheck), so the check that would be refused at attach never lands.
 */
export const MISSING_EXPORT_STAGE = "check_references_missing_export";
export function missingExportRefusal(source: string, checkRel: string, reader: SrcReader): { symbol: string; module: string; reason: string } | null {
  const cache = new Map<string, ModuleExports | null>();
  for (const ref of checkModuleReferences(source, checkRel)) {
    if (ref.absence) continue;
    const target = resolveModule(checkRel, ref.spec, reader);
    if (!target || !target.rel.startsWith("src/")) continue;
    if (!cache.has(target.rel)) cache.set(target.rel, moduleExports(target.rel, reader));
    const ex = cache.get(target.rel);
    if (!ex || ex.open !== null || ex.names.has(ref.symbol)) continue;
    const listed = [...ex.names.keys()].slice(0, 12).join(", ");
    return { symbol: ref.symbol, module: target.rel, reason: `${MISSING_EXPORT_STAGE}:${ref.symbol}: the check reads ${ref.symbol} from ${target.rel}, which does not export it (it exports ${ex.names.size} name${ex.names.size === 1 ? "" : "s"}${listed ? `: ${listed}${ex.names.size > 12 ? ", …" : ""}` : ""}), so the check is red for the missing name on every tree, not for the defect` };
  }
  return null;
}

/** W1: how many times the verify runs the check (every run must be the same assertion red). */
export const TEST_WRITING_CHECK_RUNS = 3;

export type TestWritingJudgement = {
  ok: boolean;
  stage: null | "test_writing_check_not_red" | "test_writing_check_wrong_reason" | "test_writing_check_flaky" | "test_writing_check_misses_edit_site" | "test_writing_check_reads_literals_only" | "edit_site_not_importable" | typeof MISSING_EXPORT_STAGE;
  cause?: string;
  reason: string;
  check_file: string;
  edit_site: string | null;
  runs: Array<{ verdict: string; keys: string[]; red: string[]; unhandled: boolean }>;
};

/**
 * B′ P2: THE VERIFY OF A test_writing COMPOSE. The check file test/checks/<checkSupplyCheckFile(gapId)> must exist in
 * the vessel root, import the gap's edit site (W2, checkImportsEditSite: static, before anything runs), and, run ALONE
 * up to `runs` times through `run` (feature_compose's shell; the caller supplies the command; stopping at the first run
 * that is not an assertion red), be the same assertion red every time (retry-evidence.ts testWritingRunsVerdict: the shared classifier),
 * and require no export its module lacks (missingExportRefusal, the attach guard: a red on a missing name is red on every
 * tree, so it is refused here before it lands; 7b54fc7's AuthCache check passed this verify). The export check runs
 * after the runs so every earlier stage keeps its verdict (a named import of a missing export still fails to LOAD and is
 * wrong_reason). ok only then.
 */
export async function judgeTestWritingCheck(input: { gapId: string; vesselRoot: string; editSite: unknown; run: (checkRel: string) => Promise<string>; runs?: number }): Promise<TestWritingJudgement> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { checkRunVerdict, classifyCheckRun, testWritingRunsVerdict } = await import("./retry-evidence.js");
  const checkRel = checkSupplyCheckPath(input.gapId);
  const abs = `${input.vesselRoot}/${checkRel}`;
  const out = (stage: TestWritingJudgement["stage"], reason: string, extra: Partial<TestWritingJudgement> = {}): TestWritingJudgement => ({ ok: stage === null, stage, reason, check_file: checkRel, edit_site: vesselRelativeEditSite(input.editSite), runs: [], ...extra });
  let source: string | null = null;
  try { source = existsSync(abs) ? readFileSync(abs, "utf8") : null; } catch { source = null; }
  if (source === null) return out("test_writing_check_not_red", `the check file ${checkRel} was not written in this vessel: the supply's goal asks for exactly that file`);
  const site = await checkImportsEditSite(source, checkRel, input.editSite, (rel) => existsSync(`${input.vesselRoot}/${rel}`), srcReaderAt(input.vesselRoot));
  if (!site.ok) return out(site.stage, site.reason, { edit_site: site.edit_site });
  const raws: string[] = [];
  const n = Math.max(1, Math.floor(input.runs ?? TEST_WRITING_CHECK_RUNS));
  // THE BUDGET (qa): each run is `timeout 180` inside a compose capped at 900 s, so only an ASSERTION red earns the
  // repeats. A run that is wrong_reason or green already decides (wrong_reason; or not_red / flaky against an earlier
  // red run), so the loop stops there; testWritingRunsVerdict judges the runs that were taken, by the same rules.
  for (let i = 0; i < n; i++) {
    const raw = await input.run(checkRel).catch((err) => `RUN_FAILED ${String(err).slice(0, 200)}`);
    raws.push(raw);
    if (checkRunVerdict(classifyCheckRun(raw)).verdict !== "assertion_red") break;
  }
  const v = testWritingRunsVerdict(raws);
  const runs = v.runs.map((r) => ({ verdict: r.verdict, keys: r.keys.map((k) => k.replace("\u0000", " :: ")), red: r.red.slice(0, 10), unhandled: r.unhandled }));
  if (!v.ok) return out(v.stage, v.reason, { edit_site: site.edit_site, runs, ...(v.cause ? { cause: v.cause } : {}) });
  const missing = missingExportRefusal(source, checkRel, srcReaderAt(input.vesselRoot));
  if (missing) return out(MISSING_EXPORT_STAGE, missing.reason, { edit_site: site.edit_site, runs });
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
