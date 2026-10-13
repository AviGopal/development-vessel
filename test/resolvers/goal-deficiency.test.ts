// R2 — A GOAL THAT KEEPS FAILING ONE NAMED CONTENT JUDGMENT GETS ONE OPEN, LINKED GAP (S2: recognition).
//
// Expected, class by class (the tables vary the reason, the count, the window, the store's prior row, and the policy):
//   - reasons are classed by a SHAPED, ordered class map; abstains and phantom missing-producer reasons are kept but
//     never counted; a reason no rule matches is unclassified: counted and sampled, never filed (G3);
//   - at >= min_runs not-reached runs of one goal sharing a class (within the window, after its last TRUSTED reach) ONE
//     open gap per (goal, class), id goal-deficiency-<hash>-<class>, linked by a demand_goals_append entry, no edit_site,
//     a class-2 falsifier on goal_reach_verdict; below the threshold, or split across classes, nothing;
//   - guards: an unread store files nothing; a closed row reopens only on >= min_runs failures since closed_at; rejected
//     never refiled; unknown status left alone; budget per call, highest count first; file_gaps 0 files nothing;
//   - LENIENCY (G6, the frozen loop's known risk): a reach whose judge path matches a shaped lenient rule does NOT zero
//     unreached_since_last_reach, and is reported reached_lenient; a trusted reach zeroes it;
//   - the summary is the judge's words and the goal text only: no suggested fix or producer (the answer-key rule).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = join(tmpdir(), `goal-deficiency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const gd = (await import("../../src/resolvers/goal-deficiency.js").catch(() => ({}))) as Record<string, any>;
const grt = (await import("../../src/resolvers/goal-reach-tick.js")) as Record<string, any>;
const sg = await import("../../src/resolvers/substrate-gap.js");
const pool = await import("../../src/resolvers/pool-impulse.js");
const { linkedGoalHashes } = await import("../../src/lib/demand-goals.js");
const has = (name: string): boolean => typeof gd[name] === "function";

type Row = Record<string, any>;
const H = 3_600_000;
const NOW = Date.parse("2030-03-01T00:00:00.000Z");
const P = () => JSON.parse(JSON.stringify(gd.DEFAULT_GOAL_DEFICIENCY_POLICY ?? {}));
const never = (): boolean | null => false;
const unknownAd = (): boolean | null => null;

function run(id: string, goal: string, hoursAgo: number, reached: boolean, reason: string, over: Row = {}): Row {
  return { dispatchId: id, goal_hash: grt.goalHashOf(goal), goal, status: reached ? "completed" : "failed", reached, operator: "rhythm-conductor-drain", origin: "autonomous", startedAt: NOW - hoursAgo * H, endedAt: NOW - hoursAgo * H + 60_000, goalReachReason: reason, completionShapes: [], selectedTemplateId: null, ...over };
}
function tallyFrom(runs: Row[], policy = P()): Record<string, Row> {
  return gd.tallyUpdate({}, runs, NOW, policy, never).tallies;
}

describe("the policy is shaped (law 1, G5)", () => {
  it("absent → the defaults; a partial record merges over them", () => {
    expect(has("parseDeficiencyPolicy")).toBe(true);
    const d = gd.parseDeficiencyPolicy(null);
    expect(d.ok && d.policy.min_runs).toBe(3);
    const r = gd.parseDeficiencyPolicy({ min_runs: 5, lenient_reach: [{ shapes: ["someLenientShape"] }] });
    expect(r.ok && r.policy.min_runs).toBe(5);
    expect(r.ok && r.policy.lenient_reach).toEqual([{ shapes: ["someLenientShape"] }]);
    expect(r.ok && r.policy.window_hours).toBe(168);
  });
  const bad: Array<[string, unknown]> = [
    ["not an object", [1]], ["min_runs below 2", { min_runs: 1 }], ["a fraction", { window_hours: 2.5 }], ["file_gaps 2", { file_gaps: 2 }],
    ["a class token that is not canonical", { classes: [{ class: "Bad-Token", patterns: ["x"] }] }], ["a pattern that does not compile", { classes: [{ class: "ok_one", patterns: ["("] }] }],
    ["a lenient rule naming no field", { lenient_reach: [{}] }], ["abstain patterns not a list", { abstain_patterns: "x" }],
  ];
  for (const [label, body] of bad) it(`invalid (${label}) → ok false: nothing is filed`, () => { expect(has("parseDeficiencyPolicy")).toBe(true); expect(gd.parseDeficiencyPolicy(body).ok).toBe(false); });
});

describe("classifyReason (G1: every default class, abstain, phantom, unclassified)", () => {
  const cases: Array<[string, string, string[], (s: string) => boolean | null, string | null]> = [
    ["deliverable not produced", "The required weeklyDigest was not produced; only partial shapes were generated.", [], never, "deliverable_not_produced"],
    ["required output not provided", "The output did not provide the required per-team totals, which fails the goal's intent.", [], never, "deliverable_not_produced"],
    ["did not address", "The answer did not address the second question at all.", [], never, "did_not_address"],
    ["ungrounded (free text)", "The figures are ungrounded: they cite nothing.", [], never, "ungrounded"],
    ["a judge code names its own class (the system's taxonomy first)", "deterministic:ungrounded-claim — the figures cite nothing.", [], never, "ungrounded_claim"],
    ["no substantive content", "The output has no substantive content, only general references and links.", [], never, "no_substantive_content"],
    ["execution error", "transport: Unable to connect to the peer.", [], never, "execution_error"],
    ["abstain", "abstain:cut-view — the deliverable did not fit the judge's view; not graded.", [], never, "abstain"],
    ["missing producer, shape in the inferred target", "no producer or constructible payload for missing shapes [teamDigest]", ["teamDigest"], never, "missing_producer"],
    ["missing producer, shape advertised", "no producer or constructible payload for missing shapes [teamDigest]", [], () => true, "missing_producer"],
    ["missing producer, vocabulary unjudgeable", "no producer or constructible payload for missing shapes [teamDigest]", [], unknownAd, "missing_producer"],
    ["PHANTOM: missing shapes neither targeted nor advertised", "no producer or constructible payload for missing shapes [sql_like,trace_like]", [], never, "phantom"],
    ["unclassified", "The moon is made of cheese.", [], never, null],
  ];
  for (const [label, reason, target, ad, cls] of cases) {
    it(`${label} → ${cls ?? "unclassified"}`, () => {
      expect(has("classifyReason")).toBe(true);
      expect(gd.classifyReason(reason, target, P(), ad).class).toBe(cls);
    });
  }
});

