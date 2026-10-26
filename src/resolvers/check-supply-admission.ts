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
import { CHECK_SUPPLY_DISPOSITION, EDIT_SITE_IS_OWN_CHECK, isAwaitingLandVerification, isParkingDisposition } from "../judge/gap-eligibility.js";
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
export const OUT_OF_SUITE_CHECK_RE = /^test\/checks\/[^/]+\.check\.ts$/;
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
 * THE WRITE SCOPE A TEST-WRITING COMPOSE IS PLANNED AGAINST IS THE ONE IT IS JUDGED BY (law 8: the planner is given, at
 * plan time, the scope testWritingDiffOutsideTests refuses it for leaving). feature_compose's target list
 * (composeTargetFiles) puts the gap's edit_site first whatever the mode, and that list drives the grounding (target
 * windows) and the file-scope gate; a test_writing compose planned against it edited the src edit site and was then
 * refused at test_writing_diff_outside_tests. In test_writing mode the write targets are exactly the gap's check file,
 * by the same predicate the refusal applies (testWritingPathAllowed); every other incoming target (the edit site, src
 * paths the spec names) is returned as READ-ONLY context. The check's repo path is the one the target list already
 * names (the supply's goal names repos/<vessel>/<test_file>), else repos/<v>/<checkSupplyCheckPath(gap id)> with v the
 * ledger's vessel (check_supply.vessel), else the edit site's. Null outside test_writing mode (targets unchanged).
 */
export function testWritingWriteScope(composeMode: unknown, gapId: unknown, gapMeta: Record<string, unknown>, targets: readonly string[]): { targets: string[]; readonly: string[] } | null {
  if (composeMode !== CHECK_SUPPLY_COMPOSE_MODE) return null;
  // The path charset composeTargetFiles admits: these paths reach shell commands.
  const safe = (p: string): boolean => /^repos\/[\w.-]+\/[\w./-]+\.\w+$/.test(p) && !p.split("/").includes("..");
  let write = targets.find((t) => safe(t) && testWritingPathAllowed(t, gapId)) ?? null;
  if (!write && typeof gapId === "string" && gapId.length > 0) {
    const ledger = (gapMeta["check_supply"] && typeof gapMeta["check_supply"] === "object" ? gapMeta["check_supply"] : {}) as { vessel?: unknown };
    const vesselOf = (p: unknown): string | null => (typeof p === "string" ? /^repos\/([\w.-]+)\//.exec(p.trim())?.[1] ?? null : null);
    const fromLedger = typeof ledger.vessel === "string" ? ledger.vessel.replace(/^repos\//, "").replace(/\/+$/, "") : "";
    for (const v of [fromLedger, vesselOf(gapMeta["edit_site"])]) {
      if (!v || !/^[\w.-]+$/.test(v)) continue;
      const p = `repos/${v}/${checkSupplyCheckPath(gapId)}`;
      if (safe(p) && testWritingPathAllowed(p, gapId)) { write = p; break; }
    }
  }
  return { targets: write ? [write] : [], readonly: targets.filter((t) => t !== write) };
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
export type EditSiteImport = { ok: true; edit_site: string } | { ok: false; stage: "edit_site_not_importable" | "test_writing_check_misses_edit_site" | "test_writing_check_reads_literals_only" | typeof EDIT_SITE_IS_OWN_CHECK; reason: string; edit_site: string | null };

/**
 * THE EDIT SITE MAY NOT BE A TEST. A gap sited at the check file itself, or at any test or check file (test/**, or a
 * *.test / *.spec / *.check module anywhere), can only be closed by editing a test until it passes: self-certification,
 * which the semantic gate vetoes on every attempt, so the gap loops until its lineage cap. Refused, never re-sited:
 * which src module the check means to test is not decidable from its imports alone (gap-eligibility editSiteIsOwnCheck is
 * the same rule over a stored row). null = the site is not a test.
 */
const TEST_FILE_RE = /^(?:test|tests)\/|\.(?:test|spec|check)\.[cm]?[jt]sx?$/;
export function ownCheckSiteRefusal(siteRel: string, checkRel: string): Extract<EditSiteImport, { ok: false }> | null {
  if (siteRel !== checkRel && !TEST_FILE_RE.test(siteRel)) return null;
  return { ok: false, stage: EDIT_SITE_IS_OWN_CHECK, edit_site: siteRel, reason: `the edit site ${siteRel} is ${siteRel === checkRel ? "the check file itself" : "a test file"}, so the only edit that greens the check is editing a test (self-certification); the gap needs the src module under test as its site` };
}

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
    const own = ownCheckSiteRefusal(rel, checkRel);
    if (own) return own;
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
      if (srcExists(cand) && testImportsFile(source, checkRel, cand, { runtimeOnly: true })) return ownCheckSiteRefusal(cand, checkRel) ?? configSiteCheckRefusal(source, checkRel, cand, reader) ?? { ok: true, edit_site: cand };
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
const requireTs = (): TsModule | null => createRequire(import.meta.url)("typescript") as TsModule;
let tsLoader: () => TsModule | null = requireTs;
/** What an arm record and a verify judgement carry when the guard could not run: it decided nothing, loudly. */
export const EXPORT_GUARD_UNAVAILABLE = "typescript unavailable";
/**
 * The TypeScript parser, loaded once on first use as scope-earn-in.ts loads it (typescript is a devDependency); null
 * when it is not installed, and then nothing below can read a module or a check, so the guard and the check writer's
 * export list decide nothing. That is said once, loudly, and exportGuardUnavailable() lets each record say so too.
 */
function loadTs(): TsModule | null {
  if (tsMod === undefined) {
    let why = "not installed";
    try { tsMod = tsLoader(); } catch (e) { tsMod = null; why = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 160); }
    if (!tsMod) console.warn(`[check-supply-admission] ${EXPORT_GUARD_UNAVAILABLE} (${why}): the missing-export guard and the check writer's export list decide nothing`);
  }
  return tsMod;
}
/** EXPORT_GUARD_UNAVAILABLE when the parser cannot be loaded, else null. */
export function exportGuardUnavailable(): string | null { return loadTs() ? null : EXPORT_GUARD_UNAVAILABLE; }
/** Test seam: replace the parser's loader (null restores it); the next use loads again. */
export function __setTsLoaderForTests(f: (() => TsModule | null) | null): void { tsLoader = f ?? requireTs; tsMod = undefined; }
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
 * THE SIGNATURE OF EACH FUNCTION A MODULE EXPORTS, read with the same parser and over the same reader as moduleExports:
 * its parameters (name, declared type text, optional, default text) and declared return type, as declared (whitespace
 * collapsed), for a function declaration (its first declaration, so an overload's public form), a const bound to an
 * arrow or function expression, and a const declared with a function type. It follows every route moduleExports does:
 * `export { a, b as c }` (the local declaration, or the import it re-exports), `export { x } from`, `export * from`
 * (never its default) and `export default` (a function, or a local name). `module` / `local` say where the declaration
 * is (so returnedContract can be read there). A name whose declaration is not a function, or cannot be read, has no
 * entry. Keyed by the EXPORTED name.
 */
export type ExportParameter = { name: string; type: string | null; optional: boolean; default: string | null };
export type ExportSignature = { parameters: ExportParameter[]; returns: string | null; text: string; module: string; local: string };
export function exportSignatures(siteRel: string, reader: SrcReader, seen: Set<string> = new Set()): Map<string, ExportSignature> {
  const out = new Map<string, ExportSignature>();
  const ts = loadTs();
  const source = reader.read(siteRel);
  if (!ts || source === null || seen.has(siteRel)) return out;
  seen.add(siteRel);
  const sf = ts.createSourceFile(siteRel, source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(siteRel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const flat = (t: string): string => t.replace(/\s+/g, " ").trim();
  const sig = (fn: TS.SignatureDeclarationBase, local: string): ExportSignature => {
    const parameters = fn.parameters.map((p) => ({ name: flat(p.name.getText(sf)), type: p.type ? flat(p.type.getText(sf)) : null, optional: !!p.questionToken || !!p.initializer || !!p.dotDotDotToken, default: p.initializer ? flat(p.initializer.getText(sf)) : null }));
    const returns = fn.type ? flat(fn.type.getText(sf)) : null;
    const text = flat(`(${fn.parameters.map((p) => p.getText(sf)).join(", ")})${ts.isFunctionTypeNode(fn) ? ` => ${returns ?? "unknown"}` : returns ? `: ${returns}` : ""}`);
    return { parameters, returns, text, module: siteRel, local };
  };
  const local = new Map<string, ExportSignature>();
  const imported = new Map<string, { spec: string; name: string }>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && !local.has(s.name.text)) local.set(s.name.text, sig(s, s.name.text));
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        // A declared function type is the contract; an untyped arrow assigned to it says less.
        if (d.type && ts.isFunctionTypeNode(d.type)) local.set(d.name.text, sig(d.type, d.name.text));
        else if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) local.set(d.name.text, sig(init, d.name.text));
      }
    }
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
      for (const el of s.importClause.namedBindings.elements) imported.set(el.name.text, { spec: s.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  const from = (spec: string): Map<string, ExportSignature> => {
    const target = spec.startsWith(".") ? resolveModule(siteRel, spec, reader) : null;
    return target ? exportSignatures(target.rel, reader, new Set(seen)) : new Map();
  };
  const ofLocal = (name: string): ExportSignature | undefined => {
    if (local.has(name)) return local.get(name);
    const im = imported.get(name);
    return im ? from(im.spec).get(im.name) : undefined;
  };
  for (const s of sf.statements) {
    if (hasExport(ts, s)) {
      if (ts.isFunctionDeclaration(s)) {
        const k = hasDefault(ts, s) ? "default" : s.name?.text;
        if (k && !out.has(k)) out.set(k, s.name ? local.get(s.name.text)! : sig(s, "default"));
      } else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && local.has(d.name.text)) out.set(d.name.text, local.get(d.name.text)!);
      continue;
    }
    if (ts.isExportAssignment(s)) {
      const e = s.expression;
      const v = ts.isIdentifier(e) ? ofLocal(e.text) : ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? sig(e, "default") : undefined;
      if (v) out.set("default", v);
      continue;
    }
    if (!ts.isExportDeclaration(s)) continue;
    const spec = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null;
    if (s.exportClause && ts.isNamedExports(s.exportClause)) {
      const sub = spec ? from(spec) : null;
      for (const el of s.exportClause.elements) {
        const v = sub ? sub.get(moduleName(el.propertyName ?? el.name)) : ofLocal(moduleName(el.propertyName ?? el.name));
        if (v) out.set(moduleName(el.name), v);
      }
    } else if (!s.exportClause && spec) {
      for (const [n, v] of from(spec)) if (n !== "default" && !out.has(n)) out.set(n, v);
    }
  }
  return out;
}

/**
 * WHAT A MODULE'S EXPORTS ARE, AS A CONTRACT (codeIntrospectResult's opt-in `contract`, code-introspect.ts): one entry
 * per export (moduleExports' names and kinds, in their order), each function with its parameters and declared return
 * type (exportSignatures) and, where the return walk can read the function's returns, what they are (returnedContract:
 * the value kinds, and the `shape` strings and `body` keys of returned object literals; null = open). `open` is
 * moduleExports' (a list that may be incomplete); null when the module cannot be read or parsed.
 */
export type ExportContractEntry = { name: string; kind: string; parameters?: ExportParameter[]; returns?: string | null; signature?: string; returned?: { kinds: string[] | null; shapes: string[] | null; body_keys: string[] | null } };
export function exportContract(siteRel: string, reader: SrcReader): { exports: ExportContractEntry[]; open: string | null } | null {
  const ex = moduleExports(siteRel, reader);
  const ts = loadTs();
  if (!ex || !ts) return null;
  const sigs = exportSignatures(siteRel, reader);
  const parsed = new Map<string, TS.SourceFile | null>();
  const sfOf = (rel: string): TS.SourceFile | null => {
    if (!parsed.has(rel)) { const src = reader.read(rel); parsed.set(rel, src === null ? null : ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)); }
    return parsed.get(rel)!;
  };
  const list = (s: Set<string> | null): string[] | null => (s ? [...s] : null);
  const exports = [...ex.names].map(([name, kind]): ExportContractEntry => {
    const s = sigs.get(name);
    if (!s) return { name, kind };
    const msf = sfOf(s.module);
    const rc = msf ? returnedContract(ts, msf, s.local) : null;
    return { name, kind, parameters: s.parameters, returns: s.returns, signature: s.text, ...(rc ? { returned: { kinds: list(rc.kinds), shapes: list(rc.shapes), body_keys: list(rc.bodyKeys) } } : {}) };
  });
  return { exports, open: ex.open };
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
 * `absence` marks a member read whose only use is an assertion that the name is NOT there (control (a), re-scoped by
 * the user ruling of 2026-10-18 07:09:57Z (the check-writer repair)):
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
 * process, say) is unaffected. The names a check's module MOCKS supply are resolved the same way (979b966d, a reach-judge
 * check: `mock.module("../../src/llm-router", () => ({ createLLMPort }))`, where llm-router exports no createLLMPort, so
 * the stand-in its verdict rests on is never what the code calls): each key a mock.module (jest.mock / vi.mock) factory
 * returns for a src module of the vessel must be one of that module's real exports, else the same refusal names it.
 * null = no refusal. Applied at attach (gap-check-supply's arm step) and at the verify of
 * a test_writing compose (judgeTestWritingCheck), so the check that would be refused at attach never lands.
 */
export const MISSING_EXPORT_STAGE = "check_references_missing_export";
/**
 * THE NAMES A CHECK'S MODULE MOCKS SUPPLY: for each `mock.module("<relative spec>", factory)` (and jest.mock / vi.mock
 * with a factory), the keys of the object the factory returns (an arrow's object body, or every `return { … }` of a
 * block body; spread members are skipped, `__esModule` is not a name). A factory whose result is not an object literal
 * names nothing.
 */
function mockedModuleKeys(source: string, checkRel: string): Array<{ spec: string; symbol: string }> {
  const ts = loadTs();
  if (!ts) return [];
  const sf = ts.createSourceFile(checkRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<{ spec: string; symbol: string }> = [];
  const unwrap = (e: TS.Expression): TS.Expression => { while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression; return e; };
  const keysOf = (e: TS.Expression | undefined, spec: string): void => {
    const o = e ? unwrap(e) : null;
    if (!o || !ts.isObjectLiteralExpression(o)) return;
    for (const p of o.properties) {
      if (ts.isSpreadAssignment(p) || !p.name) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key && key !== "__esModule" && !out.some((r) => r.spec === spec && r.symbol === key)) out.push({ spec, symbol: key });
    }
  };
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
      const who = `${n.expression.expression.text}.${n.expression.name.text}`;
      const [specArg, factory] = n.arguments;
      if ((who === "mock.module" || who === "jest.mock" || who === "vi.mock") && specArg && ts.isStringLiteral(specArg) && specArg.text.startsWith(".") && factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
        if (!ts.isBlock(factory.body)) keysOf(factory.body, specArg.text);
        else {
          const rets = (b: TS.Node): void => { if (ts.isFunctionLike(b)) return; if (ts.isReturnStatement(b)) keysOf(b.expression, specArg.text); ts.forEachChild(b, rets); };
          ts.forEachChild(factory.body, rets);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
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
  for (const m of mockedModuleKeys(source, checkRel)) {
    const target = resolveModule(checkRel, m.spec, reader);
    if (!target || !target.rel.startsWith("src/")) continue;
    if (!cache.has(target.rel)) cache.set(target.rel, moduleExports(target.rel, reader));
    const ex = cache.get(target.rel);
    if (!ex || ex.open !== null || ex.names.has(m.symbol)) continue;
    const listed = [...ex.names.keys()].slice(0, 12).join(", ");
    return { symbol: m.symbol, module: target.rel, reason: `${MISSING_EXPORT_STAGE}:${m.symbol}: the check mocks ${m.symbol} on ${target.rel}, which does not export it (it exports ${ex.names.size} name${ex.names.size === 1 ? "" : "s"}${listed ? `: ${listed}${ex.names.size > 12 ? ", …" : ""}` : ""}), so the stand-in replaces nothing the code under test imports from there: the check's red is decided by its own mock, not by the defect` };
  }
  return null;
}

/**
 * WHAT THE REPAIR OF A CHECK REFUSED FOR A MISSING EXPORT IS TOLD THE MODULE EXPORTS. The refusal's reason names at most
 * 12 of the module's names and no signature, and the repair round quotes that reason clipped, so the round that must
 * rewrite the check onto real exports was told neither what they are nor how to call them (f176b321, a goal-host
 * src/index.ts check that read the internal universalToolFallback: every repair round re-drafted blind and broke the
 * typecheck). Rendered from exportContract, the enumeration the refusal itself reads (moduleExports, with
 * exportSignatures' declared signatures and the `shape` strings the return walk reads): every export in its order,
 * one per line, `name: kind (parameters): ReturnType`, each signature clamped (REPAIR_SURFACE_SIGNATURE_MAX) and the
 * whole bounded (REPAIR_SURFACE_MAX_CHARS), the rest counted. null when the module cannot be read or parsed, or exports
 * nothing.
 */
export const REPAIR_SURFACE_SIGNATURE_MAX = 200;
export const REPAIR_SURFACE_MAX_CHARS = 6000;
export function exportedSurface(rel: string, reader: SrcReader): string | null {
  const c = exportContract(rel, reader);
  if (!c || c.exports.length === 0) return null;
  const lines: string[] = [];
  let chars = 0;
  for (const e of c.exports) {
    const shapes = e.returned?.shapes?.length ? ` returning shape ${e.returned.shapes.map((s) => JSON.stringify(s)).join(" | ")}` : "";
    const sig = e.signature ? `${e.signature}${shapes}` : "";
    const line = `${e.name}: ${e.kind}${sig ? ` ${sig.length > REPAIR_SURFACE_SIGNATURE_MAX ? `${sig.slice(0, REPAIR_SURFACE_SIGNATURE_MAX - 1)}…` : sig}` : ""}`;
    if (chars + line.length + 1 > REPAIR_SURFACE_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const more = c.exports.length - lines.length;
  return `${lines.join("\n")}${more > 0 ? `\n… and ${more} more` : ""}${c.open ? "\n(and what it re-exports from a module not readable here)" : ""}`;
}

/**
 * A CHECK THAT ASSERTS A CONTRACT ITS TARGET DOES NOT HAVE IS NOT A FALSIFIER. 333be5f (template-input-lint
 * harness-check-scenario) asserted `expect(result.shape).toBe('template_input_lint_issues')` on a resolver that returns
 * shape "templateInputLintReport", then `result.body.unusedInputs`, a field its body never sets. That is an assertion red
 * by the shared classifier, so it passed the verify and the arm, yet it is red on every tree whatever the fix: the
 * arm attached an unclosable falsifier. Judged from the RUN and the SOURCE together, never from the source alone:
 *   - the run: the failing expect() of each assertion failure, placed by its first stack frame in the check, and the
 *     Expected/Received bun printed (retry-evidence.ts classifyCheckRun `compared`);
 *   - the source: the assertion's subject must be a value the check got by CALLING an export of a src module of its
 *     vessel (`const r = await ns.fn(…)`, `fn(…)`, or the call inline), and that function's returns are read with the
 *     TypeScript parser (object literals, through local helper calls, conditionals and await; any other return leaves
 *     the returned shapes or body open).
 * It refuses, `check_asserts_contract_mismatch:<shape | body.X>`, when
 *   - the assertion reads `<r>.shape`, Received is a shape the function returns, and Expected is a string that is neither
 *     a shape it returns nor any string literal in its module; or
 *   - it reads `<r>.body.<X>`, Received is undefined, and every return's body is an object literal none of which sets X;
 *   - it reads `<r>` ITSELF with toBe / toEqual / toStrictEqual (not negated), Expected is a string, number or boolean
 *     the function can never return (every return is a literal or object of another kind: an object or null, say), and
 *     Received is of a kind it does return (`check_asserts_contract_mismatch:value`). An inverted check is this class:
 *     it calls an object-or-null classifier with a field the classifier never reads and expects the field's value
 *     back, so greening it would mean breaking the real classifier. Unlike the shape rule, a string literal elsewhere
 *     in the module does not excuse it: a literal the function compares against is not a value it returns.
 * The called function is found through `ns.fn(…)`, `(ns as any).fn(…)`, a named import, or a local alias of one of
 * those (`const f: any = (ns as any).fn; f(…)`). Every value-preserving pass-through around the call is looked through
 * first, for every rule: await, parentheses, `as` / `satisfies` / `!`, a one-argument `Promise.resolve(x)`, and
 * `Promise.all([…])[i]` / `(await Promise.all([…]))[i]` (directly or through a local holding the Promise.all), whose
 * element i is the call. A wrapper is not a contract: `await Promise.resolve(f(x))` asserts what f returns.
 * An assertion it cannot place, a value it cannot trace, or an open contract decides nothing. Known limit (accepted, as
 * for a missing export): a gap whose fix ADDS the shape or the body field, or makes the function return a value of a
 * new kind, writes exactly this check, and it is refused.
 * THE EXPECTED VALUE MUST BE DERIVABLE FROM WHAT THE CHECK SUPPLIES (c2ab3e0, a lookup check: it mocks the search the
 * function calls to return a hit WITHOUT the embedding, then expects the function to return the embedding
 * [0.1, 0.2, 0.3, 0.4], a value nothing it supplies carries; red forever, yet it passed the arm guards). After every rule
 * above, it refuses `check_asserts_contract_mismatch:expected_not_derivable` when
 *   - the check stands in for a dependency (mock.module, mock(), spyOn, jest/vi fakes, or an assignment to a global such
 *     as global.fetch) and reads no data from outside its own text (no file read, no JSON import, no require, no
 *     non-relative dynamic import), so what the code under test is given is what the check's text holds;
 *   - the failing assertion is toBe / toEqual / toStrictEqual (not negated) on the result of a call to a src export (or a
 *     member of it), found as above; and its Expected is an array or object literal, inline or through a local, whose
 *     leaves are literals;
 *   - and not one number or string at those leaves appears anywhere else in the check (its mocks, fixtures, arguments,
 *     numbers inside strings included) or in the called module: no code path can produce the value from them.
 * Known limit (accepted): a function that COMPUTES a composite sharing no datum with its mocked inputs (a normalised
 * vector, say), or a check whose mocks compute their data, is refused.
 * A PROPERTY READ ON A RETURN THAT IS NOT AN OBJECT (725638cc, a goal-target inference check: it reads `.shapes` off
 * a function declared `Promise<string[]>`, whose sibling returns the object with `shapes`; the read is undefined on every
 * tree, so its subject is [] whatever the fix). Last, it refuses `check_asserts_contract_mismatch:property.<X>` when the
 * failing assertion's subject (and the locals it is computed from, a bounded walk) reads a named property X off the
 * result of a call to a src export, found as above, and X is no member of any kind that result can be: the kinds of the
 * function's DECLARED return type (arrays and tuples, string / number / boolean, null / undefined / void, literals and
 * unions of those; Promise<T> read as T, and only when the call is awaited), or, with no declared type, the return
 * walk's kinds when they are closed and hold no object. A declared object type, an interface or alias, any or unknown,
 * and an un-awaited Promise decide nothing. Known limit (accepted): a gap whose fix changes the return to an object
 * writes exactly this check, and it is refused.
 * Applied where missingExportRefusal is: at the verify of a test_writing compose (so a refused check never lands) and at
 * the arm step. null = no refusal.
 */
export const CONTRACT_MISMATCH_STAGE = "check_asserts_contract_mismatch";
/** The kinds of value a function can return (`kinds`), read from the same return walk; null = open. */
type ValueKind = "object" | "array" | "null" | "undefined" | "string" | "number" | "boolean";
type ReturnedContract = { shapes: Set<string> | null; bodyKeys: Set<string> | null; kinds: Set<ValueKind> | null };
function returnedContract(ts: TsModule, sf: TS.SourceFile, fnName: string): ReturnedContract | null {
  const locals = new Map<string, TS.FunctionLikeDeclaration>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) locals.set(s.name.text, s);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) locals.set(d.name.text, d.initializer);
  }
  const root = locals.get(fnName);
  if (!root) return null;
  const shapes = new Set<string>(), bodyKeys = new Set<string>(), kinds = new Set<ValueKind>();
  let shapesOpen = false, bodyOpen = false, kindsOpen = false;
  const open = (): void => { shapesOpen = true; bodyOpen = true; };
  const unwrap = (e: TS.Expression): TS.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    return e;
  };
  const keyOf = (p: TS.ObjectLiteralElementLike): string | null => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
  const seen = new Set<TS.Node>([root]);
  const returnsOf = (fn: TS.FunctionLikeDeclaration): Array<TS.Expression | undefined> => {
    if (!fn.body) return [undefined];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: Array<TS.Expression | undefined> = [];
    const visit = (n: TS.Node): void => { if (ts.isFunctionLike(n)) return; if (ts.isReturnStatement(n)) out.push(n.expression); ts.forEachChild(n, visit); };
    ts.forEachChild(fn.body, visit);
    return out;
  };
  // The kind of a return that is not an object literal: a literal of one kind, or null (open) for anything else.
  const literalKind = (e: TS.Expression): ValueKind | null => {
    if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
    if (ts.isIdentifier(e) && e.text === "undefined") return "undefined";
    if (ts.isVoidExpression(e)) return "undefined";
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return "string";
    if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))) return "number";
    if (ts.isArrayLiteralExpression(e)) return "array";
    return null;
  };
  const value = (raw: TS.Expression | undefined): void => {
    if (!raw) { kinds.add("undefined"); open(); return; }
    const e = unwrap(raw);
    if (ts.isConditionalExpression(e)) { value(e.whenTrue); value(e.whenFalse); return; }
    const helper = ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? locals.get(e.expression.text) : undefined;
    if (helper) { if (!seen.has(helper)) { seen.add(helper); for (const r of returnsOf(helper)) value(r); } return; }
    if (!ts.isObjectLiteralExpression(e)) { const k = literalKind(e); if (k) kinds.add(k); else kindsOpen = true; open(); return; }
    // An object literal is an object whatever it spreads: a spread opens its shape and body, never its kind.
    kinds.add("object");
    let shape = false, body = false;
    for (const p of e.properties) {
      const k = ts.isSpreadAssignment(p) ? null : keyOf(p);
      if (k === null) { open(); continue; }
      const init = ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null;
      if (k === "shape") {
        shape = true;
        if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) shapes.add(init.text); else shapesOpen = true;
      } else if (k === "body") {
        body = true;
        if (!init || !ts.isObjectLiteralExpression(init)) { bodyOpen = true; continue; }
        for (const bp of init.properties) { const bk = ts.isSpreadAssignment(bp) ? null : keyOf(bp); if (bk === null) bodyOpen = true; else bodyKeys.add(bk); }
      }
    }
    if (!shape) shapesOpen = true;
    if (!body) bodyOpen = true;
  };
  for (const r of returnsOf(root)) value(r);
  return { shapes: shapesOpen ? null : shapes, bodyKeys: bodyOpen ? null : bodyKeys, kinds: kindsOpen ? null : kinds };
}
/** The function or arrow `fnName` declares at the top of its module, or null. */
function topLevelFunction(ts: TsModule, sf: TS.SourceFile, fnName: string): TS.FunctionLikeDeclaration | null {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === fnName && s.body) return s;
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === fnName && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
  }
  return null;
}
/** Whether calling `fnName` yields a Promise (it is async, or declares a Promise return). */
function returnsPromise(ts: TsModule, sf: TS.SourceFile, fnName: string): boolean {
  const fn = topLevelFunction(ts, sf, fnName);
  if (!fn) return false;
  if ((ts.canHaveModifiers(fn) ? ts.getModifiers(fn) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
  return !!fn.type && ts.isTypeReferenceNode(fn.type) && ts.isIdentifier(fn.type.typeName) && /^Promise(?:Like)?$/.test(fn.type.typeName.text);
}
/**
 * The kinds of value `fnName`'s DECLARED return type allows (a Promise<T> read as T, `promise` set), when none of them
 * is an object: arrays and tuples, string / number / boolean, void / undefined / null and their literals, and unions of
 * those. null when no return type is declared or it allows an object (an object type, an interface or alias, any,
 * unknown), which decides nothing.
 */
function declaredReturnKinds(ts: TsModule, sf: TS.SourceFile, fnName: string): { kinds: Set<ValueKind>; text: string; promise: boolean } | null {
  const fn = topLevelFunction(ts, sf, fnName);
  if (!fn?.type) return null;
  const kinds = new Set<ValueKind>();
  let promise = false;
  const visit = (t: TS.TypeNode, top: boolean): boolean => {
    if (ts.isParenthesizedTypeNode(t)) return visit(t.type, top);
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
      const n = t.typeName.text;
      if (top && (n === "Promise" || n === "PromiseLike") && t.typeArguments?.length === 1) { promise = true; return visit(t.typeArguments[0]!, false); }
      if (n === "Array" || n === "ReadonlyArray") { kinds.add("array"); return true; }
      return false;
    }
    if (ts.isArrayTypeNode(t) || ts.isTupleTypeNode(t)) { kinds.add("array"); return true; }
    if (ts.isTypeOperatorNode(t) && t.operator === ts.SyntaxKind.ReadonlyKeyword) return visit(t.type, false);
    if (ts.isUnionTypeNode(t)) return t.types.every((u) => visit(u, false));
    if (ts.isLiteralTypeNode(t)) {
      const l = t.literal;
      if (l.kind === ts.SyntaxKind.NullKeyword) kinds.add("null");
      else if (ts.isStringLiteral(l) || ts.isNoSubstitutionTemplateLiteral(l)) kinds.add("string");
      else if (ts.isNumericLiteral(l) || ts.isPrefixUnaryExpression(l)) kinds.add("number");
      else if (l.kind === ts.SyntaxKind.TrueKeyword || l.kind === ts.SyntaxKind.FalseKeyword) kinds.add("boolean");
      else return false;
      return true;
    }
    const k: ValueKind | null = t.kind === ts.SyntaxKind.StringKeyword ? "string" : t.kind === ts.SyntaxKind.NumberKeyword ? "number" : t.kind === ts.SyntaxKind.BooleanKeyword ? "boolean" : t.kind === ts.SyntaxKind.VoidKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword ? "undefined" : t.kind === ts.SyntaxKind.NullKeyword ? "null" : null;
    if (k) kinds.add(k);
    return k !== null;
  };
  return visit(fn.type, true) && kinds.size > 0 ? { kinds, text: fn.type.getText(sf), promise } : null;
}
/** The named properties a value of each kind has (its prototype chain's own names); an object's are open. */
const protoNames = (p: object): Set<string> => new Set([...Object.getOwnPropertyNames(p), ...Object.getOwnPropertyNames(Object.prototype)]);
const VALUE_MEMBERS: Record<ValueKind, Set<string>> = { array: protoNames(Array.prototype), string: protoNames(String.prototype), number: protoNames(Number.prototype), boolean: protoNames(Boolean.prototype), null: new Set(), undefined: new Set(), object: new Set() };
/** A check's module bindings (relative specifiers only): namespace imports and `const ns = await import(…)` by local
 *  name, named imports by local name. */
function checkBindings(ts: TsModule, sf: TS.SourceFile): { ns: Map<string, string>; named: Map<string, { spec: string; imported: string }> } {
  const unwrap = (e: TS.Expression): TS.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    return e;
  };
  const relSpec = (n: TS.Expression | undefined): string | null => (n && ts.isStringLiteral(n) && n.text.startsWith(".") ? n.text : null);
  const ns = new Map<string, string>();
  const named = new Map<string, { spec: string; imported: string }>();
  const bind = (n: TS.Node): void => {
    if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly) {
      const spec = relSpec(n.moduleSpecifier), nb = n.importClause.namedBindings;
      if (spec && nb && ts.isNamespaceImport(nb)) ns.set(nb.name.text, spec);
      if (spec && nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) named.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      const spec = ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword ? relSpec(init.arguments[0]) : null;
      if (spec) ns.set(n.name.text, spec);
    }
    ts.forEachChild(n, bind);
  };
  bind(sf);
  return { ns, named };
}
export function contractMismatchRefusal(source: string, checkRel: string, redReason: unknown, reader: SrcReader): { test: string; module: string; fn: string; reads: string; reason: string } | null {
  const compared = (redReason as { compared?: unknown } | null | undefined)?.compared;
  if (!Array.isArray(compared) || compared.length === 0) return null;
  const ts = loadTs();
  if (!ts) return null;
  const sf = ts.createSourceFile(checkRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unwrap = (e: TS.Expression): TS.Expression => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    return e;
  };
  const relSpec = (n: TS.Expression | undefined): string | null => (n && ts.isStringLiteral(n) && n.text.startsWith(".") ? n.text : null);
  const { ns, named } = checkBindings(ts, sf);
  // Every expect(<subject>)…<matcher>(…) call: the matcher name's position is where bun's stack frame points.
  const expects: Array<{ subject: TS.Expression; line: number; col: number; matcher: string; negated: boolean; args: readonly TS.Expression[] }> = [];
  const findExpects = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "expect" && n.arguments[0]) {
      let m: TS.Node = n;
      while (m.parent && ts.isPropertyAccessExpression(m.parent) && m.parent.expression === m && m.parent.name.text === "not") m = m.parent;
      if (m.parent && ts.isPropertyAccessExpression(m.parent) && m.parent.expression === m) {
        const pos = sf.getLineAndCharacterOfPosition(m.parent.name.getStart(sf));
        const mc = m.parent.parent;
        expects.push({ subject: n.arguments[0], line: pos.line + 1, col: pos.character + 1, matcher: m.parent.name.text, negated: m !== n, args: mc && ts.isCallExpression(mc) && mc.expression === m.parent ? mc.arguments : [] });
      }
    }
    ts.forEachChild(n, findExpects);
  };
  findExpects(sf);
  /** The declaration of `name` in scope at `from`: the nearest enclosing block's `const|let name = <init>`. */
  const initOf = (from: TS.Node, name: string): TS.Expression | null => {
    for (let a: TS.Node | undefined = from.parent; a; a = a.parent) {
      if (!ts.isBlock(a) && !ts.isSourceFile(a)) continue;
      for (const s of a.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
    return null;
  };
  /** `Promise.<method>(…)` on the global Promise (not a local binding named Promise). */
  const promiseCall = (e: TS.Expression, method: string): TS.CallExpression | null => {
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== method) return null;
    const o = e.expression.expression;
    return ts.isIdentifier(o) && o.text === "Promise" && !initOf(e, "Promise") ? e : null;
  };
  /** The expression a value-preserving pass-through wraps, until none is left (a bounded walk). */
  const passThrough = (from: TS.Expression): TS.Expression => {
    let e = unwrap(from);
    for (let hops = 0; hops < 8; hops++) {
      // A local holding the wrapped value (`const p = f(x); … Promise.resolve(p)`) is read through its declaration.
      if (ts.isIdentifier(e)) { const d = initOf(e, e.text); if (d) { e = unwrap(d); continue; } break; }
      const resolved = promiseCall(e, "resolve");
      if (resolved && resolved.arguments.length === 1 && !ts.isSpreadElement(resolved.arguments[0]!)) { e = unwrap(resolved.arguments[0]!); continue; }
      if (ts.isElementAccessExpression(e) && ts.isNumericLiteral(e.argumentExpression)) {
        let base = unwrap(e.expression);
        if (ts.isIdentifier(base)) { const b = initOf(e, base.text); if (b) base = unwrap(b); }
        const all = promiseCall(base, "all");
        const arr = all && all.arguments.length === 1 ? unwrap(all.arguments[0]!) : null;
        const i = Number(e.argumentExpression.text);
        if (arr && ts.isArrayLiteralExpression(arr) && Number.isInteger(i) && i < arr.elements.length && !arr.elements.slice(0, i + 1).some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) { e = unwrap(arr.elements[i]!); continue; }
      }
      break;
    }
    return e;
  };
  const parseValue = (v: string | null): string | null => { if (v === null || !v.startsWith("\"")) return null; try { const s = JSON.parse(v) as unknown; return typeof s === "string" ? s : null; } catch { return null; } };
  /** The one expect() a compared entry's frame points at in the check, or null. */
  const placed = (c: Record<string, unknown>): (typeof expects)[number] | null => {
    const file = typeof c["file"] === "string" ? c["file"].replace(/\\/g, "/") : "";
    if (!(file === checkRel || file.endsWith(`/${checkRel}`)) || typeof c["line"] !== "number") return null;
    // One expect() on the frame's line is that assertion; several are told apart by the frame's column.
    const onLine = expects.filter((x) => x.line === c["line"]);
    const at = onLine.length > 1 ? onLine.filter((x) => x.col === c["col"]) : onLine;
    return at.length === 1 ? at[0]! : null;
  };
  // The callee: a named import, a member of a namespace (through a cast: `(ns as any).fn`), or one local alias of either.
  const calleeOf = (call: TS.Node, raw: TS.Expression, aliased: boolean): { spec: string; fn: string } | null => {
    const callee = unwrap(raw);
    if (ts.isIdentifier(callee)) {
      if (named.has(callee.text)) return { spec: named.get(callee.text)!.spec, fn: named.get(callee.text)!.imported };
      const alias = aliased ? null : initOf(call, callee.text);
      return alias ? calleeOf(call, alias, true) : null;
    }
    const obj = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? unwrap(callee.expression) : null;
    if (!obj || !ts.isIdentifier(obj) || !ns.has(obj.text)) return null;
    if (ts.isPropertyAccessExpression(callee)) return { spec: ns.get(obj.text)!, fn: callee.name.text };
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)) return { spec: ns.get(obj.text)!, fn: callee.argumentExpression.text };
    return null;
  };
  /** The src module export a value is the result of (`init` passed through every value-preserving wrapper), or null. */
  const calledExport = (init: TS.Expression | null): { fn: string; mod: { rel: string; source: string }; msf: TS.SourceFile } | null => {
    const call = init ? passThrough(init) : null;
    if (!call || !ts.isCallExpression(call)) return null;
    const target = calleeOf(call, call.expression, false);
    if (!target) return null;
    const mod = resolveModule(checkRel, target.spec, reader);
    if (!mod || !mod.rel.startsWith("src/")) return null;
    return { fn: target.fn, mod, msf: ts.createSourceFile(mod.rel, mod.source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(mod.rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS) };
  };
  for (const c of compared as Array<Record<string, unknown>>) {
    const at = placed(c);
    if (!at) continue;
    // The subject's member path (r.body.X -> ["body", "X"]) and its root.
    const path: string[] = [];
    let e = unwrap(at.subject);
    for (;;) {
      if (ts.isPropertyAccessExpression(e)) { path.unshift(e.name.text); e = unwrap(e.expression); continue; }
      if (ts.isElementAccessExpression(e) && (ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression))) { path.unshift(e.argumentExpression.text); e = unwrap(e.expression); continue; }
      break;
    }
    const equality = !at.negated && (at.matcher === "toBe" || at.matcher === "toEqual" || at.matcher === "toStrictEqual");
    const reads = path[0] === "shape" && path.length === 1 ? "shape" : path[0] === "body" && path.length >= 2 ? `body.${path[1]}` : path.length === 0 && equality ? "value" : null;
    if (!reads) continue;
    const called = calledExport(ts.isIdentifier(e) ? initOf(at.subject, e.text) : e);
    if (!called) continue;
    const { mod, msf } = called;
    const target = { fn: called.fn };
    const contract = returnedContract(ts, msf, target.fn);
    if (!contract) continue;
    const test = String(c["name"] ?? "");
    const where = `the failing assertion of "${test.slice(0, 120)}" (line ${c["line"]})`;
    if (reads === "shape") {
      const expected = parseValue(typeof c["expected"] === "string" ? c["expected"] : null), received = parseValue(typeof c["received"] === "string" ? c["received"] : null);
      if (!contract.shapes || expected === null || received === null || !contract.shapes.has(received) || contract.shapes.has(expected)) continue;
      const literals = new Set<string>();
      const lit = (n: TS.Node): void => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.add(n.text); ts.forEachChild(n, lit); };
      lit(msf);
      if (literals.has(expected)) continue;
      return { test, module: mod.rel, fn: target.fn, reads, reason: `${CONTRACT_MISMATCH_STAGE}:shape: ${where} expects the shape ${JSON.stringify(expected)} from ${target.fn} in ${mod.rel}, which returns ${[...contract.shapes].map((s) => JSON.stringify(s)).join(", ")} and names ${JSON.stringify(expected)} nowhere, so the check is red on every tree, not for the defect` };
    }
    if (reads === "value") {
      // What bun printed, by kind: a JSON string, a number, true/false; Received also null, undefined, an object or an array.
      const kindOfPrinted = (v: unknown): ValueKind | null => {
        if (typeof v !== "string") return null;
        const t = v.trim();
        if (t === "null") return "null";
        if (t === "undefined") return "undefined";
        if (t === "true" || t === "false") return "boolean";
        if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(t)) return "number";
        if (t.startsWith("\"")) return parseValue(t) === null ? null : "string";
        if (t.startsWith("{")) return "object";
        if (t.startsWith("[")) return "array";
        return null;
      };
      const expectedKind = kindOfPrinted(c["expected"]), receivedKind = kindOfPrinted(c["received"]);
      if (!contract.kinds || contract.kinds.size === 0 || !receivedKind || !contract.kinds.has(receivedKind)) continue;
      if (expectedKind !== "string" && expectedKind !== "number" && expectedKind !== "boolean") continue;
      if (contract.kinds.has(expectedKind)) continue;
      const returns = [...contract.kinds].sort().join(" | ");
      return { test, module: mod.rel, fn: target.fn, reads, reason: `${CONTRACT_MISMATCH_STAGE}:value: ${where} expects ${String(c["expected"]).slice(0, 80)} (a ${expectedKind}) from ${target.fn} in ${mod.rel}, which only ever returns ${returns} (Received ${String(c["received"]).slice(0, 80)}), so the check is red on every tree, not for the defect` };
    }
    const field = path[1]!;
    if (c["received"] !== "undefined" || !contract.bodyKeys || contract.bodyKeys.has(field)) continue;
    const keys = [...contract.bodyKeys].slice(0, 12).join(", ");
    return { test, module: mod.rel, fn: target.fn, reads, reason: `${CONTRACT_MISMATCH_STAGE}:body.${field}: ${where} reads body.${field} from ${target.fn} in ${mod.rel}, whose returned body never sets ${field} (it sets ${contract.bodyKeys.size} field${contract.bodyKeys.size === 1 ? "" : "s"}${keys ? `: ${keys}${contract.bodyKeys.size > 12 ? ", …" : ""}` : ""}), so the check is red on every tree, not for the defect` };
  }
  // THE EXPECTED VALUE MUST BE DERIVABLE FROM WHAT THE CHECK SUPPLIES (a second pass: every rule above decides first).
  // Does the check stand its own value in for a dependency, and does it read data from outside its own text?
  let substitutes = false, readsOutside = false;
  const scan = (n: TS.Node): void => {
    if (ts.isCallExpression(n)) {
      const f = n.expression;
      const name = ts.isIdentifier(f) ? f.text : ts.isPropertyAccessExpression(f) ? `${ts.isIdentifier(f.expression) ? f.expression.text : ""}.${f.name.text}` : "";
      if (/^(?:mock|spyOn|mock\.module|(?:jest|vi)\.(?:fn|mock|spyOn))$/.test(name)) substitutes = true;
      if (/^(?:readFileSync|readFile|require|\w*\.readFileSync|\w*\.readFile|Bun\.file)$/.test(name)) readsOutside = true;
      if (f.kind === ts.SyntaxKind.ImportKeyword && !/^\.(?!.*\.json$)/.test(relSpec(n.arguments[0]) ?? "")) readsOutside = true;
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /\.json$/.test(n.moduleSpecifier.text)) readsOutside = true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && ts.isIdentifier(n.left.expression) && /^(?:global|globalThis|window)$/.test(n.left.expression.text)) substitutes = true;
    ts.forEachChild(n, scan);
  };
  scan(sf);
  for (const c of (substitutes && !readsOutside ? compared : []) as Array<Record<string, unknown>>) {
    const at = placed(c);
    if (!at || at.negated || !(at.matcher === "toBe" || at.matcher === "toEqual" || at.matcher === "toStrictEqual")) continue;
    let e = unwrap(at.subject);
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression);
    const called = calledExport(ts.isIdentifier(e) ? initOf(at.subject, e.text) : e);
    if (!called) continue;
    // The expected value: an array or object literal, inline or through a local.
    let x: TS.Expression | null = at.args[0] ? unwrap(at.args[0]) : null;
    if (x && ts.isIdentifier(x)) { const d = initOf(at.subject, x.text); x = d ? unwrap(d) : null; }
    if (!x || !(ts.isArrayLiteralExpression(x) || ts.isObjectLiteralExpression(x))) continue;
    const expectedNode = x;
    // Its data: every number and string at its leaves (keys, booleans and null are structure, not data).
    const leaves: Array<number | string> = [];
    let closed = true;
    const leaf = (raw: TS.Expression): void => {
      const v = unwrap(raw);
      if (ts.isArrayLiteralExpression(v)) { for (const el of v.elements) { if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) closed = false; else leaf(el); } return; }
      if (ts.isObjectLiteralExpression(v)) { for (const p of v.properties) { if (ts.isPropertyAssignment(p)) leaf(p.initializer); else closed = false; } return; }
      if (ts.isNumericLiteral(v)) { leaves.push(Number(v.text)); return; }
      if (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(v.operand)) { leaves.push(-Number(v.operand.text)); return; }
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) { leaves.push(v.text); return; }
      if (v.kind === ts.SyntaxKind.TrueKeyword || v.kind === ts.SyntaxKind.FalseKeyword || v.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(v) && v.text === "undefined")) return;
      closed = false;
    };
    leaf(expectedNode);
    if (!closed || leaves.length === 0) continue;
    // What the code under test can be given: every literal in the check outside the expected value (its mocks, its
    // fixtures, its arguments) and in the called module, numbers also as they appear inside strings (a JSON body).
    const nums = new Set<number>(), strs: string[] = [];
    const lits = (n: TS.Node): void => {
      if (n === expectedNode) return;
      if (ts.isNumericLiteral(n)) nums.add(Math.abs(Number(n.text)));
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
        strs.push(n.text);
        for (const m of n.text.matchAll(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)) nums.add(Number(m[0]));
      }
      ts.forEachChild(n, lits);
    };
    lits(sf);
    lits(called.msf);
    const available = (l: number | string): boolean => typeof l === "number" ? nums.has(Math.abs(l)) : strs.some((s) => s === l || (s.length >= 3 && l.includes(s)) || (l.length >= 3 && s.includes(l)));
    if (leaves.some(available)) continue;
    const test = String(c["name"] ?? "");
    const shown = leaves.slice(0, 6).map((l) => JSON.stringify(l)).join(", ") + (leaves.length > 6 ? ", …" : "");
    return { test, module: called.mod.rel, fn: called.fn, reads: "expected_not_derivable", reason: `${CONTRACT_MISMATCH_STAGE}:expected_not_derivable: the failing assertion of "${test.slice(0, 120)}" (line ${c["line"]}) expects from ${called.fn} in ${called.mod.rel} a value none of whose ${leaves.length} datum${leaves.length === 1 ? "" : "s"} (${shown}) appears in what the check supplies (its mocks, fixtures and arguments) or in ${called.mod.rel}: the check stands in for the dependencies, so no code path can produce that value from them, and the check is red on every tree, not for the defect` };
  }
  // A PROPERTY READ ON A VALUE THAT IS NOT AN OBJECT (the third pass, after every rule above): a named property the
  // called function's return can never have (its declared return type, else the return walk) reads undefined on
  // every tree.
  for (const c of compared as Array<Record<string, unknown>>) {
    const at = placed(c);
    if (!at) continue;
    // Every named property read in the subject, and in the locals it is computed from (bounded), with its base.
    const propReads: Array<{ name: string; base: TS.Expression }> = [];
    const followed = new Set<string>();
    const walk = (n: TS.Node, depth: number): void => {
      if (ts.isPropertyAccessExpression(n)) propReads.push({ name: n.name.text, base: n.expression });
      else if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression))) propReads.push({ name: n.argumentExpression.text, base: n.expression });
      else if (ts.isIdentifier(n) && depth < 3 && !followed.has(n.text) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const d = initOf(n, n.text);
        if (d && !calledExport(d)) { followed.add(n.text); walk(d, depth + 1); }
      }
      ts.forEachChild(n, (k) => walk(k, depth));
    };
    walk(at.subject, 0);
    for (const r of propReads) {
      const b = unwrap(r.base);
      const init = ts.isIdentifier(b) ? initOf(b, b.text) : r.base;
      const called = calledExport(init);
      if (!called || !init) continue;
      // An un-awaited call of an async function is its Promise, whose then / catch / finally are real.
      let w: TS.Expression = init;
      while (ts.isParenthesizedExpression(w) || ts.isAsExpression(w) || ts.isNonNullExpression(w) || ts.isSatisfiesExpression(w) || ts.isTypeAssertionExpression(w)) w = w.expression;
      const declared = declaredReturnKinds(ts, called.msf, called.fn);
      if (!declared && !ts.isAwaitExpression(w) && returnsPromise(ts, called.msf, called.fn)) continue;
      if (declared?.promise && !ts.isAwaitExpression(w)) continue;
      const walked = declared ? null : returnedContract(ts, called.msf, called.fn)?.kinds ?? null;
      const kinds = declared?.kinds ?? (walked && walked.size > 0 && !walked.has("object") ? walked : null);
      if (!kinds || [...kinds].some((k) => VALUE_MEMBERS[k].has(r.name))) continue;
      const test = String(c["name"] ?? "");
      const what = [...kinds].sort().join(" | ");
      return { test, module: called.mod.rel, fn: called.fn, reads: `property.${r.name}`, reason: `${CONTRACT_MISMATCH_STAGE}:property.${r.name}: the failing assertion of "${test.slice(0, 120)}" (line ${c["line"]}) reads .${r.name} off what ${called.fn} in ${called.mod.rel} returns, ${declared ? `declared ${declared.text.slice(0, 80)}` : "which only ever returns"} (${what}), a value with no property ${r.name}: the read is undefined on every tree, so the check is red, not for the defect` };
    }
  }
  return null;
}

