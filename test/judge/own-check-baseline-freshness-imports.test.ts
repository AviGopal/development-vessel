// AN OWN-CHECK READING WITH NO CALL PATH IS ALSO STALED BY THE EDIT SITE'S DIRECT IMPORTS (user ruling, "Yes, add direct
// imports"). When the reading's call_path is empty, the gap's edit-site file's direct relative imports, read at H, join
// the files its freshness rests on: a change to one of them in S..H stales the reading; a change to a file it does not
// import does not; a non-empty call path does not use imports. A FAILED lookup (an unreachable S, a git failure) is
// kept for one pass only: a pass starts at originDevShaOnce() (every per-pass head reader), so the next pass asks again.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `own-check-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
const CLONE = join(ROOT, "clones", "activity-api");
const PEER = join(ROOT, "peer");

const TEST_FILE = "test/trace-list-bounded-newest-first.test.ts";
const EDIT_SITE = "src/routes/execution-traces.ts";
const ONLY = ["THE DEFECT: a no-dates first page costs a fraction of materialising the 24 h window"];
// The edit site's imports, in the forms the vessels write them: an extensionless static import spread over lines, a
// .js-suffixed one, an export-from, and a dynamic import with a literal. One relative file it does NOT import.
const SITE_TEXT = [
  "import {",
  "  page,",
  "  limit,",
  "} from '../lib/trace-page';",
  'import { org } from "../lib/trace-org.js";',
  'export { counter } from "./counters";',
  "export async function lazy() { return (await import('../utils/session-context')).x; }",
  "",
].join("\n");
const FILES: Record<string, string> = {
  [TEST_FILE]: "// the check\n",
  [EDIT_SITE]: SITE_TEXT,
  "src/lib/trace-page.ts": "export const page = 1, limit = 2;\n",
  "src/lib/trace-org.ts": "export const org = 1;\n",
  "src/routes/counters/index.ts": "export const counter = 1;\n",
  "src/utils/session-context.ts": "export const x = 1;\n",
  "src/lib/unrelated.ts": "export const u = 1;\n",
};
const SHA = { S: "", page: "", org: "", counters: "", dynamic: "", unrelated: "", peer: "" };

const gitIn = (dir: string, args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};
const git = (args: string[]): string => gitIn(CLONE, args);
const put = (dir: string, rel: string, text: string): void => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const commitFrom = (dir: string, base: string, rel: string, text: string, msg: string): string => {
  gitIn(dir, ["checkout", "-q", "--detach", base]);
  put(dir, rel, text);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", msg]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
};

beforeAll(() => {
  mkdirSync(CLONE, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  for (const [rel, text] of Object.entries(FILES)) put(CLONE, rel, text);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "S"]);
  SHA.S = git(["rev-parse", "HEAD"]);
  // Each H is one commit from S; the edit site, the test file and the call path are untouched in every one.
  SHA.page = commitFrom(CLONE, SHA.S, "src/lib/trace-page.ts", "export const page = 2, limit = 2;\n", "an extensionless import");
  SHA.org = commitFrom(CLONE, SHA.S, "src/lib/trace-org.ts", "export const org = 2;\n", "a .js-suffixed import");
  SHA.counters = commitFrom(CLONE, SHA.S, "src/routes/counters/index.ts", "export const counter = 2;\n", "an export-from directory index");
  SHA.dynamic = commitFrom(CLONE, SHA.S, "src/utils/session-context.ts", "export const x = 2;\n", "a dynamic import");
  SHA.unrelated = commitFrom(CLONE, SHA.S, "src/lib/unrelated.ts", "export const u = 2;\n", "a file the site does not import");
  // A commit the vessel clone does not have yet (made in a copy of it): unreachable until fetched.
  Bun.spawnSync(["git", "clone", "-q", CLONE, PEER], { stdout: "pipe", stderr: "pipe" });
  gitIn(PEER, ["config", "user.email", "test@test"]);
  gitIn(PEER, ["config", "user.name", "test"]);
  SHA.peer = commitFrom(PEER, SHA.S, "src/lib/unrelated.ts", "export const u = 3;\n", "only in the peer");
  gitIn(PEER, ["branch", "-f", "peer-only", SHA.peer]);
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const { ownCheckBaselineFor } = await import("../../src/judge/gap-eligibility.js");
const { originDevShaOnce } = await import("../../src/judge/gap-attempt-credit.js");
type Row = Record<string, unknown>;
function meta(sha: string, callPath: string[] = []): Row {
  return {
    edit_site: `repos/activity-api/${EDIT_SITE}`,
    evidence_resolve: { shape: "test_suite", input: { vessel: "activity-api", test_file: TEST_FILE, only_tests: ONLY } },
    own_check_baseline: { verdict: "red_code_reachable", base_sha: sha, test_file: TEST_FILE, only_tests: ONLY, vessel: "activity-api",
      call_path: callPath.map((p, i) => ({ path: `repos/activity-api/${p}`, fn: `f${i}`, line: 1 })) },
  };
}

describe("with an empty call path, the edit site's direct relative imports join the freshness file set", () => {
  it("MUST-FAIL (no new seam): a change in S..H to a file the edit site imports stales the reading", () => {
    expect(ownCheckBaselineFor(meta(SHA.S), SHA.page)).toBeNull();
    expect(ownCheckBaselineFor(meta(SHA.S), SHA.org)).toBeNull();
    expect(ownCheckBaselineFor(meta(SHA.S), SHA.counters)).toBeNull();
    expect(ownCheckBaselineFor(meta(SHA.S), SHA.dynamic)).toBeNull();
  });

  it("CONTROL: a change to a file the edit site does not import leaves the reading fresh", () => {
    expect(ownCheckBaselineFor(meta(SHA.S), SHA.unrelated)).not.toBeNull();
  });

  it("CONTROL: a non-empty call path does not use the imports (the call path decides)", () => {
    expect(ownCheckBaselineFor(meta(SHA.S, ["src/lib/unrelated.ts"]), SHA.page)).not.toBeNull();
    expect(ownCheckBaselineFor(meta(SHA.S, ["src/lib/unrelated.ts"]), SHA.unrelated)).toBeNull();
  });
});

describe("a failed lookup is kept for one pass and asked again in the next", () => {
  it("MUST-FAIL (no new seam): an unreachable S stays stale within the pass after it becomes reachable, and is fresh in the next pass", () => {
    originDevShaOnce(); // a pass starts
    expect(ownCheckBaselineFor(meta(SHA.peer), SHA.unrelated)).toBeNull(); // the clone does not have the peer's commit
    git(["fetch", "-q", PEER, "peer-only"]);
    expect(git(["cat-file", "-t", SHA.peer])).toBe("commit");
    // Same pass: the failed lookup is kept, git is not asked again.
    expect(ownCheckBaselineFor(meta(SHA.peer), SHA.unrelated)).toBeNull();
    originDevShaOnce(); // the next pass
    // peer..unrelated differs only in src/lib/unrelated.ts, which the edit site does not import.
    expect(ownCheckBaselineFor(meta(SHA.peer), SHA.unrelated)).not.toBeNull();
  });
});
