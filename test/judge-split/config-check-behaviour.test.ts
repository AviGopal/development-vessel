// A CHECK FOR A CONFIG EDIT SITE MUST RUN THE CONSUMER, NOT READ THE LITERAL.
//
// The class: a gap whose edit site is configuration (an activity seed template under src/seed/, or any module exporting
// an ActivityTemplate) was armed with a check that imported the template and asserted one of its task config literals.
// The fix that set exactly that literal then passed the check, verified and settled, while doing nothing: the seed carried
// no metadata.seed_version, so seed delivery never re-uploads it on a populated catalogue; and a mode flag on an
// activity's ONLY task can make its resolver return early (the task stops doing what it did). Only a check that RUNS the
// template's consumer (its task resolver, with the template's config, on a fixture) measures such a gap.
//
// FIXTURE (synthetic): a one-task seed template whose task resolver is demo_sweep, the resolver module that declares its
// pointer type, a check that only reads the template's config literal, a check that calls the resolver (control), and a
// landing whose diff only changes that config line.
//
// MUST-FAILS:
//   (a) SUPPLY GOAL: for a seed edit site the check-supply goal names the consumer resolver and its module, and asks for
//       the prior-behaviour assertion first and the new behaviour second (one test); a non-config site keeps today's goal.
//   (b) ADMISSION: checkImportsEditSite (the rule the arm step and the test-writing verify share) REFUSES the literal-only
//       check for the seed site (test_writing_check_reads_literals_only), and refuses a config site when no source reader
//       is given (fail closed); it ADMITS the behavioural check (control). judgeTestWritingCheck (the verify) refuses
//       the literal-only check before running it.
//   (c) SETTLEMENT: the real cutover stamp for a gap with a behavioural (class-2) check derives no literal from the
//       landing's diff (git is never asked for it) and its journal line names the gap's own check as the predicate; a
//       gap with no predicate still gets the removed line as its durability sentinel (control: unchanged).
//   (d) RULE: seedDeliveryRefusals refuses a task-config edit without a seed_version bump and admits it with one.
// MUTANTS (seen red): (a) checkSupplyGoal ignoring its reader; (b) configSiteCheckRefusal returning null; (c) the stamp
// deriving for every gap; (d) seedDeliveryRefusals ignoring seed_version.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as supplyMod from "../../src/resolvers/gap-check-supply.js";
import * as admissionMod from "../../src/resolvers/check-supply-admission.js";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";

type Row = Record<string, unknown>;
type Reader = { read: (rel: string) => string | null; list: (relDir: string) => string[] };
const supply = supplyMod as unknown as { checkSupplyGoal: (v: string, f: string, s: string, site?: string | null, reader?: Reader) => string };
const adm = admissionMod as unknown as {
  checkImportsEditSite: (src: string, rel: string, site: unknown, exists: (rel: string) => boolean, reader?: Reader) => Promise<{ ok: boolean; stage?: string; reason?: string }>;
  judgeTestWritingCheck: (i: { gapId: string; vesselRoot: string; editSite: unknown; run: (rel: string) => Promise<string>; runs?: number }) => Promise<{ ok: boolean; stage: string | null }>;
  checkSupplyCheckPath: (id: string) => string;
};
const cut = cutoverMod as unknown as {
  __setOwnCheckDepsForTests: (d: Record<string, unknown> | null) => void;
  stampPendingLand: (a: Record<string, unknown>) => Promise<void>;
};

