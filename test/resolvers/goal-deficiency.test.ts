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
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `goal-deficiency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
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
      // PINNED LITERAL (the goalReachCheck extraction must leave R2's row byte-identical)
      expect(JSON.stringify(meta.evidence_resolve)).toBe(`{"shape":"goal_reach_verdict","input":{"goal_hash":"${grt.goalHashOf(goals[k]!)}"},"zero_field":"unreached_since_last_reach"}`);
      expect(meta.falsifier_spec).toBe(`goal_reach_verdict(goal_hash=${grt.goalHashOf(goals[k]!)}).unreached_since_last_reach == 0: a later run of this goal is judged reached on a path not listed as lenient`);
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

  it("#1a wiring: a filed deficiency row is localized in the same call (loud unknown when no trace is readable) and reported", async () => {
    const G4 = `reconcile the duplicate vendor invoices (${RUN})`;
    const io = grt.defaultGoalReachIO({ ...grt.DEFAULT_GOAL_REACH_POLICY });
    const ds = [9, 8, 7].map((h, i) => ({ ...obs(`lc${i}`, h, false, "The required reconciliation was not produced."), goal: G4 }));
    const r = await quiet(() => io.recogniseDeficiencies(ds, Date.now()));
    const h4 = grt.goalHashOf(G4);
    const id = `goal-deficiency-${h4}-deliverable_not_produced`;
    expect(r.filed.map((f: Row) => f.id)).toContain(id);
    expect(r.localized).toContainEqual({ id, state: "unknown", kind: "trace_unreadable" });
    await sg.__settleBirthEvaluationsForTests();
    const g = ((await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never)).body as Row).gaps[0];
    expect(g.classification_metadata.localization).toMatchObject({ state: "unknown", kind: "trace_unreadable" });
    expect(g.classification_metadata.edit_site ?? null).toBeNull();
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

  it("#1b MUST-FAIL (real store): an existing unsited row for the same (resolver, failure class) is ENRICHED and linked, never duplicated; a new pair files once at the canonical id", async () => {
    const res = `ledger_post_${RUN}`;
    const prior = `novel-failure-learned-${res.replace(/_/g, "-")}-${RUN}`;
    const w0 = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: prior, category: "systematic_failure", source: "novel-failure-detector", status: "open", detected_at: new Date(Date.now() - 3 * H).toISOString(),
      summary: `Novel failure cluster on a learned template (${RUN})`, classification_metadata: { cluster_key: `learned-${res.replace(/_/g, "-")}|execution_error` } } } as never);
    expect(w0.shape).toBe("substrateGapWriteResult");
    await sg.__settleBirthEvaluationsForTests();
    const ph = grt.goalHashOf(`post the ledger entries for the quarter (${RUN})`);
    const parent: Row = { id: `goal-deficiency-${ph}-write_goal_no_artifact`, status: "open", classification_metadata: { goal_hash: ph, dispatch_ids: ["p1", "p2"] } };
    const step = (id: string, r: string): Row => ({ dispatch_id: id, kind: "step_failure", resolver: r, failure_class: "execution_error", failure_excerpt: `${r} POST returned 400: field owner missing` });
    const loc = { state: "sited", kind: "step_failure", counts: {}, runs: [step("p1", res), step("p2", res), { dispatch_id: "p3", kind: "output_error", resolver: "shell_result" }] };
    const rowsOf = async () => (((await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never)).body as Row).gaps as Row[]);
    const deps = { vesselOf: async () => ({ vessel: "ledger-vessel" }), locate: async (v: string, r: string) => ({ file: `repos/${v}/src/resolvers/${r}.ts`, method: "grep_unique" }) };
    const quietly = <T>(f: () => Promise<T>) => quiet(f);
    const c1 = await quietly(() => grt.ensureStepChildren(parent, loc, rowsOf, sg.resolveSubstrateGapWrite, deps));
    expect(c1).toEqual([{ id: prior, resolver: res, failure_class: "execution_error", state: "linked" }]);
    await sg.__settleBirthEvaluationsForTests();
    const all = await rowsOf();
    expect(all.filter((g) => g.classification_metadata?.failing_activity === res).map((g) => g.id)).toEqual([prior]);
    expect(all.some((g) => g.id === gd.stepGapId(res, "execution_error"))).toBe(false);
    const m = all.find((g) => g.id === prior)!.classification_metadata;
    expect(m).toMatchObject({ failing_activity: res, failure_class: "execution_error", vessel: "ledger-vessel", edit_site: `repos/ledger-vessel/src/resolvers/${res}.ts`, cluster_key: `learned-${res.replace(/_/g, "-")}|execution_error`, parent_gap: parent.id });
    expect(linkedGoalHashes(m.demand_goals)).toEqual([ph]);
    expect(String(m.falsifier_spec)).toContain(`"${res} POST returned 400: field owner missing"`);
    // a second goal hitting the same step links the SAME row (demand from both goals), still one row
    const ph2 = grt.goalHashOf(`reconcile the ledger against the bank feed (${RUN})`);
    const c2 = await quietly(() => grt.ensureStepChildren({ ...parent, id: `goal-deficiency-${ph2}-x`, classification_metadata: { goal_hash: ph2, dispatch_ids: ["q1"] } }, { ...loc, runs: [step("q1", res)] }, rowsOf, sg.resolveSubstrateGapWrite, deps));
    expect(c2[0]).toMatchObject({ id: prior, state: "linked" });
    await sg.__settleBirthEvaluationsForTests();
    const after = await rowsOf();
    expect(after.filter((g) => g.classification_metadata?.failing_activity === res).length).toBe(1);
    expect(linkedGoalHashes(after.find((g) => g.id === prior)!.classification_metadata.demand_goals).sort()).toEqual([ph, ph2].sort());
    // a pair with no existing row files ONE new row at the canonical id, its summary code-formatting the resolver
    const res2 = `ledger_close_${RUN}`;
    const c3 = await quietly(() => grt.ensureStepChildren(parent, { ...loc, runs: [step("p1", res2), step("p2", res2)] }, rowsOf, sg.resolveSubstrateGapWrite, deps));
    expect(c3).toEqual([{ id: gd.stepGapId(res2, "execution_error"), resolver: res2, failure_class: "execution_error", state: "filed" }]);
    await sg.__settleBirthEvaluationsForTests();
    const fresh = (await rowsOf()).filter((g) => g.classification_metadata?.failing_activity === res2);
    expect(fresh.length).toBe(1);
    expect(fresh[0].summary).toContain(`\`${res2}\``);
    expect(fresh[0].classification_metadata).toMatchObject({ kind: "step_failure", edit_site: `repos/ledger-vessel/src/resolvers/${res2}.ts`, step_dispatch_ids: ["p1", "p2"] });
    expect(linkedGoalHashes(fresh[0].classification_metadata.demand_goals)).toEqual([ph]);
  });

  it("END-TO-END (A+B+B2+C, stubbed lane): a missing-producer deficiency row whose shape has a DECLARED contract → armed class2 producer_contract on its keys → one author request → its additive registration passes C → the judge reads absent once a contract producer is advertised (hollow stays present)", async () => {
    const pd = await import("../../src/resolvers/producer-dispatch.js");
    const judge = await import("../../src/judge/gap-check-judge.js");
    const ar = await import("../../src/judge/gap-policy.js");
    const cfg = await import("../../src/config.js");
    const shape = `parcel_backlog_${RUN}`;
    const def: Row = { id: `goal-deficiency-cafe0123-write_goal_no_artifact`, status: "open", classification_metadata: { kind: "goal_content_deficiency", goal_hash: "cafe0123", goal: "tabulate the overdue parcels per depot", dispatch_ids: [`e2e-${RUN}`] } };
    const record = { goal: "tabulate the overdue parcels per depot", walkLog: [`[goal-host-vessel] /run-goal: goal-target inference {"goal_hash":"cafe0123","inferred_target_shapes":["${shape}"],"confidence":0.8}`], completionShapes: [] };
    const sent: Array<{ id: string; tag: string }> = [];
    // A: the dispatcher over the REAL store (write) with a stubbed dispatch
    // the shape's contract is DECLARED on its capability row (required keys); without one nothing is armed or sent (see below)
    const declared: Row = { id: pd.capabilityGapId(shape), status: "open", classification_metadata: { kind: "capability_gap", missing_shape: shape, evidence_resolve: { shape, mode: "producer_contract", required_keys: ["parcels", "total"] } } };
    const rep = await quiet(() => pd.runProducerDispatch([def, declared], Date.now(), { producer_dispatch: "live", max_producer_dispatches: 1, producer_dispatch_cooldown_ms: 6 * H }, () => [], {
      isWrite: (x) => /_write$/.test(x), advertised: async () => false, readRun: async () => record, declaredBy: async () => [],
      write: async (gap, demand) => { const r = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap, demand_goals_append: [demand] } as never); return { ok: r.shape === "substrateGapWriteResult" }; },
      dispatch: async (id, tag) => { sent.push({ id, tag }); return { ok: true }; },
    }));
    const capId = pd.capabilityGapId(shape);
    expect(sent).toEqual([{ id: capId, tag: `producer_author:cafe0123:${shape}` }]);
    expect(rep.sent).toHaveLength(1);
    await sg.__settleBirthEvaluationsForTests();
    const row = ((await sg.resolveSubstrateGap({ type: "substrateGap", id: capId, limit: 1 } as never)).body as Row).gaps[0] as Row;
    // B/B2: armed class2 by the producer_contract check (an unadvertised shape), the goal's demand linked
    expect(row.status).toBe("open");
    expect(row.classification_metadata).toMatchObject({ kind: "capability_gap", missing_shape: shape, falsifier: "class2", falsifier_mode: "producer_contract", evidence_resolve: { shape, mode: "producer_contract", required_keys: ["parcels", "total"] }, edit_site: pd.plannedResolverFile(shape) });
    expect(linkedGoalHashes(row.classification_metadata.demand_goals)).toEqual(["cafe0123"]);
    // C (stubbed lane): the author route's landing — a new module at the armed edit site + the two registrations — is admitted
    const rel = String(row.classification_metadata.edit_site).replace(/^repos\/development-vessel\//, "");
    const mod = rel.replace(/^src\/resolvers\//, "").replace(/\.ts$/, "");
    const fn = "resolveParcelBacklog";
    const cfgBefore = `export const c = {\n  discovery: {\n    shapes: [\n      "alpha_report",\n    ],\n  },\n};\n`;
    const rtBefore = `export async function d(pointer: any): Promise<unknown> {\n  switch (pointer.type) {\n    default:\n      throw new Error("x");\n  }\n}\n`;
    const v = await ar.additiveRegistration([
      { path: "src/config.ts", before: cfgBefore, after: cfgBefore.replace('      "alpha_report",\n', `      "alpha_report",\n      "${shape}",\n`) },
      { path: "src/routes/impulses.ts", before: rtBefore, after: rtBefore.replace("    default:\n", `    case "${shape}": {\n      const { ${fn} } = await import("../resolvers/${mod}.js");\n      return ${fn}(pointer as any);\n    }\n    default:\n`) },
      { path: rel, before: null, after: `export async function ${fn}(pointer: any): Promise<unknown> {\n  return { shape: "${shape}", body: { parcels: [{ depot: "north", overdue: 3 }], total: 3, pointer } };\n}\n` },
    ], async () => false);
    expect(v).toMatchObject({ ok: true, shape, module: rel });
    // B: before any producer → present; a hollow producer → present; a contract-satisfying one → absent
    const P = "http://author-landed.fixture/v2/impulses/resolve";
    const withProducer = async (answer: unknown) => {
      cfg.__setDiscoveryForTests({ lookup: async (sh: string) => ({ ok: true, shape: sh, cached: false, producers: answer === undefined ? [] : [{ id: "landed", resolveEndpoint: P, origin: "local" }] }), describe: () => "fixture", failureBackoffMs: 2_000 } as never);
      try { return await quiet(() => judge.evaluateGapCheck(row, { fetchImpl: (async () => Response.json(answer)) as unknown as typeof fetch })); }
      finally { cfg.__resetDiscoveryForTests(); }
    };
    expect(await withProducer(undefined)).toBe("present");
    expect(await withProducer({ shape, body: { parcels: [], total: "TODO" } })).toBe("present");
    expect(await withProducer({ shape, body: { parcels: [{ depot: "north", overdue: 3 }], total: 3 } })).toBe("absent");
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

// SETTLEMENT OF A REACH-JUDGED GAP (2026-10-13): a landing's check is not read before the goal runs again. goal_reach_verdict
// takes `since` (the landing's pending_set_at) and is measured only once a counted run newer than it exists; the ONE judge
// passes `since` for a pending landing on a since-aware shape. A stale read (only runs from before the landing) is unknown —
// never present, so never falsified or reverted. The genuine cases stay: a newer run still unreached → present; a newer
// trusted reach → absent.
describe("goal_reach_verdict `since` + the judge's landing bound", () => {
  const G = "summarise the stale feature flags per team";
  const hh = grt.goalHashOf(G);
  const T = (h: number) => NOW - h * H;
  const fails = [5, 4, 3].map((h, i) => run(`f${i}`, G, h, false, "The required summary was not produced."));
  const tallyOf = (extra: Row[] = []) => tallyFrom([...fails, ...extra])[hh]!;
  const LANDED = T(2);
  it("no since → exactly today's verdict (backward compatible)", () => {
    const t = tallyOf();
    const a = gd.goalReachVerdict(hh, t, P()), b = gd.goalReachVerdict(hh, t, P(), null);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ measured: true, unreached_since_last_reach: 3 });
  });
  it("MUST-FAIL: since after every counted run → measured:false (the goal has not run since the landing)", () => {
    const v = gd.goalReachVerdict(hh, tallyOf(), P(), LANDED);
    expect(v.measured).toBe(false);
    expect(v.why).toMatch(/no counted run newer than since/);
  });
  it("only abstains after the landing → still measured:false (an abstain is not a run that tests the fix)", () => {
    const v = gd.goalReachVerdict(hh, tallyOf([run("ab", G, 1, false, "deterministic:spend-rate-refused")]), P(), LANDED);
    expect(v.measured).toBe(false);
  });
  it("G6: a run NEWER than the landing that is still unreached → measured, present (the genuine falsification stays)", () => {
    const v = gd.goalReachVerdict(hh, tallyOf([run("n1", G, 1, false, "The required summary was not produced.")]), P(), LANDED);
    expect(v).toMatchObject({ measured: true, unreached_since_last_reach: 4 });
  });
  it("G6: a newer TRUSTED reach → measured, 0 (the close stays)", () => {
    const v = gd.goalReachVerdict(hh, tallyOf([run("r1", G, 1, true, "reached: the summary lists every flag")]), P(), LANDED);
    expect(v).toMatchObject({ measured: true, unreached_since_last_reach: 0 });
  });
  it("an unparseable since is refused by the resolver (measured:false), never ignored", async () => {
    expect(gd.parseSince("not a time")).toBeNull();
    expect(gd.parseSince("2030-01-01T00:00:00Z")).toBe(Date.parse("2030-01-01T00:00:00Z"));
    const v = (await gd.resolveGoalReachVerdict({ goal_hash: hh, since: "not a time" })).body;
    expect(v.measured).toBe(false);
    expect(v.why).toMatch(/^since is not a time/);
  });

  // The ONE judge (evaluateGapCheck: birth, closeLandedGap and the pending-land sweep all call it), with its resolve answered by
  // the real instrument over an in-memory tally, so the judge→instrument contract is exercised exactly.
  const judge = async () => (await import("../../src/judge/gap-check-judge.js")) as Record<string, any>;
  const gapRow = (meta: Row, shape = "goal_reach_verdict"): Row => ({ id: "goal-deficiency-x", classification_metadata: { evidence_resolve: { shape, input: { goal_hash: hh }, zero_field: shape === "goal_reach_verdict" ? "unreached_since_last_reach" : "count" }, ...meta } });
  const answerWith = (t: Row, seen: Row[]) => (async (_u: unknown, init: { body: string }) => {
    const ptr = JSON.parse(init.body).impulse.pointer;
    seen.push(ptr);
    const body = ptr.type === "goal_reach_verdict" ? gd.goalReachVerdict(ptr.goal_hash, t, P(), gd.parseSince(ptr.since)) : { count: 2 };
    return new Response(JSON.stringify({ shape: "x", body }), { status: 200 });
  }) as unknown as typeof fetch;
  const quietly = async <X>(f: () => Promise<X>): Promise<X> => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
  const landing = { pending_outcome_verification: "c0ffee1234abcd", pending_set_at: new Date(LANDED).toISOString() };

  it("MUST-FAIL: a pending landing + only older runs → unknown (never present, so never falsified/reverted); since was passed", async () => {
    const { evaluateGapCheck } = await judge();
    const seen: Row[] = [];
    expect(await quietly(() => evaluateGapCheck(gapRow(landing), { fetchImpl: answerWith(tallyOf(), seen) }))).toBe("unknown");
    expect(seen[0]!["since"]).toBe(landing.pending_set_at);
  });
  it("G6 through the judge: a newer unreached run → present; a newer trusted reach → absent", async () => {
    const { evaluateGapCheck } = await judge();
    expect(await quietly(() => evaluateGapCheck(gapRow(landing), { fetchImpl: answerWith(tallyOf([run("n1", G, 1, false, "The required summary was not produced.")]), []) }))).toBe("present");
    expect(await quietly(() => evaluateGapCheck(gapRow(landing), { fetchImpl: answerWith(tallyOf([run("r1", G, 1, true, "reached")]), []) }))).toBe("absent");
  });
  it("MUST-FAIL (capability row armed by the dispatcher): a landing alone never closes it, an unbounded landing is unknown, only a later reached run closes it", async () => {
    const { evaluateGapCheck } = await judge();
    const pd = (await import("../../src/resolvers/producer-dispatch.js")) as Record<string, any>;
    const w = pd.capabilityRowWrite({ shape: "quarry_ledger", goal: G, goal_hash: hh, source_gap: "s", via: "capability_gap" }, null, new Date(LANDED).toISOString(), "live");
    const capRow = (extra: Row): Row => ({ id: w.gap.id, status: "open", classification_metadata: { ...w.gap.classification_metadata, ...extra } });
    const seen: Row[] = [];
    // the landing alone (only runs from before it): unknown, never absent
    expect(await quietly(() => evaluateGapCheck(capRow(landing), { fetchImpl: answerWith(tallyOf(), seen) }))).toBe("unknown");
    expect(seen[0]!["since"]).toBe(landing.pending_set_at);
    // a landing whose time cannot be read: unknown (stale verdicts are never read as current)
    expect(await quietly(() => evaluateGapCheck(capRow({ pending_outcome_verification: "c0ffee", pending_set_at: "garbage" }), { fetchImpl: answerWith(tallyOf(), []) }))).toBe("unknown");
    // a later unreached run: present; a later trusted reach: absent (only the goal's own reach closes it)
    expect(await quietly(() => evaluateGapCheck(capRow(landing), { fetchImpl: answerWith(tallyOf([run("n1", G, 1, false, "The required summary was not produced.")]), []) }))).toBe("present");
    expect(await quietly(() => evaluateGapCheck(capRow(landing), { fetchImpl: answerWith(tallyOf([run("r1", G, 1, true, "reached")]), []) }))).toBe("absent");
  });
  it("no pending landing → no since, and today's verdict (present on the open tally)", async () => {
    const { evaluateGapCheck } = await judge();
    const seen: Row[] = [];
    expect(await quietly(() => evaluateGapCheck(gapRow({}), { fetchImpl: answerWith(tallyOf(), seen) }))).toBe("present");
    expect("since" in seen[0]!).toBe(false);
  });
  it("a pending landing whose time cannot be read → unknown without a read (cannot be bounded)", async () => {
    const { evaluateGapCheck } = await judge();
    const seen: Row[] = [];
    const lines: string[] = [];
    const l = console.log; console.log = (x: unknown) => { lines.push(String(x)); };
    let v: string;
    try { v = await evaluateGapCheck(gapRow({ pending_outcome_verification: "c0ffee", pending_set_at: "garbage" }), { fetchImpl: answerWith(tallyOf(), seen) }); } finally { console.log = l; }
    expect(v!).toBe("unknown");
    expect(seen).toEqual([]);
    expect(lines.some((x) => /has no readable pending_set_at/.test(x))).toBe(true);
  });
  it("a shape that is not since-aware keeps its input unchanged under a pending landing (and today's verdict)", async () => {
    const { evaluateGapCheck, SINCE_AWARE_CHECK_SHAPES } = await judge();
    expect([...SINCE_AWARE_CHECK_SHAPES]).toEqual(["goal_reach_verdict"]);
    const seen: Row[] = [];
    expect(await quietly(() => evaluateGapCheck(gapRow(landing, "some_count_report"), { fetchImpl: answerWith(tallyOf(), seen) }))).toBe("present");
    expect(seen[0]).toEqual({ type: "some_count_report", goal_hash: hh });
  });
});

