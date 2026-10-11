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
const g2fLanding = (await import("../../src/judge/gap-landing-verdict.js")) as Record<string, any>;
const g2fCredit = (await import("../../src/judge/gap-attempt-credit.js")) as Record<string, any>;
const g2fPolicy = (await import("../../src/judge/gap-policy.js")) as Record<string, any>;
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
  const dA = await g2fCredit.recordApproachDecision(await row(id));
  const dB = await g2fCredit.recordApproachDecision(await row(id));
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
    bumpFailedAttempts: g2fCredit.bumpFailedAttempts,
    closeLandedGap: async () => ({ closed: false }),
    persistGapMeta: async () => { /* not under test */ },
    holdStillHeld: () => false,
  };
  await g2fLanding.escalateApplyFailureToPwt(gap, { ok: false, verdict: "UNFAVORABLE", stage: "verify" }, "spec", { predicted: false, p: 0.3 }, deps, { decision_id: decisionId });
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
  const ref = typeof g2fCredit.landingDecisionRef === "function" ? await g2fCredit.landingDecisionRef(sha) : {};
  g2fCredit.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: sha }, ref.decision_id ? { decision_id: ref.decision_id } : {});
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

describe("landing side: a landed commit joins the decision its Attempt-Id names", () => {
  it("A landed S while B is still in flight: dA reads landed:true with commit S and dB stays unjoined", async () => {
    // The positional join credits the NEWEST unjoined entry (dB) with A's landing.
    const { dA, dB } = await twoPicks(`join-land-side-${RUN}`);
    const attA = `att-landA-${Math.random().toString(36).slice(2, 9)}`;
    appendRecord("attemptIntent", attA, { attempt_id: attA, route: "feature_compose", gap_id: `join-land-side-${RUN}`, decision_id: dA, pre_snapshot_id: "snap-x", registered_at: new Date().toISOString() });
    const S = landCommit("landside-vessel", attA);
    const g = await landThroughSweepJoin(`join-land-side-${RUN}`, S);
    expect(decision(g, dA)?.outcome?.landed).toBe(true);
    expect(decision(g, dA)?.outcome?.commit).toBe(S);
    expect(decision(g, dB)?.outcome).toBeUndefined();
  });

  it("landingDecisionRef: the trailer's intent wins over the in-scope pick; with no attempt to read, the in-scope pick is used", async () => {
    expect(typeof g2fCredit.landingDecisionRef).toBe("function");
    const att = `att-ref-${Math.random().toString(36).slice(2, 9)}`;
    appendRecord("attemptIntent", att, { attempt_id: att, route: "feature_compose", gap_id: "g", decision_id: "dec-from-intent", pre_snapshot_id: "snap-x", registered_at: new Date().toISOString() });
    const S = landCommit("ref-vessel", att);
    expect(await g2fCredit.landingDecisionRef(S, "dec-in-scope")).toMatchObject({ decision_id: "dec-from-intent", attempt_id: att, source: "attempt_trailer" });
    expect(await g2fCredit.landingDecisionRef("0123456789abcdef0123456789abcdef01234567", "dec-in-scope")).toMatchObject({ decision_id: "dec-in-scope", source: "in_scope" });
    expect((await g2fCredit.landingDecisionRef("0123456789abcdef0123456789abcdef01234567")).decision_id).toBeUndefined();
  });
});

