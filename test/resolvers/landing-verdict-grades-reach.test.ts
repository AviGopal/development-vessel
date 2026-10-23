// A LANDED SELF-EDIT IS GRADED ON ITS LANDING VERDICT, NOT ON ITS EXIT OR PUSH STATUS (REALIGNMENT §2.2 and §7 step 5;
// research wiring V1 + V2; row a-landed-self-edit-is-credited-on-exit-or-push-status-…, qa re-scope 2026-10-23).
//
// MUST-FAILS (red at the parent by name):
//   (a) an ok compose's exit posts NO reach (awaiting_landing_verdict); a compose that did not come back ok posts
//       reached:false, observe passed through;
//   (b) through the REAL pending-land sweep (isolated child, temp store and clone): a verified close grades the landing
//       trace the cutover recorded, reached:true with completion_shapes ["cutoverApplied"], exactly once over two sweeps;
//   (c) a falsified / reverted landing grades it reached:false, and an execution the trace store holds no row for
//       ({updated:0}) is tolerated;
//   (d) the cutover no longer grades on push status: it records the landing trace on the row instead (pushed, open
//       rows only).
// CONTROLS: a landing that stays pending posts no reach; a landing with no landing trace and no attempt grades nothing;
// a non-pushed cutover records nothing. The graded post in (b) is the input the ribosome's reach read takes (the
// execution's `reached` column true), so extraction from a cutover trace is gated on a verified success (law 4).
import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "./isolated-gap-store-run";
import * as lc from "../../src/judge/learning-credit.js";
import * as glv from "../../src/judge/gap-landing-verdict.js";
import * as cut from "../../src/resolvers/vessel-mitosis-cutover.js";

type Fn = (...a: any[]) => Promise<any>;
const composeExitReach = (lc as unknown as { composeExitReach?: Fn }).composeExitReach;
const gradeLandingExecution = (glv as unknown as { gradeLandingExecution?: Fn }).gradeLandingExecution;
const recordLandingTrace = (cut as unknown as { recordLandingTrace?: Fn }).recordLandingTrace;

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; (cut as any).__setOwnCheckDepsForTests?.(null); });
const reachSpy = (updated = 1) => {
  const posts: Array<Record<string, unknown>> = [];
  spy = spyOn(globalThis, "fetch").mockImplementation((async (u: RequestInfo | URL, init?: RequestInit) => {
    if (String(u).endsWith("/execution-traces/reach")) posts.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ success: true, updated }), { status: 200 });
  }) as unknown as typeof fetch);
  return posts;
};

describe("(a) a compose's exit is not its grade", () => {
  it("MUST-FAIL: an ok compose posts no reach (awaiting_landing_verdict); a not-ok one posts reached:false, observe passed through", async () => {
    expect(typeof composeExitReach).toBe("function");
    const posts = reachSpy();
    expect(await composeExitReach!({ ok: true, execution_id: "exec-ok" })).toEqual({ posted: false, awaiting_landing_verdict: true });
    await composeExitReach!({ ok: false, execution_id: "exec-bad" });
    await composeExitReach!({ ok: false, execution_id: "exec-obs", observe: true });
    expect(posts).toEqual([{ execution_id: "exec-bad", reached: false }, { execution_id: "exec-obs", reached: false, learning_mode: "observe" }]);
  });
});

describe("(c) the landing verdict grades the landing's executions", () => {
  const SHA = "a".repeat(40);
  it("MUST-FAIL: a falsified/reverted landing grades its landing trace reached:false; an unknown row ({updated:0}) is tolerated", async () => {
    expect(typeof gradeLandingExecution).toBe("function");
    const posts = reachSpy(0);
    const r = await gradeLandingExecution!({ landing_trace: { execution_id: "exec-cut", sha: SHA } }, SHA, false, "falsified");
    expect(posts).toEqual([{ execution_id: "exec-cut", reached: false, completion_shapes: ["cutoverApplied"] }]);
    expect(r).toEqual([{ execution_id: "exec-cut", updated: 0 }]);
  });
  it("CONTROL: a landing with no landing trace (or one of another sha) and no attempt grades nothing", async () => {
    const posts = reachSpy();
    const g = gradeLandingExecution ?? (async () => []);
    await g({}, SHA, true, "verified");
    await g({ landing_trace: { execution_id: "exec-other", sha: "b".repeat(40) } }, SHA, true, "verified");
    expect(posts).toEqual([]);
  });
});

