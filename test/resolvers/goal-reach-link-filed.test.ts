// A WALK THAT FILED ITS OWN PREREQUISITES HAS THEM LINKED TO ITS GOAL (S1: the goal-reach seam's link writer).
//
// goal-host records the gaps a non-reaching walk filed (goalWalkState learning.gapsFiled), and the goal-reach tick
// parks a goal on gaps whose demand_goals carry a {source:"goal_reach", goal_hash} entry, re-dispatching it when they
// close. Nothing wrote that entry (demand_goals_append had no writer), so every hollow walk stayed open_unlinked and
// nothing ever re-ran it. The contract, class by class:
//   - a terminal, non-reaching walk's filed gaps that are OPEN get the entry (idempotent on goal_hash+dispatch_id), and
//     the same tick's wait sees them (the goal goes waiting);
//   - 0, 1 or many filed gaps; duplicates within a walk; the same walk on a later tick (already linked); two goals on
//     one gap (both linked); any goal text;
//   - UNKNOWN IS LOUD (G3): a closed or missing gap, a non-id entry, an incomplete goal text, an I/O that cannot link:
//     reported in linked_filed.skipped with why (and journaled), never dropped; a closed gap is never reopened;
//   - a running or reaching walk links nothing; goalReachPolicy.link_filed_gaps:false links nothing;
//   - linking is bookkeeping, so it runs in dry-run too.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = join(tmpdir(), `gr-link-filed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const grt = (await import("../../src/resolvers/goal-reach-tick.js")) as Record<string, any>;
const sg = await import("../../src/resolvers/substrate-gap.js");
const { mergeDemandGoal, linkedGoalHashes } = await import("../../src/lib/demand-goals.js");
const has = (name: string): boolean => typeof grt[name] === "function";

type Row = Record<string, unknown>;
const T0 = Date.parse("2030-02-01T00:00:00.000Z");
const POLICY = { ...grt.DEFAULT_GOAL_REACH_POLICY, dry_run: false, link_filed_gaps: true };

function dispatch(id: string, goal: string, over: Row = {}): Row {
  return { dispatchId: id, goal, goal_full: true, status: "failed", reached: false, operator: "rhythm-conductor-drain", trigger: "operator", startedAt: T0, endedAt: T0 + 60_000, node: "n", executionId: `e-${id}`, selectedTemplateId: null, ...over };
}

/** An in-memory gap store with the real merge semantics: append only while open, idempotent. */
function storeIO(gaps: Record<string, { status: string; demand_goals?: unknown[] }>, dispatches: Row[], extra: Row = {}) {
  const records: Record<string, unknown> = {};
  const writes: Array<{ id: string; entry: Row }> = [];
  const io: Row = {
    writes, gaps, records,
    listDispatches: async () => ({ ok: true, dispatches }),
    readGaps: async () => ({ ok: true, gaps: Object.entries(gaps).map(([id, g]) => ({ id, status: g.status, source: "goal_host", closed_reason: null, closed_at: null, edit_site: null, demand_goals: g.demand_goals ?? [] })) }),
    readLandings: async () => ({ ok: true, landings: [] }),
    scopeExcludes: async () => () => null,
    loadRecords: async () => ({ ...records }),
    saveRecord: async (r: Row) => { records[String(r["goal_hash"])] = JSON.parse(JSON.stringify(r)); },
    dispatchGoal: async () => ({ ok: true, dispatch_id: "r-1", coalesced: false }),
    readTemplatesSince: async () => ({ ok: true, templates: [] }),
    attachExtractionEvidence: async () => ({ ok: true }),
    fileLimitProposal: async () => ({ ok: true }),
    linkFiledGap: async (id: string, entry: Row) => {
      const g = gaps[id];
      if (!g) return { ok: false, reason: "not_found", why: `gap ${id} not found` };
      if (g.status !== "open") return { ok: false, reason: "closed", why: `gap ${id} is ${g.status}` };
      const next = mergeDemandGoal(g.demand_goals, entry as never);
      const linked = next.length !== (g.demand_goals ?? []).length;
      g.demand_goals = next;
      if (linked) writes.push({ id, entry });
      return { ok: true, linked };
    },
    ...extra,
  };
  return io;
}
const tick = async (io: Row, policy: Row = POLICY, at = T0 + 3_600_000) => grt.runGoalReachTick(io, policy, at);
const quiet = <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return f().finally(() => { console.log = l; console.warn = w; }); };