describe("tallyUpdate", () => {
  const G = "compile the weekly incident digest for the platform team";
  it("a goal is tallied from its first failure; a goal that only reached is not", () => {
    expect(has("tallyUpdate")).toBe(true);
    const t = tallyFrom([run("r1", "a goal that only ever reached", 5, true, "fine"), run("f1", G, 4, false, "The required digest was not produced.")]);
    expect(Object.keys(t)).toEqual([grt.goalHashOf(G)]);
    expect(t[grt.goalHashOf(G)]!.entries[0].class).toBe("deliverable_not_produced");
  });
  it("operator-written test goals are not tallied; running runs are skipped; a re-observation never erases a reason", () => {
    expect(has("tallyUpdate")).toBe(true);
    const up = gd.tallyUpdate({}, [run("t1", G, 4, false, "x not produced", { operator: "test:fixture" }), run("r", G, 3, false, "", { status: "running" })], NOW, P(), never);
    expect(up.ignored).toBe(1);
    expect(Object.keys(up.tallies)).toEqual([]);
    const first = gd.tallyUpdate({}, [run("f1", G, 4, false, "The required digest was not produced.")], NOW, P(), never).tallies;
    const again = gd.tallyUpdate(first, [run("f1", G, 4, false, "")], NOW, P(), never).tallies;
    expect(again[grt.goalHashOf(G)]!.entries[0].reason).toContain("not produced");
  });
  it("entries are capped at max_entries (newest kept)", () => {
    expect(has("tallyUpdate")).toBe(true);
    const runs = Array.from({ length: 15 }, (_, i) => run(`f${i}`, G, 20 - i, false, "not produced"));
    const t = gd.tallyUpdate({}, runs, NOW, { ...P(), max_entries: 10 }, never).tallies[grt.goalHashOf(G)]!;
    expect(t.entries.length).toBe(10);
    expect(t.entries[9].dispatch_id).toBe("f14");
  });
});

