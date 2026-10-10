// THE UNGROUNDED-LABEL LOOP. The pending-land sweep's independent landing verdict re-runs the gap's own check at the
// landing's parent and at the landed sha. When both read green, the label is "parent green, landed green: the
// landing did not flip its own check": the check never saw the defect, so no re-run can ground the landing. The
// sweep stored that label and on every later tick read the check at HEAD, skipped the re-run and logged "is NOT
// closed: no grounded independent verdict" for the same landing, forever (the gap that landed c1a1ed7fc986: 48
// times in 72 h, diag-s1 2026-10-10).
//
// Now the gap is RELEASED from pending verification: pending_outcome_verification cleared, pending_released names
// the non-discriminating check and the landing, disposition needs_information (the existing parking state a human
// answer on the needs-human-<gap> panel clears). It is never closed.
//
// MUST-FAILS, through the REAL sweep run twice in a fresh process on a temp store and a temp vessel clone (the
// independent-landing-verdict harness; fetch stubbed, every check green):
//   (a) the released gap is NOT closed: open, no closed_reason, no landed_verified (a guard: green at parent too);
//   (b) it leaves the pending state with a reason naming the non-discriminating check;
//   (c) the next sweep does not log "NOT closed" for it again.
// Both triggers are covered: a label STORED by an earlier tick, and one computed FRESH in this pass. CONTROL: a
// stored "parent red, landed red" label is ungrounded but not non-discriminating: it stays pending, as before.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as g2f from "../../src/resolvers/gap-to-feature.js";

