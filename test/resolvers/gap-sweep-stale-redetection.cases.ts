// A RE-DETECTED GAP IS NOT RE-CLOSED ON A LANDING THAT PREDATES THE RE-DETECTION.
//
// Live (2026-10-03): performance-inefficiency-execution_traces_list was reopened by the efficiency
// probe every ~20 minutes (the route was still slow) and the pending-land sweep re-closed it each time
// as landed_verified, crediting activity-api 1bc78f89 (09-30) — a source-text check that was true since
// 09-30 and says nothing about the latency the detector had just measured. Every cycle appended another
// FAVORABLE outcome for the same old commit: 19 by the end of the day. Posterior inflation, not a fix.
//
// Pre-registered semantics (qa): a close of a RE-DETECTED gap counts only when the commit it credits
// landed AFTER the re-detection (the sweep's own evidence run is always after it), or when the check is a
// standing row measuring the symptom itself (self_fact_reconcile). Otherwise the sweep does not close,
// does not append a FAVORABLE outcome, and records stale_evidence_predates_redetection with the sha and
// both timestamps. And one landing is credited at most once per gap, however often it re-closes.
//
// Real git (a temp clone tree), the real gap store at a temp WORKSPACE_ROOT, fetch mocked per shape.
// Landed commits touch only test/ so the sweep reads them as running on this node without systemctl.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `stale-redetect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const STORE = sg.gapStoreRootForTest();
const GAPS_PATH = join(STORE, "gaps", "gaps.json");
const CLONES = join(ROOT, "clones");
const REPO = join(CLONES, "activity-api");
const CALIB = join(ROOT, "close-oracle-calibration.json");
const RUN = Math.random().toString(36).slice(2, 8);
type Row = Record<string, unknown>;

