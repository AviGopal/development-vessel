// A NEW RED CHECK LIFTS THE SCORE (user ruling). landabilityScore takes 0.1 per failed attempt (capped at 0.4) on a
// concrete-site row, so a hard-category row with five failed attempts scores 0.10 and the pick's LANDABILITY_FLOOR
// (0.15) drops it, even after the system measured its own check red_code_reachable at the vessel's current origin/dev.
// Those attempts were drafts with no check to certify them; the fresh red reading is that check. Such a reading now
// offsets exactly the failed-attempts term. A stale-sha, green, environmental or unrunnable reading (or none) keeps
// today's score, a row with no failed attempts is unchanged, and the floor stays 0.15.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `fresh-red-lift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
const CLONE = join(ROOT, "clones", "activity-api");
let HEAD = "";
const OTHER = "0".repeat(39) + "1";

beforeAll(() => {
  mkdirSync(CLONE, { recursive: true });
  const git = (args: string[], stdin?: string): string => {
    const p = Bun.spawnSync(["git", "-C", CLONE, ...args], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  git(["init", "-q"]);
  // The vessel's origin/dev: a ref is all vesselOriginDevSha reads (no commit, so no hook runs here).
  HEAD = git(["hash-object", "-w", "--stdin"], "fresh-red-lift fixture\n");
  git(["update-ref", "refs/remotes/origin/dev", HEAD]);
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const { landabilityScore, predictLand } = await import("../../src/judge/gap-attempt-credit.js");
const modAdmission = await import("../../src/judge/gap-admission.js") as Record<string, unknown>;
type Row = Record<string, unknown>;
const pickCandidate = modAdmission.pickCandidate as (g: Row[], hooks: unknown) => Row | null;
const orderByLandability = modAdmission.orderByLandability as (rows: Row[], byId?: unknown, headOf?: unknown) => Row[];

const TEST_FILE = "test/trace-list-bounded-newest-first.test.ts";
const ONLY = ["THE DEFECT: a no-dates first page costs a fraction of materialising the 24 h window"];
type Verdict = "red_code_reachable" | "green_at_parent" | "red_environmental" | "unrunnable";
// The live shape: a hard category (-0.4), a string edit_site (+0.3 +0.1), five failed attempts (-0.4): 0.10.
function row(id: string, o: { verdict?: Verdict; sha?: () => string; fa?: number; cat?: string; vessel?: string } = {}): Row {
  const meta: Row = {
    edit_site: "repos/activity-api/src/routes/execution-traces.ts",
    failed_attempts: o.fa ?? 5,
    evidence_resolve: { shape: "test_suite", input: { vessel: o.vessel ?? "activity-api", test_file: TEST_FILE, only_tests: ONLY } },
  };
  if (o.verdict) meta.own_check_baseline = { verdict: o.verdict, base_sha: (o.sha ?? (() => HEAD))(), test_file: TEST_FILE, only_tests: ONLY, vessel: "activity-api" };
  return { id, category: o.cat ?? "performance_inefficiency", source: "substrate_detected", summary: "list traces in bounded work", status: "open", classification_metadata: meta };
}
const headOf = (v: string): string | null => (v === "activity-api" ? HEAD : null);

describe("a fresh red own-check reading offsets the failed-attempts penalty", () => {
  it("MUST-FAIL (no new seam): predictLand's p for the hard row with a fresh red reading clears the 0.15 floor", () => {
    // predictLand reads the vessel's origin/dev itself (the clone fixture above); at the parent this p is 0.10.
    expect(predictLand(row("perf-fresh-red", { verdict: "red_code_reachable" })).p).toBeGreaterThanOrEqual(0.15);
    expect(predictLand(row("perf-fresh-red", { verdict: "red_code_reachable" })).p).toBeCloseTo(0.5, 6);
  });

  it("the score drops exactly the attempts term: 0.10 -> 0.50; a vessel spelled repos/<vessel> reads the same", () => {
    expect(landabilityScore(row("perf-none"))).toBeCloseTo(0.1, 6);
    expect(landabilityScore(row("perf-fresh-red", { verdict: "red_code_reachable" }), headOf)).toBeCloseTo(0.5, 6);
    expect(landabilityScore(row("perf-fresh-red-prefixed", { verdict: "red_code_reachable", vessel: "repos/activity-api" }), headOf)).toBeCloseTo(0.5, 6);
  });

  it("CONTROLS: a stale-sha, green, environmental or unrunnable reading, no reading, or no head keep today's 0.10", () => {
    expect(landabilityScore(row("perf-stale", { verdict: "red_code_reachable", sha: () => OTHER }), headOf)).toBeCloseTo(0.1, 6);
    for (const v of ["green_at_parent", "red_environmental", "unrunnable"] as const) {
      expect(landabilityScore(row(`perf-${v}`, { verdict: v }), headOf)).toBeCloseTo(0.1, 6);
    }
    expect(landabilityScore(row("perf-none"), headOf)).toBeCloseTo(0.1, 6);
    // No head handed in: nothing is fresh (the score as before).
    expect(landabilityScore(row("perf-fresh-red", { verdict: "red_code_reachable" }))).toBeCloseTo(0.1, 6);
    // A reading measured for another check (other titles) is not this row's reading.
    const other = row("perf-other-check", { verdict: "red_code_reachable" });
    ((other.classification_metadata as Row).own_check_baseline as Row).only_tests = ["another test"];
    expect(landabilityScore(other, headOf)).toBeCloseTo(0.1, 6);
    expect(predictLand(row("perf-stale", { verdict: "red_code_reachable", sha: () => OTHER })).p).toBeCloseTo(0.1, 6);
  });

  it("CONTROLS: no failed attempts is unchanged; a non-hard row moves only by the same offset", () => {
    expect(landabilityScore(row("perf-fa0", { fa: 0 }))).toBeCloseTo(0.5, 6);
    expect(landabilityScore(row("perf-fa0-red", { fa: 0, verdict: "red_code_reachable" }), headOf)).toBeCloseTo(0.5, 6);
    // failing_test is neither hard nor surgical: 0.9, four attempts 0.5, offset back to 0.9.
    expect(landabilityScore(row("ft-fa4", { fa: 4, cat: "failing_test" }), headOf)).toBeCloseTo(0.5, 6);
    expect(landabilityScore(row("ft-fa4-red", { fa: 4, cat: "failing_test", verdict: "red_code_reachable" }), headOf)).toBeCloseTo(0.9, 6);
    expect(landabilityScore(row("ft-fa4-green", { fa: 4, cat: "failing_test", verdict: "green_at_parent" }), headOf)).toBeCloseTo(0.5, 6);
  });

  it("the floor (0.15, unchanged) keeps the lifted row and still drops the stale one; the order puts it first", () => {
    // A live human exemption keeps the hopeless-category exclusion out of this (it reads a calibration file).
    const exempt = (r: Row): Row => { (r.classification_metadata as Row).human_exemption_attempts_remaining = 1; return r; };
    const pick = (rows: Row[]): string | null => {
      const log = console.log;
      console.log = () => {};
      try {
        const c = pickCandidate(rows, { lineageIndex: new Map(rows.map((g) => [String(g.id), g])), headOf, score: (g: Row) => landabilityScore(g, headOf), rerank: () => {}, onPicked: () => {}, ask: async () => null });
        return c ? String(c.id) : null;
      } finally { console.log = log; }
    };
    expect(pick([exempt(row("perf-fresh-red", { verdict: "red_code_reachable" }))])).toBe("perf-fresh-red");
    expect(pick([exempt(row("perf-stale", { verdict: "red_code_reachable", sha: () => OTHER }))])).toBeNull();
    const ordered = orderByLandability([row("backlog-ft-fa4", { fa: 4, cat: "failing_test" }), row("perf-fresh-red", { verdict: "red_code_reachable" })], undefined, headOf);
    // backlog-… scores 0.9 - 0.3 - 0.4 = 0.20; the lifted row 0.50 goes first.
    expect(ordered.map((r) => String(r.id))).toEqual(["perf-fresh-red", "backlog-ft-fa4"]);
  });
});
