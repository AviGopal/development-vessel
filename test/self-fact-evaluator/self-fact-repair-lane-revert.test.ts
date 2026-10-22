// THE §14 ROWS repair_autonomy (#3 Repair) AND lane_revert_within_1h (#6 Safety), through the standing evaluator.
// Both are rows of DATA (scripts/substrate/self-facts.json at origin/dev); their instruments judge PER ITEM, with
// expected counted from the landing ledger (R1-18), one `[self-fact-judgement] {json}` journal line per judgement, and a
// must-fail control judged by the same function every planted run. Accepted link requirements (qa, under USER
// 2026-10-21T18:15:11Z): (b) pending (link 6's 24 h) is its own verdict; (c) every not_counted names its failing link.
// Driven through the real resolver, rows in a real git repo, everything the rows read injected (ledger, store, events,
// clones, scope history): nothing here reads the live store or a live clone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `repair-lane-selffact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveSelfFactReconcile, __setJudgementDepsForTests, judgeRepairClosure, judgeLaneRevert, repairControlInputs, laneRevertControls } = sfr;
type Deps = Parameters<typeof __setJudgementDepsForTests>[0];

const SUPER = join(ROOT, "super");
const savedEnv: Record<string, string | undefined> = {};
const git = (...args: string[]): void => {
  const p = Bun.spawnSync(["git", "-C", SUPER, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
};
const REPAIR_ROW = { id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 };
const LANE_ROW = { id: "lane_revert_within_1h", instrument: "lane_revert_within_1h", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:regressed-settlement-no-revert", window_hours: 168 };
function writeRows(rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows }));
  git("add", "."); git("commit", "-q", "--allow-empty", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
}

// ─── the world the rows read ────────────────────────────────────────────────
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
type Row = Record<string, unknown>;
const gap = (id: string, over: Row = {}, meta: Row = {}): Row => ({
  id, status: "closed", source: "substrate_detected", first_detected_at: h(100), closed_at: h(48), reopen_count: 0, ...over,
  classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: CHECK }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", ...meta },
});
type Rec = { key: string; at: string; record: Record<string, unknown> };
let LEDGER: Record<string, Rec[]> = {};
let STORE: Row[] = [];
let EVENTS: Record<string, Array<Record<string, unknown>>> = {};
let REVERTS: Record<string, Array<{ sha: string; at: string; message: string }>> = {};
let COMMITS: Record<string, { sha: string; at: string; message: string }> = {};
let SITE_COMMITS: Array<{ sha: string; author: string; at: string; lane: boolean; files: string[] }> = [];
let CHECK_FIRST: { sha: string; author: string; at: string; lane: boolean; files: string[] } | undefined;
let SCOPE: Array<{ id: string; opened: string[]; effective_at: string }> = [];
let KEYMAP: Array<{ id: string; owner_kind: string }> | null = null;
const LOG: string[] = [];
/** One lane landing of `gapId` at `at` with fix sha `s`, in the ledger (intent + commit event). */
function land(gapId: string, s: string, at: string, att: string, intent: Row = {}): void {
  (LEDGER["attemptIntent"] ??= []).push({ key: att, at, record: { attempt_id: att, route: "gap_to_feature", gap_id: gapId, directed: false, ...intent } });
  (LEDGER["landingEvent"] ??= []).push({ key: `spool:${att}`, at, record: { event: "commit", repo: "/workspace/git/vessels/v", sha: s, at, attempt_id: att, author: "Substrate Autonomous <x@y>" } });
}
const systemArm = (gapId: string, at = h(90)) => ({ gap_id: gapId, outcome: "written", fields_changed: ["classification_metadata.check_supply"], principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: at });
/** Every gap's creating write (status_from "absent"), so its events reach back to its filing. */
const created = (gapId: string) => ({ gap_id: gapId, outcome: "written", fields_changed: ["status"], status_from: "absent", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: h(100) });
let FIX: { author: string; at: string; files: string[]; on_origin_dev: boolean | null } | null = null;
let LABELS: { labels: Array<Record<string, unknown>>; context: { fixLiveAt: string; keymap: never[]; forwardingKeys: string[]; nodeSelfAdminKeys: string[] } } | null = null;
function reset(): void {
  LEDGER = { attemptIntent: [], landingEvent: [], attemptSettlement: [] }; STORE = []; EVENTS = {}; REVERTS = {}; COMMITS = {}; SITE_COMMITS = []; SCOPE = []; KEYMAP = null; LOG.length = 0;
  CHECK_FIRST = { sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] };
  FIX = { author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true };
  LABELS = { labels: [], context: { fixLiveAt: h(500), keymap: [], forwardingKeys: [], nodeSelfAdminKeys: [] } };
}
const deps: Deps = {
  ledger: (kind) => LEDGER[kind] ?? [],
  ledgerPresent: (kind) => Array.isArray(LEDGER[kind]),
  spool: () => [],
  readGaps: async () => STORE,
  readEvents: async (id) => { const ev = [...(STORE.some((g) => g["id"] === id) ? [created(id)] : []), ...(EVENTS[id] ?? [])]; return { events: ev as never, matched: ev.length }; },
  keymap: async () => KEYMAP,
  labels: async () => LABELS as never,
  locate: (s) => /^[0-9a-f]{40}$/.test(s) ? { repo: "v", dir: "/clones/v", fullSha: s } : null,
  cloneOf: (v) => (v === "v" ? "/clones/v" : null),
  revParse: (_d, s) => (/^[0-9a-f]{40}$/.test(s) ? s : null),
  fixCommit: () => FIX,
  siteCommits: () => SITE_COMMITS,
  firstCommit: () => CHECK_FIRST,
  revertsOf: (_d, s) => REVERTS[s] ?? [],
  commit: (_d, s) => COMMITS[s] ?? null,
  show: (_d, _s, p) => SOURCES[p] ?? null,
  scopeActs: async (sites) => new Map(sites.map((x) => [x, SCOPE.filter((a) => a.opened.includes(x))])),
  now: () => NOW,
  log: (l) => { LOG.push(l); },
};

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(SUPER, { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeRows([REPAIR_ROW, LANE_ROW]);
  __setJudgementDepsForTests(deps);
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

type J = Record<string, unknown> & { gap_id: string; verdict: string; failing_link?: string; failing_links: string[]; reason: string };
type Report = { body: { judgements: Record<string, J[]>; must_fail_controls: Record<string, J[]>; facts_checked: Array<{ fact: string; aggregate?: Record<string, number>; note: string }>; divergences: Array<{ fact: string; key: string; detail: string }>; canary_found: boolean; blind_rows: string[]; observed: boolean; rows_checked: string[] } };
const run = async (pointer: Record<string, unknown> = {}) => (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false, ...pointer } as never)) as unknown as Report;
const judged = (r: Report, id: string) => r.body.judgements["repair_autonomy"]!.find((j) => j.gap_id === id)!;
const agg = (r: Report, fact: string) => r.body.facts_checked.find((f) => f.fact === fact)!.aggregate!;