describe("linkFiledGaps through the tick (G1 class table)", () => {
  it("MUST-FAIL at parent: a hollow walk that filed gap X yields X with a goal_reach demand entry, still open, and the goal waits on it", async () => {
    expect(has("linkFiledGaps")).toBe(true);
    const goal = "summarise the open incidents of the week into one report";
    const io = storeIO({ "gap-x": { status: "open", demand_goals: ["an older goal text (legacy string)"] } }, [dispatch("d1", goal, { gaps_filed: ["gap-x"] })]);
    const out = await quiet(() => tick(io));
    const g = (io["gaps"] as Record<string, Row>)["gap-x"]!;
    expect(g["status"]).toBe("open");
    expect(linkedGoalHashes(g["demand_goals"])).toEqual([grt.goalHashOf(goal)]);
    expect((g["demand_goals"] as unknown[])[0]).toBe("an older goal text (legacy string)");
    expect(out.linked_filed.linked).toEqual([{ gap_id: "gap-x", goal_hash: grt.goalHashOf(goal), dispatch_id: "d1" }]);
    const rec = (io["records"] as Record<string, Row>)[grt.goalHashOf(goal)]!;
    expect(rec["status"]).toBe("waiting");
    expect(rec["waiting_on"]).toEqual(["gap-x"]);
  });

  const table: Array<[string, Row[], Record<string, { status: string }>, number, number, string[]]> = [
    // [label, dispatches, gaps, linked, already, skipped whys (prefix)]
    ["no filed gaps", [dispatch("a", "goal a", { gaps_filed: [] })], {}, 0, 0, []],
    ["one filed gap", [dispatch("b", "goal b", { gaps_filed: ["g1"] })], { g1: { status: "open" } }, 1, 0, []],
    ["many filed gaps", [dispatch("c", "goal c", { gaps_filed: ["g1", "g2", "g3"] })], { g1: { status: "open" }, g2: { status: "open" }, g3: { status: "open" } }, 3, 0, []],
    ["a duplicate within one walk", [dispatch("d", "goal d", { gaps_filed: ["g1", "g1"] })], { g1: { status: "open" } }, 1, 0, []],
    ["two goals filing one gap", [dispatch("e1", "goal e one", { gaps_filed: ["g1"] }), dispatch("e2", "goal e two", { gaps_filed: ["g1"] })], { g1: { status: "open" } }, 2, 0, []],
    ["a closed gap (never reopened)", [dispatch("f", "goal f", { gaps_filed: ["g1"] })], { g1: { status: "closed" } }, 0, 0, ["closed"]],
    ["a missing gap", [dispatch("g", "goal g", { gaps_filed: ["nope"] })], {}, 0, 0, ["not_found"]],
    ["an entry that is not a gap id", [dispatch("h", "goal h", { gaps_filed: [{ id: "g1" }, 7, ""] })], { g1: { status: "open" } }, 0, 0, ["not a gap id", "not a gap id", "not a gap id"]],
    ["a still-running walk", [dispatch("i", "goal i", { status: "running", reached: null, gaps_filed: ["g1"] })], { g1: { status: "open" } }, 0, 0, []],
    ["a reaching walk", [dispatch("j", "goal j", { status: "completed", reached: true, gaps_filed: ["g1"] })], { g1: { status: "open" } }, 0, 0, []],
    ["an incomplete goal text", [dispatch("k", "x".repeat(400), { goal_full: false, gaps_filed: ["g1"] })], { g1: { status: "open" } }, 0, 0, ["the goal text is incomplete"]],
  ];
  for (const [label, dispatches, gaps, linked, already, whys] of table) {
    it(`${label}: linked ${linked}, already ${already}, not linked ${whys.length}`, async () => {
      expect(has("linkFiledGaps")).toBe(true);
      const io = storeIO(JSON.parse(JSON.stringify(gaps)), dispatches);
      const out = await quiet(() => tick(io));
      expect(out.linked_filed.linked.length).toBe(linked);
      expect(out.linked_filed.already).toBe(already);
      const got = out.linked_filed.skipped.map((s: Row) => String(s["why"]));
      expect(got.length).toBe(whys.length);
      whys.forEach((w, i) => expect(got[i]!.startsWith(w)).toBe(true));
      for (const [id, g] of Object.entries(io["gaps"] as Record<string, Row>)) if ((gaps as Record<string, Row>)[id]!["status"] === "closed") expect(g["status"]).toBe("closed");
    });
  }

  it("the same walk on a later tick is already linked (idempotent: one entry, no second write)", async () => {
    expect(has("linkFiledGaps")).toBe(true);
    const io = storeIO({ g1: { status: "open" } }, [dispatch("m", "goal m", { gaps_filed: ["g1"] })]);
    await quiet(() => tick(io));
    const second = await quiet(() => tick(io, POLICY, T0 + 7_200_000));
    expect(second.linked_filed.linked.length).toBe(0);
    expect(second.linked_filed.already).toBe(1);
    expect((io["writes"] as unknown[]).length).toBe(1);
    expect(((io["gaps"] as Record<string, Row>)["g1"]!["demand_goals"] as unknown[]).length).toBe(1);
  });

  it("goalReachPolicy.link_filed_gaps:false links nothing; an I/O without the link method reports it", async () => {
    expect(has("linkFiledGaps")).toBe(true);
    const off = storeIO({ g1: { status: "open" } }, [dispatch("n", "goal n", { gaps_filed: ["g1"] })]);
    const o1 = await quiet(() => tick(off, { ...POLICY, link_filed_gaps: false }));
    expect(o1.linked_filed).toEqual({ linked: [], already: 0, skipped: [] });
    const noLink = storeIO({ g1: { status: "open" } }, [dispatch("o", "goal o", { gaps_filed: ["g1"] })], { linkFiledGap: undefined });
    const o2 = await quiet(() => tick(noLink));
    expect(o2.linked_filed.skipped.map((s: Row) => s["why"])).toEqual(["this I/O cannot link gaps"]);
  });

  it("linking is bookkeeping: it runs under dryRunIO too, while the re-dispatch stays a would-action", async () => {
    expect(has("linkFiledGaps")).toBe(true);
    const io = storeIO({ g1: { status: "open" } }, [dispatch("p", "goal p", { gaps_filed: ["g1"] })]);
    const out = await quiet(() => tick(grt.dryRunIO(io), { ...POLICY, dry_run: true }));
    expect(out.linked_filed.linked.length).toBe(1);
    expect(linkedGoalHashes((io["gaps"] as Record<string, Row>)["g1"]!["demand_goals"])).toEqual([grt.goalHashOf("goal p")]);
  });

  it("a not-linked filing is journaled (loud), naming the gap and why", async () => {
    expect(has("linkFiledGaps")).toBe(true);
    const lines: string[] = [];
    const w = console.warn, l = console.log;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.log = () => {};
    try { await tick(storeIO({ g1: { status: "closed" } }, [dispatch("q", "goal q", { gaps_filed: ["g1"] })])); } finally { console.warn = w; console.log = l; }
    expect(lines.some((s) => s.includes("filed gap g1 of dispatch q NOT linked: closed"))).toBe(true);
  });
});