describe("(d) the cutover records its landing trace instead of grading on push", () => {
  const SRC = readFileSync(new URL("../../src/resolvers/vessel-mitosis-cutover.ts", import.meta.url).pathname, "utf8");
  it("MUST-FAIL: no reach is posted on push status, and the emitted trace's id is recorded for the landing verdict", () => {
    expect(SRC.includes("/v2/activities/execution-traces/reach")).toBe(false);
    expect(SRC).toContain("await recordLandingTrace(gapId, String(appliedBody[\"new_git_sha\"] ?? \"\"), execId, String(appliedBody[\"push_status\"] ?? \"\"));");
  });
  it("MUST-FAIL: a pushed landing of an open row records landing_trace; CONTROL: not pushed, or a closed row, records nothing", async () => {
    expect(typeof recordLandingTrace).toBe("function");
    const SHA = "c".repeat(40);
    const writes: Array<Record<string, unknown>> = [];
    const rows: Record<string, Record<string, unknown>> = { open: { id: "open", status: "open", classification_metadata: { edit_site: "x" } }, shut: { id: "shut", status: "closed", classification_metadata: {} } };
    (cut as any).__setOwnCheckDepsForTests({
      readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: rows[String(p.id)] ? [rows[String(p.id)]] : [] } }),
      writeGap: async (p: Record<string, unknown>) => { writes.push(p.gap as Record<string, unknown>); return { shape: "substrateGap_write", body: {} }; },
    });
    expect(await recordLandingTrace!("open", SHA, "exec-cut", "pushed")).toBe(true);
    expect(await recordLandingTrace!("open", SHA, "exec-cut", "local_only")).toBe(false);
    expect(await recordLandingTrace!("shut", SHA, "exec-cut", "pushed")).toBe(false);
    expect(writes.map((w) => [w.id, ((w.classification_metadata as Record<string, unknown>).landing_trace as Record<string, unknown>).execution_id, (w.classification_metadata as Record<string, unknown>).edit_site])).toEqual([["open", "exec-cut", "x"]]);
  });
});

// (b) THE REAL SWEEP, ISOLATED (the gap-sweep-landed-partial harness).
const ROOT = join(tmpdir(), `landing-verdict-reach-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;
const CHECK = (k: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/${k}.test.ts`, only_tests: [k] }, zero_field: "requested_not_passing" } });
const git = (repo: string, ...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};
const shas: Record<string, { sha: string; parent: string }> = {};
beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "root\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "root");
  for (const k of ["verified", "pending"]) {
    const parent = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "test", `landing-${k}.test.ts`), `// ${k}\n`); git(repo, "add", "."); git(repo, "commit", "-q", "-m", `landing ${k}`);
    shas[k] = { sha: git(repo, "rev-parse", "HEAD"), parent };
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now, status: "open" };
  writeFileSync(GAPS_PATH, JSON.stringify([
    { ...base, id: "lv-verified", category: "cat_lv_verified", summary: "verified landing", classification_metadata: { ...CHECK("verified"), pending_outcome_verification: shas.verified!.sha, pending_set_at: now, landing_trace: { execution_id: "exec-cut-verified", sha: shas.verified!.sha, at: now } } },
    { ...base, id: "lv-pending", category: "cat_lv_pending", summary: "landing still red", classification_metadata: { ...CHECK("pending"), pending_outcome_verification: shas.pending!.sha, pending_set_at: now, landing_trace: { execution_id: "exec-cut-pending", sha: shas.pending!.sha, at: now } } },
  ]));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepTwice(): { exit: number; out: string } {
  const code = [
    `const RED_PARENT = ${JSON.stringify(shas.verified!.parent)};`,
    `globalThis.fetch = (async (u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  if (String(u).endsWith("/execution-traces/reach")) { console.log("REACH_POST " + JSON.stringify(b)); return new Response(JSON.stringify({ success: true, updated: 1 }), { status: 200 }); }`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  const red = String(p.test_file).includes("pending") || p.base_ref === RED_PARENT;`,
    `  return new Response(JSON.stringify({ body: { ran: true, total: 1, pass: red ? 0 : 1, fail: red ? 1 : 0, skip: 0, requested_not_passing: red ? 1 : 0 } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    `const ask = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `console.log("SWEEP1 " + JSON.stringify(await sweepPendingLandVerifications({ ask })));`,
    `console.log("SWEEP2 " + JSON.stringify(await sweepPendingLandVerifications({ ask })));`,
  ].join("\n");
  const env = isolatedChildEnv(ROOT, { HOME: process.env.HOME ?? ROOT, VESSELS_CLONE_ROOT: CLONES, EXPECTATION_CALIB_PATH: join(ROOT, "calib.json"), CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle.json"), NODE_ENV: "test", TZ: "UTC" });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr) };
}

describe("(b) the real sweep grades a verified landing's trace, once", () => {
  let run: { exit: number; out: string } | null = null;
  const once = () => (run ??= sweepTwice());
  const posts = (out: string) => out.split("\n").filter((l) => l.startsWith("REACH_POST ")).map((l) => JSON.parse(l.slice("REACH_POST ".length)));
  it("the sweep ran twice and closed the verified landing", () => {
    const r = once();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP2 ") }, r.out.slice(-2500)).toEqual({ exit: 0, ran: true });
    const byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, any>>).map((g) => [g.id, g]));
    expect([byId.get("lv-verified")!.status, byId.get("lv-verified")!.classification_metadata.closed_reason, byId.get("lv-pending")!.status]).toEqual(["closed", "landed_verified", "open"]);
  });
  it("MUST-FAIL: the verified close grades the landing trace reached:true with cutoverApplied, exactly once over two sweeps (the ribosome's input)", () => {
    const r = once();
    expect(posts(r.out), r.out.slice(-2500)).toEqual([{ execution_id: "exec-cut-verified", reached: true, completion_shapes: ["cutoverApplied"] }]);
  });
  it("CONTROL: a landing that stays pending posts no reach", () => {
    expect(posts(once().out).some((p) => p.execution_id === "exec-cut-pending")).toBe(false);
  });
});