// #1a: A DEFICIENCY IS SITED ONLY FROM WHAT ITS RUNS' OWN TRACES NAME. Each counted run is attributed from its trace
// (step_failure / output_error / composition / trace_unreadable); only a FAILING STEP sites, and only when one resolver
// accounts for siting_majority (a shaped policy field) of the readable runs, with exactly one local serving vessel and one
// located file. Everything else is a loud unknown carrying the per-run breakdown. Never from the goal or judge prose.
describe("#1a: attributing a deficiency's runs and siting it", () => {
  const T = (tasks: Array<[string, boolean]>, reason?: string) => ({ tasks: tasks.map(([r, ok]) => ({ resolver_id: r, status: ok ? "success" : "failure" })), failure_mode: reason ? { type: "execution_error", reason } : null });
  const A = (id: string, kind: string, resolver?: string, ex?: string): Row => ({ dispatch_id: id, kind, ...(resolver ? { resolver } : {}), ...(ex ? { failure_excerpt: ex } : {}) });
  const oneVessel = async (r: string) => ({ vessel: `${r.replace(/_/g, "-")}-vessel` });
  const fileFor = async (v: string, r: string) => ({ file: `repos/${v}/src/resolvers/${r}.ts`, method: "grep_unique" });
  const NOW2 = Date.parse("2030-04-01T00:00:00Z");

  it("attributeRun: a failed task → step_failure (its resolver + the trace's failure excerpt); unreadable → trace_unreadable", () => {
    expect(gd.attributeRun("d1", T([["a_step", true], ["ledger_write", false]], "ledger_write POST returned 400: field owner missing"), "x")).toEqual({ ...A("d1", "step_failure", "ledger_write", "ledger_write POST returned 400: field owner missing"), failure_class: "execution_error" });
    expect(gd.attributeRun("d2", null, "x")).toEqual(A("d2", "trace_unreadable"));
  });
  it("attributeRun: all tasks ok + an error-envelope judge code → output_error (last step); all ok otherwise → composition", () => {
    expect(gd.attributeRun("d3", T([["fetch_page", true]]), "deterministic:error-envelope — output is an error/failure envelope")).toEqual(A("d3", "output_error", "fetch_page"));
    expect(gd.attributeRun("d4", T([["scan", true], ["summarise", true]]), "The output did not provide the digest.")).toEqual(A("d4", "composition"));
  });
  it("single cause: every run fails at ONE resolver → SITED (vessel from discovery, file from the locator); two runs at it → one site", async () => {
    const runs = [A("d1", "step_failure", "ledger_write", "400"), A("d2", "step_failure", "ledger_write", "400"), A("d3", "step_failure", "ledger_write")];
    const loc = await gd.localizeFromRuns(runs, 0.5, oneVessel, fileFor, NOW2);
    expect(loc).toMatchObject({ state: "sited", kind: "step_failure", vessel: "ledger-write-vessel", failing_activity: "ledger_write", edit_site: "repos/ledger-write-vessel/src/resolvers/ledger_write.ts", method: "grep_unique" });
    expect(loc.counts.step_failure).toBe(3);
  });
  it("siting_majority is the policy's: 2 of 4 runs at one resolver sites at 0.5, not at 0.75", async () => {
    const runs = [A("d1", "step_failure", "x_write"), A("d2", "step_failure", "x_write"), A("d3", "composition"), A("d4", "composition")];
    expect((await gd.localizeFromRuns(runs, 0.5, oneVessel, fileFor, NOW2)).state).toBe("sited");
    expect((await gd.localizeFromRuns(runs, 0.75, oneVessel, fileFor, NOW2))).toMatchObject({ state: "unknown", kind: "mixed" });
  });
  it("MUST-FAIL: an environment-looking error envelope never sites (output_error stays unknown even with a unique vessel)", async () => {
    const runs = [A("d1", "output_error", "shell_result"), A("d2", "output_error", "shell_result"), A("d3", "output_error", "shell_result")];
    const loc = await gd.localizeFromRuns(runs, 0.5, oneVessel, fileFor, NOW2);
    expect(loc).toMatchObject({ state: "unknown", kind: "output_error" });
    expect(loc.edit_site).toBeUndefined();
  });
  it("MUST-FAIL: prose never sites — composition runs stay unknown whatever the goal/judge text names", async () => {
    const loc = await gd.localizeFromRuns([A("d1", "composition"), A("d2", "composition")], 0.5, oneVessel, fileFor, NOW2);
    expect(loc).toMatchObject({ state: "unknown", kind: "composition" });
    // through attributeRun: a reason naming a file and a vessel does not make a site
    const viaProse = gd.attributeRun("d5", T([["scan", true]]), "The output did not provide it; fix repos/ledger-vessel/src/resolvers/ledger.ts in the ledger vessel");
    expect(viaProse.kind).toBe("composition");
  });
  it("mixed causes (two failing resolvers, one composition) → unknown 'mixed' with the per-run breakdown", async () => {
    const runs = [A("d1", "step_failure", "a_write"), A("d2", "step_failure", "b_trace"), A("d3", "composition"), A("d4", "composition")];
    const loc = await gd.localizeFromRuns(runs, 0.6, oneVessel, fileFor, NOW2);
    expect(loc).toMatchObject({ state: "unknown", kind: "mixed" });
    expect(loc.why).toContain("a_write×1");
    expect(loc.runs.length).toBe(4);
  });
  it("a failing step served by several local vessels, or with no located file, stays a loud unknown naming why", async () => {
    const runs = [A("d1", "step_failure", "c_write"), A("d2", "step_failure", "c_write")];
    const amb = await gd.localizeFromRuns(runs, 0.5, async () => ({ why: "c_write is served by 2 local vessels: store-a, store-b" }), fileFor, NOW2);
    expect(amb).toMatchObject({ state: "unknown", kind: "step_failure", failing_activity: "c_write" });
    expect(amb.why).toContain("2 local vessels");
    const nofile = await gd.localizeFromRuns(runs, 0.5, oneVessel, async () => null, NOW2);
    expect(nofile).toMatchObject({ state: "unknown", vessel: "c-write-vessel" });
  });
  it("no readable trace → unknown trace_unreadable", async () => {
    expect(await gd.localizeFromRuns([A("d1", "trace_unreadable")], 0.5, oneVessel, fileFor, NOW2)).toMatchObject({ state: "unknown", kind: "trace_unreadable" });
  });
  it("localizeRow: reads each counted run's trace by its execution id; needsLocalization is true until every counted run is attributed", async () => {
    const G = "tabulate the late shipments per carrier";
    const hh = grt.goalHashOf(G);
    const tallies = gd.tallyUpdate({}, [1, 2].map((i) => run(`L${i}`, G, 5 - i, false, "The required table was not produced.", { executionId: `exec_L${i}` })), NOW, P(), never).tallies;
    const row: Row = { id: `goal-deficiency-${hh}-deliverable_not_produced`, status: "open", classification_metadata: { kind: "goal_content_deficiency", goal_hash: hh, dispatch_ids: ["L1", "L2"] } };
    expect(grt.needsLocalization(row)).toBe(true);
    const read: string[] = [];
    const loc = await grt.localizeRow(row, tallies, 0.5, NOW, { readTrace: async (id: string | null) => { read.push(String(id)); return T([["carrier_report", false]], "carrier_report failed: column eta missing") as Row; }, vesselOf: oneVessel, locate: fileFor });
    expect(read).toEqual(["exec_L1", "exec_L2"]);
    expect(loc).toMatchObject({ state: "sited", failing_activity: "carrier_report" });
    expect(grt.needsLocalization({ ...row, classification_metadata: { ...(row["classification_metadata"] as Row), localization: loc } })).toBe(false);
    expect(grt.needsLocalization({ ...row, classification_metadata: { ...(row["classification_metadata"] as Row), dispatch_ids: ["L1", "L2", "L3"], localization: loc } })).toBe(true);
  });
  it("siting_majority and max_localizations are read from the policy record (defaults 0.5 and 5)", () => {
    expect(gd.parseDeficiencyPolicy(null).policy).toMatchObject({ siting_majority: 0.5, max_localizations: 5 });
    expect(gd.parseDeficiencyPolicy({ siting_majority: 0.8, max_localizations: 2 }).policy).toMatchObject({ siting_majority: 0.8, max_localizations: 2 });
  });
  const bad: Array<[string, unknown]> = [["siting_majority 0", { siting_majority: 0 }], ["siting_majority above 1", { siting_majority: 1.5 }], ["siting_majority a string", { siting_majority: "half" }], ["max_localizations above 50", { max_localizations: 51 }]];
  for (const [label, body] of bad) it(`invalid (${label}) → ok false`, () => { expect(gd.parseDeficiencyPolicy(body).ok).toBe(false); });
});

