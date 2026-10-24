// ORPHANED SIBLING CHECKS AT VERIFICATION (REALIGNMENT §2.2; law 7). A narrowed row armed ONE check of a check-first
// file, a landing turned that check green with a dead export, and the file's other checks for the same edit site stayed
// red while the row read verified (activity-api 3997ea6: 4 pass / 3 fail in src/routes/deliverable-shapes-resolver-
// claim.test.ts; the root that armed them all and the narrowed child were both closed, so nobody owned the red checks).
// The rule (qa design, orphan-based): a row closes verified only if every RED check in its armed file is armed by some
// OTHER OPEN row.
//
// Through the REAL pending-land sweep, once, in a fresh process on a temp store and a temp vessel clone (the
// pending-sweep harness). fetch is stubbed: a named check is red only at its landing's parent; a whole-file run (no name
// filter) reports the file's failing tests.
// MUST-FAIL: a hand-narrowed row armed to one check, with sibling checks red that NO open row arms, is NOT verified: it
//   stays open and pending, with the orphans named on it.
// CONTROL A: two open rows each arming one check of one file; one lands while the other's check is red: verified.
// CONTROL B: a single-check file (the whole-file run has nothing else red): verified, unchanged.
// A whole-file run that cannot be read refuses the close too (fail closed), and the refusal says so on the row.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv, childUnitSeamLine } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `pending-sweep-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const check = (file: string, name: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/${file}.test.ts`, only_tests: [name] }, zero_field: "requested_not_passing" } });
// The whole file's failing tests at the landed tree, by file (what a run with no name filter reports).
const WHOLE_FILE_RED: Record<string, string[]> = {
  "test/claim.test.ts": ["claim > the promote gate and deliverable-shapes consult the same object", "claim > builtin claims"],
  "test/pair.test.ts": ["pair > a two"],
  "test/single.test.ts": [],
};
const KEYS = ["orphan", "pair", "single", "unread"] as const;
const shas: Record<string, { sha: string; parent: string }> = {};
let ready = false;

beforeAll(() => {
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
  for (const k of KEYS) {
    const parent = git(repo, "rev-parse", "HEAD");
    // A test-only landing that does not touch its own check file: running without a restart, not self-authored.
    writeFileSync(join(repo, "test", `landing-${k}.test.ts`), `// ${k}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `landing ${k}`);
    shas[k] = { sha: git(repo, "rev-parse", "HEAD"), parent };
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now, status: "open" };
  const pending = (k: string) => ({ pending_outcome_verification: shas[k]!.sha, pending_set_at: now });
  writeFileSync(GAPS_PATH, JSON.stringify([
    // The hand-narrowed child: one check of claim.test.ts; its root (which armed the rest) is closed.
    { ...base, id: "orph-root", category: "cat_root", summary: "root", status: "closed", classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/claim.test.ts" } } } },
    { ...base, id: "orph-narrowed", category: "cat_orphan", summary: "narrowed to one check", classification_metadata: { ...check("claim", "claim contents"), ...pending("orphan") } },
    // A legitimate decomposition: two open rows, one check each of pair.test.ts.
    { ...base, id: "pair-one", category: "cat_pair_one", summary: "pair one", classification_metadata: { ...check("pair", "a one"), ...pending("pair") } },
    { ...base, id: "pair-two", category: "cat_pair_two", summary: "pair two", classification_metadata: { ...check("pair", "a two") } },
    { ...base, id: "unread", category: "cat_unread", summary: "whole-file run unreadable", classification_metadata: { ...check("unread", "unread one"), ...pending("unread") } },
    { ...base, id: "single", category: "cat_single", summary: "single check file", classification_metadata: { ...check("single", "single"), ...pending("single") } },
  ]));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepInIsolation(): { exit: number; out: string } {
  const parents: Record<string, string> = { "test/claim.test.ts": shas.orphan!.parent, "test/pair.test.ts": shas.pair!.parent, "test/single.test.ts": shas.single!.parent, "test/unread.test.ts": shas.unread!.parent };
  const code = [
    `const PARENTS = ${JSON.stringify(parents)};`,
    `const WHOLE = ${JSON.stringify(WHOLE_FILE_RED)};`,
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  const named = Array.isArray(p.only_tests) && p.only_tests.length > 0;`,
    `  console.log("TS_CALL " + String(p.test_file) + " named=" + named + " ref=" + String(p.base_ref ?? ""));`,
    `  if (!named && p.test_file === "test/unread.test.ts") return new Response(JSON.stringify({ body: { ran: false } }), { status: 200 });`,
    `  if (!named) { const f = WHOLE[p.test_file] ?? []; return new Response(JSON.stringify({ body: { ran: true, total: f.length + 1, pass: 1, fail: f.length, skip: 0, failingTests: f } }), { status: 200 }); }`,
    `  const red = p.base_ref === PARENTS[p.test_file];`,
    `  return new Response(JSON.stringify({ body: { ran: true, total: 1, pass: red ? 0 : 1, fail: red ? 1 : 0, skip: 0, requested_not_passing: red ? 1 : 0, failingTests: [] } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    childUnitSeamLine(GLV),
    `const __askHuman = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `const r = await sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
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

describe("pending-land sweep: a verified close refuses red sibling checks no other open row arms", () => {
  let run: ReturnType<typeof sweepInIsolation> | null = null;
  let byId = new Map<unknown, Record<string, unknown>>();
  const runOnce = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = sweepInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    return run;
  };
  const view = (id: string) => {
    const g = byId.get(id)!;
    const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
    const o = m.orphan_sibling_refusal as { sha?: unknown; orphans?: unknown } | undefined;
    return { status: g.status, closed_reason: m.closed_reason ?? null, pending: m.pending_outcome_verification ?? null, orphans: o ? { sha: o.sha, orphans: o.orphans } : null, measured: o ? (o as { measured?: unknown }).measured : null };
  };

  it("the real sweep ran", () => {
    const r = runOnce();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP_RESULT ") }, r.out.slice(-3000)).toEqual({ exit: 0, ran: true });
  });
  it("MUST-FAIL: a row narrowed to one check, with sibling checks red that no open row arms, is NOT verified; the orphans are named", () => {
    const r = runOnce();
    expect(view("orph-narrowed"), r.out.slice(-3000)).toEqual({
      status: "open", closed_reason: null, pending: shas.orphan!.sha,
      orphans: { sha: shas.orphan!.sha, orphans: WHOLE_FILE_RED["test/claim.test.ts"] }, measured: true,
    });
  });
  it("MUST-FAIL (fail closed, said): a row whose armed file's whole run cannot be read is not verified, and the row says why", () => {
    const r = runOnce();
    expect(view("unread"), r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, pending: shas.unread!.sha, orphans: { sha: shas.unread!.sha, orphans: [] }, measured: false });
  });
  it("CONTROL A: one of two open rows splitting a file lands while the other's check is red: verified", () => {
    const r = runOnce();
    expect([view("pair-one").status, view("pair-one").closed_reason, view("pair-one").orphans], r.out.slice(-3000)).toEqual(["closed", "landed_verified", null]);
    expect(view("pair-two").status).toBe("open");
  });
  it("CONTROL B: a single-check file is verified, unchanged", () => {
    const r = runOnce();
    expect([view("single").status, view("single").closed_reason, view("single").orphans], r.out.slice(-3000)).toEqual(["closed", "landed_verified", null]);
  });
});