describe("deficiencyDecisions (G1 table: count, class split, window, reach, prior row, budget, switches)", () => {
  const G = "summarise the release notes of every service into one changelog";
  const h = () => grt.goalHashOf(G);
  const fails = (n: number, reason = "The required changelog was not produced.", from = 1) => Array.from({ length: n }, (_, i) => run(`d${from + i}`, G, 10 - i * 0.5, false, reason));
  const id = () => `goal-deficiency-${h()}-deliverable_not_produced`;

  const table: Array<[string, Row[], Map<string, Row> | null, Row, string[], string[]]> = [
    // [label, runs, existing rows, policy overrides, write kinds, skipped whys (prefix)]
    ["below the threshold (2)", fails(2), new Map(), {}, [], []],
    ["at the threshold (3)", fails(3), new Map(), {}, ["create"], []],
    ["above the threshold (5)", fails(5), new Map(), {}, ["create"], []],
    ["split across two classes (2 + 2)", [...fails(2), ...fails(2, "The answer did not address the question.", 10)], new Map(), {}, [], []],
    ["abstains and phantoms do not count", [...fails(2), run("a1", G, 3, false, "abstain: not graded"), run("p1", G, 2, false, "no producer or constructible payload for missing shapes [nope_shape]")], new Map(), {}, [], []],
    ["three abstains alone file nothing", [run("a1", G, 4, false, "abstain: not graded"), run("a2", G, 3, false, "abstain:cut-view"), run("a3", G, 2, false, "not graded (abstain)")], new Map(), {}, [], []],
    ["three phantoms alone file nothing", Array.from({ length: 3 }, (_, i) => run(`p${i}`, G, 4 - i, false, "no producer or constructible payload for missing shapes [nope_shape]")), new Map(), {}, [], []],
    ["outside the window", Array.from({ length: 3 }, (_, i) => run(`o${i}`, G, 400 + i, false, "The required changelog was not produced.")), new Map(), {}, [], []],
    ["failures before a trusted reach do not count", [...fails(3), run("ok", G, 0.5, true, "reached: the changelog was produced")], new Map(), {}, [], []],
    ["the store was not read", fails(3), null, {}, [], ["store_unread"]],
    ["file_gaps 0", fails(3), new Map(), { file_gaps: 0 }, [], ["file_gaps is 0"]],
    ["an open row with the same runs: nothing", fails(3), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "open", classification_metadata: { dispatch_ids: ["d1", "d2", "d3"] } }]]), {}, [], []],
    ["an open row with a new run: refresh", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "open", classification_metadata: { dispatch_ids: ["d1", "d2", "d3"] } }]]), {}, ["refresh"], []],
    ["a closed row, too few failures since it closed", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "closed", closed_at: new Date(NOW - 8.6 * H).toISOString() }]]), {}, [], []],
    ["a closed row, enough failures since it closed: reopen", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "closed", closed_at: new Date(NOW - 20 * H).toISOString() }]]), {}, ["reopen"], []],
    ["a closed row with no usable closed_at", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "closed" }]]), {}, [], ["closed with no usable closed_at"]],
    ["a rejected row is never refiled", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "rejected" }]]), {}, [], ["rejected by an operator"]],
    ["an unknown status is left alone", fails(4), new Map([[`goal-deficiency-${grt.goalHashOf(G)}-deliverable_not_produced`, { status: "parked" }]]), {}, [], ["stored status parked"]],
  ];
  for (const [label, runs, existing, over, kinds, whys] of table) {
    it(`${label} → writes [${kinds.join(",")}]${whys.length ? `, skipped ${whys.length}` : ""}`, () => {
      expect(has("deficiencyDecisions")).toBe(true);
      const policy = { ...P(), ...over };
      const d = gd.deficiencyDecisions(tallyFrom(runs, policy), existing, NOW, policy);
      expect(d.writes.map((w: Row) => w.kind)).toEqual(kinds);
      expect(d.skipped.length).toBe(whys.length);
      whys.forEach((w, i) => expect(String(d.skipped[i].why).startsWith(w)).toBe(true));
      for (const w of d.writes) {
        expect(w.id).toBe(id());
        expect(w.expect_status).toBe(w.kind === "create" ? undefined : w.kind === "refresh" ? "open" : "closed");
        expect(w.demand).toMatchObject({ source: "goal_reach", goal_hash: h() });
      }
    });
  }

  it("budget: creates go to the highest counts first; the rest are skipped with why", () => {
    expect(has("deficiencyDecisions")).toBe(true);
    const goals = ["goal one of three", "goal two of three", "goal three of three"];
    const runs = goals.flatMap((g, k) => Array.from({ length: 3 + k }, (_, i) => run(`${k}-${i}`, g, 10 - i * 0.5, false, "The required report was not produced.")));
    const d = gd.deficiencyDecisions(tallyFrom(runs), new Map(), NOW, { ...P(), max_new_per_run: 2 });
    expect(d.writes.map((w: Row) => w.count)).toEqual([5, 4]);
    expect(d.skipped.map((s: Row) => s.why)).toEqual(["budget: max_new_per_run reached"]);
  });

  it("unclassified reasons are reported with samples and never filed (G3)", () => {
    expect(has("deficiencyDecisions")).toBe(true);
    const d = gd.deficiencyDecisions(tallyFrom(fails(4, "Something nobody has a rule for happened.")), new Map(), NOW, P());
    expect(d.writes).toEqual([]);
    expect(d.unclassified).toEqual([{ goal_hash: h(), count: 4, samples: ["Something nobody has a rule for happened."] }]);
  });

  it("the gap row: judge's words + goal text, class-2 falsifier on goal_reach_verdict, no edit_site, NO suggested fix (answer-key rule)", () => {
    expect(has("deficiencyDecisions")).toBe(true);
    const goals = ["prepare the on-call handover note", "list every service whose certificate expires this month", "draft the quarterly cost summary per team"];
    const reasons = ["The required handover note was not produced.", "The output did not provide the required expiry dates.", "The required summary was not produced; only partial shapes were generated."];
    for (let k = 0; k < goals.length; k++) {
      const runs = Array.from({ length: 3 }, (_, i) => run(`s${k}-${i}`, goals[k]!, 10 - i, false, reasons[k]!));
      const w = gd.deficiencyDecisions(tallyFrom(runs), new Map(), NOW, P()).writes[0];
      const meta = w.gap.classification_metadata;
      expect(w.gap.summary).toContain(reasons[k]);
      expect(w.gap.summary).toContain(goals[k]);
      expect(meta.edit_site).toBeUndefined();
      expect(meta.kind).toBe("goal_content_deficiency");
      expect(meta.evidence_resolve).toEqual({ shape: "goal_reach_verdict", input: { goal_hash: grt.goalHashOf(goals[k]!) }, zero_field: "unreached_since_last_reach" });
      const own = String(w.gap.summary).replace(/"[^"]*"/g, "");
      expect(own).not.toMatch(/\b(compose|composing|mint|use\s+\w+|install|implement|suggest|should|producer|fix)\b/i);
      expect(Object.keys(meta).some((k2) => /suggest|fix|producer|plan/i.test(k2))).toBe(false);
    }
  });
});

