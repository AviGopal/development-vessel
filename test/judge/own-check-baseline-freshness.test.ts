// AN OWN-CHECK READING IS FRESH BY ITS FILES (user ruling, "Both, freshness first"). A reading taken at sha S is fresh at
// the vessel's origin/dev H when S == H, or when `git diff S..H` in the vessel's clone touches none of the check's test
// file, the reading's call_path files and the gap's edit site; an unknown or unreachable S is stale. ONE predicate,
// read through ownCheckBaselineFor, so every reader gets it: admission, the fresh-red lift (predictLand /
// landabilityScore), the compose's baseline, and the check-supply tick's never-twice guard.
// The live case: the trace-list row's red reading is at activity-api S, and activity-api's dev moved to H by a commit
// touching only an unrelated check file. Before this, that reading was stale, so the lift did not apply (p 0.10 < 0.15).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `own-check-freshness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
const CLONE = join(ROOT, "clones", "activity-api");
const SUPER = join(ROOT, "super");

const TEST_FILE = "test/trace-list-bounded-newest-first.test.ts";
const EDIT_SITE = "src/routes/execution-traces.ts";
const CALL_PATH_FILE = "src/lib/trace-page.ts";
const UNRELATED = "test/checks/the-variant-performance-metrics-counter-write-finds-its-row.check.ts";
const ONLY = ["THE DEFECT: a no-dates first page costs a fraction of materialising the 24 h window"];
// S: the reading's sha. H: origin/dev, one commit touching only an unrelated check. The controls branch from S.
const SHA = { S: "", H: "", editSite: "", testFile: "", callPath: "", renamed: "" };