function git(env: Record<string, string>, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", REPO, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
/** A landing touching only test/ (read as running here); `when` back-dates author and committer. */
function land(name: string, when?: string): string {
  writeFileSync(join(REPO, "test", `${name}.txt`), `${name}\n`);
  git({}, "add", "test");
  const env = when ? { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } : {};
  git(env, "commit", "-q", "-m", `land ${name}`);
  return git({}, "rev-parse", "HEAD");
}

const HEALTHY = { shape: "health_probe", nonzero_field: "count" };
const STANDING = { shape: "self_fact_reconcile", input: { facts: ["trace_list_p99"], key: "k", plant_canary: false, file_gaps: false }, zero_field: "divergence_count" };
const T0 = "2026-09-30T07:00:00.000Z";
let shaC = "";
let shaCtrl = "";
let shaStanding = "";
const ids = { flap: `stale-flap-${RUN}`, ctrl: `stale-ctrl-${RUN}`, standing: `stale-standing-${RUN}` };

const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
const saved = { clones: process.env["VESSELS_CLONE_ROOT"], calib: process.env["CLOSE_ORACLE_CALIB_PATH"], exp: process.env["EXPECTATION_CALIB_PATH"] };

function readStore(): Row[] { return JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Row[]; }
function rowOf(id: string): Row { return readStore().find((g) => g["id"] === id)!; }
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
const favorables = (r: Row, sha: string): number =>
  ((metaOf(r)["approach_decisions"] ?? []) as Row[]).filter((d) => {
    const o = (d?.["outcome"] ?? {}) as Row;
    return o["landed"] === true && o["verdict"] === "FAVORABLE" && o["commit"] === sha;
  }).length;
const measuredCloses = (): number => {
  try { return (JSON.parse(readFileSync(CALIB, "utf8")) as Record<string, { closes: number }>)["measured"]?.closes ?? 0; } catch { return 0; }
};

/** The store write a detector makes when it re-observes the symptom on a closed row: a reopen. */
async function redetect(id: string): Promise<void> {
  const r = rowOf(id);
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: r["category"], source: r["source"], summary: r["summary"], status: "open", detected_at: new Date().toISOString(), classification_metadata: { ...metaOf(r) } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
/** A new landing stamped on the open gap, as the cutover's pending-land stamp does. */
async function stampLanding(id: string, sha: string): Promise<void> {
  const r = rowOf(id);
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: r["category"], source: r["source"], summary: r["summary"], status: "open", classification_metadata: { ...metaOf(r), pending_outcome_verification: sha, pending_set_at: new Date().toISOString(), disposition: "pending_verification" } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  if (!STORE.startsWith(tmpdir()) && !STORE.startsWith("/tmp/")) throw new Error(`gap store root ${STORE} is not a temp dir`);
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  process.env["CLOSE_ORACLE_CALIB_PATH"] = CALIB;
  process.env["EXPECTATION_CALIB_PATH"] = join(ROOT, "expectation-calibration.json");
  sg.__setBirthJudgeForTests(async () => "present");
  globalThis.fetch = (async (...args: unknown[]) => {
    const body = String((args[1] as { body?: string } | undefined)?.body ?? "");
    if (body.includes("health_probe")) return Response.json({ body: { count: 1 } });
    if (body.includes("self_fact_reconcile")) return Response.json({ body: { divergence_count: 0 } });
    return Response.json({ content: { vessels: [] } });
  }) as unknown as typeof fetch;

  mkdirSync(join(REPO, "test"), { recursive: true });
  git({}, "init", "-q");
  git({}, "config", "user.email", "test@test");
  git({}, "config", "user.name", "test");
  // A root commit first: diff-tree lists nothing for a root commit, which would read as touching src.
  writeFileSync(join(REPO, "README"), "clone\n");
  git({}, "add", "README");
  git({ GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z" }, "commit", "-q", "-m", "root");
  shaC = land(`c-${RUN}`, T0);
  shaCtrl = land(`ctrl-${RUN}`, T0);
  shaStanding = land(`standing-${RUN}`, T0);

  mkdirSync(join(STORE, "gaps"), { recursive: true });
  let existing: Row[] = [];
  try { existing = readStore(); } catch { /* fresh store */ }
  const base = { category: "performance_inefficiency", source: "substrate_detected", detected_at: "2026-09-18T18:12:13.767Z", first_detected_at: "2026-09-18T18:12:13.767Z", created_at: "2026-09-18T18:12:13.767Z", updated_at: T0 };
  const closedBy = (sha: string, er: Row): Row => ({
    edit_site: "repos/activity-api/src/routes/execution-traces.ts", evidence_resolve: er,
    pending_outcome_verification: sha, pending_set_at: T0, disposition: "pending_verification",
    approach_decisions: [{ at: T0, appended_by: "joinDecisionOutcome", outcome: { landed: true, verdict: "FAVORABLE", commit: sha, joined_at: T0 } }],
    closed_reason: "landed_verified", close_basis: "absent",
    falsifier_exercise: { detector: "gap-sweep", verdict: "absent", passed: true, ran_at: T0, commit: sha },
  });
  writeFileSync(GAPS_PATH, JSON.stringify([
    ...existing,
    // Closed by C at T0; a detector will reopen it.
    { ...base, id: ids.flap, summary: `list route slow ${RUN}`, status: "closed", closed_at: T0, reopen_count: 0, classification_metadata: closedBy(shaC, HEALTHY) },
    // CONTROL: never closed, never reopened; its landing is just as old. Closes as today.
    { ...base, id: ids.ctrl, summary: `never reopened ${RUN}`, status: "open", reopen_count: 0, classification_metadata: { evidence_resolve: HEALTHY, pending_outcome_verification: shaCtrl, pending_set_at: T0, disposition: "pending_verification" } },
    // STANDING ROW: its check measures the symptom itself, so a reopen-then-measured-clean close is valid.
    { ...base, id: ids.standing, summary: `standing row ${RUN}`, status: "closed", closed_at: T0, reopen_count: 0, classification_metadata: closedBy(shaStanding, STANDING) },
  ]));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  for (const [k, v] of [["VESSELS_CLONE_ROOT", saved.clones], ["CLOSE_ORACLE_CALIB_PATH", saved.calib], ["EXPECTATION_CALIB_PATH", saved.exp]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

describe("pending-land sweep on a RE-DETECTED gap", () => {
  it("control: a never-reopened gap closes on its (old) landing as today", async () => {
    await g2f.sweepPendingLandVerifications();
    const r = rowOf(ids.ctrl);
    expect(r["status"]).toBe("closed");
    expect((metaOf(r)["falsifier_exercise"] as Row)["commit"]).toBe(shaCtrl);
    expect(favorables(r, shaCtrl)).toBe(1);
  });

  it("the reopen stamps reopened_at (the re-detection time the guard compares against)", async () => {
    await redetect(ids.flap);
    const r = rowOf(ids.flap);
    expect(r["status"]).toBe("open");
    expect(r["reopen_count"]).toBe(1);
    expect(typeof r["reopened_at"]).toBe("string");
    expect(Date.parse(String(r["reopened_at"]))).toBeGreaterThan(Date.parse(T0));
  });

  it("(a) a commit landed BEFORE the re-detection does not re-close it and appends no FAVORABLE", async () => {
    const before = favorables(rowOf(ids.flap), shaC);
    const calibBefore = measuredCloses();
    await g2f.sweepPendingLandVerifications();
    const r = rowOf(ids.flap);
    const m = metaOf(r);
    expect(r["status"]).toBe("open");
    expect(favorables(r, shaC)).toBe(before);
    expect(measuredCloses()).toBe(calibBefore);
    const stale = m["stale_close_evidence"] as Row;
    expect(stale?.["reason"]).toBe("stale_evidence_predates_redetection");
    expect(stale?.["sha"]).toBe(shaC);
    expect(stale?.["committed_at"]).toBe(T0);
    expect(stale?.["redetected_at"]).toBe(r["reopened_at"]);
    // The stale landing no longer holds the gap pending: it is open for another attempt.
    expect(m["pending_outcome_verification"]).toBe("");
    expect(m["disposition"]).not.toBe("pending_verification");
    // And the next sweep does not take it again.
    await g2f.sweepPendingLandVerifications();
    expect(rowOf(ids.flap)["status"]).toBe("open");
    expect(favorables(rowOf(ids.flap), shaC)).toBe(before);
  });

  let shaC2 = "";
  it("(b) a NEW landing after the re-detection closes it and credits that landing once", async () => {
    // Committer time has whole-second resolution: land C' clearly after the reopen stamp.
    shaC2 = land(`c2-${RUN}`, new Date(Date.parse(String(rowOf(ids.flap)["reopened_at"] ?? new Date().toISOString())) + 2000).toISOString());
    await stampLanding(ids.flap, shaC2);
    await g2f.sweepPendingLandVerifications();
    const r = rowOf(ids.flap);
    expect(r["status"]).toBe("closed");
    expect((metaOf(r)["falsifier_exercise"] as Row)["commit"]).toBe(shaC2);
    expect(favorables(r, shaC2)).toBe(1);
  });

  it("(c) two further sweeps after (b) append nothing more", async () => {
    await g2f.sweepPendingLandVerifications();
    await g2f.sweepPendingLandVerifications();
    expect(favorables(rowOf(ids.flap), shaC2)).toBe(1);
  });

  it("(c') a standing row reopened and re-closed on the same landing credits it once, not per close", async () => {
    await redetect(ids.standing);
    const calibBefore = measuredCloses();
    await g2f.sweepPendingLandVerifications();
    let r = rowOf(ids.standing);
    // The standing row measures the symptom: a reopen followed by a clean measurement may close it.
    expect(r["status"]).toBe("closed");
    expect(metaOf(r)["stale_close_evidence"]).toBeUndefined();
    // ...but its landing was already credited at T0: no second FAVORABLE, no second measured close.
    expect(favorables(r, shaStanding)).toBe(1);
    expect(measuredCloses()).toBe(calibBefore);
    await redetect(ids.standing);
    await g2f.sweepPendingLandVerifications();
    r = rowOf(ids.standing);
    expect(r["status"]).toBe("closed");
    expect(favorables(r, shaStanding)).toBe(1);
  });
});

describe("joinDecisionOutcome is idempotent per (gap, commit) for a FAVORABLE landing", () => {
  it("a second FAVORABLE for the same commit is not appended, and says so", () => {
    const meta: Row = {};
    const first = g2f.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "abc1234" });
    const second = g2f.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "abc1234" });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((meta["approach_decisions"] as Row[]).length).toBe(1);
    // A different landing is a new outcome.
    expect(g2f.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "def5678" })).toBe(true);
    expect((meta["approach_decisions"] as Row[]).length).toBe(2);
  });
});