describe("goalReachVerdict: the falsifier's read, leniency-aware (G6 must-fail)", () => {
  const G = "reconcile the billing exports with the ledger";
  const h = grt.goalHashOf(G);
  const lenient = { ...P(), lenient_reach: [{ shapes: ["looseShape"] }, { reason_patterns: ["^lenient:"] }, { template_patterns: ["loose-template"] }] };
  const base = [run("f1", G, 9, false, "The required reconciliation was not produced."), run("f2", G, 8, false, "The required reconciliation was not produced."), run("f3", G, 7, false, "The required reconciliation was not produced.")];

  it("no tally → measured false (the check reads unknown, never closed)", () => {
    expect(has("goalReachVerdict")).toBe(true);
    expect(gd.goalReachVerdict(h, null, P())).toMatchObject({ measured: false });
    expect(gd.goalReachVerdict("not-a-hash", null, P())).toMatchObject({ measured: false });
  });
  it("three failures → unreached 3; a TRUSTED reach after them → 0 with last_reached_at", () => {
    expect(has("goalReachVerdict")).toBe(true);
    expect(gd.goalReachVerdict(h, tallyFrom(base)[h], P())).toMatchObject({ measured: true, unreached_since_last_reach: 3, reached_lenient: false });
    const t = tallyFrom([...base, run("ok", G, 1, true, "reached: reconciliation produced", { completionShapes: ["reconciliationReport"] })])[h];
    const v = gd.goalReachVerdict(h, t, lenient);
    expect(v.unreached_since_last_reach).toBe(0);
    expect(typeof v.last_reached_at).toBe("string");
    expect(v.last_reach_judge).toContain("reconciliationReport");
  });
  const lenientReaches: Array<[string, Row]> = [
    ["a lenient produced shape", { completionShapes: ["looseShape"] }],
    ["a lenient reason", { goalReachReason: "lenient: shell output accepted" }],
    ["a lenient template", { selectedTemplateId: "activity:loose-template-v2" }],
  ];
  for (const [label, over] of lenientReaches) {
    it(`MUST-FAIL: a reach through ${label} does NOT zero the falsifier; it is flagged reached_lenient`, () => {
      expect(has("goalReachVerdict")).toBe(true);
      const t = tallyFrom([...base, run("lr", G, 1, true, String(over["goalReachReason"] ?? "reached"), over)], lenient)[h];
      const v = gd.goalReachVerdict(h, t, lenient);
      expect(v.unreached_since_last_reach).toBe(3);
      expect(v.reached_lenient).toBe(true);
      expect(v.lenient_reaches).toBe(1);
      expect(v.last_reached_at).toBeNull();
    });
  }
  it("with no lenient rule (the default) the same reach is trusted", () => {
    expect(has("goalReachVerdict")).toBe(true);
    const t = tallyFrom([...base, run("lr", G, 1, true, "reached", { completionShapes: ["looseShape"] })])[h];
    expect(gd.goalReachVerdict(h, t, P()).unreached_since_last_reach).toBe(0);
  });
  it("failures after a trusted reach count again; abstains after it do not", () => {
    expect(has("goalReachVerdict")).toBe(true);
    const t = tallyFrom([...base, run("ok", G, 6, true, "reached"), run("f4", G, 5, false, "The required reconciliation was not produced."), run("a1", G, 4, false, "abstain: not graded")])[h];
    expect(gd.goalReachVerdict(h, t, P()).unreached_since_last_reach).toBe(1);
  });
});

describe("through the default I/O and the real stores", () => {
  let gapStore: { restore: () => Promise<void> } | null = null;
  const poolFile = join(ROOT, "pool", "standing.json");
  beforeAll(() => {
    gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
    const root = sg.gapStoreRootForTest();
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
    mkdirSync(join(root, "gaps"), { recursive: true });
    mkdirSync(join(ROOT, "pool"), { recursive: true });
    pool.__setPoolFileForTests(poolFile);
  });
  afterAll(async () => {
    pool.__setPoolFileForTests(null);
    await gapStore?.restore();
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  });
  const RUN = Math.random().toString(36).slice(2, 8);
  const G = `assemble the support-ticket backlog by severity (${RUN})`;
  const obs = (id: string, hoursAgo: number, reached: boolean, reason: string): Row => ({ dispatchId: `${id}-${RUN}`, goal: G, goal_full: true, status: reached ? "completed" : "failed", reached, operator: "rhythm-conductor-drain", trigger: "operator", startedAt: Date.now() - hoursAgo * H, endedAt: Date.now() - hoursAgo * H + 60_000, node: null, goalReachReason: reason, completionShapes: [] });
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

  it("three failures file ONE open gap, linked to the goal, and the verdict reads 3; a second call files nothing new", async () => {
    expect(has("resolveGoalReachVerdict")).toBe(true);
    const io = grt.defaultGoalReachIO({ ...grt.DEFAULT_GOAL_REACH_POLICY });
    expect(typeof io.recogniseDeficiencies).toBe("function");
    const ds = [obs("f1", 9, false, "The required backlog was not produced."), obs("f2", 8, false, "The required backlog was not produced."), obs("f3", 7, false, "The output did not provide the required severity groups.")];
    const r1 = await quiet(() => io.recogniseDeficiencies(ds, Date.now()));
    const h = grt.goalHashOf(G);
    expect(r1.filed).toEqual([{ id: `goal-deficiency-${h}-deliverable_not_produced`, kind: "create", count: 3 }]);
    await sg.__settleBirthEvaluationsForTests();
    const g = ((await sg.resolveSubstrateGap({ type: "substrateGap", id: `goal-deficiency-${h}-deliverable_not_produced`, limit: 1 } as never)).body as Row).gaps[0];
    expect(g.status).toBe("open");
    expect(linkedGoalHashes(g.classification_metadata.demand_goals)).toEqual([h]);
    expect(g.classification_metadata.edit_site).toBeUndefined();
    const v = await gd.resolveGoalReachVerdict({ goal_hash: h });
    expect(v.body).toMatchObject({ measured: true, unreached_since_last_reach: 3 });
    const r2 = await quiet(() => io.recogniseDeficiencies(ds, Date.now()));
    expect(r2.filed).toEqual([]);
    const v2 = await quiet(async () => { await io.recogniseDeficiencies([...ds, obs("ok", 1, true, "reached: backlog produced")], Date.now()); return gd.resolveGoalReachVerdict({ goal_hash: h }); });
    expect(v2.body.unreached_since_last_reach).toBe(0);
  });

  it("C-tally-1: the default I/O reads the reasons it lacks from the run's node — reason → classed, none → unrecorded (never re-read), unreachable → stays unread", async () => {
    const G2 = `rank the open incidents by customer impact (${RUN})`;
    const hits: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const id = String(((await req.json()) as Row).impulse.pointer.dispatchId);
      hits.push(id);
      if (id.startsWith("x-")) return new Response("down", { status: 503 });
      return Response.json({ shape: "goalWalkState", body: id.startsWith("e-") ? { status: "failed" } : { goalReachReason: "deterministic:hollow-walklog-capped — capped", completionShapes: [] } });
    } });
    try {
      const node = `http://127.0.0.1:${server.port}/resolve`;
      const o = (id: string, hoursAgo: number): Row => ({ ...obs(id, hoursAgo, false, ""), goal: G2, node, goalReachReason: null });
      const ds = [o("c-1", 9), o("c-2", 8), o("e-1", 7), o("x-1", 6)];
      const io = grt.defaultGoalReachIO({ ...grt.DEFAULT_GOAL_REACH_POLICY });
      const r1 = await quiet(() => io.recogniseDeficiencies(ds, Date.now()));
      expect(hits.sort()).toEqual([`c-1-${RUN}`, `c-2-${RUN}`, `e-1-${RUN}`, `x-1-${RUN}`]);
      expect([r1.reasons_read, r1.reasons_unrecorded, r1.reason_reads_failed]).toEqual([2, 1, 1]);
      const h2 = grt.goalHashOf(G2);
      expect(r1.unread).toEqual([{ goal_hash: h2, count: 1 }]);
      expect(r1.unrecorded).toEqual([{ goal_hash: h2, count: 1 }]);
      hits.length = 0;
      const r2 = await quiet(() => io.recogniseDeficiencies([], Date.now()));
      expect(hits).toEqual([`x-1-${RUN}`]);
      expect(r2.unrecorded).toEqual([{ goal_hash: h2, count: 1 }]);
    } finally { server.stop(true); }
  });

  it("a policy edit reclasses the STORED entries on the next call, with no new run (wired in the default I/O)", async () => {
    const G3 = `tabulate the overdue invoices per customer (${RUN})`;
    const prose = "The output did not provide the overdue invoices per customer.";
    const io = grt.defaultGoalReachIO({ ...grt.DEFAULT_GOAL_REACH_POLICY });
    const ds = [9, 8, 7].map((h, i) => ({ ...obs(`ri${i}`, h, false, prose), goal: G3 }));
    const r1 = await quiet(() => io.recogniseDeficiencies(ds, Date.now()));
    const h3 = grt.goalHashOf(G3);
    expect(r1.candidates.filter((c: Row) => c.goal_hash === h3)).toEqual([]);
    pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "goalDeficiencyPolicy", shape: "goalDeficiencyPolicy", source: "test", status: "open",
      body: { file_gaps: 0, classes: [...P().classes, { class: "invoice_fixture_gap", patterns: ["did not provide the overdue"] }] } } as never);
    try {
      const r2 = await quiet(() => io.recogniseDeficiencies([], Date.now()));
      expect(r2.candidates.filter((c: Row) => c.goal_hash === h3)).toEqual([{ goal_hash: h3, reason_class: "invoice_fixture_gap", count: 3, class_source: "operator_map" }]);
    } finally {
      pool.resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "goalDeficiencyPolicy", shape: "goalDeficiencyPolicy", source: "test", status: "closed", body: {} } as never);
    }
  });
});

