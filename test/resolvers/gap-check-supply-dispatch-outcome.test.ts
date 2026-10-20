// CHECK SUPPLY READS EVERY DISPATCH OUTCOME, AND AN OUTCOME IT CANNOT READ IS NEVER A FAILURE (S3).
//
// The supply dispatched a test-writing goal and then waited for new titles in the gap's check file; it never read the
// goal back, so a goal that ended not reached left the gap at goal_dispatched with nothing to say why, and a dispatch
// sent from another node (the gap store is shared, a goal's record lives only on the goal-host that ran it) could not be
// read at all. The contract, class by class (the gap's own check, gap-check-supply-outcome.test.ts, pins four cases):
//   - every dispatch records the node that sent it and its goal-host;
//   - running waits; running past the timeout is lost (timed_out); terminal and not reached is FAILED with the reach
//     reason; terminal and reached waits for its titles a grace, then is failed; any terminal status this code knows;
//   - UNKNOWN IS NEVER FAILED (G3): not found on the host, host unreachable, an HTTP error, no dispatch id, a status this
//     code does not know, a dispatch owned by another node: it waits and is reported, and only past a shaped bound is it
//     lost, recording WHY;
//   - G6: a goal in flight is never sent a second one; another node's dispatch is never probed here;
//   - a settled attempt is a debit (beta), a dispatch alone credits nothing;
//   - an absent or unreadable autonomyScope skips nothing here and is reported.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-dispatch-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUBSTRATE_NAME"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SUBSTRATE_NAME"] = "node-a";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;
const has = (name: string): boolean => typeof supply[name] === "function";

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const H = 3_600_000;
const BOUNDS = { stale_ms: 24 * H, timeout_ms: 6 * H, title_grace_ms: 2 * H, foreign_stale_ms: 72 * H };
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const sentAgo = (hours: number): string => new Date(NOW - hours * H).toISOString();

describe("checkSupplyScopeTargets: each target is one real repo path (C-doublepath-1)", () => {
  it("a repos/-prefixed site, a bare vessel-relative site and no site each give repos/<v>/<rel> once, plus the check file", () => {
    const tf = "test/checks/g.check.ts";
    expect(supply.checkSupplyScopeTargets("v-vessel", "repos/v-vessel/src/a/b.ts", tf)).toEqual(["repos/v-vessel/src/a/b.ts", "repos/v-vessel/test/checks/g.check.ts"]);
    expect(supply.checkSupplyScopeTargets("v-vessel", "src/a/b.ts:12", tf)).toEqual(["repos/v-vessel/src/a/b.ts", "repos/v-vessel/test/checks/g.check.ts"]);
    expect(supply.checkSupplyScopeTargets("v-vessel", null, tf)).toEqual(["repos/v-vessel/", "repos/v-vessel/test/checks/g.check.ts"]);
    for (const t of supply.checkSupplyScopeTargets("v-vessel", "repos/v-vessel/src/a/b.ts", tf) as string[]) expect(t.split("repos/").length - 1).toBe(1);
  });
});