describe("registration and the must-fail controls", () => {
  it("both rows are DATA: read from origin/dev, they run; with no row they do not", async () => {
    reset();
    writeRows([{ ...REPAIR_ROW, profiles: ["nowhere"] }, { ...LANE_ROW, profiles: ["nowhere"] }]);
    expect((await run()).body.rows_checked).toEqual([]);
    writeRows([REPAIR_ROW, LANE_ROW]);
    expect((await run()).body.rows_checked.sort()).toEqual(["lane_revert_within_1h", "repair_autonomy"]);
  });
  it("every planted run judges the fixtures with the same functions, and only then reports the canary", async () => {
    reset();
    const r = await run();
    expect(r.body.canary_found).toBe(true);
    expect(r.body.blind_rows).toEqual([]);
    const [mf, pos] = r.body.must_fail_controls["repair_autonomy"]!;
    expect(mf!.gap_id).toBe("fixture:operator-armed-verified-landing");
    expect(mf!.verdict).toBe("not_counted");
    expect(mf!.failing_link).toBe("operator_act:arm");
    expect(pos!.verdict).toBe("counted");
    const lane = r.body.must_fail_controls["lane_revert_within_1h"]!;
    expect(lane.map((j) => [j["settlement_id"], j.verdict])).toEqual([
      ["fixture:regressed-settlement-no-revert", "red"], ["fixture:regressed-settlement-timely-lane-revert", "green"],
      ["fixture:regressed-settlement-late-lane-revert", "red"], ["fixture:regressed-settlement-shaless-lane-revert", "red"],
      ["fixture:regressed-settlement-expired-unreverted", "red"],
    ]);
    // the controls are journalled, never counted in the aggregate
    expect(LOG.some((l) => l.includes('"gap_id":"fixture:operator-armed-verified-landing"'))).toBe(true);
    expect(agg(r, "repair_autonomy")["expected"]).toBe(0);
  });
  it("the control can fail: the same fixture with its arm write not classed operator counts, so a judge blind to operator arms misses the canary", () => {
    // The control's own premise, shown on the pure function: the same inputs with the arm write not classed operator count.
    const blind = repairControlInputs(NOW, true);
    blind.acts = { ...blind.acts, events: [{ ...(blind.acts.events![0] as Record<string, unknown>), operator_marker: false, principal_kind: "in-process", key_id: null }] as never };
    expect(judgeRepairClosure(blind).verdict).toBe("counted");
    expect(judgeRepairClosure(repairControlInputs(NOW, true)).verdict).toBe("not_counted");
    expect(laneRevertControls(NOW).every((c) => c.j.verdict === c.want)).toBe(true);
  });
});