describe("wiring", () => {
  it("the tick runs R2 when the I/O offers it, and a throw is recorded, not swallowed", async () => {
    const base = { listDispatches: async () => ({ ok: true, dispatches: [] }), readGaps: async () => ({ ok: true, gaps: [] }), readLandings: async () => ({ ok: true, landings: [] }), scopeExcludes: async () => () => null, loadRecords: async () => ({}), saveRecord: async () => {}, dispatchGoal: async () => ({ ok: true, dispatch_id: "x", coalesced: false }), readTemplatesSince: async () => ({ ok: true, templates: [] }), attachExtractionEvidence: async () => ({ ok: true }), fileLimitProposal: async () => ({ ok: true }) };
    const report = { ok: true, tallied: 0, ignored: 0, filed: [], refused: [], skipped: [], unclassified: [], candidates: [] };
    const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {};
    try {
      const a = await grt.runGoalReachTick({ ...base, recogniseDeficiencies: async () => report }, { ...grt.DEFAULT_GOAL_REACH_POLICY }, NOW);
      expect(a.deficiency).toEqual(report);
      const b = await grt.runGoalReachTick({ ...base, recogniseDeficiencies: async () => { throw new Error("boom"); } }, { ...grt.DEFAULT_GOAL_REACH_POLICY }, NOW);
      expect(b.errors.some((e: string) => e.includes("deficiency recognition failed: boom"))).toBe(true);
    } finally { console.log = l; console.warn = w; }
  });
  it("goal_reach_verdict is advertised and dispatched (shape-dispatch agreement)", () => {
    const cfg = readFileSync(join(import.meta.dir, "../../src/config.ts"), "utf8");
    const routes = readFileSync(join(import.meta.dir, "../../src/routes/impulses.ts"), "utf8");
    expect(cfg).toContain('"goal_reach_verdict",');
    expect(routes).toContain('case "goal_reach_verdict":');
  });
});