// #1b: per distinct failing step of a localized deficiency, a linked step gap (reuse first, by (resolver, failure class)),
// sited from discovery + the locator and carrying the goal's demand. Output errors and composition runs never make a child.
describe("#1b: step children of a deficiency", () => {
  const S = (id: string, r: string, cls = "execution_error", ex?: string): Row => ({ dispatch_id: id, kind: "step_failure", resolver: r, failure_class: cls, ...(ex ? { failure_excerpt: ex } : {}) });
  const vesselOk = async (r: string) => ({ vessel: `${r.split("_")[0]}-vessel` });
  const fileOk = async (v: string, r: string) => ({ file: `repos/${v}/src/resolvers/${r}.ts`, method: "grep_unique" });
  const parent: Row = { id: "goal-deficiency-abc-x", status: "open", classification_metadata: { goal_hash: "abc", dispatch_ids: ["d1", "d2"] } };
  const LOC = (runs: Row[]) => ({ state: "unknown", kind: "mixed", counts: {}, runs });
  const recorder = () => { const writes: Row[] = []; return { writes, write: async (p: Row) => { writes.push(p); return { shape: "substrateGapWriteResult", body: { action: "created" } }; } }; };
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

  it("stepChildren: two runs at the same (resolver, class) make ONE child with both dispatch ids; a different class at that resolver is another", () => {
    const plans = gd.stepChildren([S("d1", "ledger_post", "execution_error", "first"), S("d2", "ledger_post", "execution_error", "second"), S("d3", "ledger_post", "timeout"), { dispatch_id: "d4", kind: "composition" }]);
    expect(plans).toEqual([{ resolver: "ledger_post", failure_class: "execution_error", dispatch_ids: ["d1", "d2"], excerpt: "first" }, { resolver: "ledger_post", failure_class: "timeout", dispatch_ids: ["d3"] }]);
  });
  it("attributeRun carries the trace's failure class; no class → unclassified_failure", () => {
    const t = (fm: Row | null) => ({ tasks: [{ resolver_id: "ledger_post", status: "failure" }], failure_mode: fm });
    expect(gd.attributeRun("d1", t({ type: "timeout", reason: "deadline exceeded after 30s" }), "x").failure_class).toBe("timeout");
    expect(gd.attributeRun("d2", t(null), "x").failure_class).toBe("unclassified_failure");
  });
  it("MUST-FAIL: an environment error envelope never becomes a child (output_error runs write nothing)", async () => {
    const r = recorder();
    const out = await quiet(() => grt.ensureStepChildren(parent, LOC([{ dispatch_id: "d1", kind: "output_error", resolver: "shell_result" }, { dispatch_id: "d2", kind: "output_error", resolver: "shell_result" }]), async () => [], r.write, { vesselOf: vesselOk, locate: fileOk }));
    expect(out).toEqual([]);
    expect(r.writes).toEqual([]);
  });
  it("MUST-FAIL: prose never sites a child — composition runs (whatever the reason names) write nothing", async () => {
    const viaProse = gd.attributeRun("d5", { tasks: [{ resolver_id: "scan", status: "success" }], failure_mode: null }, "fix repos/ledger-vessel/src/resolvers/ledger_post.ts");
    const r = recorder();
    const out = await quiet(() => grt.ensureStepChildren(parent, LOC([viaProse, { dispatch_id: "d6", kind: "composition" }]), async () => [], r.write, { vesselOf: vesselOk, locate: fileOk }));
    expect(out).toEqual([]);
    expect(r.writes).toEqual([]);
  });
  it("MUST-FAIL: two runs at the same resolver write ONE child, carrying the goal's demand", async () => {
    const r = recorder();
    const out = await quiet(() => grt.ensureStepChildren(parent, LOC([S("d1", "ledger_post", "execution_error", "ledger_post POST returned 400: owner missing"), S("d2", "ledger_post")]), async () => [], r.write, { vesselOf: vesselOk, locate: fileOk }));
    expect(out).toEqual([{ id: gd.stepGapId("ledger_post", "execution_error"), resolver: "ledger_post", failure_class: "execution_error", state: "filed" }]);
    expect(r.writes.length).toBe(1);
    expect(r.writes[0]!.demand_goals_append).toEqual([{ source: "goal_reach", goal_hash: "abc", dispatch_id: "d2", origin: "autonomous" }]);
    expect(r.writes[0]!.gap.classification_metadata).toMatchObject({ failing_activity: "ledger_post", failure_class: "execution_error", vessel: "ledger-vessel", edit_site: "repos/ledger-vessel/src/resolvers/ledger_post.ts", step_dispatch_ids: ["d1", "d2"] });
    expect(r.writes[0]!.gap.classification_metadata.falsifier_spec).toContain('"ledger_post POST returned 400: owner missing"');
  });
  it("an unsited step (several serving vessels, or no located file) writes nothing and is recorded loudly with why", async () => {
    const r = recorder();
    const amb = await quiet(() => grt.ensureStepChildren(parent, LOC([S("d1", "concept_put")]), async () => [], r.write, { vesselOf: async () => ({ why: "concept_put is served by 2 local vessels" }), locate: fileOk }));
    expect(amb).toEqual([{ resolver: "concept_put", failure_class: "execution_error", state: "unsited", why: "concept_put is served by 2 local vessels" }]);
    const nofile = await quiet(() => grt.ensureStepChildren(parent, LOC([S("d1", "concept_put")]), async () => [], r.write, { vesselOf: vesselOk, locate: async () => null }));
    expect(nofile[0]).toMatchObject({ state: "unsited", why: "no single file located in concept-vessel" });
    expect(r.writes).toEqual([]);
  });
  it("reuse keeps an existing row's own falsifier_spec and writes only while it is still open", async () => {
    const r = recorder();
    const row: Row = { id: "older-row", status: "open", detected_at: "2030-01-01T00:00:00Z", summary: "s", classification_metadata: { failing_activity: "ledger_post", failure_class: "execution_error", falsifier_spec: "its own check" } };
    const out = await quiet(() => grt.ensureStepChildren(parent, LOC([S("d1", "ledger_post", "execution_error", "ledger_post POST returned 400: owner missing")]), async () => [row], r.write, { vesselOf: vesselOk, locate: fileOk }));
    expect(out[0]).toMatchObject({ id: "older-row", state: "linked" });
    expect(r.writes[0]!.gap.classification_metadata.falsifier_spec).toBe("its own check");
    expect(r.writes[0]!.expect_status).toBe("open");
  });
  it("a refused write is reported as refused, not filed or linked", async () => {
    const out = await quiet(() => grt.ensureStepChildren(parent, LOC([S("d1", "ledger_post")]), async () => [], async () => ({ shape: "structuredError", body: { skip_reason: "status_precondition_failed" } }), { vesselOf: vesselOk, locate: fileOk }));
    expect(out[0]).toMatchObject({ state: "refused", why: "status_precondition_failed" });
  });
  it("findStepGap: own (failing_activity + class) first, newest; else a cluster key naming the resolver and the SAME class; closed rows and other classes never match", () => {
    const rows: Row[] = [
      { id: "closed-own", status: "closed", detected_at: "2030-02-01T00:00:00Z", classification_metadata: { failing_activity: "trace_fetch", failure_class: "execution_error" } },
      { id: "cluster-old", status: "open", detected_at: "2030-01-01T00:00:00Z", classification_metadata: { cluster_key: "learned-satisfier-trace-fetch|execution_error" } },
      { id: "cluster-new", status: "open", detected_at: "2030-01-02T00:00:00Z", classification_metadata: { cluster_key: "tpl:trace_fetch|execution_error" } },
      { id: "cluster-other-class", status: "open", detected_at: "2030-01-03T00:00:00Z", classification_metadata: { cluster_key: "learned-satisfier-trace-fetch|timeout" } },
      { id: "cluster-prefix-only", status: "open", detected_at: "2030-01-04T00:00:00Z", classification_metadata: { cluster_key: "trace-fetch-extended|execution_error" } },
    ];
    expect(gd.findStepGap(rows, "trace_fetch", "execution_error")?.id).toBe("cluster-new");
    expect(gd.findStepGap([...rows, { id: "own", status: "open", detected_at: "2029-01-01T00:00:00Z", classification_metadata: { failing_activity: "trace_fetch", failure_class: "execution_error" } }], "trace_fetch", "execution_error")?.id).toBe("own");
    expect(gd.findStepGap(rows, "trace_fetch", "parse_error")).toBeNull();
    expect(gd.findStepGap(rows.slice(0, 1), "trace_fetch", "execution_error")).toBeNull();
  });
  it("observedFailureText: the first line, quotes made safe, bounded; too short or one token → null", () => {
    expect(gd.observedFailureText('fetch "x" failed with 404\nstack...')).toBe("fetch 'x' failed with 404");
    expect(gd.observedFailureText("x".repeat(400))).toBeNull();
    expect(gd.observedFailureText("a ".repeat(200))!.length).toBeLessThanOrEqual(160);
    expect(gd.observedFailureText("short err")).toBeNull();
    expect(gd.observedFailureText(undefined)).toBeNull();
  });
  it("the tick files step children only when the policy files gaps (file_gaps 1), and records them on the parent's localization", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
    expect(src).toMatch(/const children = pol\.policy\.file_gaps === 1\s*\?\s*await ensureStepChildren\(/);
    expect(src).toContain("localization: { ...loc, children }");
  });
});