const VESSEL = "demo-vessel";
const SITE = "src/seed/demo-sweep-tick.ts";
const CONSUMER = "src/resolvers/demo-sweep.ts";
const CONFIG_LINE = '      config: { type: "demo_sweep", staleHours: 48, autoClose: true },';
const SEED_SRC = [
  'import type { ActivityTemplate } from "@avigopal/ias-executor-ts";',
  "export const DEMO_SWEEP_TICK_TEMPLATE: ActivityTemplate = {",
  '  id: "demo-vessel:demo-sweep-tick",',
  '  name: "demo-sweep-tick",',
  "  tasks: [",
  "    {",
  '      id: "run_demo_sweep",',
  '      resolver: "demo_sweep",',
  CONFIG_LINE,
  "    },",
  "  ],",
  "};",
  "",
].join("\n");
const CONSUMER_SRC = [
  "export interface DemoSweepPointer {",
  '  type: "demo_sweep";',
  "  staleHours?: number;",
  "  autoClose?: boolean;",
  "  auditOnly?: boolean;",
  "}",
  "export const DEMO_SWEEP_DEFAULT_HOURS = 48;",
  "export async function resolveDemoSweep(p: DemoSweepPointer): Promise<{ closed: number; audited: boolean }> {",
  "  return { closed: p.autoClose ? 1 : 0, audited: p.auditOnly === true };",
  "}",
  "",
].join("\n");
// Another module that CALLS the resolver with an object literal of its type: not its consumer module.
const CALLER_SRC = 'export const FAMILIES = { sweep: { type: "demo_sweep", autoClose: true } };\n';
const TREE: Record<string, string> = { [SITE]: SEED_SRC, [CONSUMER]: CONSUMER_SRC, "src/resolvers/rhythm-families.ts": CALLER_SRC, "src/compute.ts": "export function compute(x: number): number { return x + 1; }\n" };
const reader: Reader = {
  read: (rel) => TREE[rel] ?? null,
  list: (dir) => Object.keys(TREE).filter((k) => k.startsWith(`${dir.replace(/\/+$/, "")}/`) && !k.slice(dir.length + 1).includes("/")),
};
const exists = (rel: string): boolean => rel in TREE;

const GAP_ID = "demo-sweep-never-audits";
const CHECK_REL = `test/checks/${GAP_ID}.check.ts`;
const LITERAL_CHECK = [
  'import { describe, expect, test } from "bun:test";',
  'import * as site from "../../src/seed/demo-sweep-tick.js";',
  'describe("demo sweep", () => {',
  '  test("the tick audits", () => {',
  "    const task = (site as any).DEMO_SWEEP_TICK_TEMPLATE.tasks[0];",
  "    expect(task.config.auditOnly).toBe(true);",
  "  });",
  "});",
  "",
].join("\n");
const BEHAVIOUR_CHECK = [
  'import { describe, expect, test } from "bun:test";',
  'import * as site from "../../src/seed/demo-sweep-tick.js";',
  'import * as consumer from "../../src/resolvers/demo-sweep.js";',
  'describe("demo sweep", () => {',
  '  test("the tick audits and still closes", async () => {',
  "    const cfg = (site as any).DEMO_SWEEP_TICK_TEMPLATE.tasks[0].config;",
  "    const r = await consumer.resolveDemoSweep(cfg);",
  "    expect(r.closed).toBe(1);",
  "    expect(r.audited).toBe(true);",
  "  });",
  "});",
  "",
].join("\n");

describe("(a) the supply goal for a config edit site asks for the consumer's behaviour", () => {
  const summary = `the sweep tick in repos/${VESSEL}/${SITE} never runs in audit-only mode`;
  it("names the consumer resolver, its module, and the prior-behaviour assertion before the new one", () => {
    const goal = supply.checkSupplyGoal(VESSEL, CHECK_REL, summary, `repos/${VESSEL}/${SITE}`, reader);
    expect(goal).toContain(`repos/${VESSEL}/${CHECK_REL}`);
    expect(goal).toContain("demo_sweep");
    expect(goal).toContain("../../src/resolvers/demo-sweep");
    expect(goal).toContain("ONE test");
    const prior = goal.indexOf("FIRST that the behaviour the resolver had before");
    const next = goal.indexOf("THEN the new behaviour");
    expect(prior).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(prior);
    expect(goal).not.toContain("and assert on it");
  });
  it("CONTROL: a non-config edit site keeps the namespace-import goal", () => {
    const goal = supply.checkSupplyGoal(VESSEL, CHECK_REL, "compute adds 1", `repos/${VESSEL}/src/compute.ts`, reader);
    expect(goal).toContain('import * as mod from "../../src/compute"');
    expect(goal).not.toContain("FIRST that the behaviour");
  });
});