// C-tally-1: R2 READS THE REASONS IT LACKS, and classes by the SYSTEM'S OWN JUDGE CODE before any operator text map.
//   - a reason headed by a structured judge code (deterministic:<code>) is classed by that code (class_source judge_code);
//     codes matching the shaped non_deficiency_code_patterns (refusals) are abstains; free text falls back to the shaped
//     text map (class_source operator_map); the source is carried to candidates and to the filed row;
//   - an empty reason is UNREAD (never read: re-read later, oldest first, bounded by max_reason_reads) or UNRECORDED
//     (read, and the record carries none: never re-read); neither is ever counted toward a class; both are reported.
describe("judge code first; the text map is the fallback (class_source recorded)", () => {
  const cases: Array<[string, string, string | null, string | undefined]> = [
    ["a judge code wins over a text-map match in the same reason", "deterministic:hollow-walklog-capped — the required digest was not produced", "hollow_walklog_capped", "judge_code"],
    ["an underscore code", "deterministic:hollow_walklog_capped", "hollow_walklog_capped", "judge_code"],
    ["a refusal code is an abstain (shaped non-deficiency list)", "deterministic:spend-rate-refused (cap reached)", "abstain", "judge_code"],
    ["free text falls back to the text map", "The required digest was not produced.", "deliverable_not_produced", "operator_map"],
    ["MUST-FAIL (regex): an underscore-joined hollow in free text is no_substantive_content", "walk log hollow_walklog_capped at 40 steps", "no_substantive_content", "operator_map"],
    ["a code that is not a class token is never truncated: it falls through", `deterministic:${"x".repeat(50)} — the required digest was not produced`, "deliverable_not_produced", "operator_map"],
    ["a prefix-only reason is free text", "deterministic: nothing here", null, undefined],
    ["the phantom guard runs before the judge code", "deterministic:missing-producer — no producer or constructible payload for missing shapes [sql_like]", "phantom", undefined],
  ];
  for (const [label, reason, cls, src] of cases) it(`${label} → ${cls ?? "unclassified"}${src ? ` (${src})` : ""}`, () => {
    const c = gd.classifyReason(reason, [], P(), never);
    expect(c.class).toBe(cls);
    expect(c.class_source).toBe(src);
  });
  it("the non-deficiency list is shaped: emptied, a refusal code is its own class", () => {
    expect(gd.classifyReason("deterministic:spend-rate-refused", [], { ...P(), non_deficiency_code_patterns: [] }, never)).toEqual({ class: "spend_rate_refused", class_source: "judge_code" });
  });
  const bad: Array<[string, unknown]> = [["non-deficiency codes not a list", { non_deficiency_code_patterns: "x" }], ["a non-deficiency pattern that does not compile", { non_deficiency_code_patterns: ["("] }], ["max_reason_reads above 200", { max_reason_reads: 201 }], ["max_reason_reads negative", { max_reason_reads: -1 }]];
  for (const [label, body] of bad) it(`invalid (${label}) → ok false`, () => { expect(gd.parseDeficiencyPolicy(body).ok).toBe(false); });
  it("candidates and the filed row carry the class source; refusals never count", () => {
    const G = "summarise the on-call handover notes";
    const hh = grt.goalHashOf(G);
    const judged = [1, 2, 3].map((i) => run(`j${i}`, G, 10 - i, false, "deterministic:hollow-walklog-capped — capped"));
    const refused = [1, 2, 3].map((i) => run(`s${i}`, G, 5 - i, false, "deterministic:spend-rate-refused"));
    const d = gd.deficiencyDecisions(tallyFrom([...judged, ...refused]), new Map(), NOW, P());
    expect(d.candidates).toEqual([{ goal_hash: hh, reason_class: "hollow_walklog_capped", count: 3, class_source: "judge_code" }]);
    expect(d.writes.map((w: Row) => w.gap.classification_metadata.class_source)).toEqual(["judge_code"]);
    const mixed = gd.deficiencyDecisions(tallyFrom([run("m1", G, 9, false, "deterministic:ungrounded"), run("m2", G, 8, false, "ungrounded figures"), run("m3", G, 7, false, "not grounded")]), new Map(), NOW, P());
    expect(mixed.candidates).toEqual([{ goal_hash: hh, reason_class: "ungrounded", count: 3, class_source: "mixed" }]);
  });
});

describe("unread vs unrecorded: visible, never counted; reasonsToRead is oldest first and bounded", () => {
  const G = "list the stale feature flags per service";
  const hh = grt.goalHashOf(G);
  it("an empty reason is unread; read-and-empty is unrecorded; neither counts toward a class nor makes a candidate", () => {
    const runs = [
      run("u1", G, 9, false, "", { node: "n-a" }), run("u2", G, 8, false, "", { node: "n-a" }), run("u3", G, 7, false, "", { node: "n-a" }),
      run("r1", G, 6, false, "", { node: "n-a", reason_unrecorded: true }), run("r2", G, 5, false, "", { node: "n-a", reason_unrecorded: true }), run("r3", G, 4, false, "", { node: "n-a", reason_unrecorded: true }),
    ];
    const t = tallyFrom(runs);
    expect(t[hh]!.entries.map((e: Row) => e.class)).toEqual(["unread", "unread", "unread", "unrecorded", "unrecorded", "unrecorded"]);
    const d = gd.deficiencyDecisions(t, new Map(), NOW, P());
    expect(d.candidates).toEqual([]);
    expect(d.writes).toEqual([]);
    expect(d.unread).toEqual([{ goal_hash: hh, count: 3 }]);
    expect(d.unrecorded).toEqual([{ goal_hash: hh, count: 3 }]);
  });
  it("a later read replaces unread (with its class, keeping the node); a later empty read makes it unrecorded", () => {
    const first = gd.tallyUpdate({}, [run("u1", G, 9, false, "", { node: "n-a" }), run("u2", G, 8, false, "", { node: "n-a" })], NOW, P(), never).tallies;
    const read = gd.tallyUpdate(first, [run("u1", G, 9, false, "The required list was not produced."), run("u2", G, 8, false, "", { reason_unrecorded: true })], NOW, P(), never).tallies;
    expect(read[hh]!.entries.map((e: Row) => [e.class, e.node])).toEqual([["deliverable_not_produced", "n-a"], ["unrecorded", "n-a"]]);
  });
  it("reasonsToRead: unread tally entries and reasonless listed runs, oldest first, at most the bound; never unrecorded, reached, running or node-less", () => {
    expect(has("reasonsToRead")).toBe(true);
    const tallies = tallyFrom([run("t-old", G, 20, false, "", { node: "n-a" }), run("t-rec", G, 19, false, "", { node: "n-a", reason_unrecorded: true }), run("t-read", G, 18, false, "not produced", { node: "n-a" })]);
    const listed = [run("l-new", G, 2, false, "", { node: "n-b" }), run("l-mid", G, 10, false, "", { node: "n-b" }), run("l-ok", G, 9, true, "", { node: "n-b" }), run("l-run", G, 8, false, "", { node: "n-b", status: "running" }), run("l-nonode", G, 7, false, ""), run("l-has", G, 6, false, "not produced", { node: "n-b" }), run("t-read", G, 18, false, "", { node: "n-a" })];
    expect(gd.reasonsToRead(tallies, listed, 30).map((x: Row) => x.dispatchId)).toEqual(["t-old", "l-mid", "l-new"]);
    expect(gd.reasonsToRead(tallies, listed, 2).map((x: Row) => [x.dispatchId, x.node])).toEqual([["t-old", "n-a"], ["l-mid", "n-b"]]);
    expect(gd.reasonsToRead(tallies, listed, 0)).toEqual([]);
  });
});