// #1c (exception (a), a regression of #1a): the gap store is SHARED across nodes, the runs are not. A node attributes only
// the runs it holds (its tally, or its own goal-host knows the dispatch); another node's runs are skipped, never written as
// trace_unreadable; every run records the node that attributed it; a node's write MERGES with the other nodes' runs; a
// trace_unreadable written by another node (or before ownership existed) is re-attributed at once by the owner; a node's
// own trace_unreadable is retried after the shaped relocalize_unread_after_ms; and "unreadable" says which hop failed.
describe("#1c: localization is per-run ownership, merged across nodes", () => {
  const G = "summarise the failed deliveries by region";
  const hh = grt.goalHashOf(G);
  const SELF = "node-a", OTHER = "node-b";
  const tallyOf = (ids: string[], over: Row = {}) => gd.tallyUpdate({}, ids.map((id, i) => run(id, G, 9 - i, false, "The required summary was not produced.", { executionId: `exec_${id}`, ...over })), NOW, P(), never).tallies;
  const rowOf = (ids: string[], runs?: Row[]): Row => ({ id: `goal-deficiency-${hh}-deliverable_not_produced`, status: "open", classification_metadata: { kind: "goal_content_deficiency", goal_hash: hh, dispatch_ids: ids, ...(runs ? { localization: { state: "unknown", kind: "trace_unreadable", runs } } : {}) } });
  const stepTrace = (r: string) => ({ tasks: [{ resolver_id: r, status: "failure" }], failure_mode: { type: "execution_error", reason: `${r} POST returned 400: field region missing` } }) as Row;
  const oneVessel = async (r: string) => ({ vessel: `${r.replace(/_/g, "-")}-vessel` });
  const fileFor = async (v: string, r: string) => ({ file: `repos/${v}/src/resolvers/${r}.ts`, method: "grep_unique" });
  const deps = (over: Row = {}) => ({ self: SELF, retryMs: H, vesselOf: oneVessel, locate: fileFor, readTrace: async () => stepTrace("region_report"), ownGoalHost: async () => null, ...over });

  it("MUST-FAIL: a row whose runs this node does not hold is never attributed (nothing fresh to write), whatever its prior state", async () => {
    const row = rowOf(["x1", "x2"]);
    const loc = await grt.localizeRow(row, {}, 0.5, NOW, deps({ executionIdOf: async (e: Row | undefined) => (e ? "exec_mine" : null) }));
    expect(loc.fresh).toBe(0);
    expect(loc.runs).toEqual([]);
    const poisoned = rowOf(["x1"], [{ dispatch_id: "x1", kind: "composition", node: OTHER, at: NOW - H }]);
    const loc2 = await grt.localizeRow(poisoned, {}, 0.5, NOW, deps({ executionIdOf: async () => null }));
    expect(loc2.fresh).toBe(0);
    expect(loc2.runs).toEqual([{ dispatch_id: "x1", kind: "composition", node: OTHER, at: NOW - H }]);
  });
  it("MUST-FAIL (qa a): a row ALREADY poisoned — another node's trace_unreadable on runs THIS node owns — is re-attributed and the verdict recomputed", async () => {
    const ids = ["p1", "p2", "p3"];
    const row = rowOf(ids, ids.map((id) => ({ dispatch_id: id, kind: "trace_unreadable", node: OTHER, at: NOW - 60_000 })));
    expect(grt.needsLocalization(row, SELF, NOW, H)).toBe(true);
    const loc = await grt.localizeRow(row, tallyOf(ids), 0.5, NOW, deps());
    expect(loc.fresh).toBe(3);
    expect(loc).toMatchObject({ state: "sited", kind: "step_failure", failing_activity: "region_report" });
    expect(loc.runs.every((r: Row) => r.node === SELF && r.kind === "step_failure")).toBe(true);
    // the same for rows written before ownership existed (no node recorded on the run)
    const legacy = rowOf(ids, ids.map((id) => ({ dispatch_id: id, kind: "trace_unreadable" })));
    expect((await grt.localizeRow(legacy, tallyOf(ids), 0.5, NOW, deps())).fresh).toBe(3);
  });
  it("MUST-FAIL (qa b): every fresh run records the attributing node and time; another node's attribution survives the merge", async () => {
    const row = rowOf(["mine", "theirs"], [{ dispatch_id: "theirs", kind: "composition", node: OTHER, at: NOW - H }]);
    const loc = await grt.localizeRow(row, tallyOf(["mine"]), 0.5, NOW, deps());
    expect(loc.fresh).toBe(1);
    expect(loc.runs).toEqual([
      { dispatch_id: "mine", kind: "step_failure", resolver: "region_report", failure_excerpt: "region_report POST returned 400: field region missing", failure_class: "execution_error", node: SELF, at: NOW },
      { dispatch_id: "theirs", kind: "composition", node: OTHER, at: NOW - H },
    ]);
  });
  it("this node's own trace_unreadable is retried only after relocalize_unread_after_ms; its readable verdicts stand", async () => {
    const recent = rowOf(["r1"], [{ dispatch_id: "r1", kind: "trace_unreadable", unread: "trace_read_failed", node: SELF, at: NOW - 60_000 }]);
    expect(grt.needsLocalization(recent, SELF, NOW, H)).toBe(false);
    expect((await grt.localizeRow(recent, tallyOf(["r1"]), 0.5, NOW, deps())).fresh).toBe(0);
    const old = rowOf(["r1"], [{ dispatch_id: "r1", kind: "trace_unreadable", unread: "trace_read_failed", node: SELF, at: NOW - 2 * H }]);
    expect(grt.needsLocalization(old, SELF, NOW, H)).toBe(true);
    expect((await grt.localizeRow(old, tallyOf(["r1"]), 0.5, NOW, deps())).fresh).toBe(1);
    const settled = rowOf(["r1"], [{ dispatch_id: "r1", kind: "composition", node: SELF, at: NOW - 30 * H }]);
    expect(grt.needsLocalization(settled, SELF, NOW, H)).toBe(false);
  });
  it("MUST-FAIL: a legacy tally entry with no execution id and no node resolves through THIS node's own goal-host; a dispatch it does not know is not this node's run", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
      return id === "legacy-1" ? Response.json({ dispatchId: id, executionId: "exec_legacy_1" }) : new Response("not found", { status: 404 });
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const tallies = tallyOf(["legacy-1"], { executionId: undefined, node: null });
      const e = tallies[hh]!.entries[0] as Row;
      expect(e.execution_id ?? null).toBeNull();
      expect(e.node ?? null).toBeNull();
      const read: string[] = [];
      const loc = await grt.localizeRow(rowOf(["legacy-1", "foreign-9"]), tallies, 0.5, NOW, deps({ ownGoalHost: async () => base, readTrace: async (x: string | null) => { read.push(String(x)); return stepTrace("region_report"); } }));
      expect(read).toEqual(["exec_legacy_1"]);
      expect(loc.fresh).toBe(1);
      expect(loc.runs.map((r: Row) => r.dispatch_id)).toEqual(["legacy-1"]);
    } finally { server.stop(true); }
  });
  it("unreadable says which hop failed: execution id unknown vs trace read failed, counted in the why", async () => {
    const ids = ["u1", "u2"];
    const loc = await grt.localizeRow(rowOf(ids), tallyOf(ids), 0.5, NOW, deps({ executionIdOf: async (_e: Row | undefined, id: string) => (id === "u1" ? null : "exec_u2"), readTrace: async () => null }));
    expect(loc.runs).toEqual([
      { dispatch_id: "u1", kind: "trace_unreadable", unread: "execution_id_unknown", node: SELF, at: NOW },
      { dispatch_id: "u2", kind: "trace_unreadable", unread: "trace_read_failed", node: SELF, at: NOW },
    ]);
    expect(loc.why).toContain("execution id unknown 1, trace read failed 1");
  });
  it("relocalize_unread_after_ms is a shaped policy field (default 1 h; out of range → ok false)", () => {
    expect(gd.parseDeficiencyPolicy(null).policy.relocalize_unread_after_ms).toBe(3_600_000);
    expect(gd.parseDeficiencyPolicy({ relocalize_unread_after_ms: 7_200_000 }).policy.relocalize_unread_after_ms).toBe(7_200_000);
    expect(gd.parseDeficiencyPolicy({ relocalize_unread_after_ms: 1000 }).ok).toBe(false);
  });
  it("wiring: the tick localizes only rows whose goal has a tally on this node, and never writes when nothing was attributed here", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
    expect(src).toMatch(/&& !!up\.tallies\[String\(/);
    expect(src).toContain("needsLocalization(g, self, now, pol.policy.relocalize_unread_after_ms)");
    expect(src).toContain("if (fresh === 0) continue;");
  });
});