describe("dispatchVerdict: every outcome class (G1), unknown never failed (G3)", () => {
  type Case = [string, Row, unknown, string, string | null];
  // [label, ledger extras, probe (null = not probed), expected kind, expected why (lost/wait) or reason fragment (failed)]
  const local = { dispatch_id: "d-1", dispatch_node: "node-a", test_file: "test/checks/x.check.ts" };
  const cases: Case[] = [
    ["running, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "running", reached: null }, "running", null],
    ["pending, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "pending" }, "running", null],
    ["queued, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "queued" }, "running", null],
    ["running past the timeout", { ...local, last_dispatch_at: sentAgo(7) }, { http: 200, status: "running" }, "lost", "timed_out"],
    ["completed, not reached", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "completed", reached: false, reach_reason: "the check file was not written" }, "failed", "the check file was not written"],
    ["failed, reached null", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "failed", reached: null }, "failed", "ended failed, not reached"],
    ["refused", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "refused", reached: false }, "failed", "ended refused"],
    ["cancelled", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "cancelled", reached: false }, "failed", "ended cancelled"],
    ["error", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "error" }, "failed", "ended error"],
    ["timed_out status", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "timed_out", reached: false }, "failed", "ended timed_out"],
    ["completed and reached, inside the title grace", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "completed", reached: true }, "awaiting_titles", null],
    ["completed and reached, no title after the grace", { ...local, last_dispatch_at: sentAgo(3) }, { http: 200, status: "completed", reached: true }, "failed", "no new test title appeared in test/checks/x.check.ts"],
    ["not found on the host, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: 404 }, "wait", "not_found_on_host"],
    ["not found on the host, stale", { ...local, last_dispatch_at: sentAgo(30) }, { http: 404 }, "lost", "not_found_on_host"],
    ["host unreachable, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: "unreachable", error: "ECONNREFUSED" }, "wait", "host_unreachable"],
    ["host unreachable, stale", { ...local, last_dispatch_at: sentAgo(30) }, { http: "unreachable", error: "ECONNREFUSED" }, "lost", "host_unreachable"],
    ["HTTP 500, stale", { ...local, last_dispatch_at: sentAgo(30) }, { http: 500 }, "lost", "host_unreachable"],
    ["a status this code does not know, young", { ...local, last_dispatch_at: sentAgo(1) }, { http: 200, status: "hibernating" }, "wait", "unrecognised_status"],
    ["a status this code does not know, stale", { ...local, last_dispatch_at: sentAgo(30) }, { http: 200, status: "hibernating" }, "lost", "unrecognised_status"],
    ["no dispatch id, young", { dispatch_node: "node-a", last_dispatch_at: sentAgo(1) }, null, "wait", "no_dispatch_id"],
    ["no dispatch id, stale", { dispatch_node: "node-a", last_dispatch_at: sentAgo(30) }, null, "lost", "no_dispatch_id"],
    ["another node's dispatch, inside its bound", { dispatch_id: "d-1", dispatch_node: "node-b", last_dispatch_at: sentAgo(30) }, null, "wait", "owning_node_never_settled"],
    ["another node's dispatch, past its bound", { dispatch_id: "d-1", dispatch_node: "node-b", last_dispatch_at: sentAgo(80) }, null, "lost", "owning_node_never_settled"],
    ["legacy ledger (no node), not found here, stale", { dispatch_id: "d-1", last_dispatch_at: sentAgo(30) }, { http: 404 }, "lost", "not_found_on_host"],
  ];
  for (const [label, ledger, probe, kind, detail] of cases) {
    it(`${label} → ${kind}${detail && (kind === "lost" || kind === "wait") ? ` (${detail})` : ""}`, () => {
      expect(has("dispatchVerdict")).toBe(true);
      const v = supply.dispatchVerdict(ledger, probe, NOW, BOUNDS, "node-a");
      expect(v.kind).toBe(kind);
      if (kind === "lost" || kind === "wait") expect(v.why).toBe(detail);
      if (kind === "failed") expect(v.reason).toContain(detail);
      if (kind === "lost") expect(v.reason).toContain(`${detail}:`);
    });
  }

  it("a legacy ledger's lost reason says the dispatching node was not recorded", () => {
    expect(has("dispatchVerdict")).toBe(true);
    const v = supply.dispatchVerdict({ dispatch_id: "d-9", last_dispatch_at: sentAgo(30) }, { http: 404 }, NOW, BOUNDS, "node-a");
    expect(v.reason).toContain("the dispatching node was not recorded");
  });

  it("the settlement: a dispatch alone credits nothing; an armed check is alpha; a settled failure is beta", () => {
    expect(supply.checkSupplySettlementLeg({ dispatched: 3, armed: 0, refused: 0 })).toBeNull();
    expect(supply.checkSupplySettlementLeg({ dispatched: 3, armed: 1, refused: 2 })).toBe("alpha");
    expect(supply.checkSupplySettlementLeg({ dispatched: 0, armed: 0, refused: 1 })).toBe("beta");
  });
});

