// gap_falsify v2's STANDING measurement: a selfFactSpec row (data, read at use time from origin/dev:
// scripts/substrate/self-facts.json) whose instrument, gap_birth_verdicts, measures on every tick
//   (a) the birth-verdict distribution the write seam produced over the row's window,
//   (b) the falsifier supply backlog against the row's recorded baseline (it must fall or hold),
//   (c) a must-fail control: a planted check KNOWN TO PASS on the current tree, run through the seam's own birth
//       evaluator (takeBirthVerdict), must come back 'absent'. If the evaluator cannot tell, the row reads blind
//       and the run files a gap about itself (self_fact_reconcile's existing canary-not-found pattern).
// Driven through the real resolver, with the rows in a real git repo, the store injected, and the judge reached
// through globalThis.fetch standing in for the vessel's own test_suite resolve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gf2-selffact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const { resolveSelfFactReconcile, __setGapBirthDepsForTests } = await import("../../src/resolvers/self-fact-reconcile.js");
const { __setBirthJudgeForTests, __settleBirthEvaluationsForTests, class2PredicateKey } = await import("../../src/resolvers/substrate-gap.js");

const SUPER = join(ROOT, "super");
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const PASSING_AT_HEAD = "no predicate at all is \"none\"";
const MUST_FAIL_CHECK = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/resolvers/substrate-gap-falsifier.test.ts", only_tests: [PASSING_AT_HEAD], timeout_ms: 120000 }, zero_field: "requested_not_passing" } };
const git = (...args: string[]): void => {
  const p = Bun.spawnSync(["git", "-C", SUPER, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
};
function writeRows(row: Record<string, unknown>): void {
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [row] }));
  git("add", "."); git("commit", "-q", "--allow-empty", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
}
const ROW = { id: "gap_birth_verdicts", instrument: "gap_birth_verdicts", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/substrate-gap.ts", must_fail: "canary", window_hours: 1, max: 2, must_fail_check: MUST_FAIL_CHECK };

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const c2 = { evidence_resolve: { shape: "x_report", zero_field: "n" } };
const stamped = (id: string, verdict: string, msAgo: number) => ({ id, status: "open", created_at: iso(msAgo), classification_metadata: { ...c2, falsifier: "class2", predicate_birth_verdict: verdict, predicate_birth_at: iso(msAgo), predicate_birth_key: class2PredicateKey(c2) } });
const none = (id: string, meta: Record<string, unknown> = {}) => ({ id, status: "open", created_at: iso(86_400_000), classification_metadata: { falsifier: "none", edit_site: "repos/v/src/a.ts", ...meta } });
const STORE: Array<Record<string, unknown>> = [
  stamped("s-present-1", "present", 60_000), stamped("s-present-2", "present", 120_000), stamped("s-absent", "absent", 60_000), stamped("s-unknown", "unknown", 60_000),
  stamped("s-old-absent", "absent", 5 * 3600_000), // outside the 1 h window
  none("b-1"), none("b-2"), none("b-3"),                          // the supply backlog: 3
  none("b-lane", { edit_site: "repos/lane-core/src/a.ts" }),     // inside the autonomy scope
  none("b-missing", { edit_site: "repos/v/src/missing.ts" }),    // edit site is not an existing file
  none("b-held", { operator_hold: true }),
  none("b-1-step-1"), none("recommit-b-1"), none("b-1-narrowed"),
  { ...none("b-closed"), status: "closed" },
];
let testSuiteMode: "real" | "broken" | "http500" | "timeout" | "unreachable" = "real";

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(SUPER, { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const p = (init?.body ? JSON.parse(String(init.body)) : {})?.impulse?.pointer;
    // The planted check's test passes at HEAD: a working test_suite resolve reports 0 not passing.
    if (p?.type === "test_suite") {
      // The three ways the control can fail to RUN: no result, a timeout, a transport/spawn error.
      if (testSuiteMode === "http500") return new Response("resolver crashed", { status: 500 });
      if (testSuiteMode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
      if (testSuiteMode === "unreachable") throw new TypeError("fetch failed: connect ECONNREFUSED");
      return Response.json({ shape: "test_suite", body: { ran: true, requested_not_passing: testSuiteMode === "real" ? 0 : 1 } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  __setGapBirthDepsForTests({ readGaps: async () => STORE, inAutonomyScope: async () => (s: string) => s.includes("lane-core"), siteReadable: (s: string) => !s.includes("missing") });
});
afterAll(async () => {
  await __settleBirthEvaluationsForTests();
  globalThis.fetch = originalFetch;
  __setGapBirthDepsForTests(null);
  __setBirthJudgeForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

type Report = { body: { facts_checked: Array<{ fact: string; note: string; divergences: number }>; divergences: Array<{ key: string }>; blind_rows: string[]; canary_found: boolean; observed: boolean; self_gap_filed: boolean; rows_checked: string[] } };
const run = async (pointer: Record<string, unknown> = {}) => (await resolveSelfFactReconcile({ type: "self_fact_reconcile", ...pointer } as never)) as unknown as Report;

describe("self_fact_reconcile row gap_birth_verdicts", () => {
  it("is registered as DATA: the row read from origin/dev runs the instrument; with no row it does not run", async () => {
    writeRows({ ...ROW, id: "some_other_row", instrument: "lane_coverage", profiles: ["nowhere"] });
    expect((await run({ file_gaps: false })).body.rows_checked).not.toContain("gap_birth_verdicts");
    writeRows(ROW);
    expect((await run({ file_gaps: false })).body.rows_checked).toEqual(["gap_birth_verdicts"]);
  });

  it("(a) reports the birth-verdict distribution over its window and (b) the supply backlog, from the store", async () => {
    writeRows({ ...ROW, max: 3 });
    const r = await run({ file_gaps: false });
    const note = r.body.facts_checked.find((f) => f.fact === "gap_birth_verdicts")!.note;
    expect(note).toContain("present=2 absent=1 unknown=1 pending=0");
    expect(note).toContain("supply backlog=3 (baseline 3)");
    expect(r.body.divergences).toEqual([]); // backlog held at its baseline
    expect(r.body.observed).toBe(true);
  });

  it("(b) a backlog that rose above its recorded baseline is a divergence", async () => {
    writeRows({ ...ROW, max: 2 });
    const r = await run({ file_gaps: false });
    expect(r.body.divergences.map((d) => d.key)).toEqual(["supply-backlog-rose"]);
  });

  it("(a) class-2 gaps born in the window with no birth verdict mean the evaluator is not running", async () => {
    writeRows({ ...ROW, max: 3 });
    STORE.push({ id: "s-unstamped", status: "open", created_at: iso(60_000), classification_metadata: { ...c2, falsifier: "class2" } });
    try {
      const r = await run({ file_gaps: false });
      expect(r.body.divergences.map((d) => d.key)).toEqual(["birth-evaluation-not-running"]);
    } finally { STORE.pop(); }
  });

  it("(a) a verdict left pending for over an hour is a divergence, whatever the window", async () => {
    writeRows({ ...ROW, max: 3, window_hours: 24 });
    STORE.push(stamped("s-stuck", "pending", 2 * 3600_000));
    try {
      const r = await run({ file_gaps: false });
      expect(r.body.divergences.map((d) => d.key)).toEqual(["birth-evaluation-not-running"]);
    } finally { STORE.pop(); }
  });

  it("(c) the must-fail control: the planted inverted check is stamped absent by the birth evaluator, so the row sees", async () => {
    writeRows({ ...ROW, max: 3 });
    testSuiteMode = "real";
    const r = await run();
    expect(r.body.canary_found).toBe(true);
    expect(r.body.blind_rows).toEqual([]);
    expect(r.body.self_gap_filed).toBe(false);
    expect(r.body.facts_checked[0]!.note).toContain("must-fail control=absent");
  });

  it("(c) an evaluator that stamps everything present fails the row: blind, and a gap about itself is filed", async () => {
    writeRows({ ...ROW, max: 3 });
    __setBirthJudgeForTests(async () => "present");
    try {
      const r = await run();
      expect(r.body.canary_found).toBe(false);
      expect(r.body.blind_rows).toEqual(["gap_birth_verdicts"]);
      expect(r.body.self_gap_filed).toBe(true);
      expect(r.body.observed).toBe(false);
    } finally { __setBirthJudgeForTests(null); }
  });

  it("(c) a test_suite resolve that cannot see the passing test (reports it not passing) fails the row too", async () => {
    writeRows({ ...ROW, max: 3 });
    testSuiteMode = "broken";
    try {
      const r = await run();
      expect(r.body.blind_rows).toEqual(["gap_birth_verdicts"]);
    } finally { testSuiteMode = "real"; }
  });
});

describe("qa R1/R2 on gap_birth_verdicts", () => {
  it("(R1) an unknown birth verdict not re-taken for over 6 h means evaluation is not running; a tree-moved one does not count", async () => {
    writeRows({ ...ROW, max: 3, window_hours: 24 });
    STORE.push(stamped("s-unknown-5h", "unknown", 5 * 3600_000));
    STORE.push({ ...stamped("s-unknown-moved-9h", "unknown", 9 * 3600_000), classification_metadata: { ...stamped("x", "unknown", 9 * 3600_000).classification_metadata, predicate_birth_tree_moved: true } });
    try {
      const clean = await run({ file_gaps: false });
      expect(clean.body.divergences).toEqual([]);
      STORE.push(stamped("s-unknown-7h", "unknown", 7 * 3600_000));
      try {
        const r = await run({ file_gaps: false });
        expect(r.body.divergences.map((d) => d.key)).toEqual(["birth-evaluation-not-running"]);
        expect(r.body.facts_checked[0]!.note).toContain("unknown_stale=1");
        expect(r.body.facts_checked[0]!.note).toContain("unknown_tree_moved=1 (oldest 9h)");
      } finally { STORE.pop(); }
    } finally { STORE.pop(); STORE.pop(); }
  });

  it("(a) absent is split by tree: eval_tree_unread counts EXACTLY the absents with no sha readable at all", async () => {
    writeRows({ ...ROW, max: 3 });
    const withShas = (id: string, shas: Record<string, string>) => ({ ...stamped(id, "absent", 60_000), classification_metadata: { ...stamped(id, "absent", 60_000).classification_metadata, ...shas } });
    // The STORE's own s-absent carries no sha at all: it is the one neither-sha-readable absent.
    STORE.push(withShas("s-absent-same", { predicate_birth_sha: "abcdef1", predicate_birth_detected_sha: "abcdef1", predicate_birth_queued_sha: "abcdef1" }));
    STORE.push(withShas("s-absent-queued", { predicate_birth_sha: "abcdef2", predicate_birth_queued_sha: "abcdef2" }));
    STORE.push(withShas("s-absent-queued-only", { predicate_birth_queued_sha: "abcdef3" }));
    try {
      const note = (await run({ file_gaps: false })).body.facts_checked[0]!.note;
      expect(note).toContain("absent=4");
      expect(note).toContain("absent_same_tree=1 absent_detection_unknown=2 absent_eval_tree_unread=1");
    } finally { STORE.splice(STORE.length - 3, 3); }
  });

  // R2: the must-fail control has three outcomes. absent = healthy, present = blind, did not run = UNOBSERVED.
  it("(R2) control reads absent: healthy (canary found, nothing blind or unobserved)", async () => {
    writeRows({ ...ROW, max: 3 });
    testSuiteMode = "real";
    const r = await run();
    expect(r.body.canary_found).toBe(true);
    expect(r.body.blind_rows).toEqual([]);
    expect((r.body as unknown as { unobserved_rows: string[] }).unobserved_rows).toEqual([]);
    expect(r.body.observed).toBe(true);
  });

  it("(R2) control reads present: blind, and the run files a gap about itself", async () => {
    writeRows({ ...ROW, max: 3 });
    testSuiteMode = "broken";
    try {
      const r = await run();
      expect(r.body.blind_rows).toEqual(["gap_birth_verdicts"]);
      expect((r.body as unknown as { unobserved_rows: string[] }).unobserved_rows).toEqual([]);
      expect(r.body.self_gap_filed).toBe(true);
    } finally { testSuiteMode = "real"; }
  });

  for (const mode of ["http500", "timeout", "unreachable"] as const) {
    it(`(R2) control did not run (${mode}): canary unobserved, never blind and never healthy`, async () => {
      writeRows({ ...ROW, max: 3 });
      testSuiteMode = mode;
      try {
        const r = await run();
        expect((r.body as unknown as { unobserved_rows: string[] }).unobserved_rows).toEqual(["gap_birth_verdicts"]);
        expect(r.body.blind_rows).toEqual([]);
        expect(r.body.observed).toBe(false);
        expect(r.body.self_gap_filed).toBe(false);
        expect(r.body.facts_checked[0]!.note).toContain("canary unobserved");
      } finally { testSuiteMode = "real"; }
    });
  }

  it("(R2) control did not run (the evaluator itself threw, e.g. a spawn error): canary unobserved", async () => {
    writeRows({ ...ROW, max: 3 });
    __setBirthJudgeForTests(async () => { throw new Error("spawn bun ENOENT"); });
    try {
      const r = await run();
      expect((r.body as unknown as { unobserved_rows: string[] }).unobserved_rows).toEqual(["gap_birth_verdicts"]);
      expect(r.body.blind_rows).toEqual([]);
      expect(r.body.observed).toBe(false);
    } finally { __setBirthJudgeForTests(null); }
  });
});

describe("qa C3' refinement 2: the parked queue of tree-moved unknowns", () => {
  const moved = (id: string, ago: number) => ({ ...stamped(id, "unknown", ago), classification_metadata: { ...stamped(id, "unknown", ago).classification_metadata, predicate_birth_tree_moved: true } });
  it("5 parked, all younger than 24 h: no divergence; a 6th: unknown-tree-moved-parked", async () => {
    writeRows({ ...ROW, max: 3 });
    for (let i = 0; i < 5; i++) STORE.push(moved(`s-park-${i}`, 3600_000));
    try {
      expect((await run({ file_gaps: false })).body.divergences).toEqual([]);
      STORE.push(moved("s-park-5", 3600_000));
      try {
        const r = await run({ file_gaps: false });
        expect(r.body.divergences.map((d) => d.key)).toEqual(["unknown-tree-moved-parked"]);
      } finally { STORE.pop(); }
    } finally { STORE.splice(STORE.length - 5, 5); }
  });
  it("one parked older than 24 h: unknown-tree-moved-parked; a closed one does not count", async () => {
    writeRows({ ...ROW, max: 3 });
    STORE.push({ ...moved("s-park-closed", 30 * 3600_000), status: "closed" });
    try {
      expect((await run({ file_gaps: false })).body.divergences).toEqual([]);
      STORE.push(moved("s-park-old", 25 * 3600_000));
      try {
        const r = await run({ file_gaps: false });
        expect(r.body.divergences.map((d) => d.key)).toEqual(["unknown-tree-moved-parked"]);
        expect(r.body.facts_checked[0]!.note).toContain("unknown_tree_moved=1 (oldest 25h)");
      } finally { STORE.pop(); }
    } finally { STORE.pop(); }
  });
});