// #1d (exception (a), a gap in our C-tally-1 follow-up): entries tallied BEFORE unread/unrecorded existed carry no reason and
// no class (and often no node). reasonsToRead re-read only class "unread" with a node, and reclassifyStored skips a missing
// reason, so those runs were never read and never counted: a goal could sit below min_runs forever while its goal-host held a
// reason for every run. Now a legacy entry is unread; with no node it is read through this node's own goal-host; and any
// unread run whose record stays unreadable for the shaped max_reason_read_attempts becomes UNRECORDED (never re-read), so
// old or foreign runs cannot hold the oldest-first read budget forever.
describe("#1d: legacy reasonless entries are read, then counted", () => {
  const G = "list the overdue library loans by branch";
  const hh = grt.goalHashOf(G);
  const OWN = "http://own-goal-host.test/v2/impulses/resolve";
  const legacy = (id: string, at: number, node?: string): Row => ({ dispatch_id: id, at, reached: false, reason: "", class: null, ...(node ? { node } : {}) });
  const tallyWith = (entries: Row[]): Record<string, Row> => ({ [hh]: { goal_hash: hh, goal: G, origin: "human", entries, updated_at: NOW } });

  it("MUST-FAIL: a legacy entry (no reason, no class, no node) is read through this node's own goal-host; without a fallback it is not", () => {
    const t = tallyWith([legacy("lg1", NOW - 3 * H)]);
    expect(gd.reasonsToRead(t, [], 30, OWN)).toEqual([{ dispatchId: "lg1", node: OWN, goal_hash: hh, at: NOW - 3 * H }]);
    expect(gd.reasonsToRead(t, [], 30)).toEqual([]);
  });
  it("a legacy entry that names its node is read there, not through the fallback; a reached or reasoned entry is never read", () => {
    const t = tallyWith([legacy("lg2", NOW - 2 * H, "http://ran-here.test/resolve"), { dispatch_id: "ok", at: NOW - H, reached: true, reason: "", class: null }, { dispatch_id: "rs", at: NOW - H, reached: false, reason: "The required table was not produced.", class: "deliverable_not_produced" }]);
    expect(gd.reasonsToRead(t, [], 30, OWN)).toEqual([{ dispatchId: "lg2", node: "http://ran-here.test/resolve", goal_hash: hh, at: NOW - 2 * H }]);
  });
  it("MUST-FAIL: UNRECORDED (read, the record gave none) is never re-read, even with a fallback", () => {
    const t = tallyWith([{ dispatch_id: "ur", at: NOW - H, reached: false, reason: "", class: gd.UNRECORDED_CLASS }]);
    expect(gd.reasonsToRead(t, [], 30, OWN)).toEqual([]);
  });
  it("MUST-FAIL: a record that stays unreadable becomes UNRECORDED after max_reason_read_attempts and leaves the read queue", () => {
    const t = tallyWith([legacy("gone", NOW - 9 * H)]);
    expect(gd.recordFailedRead(t, hh, "gone", 3)).toBe("counted");
    expect(gd.recordFailedRead(t, hh, "gone", 3)).toBe("counted");
    expect(gd.reasonsToRead(t, [], 30, OWN).map((x: Row) => x.dispatchId)).toEqual(["gone"]);
    expect(gd.recordFailedRead(t, hh, "gone", 3)).toBe("unrecorded");
    expect(t[hh].entries[0].class).toBe(gd.UNRECORDED_CLASS);
    expect(gd.reasonsToRead(t, [], 30, OWN)).toEqual([]);
    expect(gd.recordFailedRead(t, hh, "not-tallied", 3)).toBe("absent");
  });
  it("MUST-FAIL (qa): a legacy entry, once read and classed, counts toward min_runs on the next decision", () => {
    const reason = "The required list was not produced.";
    let tallies: Record<string, Row> = tallyWith([
      { dispatch_id: "r1", at: NOW - 5 * H, reached: false, reason, class: "deliverable_not_produced", class_source: "operator_map" },
      legacy("r2", NOW - 4 * H), legacy("r3", NOW - 3 * H),
    ]);
    expect(gd.deficiencyDecisions(tallies, new Map(), NOW, P()).candidates.filter((c: Row) => c.goal_hash === hh)).toEqual([]);
    const queue = gd.reasonsToRead(tallies, [], 30, OWN);
    expect(queue.map((x: Row) => x.dispatchId)).toEqual(["r2", "r3"]);
    // the reader's result, as the tick feeds it back: a run with the read reason and the node it was read from
    const read = queue.map((x: Row) => ({ dispatchId: x.dispatchId, goal_hash: hh, goal: G, status: "failed", reached: false, operator: null, origin: "human", startedAt: x.at, endedAt: x.at, goalReachReason: reason, completionShapes: [], node: x.node, reason_unrecorded: false }));
    tallies = gd.tallyUpdate(tallies, read, NOW, P(), never).tallies;
    expect(tallies[hh].entries.every((e: Row) => e.class === "deliverable_not_produced")).toBe(true);
    expect(tallies[hh].entries.filter((e: Row) => e.dispatch_id !== "r1").every((e: Row) => e.node === OWN)).toBe(true);
    const c = gd.deficiencyDecisions(tallies, new Map(), NOW, P()).candidates.filter((x: Row) => x.goal_hash === hh);
    expect(c).toEqual([expect.objectContaining({ goal_hash: hh, reason_class: "deliverable_not_produced", count: 3 })]);
  });
  it("max_reason_read_attempts is a shaped policy field (default 3; out of range → ok false)", () => {
    expect(gd.parseDeficiencyPolicy(null).policy.max_reason_read_attempts).toBe(3);
    expect(gd.parseDeficiencyPolicy({ max_reason_read_attempts: 5 }).policy.max_reason_read_attempts).toBe(5);
    expect(gd.parseDeficiencyPolicy({ max_reason_read_attempts: 0 }).ok).toBe(false);
  });
  it("wiring: the tick reads legacy entries through its own goal-host, and counts a failed read toward the bound and persists it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
    expect(src).toContain('const ownWalk = await ownUrls("goalWalkState")');
    expect(src).toContain("gd.reasonsToRead(tallies, runs, pol.policy.max_reason_reads, ownWalk)");
    expect(src).toContain("gd.recordFailedRead(tallies, n.goal_hash, n.dispatchId, pol.policy.max_reason_read_attempts)");
    expect(src).toContain("for (const h of failedReadHashes) if (!up.touched.includes(h)) up.touched.push(h);");
  });
});