const ROOT = join(tmpdir(), `pending-sweep-non-discriminating-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const BIN = join(ROOT, "bin");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const GTF = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
const check = (k: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/nd-${k}.test.ts`, only_tests: [`nd ${k}`] }, zero_field: "requested_not_passing" } });
const KEYS = ["stored", "fresh", "redred"] as const;
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
    // A test-only landing that does not touch its own check file: "running" without a restart, not self-authored.
    writeFileSync(join(repo, "test", `landing-${k}.test.ts`), `// ${k}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `landing ${k}`);
    shas[k] = { sha: git(repo, "rev-parse", "HEAD"), parent };
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const label = (k: string, reason: string) => ({ grounded: false, labeler: "sweep-parent-child", sha: shas[k]!.sha, parent: shas[k]!.parent, tests: [`nd ${k}`], ran_at: now, reason });
  const rows = KEYS.map((k) => ({
    id: `nd-${k}`, category: `cat_${k}`, source: "substrate_detected", summary: `non-discriminating ${k}`,
    detected_at: now, created_at: now, updated_at: now, status: "open",
    classification_metadata: {
      ...check(k),
      pending_outcome_verification: shas[k]!.sha, pending_set_at: now, disposition: "pending_verification",
      ...(k === "stored" ? { goal_verification_label: label(k, "parent green, landed green: the landing did not flip its own check") } : {}),
      ...(k === "redred" ? { goal_verification_label: label(k, "parent red, landed red: the landing did not flip its own check") } : {}),
    },
  }));
  writeFileSync(GAPS_PATH, JSON.stringify(rows));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep twice, in a fresh process bound to ROOT. Every test_suite check reads green, at HEAD and pinned. */
function sweepTwiceInIsolation(): { exit: number; first: string; second: string; out: string } {
  const code = [
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  return new Response(JSON.stringify({ body: { ran: true, requested_not_passing: 0 } }), { status: 200 });`,
    `});`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GTF)});`,
    `const r1 = await sweepPendingLandVerifications();`,
    `console.log("SWEEP1_DONE " + JSON.stringify(r1));`,
    `const r2 = await sweepPendingLandVerifications();`,
    `console.log("SWEEP2_DONE " + JSON.stringify(r2));`,
  ].join("\n");
  const env: Record<string, string> = {
    HOME: ROOT, PATH: BIN, WORKSPACE_ROOT: ROOT, VESSELS_CLONE_ROOT: CLONES,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1", NODE_ENV: "test", TZ: "UTC",
  };
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const out = new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr);
  // stdout carries both markers in order; console.warn lines go to stderr, so split the log lines by marker on stdout
  // and keep stderr whole for the release line.
  const so = new TextDecoder().decode(p.stdout);
  const i1 = so.indexOf("SWEEP1_DONE");
  return { exit: p.exitCode ?? -1, first: i1 >= 0 ? so.slice(0, i1) : so, second: i1 >= 0 ? so.slice(i1) : "", out };
}

describe("pending-land sweep: a check green at the landing's parent releases the pending hold", () => {
  it("the predicate: only a non-shadow ungrounded 'parent green, landed green' label", () => {
    const base = { grounded: false, labeler: "sweep-parent-child", sha: "a".repeat(40), parent: "b".repeat(40), tests: [], ran_at: "x" };
    expect(g2f.nonDiscriminatingLandingLabel({ ...base, reason: "parent green, landed green: the landing did not flip its own check" })).toBe(true);
    expect(g2f.nonDiscriminatingLandingLabel({ ...base, reason: "parent green, landed green: the landing did not flip its own check", shadow: true })).toBe(false);
    expect(g2f.nonDiscriminatingLandingLabel({ ...base, reason: "parent red, landed red: the landing did not flip its own check" })).toBe(false);
    expect(g2f.nonDiscriminatingLandingLabel({ ...base, grounded: true, reason: "parent green, landed green" })).toBe(false);
    expect(g2f.nonDiscriminatingLandingLabel(null)).toBe(false);
  });

  let run: ReturnType<typeof sweepTwiceInIsolation> | null = null;
  let byId = new Map<unknown, Record<string, unknown>>();
  const runOnce = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = sweepTwiceInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    return run;
  };
  const view = (k: string) => {
    const g = byId.get(`nd-${k}`)!;
    const m = g.classification_metadata as Record<string, unknown>;
    const rel = m.pending_released as { reason?: unknown; check?: { test_file?: unknown }; landed?: unknown } | undefined;
    return {
      status: g.status, closed_reason: m.closed_reason ?? null, disposition: m.disposition ?? null,
      pending: m.pending_outcome_verification ?? null,
      released: rel ? { reason: rel.reason, test_file: rel.check?.test_file ?? null, landed: rel.landed } : null,
    };
  };
  const notClosed = (txt: string, k: string) => new RegExp(`gap nd-${k} .*NOT closed`).test(txt);

  it("the real sweep ran twice", () => {
    const r = runOnce();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP2_DONE ") }, r.out.slice(-3000)).toEqual({ exit: 0, ran: true });
  });
  it("MUST-FAIL (a): the released gaps are NOT closed: open, no closed_reason, nothing landed_verified", () => {
    const r = runOnce();
    for (const k of ["stored", "fresh"]) expect({ k, status: view(k).status, closed_reason: view(k).closed_reason }, r.out.slice(-2000)).toEqual({ k, status: "open", closed_reason: null });
    expect(readFileSync(GAPS_PATH, "utf8").includes("landed_verified")).toBe(false);
  });
  it("MUST-FAIL (b): they leave pending_verification with pending_released naming the non-discriminating check and the landing", () => {
    const r = runOnce();
    const released = (k: string) => ({ status: "open", closed_reason: null, disposition: "needs_information", pending: "", released: { reason: "non_discriminating_check", test_file: `test/nd-${k}.test.ts`, landed: shas[k]!.sha } });
    expect({ stored: view("stored"), fresh: view("fresh") }, r.out.slice(-3000)).toEqual({ stored: released("stored"), fresh: released("fresh") });
    expect(r.out.includes("released pending_verification on nd-stored: non_discriminating_check")).toBe(true);
  });
  it("MUST-FAIL (c): the next sweep does not log NOT closed for a released gap (nor does the first, for the stored label)", () => {
    const r = runOnce();
    expect({ stored_first: notClosed(r.first, "stored"), stored_second: notClosed(r.second, "stored"), fresh_second: notClosed(r.second, "fresh") }, r.out.slice(-3000))
      .toEqual({ stored_first: false, stored_second: false, fresh_second: false });
  });
  it("CONTROL: a stored red/red label (ungrounded, not non-discriminating) stays pending and still logs NOT closed", () => {
    const r = runOnce();
    expect(view("redred"), r.out.slice(-2000)).toEqual({ status: "open", closed_reason: null, disposition: "pending_verification", pending: shas.redred!.sha, released: null });
    expect(notClosed(r.second, "redred")).toBe(true);
  });
});