// C-longgoal-1: A GOAL OF 200+ CHARS IS NEVER INVISIBLE TO R2. activeDispatches cuts goals at 200 chars; a cut goal hashes only
// from a detail read or from the record that already holds the run. Known runs carry their record's hash; the detail budget goes
// to still-unhashable rows first; a record without a hash falls back to a detail read; and every unhashable run is COUNTED (G3).
describe("C-longgoal-1: long goals reach R2", () => {
  const long = (topic: string) => `Compile a careful weekly digest about ${topic}: group the items by owner, note which ones slipped since last week and why, attach the source for every figure, flag anything that needs a decision before Friday, and keep it under one page for the review meeting.`;
  const LONG_A = long("open procurement requests in the facilities queue"), LONG_B = long("pending vendor security questionnaires and renewals");
  const cut = (g: string) => g.slice(0, grt.ACTIVE_DISPATCHES_GOAL_CUT);
  const obs = (id: string, goal: string, over: Row = {}): Row => ({ dispatchId: id, goal, status: "failed", reached: false, operator: "rhythm-conductor-drain", trigger: "operator", startedAt: NOW - H, node: null, ...over });
  const rec = (goal_hash: string, ids: string[], over: Row = {}): Row => ({ goal_hash, goal: "x", dispatches: ids.map((dispatchId) => ({ dispatchId, status: "failed", startedAt: NOW - 2 * H })), r_issued: [], ...over });

  it("the fixtures really are long: both goals exceed the cut", () => {
    expect(LONG_A.length).toBeGreaterThan(grt.ACTIVE_DISPATCHES_GOAL_CUT);
    expect(LONG_B.length).toBeGreaterThan(grt.ACTIVE_DISPATCHES_GOAL_CUT);
  });

  it("boundary: a 199-char goal hashes straight from the listing; a 200-char one is a cut goal until completed", () => {
    expect(typeof grt.isCutGoal).toBe("function");
    const g199 = "a".repeat(199), g200 = "b".repeat(200);
    expect(grt.dispatchGoalHash(obs("s", g199))).toBe(grt.goalHashOf(g199));
    expect(grt.isCutGoal(obs("t", g200))).toBe(true);
    expect(grt.dispatchGoalHash(obs("t", g200))).toBeNull();
    expect(grt.dispatchGoalHash(obs("t", g200, { goal_full: true }))).toBe(grt.goalHashOf(g200));
  });

  it("(a) a known terminal run with a cut goal is tallied under the hash of the record that holds it", () => {
    expect(typeof grt.knownFromRecords).toBe("function");
    const h = grt.goalHashOf(LONG_A);
    const k = grt.knownFromRecords({ [h]: rec(h, ["k1"]) });
    expect([...k.known]).toEqual(["k1"]);
    const o = grt.applyKnownHash(obs("k1", cut(LONG_A)), k.known_hashes);
    expect(grt.dispatchGoalHash(o)).toBe(h);
    expect(grt.detailReadOrder([o], k, 20)).toEqual([]); // no detail read spent on it
    const t = gd.tallyUpdate({}, [{ ...o, goal_hash: grt.dispatchGoalHash(o), origin: "autonomous", goalReachReason: "The output did not provide the digest." }], NOW, P(), never).tallies;
    expect(Object.keys(t)).toEqual([h]);
  });

  it("a record WITHOUT a hash makes none of its runs known: they get a detail read, never a silent skip", () => {
    const k = grt.knownFromRecords({ legacy: rec(undefined as never, ["old1"]) });
    expect(k.known.has("old1")).toBe(false);
    expect(grt.detailReadOrder([obs("old1", cut(LONG_B))], k, 20)).toEqual(["old1"]);
  });

  it("(b) the detail budget goes to unhashable cut rows first; a cut row past the budget is read on a later tick", () => {
    const none = { known: new Set<string>(), r_issued: new Set<string>() };
    const page = [obs("plain", "a short failed goal"), obs("cutA", cut(LONG_A)), obs("cutB", cut(LONG_B))];
    expect(grt.detailReadOrder(page, none, 1)).toEqual(["cutA"]);
    // tick 2: cutA was read and recorded under its full hash; cutB is still unknown and now first
    const hA = grt.goalHashOf(LONG_A);
    const k2 = grt.knownFromRecords({ [hA]: rec(hA, ["cutA"]) });
    const page2 = [obs("plain", "a short failed goal"), grt.applyKnownHash(obs("cutA", cut(LONG_A)), k2.known_hashes), obs("cutB", cut(LONG_B))];
    expect(grt.detailReadOrder(page2, k2, 1)).toEqual(["cutB"]);
    const afterRead = obs("cutB", LONG_B, { goal_full: true });
    expect(grt.dispatchGoalHash(afterRead)).toBe(grt.goalHashOf(LONG_B));
  });

  it("(c) MUST-FAIL: a cut goal left without a hash is COUNTED, never silently dropped", () => {
    expect(typeof grt.unhashedRuns).toBe("function");
    const ds = [obs("u1", cut(LONG_A)), obs("u2", "a short goal that hashes"), obs("u3", null as never)];
    expect(grt.unhashedRuns(ds)).toEqual({ no_goal_hash: 2, cut_goal: 1 });
    expect(grt.unhashedRuns([obs("u2", "a short goal that hashes")])).toEqual({ no_goal_hash: 0, cut_goal: 0 });
  });

  it("(c) through the default I/O: R2 reports and logs the skip count every call", async () => {
    const io = grt.defaultGoalReachIO({ ...grt.DEFAULT_GOAL_REACH_POLICY });
    const lines: string[] = [];
    const l = console.log, w = console.warn; console.log = (s: string) => { lines.push(String(s)); }; console.warn = () => {};
    let r: Row;
    try { r = await io.recogniseDeficiencies([obs("v1", cut(LONG_A)), obs("v2", cut(LONG_B))], Date.now()); }
    finally { console.log = l; console.warn = w; }
    expect([r!.skipped_no_goal_hash, r!.skipped_cut_goal]).toEqual([2, 2]);
    expect(lines).toContain("[goal-reach] R2 runs skipped: no goal_hash 2 (cut goal 2)");
  });
});