describe("the default I/O links against the real gap store", () => {
  let gapStore: { restore: () => Promise<void> } | null = null;
  beforeAll(() => {
    gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
    const root = sg.gapStoreRootForTest();
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
    mkdirSync(join(root, "gaps"), { recursive: true });
  });
  afterAll(async () => {
    await gapStore?.restore();
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  });
  const RUN = Math.random().toString(36).slice(2, 8);
  async function seed(id: string, status: string, meta: Row): Promise<void> {
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "capability_gap", source: "goal_host", status, detected_at: new Date().toISOString(), summary: `fixture ${RUN}: a capability the walk needed was missing`, classification_metadata: meta } } as never);
    if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
    await sg.__settleBirthEvaluationsForTests();
  }
  async function row(id: string): Promise<Row | undefined> {
    const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
    return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  }
  const entry = (h: string, d: string) => ({ source: "goal_reach" as const, goal_hash: h, dispatch_id: d, origin: "autonomous" as const });

  it("an open gap gains the entry, keeps its other metadata and stays open; a second call is already-linked", async () => {
    expect(has("defaultGoalReachIO")).toBe(true);
    const id = `gr-link-open-${RUN}`;
    await seed(id, "open", { demand_goals: ["legacy goal text"], edit_site: "repos/demo-vessel/src/a.ts" });
    const io = grt.defaultGoalReachIO(POLICY);
    expect(typeof io.linkFiledGap).toBe("function");
    expect(await io.linkFiledGap(id, entry("abcd1234", "d-1"))).toEqual({ ok: true, linked: true });
    const g = await row(id);
    const meta = (g?.["classification_metadata"] ?? {}) as Row;
    expect(g?.["status"]).toBe("open");
    expect(meta["edit_site"]).toBe("repos/demo-vessel/src/a.ts");
    expect(meta["demand_goals"]).toEqual(["legacy goal text", entry("abcd1234", "d-1")]);
    expect(await io.linkFiledGap(id, entry("abcd1234", "d-1"))).toEqual({ ok: true, linked: false });
  });

  it("a closed gap is not linked and not reopened; a missing gap is not_found", async () => {
    expect(has("defaultGoalReachIO")).toBe(true);
    const id = `gr-link-closed-${RUN}`;
    await seed(id, "open", {});
    await seed(id, "closed", { closed_reason: "fixture: closed", closed_by: "goal-reach-link-filed.test.ts" }); // the store closes only a stored row, with evidence
    const io = grt.defaultGoalReachIO(POLICY);
    const r = await io.linkFiledGap(id, entry("abcd1234", "d-2"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("closed");
    const g = await row(id);
    expect(g?.["status"]).toBe("closed");
    expect(linkedGoalHashes(((g?.["classification_metadata"] ?? {}) as Row)["demand_goals"])).toEqual([]);
    expect((await io.linkFiledGap(`gr-link-absent-${RUN}`, entry("abcd1234", "d-3"))).reason).toBe("not_found");
  });
});