/**
 * A CHECK THAT CALLS ITS TARGET THROUGH A CAST IS NOT A FALSIFIER (user ruling: held until a gate refuses it). 2182d140
 * called `Number((mod as any).nonAttemptDelayMs(row))` on a function declared (baseMs, streak, maxMs, receiverMinMs = 0):
 * one row object where four numbers belong. The cast erased the signature, so the call typechecked, ran, and was red on
 * every tree for the call, not for the defect. A call whose callee is an export of a src module of the check's vessel,
 * reached through a cast to `any` or `unknown` (`x as any`, `x as unknown`, `x as unknown as T`, `<any>x`), is refused,
 * `check_asserts_contract_mismatch:cast_callee:<fn>`: on the namespace (`(ns as any).fn(…)`, `(ns as unknown as T)["fn"](…)`),
 * on the member or a named import (`(ns.fn as any)(…)`, `(fn as any)(…)`), or through a local holding one of those or
 * declared `: any` / `: unknown` (`const f: any = ns.fn; f(…)`). A cast on an ARGUMENT, or on a result, is not a callee
 * cast. Static, over the check alone; a caller applies it after contractMismatchRefusal (so a check refused for its
 * contract keeps that reason): the verify of a test_writing compose (judgeTestWritingCheck) does. null = no refusal.
 */
