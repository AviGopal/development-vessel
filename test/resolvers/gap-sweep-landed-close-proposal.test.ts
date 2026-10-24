// LANDED BUT NOT CLOSED (law 7 durability; REALIGNMENT §2.1 / §2.2; USER RULING 2026-10-23T22:27:58Z via qa, "With the
// landed-open detector"). A fix that lands outside the lane leaves its row open: the landing-time close and the
// fixed_elsewhere close act only on a row the lane composes, and the pending sweep only on a row a landing stamped. So
// the pending-land sweep now re-runs an open row's own check on the clone HEAD when a commit has touched the row's
// edit_site since its detection, and a pass PROPOSES the close (landed_close_proposal + a question on the human panel).
// It never closes the row and never stamps pending_outcome_verification.
//
// MUST-FAIL (the row's own): "a row whose edit_site gets a commit that makes its test_file pass is flagged closable
// within one tick" — through the REAL sweep, once, in a fresh process on a temp store and a temp vessel clone (the
// pending-sweep harness; fetch stubbed per test_file). Both check forms: a test_suite evidence_resolve row, and a row
// that carries only a bare test_file. CONTROL (the row's own): "a row whose check still fails stays open" — no proposal,
// no close; likewise a row whose edit_site no commit touched (not even run) and a prose-only must_fail row. A second
// must-fail pins the bookkeeping: the still-red row records the commit it was judged against, so the next sweep does
// not re-run it, and the prose-only row is counted, never written.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv, childUnitSeamLine } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `sweep-landed-close-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const BIN = join(ROOT, "bin");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
const V = "repos/development-vessel";
const armed = (k: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: V, test_file: `test/lc-${k}.test.ts`, only_tests: [`lc ${k}`] }, zero_field: "requested_not_passing" } });
const fixSha: Record<string, string> = {};
let head = "";
let ready = false;

beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "root\n");
  for (const k of ["fixed", "red", "bare", "untouched"]) writeFileSync(join(repo, "src", `lc-${k}.ts`), `export const v = 0; // ${k}\n`);
  git(repo, "add", ".");
  // The rows are detected an hour after the root commit and an hour before the fixing commits.
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "root"], { env: { ...process.env, GIT_AUTHOR_DATE: iso(now - 7_200_000), GIT_COMMITTER_DATE: iso(now - 7_200_000) } });
  // An operator-style fix per row, each touching only that row's edit_site, landed after detection.
  for (const k of ["fixed", "red", "bare"]) {
    writeFileSync(join(repo, "src", `lc-${k}.ts`), `export const v = 1; // ${k} fixed\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `fix ${k}`);
    fixSha[k] = git(repo, "rev-parse", "HEAD");
  }
  head = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const detected = iso(now - 3_600_000);
  const row = (k: string, meta: Record<string, unknown>) => ({
    id: `lc-${k}`, category: `cat_lc_${k}`, source: "substrate_detected", summary: `landed but not closed ${k}`,
    detected_at: detected, created_at: detected, updated_at: detected, status: "open",
    classification_metadata: { edit_site: `${V}/src/lc-${k}.ts`, ...meta },
  });
  writeFileSync(GAPS_PATH, JSON.stringify([
    row("fixed", armed("fixed")),
    row("red", armed("red")),
    row("bare", { test_file: "test/lc-bare.test.ts", must_fail: "lc-bare's check fails until src/lc-bare.ts is fixed" }),
    row("untouched", armed("untouched")),
    row("prose", { must_fail: "a prose must-fail with nothing to run" }),
  ]));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep twice, in a fresh process bound to ROOT. lc-red's check reads red; every other check reads green. */
function sweepTwiceInIsolation(): { exit: number; first: string; second: string; out: string } {
  const code = [
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  console.log("TS_CALL " + String(p.test_file) + " " + String(p.base_ref ?? ""));`,
    `  const red = String(p.test_file).includes("lc-red");`,
    `  return new Response(JSON.stringify({ body: { ran: true, total: 1, pass: red ? 0 : 1, fail: red ? 1 : 0, skip: 0, requested_not_passing: red ? 1 : 0 } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    childUnitSeamLine(GLV),
    `const __askHuman = async (p) => { console.log("ASK " + String(p?.id ?? "")); return (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p); };`,
    `const r1 = await sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP1_DONE " + JSON.stringify(r1));`,
    `const r2 = await sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP2_DONE " + JSON.stringify(r2));`,
  ].join("\n");
  const env: Record<string, string> = isolatedChildEnv(ROOT, {
    HOME: ROOT, PATH: BIN, VESSELS_CLONE_ROOT: CLONES,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    NODE_ENV: "test", TZ: "UTC",
  });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const so = new TextDecoder().decode(p.stdout);
  const out = so + "\n" + new TextDecoder().decode(p.stderr);
  const i1 = so.indexOf("SWEEP1_DONE");
  return { exit: p.exitCode ?? -1, first: i1 >= 0 ? so.slice(0, i1) : so, second: i1 >= 0 ? so.slice(i1) : "", out };
}

