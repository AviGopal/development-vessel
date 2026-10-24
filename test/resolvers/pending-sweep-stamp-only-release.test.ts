// A STAMP-ONLY LANDING THE SWEEP MEASURES PRESENT IS RELEASED (qa condition on c01f55a3). The cutover stamps a landing
// with pending_outcome_verification=<sha> and NO disposition. Since c01f55a3 that stamp holds the row, so the sweep's
// measured-present release (liftLandVerificationHold) must release it too, or a cutover landing that did not fix its gap
// would be held forever.
//
// Through the REAL pending-land sweep, once, in a fresh process on a temp store and a temp vessel clone (the
// pending-sweep harness; test-only landings run without a restart; fetch stubbed).
// MUST-FAIL: a stamp-only row whose check reads PRESENT at the landed tree gets pending_released_sha = its stamp, keeps
//   the stamp, and is no longer held (red at bf068d73, the parent of c01f55a3).
// CONTROL: a stamp-only row whose check reads ABSENT at HEAD but whose pinned re-run does not ground the landing (red at
//   parent and at the landed sha) is not released: no marker, still held.
// CONTROL (referenced, not repeated): a parking or check-supply disposition is never lifted by the release:
//   test/resolvers/land-verification-hold-cutover-stamp.test.ts "CONTROL: a human or supply hold is never lifted".
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "./isolated-gap-store-run.js";
import { isAwaitingLandVerification } from "../../src/judge/gap-eligibility.js";

const ROOT = join(tmpdir(), `pending-sweep-stamp-only-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const check = (k: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/so-${k}.test.ts`, only_tests: [`so ${k}`] }, zero_field: "requested_not_passing" } });
const KEYS = ["present", "absent"] as const;
const shas: Record<string, { sha: string; parent: string }> = {};
let ready = false;

beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "root\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "root");
  for (const k of KEYS) {
    const parent = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "test", `landing-${k}.test.ts`), `// ${k}\n`); git(repo, "add", "."); git(repo, "commit", "-q", "-m", `landing ${k}`);
    shas[k] = { sha: git(repo, "rev-parse", "HEAD"), parent };
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  // Stamp-only, exactly as the cutover writes it (stampPendingLand): the sha, pending_set_at, the landed_unverified
  // fields and pending_unmeasurable; NO disposition.
  const stamp = (k: string) => ({ pending_outcome_verification: shas[k]!.sha, pending_set_at: now, landed_unverified: false, landed_unverified_reason: "", landed_unverified_sha: "", pending_unmeasurable: "" });
  writeFileSync(GAPS_PATH, JSON.stringify(KEYS.map((k) => ({
    id: `so-${k}`, category: `cat_so_${k}`, source: "substrate_detected", summary: `stamp-only ${k}`, detected_at: now, created_at: now, updated_at: now, status: "open",
    classification_metadata: { edit_site: "repos/development-vessel/src/x.ts", ...check(k), ...stamp(k) },
  }))));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    // so-present: red everywhere. so-absent: green at HEAD (no base_ref), red at every pinned tree (ungrounded).
    `  const red = String(p.test_file).includes("present") || !!p.base_ref;`,
    `  return new Response(JSON.stringify({ body: { ran: true, total: 1, pass: red ? 0 : 1, fail: red ? 1 : 0, skip: 0, requested_not_passing: red ? 1 : 0 } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    `const ask = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `console.log("SWEEP_RESULT " + JSON.stringify(await sweepPendingLandVerifications({ ask })));`,
  ].join("\n");
  const env: Record<string, string> = isolatedChildEnv(ROOT, {
    HOME: ROOT, PATH: BIN, VESSELS_CLONE_ROOT: CLONES,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    NODE_ENV: "test", TZ: "UTC",
  });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr) };
}

describe("pending-land sweep: a stamp-only landing measured present is released", () => {
  let run: { exit: number; out: string } | null = null;
  let byId = new Map<unknown, Record<string, any>>();
  const once = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = sweepInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, any>>).map((g) => [g.id, g]));
    return run;
  };
  const view = (k: string) => {
    const g = byId.get(`so-${k}`)!;
    const m = g.classification_metadata;
    return { status: g.status, stamp: m.pending_outcome_verification ?? null, released: m.pending_released_sha ?? null, held: isAwaitingLandVerification(g) };
  };
  it("the real sweep ran", () => {
    const r = once();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP_RESULT ") }, r.out.slice(-2500)).toEqual({ exit: 0, ran: true });
  });
  it("MUST-FAIL: measured PRESENT -> pending_released_sha = the stamp, the stamp kept, no longer held", () => {
    const r = once();
    expect(view("present"), r.out.slice(-2500)).toEqual({ status: "open", stamp: shas.present!.sha, released: shas.present!.sha, held: false });
  });
  it("CONTROL: measured ABSENT but not grounded -> not released, no marker, still held", () => {
    const r = once();
    expect(view("absent"), r.out.slice(-2500)).toEqual({ status: "open", stamp: shas.absent!.sha, released: null, held: true });
  });
});