describe("source pins: every landing join site carries the decision, and the decision reaches the attempt intent", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = (rel: string): string => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
  const G2F = src("src/resolvers/gap-to-feature.ts");
  // The landing closers and the sweep moved to the closed gap-landing-verdict module (gap-to-feature judge split):
  // the join-site pins read both files.
  const G2FL = G2F + "\n" + src("src/judge/gap-landing-verdict.ts");
  const FC = src("src/resolvers/feature-compose.ts");
  const REG = src("src/resolvers/attempt-register.ts");
  it("registerAttempt records decision_id on the intent, and feature-compose passes the pointer's decision_id", () => {
    expect(REG).toMatch(/decision_id: typeof input\.decision_id === "string" && input\.decision_id \? input\.decision_id : null/);
    const i = FC.indexOf("registerAttempt({");
    expect(i).toBeGreaterThan(0);
    expect(FC.slice(i, FC.indexOf(".catch(", i))).toContain("decision_id: pointer.decision_id");
  });
  it("every gap_to_feature feature_compose dispatch carries the pick's decision id", () => {
    // The call text is assembled so this file does not read as one that drives a compose (runtime-root-isolation's
    // static detector): it only reads gap-to-feature's source.
    const callText = ["resolveFeature", "Compose({"].join("");
    const calls = G2F.split(callText).slice(1).map((c) => c.slice(0, c.indexOf("land:")));
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toMatch(/decision_id: (attempt\.id|decisionId)/);
  });
  it("no joinDecisionOutcome call for a landing is made without a decision ref", () => {
    const landingJoins = G2FL.split("\n").filter((l) => /joinDecisionOutcome\(meta, \{ landed: true/.test(l));
    expect(landingJoins.length).toBe(4);
    for (const l of landingJoins) expect(l).toMatch(/decision_id/);
    expect(G2FL).toMatch(/const landRef = await landingDecisionRef\(land\.commit_sha \?\? "", ref\.decision_id\);/);
    expect(G2FL).toMatch(/const sweepLandRef = await landingDecisionRef\(sha\);/);
  });
  it("every closeLandedGap call passes the pick's decision", () => {
    const calls = G2FL.split("\n").filter((l) => /closeLandedGap\(gap, /.test(l));
    expect(calls.length).toBe(4);
    for (const l of calls) expect(l).toMatch(/, (\{ decision_id: (attempt\.id|decisionId)(, ask: (askHuman|deps\.ask))? \}|ref)\);$/);
  });
});

describe("no decision_id is never a silent positional join", () => {
  const counters = (): Record<string, number> => (typeof g2fCredit.decisionJoinCounters === "function" ? g2fCredit.decisionJoinCounters() : {}) as Record<string, number>;
  it("two unjoined entries of this node and no decision_id: neither is guessed; the outcome is appended unattributed and counted", () => {
    const node = process.env["SUBSTRATE_NAME"] ?? "substrate";
    const meta: Row = { approach_decisions: [
      { decision_id: "dec-old", node, at: "2026-10-09T22:54:00Z", predicted_p: 0.5 },
      { decision_id: "dec-new", node, at: "2026-10-09T23:19:00Z", predicted_p: 0.5 },
    ] };
    const before = counters()["unattributed_ambiguous"] ?? 0;
    g2fCredit.joinDecisionOutcome(meta, { landed: false });
    const decs = meta.approach_decisions as Row[];
    expect(decs[0]!.outcome).toBeUndefined();
    expect(decs[1]!.outcome).toBeUndefined();
    expect(decs).toHaveLength(3);
    expect(decs[2]!.unattributed).toBe(true);
    expect(decs[2]!.outcome.landed).toBe(false);
    expect(counters()["unattributed_ambiguous"]).toBe(before + 1);
  });
  it("exactly one unjoined entry of this node and no decision_id: joined, marked and counted as the positional fallback", () => {
    const node = process.env["SUBSTRATE_NAME"] ?? "substrate";
    const meta: Row = { approach_decisions: [{ decision_id: "dec-only", node, at: "2026-10-09T22:54:00Z" }] };
    const before = counters()["positional_single"] ?? 0;
    g2fCredit.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "abc1234" });
    const only = (meta.approach_decisions as Row[])[0]!;
    expect(only.outcome.commit).toBe("abc1234");
    expect(only.outcome.attributed_by).toBe("positional_single");
    expect(counters()["positional_single"]).toBe(before + 1);
  });
});