const git = (args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", CLONE, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};
const put = (rel: string, text: string): void => { mkdirSync(dirname(join(CLONE, rel)), { recursive: true }); writeFileSync(join(CLONE, rel), text); };
const commitFrom = (base: string, change: () => void, msg: string): string => {
  git(["checkout", "-q", "--detach", base]);
  change();
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
};

beforeAll(() => {
  mkdirSync(CLONE, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  put(TEST_FILE, "// the check\n");
  put(EDIT_SITE, "export const route = 1;\n");
  put(CALL_PATH_FILE, "export const page = 1;\n");
  put(UNRELATED, "// another check\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "S"]);
  SHA.S = git(["rev-parse", "HEAD"]);
  SHA.H = commitFrom(SHA.S, () => put(UNRELATED, "// another check, changed\n"), "H: an unrelated check only");
  SHA.editSite = commitFrom(SHA.S, () => put(EDIT_SITE, "export const route = 2;\n"), "the edit site");
  SHA.testFile = commitFrom(SHA.S, () => put(TEST_FILE, "// the check, changed\n"), "the test file");
  SHA.callPath = commitFrom(SHA.S, () => put(CALL_PATH_FILE, "export const page = 2;\n"), "a call-path file");
  SHA.renamed = commitFrom(SHA.S, () => { mkdirSync(join(CLONE, "test/moved"), { recursive: true }); renameSync(join(CLONE, TEST_FILE), join(CLONE, "test/moved/trace-list.test.ts")); }, "the test file moved away");
  git(["update-ref", "refs/remotes/origin/dev", SHA.H]);
  mkdirSync(join(SUPER, ".git"), { recursive: true });
  mkdirSync(join(SUPER, "policies"), { recursive: true });
  writeFileSync(join(SUPER, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: 2 }));
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const { ownCheckBaselineFor } = await import("../../src/judge/gap-eligibility.js");
const { predictLand, landabilityScore } = await import("../../src/judge/gap-attempt-credit.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
type Row = Record<string, unknown>;
// The live row's shape: a hard category, a string edit_site, five failed attempts (0.10 without the lift).
function row(id: string, sha: () => string, o: { callPath?: string[] } = {}): Row {
  const meta: Row = {
    edit_site: `repos/activity-api/${EDIT_SITE}`,
    failed_attempts: 5,
    evidence_resolve: { shape: "test_suite", input: { vessel: "activity-api", test_file: TEST_FILE, only_tests: ONLY } },
    own_check_baseline: { verdict: "red_code_reachable", base_sha: sha(), test_file: TEST_FILE, only_tests: ONLY, vessel: "activity-api",
      call_path: (o.callPath ?? []).map((p, i) => ({ path: `repos/activity-api/${p}`, fn: `f${i}`, line: 1 })) },
  };
  return { id, category: "performance_inefficiency", source: "substrate_detected", summary: "list traces in bounded work", status: "open", classification_metadata: meta };
}
const meta = (r: Row): Row => r.classification_metadata as Row;
const at = (r: Row, h: string): unknown => ownCheckBaselineFor(meta(r), h);

describe("an own-check reading is fresh at origin/dev when the diff touches none of its files", () => {
  it("MUST-FAIL (no new seam): the lift applies to a reading at S when S..H touches only an unrelated check", () => {
    // predictLand reads the vessel's origin/dev (H) from the clone fixture; at the parent the reading is stale: p 0.10.
    expect(predictLand(row("perf-fresh", () => SHA.S)).p).toBeGreaterThanOrEqual(0.15);
    expect(predictLand(row("perf-fresh", () => SHA.S)).p).toBeCloseTo(0.5, 6);
  });

  it("MUST-FAIL (no new seam): ownCheckBaselineFor accepts the reading at S as fresh at H, call path included", () => {
    expect(at(row("fresh", () => SHA.S), SHA.H)).not.toBeNull();
    expect(at(row("fresh-cp", () => SHA.S, { callPath: [CALL_PATH_FILE, EDIT_SITE] }), SHA.H)).not.toBeNull();
    expect(landabilityScore(row("fresh", () => SHA.S), (v) => (v === "activity-api" ? SHA.H : null))).toBeCloseTo(0.5, 6);
  });

  it("CONTROL: a diff touching the gap's edit site is stale", () => {
    expect(at(row("edit-site", () => SHA.S), SHA.editSite)).toBeNull();
  });

  it("CONTROL: a diff touching the check's test file is stale (a rename away from it too)", () => {
    expect(at(row("test-file", () => SHA.S), SHA.testFile)).toBeNull();
    expect(at(row("test-file-renamed", () => SHA.S), SHA.renamed)).toBeNull();
  });

  it("CONTROL: a diff touching a call_path file is stale; the same diff with that file off the path is fresh", () => {
    expect(at(row("call-path", () => SHA.S, { callPath: [CALL_PATH_FILE] }), SHA.callPath)).toBeNull();
    expect(at(row("no-call-path", () => SHA.S), SHA.callPath)).not.toBeNull();
  });

  it("CONTROL: an unknown or unreachable S is stale", () => {
    expect(at(row("unreachable", () => "0".repeat(39) + "1"), SHA.H)).toBeNull();
    expect(at(row("not-a-sha", () => "unknown"), SHA.H)).toBeNull();
    expect(predictLand(row("perf-unreachable", () => "0".repeat(39) + "1")).p).toBeCloseTo(0.1, 6);
  });

  it("CONTROL: S == H is fresh, unchanged (no git needed: a vessel with no clone still reads it)", () => {
    expect(at(row("same", () => SHA.H), SHA.H)).not.toBeNull();
    const elsewhere = row("same-no-clone", () => "a".repeat(40));
    ((meta(elsewhere).evidence_resolve as Row).input as Row).vessel = "no-such-vessel";
    expect(at(elsewhere, "a".repeat(40))).not.toBeNull();
    // And a reading for another check (other titles) is still not this row's, fresh or not.
    const other = row("other-check", () => SHA.S);
    (meta(other).own_check_baseline as Row).only_tests = ["another test"];
    expect(at(other, SHA.H)).toBeNull();
  });
});

describe("the check-supply tick's never-twice guard reads the same predicate", () => {
  async function tick(open: Row[]) {
    const sends: Array<Record<string, unknown>> = [];
    let n = 0;
    const sent = await supply.dispatchOwnCheckBaselines(open as never, {
      node: "node-a", nowIso: "2026-01-01T00:00:00Z", env: { SUPER_REPO_DIR: SUPER },
      write: async () => ({ shape: "substrateGap", body: {} }) as never,
      send: (async (p: Record<string, unknown>) => { sends.push(p); n += 1; return { shape: "goalDispatchResult", body: { dispatch_id: `disp-${n}` } }; }) as never,
      headOf: () => SHA.H,
      executionIdOf: async () => null,
    });
    return { sent, sends };
  }

  it("MUST-FAIL (no new seam): a reading fresh at H by its files is not measured again", async () => {
    const { sent } = await tick([row("guard-fresh", () => SHA.S)]);
    expect(sent).toEqual([]);
  });

  it("CONTROL: a stale reading (the diff touched its test file) is measured at H, as before", async () => {
    // origin/dev for this row's vessel is H; the stale reading sits at a sha whose diff to H touches the test file.
    const { sent } = await tick([row("guard-stale", () => SHA.testFile)]);
    expect(sent.map((s) => [s.id, s.base_sha])).toEqual([["guard-stale", SHA.H]]);
  });
});
