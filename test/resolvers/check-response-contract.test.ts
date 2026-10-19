// THE RESPONSE CONTRACTS DO NOT DRIFT FROM THE BODIES THEY DESCRIBE (substrate-gap.ts RESPONSE CONTRACTS).
// The write seam stamps arming_invalid on a check whose field is not in its shape's declared list, so a body key that a
// resolver starts returning without being declared would condemn every good arming that names it. Each resolver below
// is run for real (its transport or data source stubbed) and every key of its body must be declared; the keys every
// answer carries must be declared too. goal_reach_verdict's list is a Record over keyof GoalReachVerdict (a compile
// error when they differ); self_fact_reconcile's single body literal is not run here (it reads the live substrate).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "check-response-contract-"));
process.env["WORKSPACE_ROOT"] = ROOT;
const { responseFields, RESPONSE_CONTRACT_SHAPES, resolveResolverSchema } = await import("../../src/resolvers/resolver-schema.js");
const { resolveGitLog, __setGitLogRootsForTests } = await import("../../src/resolvers/git-log.js");
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");
const { resolveReachRateScan } = await import("../../src/resolvers/reach-rate-scan.js");
const { resolveGoalReachVerdict } = await import("../../src/resolvers/goal-deficiency.js");

const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; __setGitLogRootsForTests(null); try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });
const keysOf = (r: unknown): string[] => Object.keys(((r as { body?: Record<string, unknown> }).body ?? {}));
const undeclared = (shape: string, keys: string[]): string[] => keys.filter((k) => !(responseFields(shape) ?? []).includes(k));

describe("each declared response contract covers its resolver's body", () => {
  it("git_log: a real log read and a refusal carry only declared keys", async () => {
    const repo = join(ROOT, "super");
    const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    Bun.spawnSync(["mkdir", "-p", repo, join(ROOT, "clones")]);
    sh(["git", "init", "-q"]); sh(["git", "commit", "-q", "--allow-empty", "-m", "fix: one"]);
    __setGitLogRootsForTests({ superRepo: repo, cloneDir: join(ROOT, "clones") });
    const ok = await resolveGitLog({ type: "git_log" } as never);
    expect(String((ok.body as Record<string, unknown>).stdout)).toContain("fix: one");
    expect(undeclared("git_log", keysOf(ok))).toEqual([]);
    const refused = await resolveGitLog({ type: "git_log", limit: 100000 } as never);
    expect((refused.body as Record<string, unknown>).refused).toBe(true);
    expect(undeclared("git_log", keysOf(refused))).toEqual([]);
  });

  it("test_suite: a run's body carries only declared keys, and requested_not_passing is among them", async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      if (b?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/v2/impulses/resolve" }] } });
      return Response.json({ stdout: "VERIFIED_ROOT=/x\nVERIFIED_HEAD=abc1234\n(pass) widget works\n(fail) widget breaks\n 1 pass\n 1 fail\nRan 2 tests across 1 file.\n" });
    }) as unknown as typeof fetch;
    const r = await resolveTestSuite({ vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: ["widget breaks"] });
    expect((r.body as Record<string, unknown>).requested_not_passing).toBe(1);
    expect(undeclared("test_suite", keysOf(r))).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it("reach_rate_scan: the scoped re-read (below the floor) and the scan both carry only declared keys", async () => {
    const rows = [{ activity_id: "a1", count: 10, success_rate: 0.2, reached_count: 1, graded_count: 10, ungraded_count: 0, reach_rate: 0.1 }];
    const scoped = await resolveReachRateScan({ type: "reach_rate_scan", activity_id: "a1", _rows: rows } as never);
    expect(keysOf(scoped)).toContain("reach_below_floor");
    expect(undeclared("reach_rate_scan", keysOf(scoped))).toEqual([]);
    const scan = await resolveReachRateScan({ type: "reach_rate_scan", dry_run: true, _rows: rows } as never);
    expect(undeclared("reach_rate_scan", keysOf(scan))).toEqual([]);
  });

  it("goal_reach_verdict: an unmeasured answer carries only declared keys, and the measured field is declared", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch; // no live policy read
    const r = await resolveGoalReachVerdict({ goal_hash: "not-a-hash" });
    globalThis.fetch = originalFetch;
    expect(undeclared("goal_reach_verdict", keysOf(r))).toEqual([]);
    expect(responseFields("goal_reach_verdict")).toContain("unreached_since_last_reach");
  });

  it("resolver_schema serves each declared list as response_fields", () => {
    for (const shape of RESPONSE_CONTRACT_SHAPES) {
      const b = (resolveResolverSchema({ shape }) as { body: Record<string, unknown> }).body;
      expect({ shape, fields: b.response_fields }).toEqual({ shape, fields: [...(responseFields(shape) ?? [])] });
    }
  });
});
