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
    ["ungrounded", "deterministic:ungrounded-claim — the figures cite nothing.", [], never, "ungrounded"],
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