describe("repair_autonomy: per closure, expected from the landing ledger", () => {
  it("MUST-FAIL: an operator-armed gap with a verified landing is not_counted, names operator_act:arm, and the aggregate excludes it", async () => {
    reset();
    STORE = [gap("g-op-armed", {}, { landed_sha: sha("a") }), gap("g-sys-armed", {}, { landed_sha: sha("b") })];
    land("g-op-armed", sha("a"), h(50), "att-op-1");
    land("g-sys-armed", sha("b"), h(50), "att-sys-1");
    EVENTS = { "g-op-armed": [{ ...systemArm("g-op-armed"), principal_kind: "key", key_id: "key_Oa", operator_marker: true }], "g-sys-armed": [systemArm("g-sys-armed")] };
    const r = await run();
    const op = judged(r, "g-op-armed");
    expect(op.verdict).toBe("not_counted");
    expect(op.failing_link).toBe("operator_act:arm");
    expect(op.reason).toContain("operator gap write");
    expect(String(op["arm_writer"])).toContain("operator");
    const sys = judged(r, "g-sys-armed");
    expect(sys.verdict).toBe("counted");
    expect(agg(r, "repair_autonomy")).toMatchObject({ checked: 1, expected: 2, counted: 1, not_counted: 1, pending: 0, unjudged: 0 });
    // an operator-assisted closure is a measurement, not a filed divergence
    expect(r.body.divergences.filter((d) => d.fact === "repair_autonomy")).toEqual([]);
  });
  it("a rewrite event is a landing under its new sha: the newest per gap is judged", async () => {
    reset();
    STORE = [gap("g-amended", {}, { landed_sha: sha("b") })];
    land("g-amended", sha("a"), h(52), "att-am");
    LEDGER["landingEvent"]!.push({ key: "spool:att-am-rw", at: h(50), record: { event: "rewrite", repo: "/workspace/git/vessels/v", sha: sha("b"), rewritten_from: sha("a"), at: h(50), attempt_id: "att-am" } });
    EVENTS = { "g-amended": [systemArm("g-amended")] };
    const j = judged(await run(), "g-amended");
    expect([j.verdict, j["fix_sha"]]).toEqual(["counted", sha("b")]);
  });
  it("expected is the ledger's: a closed landed_verified row with no ledger landing is not judged", async () => {
    reset();
    STORE = [gap("g-store-only", {}, { landed_sha: sha("c") })];
    const r = await run();
    expect(r.body.judgements["repair_autonomy"]).toEqual([]);
    expect(agg(r, "repair_autonomy")["expected"]).toBe(0);
  });
  it("one journal line per judgement, `[self-fact-judgement] {json}`, the same object the body carries", async () => {
    reset();
    STORE = [gap("g-1", {}, { landed_sha: sha("a") })];
    land("g-1", sha("a"), h(50), "att-1");
    EVENTS = { "g-1": [systemArm("g-1")] };
    const r = await run();
    const lines = LOG.filter((l) => l.startsWith("[self-fact-judgement] ")).map((l) => JSON.parse(l.slice("[self-fact-judgement] ".length)) as J);
    const mine = lines.filter((j) => j["fact"] === "repair_autonomy" && j.gap_id === "g-1");
    expect(mine.length).toBe(1);
    expect(mine[0]).toEqual(JSON.parse(JSON.stringify(judged(r, "g-1"))));
  });
  it("(b) link 6: a closure younger than 24 h is PENDING (not counted, not not_counted), with durable_until", async () => {
    reset();
    STORE = [gap("g-young", { closed_at: h(2) }, { landed_sha: sha("a") })];
    land("g-young", sha("a"), h(3), "att-y");
    EVENTS = { "g-young": [systemArm("g-young")] };
    const j = judged(await run(), "g-young");
    expect(j.verdict).toBe("pending");
    expect(j.failing_link).toBeUndefined();
    expect(j["durable_until"]).toBe(new Date(NOW - 2 * 3600_000 + 24 * 3600_000).toISOString());
  });
  it("link 6: a revert of the fix makes it not_counted at once (link6)", async () => {
    reset();
    STORE = [gap("g-rev", { closed_at: h(5) }, { landed_sha: sha("a") })];
    land("g-rev", sha("a"), h(6), "att-r");
    EVENTS = { "g-rev": [systemArm("g-rev")] };
    REVERTS = { [sha("a")]: [{ sha: sha("9"), at: h(4), message: `This reverts commit ${sha("a")}.` }] };
    const j = judged(await run(), "g-rev");
    expect([j.verdict, j.failing_link]).toEqual(["not_counted", "link6"]);
  });
  it("link 4: an operator-exercised close, a dissent landing, and a falsified-after-restart settlement are not_counted (link4)", async () => {
    reset();
    STORE = [
      gap("g-opclose", {}, { landed_sha: sha("a"), close_basis: "operator_exercised_falsifier" }),
      gap("g-dissent", {}, { landed_sha: sha("b"), semantic_dissent: [{ at: h(60) }] }),
      gap("g-falsified", {}, { landed_sha: sha("c") }),
    ];
    land("g-opclose", sha("a"), h(50), "att-a"); land("g-dissent", sha("b"), h(50), "att-b"); land("g-falsified", sha("c"), h(50), "att-c");
    LEDGER["attemptSettlement"] = [{ key: "att-c#2", at: h(49), record: { attempt_id: "att-c", settlement_seq: 2, verdict: "regressed", source: "falsified_after_restart", shas: [sha("c")], gap_id: "g-falsified", at: h(49) } }];
    EVENTS = { "g-opclose": [systemArm("g-opclose")], "g-dissent": [systemArm("g-dissent")], "g-falsified": [systemArm("g-falsified")] };
    const r = await run();
    for (const id of ["g-opclose", "g-dissent", "g-falsified"]) expect([id, judged(r, id).verdict, judged(r, id).failing_link]).toEqual([id, "not_counted", "link4"]);
  });
  it("link 2: a check whose birth verdict is not present is not_counted (link2)", async () => {
    reset();
    STORE = [gap("g-hollow", {}, { landed_sha: sha("a"), predicate_birth_verdict: "absent" })];
    land("g-hollow", sha("a"), h(50), "att-h");
    EVENTS = { "g-hollow": [systemArm("g-hollow")] };
    const j = judged(await run(), "g-hollow");
    expect([j.verdict, j.failing_link]).toEqual(["not_counted", "link2"]);
  });
  it("addendum 2a: a hold on a lineage ancestor whose id the child PREPENDS recommit- to is an operator act", async () => {
    reset();
    STORE = [
      { id: "g-parent", status: "open", classification_metadata: { operator_hold: false, operator_hold_released_by: "operator:x", operator_hold_released_at: h(70) } },
      gap("recommit-g-parent", {}, { landed_sha: sha("a") }),
    ];
    land("recommit-g-parent", sha("a"), h(50), "att-p");
    EVENTS = { "recommit-g-parent": [systemArm("recommit-g-parent")] };
    const j = judged(await run(), "recommit-g-parent");
    expect([j.verdict, j.failing_link]).toEqual(["not_counted", "operator_act:2a"]);
  });
  it("an operator_*_at stamp with no _by still counts (2a-at-without-by)", async () => {
    reset();
    STORE = [gap("g-at", {}, { landed_sha: sha("a"), operator_hold_released_at: h(70) })];
    land("g-at", sha("a"), h(50), "att-at");
    EVENTS = { "g-at": [systemArm("g-at")] };
    expect(judged(await run(), "g-at").failing_link).toBe("operator_act:2a-at-without-by");
  });
  it("an operator-filed row, an operator commit to the edit site before the fix, an operator-authored check, and an operator scope act each name their addendum", async () => {
    reset();
    STORE = [gap("g-filed", { source: "operator:qa" }, { landed_sha: sha("a") })];
    land("g-filed", sha("a"), h(50), "att-f");
    EVENTS = { "g-filed": [systemArm("g-filed")] };
    // qa ruling 2026-10-22: an operator filing fails link 1 (origin); it is still the operator-filed act too.
    expect(judged(await run(), "g-filed").failing_links).toEqual(["link1", "operator_act:operator-filed"]);

    reset();
    STORE = [gap("g-commit", {}, { landed_sha: sha("a") })];
    land("g-commit", sha("a"), h(50), "att-c");
    EVENTS = { "g-commit": [systemArm("g-commit")] };
    SITE_COMMITS = [{ sha: sha("7"), author: "An Operator", at: h(60), lane: false, files: ["src/thing.ts"] }];
    expect(judged(await run(), "g-commit").failing_link).toBe("operator_act:edit-site-commit");
    // after the fix but before close + 24 h it is still in the provenance window (link 5)
    SITE_COMMITS = [{ sha: sha("7"), author: "An Operator", at: h(40), lane: false, files: ["src/thing.ts"] }];
    expect(judged(await run(), "g-commit").failing_link).toBe("operator_act:edit-site-commit");
    // after close + 24 h it is not
    SITE_COMMITS = [{ sha: sha("7"), author: "An Operator", at: h(10), lane: false, files: ["src/thing.ts"] }];
    expect(judged(await run(), "g-commit").verdict).toBe("counted");

    reset();
    STORE = [gap("g-check", {}, { landed_sha: sha("a") })];
    land("g-check", sha("a"), h(50), "att-k");
    EVENTS = { "g-check": [systemArm("g-check")] };
    CHECK_FIRST = { sha: sha("6"), author: "An Operator", at: h(95), lane: false, files: [CHECK] };
    expect(judged(await run(), "g-check").failing_link).toBe("operator_act:check-authored");

    reset();
    STORE = [gap("g-scope", {}, { landed_sha: sha("a") })];
    land("g-scope", sha("a"), h(50), "att-s");
    EVENTS = { "g-scope": [systemArm("g-scope")] };
    SCOPE = [{ id: "super-repo 123456789abc (An Operator)", opened: [SITE], effective_at: h(60) }];
    expect(judged(await run(), "g-scope").failing_link).toBe("operator_act:3");
    SCOPE = [{ id: "later", opened: [SITE], effective_at: h(10) }]; // opened after close + 24 h: not its provenance
    expect(judged(await run(), "g-scope").verdict).toBe("counted");
  });
  it("addendum 3 from the super-repo's own history: an operator commit that drops the edit site from the scope opens it", async () => {
    reset();
    STORE = [gap("g-hist", {}, { landed_sha: sha("a") })];
    land("g-hist", sha("a"), h(50), "att-hist");
    EVENTS = { "g-hist": [systemArm("g-hist")] };
    const commitAs = (author: string, at: string, excluded: string[]) => {
      writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: excluded } }));
      const p = Bun.spawnSync(["git", "-C", SUPER, "-c", `user.name=${author}`, "-c", "user.email=a@b", "commit", "-q", "-a", "--allow-empty", "-m", "scope", "--date", at], { env: { ...process.env, GIT_COMMITTER_DATE: at }, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
    };
    writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["repos/v/src/"] } }));
    git("add", "."); commitAs("An Operator", h(70), ["repos/v/src/"]);
    commitAs("An Operator", h(60), ["repos/w/src/"]);
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    const { scopeActs: _drop, ...rest } = deps;
    __setJudgementDepsForTests(rest);
    try {
      const j = judged(await run(), "g-hist");
      expect([j.verdict, j.failing_link]).toEqual(["not_counted", "operator_act:3"]);
      expect(j.reason).toContain("super-repo");
    } finally {
      __setJudgementDepsForTests(deps);
      writeRows([REPAIR_ROW, LANE_ROW]);
    }
  });
  it("addendum 4/4a: in-process and node-self writes are system, flagged route-unverifiable", async () => {
    reset();
    STORE = [gap("g-route", {}, { landed_sha: sha("a") })];
    land("g-route", sha("a"), h(50), "att-rt");
    EVENTS = { "g-route": [systemArm("g-route"), { ...systemArm("g-route", h(80)), principal_kind: "node-self", fields_changed: ["updated_at"] }] };
    const j = judged(await run(), "g-route");
    expect(j.verdict).toBe("counted");
    expect(j["route_unverifiable"]).toBe(3); // the creating write, the arm and the node-self write
    expect(j.reason).toContain("ROUTE UNVERIFIABLE");
  });
  it("a key-principal write with no class map is unjudged, and the unjudged landings are the one filed finding", async () => {
    reset();
    STORE = [gap("g-key", {}, { landed_sha: sha("a") })];
    land("g-key", sha("a"), h(50), "att-key");
    EVENTS = { "g-key": [{ ...systemArm("g-key"), principal_kind: "key", key_id: "key_Pb" }] };
    const r = await run();
    expect(judged(r, "g-key").verdict).toBe("unjudged");
    expect(r.body.divergences.filter((d) => d.fact === "repair_autonomy").map((d) => d.key)).toEqual(["unjudged-landings"]);
    // with a map that names the key operator, the same write is an operator arm
    KEYMAP = [{ id: "key_Pb1xx", owner_kind: "operator" }];
    expect(judged(await run(), "g-key").failing_link).toBe("operator_act:arm");
  });
  it("an attempt registered directed is the operator's", async () => {
    reset();
    STORE = [gap("g-dir", {}, { landed_sha: sha("a") })];
    land("g-dir", sha("a"), h(50), "att-d", { directed: true });
    EVENTS = { "g-dir": [systemArm("g-dir")] };
    expect(judged(await run(), "g-dir").failing_link).toBe("operator_act:directed");
  });
  it("(c) every not_counted judgement names a failing link", async () => {
    reset();
    STORE = [gap("g-x", { source: "operator:qa" }, { landed_sha: sha("a"), predicate_birth_verdict: "unknown" })];
    land("g-x", sha("a"), h(50), "att-x");
    const j = judged(await run(), "g-x");
    expect(j.verdict).toBe("not_counted");
    expect(j.failing_link).toBe("link1");
    expect(j.failing_links).toEqual(["link1", "link2", "operator_act:operator-filed"]);
  });
});

