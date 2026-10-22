// qa's 10-22 REVIEW OF THE §14 ROWS: as first built, repair_autonomy and lane_revert_within_1h were lenient in the
// direction that games §14 (assisted closures counted as autonomous; a red settlement could close by ageing out). Each
// required fix has a must-fail case here, tagged [item N]; each was seen red under a named mutant that removes exactly
// that fix (the mutant list is in the commit message), then green.
//   1 ORIGIN       autonomous only if source === "substrate_detected"; unset fails (addendum 1).
//   2 DIRECTED     autonomous only if directed === false EXACTLY (the auto-revert's rule: absent or unknown is not).
//   3 LINK 5       operator acts FILING to close + 24 h; undated holds, hand closes, operator-only fields, ancestor
//                  events, and unread oracle labels (REVIEW).
//   4 UNKNOWN      a missing ledger file or spool, a capped read, events that do not reach the filing, an unparsable
//                  time: never clean.
//   5 SAFETY       a red settlement stays red until a revert is OBSERVED on origin/dev; ageing out is "expired unreverted".
//   6 LINK 3       the fix is the lane's commit, on the edit_site, in its repo, reachable from origin/dev; sources only
//                  at the fix (no HEAD fallback).
//   7 HEADER       operator-acts.ts names no reader that does not import it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `repair-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveSelfFactReconcile, __setJudgementDepsForTests, judgeRepairClosure, repairControlInputs, judgeLaneRevert } = sfr;
const { operatorActsOf } = await import("../../src/resolvers/operator-acts.js");
type Deps = Parameters<typeof __setJudgementDepsForTests>[0];

