// EACH APPROACH-DECISION OUTCOME JOINS ITS OWN DECISION (credit 1b). recordApproachDecision pushes a
// {decision_id: dec-…} entry on every pick, and an outcome used to join the NEWEST unjoined entry of the node,
// because no caller passed the decision id. Two overlapping picks of one gap then swapped outcomes: measured on
// the live store, gap idle-ticks-earn-alpha… was picked at 22:54 (dA) and 23:19 (dB); A failed, B landed
// 71ffac3, and dA read landed:true while dB read landed:false. These tests replay that and pin each join site.
//
// Driven through the REAL gap store under a temp WORKSPACE_ROOT, the real attempt ledger under a temp
// ATTEMPT_LEDGER_DIR, and a temp VESSELS_CLONE_ROOT holding a git repo whose commit carries the Attempt-Id
// trailer a cutover writes. Nothing reads or writes /workspace or /vessels.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "approach-decision-join-"));
const saved = { ws: process.env["WORKSPACE_ROOT"], ledger: process.env["ATTEMPT_LEDGER_DIR"], clones: process.env["VESSELS_CLONE_ROOT"], calib: process.env["EXPECTATION_CALIB_PATH"], oracle: process.env["CLOSE_ORACLE_CALIB_PATH"] };
process.env["WORKSPACE_ROOT"] = join(ROOT, "ws");
mkdirSync(process.env["WORKSPACE_ROOT"], { recursive: true });
process.env["ATTEMPT_LEDGER_DIR"] = join(ROOT, "ledger");
process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
mkdirSync(process.env["VESSELS_CLONE_ROOT"], { recursive: true });
// Calibration stores the gap-store holder and the close oracle write: kept in the sandbox too.
process.env["EXPECTATION_CALIB_PATH"] = join(ROOT, "expectation-calibration.json");
process.env["CLOSE_ORACLE_CALIB_PATH"] = join(ROOT, "close-oracle-calibration.json");
// Never shell the real gap-compose trigger from a test (see substrate-gap.test.ts).
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const { resolveSubstrateGap, resolveSubstrateGapWrite, gapStoreRootForTest, isScratchGapStoreRoot } = await import("../../src/resolvers/substrate-gap.js");
// The store root is frozen when substrate-gap.js first loads; in a one-process suite run another file may have
// loaded it first. Write fixtures only into a scratch (temp) store, never a checkout's gaps/ or /workspace.
const STORE_ROOT = gapStoreRootForTest();
const RUN = Math.random().toString(36).slice(2, 8);
const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as Record<string, any>;
const { appendRecord } = await import("../../src/resolvers/attempt-ledger.js");
type Row = Record<string, any>;

afterAll(() => {
  for (const [k, v] of [["WORKSPACE_ROOT", saved.ws], ["ATTEMPT_LEDGER_DIR", saved.ledger], ["VESSELS_CLONE_ROOT", saved.clones], ["EXPECTATION_CALIB_PATH", saved.calib], ["CLOSE_ORACLE_CALIB_PATH", saved.oracle]] as const) {
    if (v !== undefined) process.env[k] = v; else delete process.env[k];
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

async function row(id: string): Promise<Row> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 5 } as never);
  const g = ((r.body as { gaps?: Row[] }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error(`fixture row ${id} missing`);
  return g;
}
async function seedGap(id: string): Promise<void> {
  if (!isScratchGapStoreRoot(STORE_ROOT)) throw new Error(`gap store root ${STORE_ROOT} is not a scratch root; refusing to write fixtures`);
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: {
    id, category: "systematic_failure", source: "test", summary: `decision join fixture ${id}`, detected_at: "2026-10-09T22:00:00Z",
    classification_metadata: { edit_site: "repos/development-vessel/src/resolvers/x.ts" }, status: "open",
  } } as never);
}
/** Two picks of one gap, each recorded on a FRESH read of the row (as two overlapping ticks would). */
async function twoPicks(id: string): Promise<{ dA: string; dB: string }> {
  await seedGap(id);
  const dA = await g2f.recordApproachDecision(await row(id));
  const dB = await g2f.recordApproachDecision(await row(id));
  expect(typeof dA).toBe("string");
  expect(typeof dB).toBe("string");
  return { dA, dB };
}
const decisionsOf = (g: Row): Row[] => (g.classification_metadata?.approach_decisions ?? []) as Row[];
const decision = (g: Row, id: string): Row | undefined => decisionsOf(g).find((d) => d.decision_id === id);