// #1e (exception (a), a #1a/#1b regression found live): vesselOfResolver read `vesselId` from discovery producers, but the
// ias discovery adapter maps every row's id/vesselId into `id`. Every step read "no local vessel serves" on node1
// (11:58Z, concept_write and execution_trace) while the unit fixtures, hand-made with `vesselId`, passed. The fixture here
// is the LIVE discovery answer for both shapes (captured 2026-10-13 via the cockpit registry read: the vesselCapability
// rows), passed through the REAL HttpDiscoveryAdapter, so the test reads exactly what production reads.
describe("#1e: the serving vessel is read from discovery as the real adapter maps it", () => {
  const CAPTURED: Record<string, Row[]> = {
    execution_trace: [
      { vesselId: "development-vessel-local", endpoint: "http://localhost:18090", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "development-vessel-local@syzygy-hub", endpoint: "http://127.0.0.1:18401", protocol: "libp2p", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "development-vessel-local@spoke-cfaaaa8d", endpoint: "http://127.0.0.1:18401", protocol: "libp2p", resolve_endpoint: "/v2/impulses/resolve" },
    ],
    concept_write: [
      { vesselId: "concept-db-local", endpoint: "http://127.0.0.1:18260", protocol: "http", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "development-vessel-local", endpoint: "http://localhost:18090", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "concept-db-local@syzygy-hub", endpoint: "http://127.0.0.1:18401", protocol: "libp2p", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "development-vessel-local@syzygy-hub", endpoint: "http://127.0.0.1:18401", protocol: "libp2p", resolve_endpoint: "/v2/impulses/resolve" },
      { vesselId: "development-vessel-local@spoke-cfaaaa8d", endpoint: "http://127.0.0.1:18401", protocol: "libp2p", resolve_endpoint: "/v2/impulses/resolve" },
    ],
  };
  const withLiveDiscovery = async <T>(f: () => Promise<T>): Promise<T> => {
    const { HttpDiscoveryAdapter } = await import("@avigopal/ias-executor-ts/adapters");
    const cfg = await import("../../src/config.js");
    const port = { request: async (_u: string, init?: RequestInit) => { const shape = JSON.parse(String(init?.body ?? "{}"))?.pointer?.shape; return Response.json({ content: { shape, vessels: CAPTURED[shape] ?? [], found: !!CAPTURED[shape] } }); } };
    cfg.__setDiscoveryForTests(new HttpDiscoveryAdapter(port as never, "http://discovery.fixture") as never);
    try { return await f(); } finally { cfg.__resetDiscoveryForTests(); }
  };
  it("MUST-FAIL: execution_trace, served by one local vessel (plus federated rows), is sited in development-vessel", async () => {
    expect(await withLiveDiscovery(() => grt.vesselOfResolver("execution_trace", { repoExists: (r: string) => r === "repos/development-vessel" }))).toEqual({ vessel: "development-vessel" });
  });
  it("MUST-FAIL: concept_write, served by two local vessels, says so by name (never 'no local vessel')", async () => {
    expect(await withLiveDiscovery(() => grt.vesselOfResolver("concept_write", { repoExists: () => true }))).toEqual({ why: "concept_write is served by 2 local vessels: concept-db-local, development-vessel-local" });
  });
  it("controls: a shape no vessel serves says no local vessel; a local vessel with no repo here says so", async () => {
    expect(await withLiveDiscovery(() => grt.vesselOfResolver("unserved_fixture_shape", { repoExists: () => true }))).toEqual({ why: "no local vessel serves unserved_fixture_shape" });
    expect(await withLiveDiscovery(() => grt.vesselOfResolver("execution_trace", { repoExists: () => false }))).toEqual({ why: "development-vessel-local maps to no repo here (development-vessel)" });
  });
});