const SUPER = join(ROOT, "super");
const CLONES = join(ROOT, "clones");
const savedEnv: Record<string, string | undefined> = {};
const sh = (cwd: string, args: string[], env: Record<string, string> = {}): string => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};
const REPAIR_ROW = { id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 };
const LANE_ROW = { id: "lane_revert_within_1h", instrument: "lane_revert_within_1h", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:regressed-settlement-no-revert", window_hours: 168 };

// ─── the fixture world (as the sibling file, plus the inputs these fixes read) ──
const NOW = Date.parse("2026-10-22T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
const CHECK = "test/thing.check.ts";
const SOURCES: Record<string, string> = { [CHECK]: `import { thing } from "../src/thing.js";\nexpect(thing()).toBe("fixed_value");\n`, "src/thing.ts": `export function thing() { return "fixed_value"; }\n` };
type Row = Record<string, unknown>;
const gap = (id: string, over: Row = {}, meta: Row = {}): Row => ({
  id, status: "closed", source: "substrate_detected", first_detected_at: h(100), closed_at: h(48), reopen_count: 0, ...over,
  classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: CHECK }, predicate_birth_verdict: "present", closed_reason: "landed_verified", close_basis: "absent", landed_sha: sha("a"), ...meta },
});
type Rec = { key: string; at: string; record: Record<string, unknown> };
let LEDGER: Record<string, Rec[] | undefined> = {};
let SPOOL: Array<{ key: string; record: Record<string, unknown> }> | null = [];
let STORE: Row[] = [];
let EVENTS: Record<string, Array<Record<string, unknown>>> = {};
let NO_CREATE = new Set<string>();
let CAP: Set<string> = new Set();
let LABELS: unknown = null;
const LOG: string[] = [];
const created = (gapId: string) => ({ gap_id: gapId, outcome: "written", fields_changed: ["status"], status_from: "absent", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: h(100) });
const sysArm = (gapId: string, at = h(90)) => ({ gap_id: gapId, outcome: "written", fields_changed: ["classification_metadata.check_supply"], principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: at });
const opWrite = (gapId: string, at: string, fields = ["classification_metadata.evidence_resolve"]) => ({ gap_id: gapId, outcome: "written", fields_changed: fields, principal_kind: "key", key_id: "key_Oa", operator_marker: true, store: "local", ts: at });
function land(gapId: string, s: string, at: string, att: string, intent: Row = {}): void {
  LEDGER["attemptIntent"]!.push({ key: att, at, record: { attempt_id: att, route: "gap_to_feature", gap_id: gapId, directed: false, ...intent } });
  LEDGER["landingEvent"]!.push({ key: `spool:${att}`, at, record: { event: "commit", repo: "/workspace/git/vessels/v", sha: s, at, attempt_id: att } });
}
const READ_LABELS = { labels: [], context: { fixLiveAt: h(500), keymap: [], forwardingKeys: [], nodeSelfAdminKeys: [] } };
function reset(): void {
  LEDGER = { attemptIntent: [], landingEvent: [], attemptSettlement: [] }; SPOOL = []; STORE = []; EVENTS = {}; NO_CREATE = new Set(); CAP = new Set(); LABELS = READ_LABELS; LOG.length = 0;
}
const fakeGit: Partial<NonNullable<Deps>> = {
  locate: (s) => /^[0-9a-f]{40}$/.test(s) ? { repo: "v", dir: "/clones/v", fullSha: s } : null,
  cloneOf: (v) => (v === "v" ? "/clones/v" : null),
  revParse: (_d, s) => (/^[0-9a-f]{40}$/.test(s) ? s : null),
  fixCommit: () => ({ author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true }),
  siteCommits: () => [], firstCommit: () => ({ sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] }),
  revertsOf: () => [], commit: () => null, show: (_d, _s, p) => SOURCES[p] ?? null,
};
const deps: Deps = {
  ledger: (kind) => LEDGER[kind] ?? [],
  ledgerPresent: (kind) => Array.isArray(LEDGER[kind]),
  spool: () => SPOOL,
  readGaps: async () => STORE,
  readEvents: async (id) => {
    const ev = [...(STORE.some((g) => g["id"] === id) && !NO_CREATE.has(id) ? [created(id)] : []), ...(EVENTS[id] ?? [])];
    return { events: ev as never, matched: ev.length + (CAP.has(id) ? 1 : 0) };
  },
  keymap: async () => null,
  labels: async () => LABELS as never,
  ...fakeGit,
  scopeActs: async (sites) => new Map(sites.map((x) => [x, []])),
  now: () => NOW,
  log: (l) => { LOG.push(l); },
};
type J = Record<string, unknown> & { gap_id: string; verdict: string; failing_link?: string; failing_links: string[]; reason: string };
type Report = { body: { judgements: Record<string, J[]>; facts_checked: Array<{ fact: string; source_read: boolean; note: string; aggregate?: Record<string, number> }>; divergences: Array<{ fact: string; key: string; detail: string }>; unobserved_rows: string[] } };
const run = async () => (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never)) as unknown as Report;
const judged = async (id: string) => (await run()).body.judgements["repair_autonomy"]!.find((j) => j.gap_id === id)!;
/** One closure that counts with every input readable (the positive control the cases below perturb). */
function counting(id = "g-ok", over: Row = {}, meta: Row = {}): void {
  STORE.push(gap(id, over, meta));
  land(id, sha("a"), h(50), `att-${id}`);
  EVENTS[id] = [sysArm(id)];
}

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT", "MITOSIS_PUSH_CLONE_DIR"]) savedEnv[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  process.env["MITOSIS_PUSH_CLONE_DIR"] = CLONES;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  sh(SUPER, ["init", "-q"]); sh(SUPER, ["config", "user.email", "t@t"]); sh(SUPER, ["config", "user.name", "t"]);
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [REPAIR_ROW, LANE_ROW] }));
  sh(SUPER, ["add", "."]); sh(SUPER, ["commit", "-q", "-m", "rows"]); sh(SUPER, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  __setJudgementDepsForTests(deps);
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the positive control these cases perturb", () => {
  it("a system-detected, system-armed, autonomous, lane-fixed, durable closure with labels read counts", async () => {
    reset(); counting();
    expect((await judged("g-ok")).verdict).toBe("counted");
  });
});

describe("[item 1] ORIGIN", () => {
  it("[item 1] an unset source is not_counted, failing link1 (addendum 1)", async () => {
    reset(); counting("g-o1", { source: undefined });
    const j = await judged("g-o1");
    expect([j.verdict, j.failing_link]).toEqual(["not_counted", "link1"]);
  });
  it("[item 1] a detector or walk source that is not substrate_detected is not autonomous", async () => {
    reset(); counting("g-o2", { source: "detector:some-scan" });
    expect((await judged("g-o2")).failing_link).toBe("link1");
  });
});

describe("[item 2] DIRECTED", () => {
  for (const [name, intent] of [["absent", { directed: undefined }], ["null (unknown)", { directed: null }]] as const) {
    it(`[item 2] an attempt whose directed is ${name} is not autonomous (link3)`, async () => {
      reset(); STORE.push(gap("g-d")); land("g-d", sha("a"), h(50), "att-d", intent as Row); EVENTS["g-d"] = [sysArm("g-d")];
      const j = await judged("g-d");
      expect([j.verdict, j.failing_link]).toEqual(["not_counted", "link3"]);
    });
  }
});