// THE DEADLOCK (#2): a gap judged by the goal's own reach (its falsifier is a later reach) can never close while the goal waits
// on it. A LANDING on an open linked gap, newer than the last attempt, re-runs the goal ONCE; nothing else moves. The landing
// never closes the gap or touches its falsifier; budgets and scope still win; a reach by that re-run records its chain.
describe("a landing on an open linked gap re-runs its goal once (no deadlock)", () => {
  const G = `compile the open purchase orders by supplier ${Math.random().toString(36).slice(2, 6)}`;
  const H = grt.goalHashOf(G);
  const P = { ...grt.DEFAULT_GOAL_REACH_POLICY, dry_run: false, max_cycles: 3, max_cost_usd: 5 };
  const link = { source: "goal_reach", goal_hash: H, dispatch_id: "d1", origin: "autonomous" };
  const gapv = (over: Row = {}): Row => ({ id: "gd-1", status: "open", source: "goal_reach_tick", closed_reason: null, closed_at: null, edit_site: null, demand_goals: [link], ...over });
  const rec = (dispatches: Row[], gaps: Row[]): Row => { const recs = grt.observe({}, dispatches, T0 + 3_600_000); const r = recs[H]; grt.linkGaps(r, gaps); return r; };
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const d1 = dispatch("d1", G, { startedAt: T0, endedAt: T0 + 60_000 });

  it("MUST-FAIL baseline: an open linked gap with NO landing still waits", () => {
    expect(grt.nextAction(rec([d1], [gapv()]), [gapv()], P).kind).toBe("wait");
  });
  it("a landing newer than the last attempt re-runs the goal, naming the landing", () => {
    const g = gapv({ landed_at: at(10), landed_sha: "abc123def456" });
    const a = grt.nextAction(rec([d1], [g]), [g], P);
    expect(a.kind).toBe("redispatch");
    expect(a.landed).toEqual([{ gap: "gd-1", sha: "abc123def456", at: at(10) }]);
  });
  it("an UNVERIFIED fix landing (the cutover's stamp with landed_unverified, as for a gap with no own check) re-runs the goal once", () => {
    // the stamp stampPendingLand writes for a pushed fix landing on a gap with no test_suite check (vessel-mitosis-cutover.ts)
    const meta = { pending_outcome_verification: "9e1f00d2c0ffee", pending_set_at: at(12), landed_unverified: true, landed_unverified_reason: "gap carries no test_suite check", landed_unverified_sha: "9e1f00d2c0ffee" };
    const g = gapv({ landed_at: meta.pending_set_at, landed_sha: meta.pending_outcome_verification });
    const a = grt.nextAction(rec([d1], [g]), [g], P);
    expect(a.kind).toBe("redispatch");
    expect(a.landed).toEqual([{ gap: "gd-1", sha: "9e1f00d2c0ffee", at: at(12) }]);
  });
  it("MUST-FAIL: a landing time with no pending sha (a cleared landing) is no landing: still waits", () => {
    const g = gapv({ landed_at: at(10), landed_sha: "" });
    expect(grt.nextAction(rec([d1], [g]), [g], P).kind).toBe("wait");
  });
  it("MUST-FAIL: a landing OLDER than the last attempt does not re-run it (that attempt already tested it)", () => {
    const g = gapv({ landed_at: at(-10), landed_sha: "abc123def456" });
    expect(grt.nextAction(rec([d1], [g]), [g], P).kind).toBe("wait");
  });
  it("MUST-FAIL: one re-run per landing: after the re-run (newer than the landing) the goal waits again", () => {
    const g = gapv({ landed_at: at(10), landed_sha: "abc123def456" });
    const d2 = dispatch("r-1", G, { startedAt: T0 + 20 * 60_000, endedAt: T0 + 21 * 60_000 });
    expect(grt.nextAction(rec([d1, d2], [g]), [g], P).kind).toBe("wait");
  });
  it("a landing never overrides scope or budget: blocked_by_scope and budget:cycles still win", () => {
    const g = gapv({ landed_at: at(10), landed_sha: "abc123def456", edit_site: "repos/x/src/locked.ts" });
    const a = grt.nextAction(rec([d1], [g]), [g], P, { scopeExcludes: (p: string) => (p.includes("locked") ? "excluded" : null) });
    expect(a.kind).toBe("stop");
    expect(String(a.reason)).toMatch(/^blocked_by_scope:/);
    const r = rec([d1], [g]); r.cycles = 3;
    expect(grt.nextAction(r, [g], P)).toEqual({ kind: "stop", reason: "budget:cycles" });
  });
  it("MUST-FAIL: through a tick the landing re-runs the goal and NOTHING is written to the gap (it closes only on goal_reach_verdict)", async () => {
    const g = gapv({ landed_at: at(10), landed_sha: "abc123def456" });
    const records: Record<string, unknown> = {};
    const gapWrites: unknown[] = [];
    const dispatched: Row[] = [];
    const io: Row = {
      listDispatches: async () => ({ ok: true, dispatches: [d1] }),
      readGaps: async () => ({ ok: true, gaps: [g] }),
      readLandings: async () => ({ ok: true, landings: [] }),
      scopeExcludes: async () => () => null,
      loadRecords: async () => ({ ...records }),
      saveRecord: async (r: Row) => { records[String(r["goal_hash"])] = JSON.parse(JSON.stringify(r)); },
      dispatchGoal: async (req: Row) => { dispatched.push(req); return { ok: true, dispatch_id: "r-1", coalesced: false }; },
      readTemplatesSince: async () => ({ ok: true, templates: [] }),
      attachExtractionEvidence: async () => ({ ok: true }),
      fileLimitProposal: async () => ({ ok: true }),
      linkFiledGap: async (...a: unknown[]) => { gapWrites.push(a); return { ok: true }; },
    };
    const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
    let res: Row;
    try { res = await grt.runGoalReachTick(io, { ...P, link_filed_gaps: false }, T0 + 30 * 60_000); } finally { console.log = l; console.warn = w; }
    expect(dispatched.length).toBe(1);
    expect((dispatched[0]!["tags"] as string[])).toContain("goal_reach_landing:abc123def456");
    expect(gapWrites).toEqual([]);
    expect(g["status"]).toBe("open");
    expect(Object.keys(g).some((k) => /falsifier|evidence_resolve/.test(k))).toBe(false);
    const saved = records[H] as Row;
    expect(saved["redispatch_triggers"]).toEqual([{ dispatch_id: "r-1", landed: [{ gap: "gd-1", sha: "abc123def456", at: at(10) }] }]);
    expect((res!["redispatched"] as Row[]).map((x) => x["dispatch_id"])).toEqual(["r-1"]);
  });
  it("a reach by that re-run records its chain (landing sha -> redispatch id -> reach); another R re-run records none", () => {
    const g = gapv({ landed_at: at(10), landed_sha: "abc123def456" });
    const r = rec([d1, dispatch("r-1", G, { startedAt: T0 + 20 * 60_000, status: "completed", reached: true })], [g]);
    r.r_issued = ["r-1", "r-2"];
    r.redispatch_triggers = [{ dispatch_id: "r-1", landed: [{ gap: "gd-1", sha: "abc123def456", at: at(10) }] }];
    r.reached_dispatch_id = "r-1";
    expect(grt.attributeReach(r, [g], [], T0 + 60 * 60_000)).toEqual({ attribution: "r", reasons: ["landing:gd-1@abc123def456->redispatch:r-1->reach"] });
    r.reached_dispatch_id = "r-2";
    r.dispatches.push({ ...r.dispatches[r.dispatches.length - 1], dispatchId: "r-2" });
    expect(grt.attributeReach(r, [g], [], T0 + 60 * 60_000).reasons).toEqual([]);
  });
});
