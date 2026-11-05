// THE CLOSE STEP IS AN ACTIVITY (development-vessel:gap-close-verify), END TO END THROUGH THE REAL PENDING-LAND SWEEP.
//
// A close is traced (output gapCloseDecision) after everything it already does, and graded at its horizon by a later
// sweep that re-runs the gap's own check FRESH. The landing grade the sweep already posts (gradeLandingExecution, the
// reach-grade path) is unchanged: same execution, same verdict, same order, before the new trace.
//   - [MUST-FAIL] a verified close stamps close_trace_id and posts its own trace AFTER the landing's reach post.
//   - [MUST-FAIL] at the horizon: still closed with its check green -> credit reached:true; re-opened -> reached:false;
//     a check that cannot be re-run -> ungraded (no credit); each graded row records close_credit once.
//   - [CONTROL] the landing's reach post is the same as before (one post, the landing trace, reached:true); a close
//     younger than the horizon is not graded.
// ISOLATION as gap-sweep-landed-partial.test.ts: the sweep runs in a FRESH bun process bound to this file's temp dir.
import { isolatedChildEnv, childUnitSeamLine } from "./isolated-gap-store-run";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `gap-close-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const CALIB = join(ROOT, "expectation-calibration.json");
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

const CHECK = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/own.test.ts", only_tests: ["own"] }, zero_field: "requested_not_passing" } };
const DAY = 86_400_000;
let parentSha = "";
let landedSha = "";
beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  parentSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "test", "a.test.ts"), "// a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "the landing");
  landedSha = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 4 * DAY).toISOString();
  const base = { source: "substrate_detected", detected_at: old, created_at: old, updated_at: now, category: "cat_cv" };
  writeFileSync(GAPS_PATH, JSON.stringify([
    { ...base, id: "cv-landing", status: "open", summary: "a landing to verify", classification_metadata: { ...CHECK, pending_outcome_verification: landedSha, pending_set_at: now, landing_trace: { execution_id: "lt-cv-1", sha: landedSha } } },
    { ...base, id: "cv-old-green", status: "closed", summary: "closed four days ago, check green", classification_metadata: { ...CHECK, closed_reason: "landed_verified", closed_at: old, close_trace_id: "gap-close-verify-old-green" } },
    { ...base, id: "cv-old-reopened", status: "open", summary: "closed then re-opened", classification_metadata: { ...CHECK, closed_reason: "landed_verified", closed_at: old, close_trace_id: "gap-close-verify-old-reopened" } },
    { ...base, id: "cv-old-nocheck", status: "closed", summary: "closed with no check to re-run", classification_metadata: { closed_reason: "landed_verified", closed_at: old, close_trace_id: "gap-close-verify-old-nocheck" } },
    { ...base, id: "cv-recent", status: "closed", summary: "closed an hour ago", classification_metadata: { ...CHECK, closed_reason: "landed_verified", closed_at: new Date(Date.now() - 3_600_000).toISOString(), close_trace_id: "gap-close-verify-recent" } },
  ]));
  writeFileSync(CALIB, JSON.stringify({}));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep once, in a fresh process. The own check is red at the landing's parent and green everywhere else.
 *  Every /reach post and every close-verify trace is printed, in order. */
function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    `const PARENT = ${JSON.stringify(parentSha)};`,
    `globalThis.fetch = (async (u, init) => { let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {} if (String(u).endsWith("/execution-traces/reach")) console.log("REACH " + JSON.stringify({ execution_id: b.execution_id, reached: b.reached })); const ref = b?.impulse?.pointer?.base_ref; return new Response(JSON.stringify({ updated: 1, body: { ran: true, requested_not_passing: ref === PARENT ? 1 : 0 } }), { status: 200 }); });`,
    `const glv = await import(${JSON.stringify(GLV)});`,
    `glv.__setGapCloseVerifyDepsForTests?.({ postTrace: async (t) => { console.log("TRACE " + JSON.stringify(t)); return 201; } });`,
    childUnitSeamLine(GLV),
    `const __askHuman = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `const r = await glv.sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
    // The round trip through the real gap-store resolve (not the file): the two horizon fields come back as written.
    `const sg = await import(${JSON.stringify(new URL("../../src/resolvers/substrate-gap.ts", import.meta.url).pathname)});`,
    `for (const id of ["cv-landing", "cv-old-green"]) { const rr = await sg.resolveSubstrateGap({ type: "substrateGap", id, include_held: true }); const g = (rr?.body?.gaps ?? [])[0] ?? null; const m = g?.classification_metadata ?? {}; console.log("RESOLVED " + JSON.stringify({ id, status: g?.status ?? null, close_trace_id: m.close_trace_id ?? null, close_credit: m.close_credit === undefined ? "absent" : m.close_credit })); }`,
  ].join("\n");
  const env = isolatedChildEnv(ROOT, {
    HOME: process.env.HOME ?? ROOT, VESSELS_CLONE_ROOT: CLONES, EXPECTATION_CALIB_PATH: CALIB,
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"), NODE_ENV: "test", TZ: "UTC",
  });
  const p = Bun.spawnSync(["bun", "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

describe("the close step as an activity, through the real sweep", () => {
  let run: { exit: number; out: string } = { exit: -1, out: "" };
  let lines: string[] = [];
  let byId = new Map<unknown, Record<string, unknown>>();
  const traces = () => lines.filter((l) => l.startsWith("TRACE ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  beforeAll(() => {
    run = sweepInIsolation();
    lines = run.out.split("\n");
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
  });
  const meta = (id: string) => (byId.get(id)?.classification_metadata ?? {}) as Record<string, unknown>;

  it("[CONTROL] the sweep closes the landing and grades its landing trace exactly once, reached:true", () => {
    expect({ exit: run.exit, ran: run.out.includes("SWEEP_RESULT ") }, run.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    expect([byId.get("cv-landing")?.status, meta("cv-landing").closed_reason]).toEqual(["closed", "landed_verified"]);
    expect(lines.filter((l) => l.startsWith("REACH "))).toEqual([`REACH ${JSON.stringify({ execution_id: "lt-cv-1", reached: true })}`]);
  });
  it("[CONTROL] today's close is unchanged: with the two horizon fields set aside, the close's metadata is exactly what it was", () => {
    const { close_trace_id: _t, close_credit: _c, ...rest } = meta("cv-landing");
    expect(Object.keys(rest).sort()).toEqual(["approach_decisions", "close_basis", "closed_at", "closed_reason", "evidence_resolve", "falsifier", "falsifier_classified_at", "falsifier_exercise", "falsifier_position", "goal_verification_label", "landed_sha", "landing_trace", "pending_outcome_verification", "pending_set_at", "resolution"]);
    expect(rest).toMatchObject({ closed_reason: "landed_verified", landed_sha: landedSha, close_basis: "absent" });
  });
  it("[MUST-FAIL] the close stamps close_trace_id and posts its own trace after the landing's reach post", () => {
    const id = meta("cv-landing").close_trace_id;
    expect(typeof id).toBe("string");
    const own = traces().find((t) => t["execution_id"] === id);
    expect(own?.["activity_variant_id"]).toBe("development-vessel:gap-close-verify");
    expect(own?.["output_shapes"]).toEqual(["gapCloseDecision"]);
    expect((own?.["metadata"] as Record<string, any>)?.gapCloseDecision).toMatchObject({ gap_id: "cv-landing", sha: landedSha, path: "sweep", decision: "closed", closed_reason: "landed_verified" });
    const reachAt = lines.findIndex((l) => l.startsWith("REACH "));
    const ownAt = lines.findIndex((l) => l.startsWith("TRACE ") && l.includes(String(id)));
    expect(reachAt).toBeGreaterThanOrEqual(0);
    expect(ownAt).toBeGreaterThan(reachAt);
  });
  it("[MUST-FAIL] at the horizon: still closed and green is reached, re-opened is not, no check is ungraded; each recorded once", () => {
    const credits = traces().filter((t) => t["activity_id"] === "development-vessel:gap-close-verify-credit");
    const byProducer = Object.fromEntries(credits.map((c) => [((c["composition_chain"] as string[]) ?? [])[0], (c["tags"] as string[]).find((x) => x.startsWith("reached:"))]));
    expect(byProducer).toEqual({ "gap-close-verify-old-green": "reached:true", "gap-close-verify-old-reopened": "reached:false" });
    expect(meta("cv-old-green").close_credit).toMatchObject({ reached: true });
    expect(meta("cv-old-reopened").close_credit).toMatchObject({ reached: false });
    expect(meta("cv-old-nocheck").close_credit).toMatchObject({ reached: null });
    expect(byId.get("cv-old-green")?.status).toBe("closed");
  });
  it("[MUST-FAIL] the two horizon fields survive the real gap-store write and resolve", () => {
    const resolved = Object.fromEntries(lines.filter((l) => l.startsWith("RESOLVED ")).map((l) => { const j = JSON.parse(l.slice(9)); return [j.id, j]; }));
    expect(resolved["cv-landing"]).toMatchObject({ status: "closed", close_trace_id: meta("cv-landing").close_trace_id, close_credit: null });
    expect(typeof resolved["cv-landing"].close_trace_id).toBe("string");
    expect(resolved["cv-old-green"]).toMatchObject({ status: "closed", close_trace_id: "gap-close-verify-old-green" });
    expect(resolved["cv-old-green"].close_credit).toMatchObject({ reached: true });
  });
  it("[CONTROL] a close younger than the horizon is not graded", () => {
    expect(meta("cv-recent").close_credit).toBeUndefined();
    expect(traces().some((t) => ((t["composition_chain"] as string[]) ?? [])[0] === "gap-close-verify-recent")).toBe(false);
  });
});