describe("(b) admission refuses a literal-only check for a config edit site", () => {
  it("REFUSES the check that only reads the template's config literal", async () => {
    const r = await adm.checkImportsEditSite(LITERAL_CHECK, CHECK_REL, `repos/${VESSEL}/${SITE}`, exists, reader);
    expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "test_writing_check_reads_literals_only" });
  });
  it("REFUSES the literal-only check when the gap names no edit site and the check imports the seed", async () => {
    const r = await adm.checkImportsEditSite(LITERAL_CHECK, CHECK_REL, null, exists, reader);
    expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "test_writing_check_reads_literals_only" });
  });
  it("REFUSES a config edit site when no source reader is given (fail closed)", async () => {
    const r = await adm.checkImportsEditSite(BEHAVIOUR_CHECK, CHECK_REL, `repos/${VESSEL}/${SITE}`, exists);
    expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "test_writing_check_reads_literals_only" });
  });
  it("CONTROL: ADMITS the check that runs the consumer resolver with the template's config", async () => {
    const r = await adm.checkImportsEditSite(BEHAVIOUR_CHECK, CHECK_REL, `repos/${VESSEL}/${SITE}`, exists, reader);
    expect(r.ok).toBe(true);
  });
  it("CONTROL: a non-config edit site is judged as before (import only)", async () => {
    const src = 'import { expect, test } from "bun:test";\nimport * as mod from "../../src/compute.js";\ntest("adds two", () => { expect(mod.compute(1)).toBe(3); });\n';
    expect((await adm.checkImportsEditSite(src, CHECK_REL, `repos/${VESSEL}/src/compute.ts`, exists)).ok).toBe(true);
  });

  describe("the test-writing verify (judgeTestWritingCheck) on a fixture vessel", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "config-check-verify-"));
      for (const [rel, text] of Object.entries(TREE)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); }
    });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const writeCheck = (src: string): void => {
      const rel = adm.checkSupplyCheckPath(GAP_ID);
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), src);
    };
    const RED = "error: expect(received).toBe(expected)\n\nExpected: true\nReceived: false\n\n(fail) demo sweep > the tick audits and still closes\n 0 pass\n 1 fail\n";
    it("REFUSES the literal-only check before running it", async () => {
      writeCheck(LITERAL_CHECK.replace("the tick audits", "the tick audits and still closes"));
      let ran = 0;
      const j = await adm.judgeTestWritingCheck({ gapId: GAP_ID, vesselRoot: root, editSite: `repos/${VESSEL}/${SITE}`, runs: 1, run: async () => { ran++; return RED; } });
      expect({ ok: j.ok, stage: j.stage, ran }).toEqual({ ok: false, stage: "test_writing_check_reads_literals_only", ran: 0 });
    });
    it("CONTROL: the behavioural check reaches the run", async () => {
      writeCheck(BEHAVIOUR_CHECK);
      let ran = 0;
      const j = await adm.judgeTestWritingCheck({ gapId: GAP_ID, vesselRoot: root, editSite: `repos/${VESSEL}/${SITE}`, runs: 1, run: async () => { ran++; return RED; } });
      expect(ran).toBe(1);
      expect(j.stage).not.toBe("test_writing_check_reads_literals_only");
    });
  });
});