// ─── through the tick ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let probes: string[] = [];
let warnings: string[] = [];
let rhythms: Row[] = [];
let executions: Record<string, { status: string; reached: boolean | null; goalReachReason?: string }> = {};
let excluded: string[] | null = null;
let exceptions: string[] | undefined;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3, dispatch_stale_hours: 24, foreign_stale_hours: 72, ...extra },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test"), join(RUNTIME, VESSEL, "src")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const id = decodeURIComponent(exec[1]!);
      probes.push(id);
      const rec = executions[id];
      return rec ? Response.json({ dispatchId: id, ...rec }) : new Response("not found", { status: 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const rows = excluded === null ? [] : [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: excluded, require_falsifier_classes: ["class2"], ...(exceptions ? { excluded_path_exceptions: exceptions } : {}) } }];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  goals = []; probes = []; warnings = []; executions = {}; excluded = ["repos/some-other-vessel/"]; exceptions = undefined; rhythms = [dueRhythm()];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
async function seed(id: string, what: string, meta: Row = {}): Promise<void> {
  const summary = `${what} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const goalsFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);

describe("the tick records, reads and settles dispatch outcomes", () => {
  it("a dispatch records the node that sent it and its goal-host", async () => {
    const id = T("gcso-node");
    await seed(id, "records-node");
    await tick(Date.now() + 2000 * H);
    const led = ledgerOf(await storeRow(id));
    expect(led["dispatch_node"]).toBe("node-a");
    expect(String(led["dispatch_host"] ?? "")).toMatch(/^https?:\/\//);
  });

  it("a goal running past its timeout is lost (timed_out), never left in flight forever; the retry keeps its history", async () => {
    const id = T("gcso-inflight");
    await seed(id, "inflight");
    const t0 = Date.now() + 2100 * H;
    await tick(t0);
    executions[String(ledgerOf(await storeRow(id))["dispatch_id"])] = { status: "running", reached: null };
    const b = await tick(t0 + 25 * H); // past the 6 h timeout and the 24 h backoff: lost, then retried in the same tick
    expect(((b["outcomes"] as Row)["lost"] as Row[]).some((l) => l["id"] === id && l["why"] === "timed_out")).toBe(true);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("goal_dispatched");
    expect(goalsFor(id).length).toBe(2);
    const hist = led["history"] as Row[];
    expect(hist.length).toBe(1);
    expect(hist[0]).toMatchObject({ attempt: 1, state: "dispatch_lost" });
    expect((hist[0]!["outcome"] as Row)["lost_why"]).toBe("timed_out");
  });

  it("G6: a goal still running inside its timeout is not re-sent, whatever the backoff", async () => {
    rhythms = [dueRhythm({ backoff_hours: 1, dispatch_timeout_hours: 48 })];
    const id = T("gcso-running");
    await seed(id, "running");
    const t0 = Date.now() + 2200 * H;
    await tick(t0);
    executions[String(ledgerOf(await storeRow(id))["dispatch_id"])] = { status: "running", reached: null };
    await tick(t0 + 5 * H);
    expect(goalsFor(id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("goal_dispatched");
  });

  it("another node's dispatch is not probed here, waits loudly, and is lost past its bound with why", async () => {
    rhythms = [dueRhythm({ backoff_hours: 500 })]; // no same-tick retry: the settled state is read
    const id = T("gcso-foreign");
    const t0 = Date.now() + 2300 * H;
    await seed(id, "foreign", { check_supply: { state: "goal_dispatched", attempts: 1, last_dispatch_at: new Date(t0).toISOString(), test_file: "test/checks/f.check.ts", vessel: VESSEL, dispatch_id: "d-foreign-1", dispatch_node: "node-b" } });
    const b1 = await tick(t0 + 30 * H);
    expect(probes).not.toContain("d-foreign-1");
    expect(goalsFor(id).length).toBe(0);
    expect(((b1["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === id && w["why"] === "owning_node_never_settled")).toBe(true);
    expect(warnings.some((w) => w.includes(id) && w.includes("owning_node_never_settled"))).toBe(true);
    await tick(t0 + 80 * H);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("dispatch_lost");
    expect((led["outcome"] as Row)["lost_why"]).toBe("owning_node_never_settled");
    expect(String(led["reason"])).toContain("node-b");
  });

  it("not found on this node's goal-host: waits (reported) inside the bound, lost with why past it, never 'failed'", async () => {
    rhythms = [dueRhythm({ backoff_hours: 500 })]; // no same-tick retry: the settled state is read
    const id = T("gcso-404");
    await seed(id, "notfound");
    const t0 = Date.now() + 2400 * H;
    await tick(t0);
    const b1 = await tick(t0 + 2 * H);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("goal_dispatched");
    expect(((b1["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === id && w["why"] === "not_found_on_host")).toBe(true);
    await tick(t0 + 25 * H);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("dispatch_lost");
    expect((led["outcome"] as Row)["lost_why"]).toBe("not_found_on_host");
    expect((led["outcome"] as Row)["http"]).toBe(404);
  });

  it("a status this code does not know is reported, then lost with why; a failed outcome is a beta debit", async () => {
    rhythms = [dueRhythm({ backoff_hours: 500 })]; // no same-tick retry: the settled state is read
    const id = T("gcso-odd");
    await seed(id, "odd-status");
    const t0 = Date.now() + 2500 * H;
    await tick(t0);
    const did = String(ledgerOf(await storeRow(id))["dispatch_id"]);
    executions[did] = { status: "hibernating", reached: null };
    const b1 = await tick(t0 + 1 * H);
    expect(((b1["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === id && w["why"] === "unrecognised_status")).toBe(true);
    await tick(t0 + 25 * H);
    expect((ledgerOf(await storeRow(id))["outcome"] as Row)["lost_why"]).toBe("unrecognised_status");
    const id2 = T("gcso-debit");
    await seed(id2, "debit");
    const t1 = t0 + 100 * H;
    await tick(t1);
    executions[String(ledgerOf(await storeRow(id2))["dispatch_id"])] = { status: "completed", reached: false, goalReachReason: "no check written" };
    const b2 = await tick(t1 + 1 * H);
    expect(((b2["outcomes"] as Row)["failed"] as Row[]).some((f) => f["id"] === id2 && String(f["reason"]).includes("no check written"))).toBe(true);
    expect(Number(b2["refused"])).toBeGreaterThanOrEqual(1);
  });

  it("C-doublepath-1 MUST-FAIL: a scope-excluded edit site is recorded by its one real path, never repos/<v>/repos/<v>/…", async () => {
    excluded = [`repos/${VESSEL}/src/widget.ts`];
    const id = T("gcso-scopesite");
    await seed(id, "scopesite");
    await tick(Date.now() + 2600 * H);
    expect(goalsFor(id).length).toBe(0);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("scope_excluded");
    expect(String(l["reason"])).toContain(`target repos/${VESSEL}/src/widget.ts is excluded by the autonomy scope`);
    expect(String(l["reason"])).not.toContain(`repos/${VESSEL}/repos/`);
  });

  it("MUST-FAIL: a site its directory entry excepts by excluded_path_exceptions is supplied as the lane reads it, not skipped", async () => {
    excluded = [`repos/${VESSEL}/src/`];
    exceptions = [`repos/${VESSEL}/src/widget.ts`];
    const id = T("gcso-scopeexc");
    await seed(id, "scopeexc");
    await tick(Date.now() + 2600 * H);
    expect(ledgerOf(await storeRow(id))["state"]).not.toBe("scope_excluded");
    expect(goalsFor(id).length).toBe(1);
  });

  it("CONTROL: the same directory entry with no exception skips the site as scope-excluded", async () => {
    excluded = [`repos/${VESSEL}/src/`];
    const id = T("gcso-scopedir");
    await seed(id, "scopedir");
    await tick(Date.now() + 2600 * H);
    expect(goalsFor(id).length).toBe(0);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("scope_excluded");
  });

  it("an absent autonomyScope record skips nothing here and is reported", async () => {
    excluded = null;
    const id = T("gcso-noscope");
    await seed(id, "noscope");
    const b = await tick(Date.now() + 2600 * H);
    expect(goalsFor(id).length).toBe(1);
    expect(String(b["scope_unread"] ?? "")).toContain("no autonomyScope record");
  });
});