describe("[item 3] LINK 5: filing to close + 24 h, and what counts in it", () => {
  it("[item 3] an operator write AFTER the fix but before close + 24 h is an operator act", async () => {
    reset(); counting("g-w"); EVENTS["g-w"]!.push(opWrite("g-w", h(30), ["classification_metadata.check_supply"]));
    expect((await judged("g-w")).failing_link).toBe("operator_act:arm");
  });
  it("[item 3] an undated operator_hold on an ancestor counts", async () => {
    reset(); STORE.push({ id: "g-anc", status: "open", classification_metadata: { operator_hold: true } }); counting("recommit-g-anc");
    expect((await judged("recommit-g-anc")).failing_links).toContain("operator_act:hold-undated");
  });
  it("[item 3] a hand close (closed_by operator:*) counts as an operator act", async () => {
    reset(); counting("g-hc", {}, { closed_by: "operator:qa" });
    expect((await judged("g-hc")).failing_links).toContain("operator_act:hand-close");
  });
  it("[item 3] an operator-only field (deadline_status) counts", async () => {
    reset(); counting("g-dl", {}, { deadline_status: "APPROVED: a ruling" });
    expect((await judged("g-dl")).failing_link).toBe("operator_act:operator-field");
  });
  it("[item 3] an operator write on an ANCESTOR row counts", async () => {
    reset(); STORE.push({ id: "g-par", status: "open", classification_metadata: {} }); counting("recommit-g-par");
    EVENTS["g-par"] = [opWrite("g-par", h(60))];
    expect((await judged("recommit-g-par")).failing_link).toBe("operator_act:ancestor-gap-write");
  });
  it("[item 3] unreadable oracle labels read REVIEW (unjudged), never counted", async () => {
    reset(); counting("g-lab"); LABELS = null;
    const j = await judged("g-lab");
    expect(j.verdict).toBe("unjudged");
    expect(j.reason).toContain("oracle labels unread");
  });
  it("[item 3] an operator label on a provenance trace is an operator act", () => {
    const row = gap("g-ol", {}, { execution_id: "exec_1" });
    const r = operatorActsOf(row, { byId: new Map([["g-ol", row]]), filedAt: h(100), untilAt: h(24), events: [created("g-ol") as never], eventsFromFiling: true,
      labels: [{ execution_id: "exec_1", labeler: "human", created_at: h(60), principal_kind: "session" }], labelContext: READ_LABELS.context, scopeActs: [], siteCommits: [] });
    expect(r.acts.map((a) => a.addendum)).toContain("operator-label");
  });
});

describe("[item 4] UNKNOWN IS NEVER CLEAN", () => {
  it("[item 4] an absent ledger file leaves the row unobserved, not an empty clean ledger", async () => {
    reset(); counting(); LEDGER["landingEvent"] = undefined;
    const r = await run();
    expect(r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!.source_read).toBe(false);
    expect(r.body.unobserved_rows).toContain("repair_autonomy");
  });
  it("[item 4] an unreadable spool leaves the row unobserved", async () => {
    reset(); counting(); SPOOL = null;
    expect((await run()).body.unobserved_rows).toContain("repair_autonomy");
  });
  it("[item 4] a landing still in the spool is expected", async () => {
    reset(); STORE.push(gap("g-sp")); EVENTS["g-sp"] = [sysArm("g-sp")];
    LEDGER["attemptIntent"]!.push({ key: "att-sp", at: h(50), record: { attempt_id: "att-sp", route: "gap_to_feature", gap_id: "g-sp", directed: false } });
    SPOOL = [{ key: "spool:x.json", record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("a"), at: h(50), attempt_id: "att-sp" } }];
    const r = await run();
    expect(r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!.aggregate!["expected"]).toBe(1);
  });
  it("[item 4] a capped event read is unjudged", async () => {
    reset(); counting("g-cap"); CAP.add("g-cap");
    expect((await judged("g-cap")).verdict).toBe("unjudged");
  });
  it("[item 4] events that do not reach back to the filing are unjudged", async () => {
    reset(); counting("g-nf"); NO_CREATE.add("g-nf");
    expect((await judged("g-nf")).verdict).toBe("unjudged");
  });
  it("[item 4] an unparsable event time is unjudged", async () => {
    reset(); counting("g-ts"); EVENTS["g-ts"]!.push({ ...sysArm("g-ts"), fields_changed: ["updated_at"], ts: "not-a-time" });
    expect((await judged("g-ts")).verdict).toBe("unjudged");
  });
  it("[item 4] an unparsable landing time is kept as expected and unjudged", async () => {
    reset(); STORE.push(gap("g-lt")); land("g-lt", sha("a"), "yesterday-ish", "att-lt"); EVENTS["g-lt"] = [sysArm("g-lt")];
    const r = await run();
    const j = r.body.judgements["repair_autonomy"]!.find((x) => x.gap_id === "g-lt");
    expect(j?.verdict).toBe("unjudged");
  });
});