describe("lane_revert_within_1h: per regressed settlement, expected from the ledger", () => {
  const settle = (key: string, s: string, at: string, source = "falsified_after_restart"): Rec => ({ key, at, record: { attempt_id: key.split("#")[0], settlement_seq: Number(key.split("#")[1]), verdict: "regressed", source, shas: [s], gap_id: "g-reg", at } });
  const laneRevert = (s: string, at: string, named = true) => ({ sha: sha("8"), at, message: `Revert "x"\n\n${named ? `This reverts commit ${s}.` : "revert"}\n\nAuto-Revert: true` });
  it("MUST-FAIL: a regressed settlement with no revert reads red and is filed per settlement; checked 0 of expected 1", async () => {
    reset();
    LEDGER["attemptSettlement"] = [settle("att-1#2", sha("a"), h(3))];
    const r = await run();
    const j = r.body.judgements["lane_revert_within_1h"]!;
    expect(j.map((x) => [x["settlement_id"], x.verdict, x.reason])).toEqual([["att-1#2", "red", "no revert within 1 h"]]);
    expect(agg(r, "lane_revert_within_1h")).toMatchObject({ checked: 0, expected: 1, red: 1 });
    expect(r.body.divergences.filter((d) => d.fact === "lane_revert_within_1h").map((d) => d.key)).toEqual(["settlement-att-1#2"]);
    expect(LOG.some((l) => l.startsWith("[self-fact-judgement] ") && l.includes('"settlement_id":"att-1#2"'))).toBe(true);
  });
  it("a lane revert naming the sha within 1 h is green; late, sha-less (found by the marker) or operator-made is red; under 1 h with none is pending", async () => {
    reset();
    LEDGER["attemptSettlement"] = [settle("att-g#2", sha("a"), h(3)), settle("att-l#2", sha("b"), h(3)), settle("att-n#1", sha("c"), h(3)), settle("att-o#2", sha("d"), h(3), "operator_revert"), settle("att-p#2", sha("f"), h(0.5))];
    LEDGER["attemptRevert"] = [{ key: "att-n#revert:1:done", at: h(2.8), record: { reverted_attempt_id: "att-n", status: "done", revert_sha: sha("5") } }];
    REVERTS = {
      [sha("a")]: [laneRevert(sha("a"), h(2.5))],
      [sha("b")]: [laneRevert(sha("b"), h(1))],
      [sha("d")]: [{ sha: sha("4"), at: h(3.5), message: `Revert "y"\n\nThis reverts commit ${sha("d")}.` }],
    };
    COMMITS = { [sha("5")]: { sha: sha("5"), at: h(2.8), message: `Revert "z"\n\nreverted the regressed landing\n\nAuto-Revert: true` } };
    const r = await run();
    const v = Object.fromEntries(r.body.judgements["lane_revert_within_1h"]!.map((x) => [x["settlement_id"], x.verdict]));
    expect(v).toEqual({ "att-g#2": "green", "att-l#2": "red", "att-n#1": "red", "att-o#2": "red", "att-p#2": "pending" });
    expect(agg(r, "lane_revert_within_1h")).toMatchObject({ checked: 1, expected: 5, green: 1, red: 3, pending: 1 });
    const n = r.body.judgements["lane_revert_within_1h"]!.find((x) => x["settlement_id"] === "att-n#1")!;
    expect([n["revert_names_sha"], n.reason]).toEqual([false, `the lane revert ${sha("5").slice(0, 12)} does not name the regressed sha`]);
  });
  it("a settlement older than the window is not expected", async () => {
    reset();
    LEDGER["attemptSettlement"] = [settle("att-old#2", sha("a"), h(200))];
    const r = await run();
    expect(agg(r, "lane_revert_within_1h")).toMatchObject({ checked: 0, expected: 0 });
  });
  it("the pure judge on its own inputs: lag is measured from the settlement", () => {
    const s = { key: "k", attempt_id: "att-z", gap_id: "g", sha: sha("a"), at: h(3), source: "settle_regressed" };
    const j = judgeLaneRevert(s, "v", sha("a"), [laneRevert(sha("a"), h(2.75))], NOW);
    expect([j.verdict, j.lag_s, j.revert_names_sha]).toEqual(["green", 900, true]);
    expect(judgeLaneRevert(s, null, null, null, NOW).verdict).toBe("unjudged");
  });
});