// PACKAGE A (user ruling 10-13): the producer dispatcher sends goal-linked missing-producer demand into the EXISTING
// capability author route, arming the capability row from the shape's contract (package B/B2) with its planned CREATE
// target. Intake: open goal-linked capability_gap rows, and deficiency rows whose inferred target shapes (from the record:
// tally missing_shapes, else the walkLog inference JSON) no step produced. Reuse first; loud skips; shaped budget/cooldown.
describe("package A: the producer dispatcher", () => {
  const pd = async () => (await import("../../src/resolvers/producer-dispatch.js")) as Record<string, any>;
  const T0 = Date.parse("2030-06-01T00:00:00Z");
  const INFER = (shapes: string[]) => `[goal-host-vessel] /run-goal: goal-target inference {"goal_hash":"aaaa1111","inferred_target_shapes":${JSON.stringify(shapes)},"confidence":0.8,"alternatives":[]}`;
  const PRODUCED = (s: string) => `[goal-host-vessel] walk(/run-goal): VESSEL-RESOLVE SATISFIER produced "${s}" directly (connected vessel resolve) — no bridge needed`;
  const capRow = (shape: string, over: Row = {}): Row => ({ id: `gap-${shape.replace(/_/g, "-")}`, status: "open", classification_metadata: { kind: "capability_gap", missing_shape: shape, goal: "tabulate the overdue parcels per depot", demand_goals: [{ source: "goal_reach", goal_hash: "aaaa1111" }], ...over } });
  const defRow = (ids: string[], over: Row = {}): Row => ({ id: "goal-deficiency-aaaa1111-write_goal_no_artifact", status: "open", classification_metadata: { kind: "goal_content_deficiency", goal_hash: "aaaa1111", dispatch_ids: ids, ...over } });
  const deps = (over: Row = {}) => ({ isWrite: (s: string) => /_write$/.test(s) || s === "fs_edit", advertised: async () => false, readRun: async () => ({ goal: "tabulate the overdue parcels per depot", walkLog: [INFER(["parcel_backlog_report"])], completionShapes: [] }), declaredBy: async () => [] as string[], ...over });
  const none = () => [] as string[];
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

  it("reads the inferred targets from the walkLog's JSON payload only, and the produced shapes from the record", async () => {
    const m = await pd();
    expect(m.inferredTargets([PRODUCED("x"), INFER(["a_report", "b view"])])).toEqual(["a_report", "b view"]);
    expect(m.inferredTargets(["no inference here"])).toBeNull();
    expect([...m.producedShapes([PRODUCED("a_report")], ["c_list"])].sort()).toEqual(["a_report", "c_list"]);
  });
  it("MUST-PASS: a deficiency row whose inferred target has NO advertised producer and was not produced → one author request", async () => {
    const r = await (await pd()).planProducerDemand([defRow(["r1"])], T0, H, none, deps());
    expect(r.plans).toEqual([{ shape: "parcel_backlog_report", goal: "tabulate the overdue parcels per depot", goal_hash: "aaaa1111", source_gap: "goal-deficiency-aaaa1111-write_goal_no_artifact", via: "deficiency", dispatch_id: "r1" }]);
  });
  it("MUST-FAIL (live negative, e643b8f8-shaped): every inferred target WAS produced → loud skip, no request", async () => {
    const rec = { walkLog: [INFER(["llm_completion_dispatch"]), PRODUCED("llm_completion_dispatch")], completionShapes: ["webSearchResult"] };
    const r = await (await pd()).planProducerDemand([defRow(["r1"])], T0, H, none, deps({ readRun: async () => rec }));
    expect(r.plans).toEqual([]);
    expect(r.skips).toEqual([expect.objectContaining({ why: "target produced; not a missing-producer deficiency" })]);
  });
  it("MUST-FAIL: a non-identifier target (04698df0-shaped) is skipped loudly, and the next identifier target is judged", async () => {
    const rec = { goal: "tabulate the overdue parcels per depot", walkLog: [INFER(["code_quality with substantive assessment content", "parcel_backlog_report"])], completionShapes: [] };
    const r = await (await pd()).planProducerDemand([defRow(["r1"])], T0, H, none, deps({ readRun: async () => rec }));
    expect(r.skips[0]).toMatchObject({ why: "target is not a shape identifier" });
    expect(r.plans.map((p: Row) => p.shape)).toEqual(["parcel_backlog_report"]);
  });
  it("MUST-FAIL: an advertised target → reuse (no request); unreadable discovery → no request; a write/action target → never authored", async () => {
    const m = await pd();
    expect((await m.planProducerDemand([capRow("parcel_backlog_report")], T0, H, none, deps({ advertised: async () => true }))).skips[0]).toMatchObject({ why: expect.stringMatching(/already advertised: reuse/) });
    expect((await m.planProducerDemand([capRow("parcel_backlog_report")], T0, H, none, deps({ advertised: async () => null }))).skips[0]).toMatchObject({ why: expect.stringMatching(/discovery unreadable/) });
    expect((await m.planProducerDemand([capRow("parcel_write")], T0, H, none, deps())).skips[0]).toMatchObject({ why: expect.stringMatching(/write\/action/) });
  });
  it("intake: an open goal-linked capability row is a candidate; unlinked, closed, or in cooldown is not; the tally's missing_shapes come before the walkLog", async () => {
    const m = await pd();
    expect((await m.planProducerDemand([capRow("parcel_backlog_report")], T0, H, none, deps())).plans).toHaveLength(1);
    expect((await m.planProducerDemand([capRow("parcel_backlog_report", { demand_goals: ["a text goal"] })], T0, H, none, deps())).plans).toHaveLength(0);
    expect((await m.planProducerDemand([{ ...capRow("parcel_backlog_report"), status: "closed" }], T0, H, none, deps())).plans).toHaveLength(0);
    const cooled = capRow("parcel_backlog_report", { producer_dispatch: { at: new Date(T0 - 60_000).toISOString() } });
    expect((await m.planProducerDemand([cooled], T0, H, none, deps())).skips[0]).toMatchObject({ why: expect.stringMatching(/cooldown/) });
    let read = 0;
    const r = await m.planProducerDemand([defRow(["r1"])], T0, H, () => ["depot_load_view"], deps({ readRun: async () => { read++; return null; } }), (h: string) => (h === "aaaa1111" ? "tabulate the overdue parcels per depot" : ""));
    // the goal text comes from the tally when the row carries none; without it, no request
    expect((await m.planProducerDemand([defRow(["r1"])], T0, H, () => ["depot_load_view"], deps())).skips[0]).toMatchObject({ why: expect.stringMatching(/no goal text/) });
    expect(r.plans.map((p: Row) => p.shape)).toEqual(["depot_load_view"]);
    expect(read).toBe(0);
  });
  it("runProducerDispatch: live arms + links + sends at most the budget; dry_run writes and sends nothing; off does nothing", async () => {
    const m = await pd();
    const mk = () => { const writes: Row[] = [], sends: string[] = []; return { writes, sends, d: { ...deps(), write: async (gap: Row, demand: Row) => { writes.push({ gap, demand }); return { ok: true }; }, dispatch: async (id: string) => { sends.push(id); return { ok: true }; } } }; };
    const rows = [capRow("parcel_backlog_report", { evidence_resolve: { shape: "parcel_backlog_report", mode: "producer_contract", required_keys: ["parcels"] } }), capRow("depot_load_view", { demand_goals: [{ source: "goal_reach", goal_hash: "bbbb2222" }] })];
    const pol = { producer_dispatch: "live", max_producer_dispatches: 1, producer_dispatch_cooldown_ms: 6 * H };
    const live = mk();
    const rep = await quiet(() => m.runProducerDispatch(rows, T0, pol, none, live.d));
    expect(live.sends).toEqual(["gap-parcel-backlog-report"]);
    expect(rep.sent).toEqual([{ gap_id: "gap-parcel-backlog-report", shape: "parcel_backlog_report", source_gap: "gap-parcel-backlog-report", tag: "producer_author:aaaa1111:parcel_backlog_report" }]);
    const w = live.writes[0]!;
    expect(w.gap).toMatchObject({ id: "gap-parcel-backlog-report", status: "open", classification_metadata: { kind: "capability_gap", missing_shape: "parcel_backlog_report", evidence_resolve: { shape: "parcel_backlog_report", mode: "producer_contract", required_keys: ["parcels"] }, edit_site: "repos/development-vessel/src/resolvers/parcel-backlog-report.ts", producer_dispatch: { mode: "live", tag: "producer_author:aaaa1111:parcel_backlog_report" } } });
    expect(w.demand).toMatchObject({ source: "goal_reach", goal_hash: "aaaa1111" });
    const dry = mk();
    await quiet(() => m.runProducerDispatch(rows, T0, { ...pol, producer_dispatch: "dry_run" }, none, dry.d));
    expect([dry.writes.length, dry.sends.length]).toEqual([0, 0]);
    const off = mk();
    expect((await quiet(() => m.runProducerDispatch(rows, T0, { ...pol, producer_dispatch: "off" }, none, off.d))).planned).toEqual([]);
    const refused = mk(); refused.d.write = async () => ({ ok: false, why: "status_precondition_failed" });
    const rr = await quiet(() => m.runProducerDispatch(rows, T0, pol, none, refused.d));
    expect([rr.sent.length, rr.refused[0]?.why, refused.sends.length]).toEqual([0, "write refused: status_precondition_failed", 0]);
  });
  it("the armed edit site is the file the author route creates (its shapeToResolverName, kebab-cased)", async () => {
    const m = await pd();
    expect(m.plannedResolverFile("llmTextCompletion")).toBe("repos/development-vessel/src/resolvers/llm-text-completion.ts");
    expect(m.plannedResolverFile("parcel_backlog_report", "ledger-vessel")).toBe("repos/ledger-vessel/src/resolvers/parcel-backlog-report.ts");
    expect(m.capabilityGapId("llmTextCompletion")).toBe("gap-llmtextcompletion");
  });
  it("the policy fields are shaped (defaults live / 1 / 6 h; invalid → ok false) and the tick runs the dispatcher only with file_gaps 1", () => {
    expect(gd.parseDeficiencyPolicy(null).policy).toMatchObject({ producer_dispatch: "live", max_producer_dispatches: 1, producer_dispatch_cooldown_ms: 6 * 3_600_000 });
    for (const bad of [{ producer_dispatch: "yes" }, { max_producer_dispatches: 21 }, { producer_dispatch_cooldown_ms: 10 }]) expect(gd.parseDeficiencyPolicy(bad).ok).toBe(false);
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
    expect(src).toContain('if (pol.policy.file_gaps === 1 && pol.policy.producer_dispatch !== "off") {');
    expect(src).toContain('type: "gap_to_feature", gap_id: gapId, triggered_by: "goal-reach-producer-dispatch"');
  });
});