describe("[item 5] SAFETY: a red settlement closes only on an observed revert", () => {
  const settle = (key: string, s: string, at: string): Rec => ({ key, at, record: { attempt_id: key.split("#")[0], verdict: "regressed", source: "falsified_after_restart", shas: [s], gap_id: "g-reg", at } });
  const openRed = (key: string): Row => ({ id: `self-fact-divergence-lane-revert-within-1h-settlement-${key}`, status: "open", classification_metadata: { detector: "activity:self_fact_reconcile@development-vessel", fact: "lane_revert_within_1h", divergence_key: `settlement-${key}` } });
  it("[item 5] a red settlement that aged out of the window stays red: \"expired unreverted\", its divergence kept", async () => {
    reset(); LEDGER["attemptSettlement"] = [settle("att-old#2", sha("a"), h(200))]; STORE = [openRed("att-old#2")];
    const r = await run();
    const j = r.body.judgements["lane_revert_within_1h"]!.find((x) => x["settlement_id"] === "att-old#2")!;
    expect(j.verdict).toBe("red");
    expect(j.reason).toContain("expired unreverted");
    expect(r.body.divergences.map((d) => d.key)).toContain("settlement-att-old#2");
  });
  it("[item 5] a carried red whose record left the ledger stays red", async () => {
    reset(); STORE = [openRed("att-gone#2")];
    const r = await run();
    expect(r.body.divergences.map((d) => d.key)).toContain("settlement-att-gone#2");
  });
  it("[item 5] a carried red that now reads unjudged keeps its divergence", async () => {
    reset(); LEDGER["attemptSettlement"] = [settle("att-u#2", "", h(200))]; STORE = [openRed("att-u#2")];
    const r = await run();
    expect(r.body.divergences.map((d) => d.key)).toContain("settlement-att-u#2");
  });
});

describe("[item 6] LINK 3: the fix commit", () => {
  const base = () => repairControlInputs(NOW, false);
  it("[item 6] a fix authored by an operator is not_counted (link3)", () => {
    const i = base(); i.fix = { ...i.fix!, author: "An Operator" };
    expect([judgeRepairClosure(i).verdict, judgeRepairClosure(i).failing_link]).toEqual(["not_counted", "link3"]);
  });
  it("[item 6] a fix that does not touch the edit_site is not_counted (link3)", () => {
    const i = base(); i.fix = { ...i.fix!, files: ["src/other.ts"] };
    expect(judgeRepairClosure(i).failing_link).toBe("link3");
  });
  it("[item 6] a fix not reachable from origin/dev is not_counted (link3); unreadable reachability is unjudged", () => {
    const i = base(); i.fix = { ...i.fix!, on_origin_dev: false };
    expect(judgeRepairClosure(i).failing_link).toBe("link3");
    const k = base(); k.fix = { ...k.fix!, on_origin_dev: null };
    expect(judgeRepairClosure(k).verdict).toBe("unjudged");
  });
  it("[item 6] a fix landed in another repo than the edit site's is not_counted (link3)", () => {
    const i = base(); i.landing = { ...i.landing, repo: "other-vessel" };
    expect(judgeRepairClosure(i).failing_link).toBe("link3");
  });
});