describe("(c) the cutover stamp never takes a line of the diff as the settlement predicate of a gap with a check", () => {
  let dir: string;
  let repo: string;
  let gitLog: string;
  let gitCmd: string;
  let writes: Row[];
  let logs: string[];
  const realLog = console.log;
  const savedClone = process.env["MITOSIS_PUSH_CLONE_DIR"];
  const git = (args: string[]): string => {
    const p = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  let sha = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-check-stamp-"));
    repo = join(dir, VESSEL);
    mkdirSync(join(repo, "src/seed"), { recursive: true });
    writeFileSync(join(repo, SITE), SEED_SRC);
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
    // The landing: its diff only changes the task's config literal.
    writeFileSync(join(repo, SITE), SEED_SRC.replace(CONFIG_LINE, CONFIG_LINE.replace("autoClose: true }", "autoClose: true, auditOnly: true }")));
    git(["commit", "-q", "-am", "set the flag"]);
    sha = git(["rev-parse", "HEAD"]);
    // A recording git: every invocation's arguments, then the real git.
    gitLog = join(dir, "git-calls.txt");
    gitCmd = join(dir, "git-rec");
    writeFileSync(gitCmd, `#!/bin/sh\necho "$*" >> '${gitLog}'\nexec git "$@"\n`);
    chmodSync(gitCmd, 0o755);
    writes = []; logs = [];
    delete process.env["MITOSIS_PUSH_CLONE_DIR"];
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  });
  afterEach(() => {
    console.log = realLog;
    cut.__setOwnCheckDepsForTests(null);
    if (savedClone === undefined) delete process.env["MITOSIS_PUSH_CLONE_DIR"]; else process.env["MITOSIS_PUSH_CLONE_DIR"] = savedClone;
    rmSync(dir, { recursive: true, force: true });
  });
  async function stamp(row: Row): Promise<Row> {
    cut.__setOwnCheckDepsForTests({
      readGap: async () => ({ shape: "substrateGap", body: { gaps: [row] } }),
      writeGap: async (p: Row) => { writes.push(p); return { shape: "substrateGapWriteResult", body: { id: row.id, action: "updated" } }; },
      ask: async () => ({ shape: "uiQuestion_write", body: { ok: true } }),
    });
    await cut.stampPendingLand({ gapId: row.id, newSha: sha, appliedAt: "2026-10-12T00:00:00.000Z", vessel_name: VESSEL, hostRepoRoot: repo, gitCmd, landedUnverifiedReason: null, stagedFiles: [SITE] });
    const w = writes.at(-1) as { gap?: { classification_metadata?: Row } } | undefined;
    return (w?.gap?.classification_metadata ?? {}) as Row;
  }
  const gitShowCalls = (): number => (existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter((l) => l.startsWith("show ")).length : 0);
  const stampLine = (): string => logs.find((l) => l.includes("pending-land stamp gap=")) ?? "";

  it("a gap with a behavioural check: nothing derived from the diff, and the stamp names the check", async () => {
    const check = adm.checkSupplyCheckPath(GAP_ID);
    const meta = await stamp({
      id: GAP_ID, status: "open", category: "missing_capability", source: "substrate_detected", summary: "the demo sweep never audits", detected_at: "2026-10-01T00:00:00.000Z",
      classification_metadata: { falsifier: "class2", edit_site: `repos/${VESSEL}/${SITE}`, evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: check }, zero_field: "requested_not_passing" } },
    });
    expect(meta["pending_outcome_verification"]).toBe(sha);
    expect(meta["predicate_source"]).not.toBe("removed_line_of_landing_commit");
    expect(gitShowCalls()).toBe(0);
    expect(stampLine()).toContain(`predicate=own_check test_suite ${check}`);
    expect(stampLine()).not.toContain("demo_sweep");
  });
  it("CONTROL: a gap with no predicate still gets the removed line as its durability sentinel", async () => {
    const meta = await stamp({
      id: "demo-no-predicate", status: "open", category: "missing_capability", source: "substrate_detected", summary: "the demo sweep never audits", detected_at: "2026-10-01T00:00:00.000Z",
      classification_metadata: { edit_site: `repos/${VESSEL}/${SITE}` },
    });
    expect(gitShowCalls()).toBe(1);
    expect(meta["predicate_source"]).toBe("removed_line_of_landing_commit");
    expect(meta["hardcoded_url"]).toBe(CONFIG_LINE.trim());
  });
  it("CONTROL: a literal-only gap still derives (unchanged) and its own literal is kept", async () => {
    const meta = await stamp({
      id: "demo-literal", status: "open", category: "missing_capability", source: "substrate_detected", summary: "the demo sweep never audits", detected_at: "2026-10-01T00:00:00.000Z",
      classification_metadata: { falsifier: "class1", edit_site: `repos/${VESSEL}/${SITE}`, expected_literal: "auditOnly: true" },
    });
    expect(gitShowCalls()).toBe(1);
    expect(meta["expected_literal"]).toBe("auditOnly: true");
    expect(meta["predicate_source"]).not.toBe("removed_line_of_landing_commit");
  });
});