export function castCalleeRefusal(source: string, checkRel: string, reader: SrcReader): { module: string; fn: string; reason: string } | null {
  const ts = loadTs();
  if (!ts) return null;
  const sf = ts.createSourceFile(checkRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { ns, named } = checkBindings(ts, sf);
  const bare = (e: TS.Expression): TS.Expression => { while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression; return e; };
  const erasing = (t: TS.TypeNode): boolean => t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword;
  /** The expression under a chain of casts one of which erases its type (to any / unknown, `as unknown as T`), else null. */
  const erased = (raw: TS.Expression): TS.Expression | null => {
    let e = bare(raw), erases = false;
    while (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) { erases ||= erasing(e.type); e = bare(e.expression); }
    return erases ? e : null;
  };
  /** The module export an expression names: a named import, or a member of a namespace binding. */
  const exportOf = (raw: TS.Expression): { spec: string; fn: string } | null => {
    const e = bare(raw);
    if (ts.isIdentifier(e) && named.has(e.text)) return { spec: named.get(e.text)!.spec, fn: named.get(e.text)!.imported };
    const obj = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? bare(e.expression) : null;
    if (!obj || !ts.isIdentifier(obj) || !ns.has(obj.text)) return null;
    if (ts.isPropertyAccessExpression(e)) return { spec: ns.get(obj.text)!, fn: e.name.text };
    if (!ts.isElementAccessExpression(e)) return null;
    return ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression) ? { spec: ns.get(obj.text)!, fn: e.argumentExpression.text } : null;
  };
  /** A callee reached through an erasing cast: the export it names, or null. */
  const castCallee = (raw: TS.Expression): { spec: string; fn: string } | null => {
    const inner = erased(raw);
    if (inner) return exportOf(inner);
    const e = bare(raw);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const obj = erased(e.expression);
      if (!obj || !ts.isIdentifier(obj) || !ns.has(obj.text)) return null;
      if (ts.isPropertyAccessExpression(e)) return { spec: ns.get(obj.text)!, fn: e.name.text };
      return ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression) ? { spec: ns.get(obj.text)!, fn: e.argumentExpression.text } : null;
    }
    return null;
  };
  /** The declaration of a local `name` in scope at `from`. */
  const declOf = (from: TS.Node, name: string): TS.VariableDeclaration | null => {
    for (let a: TS.Node | undefined = from.parent; a; a = a.parent) {
      if (!ts.isBlock(a) && !ts.isSourceFile(a)) continue;
      for (const s of a.statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d;
    }
    return null;
  };
  let found: { spec: string; fn: string; call: TS.CallExpression } | null = null;
  const visit = (n: TS.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      let hit = castCallee(n.expression);
      const callee = bare(n.expression);
      if (!hit && ts.isIdentifier(callee) && !named.has(callee.text)) {
        const d = declOf(n, callee.text);
        if (d?.initializer) hit = castCallee(d.initializer) ?? (d.type && erasing(d.type) ? exportOf(d.initializer) : null);
      }
      if (hit) found = { ...hit, call: n };
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) return null;
  const { spec, fn, call } = found as { spec: string; fn: string; call: TS.CallExpression };
  const mod = resolveModule(checkRel, spec, reader);
  if (!mod || !mod.rel.startsWith("src/")) return null;
  const msf = ts.createSourceFile(mod.rel, mod.source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(mod.rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const decl = topLevelFunction(ts, msf, fn);
  const params = decl ? decl.parameters.map((p) => p.getText(msf)).join(", ") : null;
  const text = call.getText(sf).replace(/\s+/g, " ").slice(0, 120);
  return { module: mod.rel, fn, reason: `${CONTRACT_MISMATCH_STAGE}:cast_callee:${fn}: the check calls ${fn} from ${mod.rel} through a cast to any / unknown (\`${text}\`), which erases the signature the call must match${params !== null ? ` (${fn} declares (${params.slice(0, 160)}))` : ""}, so a call that does not fit the contract typechecks and its red is not the defect's: call the typed export` };
}

/**
 * A CHECK THAT ASSERTS THE DEFECT'S OWN OUTPUT IS NOT A FALSIFIER (2026-10-24). goal-host 6c6d632's check-supply check
 * expected `toContain("the command produced no result")`: the literal the gap's region returns
 * (`if (r == null) return "the command produced no result";`), the defect itself. It was red at the parent only because
 * it called dispatchFailureReasons, which never reaches that region, with a fixture that function cannot parse (received
 * ["Dispatch failed."]). The verify passed it (three identical assertion reds), and a later runtime rebinding that
 * appends the literal turned it green and closed a child gap on it. Red at the parent is necessary, not sufficient: the
 * verify must also read what the check EXPECTS. Refused, stage ASSERTS_DEFECT_OUTPUT_STAGE (`expects_region_output`), when
 * the gap carries a region (classification_metadata.region, the literal grounding uses) that occurs exactly once in the
 * edit site, and a failing assertion's Expected (bun's printout, a string) EQUALS a string literal the region returns or
 * emits: a literal on the region's text in value position of a return, a throw, an arrow's expression body, or an
 * argument of a console / log / warn / error / emit / write / send / push call (through parentheses, casts,
 * conditionals, ?? / ||, array and object literals and `new`). A negated assertion (`.not.`, read off the failure's error
 * line) asserts the fixed behaviour and is not refused. Whether what the check calls REACHES the region is not judged
 * here: the same-file reachability the arm step uses (gap-check-supply.ts siteRegionSource) is outside the evaluator's
 * import closure.
 * Known limits (accepted): no region on the gap, a region not exactly once in the site, or an Expected that is not a
 * string decides nothing; a template literal is no output literal; an Expected that is only a substring of the region's
 * output is not refused.
 */
export const ASSERTS_DEFECT_OUTPUT_STAGE = "test_writing_check_asserts_defect_output";
const EMIT_CALLEE = /(?:^console\.\w+|(?:^|\.)(?:log|warn|error|emit|write|send|push))$/;
/** The string literals the region returns or emits (see ASSERTS_DEFECT_OUTPUT_STAGE), or null when the region is not exactly once in the site. */
export function regionOutputLiterals(siteSrc: string, siteRel: string, region: string): { start: number; end: number; literals: string[] } | null {
  const ts = loadTs();
  const r = region.trim();
  if (!ts || !r) return null;
  const start = siteSrc.indexOf(r);
  if (start < 0 || siteSrc.indexOf(r, start + r.length) >= 0) return null;
  const end = start + r.length;
  const sf = ts.createSourceFile(siteRel, siteSrc, ts.ScriptTarget.Latest, true, /\.tsx$/.test(siteRel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const literals = new Set<string>();
  const output = (lit: TS.Node): boolean => {
    let n: TS.Node = lit;
    for (let p = n.parent; p; n = p, p = p.parent) {
      if (ts.isReturnStatement(p) || ts.isThrowStatement(p)) return true;
      if (ts.isArrowFunction(p)) return p.body === n;
      if (ts.isCallExpression(p)) return p.expression !== n && EMIT_CALLEE.test(p.expression.getText(sf).replace(/\s+/g, ""));
      if (ts.isConditionalExpression(p)) { if (p.condition === n) return false; continue; }
      if (ts.isBinaryExpression(p)) { const op = p.operatorToken.kind; if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) continue; return false; }
      if (ts.isPropertyAssignment(p)) { if (p.initializer === n) continue; return false; }
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isNewExpression(p)) continue;
      return false;
    }
    return false;
  };
  const visit = (n: TS.Node): void => {
    if (n.getEnd() <= start || n.getStart(sf) >= end) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.getStart(sf) >= start && n.getEnd() <= end && output(n)) literals.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { start, end, literals: [...literals] };
}
/** The verify's refusal of a check that expects its gap region's own output (see ASSERTS_DEFECT_OUTPUT_STAGE). null = no refusal. */
export function assertsDefectOutputRefusal(redReason: unknown, siteRel: string, siteSrc: string, region: string): { cause: "expects_region_output"; reason: string } | null {
  const out = regionOutputLiterals(siteSrc, siteRel, region);
  if (!out) return null;
  const shown = region.trim().replace(/\s+/g, " ").slice(0, 160);
  const rr = (redReason ?? {}) as { compared?: Array<{ name?: unknown; expected?: unknown }>; failures?: Array<{ name?: unknown; error?: unknown }> };
  for (const c of Array.isArray(rr.compared) ? rr.compared : []) {
    let expected: unknown = null;
    try { expected = typeof c.expected === "string" && c.expected.startsWith("\"") ? JSON.parse(c.expected) : null; } catch { expected = null; }
    if (typeof expected !== "string" || !out.literals.includes(expected)) continue;
    const err = (Array.isArray(rr.failures) ? rr.failures : []).find((f) => f.name === c.name)?.error;
    if (typeof err === "string" && /\)\.not\./.test(err)) continue;
    return { cause: "expects_region_output", reason: `${ASSERTS_DEFECT_OUTPUT_STAGE}:expects_region_output: the failing assertion of "${String(c.name ?? "").slice(0, 120)}" expects ${JSON.stringify(expected).slice(0, 160)}, the literal the gap's region in ${siteRel} returns or emits (\`${shown}\`): the check asserts the defect's own output, so a change that produces the defect turns it green; assert the fixed behaviour instead` };
  }
  return null;
}

/** W1: how many times the verify runs the check (every run must be the same assertion red). */
export const TEST_WRITING_CHECK_RUNS = 3;

export type TestWritingJudgement = {
  ok: boolean;
  stage: null | "test_writing_check_not_red" | "test_writing_check_wrong_reason" | "test_writing_check_flaky" | "test_writing_check_misses_edit_site" | "test_writing_check_reads_literals_only" | "edit_site_not_importable" | typeof EDIT_SITE_IS_OWN_CHECK | typeof MISSING_EXPORT_STAGE | typeof CONTRACT_MISMATCH_STAGE | typeof ASSERTS_DEFECT_OUTPUT_STAGE;
  cause?: string;
  reason: string;
  /** Set when the missing-export guard could not run (EXPORT_GUARD_UNAVAILABLE): it decided nothing. */
  guard_decided_nothing?: string;
  /** Set on a MISSING_EXPORT_STAGE refusal: the refused module's exported surface (exportedSurface), for the repair. */
  exported_surface?: { module: string; text: string };
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
 * tree, so it is refused here before it lands; 7b54fc7's AuthCache check passed this verify), assert no contract its
 * target lacks (contractMismatchRefusal, applied at the arm step too) and call no target through a cast that erases its
 * signature (castCalleeRefusal, after it), and, when the gap carries a region (`region`, classification_metadata.region),
 * not expect the region's own output (assertsDefectOutputRefusal). The static checks run
 * after the runs so every earlier stage keeps its verdict (a named import of a missing export still fails to LOAD and is
 * wrong_reason). ok only then.
 */
export async function judgeTestWritingCheck(input: { gapId: string; vesselRoot: string; editSite: unknown; region?: unknown; run: (checkRel: string) => Promise<string>; runs?: number }): Promise<TestWritingJudgement> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { checkRunVerdict, classifyCheckRun, testWritingRunsVerdict } = await import("./retry-evidence.js");
  const checkRel = checkSupplyCheckPath(input.gapId);
  const abs = `${input.vesselRoot}/${checkRel}`;
  const out = (stage: TestWritingJudgement["stage"], reason: string, extra: Partial<TestWritingJudgement> = {}): TestWritingJudgement => ({ ok: stage === null, stage, reason, check_file: checkRel, edit_site: vesselRelativeEditSite(input.editSite), runs: [], ...extra });
  let source: string | null = null;
  try { source = existsSync(abs) ? readFileSync(abs, "utf8") : null; } catch { source = null; }
  if (source === null) return out("test_writing_check_not_red", `the check file ${checkRel} was not written in this vessel: the supply's goal asks for exactly that file`);
  const site = await checkImportsEditSite(source, checkRel, input.editSite, (rel) => existsSync(`${input.vesselRoot}/${rel}`), srcReaderAt(input.vesselRoot));
  if (!site.ok) {
    if (site.stage === EDIT_SITE_IS_OWN_CHECK) console.log(`[check-supply] refused ${input.gapId}: ${EDIT_SITE_IS_OWN_CHECK} (${site.edit_site})`);
    return out(site.stage, site.reason, { edit_site: site.edit_site });
  }
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
  if (missing) {
    const surface = exportedSurface(missing.module, srcReaderAt(input.vesselRoot));
    return out(MISSING_EXPORT_STAGE, missing.reason, { edit_site: site.edit_site, runs, ...(surface ? { exported_surface: { module: missing.module, text: surface } } : {}) });
  }
  // The runs agree (W1), so the first one's compared values stand for all; 333be5f passed this verify before.
  const mismatch = contractMismatchRefusal(source, checkRel, classifyCheckRun(raws[0]!), srcReaderAt(input.vesselRoot));
  if (mismatch) return out(CONTRACT_MISMATCH_STAGE, mismatch.reason, { edit_site: site.edit_site, runs });
  const cast = castCalleeRefusal(source, checkRel, srcReaderAt(input.vesselRoot));
  if (cast) return out(CONTRACT_MISMATCH_STAGE, cast.reason, { edit_site: site.edit_site, runs });
  const region = typeof input.region === "string" ? input.region : "";
  const siteSrc = region.trim() ? srcReaderAt(input.vesselRoot).read(site.edit_site) : null;
  const defect = siteSrc !== null ? assertsDefectOutputRefusal(classifyCheckRun(raws[0]!), site.edit_site, siteSrc, region) : null;
  if (defect) return out(ASSERTS_DEFECT_OUTPUT_STAGE, defect.reason, { edit_site: site.edit_site, runs, cause: defect.cause });
  const unguarded = exportGuardUnavailable();
  return out(null, `the check is the same assertion red on ${n} runs and imports ${site.edit_site}`, { edit_site: site.edit_site, runs, ...(unguarded ? { guard_decided_nothing: unguarded } : {}) });
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