// CONTAINED IS NOT MISSING (exception (a), 10-13): discovery lists only producers that are UP. A shape that a vessel in the
// running tree DECLARES but discovery does not advertise (masked, disabled, crashed, contained) is never authored, by the
// dispatcher or by the author route; an unreadable tree or an unreadable discovery answer refuses too (fail closed).
describe("contained is not missing: the dispatcher and the author route never author a declared shape", () => {
  const pd = async () => (await import("../../src/resolvers/producer-dispatch.js")) as Record<string, any>;
  const T0 = Date.parse("2030-06-01T00:00:00Z");
  const capRow = (shape: string): Row => ({ id: `gap-${shape.replace(/_/g, "-")}`, status: "open", classification_metadata: { kind: "capability_gap", missing_shape: shape, goal: "list the quarry ledger entries", demand_goals: [{ source: "goal_reach", goal_hash: "bbbb2222" }] } });
  const deps = (over: Row = {}) => ({ isWrite: (s: string) => /_write$/.test(s), advertised: async () => false, readRun: async () => null, declaredBy: async () => [] as string[], ...over });
  const none = () => [] as string[];
  // a fake running tree: vessel dir → declaration file → text
  const tree = (files: Record<string, string>) => ({
    list: (d: string) => { if (d !== "/rt") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return [...new Set(Object.keys(files).map((k) => k.split("/")[0]!))]; },
    read: (f: string) => { const k = f.replace(/^\/rt\//, ""); if (!(k in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); if (files[k] === "<EACCES>") throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return files[k]!; },
  });

  it("MUST-FAIL: a shape declared by a vessel in the tree but not advertised (a masked producer) → skipped, never planned", async () => {
    const m = await pd();
    const r = await m.planProducerDemand([capRow("quarry_ledger")], T0, 3_600_000, none, deps({ declaredBy: async () => ["quarry-vessel"] }));
    expect(r.plans).toEqual([]);
    expect(r.skips[0]).toMatchObject({ shape: "quarry_ledger", why: expect.stringMatching(/declared by quarry-vessel but not advertised: an offline or contained producer/) });
  });

  it("MUST-FAIL: unreadable declarations → skipped (unknown is not absent); a throwing reader too", async () => {
    const m = await pd();
    for (const declaredBy of [async () => null, async () => { throw new Error("EACCES"); }]) {
      const r = await m.planProducerDemand([capRow("quarry_ledger")], T0, 3_600_000, none, deps({ declaredBy }));
      expect(r.plans).toEqual([]);
      expect(r.skips[0]).toMatchObject({ why: expect.stringMatching(/declarations unreadable/) });
    }
  });

  it("MUST-FAIL: a discovery lookup that failed (HTTP 401, timeout, malformed) reads as unreadable, never as 'no producer'", async () => {
    const m = await pd();
    expect(m.advertisedFrom({ ok: false, reason: "http", status: 401 })).toBeNull();
    expect(m.advertisedFrom({ ok: false, reason: "timeout" })).toBeNull();
    expect(m.advertisedFrom({ ok: true })).toBeNull();
    expect(m.advertisedFrom({ ok: true, producers: [] })).toBe(false);
    expect(m.advertisedFrom({ ok: true, producers: [{ id: "x" }] })).toBe(true);
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/goal-reach-tick.ts"), "utf8");
    expect(src).toContain("advertised: async (shape) => pd.advertisedFrom(await lookupShape(shape)),");
    expect(src).toContain("declaredBy: async (shape) => pd.declaredBy(shape,");
  });

  it("CONTROL: declared nowhere, readable tree, not advertised → planned (the missing-producer route still works)", async () => {
    const m = await pd();
    const r = await m.planProducerDemand([capRow("quarry_ledger")], T0, 3_600_000, none, deps());
    expect(r.plans.map((p: { shape: string }) => p.shape)).toEqual(["quarry_ledger"]);
  });

  it("declaredBy reads each vessel's config.ts / index.ts for the quoted shape literal; a missing file declares nothing, an unreadable one (or root) → null", async () => {
    const m = await pd();
    const t = tree({ "quarry-vessel/src/index.ts": 'const RESOLVERS = [["quarry_ledger", ledger]];', "other-vessel/src/config.ts": 'shapes: ["quarry_ledger_summary"]', "third-vessel/src/config.ts": "shapes: ['quarry_ledger']" });
    expect(m.declaredBy("quarry_ledger", "/rt", t)).toEqual(["quarry-vessel", "third-vessel"]);
    expect(m.declaredBy("slate_index", "/rt", t)).toEqual([]);
    expect(m.declaredBy("quarry_ledger", "/missing", t)).toBeNull();
    expect(m.declaredBy("quarry_ledger", "/rt", tree({ "x-vessel/README.md": "quarry_ledger" }))).toEqual([]); // no declaration file: not a vessel
    expect(m.declaredBy("quarry_ledger", "/rt", tree({ "x-vessel/src/config.ts": "<EACCES>", "y-vessel/src/index.ts": '"slate"' }))).toBeNull(); // unreadable declaration: unknown
    expect(m.declaredBy("not a shape", "/rt", t)).toEqual([]);
    expect(m.declaredBy("quarry_ledger", "/rt", tree({}))).toEqual([]); // an empty, listable root declares nothing
  });

  it("MUST-FAIL (author route): containedRefusal refuses a declared shape and an unreadable tree, and gap-to-feature checks it before composing", async () => {
    const m = await pd();
    const t = tree({ "quarry-vessel/src/index.ts": '"quarry_ledger"' });
    expect(m.containedRefusal("quarry_ledger", "/rt", t)).toMatch(/declared by quarry-vessel but not advertised/);
    expect(m.containedRefusal("quarry_ledger", "/missing", t)).toMatch(/declarations unreadable/);
    expect(m.containedRefusal("slate_index", "/rt", t)).toBeNull();
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/gap-to-feature.ts"), "utf8");
    const route = src.slice(src.indexOf("async function routeCapabilityGapToNewResolver("));
    const guard = route.indexOf("const reason = containedRefusal(missingShape, runtimeRoot());");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(route.indexOf("await resolveFeatureCompose("));
  });
});

// NO KEYLESS ARMING (exception (a), 10-13): a producer_contract check with no required keys closes on ANY substantive body, so
// a hollow producer would close it. The dispatcher arms only from a DECLARED contract (required keys already on the row);
// otherwise it records the demand and "not armed", and sends nothing to the author route.
describe("the producer dispatcher arms only a declared contract", () => {
  const pd = async () => (await import("../../src/resolvers/producer-dispatch.js")) as Record<string, any>;
  const T0 = Date.parse("2030-06-01T00:00:00Z"), HR = 3_600_000;
  const pol = { producer_dispatch: "live", max_producer_dispatches: 3, producer_dispatch_cooldown_ms: 6 * HR };
  const cap = (shape: string, over: Row = {}): Row => ({ id: `gap-${shape.replace(/_/g, "-")}`, status: "open", classification_metadata: { kind: "capability_gap", missing_shape: shape, goal: "list the quarry ledger entries", demand_goals: [{ source: "goal_reach", goal_hash: "cccc3333" }], ...over } });
  const io = () => { const writes: Row[] = [], sends: string[] = []; return { writes, sends, d: { isWrite: (x: string) => /_write$/.test(x), advertised: async () => false, readRun: async () => null, declaredBy: async () => [] as string[], write: async (gap: Row, demand: Row) => { writes.push({ gap, demand }); return { ok: true }; }, dispatch: async (id: string) => { sends.push(id); return { ok: true }; } } }; };
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

  it("MUST-FAIL: a shape with NO declared contract is never armed KEYLESS: it is armed on its demanding goal's own reach (the R2 check) and sent once", async () => {
    const m = await pd(); const x = io();
    const gdm = await import("../../src/resolvers/goal-deficiency.js");
    const rep = await quiet(() => m.runProducerDispatch([cap("quarry_ledger")], T0, pol, () => [], x.d));
    expect(x.sends).toEqual(["gap-quarry-ledger"]);
    expect(rep.sent).toHaveLength(1);
    const meta = (x.writes[0]!.gap as Row).classification_metadata as Row;
    expect(meta.evidence_resolve).toEqual(gdm.goalReachCheck("cccc3333"));
    expect(meta.evidence_resolve).toEqual({ shape: "goal_reach_verdict", input: { goal_hash: "cccc3333" }, zero_field: "unreached_since_last_reach" });
    expect((meta.evidence_resolve as Row).mode).toBeUndefined(); // never a producer_contract without keys
    expect(meta.falsifier_spec).toBe(gdm.goalReachFalsifierSpec("cccc3333"));
    expect(meta.producer_dispatch).toMatchObject({ armed: true, arm_basis: "goal_reach" });
    expect((x.writes[0]!.demand as Row).goal_hash).toBe("cccc3333");
  });

  it("MUST-FAIL: no declared contract and no demanding goal hash → nothing arms it (capabilityRowWrite says so)", async () => {
    const m = await pd();
    const w = m.capabilityRowWrite({ shape: "quarry_ledger", goal: "g", goal_hash: "", source_gap: "s", via: "capability_gap" }, null, "2030-06-01T00:00:00.000Z", "live");
    expect(w.armed).toBe(false);
    expect(w.gap.classification_metadata.evidence_resolve).toBeUndefined();
    expect(w.gap.classification_metadata.producer_dispatch).toMatchObject({ armed: false, not_armed: m.NOT_ARMED_NO_GOAL });
  });

  it("MUST-FAIL: an existing goal-reach check on the row is kept as it is (never rewritten to the demanding goal's) and counts as armed (sent)", async () => {
    const m = await pd(); const x = io();
    const gdm = await import("../../src/resolvers/goal-deficiency.js");
    const own = gdm.goalReachCheck("dddd4444"); // another goal's check than the demanding one: kept verbatim, never rewritten
    await quiet(() => m.runProducerDispatch([cap("quarry_ledger", { evidence_resolve: own })], T0, pol, () => [], x.d));
    expect(x.sends).toEqual(["gap-quarry-ledger"]);
    expect(((x.writes[0]!.gap as Row).classification_metadata as Row).evidence_resolve).toEqual(own);
  });

  it("CONTROL: a shape whose contract is declared (required keys on the row) is armed on exactly those keys and sent once", async () => {
    const m = await pd(); const x = io();
    const rep = await quiet(() => m.runProducerDispatch([cap("quarry_ledger", { evidence_resolve: { shape: "quarry_ledger", mode: "producer_contract", required_keys: ["entries", "entries", "count", ""] } })], T0, pol, () => [], x.d));
    expect(x.sends).toEqual(["gap-quarry-ledger"]);
    expect(rep.sent).toHaveLength(1);
    const meta = (x.writes[0]!.gap as Row).classification_metadata as Row;
    expect(meta.evidence_resolve).toEqual({ shape: "quarry_ledger", mode: "producer_contract", required_keys: ["entries", "count"] });
    expect(meta.producer_dispatch).toMatchObject({ armed: true, required_keys: ["entries", "count"] });
  });

  it("MUST-FAIL: a row already armed KEYLESS keeps its check untouched and is not sent again (it is not a declared contract)", async () => {
    const m = await pd(); const x = io();
    const keyless = { shape: "quarry_ledger", mode: "producer_contract" };
    await quiet(() => m.runProducerDispatch([cap("quarry_ledger", { evidence_resolve: keyless })], T0, pol, () => [], x.d));
    expect(x.sends).toEqual([]);
    expect(((x.writes[0]!.gap as Row).classification_metadata as Row).evidence_resolve).toEqual(keyless);
  });

  it("declaredContractKeys reads only a producer_contract check for the same shape; another check or another shape is no contract", async () => {
    const m = await pd();
    expect(m.declaredContractKeys(cap("quarry_ledger", { evidence_resolve: { shape: "quarry_ledger", mode: "producer_contract", required_keys: ["a"] } }), "quarry_ledger")).toEqual(["a"]);
    expect(m.declaredContractKeys(cap("quarry_ledger", { evidence_resolve: { shape: "slate_index", mode: "producer_contract", required_keys: ["a"] } }), "quarry_ledger")).toEqual([]);
    expect(m.declaredContractKeys(cap("quarry_ledger", { evidence_resolve: { shape: "test_suite", input: {}, zero_field: "x" } }), "quarry_ledger")).toEqual([]);
    expect(m.declaredContractKeys(null, "quarry_ledger")).toEqual([]);
  });
});