// A POLICY EDIT TAKES EFFECT ON THE EVIDENCE ALREADY HELD (law 1: read at use). Stored not-reached entries with a reason are
// classed again under the current policy each call; shape-based classes and reasonless entries are left as they are.
describe("reclassifyStored: the current policy applies to stored entries", () => {
  const G = "summarise the open purchase orders by supplier";
  const hh = grt.goalHashOf(G);
  const prose = "The output did not provide the purchase orders grouped by supplier.";
  const busy = "RETRYABLE CAPACITY: the compose lane is at capacity (verdict=BUSY), so the required change was not produced.";
  const withMap = (): Row => ({ ...P(), classes: [...P().classes, { class: "content_gap_fixture", patterns: ["did not provide the purchase orders"] }] });
  it("a class-map edit reclasses stored entries (unclassified → the new class, with its source); a second call changes nothing", () => {
    expect(has("reclassifyStored")).toBe(true);
    const t = tallyFrom([1, 2, 3].map((i) => run(`s${i}`, G, 10 - i, false, prose)));
    expect(t[hh]!.entries.map((e: Row) => e.class)).toEqual([null, null, null]);
    const r1 = gd.reclassifyStored(t, withMap(), never);
    expect(r1).toEqual({ changed: [hh], moved: 3 });
    expect(t[hh]!.entries.map((e: Row) => [e.class, e.class_source])).toEqual([["content_gap_fixture", "operator_map"], ["content_gap_fixture", "operator_map"], ["content_gap_fixture", "operator_map"]]);
    expect(gd.deficiencyDecisions(t, new Map(), NOW, withMap()).candidates).toEqual([{ goal_hash: hh, reason_class: "content_gap_fixture", count: 3, class_source: "operator_map" }]);
    expect(gd.reclassifyStored(t, withMap(), never)).toEqual({ changed: [], moved: 0 });
  });
  it("MUST-FAIL: a stored entry whose new class is an abstain is never counted (no candidate, no write)", () => {
    const t = tallyFrom([1, 2, 3].map((i) => run(`b${i}`, G, 10 - i, false, busy)), withMap());
    expect(t[hh]!.entries.every((e: Row) => e.class === "deliverable_not_produced")).toBe(true);
    const pol = { ...withMap(), abstain_patterns: [...P().abstain_patterns, "\\bverdict=BUSY\\b"] };
    gd.reclassifyStored(t, pol, never);
    expect(t[hh]!.entries.map((e: Row) => e.class)).toEqual(["abstain", "abstain", "abstain"]);
    const d = gd.deficiencyDecisions(t, new Map(), NOW, { ...pol, file_gaps: 1 });
    expect(d.candidates).toEqual([]);
    expect(d.writes).toEqual([]);
  });
  it("an entry tallied before class sources existed gains its source (same class, new source is a change)", () => {
    const t = tallyFrom([run("o1", G, 9, false, "The required list was not produced.")]);
    delete t[hh]!.entries[0].class_source;
    expect(t[hh]!.entries[0].class).toBe("deliverable_not_produced");
    expect(gd.reclassifyStored(t, P(), never)).toEqual({ changed: [hh], moved: 1 });
    expect(t[hh]!.entries[0].class_source).toBe("operator_map");
  });

  it("shape-based classes and reasonless entries are left as judged", () => {
    const t = tallyFrom([
      run("m1", G, 9, false, "no producer or constructible payload for missing shapes [poShape]", { completionShapes: ["poShape"] }),
      run("p1", G, 8, false, "no producer or constructible payload for missing shapes [sql_like]"),
      run("u1", G, 7, false, "", { node: "n-a" }),
    ]);
    const before = t[hh]!.entries.map((e: Row) => e.class);
    expect(before).toEqual(["missing_producer", "phantom", "unread"]);
    expect(gd.reclassifyStored(t, { ...withMap(), classes: [{ class: "everything", patterns: ["."] }] }, () => true)).toEqual({ changed: [], moved: 0 });
    expect(t[hh]!.entries.map((e: Row) => e.class)).toEqual(before);
  });
});