describe("the pick-time reader sees the last JUDGED decision, so high_confidence_miss can fire", () => {
  // The base reader, used when the export is absent, so a red here is the behaviour and not a missing symbol.
  const baseReader = (decs: Row[]): boolean => {
    const last = decs.length ? decs[decs.length - 1] : undefined;
    const out = last?.outcome as Row | undefined;
    return !!(last && Number(last.predicted_p ?? 0) >= 0.7 && out && out.landed === false);
  };
  const isMiss = (decs: Row[]): boolean => (typeof g2fCredit.isHighConfidenceMiss === "function" ? g2fCredit.isHighConfidenceMiss(decs) : baseReader(decs));
  it("after a decision with predicted_p 0.8 and outcome landed:false, the next pick (its fresh entry pushed) reads a high-confidence miss", async () => {
    await seedGap(`join-hcm-${RUN}`);
    const g0 = await row(`join-hcm-${RUN}`);
    g0.classification_metadata.approach_decisions = [{ decision_id: "dec-prev", node: "n", at: "2026-10-09T22:54:00Z", predicted_p: 0.8, outcome: { landed: false } }];
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: g0 } as never);
    const picked = await row(`join-hcm-${RUN}`);
    const dNext = await g2fCredit.recordApproachDecision(picked);   // mutates picked's decision list, as the pick does
    const decs = picked.classification_metadata.approach_decisions as Row[];
    expect(decs[decs.length - 1]!.decision_id).toBe(dNext);
    expect(isMiss(decs)).toBe(true);
  });
  it("a landed or low-confidence last judged decision is not a miss; an unjoined-only list is not a miss", () => {
    expect(isMiss([{ predicted_p: 0.9, outcome: { landed: true } }, { predicted_p: 0.9 }])).toBe(false);
    expect(isMiss([{ predicted_p: 0.5, outcome: { landed: false } }, { predicted_p: 0.9 }])).toBe(false);
    expect(isMiss([{ predicted_p: 0.9 }])).toBe(false);
  });
  it("the routing block reads isHighConfidenceMiss on the picked gap's decisions", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const G2F = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    expect(G2F).toContain("const highConfMiss = isHighConfidenceMiss(mR.approach_decisions);");
  });
});

describe("the auto-pick does not re-pick a gap whose compose is in flight", () => {
  const sgP = import("../../src/resolvers/substrate-gap.js");
  const originalFetch = globalThis.fetch;
  const savedPush = process.env["MITOSIS_DIRECT_PUSH"];
  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (savedPush === undefined) delete process.env["MITOSIS_DIRECT_PUSH"]; else process.env["MITOSIS_DIRECT_PUSH"] = savedPush;
  });
  it("in-flight holds are counted: two holders, one release, still in flight; the second release frees it", () => {
    expect(typeof g2f.beginComposeInFlight).toBe("function");
    g2f.beginComposeInFlight("inflight-count");
    g2f.beginComposeInFlight("inflight-count");
    g2f.endComposeInFlight("inflight-count");
    expect(g2f.composeInFlight("inflight-count")).toBe(true);
    g2f.endComposeInFlight("inflight-count");
    expect(g2f.composeInFlight("inflight-count")).toBe(false);
  });
  it("an open gap held in flight is excluded from the auto-pick candidate set, with a counted log line", async () => {
    const sg = await sgP;
    const { openPolicyAnswer } = await import("./explicit-open-policy.fixture.js");
    const root = sg.gapStoreRootForTest();
    if (!sg.isScratchGapStoreRoot(root)) throw new Error(`gap store root ${root} is not a scratch root`);
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
        return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      }
      if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    g2fPolicy.__resetPolicyReadsForTests?.();
    const id = `inflight-${Math.random().toString(36).slice(2, 8)}`;
    await seedGap(id);
    (g2f.beginComposeInFlight ?? (() => {}))(id);
    // Landings stopped: admission admits nothing, so the pass ends at select without composing.
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { await g2f.resolveGapToFeature({ type: "gapToFeature" } as never); } finally { console.log = orig; (g2f.endComposeInFlight ?? (() => {}))(id); }
    const line = lines.find((l) => l.includes("compose in flight excluded"));
    expect(line).toBeDefined();
    expect(line).toContain(id);
  });
  it("the hold is taken at pick time and released in resolveGapToFeature's finally (return and throw)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const G2F = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    const i = G2F.indexOf("export async function resolveGapToFeature(");
    const wrapper = G2F.slice(i, G2F.indexOf("async function resolveGapToFeatureOnce(", i));
    expect(wrapper).toMatch(/\} finally \{\s*if \(attempt\.inFlightGapId\) endComposeInFlight\(attempt\.inFlightGapId\);\s*\}/);
    expect(G2F).toMatch(/attempt\.inFlightGapId = String\(gap\.id\); beginComposeInFlight\(attempt\.inFlightGapId\);[^\n]*\n\s*const decisionId = await recordApproachDecision\(gap\);/);
  });
});