describe("(d) the seed-delivery rule", () => {
  const BUMPED = SEED_SRC.replace(CONFIG_LINE, CONFIG_LINE.replace("autoClose: true }", "autoClose: true, auditOnly: true }")).replace('  name: "demo-sweep-tick",', '  name: "demo-sweep-tick",\n  metadata: { seed_version: 1 },');
  const UNBUMPED = SEED_SRC.replace(CONFIG_LINE, CONFIG_LINE.replace("autoClose: true }", "autoClose: true, auditOnly: true }"));
  async function rule(): Promise<{ seedDeliveryRefusals?: (e: Array<{ path: string; pre: string; post: string }>) => unknown[]; seedDeliveryReason?: (r: unknown[]) => string }> {
    try { return await import("../../src/seed-delivery-verify.js"); } catch { return {}; }
  }
  it("REFUSES a task-config edit without a seed_version bump, with the delivery reason", async () => {
    const m = await rule();
    expect(typeof m.seedDeliveryRefusals).toBe("function");
    const r = m.seedDeliveryRefusals!([{ path: `repos/${VESSEL}/${SITE}`, pre: SEED_SRC, post: UNBUMPED }]);
    expect(r).toEqual([{ path: SITE, template: "DEMO_SWEEP_TICK_TEMPLATE", before: 0, after: 0 }]);
    expect(m.seedDeliveryReason!(r)).toContain("cannot reach the runtime: seed delivery re-uploads only on a seed_version bump");
  });
  it("CONTROL: admits the same edit with a bump, an edit that leaves tasks alone, and a file outside src/seed/", async () => {
    const m = await rule();
    expect(typeof m.seedDeliveryRefusals).toBe("function");
    expect(m.seedDeliveryRefusals!([{ path: SITE, pre: SEED_SRC, post: BUMPED }])).toEqual([]);
    expect(m.seedDeliveryRefusals!([{ path: SITE, pre: SEED_SRC, post: SEED_SRC.replace('name: "demo-sweep-tick"', 'name: "demo-sweep-tick-2"') }])).toEqual([]);
    expect(m.seedDeliveryRefusals!([{ path: "src/resolvers/demo-template.ts", pre: SEED_SRC, post: UNBUMPED }])).toEqual([]);
  });
  it("REFUSES a bump that does not rise (equal or lower)", async () => {
    const m = await rule();
    expect(typeof m.seedDeliveryRefusals).toBe("function");
    const pre = SEED_SRC.replace('  name: "demo-sweep-tick",', '  name: "demo-sweep-tick",\n  metadata: { seed_version: 2 },');
    const post = UNBUMPED.replace('  name: "demo-sweep-tick",', '  name: "demo-sweep-tick",\n  metadata: { seed_version: 2 },');
    expect(m.seedDeliveryRefusals!([{ path: SITE, pre, post }])).toEqual([{ path: SITE, template: "DEMO_SWEEP_TICK_TEMPLATE", before: 2, after: 2 }]);
  });
});