describe("pending-land sweep: a landed fix on an open row's edit_site proposes the close, never makes it", () => {
  let run: ReturnType<typeof sweepTwiceInIsolation> | null = null;
  let byId = new Map<unknown, Record<string, unknown>>();
  const runOnce = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = sweepTwiceInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    return run;
  };
  const meta = (k: string) => (byId.get(`lc-${k}`)!.classification_metadata ?? {}) as Record<string, unknown>;
  const view = (k: string) => {
    const m = meta(k);
    const p = m.landed_close_proposal as Record<string, unknown> | undefined;
    const c = m.landed_close_check as Record<string, unknown> | undefined;
    return {
      status: byId.get(`lc-${k}`)!.status, closed_reason: m.closed_reason ?? null, pending: m.pending_outcome_verification ?? null,
      proposal: p ? { fixing_sha: p.fixing_sha, head: p.head, verdict: p.verdict, detector: p.detector } : null,
      check: c ? { fixing_sha: c.fixing_sha, verdict: c.verdict } : null,
    };
  };
  const calls = (txt: string, k: string) => txt.split("\n").filter((l) => l.startsWith(`TS_CALL test/lc-${k}.test.ts`)).length;

  it("the real sweep ran twice", () => {
    const r = runOnce();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP2_DONE ") }, r.out.slice(-3000)).toEqual({ exit: 0, ran: true });
  });
  it("MUST-FAIL: a row whose edit_site got a commit that makes its check pass is flagged closable in one sweep (and stays open)", () => {
    const r = runOnce();
    const proposed = (k: string) => ({ status: "open", closed_reason: null, pending: null, proposal: { fixing_sha: fixSha[k], head, verdict: "absent", detector: "gap-sweep:landed_close_proposal" }, check: { fixing_sha: fixSha[k], verdict: "absent" } });
    expect({ fixed: view("fixed"), bare: view("bare") }, r.out.slice(-3000)).toEqual({ fixed: proposed("fixed"), bare: proposed("bare") });
    // The check ran on the clone HEAD (the live tree), and the human panel was asked.
    expect(r.first.includes(`TS_CALL test/lc-fixed.test.ts ${head}`), r.first.slice(-2000)).toBe(true);
    expect(r.first.includes("ASK landed-close-proposal-lc-fixed")).toBe(true);
    expect(readFileSync(GAPS_PATH, "utf8").includes("landed_verified")).toBe(false);
  });
  it("CONTROL: a row whose check still fails stays open with no proposal; an untouched edit_site and a prose-only must-fail are not proposed", () => {
    const r = runOnce();
    const plain = (k: string) => ({ status: view(k).status, closed_reason: view(k).closed_reason, pending: view(k).pending, proposal: view(k).proposal });
    const open = { status: "open", closed_reason: null, pending: null, proposal: null };
    expect({ red: plain("red"), untouched: plain("untouched"), prose: plain("prose") }, r.out.slice(-2000)).toEqual({ red: open, untouched: open, prose: open });
    expect({ red: r.out.includes("ASK landed-close-proposal-lc-red"), untouched: calls(r.out, "untouched") }).toEqual({ red: false, untouched: 0 });
  });
  it("MUST-FAIL (bookkeeping): the still-red row records the commit it was judged against and the next sweep does not re-run it; the prose-only row is counted, not written", () => {
    const r = runOnce();
    expect(view("red").check, r.out.slice(-2000)).toEqual({ fixing_sha: fixSha.red, verdict: "present" });
    expect({ first: calls(r.first, "red"), second: calls(r.second, "red") }).toEqual({ first: 1, second: 0 });
    expect({ check: meta("prose").landed_close_check ?? null, untouched: meta("untouched").landed_close_check ?? null }).toEqual({ check: null, untouched: null });
    expect(/"landed_close_prose_only":1/.test(r.first), r.first.slice(-1500)).toBe(true);
  });
  it("MUST-FAIL (cost): only rows whose edit_site moved take the heavy read, and an already-judged edit_site commit is not read again", () => {
    const r = runOnce();
    // fixed, red and bare moved (3); untouched did not. The second sweep finds every moved edit_site already judged.
    expect({ first: /"landed_close_examined":3[,}]/.test(r.first), second: /"landed_close_examined":0[,}]/.test(r.second) }, r.out.slice(-2000)).toEqual({ first: true, second: true });
  });
});