/** The failure seam: escalateApplyFailureToPwt with a non-apply failure grades through deps.bumpFailedAttempts. */
async function failThroughSeam(gap: Row, decisionId: string): Promise<void> {
  const deps = {
    resolvePwt: async () => { throw new Error("pwt must not run for a non-apply failure"); },
    updateClassPosterior: () => { /* not under test */ },
    bumpFailedAttempts: g2f.bumpFailedAttempts,
    closeLandedGap: async () => ({ closed: false }),
    persistGapMeta: async () => { /* not under test */ },
    holdStillHeld: () => false,
  };
  await g2f.escalateApplyFailureToPwt(gap, { ok: false, verdict: "UNFAVORABLE", stage: "verify" }, "spec", { predicted: false, p: 0.3 }, deps, { decision_id: decisionId });
}

/** A vessel clone whose HEAD commit carries `Attempt-Id: <attemptId>`, as the mitosis cutover writes it. */
function landCommit(vessel: string, attemptId: string): string {
  const dir = join(process.env["VESSELS_CLONE_ROOT"]!, vessel);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  if (!Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-dir"], { stdout: "pipe", stderr: "pipe" }).success) git("init", "-q");
  writeFileSync(join(dir, "f.txt"), `${attemptId}\n`);
  git("add", "f.txt");
  git("commit", "-q", "-m", `feat: landed\n\nApplied autonomously.\n\nAttempt-Id: ${attemptId}`);
  return git("rev-parse", "HEAD");
}
/** The landing side as the sweep runs it: map the commit to its decision, then join. */
async function landThroughSweepJoin(id: string, sha: string): Promise<Row> {
  const g = await row(id);
  const meta = g.classification_metadata as Row;
  const ref = typeof g2f.landingDecisionRef === "function" ? await g2f.landingDecisionRef(sha) : {};
  g2f.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: sha }, ref.decision_id ? { decision_id: ref.decision_id } : {});
  return g;
}

describe("failure side: bumpFailedAttempts joins the decision it is given", () => {
  it("a failure graded through deps.bumpFailedAttempts for dA writes dA, not the newer dB", async () => {
    const { dA, dB } = await twoPicks(`join-fail-side-${RUN}`);
    await failThroughSeam(await row(`join-fail-side-${RUN}`), dA);
    const after = await row(`join-fail-side-${RUN}`);
    expect(decision(after, dA)?.outcome?.landed).toBe(false);
    expect(decision(after, dB)?.outcome).toBeUndefined();
  });
});

describe("replay of the 22:54 / 23:19 swap", () => {
  it("A failed and B landed S: dA reads landed:false and dB reads landed:true with commit S", async () => {
    const { dA, dB } = await twoPicks(`join-replay-${RUN}`);
    await failThroughSeam(await row(`join-replay-${RUN}`), dA);
    const attB = `att-replay-${Math.random().toString(36).slice(2, 9)}`;
    appendRecord("attemptIntent", attB, { attempt_id: attB, route: "feature_compose", gap_id: `join-replay-${RUN}`, decision_id: dB, pre_snapshot_id: "snap-x", registered_at: new Date().toISOString() });
    const S = landCommit("replay-vessel", attB);
    const g = await landThroughSweepJoin(`join-replay-${RUN}`, S);
    expect(decision(g, dA)?.outcome?.landed).toBe(false);
    expect(decision(g, dB)?.outcome?.landed).toBe(true);
    expect(decision(g, dB)?.outcome?.commit).toBe(S);
  });
});
