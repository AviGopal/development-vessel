// CHECK-FIRST: AN INDEPENDENT LANDING VERDICT. A landing closes `landed_verified` only on a label the EVALUATOR
// (the pending-land sweep) wrote after re-running the gap's OWN check on commit-pinned trees: red at the
// landing's parent AND green at the landed sha. Never on the lander's own claim, never on a HEAD read alone.
//
// Why: the pending-land sweep and closeLandedGap closed gaps `landed_verified` on the gap's predicate reading
// 'absent' at HEAD, with no record that the landing is what flipped it. In one day three false 'verified' closes
// went through that seam (local-tools 2720323: the own check went green on example strings only; ias-executor
// bbadb86: a hollow write with zero callers; activity-api a79e70c: green against a mocked store), and a landing
// can be the lane grading itself.
//
// WHAT ITEM 1 CATCHES, AND WHAT IT DOES NOT. It catches self-grading (the lander's claim, a stored label any gap
// writer can forge), false red->green claims, and checks no commit-pinned tree can re-run. It does NOT catch a
// check that invites the patch: an honest pinned re-run GROUNDS 2720323 (its 4-string check really is red at the
// parent and green at the landing), a79e70c (its mocked test really flips) and bbadb86's own check. Those are
// recorded below as out of scope; they are caught only at ARMING (class checks, held-out sets, real-schema rule).
//
// Fixtures are hermetic gap rows judged through the injected pinned-run seam (parentOf, runAt): no real history,
// no network (fetch guard), no host process (exec guard). Named rows are modelled only from the record
// (validation/reports/realignment-2026-09-29): a198907 is "Class-1 literal satisfied by an env-gated hollow write"
// (its check is an expected_literal: un-rerunnable); b585a03 fabricated the directory its own check read, which
// the existing self-authored guard (selfAuthoredCheckInputs) holds (end-to-end row). c4bb14d, 9cfdea4 and af2c737
// are recorded only as operator-reverted passing landings, with nothing about their checks, so they are NOT
// modelled; the outcomes they could stand for are covered by unnamed class rows. The end-to-end case runs the REAL sweep in a fresh process on a temp store and temp
// clones (the gap-sweep-landed-partial harness) with fetch stubbed on base_ref, so the default pinned runner
// (evaluateGapCheck over test_suite's base_ref worktree run) is exercised too.
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";
import * as g2f from "../../src/resolvers/gap-to-feature.js";
import { installCutoverFetchGuard, restoreCutoverFetch, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

type Verdict = "present" | "absent" | "pending" | "unknown";
type Deps = { parentOf: (sha: string) => string | null; runAt: (gap: Record<string, unknown>, ref: string) => Promise<Verdict> };
type Label = { grounded: boolean; labeler: string; sha: string; parent: string; tests: string[]; ran_at: string; reason?: string };
type VerdictFn = (gap: Record<string, unknown>, sha: string, deps?: Deps) => Promise<{ label: Label | null; reason: string }>;
type CloseReasonFn = (meta: Record<string, unknown>, sha: string, literalOnly: boolean, independent?: Label | null) => string;

function exported<T>(mod: unknown, file: string, name: string): T {
  const f = (mod as Record<string, unknown>)[name];
  expect(typeof f, `${file} must export ${name}`).toBe("function");
  return f as T;
}
const verdictFn = (): VerdictFn => exported<VerdictFn>(g2f, "src/resolvers/gap-to-feature.ts", "independentLandingVerdict");
const closeReason: CloseReasonFn = (m, s, l, i) => (fc.landedCloseReason as unknown as CloseReasonFn)(m, s, l, i);

let guard: FetchGuard;
let exec: ExecGuard;
beforeEach(() => { guard = installCutoverFetchGuard(); exec = installCutoverExecGuard(); });
afterEach(() => {
  const execViolations = exec.restore();
  expect(guard.restore()).toEqual([]);
  expect(execViolations).toEqual([]);
});
afterAll(() => { restoreCutoverFetch(); restoreCutoverExecModules(); });

const testSuiteCheck = (vessel: string, testFile: string, name: string) => ({
  evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${vessel}`, test_file: testFile, only_tests: [name] }, zero_field: "requested_not_passing" },
});
const full = (short: string) => (short + "0".repeat(40)).slice(0, 40);
const parentOfFull = (short: string) => (short.split("").reverse().join("") + "f".repeat(40)).slice(0, 40);

/** A pinned runner: the gap's own check read at parent and at the landed sha, as the history is modelled. */
function pinned(sha: string, atParent: Verdict | "throw", atSha: Verdict | "throw", calls: string[] = []): Deps {
  const parent = parentOfFull(sha.slice(0, 7));
  return {
    parentOf: (s) => (s === sha ? parent : null),
    runAt: async (_g, ref) => {
      calls.push(ref);
      const v = ref === parent ? atParent : ref === sha ? atSha : "unknown";
      if (v === "throw") throw new Error("pinned run failed: the store this check reads is not reachable from a pinned tree");
      return v;
    },
  };
}

type Row = { id: string; sha: string; meta: Record<string, unknown>; deps: Deps; model: string };
const MUST_REFUSE: Row[] = [
  {
    id: "a198907", sha: full("a1989073"), model: "Class-1 literal satisfied by an env-gated hollow write: an expected_literal check, which no pinned tree re-runs",
    meta: { edit_site: "repos/development-vessel/src/resolvers/patch-with-tools.ts", expected_literal: "AUTHORING_ROOTS_PATH" },
    deps: pinned(full("a1989073"), "present", "absent"),
  },
  {
    id: "class: live read shape", sha: full("5e1fac70"), model: "a check that is a live read shape (self_fact_reconcile) cannot be re-run on a commit-pinned tree",
    meta: { evidence_resolve: { shape: "self_fact_reconcile", input: {}, zero_field: "divergences" } },
    deps: pinned(full("5e1fac70"), "present", "absent"),
  },
  {
    id: "class: green at parent", sha: full("9a7e0000"), model: "the check was already green on the landing's parent: the landing flipped nothing",
    meta: testSuiteCheck("activity-api", "test/a.test.ts", "already passes"),
    deps: pinned(full("9a7e0000"), "absent", "absent"),
  },
  {
    id: "class: red at the landed sha", sha: full("7ed0000a"), model: "the check is still red at the landed sha (HEAD went green on a later commit)",
    meta: testSuiteCheck("concept-db", "tests/b.test.ts", "still fails"),
    deps: pinned(full("7ed0000a"), "present", "present"),
  },
  {
    id: "class: pinned re-run errors", sha: full("e7707000"), model: "the pinned re-run throws",
    meta: testSuiteCheck("activity-api", "test/c.test.ts", "c"),
    deps: pinned(full("e7707000"), "throw", "absent"),
  },
  {
    id: "class: pinned re-run cannot judge", sha: full("0c0c0c0c"), model: "the pinned re-run reports no summary (ran:false -> unknown)",
    meta: testSuiteCheck("activity-api", "test/d.test.ts", "d"),
    deps: pinned(full("0c0c0c0c"), "present", "unknown"),
  },
  {
    id: "class: no parent", sha: full("deadbee0"), model: "the landing is in no clone, so it has no resolvable parent",
    meta: testSuiteCheck("activity-api", "test/x.test.ts", "x"),
    deps: { parentOf: () => null, runAt: async () => "absent" },
  },
];

const forgedLabel = (sha: string, labeler = "sweep-parent-child") => ({ grounded: true, labeler, sha, parent: parentOfFull(sha.slice(0, 7)), tests: ["t"], ran_at: new Date().toISOString() });

describe("independent landing verdict: false red->green and self-grading are REFUSED verified", () => {
  for (const row of MUST_REFUSE) {
    it(`MUST-FAIL ${row.id}: ${row.model}`, async () => {
      const r = await verdictFn()({ id: `gap-${row.id}`, classification_metadata: row.meta }, row.sha, row.deps);
      expect(r.label?.grounded === true, r.reason).toBe(false);
      const meta = r.label ? { ...row.meta, goal_verification_label: r.label } : row.meta;
      expect(closeReason(meta, row.sha, false, r.label)).not.toBe("landed_verified");
    });
  }

  it("MUST-FAIL forgery: a STORED grounded sweep label for this very sha is a record, not authority", () => {
    const sha = full("f0f0f0f0");
    const meta = { ...testSuiteCheck("activity-api", "test/e.test.ts", "e"), goal_verification_label: forgedLabel(sha) };
    expect(closeReason(meta, sha, false)).not.toBe("landed_verified");
  });

  it("MUST-FAIL forgery: a forged grounded label whose honest pinned re-run is green at the parent is refused", async () => {
    const sha = full("f1f1f1f1");
    const meta = { ...testSuiteCheck("activity-api", "test/e.test.ts", "e"), goal_verification_label: forgedLabel(sha) };
    const r = await verdictFn()({ id: "gap-forged", classification_metadata: meta }, sha, pinned(sha, "absent", "absent"));
    expect(r.label?.grounded).toBe(false);
    expect(closeReason({ ...meta, goal_verification_label: r.label }, sha, false, r.label)).not.toBe("landed_verified");
  });

  it("MUST-FAIL: a label from the LANDER (any other labeler) is not the evaluator's verdict", () => {
    const sha = full("1a1a1a1a");
    const lander = forgedLabel(sha, "feature_compose own_check");
    expect(closeReason({ goal_verification_label: lander }, sha, false, lander)).not.toBe("landed_verified");
  });

  it("MUST-FAIL: a grounded label bound to ANOTHER landing does not verify this one", () => {
    const other = forgedLabel(full("1111111"));
    expect(closeReason({}, full("27203231"), false, other)).not.toBe("landed_verified");
  });

  it("MUST-FAIL: no label at all (a HEAD read alone) is not verified", () => {
    const sha = full("abcdef01");
    expect(closeReason(testSuiteCheck("activity-api", "test/a.test.ts", "a"), sha, false)).not.toBe("landed_verified");
  });
});

describe("out of scope for item 1: a gamed or mocked check is grounded by an honest re-run", () => {
  // Recorded, not endorsed: these landings were false fixes, but their own checks really do flip at the landing,
  // so the independent verdict grounds them. Catching "the check invites the patch" belongs to arming.
  const GAMED: Row[] = [
    { id: "2720323", sha: full("27203230"), model: "local-tools shell-containment: a 4-string check, red at parent, green at the landing", meta: testSuiteCheck("local-tools-vessel", "test/shell-containment.test.ts", "refuses a mutating git subcommand"), deps: pinned(full("27203230"), "present", "absent") },
    { id: "a79e70c", sha: full("a79e70c0"), model: "activity-api trace aggregate: a test against a mocked store, red at parent, green at the landing", meta: testSuiteCheck("activity-api", "test/trace-aggregate-report.test.ts", "reads the live table"), deps: pinned(full("a79e70c0"), "present", "absent") },
  ];
  for (const row of GAMED) {
    it(`${row.id}: ${row.model} -> grounded, landed_verified as far as item 1 is concerned`, async () => {
      const r = await verdictFn()({ id: `gap-${row.id}`, classification_metadata: row.meta }, row.sha, row.deps);
      expect(r.label?.grounded).toBe(true);
      expect(closeReason(row.meta, row.sha, false, r.label)).toBe("landed_verified");
    });
  }
  it("bbadb86: ias-executor hollow write; its own check flips too -> grounded; only the cutover's landed_unverified stamp (a separate seam) keeps it partial", async () => {
    const sha = full("bbadb860");
    const check = testSuiteCheck("ias-executor-ts", "test/trace-sink.test.ts", "carries the code version");
    const r = await verdictFn()({ id: "gap-bbadb86", classification_metadata: check }, sha, pinned(sha, "present", "absent"));
    expect(r.label?.grounded).toBe(true);
    expect(closeReason(check, sha, false, r.label)).toBe("landed_verified");
    expect(closeReason({ ...check, landed_unverified: true, landed_unverified_sha: sha }, sha, false, r.label)).toBe("landed_partial");
  });
});

describe("independent landing verdict: CONTROLS read verified", () => {
  const CONTROLS: Row[] = [
    { id: "b70ff28", sha: full("b70ff280"), model: "goal-host regex literal held control bytes: red at parent, green at the landing", meta: testSuiteCheck("goal-host-vessel", "test/goal-target-inference.test.ts", "the regex matches its escapes"), deps: pinned(full("b70ff280"), "present", "absent") },
    { id: "0354005", sha: full("03540050"), model: "activity-api trace list no-cache: red at parent, green at the landing", meta: testSuiteCheck("activity-api", "test/execution-traces-list.test.ts", "the list is not cached"), deps: pinned(full("03540050"), "present", "absent") },
  ];
  for (const row of CONTROLS) {
    it(`CONTROL ${row.id}: ${row.model}`, async () => {
      const calls: string[] = [];
      const deps = pinned(row.sha, "present", "absent", calls);
      const r = await verdictFn()({ id: `gap-${row.id}`, classification_metadata: row.meta }, row.sha, deps);
      const parent = parentOfFull(row.sha.slice(0, 7));
      expect(calls.sort()).toEqual([parent, row.sha].sort());
      expect(r.label).toMatchObject({ grounded: true, labeler: "sweep-parent-child", sha: row.sha, parent, tests: (row.meta.evidence_resolve as { input: { only_tests: string[] } }).input.only_tests });
      expect(typeof r.label?.ran_at).toBe("string");
      expect(closeReason(row.meta, row.sha, false, r.label)).toBe("landed_verified");
      // An abbreviated landing sha binds the same label.
      expect(closeReason(row.meta, row.sha.slice(0, 7), false, r.label)).toBe("landed_verified");
    });
  }
});

// ── wiring: both closers take closed_reason from landedCloseReason, which consults the label ─────────
function fnText(file: string, name: string): string {
  const src = readFileSync(new URL(`../../src/resolvers/${file}`, import.meta.url), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let out = "";
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
describe("independent landing verdict: wiring", () => {
  it("landedCloseReason consults the sweep's label (goal_verification_label) bound to the landing", () => {
    const body = fnText("feature-compose.ts", "landedCloseReason");
    expect(body.length).toBeGreaterThan(0);
    expect(/landingLabelHere\(|goal_verification_label/.test(body)).toBe(true);
  });
  it("the sweep runs the independent verdict BEFORE crediting and before closed_reason; closeLandedGap defers without a label", () => {
    const sweep = fnText("gap-to-feature.ts", "sweepPendingLandVerificationsOnce");
    const lander = fnText("gap-to-feature.ts", "closeLandedGap");
    const iv = sweep.indexOf("independentLandingVerdict(");
    expect(iv).toBeGreaterThan(0);
    expect(iv).toBeLessThan(sweep.indexOf("joinDecisionOutcome("));
    expect(iv).toBeLessThan(sweep.indexOf("closed_reason: landedCloseReason("));
    expect(lander.includes("closed_reason: landedCloseReason(")).toBe(true);
    // The lander never passes an in-pass label, so it can never close verified; the sweep's close passes its own.
    const calls = (txt: string): number[] => { const out: number[] = []; const sf = ts.createSourceFile("x.ts", `function f(){${txt}}`, ts.ScriptTarget.Latest, true); const v = (n: ts.Node): void => { if (ts.isCallExpression(n) && n.expression.getText(sf) === "landedCloseReason") out.push(n.arguments.length); ts.forEachChild(n, v); }; v(sf); return out; };
    expect(calls(lander).length).toBeGreaterThan(0);
    expect(calls(lander).every((n) => n <= 3)).toBe(true);
    expect(sweep.includes("closed_reason: landedCloseReason(meta, sha, isLiteralOnlyStepClose(meta), independentLabel)")).toBe(true);
    const deferAt = lander.indexOf('"awaiting_independent_verdict"');
    expect(deferAt).toBeGreaterThan(0);
    expect(deferAt).toBeLessThan(lander.indexOf('status: "closed"'));
    const src = readFileSync(new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url), "utf8");
    expect(src.includes('closed_reason: "landed_verified"')).toBe(false);
  });
});

// ── end to end through the REAL sweep, isolated in a fresh process (see gap-sweep-landed-partial) ────
const ROOT = join(tmpdir(), `independent-landing-verdict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const CALIB = join(ROOT, "expectation-calibration.json");
const GTF = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;
const BIN = join(ROOT, "bin");
function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
const shas: Record<string, { sha: string; parent: string }> = {};
const SELF_INPUT = "test/fixtures/obsidian-vessel-live/vault.md";
const E2E: Record<string, Record<string, unknown>> = {
  control: testSuiteCheck("development-vessel", "test/control.test.ts", "flips with the landing"),
  errors: testSuiteCheck("development-vessel", "test/errors.test.ts", "cannot run pinned"),
  readshape: { evidence_resolve: { shape: "self_fact_reconcile", input: {}, zero_field: "divergences" } },
  // Forged: a grounded sweep label for its own landed sha is pre-seeded, but its check is green at the parent.
  forged: testSuiteCheck("development-vessel", "test/forged.test.ts", "never red"),
  // The same forgery, offered to the cutover's close path (closeLandedGap) instead of the sweep.
  forgedcut: testSuiteCheck("development-vessel", "test/forgedcut.test.ts", "never red"),
  // b585a03: the landing fabricated the directory its own check reads (check_inputs), red->green or not.
  selfauth: { ...testSuiteCheck("development-vessel", "test/selfauth.test.ts", "reads the vault"), check_inputs: [`repos/development-vessel/${SELF_INPUT}`] },
  // A supply-armed check (vessel "repos/<v>", as gap-check-supply writes it) whose landing edited its OWN test_file:
  // the sweep's self-authored hold must fire, not only the independent verdict's later instrument guard.
  supplyedit: testSuiteCheck("development-vessel", "test/supplyedit.test.ts", "edited by its landing"),
  // CONTROL: the same self-edit with a bare vessel name, held as before.
  bareedit: { evidence_resolve: { shape: "test_suite", input: { vessel: "development-vessel", test_file: "test/bareedit.test.ts", only_tests: ["edited by its landing"] }, zero_field: "requested_not_passing" } },
  // A test_file named super-repo style (repos/<v>/test/...): the landing editing test/prefixedit.test.ts edited its check.
  prefixedit: testSuiteCheck("development-vessel", "repos/development-vessel/test/prefixedit.test.ts", "edited by its landing"),
};
const SELF_EDITS: Record<string, string> = { supplyedit: "test/supplyedit.test.ts", bareedit: "test/bareedit.test.ts", prefixedit: "test/prefixedit.test.ts" };
let e2eReady = false;
beforeAll(() => {
  // The real sweep spawns git; the exec guard is per-test, and this setup runs outside any test.
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  for (const k of Object.keys(E2E)) {
    const parent = git(repo, "rev-parse", "HEAD");
    // Test-only landings are "running" without a restart; none edits its own check's test file, except selfauth,
    // which writes the very input its check reads.
    const file = k === "selfauth" ? join(repo, SELF_INPUT) : SELF_EDITS[k] ? join(repo, SELF_EDITS[k]!) : join(repo, "test", `landing-${k}.test.ts`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `// ${k}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `landing ${k}`);
    shas[k] = { sha: git(repo, "rev-parse", "HEAD"), parent };
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now, status: "open" };
  writeFileSync(GAPS_PATH, JSON.stringify(Object.entries(E2E).map(([k, check]) => ({
    ...base, id: `ilv-${k}`, category: `cat_${k}`, summary: `landing ${k}`,
    classification_metadata: {
      ...check,
      ...(k === "forgedcut" ? {} : { pending_outcome_verification: shas[k]!.sha, pending_set_at: now }),
      ...(k.startsWith("forged") ? { goal_verification_label: { grounded: true, labeler: "sweep-parent-child", sha: shas[k]!.sha, parent: shas[k]!.parent, tests: ["never red"], ran_at: now } } : {}),
    },
  }))));
  writeFileSync(CALIB, JSON.stringify({}));
  e2eReady = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep once, in a fresh process bound to ROOT. The check transport answers by base_ref. */
function sweepInIsolation(): { exit: number; out: string } {
  const table = Object.fromEntries(Object.entries(shas).map(([k, v]) => [k, v]));
  const code = [
    `const T = ${JSON.stringify(table)};`,
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type === "self_fact_reconcile") return new Response(JSON.stringify({ body: { divergences: 0 } }), { status: 200 });`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  const f = String(p.test_file ?? "");`,
    `  const ref = typeof p.base_ref === "string" ? p.base_ref : "";`,
    `  if (f.includes("errors") && ref) return new Response("store unreachable from a pinned tree", { status: 500 });`,
    // Each check is red only on its OWN landing's parent (the landings are consecutive commits); forged never is.
    `  const red = ref !== "" && ((f.includes("control") && ref === T.control.parent) || (f.includes("selfauth") && ref === T.selfauth.parent));`,
    `  return new Response(JSON.stringify({ body: { ran: true, requested_not_passing: red ? 1 : 0 } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications, closeLandedGap } = await import(${JSON.stringify(GTF)});`,
    `const r = await sweepPendingLandVerifications();`,
    `const c = await closeLandedGap({ id: "ilv-forgedcut" }, { landed: true, commit_sha: T.forgedcut.sha, vessel: "activity-api", push_status: "pushed" });`,
    `console.log("CUTOVER_CLOSE " + JSON.stringify(c));`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
  ].join("\n");
  const env: Record<string, string> = {
    // The exec guard does not reach a child process: its PATH resolves git and bun only, so no
    // host-lifecycle tool (systemctl, docker, podman, vessel-ctl) can run from it.
    HOME: ROOT, PATH: BIN,
    WORKSPACE_ROOT: ROOT, VESSELS_CLONE_ROOT: CLONES, EXPECTATION_CALIB_PATH: CALIB,
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1", NODE_ENV: "test", TZ: "UTC",
  };
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

describe("independent landing verdict: end to end through the real pending-land sweep", () => {
  it("MUST-FAIL: a forged grounded label (sweep and cutover paths), a live-read-shape check and a check whose pinned re-run errors stay open, unverified; b585a03's self-authored check input is held for review; the CONTROL closes landed_verified carrying the sweep's label", () => {
    expect(e2eReady).toBe(true);
    const run = sweepInIsolation();
    expect({ exit: run.exit, ran: run.out.includes("SWEEP_RESULT ") }, run.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    const byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    const view = (k: string) => {
      const g = byId.get(`ilv-${k}`)!;
      const m = g.classification_metadata as Record<string, unknown>;
      const l = m.goal_verification_label as Label | undefined;
      return { status: g.status, closed_reason: m.closed_reason ?? null, label: l ? { grounded: l.grounded, labeler: l.labeler, sha: l.sha, parent: l.parent } : null };
    };
    const seen = Object.fromEntries(Object.keys(E2E).map((k) => [k, view(k)]));
    const dispositionOf = (k: string) => ((byId.get(`ilv-${k}`)!.classification_metadata as Record<string, unknown>).disposition) ?? null;
    const disposition = dispositionOf("selfauth");
    const lbl = (k: string, grounded: boolean) => ({ grounded, labeler: "sweep-parent-child", sha: shas[k]!.sha, parent: shas[k]!.parent });
    expect({ ...seen, selfauth_disposition: disposition, supplyedit_disposition: dispositionOf("supplyedit"), bareedit_disposition: dispositionOf("bareedit"), prefixedit_disposition: dispositionOf("prefixedit") }, run.out.slice(-3000)).toEqual({
      control: { status: "closed", closed_reason: "landed_verified", label: lbl("control", true) },
      errors: { status: "open", closed_reason: null, label: null },
      readshape: { status: "open", closed_reason: null, label: null },
      // The sweep re-ran it (the stored label did not stand in) and recorded the honest, ungrounded verdict.
      forged: { status: "open", closed_reason: null, label: lbl("forged", false) },
      // The cutover path never closes verified; the forged label stays a record on an open row.
      forgedcut: { status: "open", closed_reason: null, label: lbl("forgedcut", true) },
      selfauth: { status: "open", closed_reason: null, label: null },
      selfauth_disposition: "awaiting_operator_review",
      // MUST-FAIL (i): held by the sweep's self-authored check (no pinned re-run, so no label), vessel prefix or not.
      supplyedit: { status: "open", closed_reason: null, label: null },
      supplyedit_disposition: "awaiting_operator_review",
      bareedit: { status: "open", closed_reason: null, label: null },
      bareedit_disposition: "awaiting_operator_review",
      // MUST-FAIL (S2): the repos/<v>/ prefix on test_file is stripped, so the self-edit is held, never re-run.
      prefixedit: { status: "open", closed_reason: null, label: null },
      prefixedit_disposition: "awaiting_operator_review",
    });
  });
});