describe("[item 5] [item 6] against a real clone: origin/dev decides, never HEAD", () => {
  // One vessel clone: c0 adds the site; c1 is the lane's fix; origin/dev = c1; c2 (HEAD only) is a lane revert of c1 that
  // never reached origin/dev, and c2 also adds the check file (present at HEAD, absent at the fix).
  let c1 = "";
  beforeAll(() => {
    const repo = join(CLONES, "v");
    mkdirSync(join(repo, "src"), { recursive: true });
    sh(repo, ["init", "-q"]); sh(repo, ["config", "user.email", "t@t"]);
    writeFileSync(join(repo, "src", "thing.ts"), "export function thing() { return 1; }\n");
    sh(repo, ["add", "."]); sh(repo, ["-c", "user.name=An Operator", "commit", "-q", "-m", "c0"]);
    writeFileSync(join(repo, "src", "thing.ts"), SOURCES["src/thing.ts"]!);
    sh(repo, ["add", "."]); sh(repo, ["-c", "user.name=Substrate Autonomous", "commit", "-q", "-m", "fix"], { GIT_COMMITTER_DATE: h(50), GIT_AUTHOR_DATE: h(50) });
    c1 = sh(repo, ["rev-parse", "HEAD"]);
    sh(repo, ["update-ref", "refs/remotes/origin/dev", c1]);
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "src", "thing.ts"), "export function thing() { return 1; }\n");
    writeFileSync(join(repo, CHECK), SOURCES[CHECK]!);
    sh(repo, ["add", "."]); sh(repo, ["-c", "user.name=Substrate Autonomous", "commit", "-q", "-m", `Revert "fix"\n\nThis reverts commit ${c1}.\n\nAuto-Revert: true`], { GIT_COMMITTER_DATE: h(2.5), GIT_AUTHOR_DATE: h(2.5) });
  });
  const realGit = () => { const { locate: _l, cloneOf: _c, revParse: _r, fixCommit: _f, siteCommits: _s, firstCommit: _fc, revertsOf: _rv, commit: _cm, show: _sh, ...rest } = deps!; return rest; };
  it("[item 5] a lane revert on HEAD but not on origin/dev is not observed: the settlement stays red", async () => {
    reset(); __setJudgementDepsForTests(realGit());
    try {
      LEDGER["attemptSettlement"] = [{ key: "att-r#2", at: h(3), record: { attempt_id: "att-r", verdict: "regressed", source: "falsified_after_restart", shas: [c1], gap_id: "g-reg", at: h(3) } }];
      const j = (await run()).body.judgements["lane_revert_within_1h"]!.find((x) => x["settlement_id"] === "att-r#2")!;
      expect([j.verdict, j["revert_sha"]]).toEqual(["red", null]);
    } finally { __setJudgementDepsForTests(deps); }
  });
  it("[item 6] the check file is read AT THE FIX: present only at HEAD, the closure is unjudged (never counted from HEAD)", async () => {
    reset(); __setJudgementDepsForTests(realGit());
    try {
      STORE.push(gap("g-real", {}, { landed_sha: c1 })); land("g-real", c1, h(50), "att-real"); EVENTS["g-real"] = [sysArm("g-real")];
      const j = await judged("g-real");
      expect(j.verdict).toBe("unjudged");
      expect(String((j["check_honest"] as { reason: string }).reason)).toContain("AT THE FIX");
    } finally { __setJudgementDepsForTests(deps); }
  });
});

describe("[item 7] the reader's header names no reader that does not import it", () => {
  it("[item 7] every src file the header names as reading operator-acts.ts imports it", () => {
    const SRC = join(import.meta.dir, "..", "..", "src");
    const header = readFileSync(join(SRC, "resolvers", "operator-acts.ts"), "utf8").split("*/")[0]!;
    const importers = new Set<string>();
    const walk = (d: string): void => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts") && /from "\.\/operator-acts\.js"|from "\.\.\/resolvers\/operator-acts\.js"/.test(readFileSync(p, "utf8"))) importers.add(relative(SRC, p).split("/").pop()!.replace(/\.ts$/, "")); } };
    walk(SRC);
    // A module named in the header in a clause that does not deny it ("does NOT read") must be an importer.
    for (const name of ["goal-reach-tick", "self-fact-reconcile"]) {
      const named = header.includes(name);
      const denied = new RegExp(`${name}[^.]*does NOT read`).test(header);
      if (named && !denied) expect([name, importers.has(name)]).toEqual([name, true]);
    }
    expect(importers.has("self-fact-reconcile")).toBe(true);
  });
});

describe("the lane-revert pure judge keeps the window rule", () => {
  it("an aged-out settlement with no revert is red, never pending or clean", () => {
    const s = { key: "k", attempt_id: "a", gap_id: "g", sha: sha("a"), at: h(300), source: "settle_regressed" };
    expect(judgeLaneRevert(s, "v", sha("a"), [], NOW, NOW - 168 * 3600_000, true).reason).toContain("expired unreverted");
  });
});
