// qa's SECOND 10-22 REVIEW OF THE §14 ROWS (A-D), on the harness of self-fact-repair-review-fixes.test.ts. Each case is
// tagged [A]..[D]; each was seen red under the named mutant in the commit message, then green.
//   A scope acts are read from ALL scope history, and addendum 3 counts only an opening effective AFTER the row's filing:
//     standing configuration that pre-dates the gap is not an operator act on its landings (A′), an opening after the
//     filing and before the window's end still counts (A″).
//   B oracle labels are fetched for EVERY provenance trace the reader considers, not only the authoring execution.
//   C a torn spool file and a landing whose attempt has no intent (or names no gap) are expected and unjudged.
//   D hand closes and operator-only fields count on ANCESTORS; the filing time accepts detected_at.
//
// (the first review:)
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

const ROOT = join(tmpdir(), `repair-review-ad-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
let ASKED: string[][] = [];
let SITE_COMMITS: Array<{ sha: string; author: string; at: string; lane: boolean; files: string[] }> = [];
const LOG: string[] = [];
const created = (gapId: string) => ({ gap_id: gapId, outcome: "written", fields_changed: ["status"], status_from: "absent", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: h(100) });
const sysArm = (gapId: string, at = h(90)) => ({ gap_id: gapId, outcome: "written", fields_changed: ["classification_metadata.check_supply"], principal_kind: "in-process", key_id: null, operator_marker: false, store: "local", ts: at });
const opWrite = (gapId: string, at: string, fields = ["classification_metadata.evidence_resolve"]) => ({ gap_id: gapId, outcome: "written", fields_changed: fields, principal_kind: "key", key_id: "key_Oa", operator_marker: true, store: "local", ts: at });
// Every fixture landing's attempt gets an authoring execution through the REAL attemptAuthoring path (attempt-register's
// writer), with no label on it: a lane landing whose authoring execution is known nowhere is unattributable (qa eval5 B3).
const { setAuthoringExecution } = await import("../../src/resolvers/attempt-register.js");
function land(gapId: string, s: string, at: string, att: string, intent: Row = {}): void {
  LEDGER["attemptIntent"]!.push({ key: att, at, record: { attempt_id: att, route: "gap_to_feature", gap_id: gapId, directed: false, ...intent } });
  void setAuthoringExecution(att, `exec-authoring-${att}`);
  LEDGER["landingEvent"]!.push({ key: `spool:${att}`, at, record: { event: "commit", repo: "/workspace/git/vessels/v", sha: s, at, attempt_id: att } });
}
const READ_LABELS = { labels: [], context: { fixLiveAt: h(500), keymap: [], forwardingKeys: [], nodeSelfAdminKeys: [] } };
function reset(): void {
  LEDGER = { attemptIntent: [], landingEvent: [], attemptSettlement: [] }; SPOOL = []; STORE = []; EVENTS = {}; NO_CREATE = new Set(); CAP = new Set(); LABELS = READ_LABELS; LOG.length = 0; ASKED = []; SITE_COMMITS = [];
}
const fakeGit: Partial<NonNullable<Deps>> = {
  locate: (s) => /^[0-9a-f]{40}$/.test(s) ? { repo: "v", dir: "/clones/v", fullSha: s } : null,
  cloneOf: (v) => (v === "v" ? "/clones/v" : null),
  revParse: (_d, s) => (/^[0-9a-f]{40}$/.test(s) ? s : null),
  fixCommit: () => ({ author: "Substrate Autonomous", at: h(50), files: ["src/thing.ts"], on_origin_dev: true }),
  // Honours `since` like git log --since, so a filing time read wrongly drops commits.
  siteCommits: (_d, _p, since) => SITE_COMMITS.filter((c) => Date.parse(c.at) >= Date.parse(since)), firstCommit: () => ({ sha: sha("e"), author: "Substrate Autonomous", at: h(95), lane: true, files: [CHECK] }),
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
  // Returns only the labels of the traces it was asked for (as a real label read would).
  labels: async (ids) => { ASKED.push(ids); if (LABELS === null) return null; const L = LABELS as { labels: Array<{ execution_id?: string }>; context: unknown }; return { labels: L.labels.filter((x) => ids.includes(String(x.execution_id))), context: L.context } as never; },
  ...fakeGit,
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
  it("a closure with every input readable and no act counts (the real scope history read, no act in it)", async () => {
    reset(); counting();
    expect((await judged("g-ok")).verdict).toBe("counted");
  });
});

describe("[A] scope acts from ALL history; addendum 3 counts only an opening after the filing", () => {
  const scope = join(SUPER, "scripts", "substrate", "autonomy-scope.json");
  const commitAs = (at: string, excluded: string[]) => {
    writeFileSync(scope, JSON.stringify({ autonomyScope: { excluded_paths: excluded } }));
    sh(SUPER, ["add", "."]); sh(SUPER, ["-c", "user.name=An Operator", "commit", "-q", "-m", "scope", "--date", at], { GIT_COMMITTER_DATE: at });
  };
  const scopeActs = (j: J) => ((j["operator_acts"] as { acts?: Array<{ addendum: string; at: string | null; detail: string }> } | null)?.acts ?? []).filter((a) => a.addendum === "3");
  it("[A′] a real operator scope commit that opened the edit site BEFORE the row's filing is no addendum-3 act", async () => {
    // Its own edit site, so the opening (which stays in history: once opened, opened) touches no other case.
    reset(); counting("g-scope-old", {}, { edit_site: "repos/v/src/opened.ts" });
    commitAs(h(400), ["repos/v/src/opened.ts"]); // the site excluded
    commitAs(h(300), []);                         // opened, 300 h ago: before the row's filing (100 h ago)
    sh(SUPER, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    const j = await judged("g-scope-old");
    expect(j.failing_links).not.toContain("operator_act:3");
    expect(scopeActs(j)).toEqual([]);
  });
  it("[A″] a real operator scope commit that opened the edit site AFTER the filing, before the landing, makes the closure assisted", async () => {
    reset(); counting("g-scope-late", {}, { edit_site: "repos/v/src/opened-late.ts" });
    commitAs(h(400), ["repos/v/src/opened-late.ts"]); // the site excluded
    commitAs(h(80), []);                               // opened, 80 h ago: after the filing (100 h), before the landing (50 h)
    sh(SUPER, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    const j = await judged("g-scope-late");
    expect(j.verdict).toBe("not_counted");
    expect(j.failing_links).toContain("operator_act:3");
    expect(scopeActs(j).map((a) => a.at)).toEqual([h(80)]);
    expect(JSON.stringify(j["operator_acts"])).toContain("super-repo");
  });
});

describe("[B] labels for every provenance trace", () => {
  it("[B] an operator label on a row's example trace (not the authoring execution) is read and counts", async () => {
    reset(); counting("g-trace", {}, { example_trace_ids: ["exec_9"] });
    LABELS = { labels: [{ execution_id: "exec_9", labeler: "human", source: null, created_at: h(60), principal_kind: "session" }], context: READ_LABELS.context };
    const j = await judged("g-trace");
    expect(ASKED.some((ids) => ids.includes("exec_9"))).toBe(true);
    expect(j.failing_link).toBe("operator_act:operator-label");
  });
});

describe("[C] nothing that may be a landing is dropped", () => {
  it("[C] a torn spool file is expected and unjudged", async () => {
    reset(); counting(); SPOOL = [{ key: "spool:torn.json", record: null }];
    const r = await run();
    const j = r.body.judgements["repair_autonomy"]!.find((x) => x.gap_id === "ledger:spool:torn.json");
    expect(j?.verdict).toBe("unjudged");
    expect(r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!.aggregate!["expected"]).toBe(2);
  });
  it("[C] a landing whose attempt has no intent is expected and unjudged", async () => {
    reset(); counting();
    LEDGER["landingEvent"]!.push({ key: "spool:orphan", at: h(40), record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("b"), at: h(40), attempt_id: "att-orphan" } });
    const r = await run();
    expect(r.body.judgements["repair_autonomy"]!.find((x) => x.gap_id === "ledger:att-orphan")?.verdict).toBe("unjudged");
    expect(r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!.aggregate!["expected"]).toBe(2);
  });
  it("[C] a landing whose intent names no gap is expected and unjudged", async () => {
    reset(); counting();
    LEDGER["attemptIntent"]!.push({ key: "att-nogap", at: h(40), record: { attempt_id: "att-nogap", route: "gap_to_feature", gap_id: null, directed: false } });
    LEDGER["landingEvent"]!.push({ key: "spool:nogap", at: h(40), record: { event: "commit", repo: "/workspace/git/vessels/v", sha: sha("c"), at: h(40), attempt_id: "att-nogap" } });
    expect((await run()).body.judgements["repair_autonomy"]!.find((x) => x.gap_id === "ledger:att-nogap")?.verdict).toBe("unjudged");
  });
});

describe("[D] ancestors and the filing time", () => {
  it("[D] a hand close on an ANCESTOR counts", async () => {
    reset(); STORE.push({ id: "g-hcp", status: "closed", classification_metadata: { closed_by: "operator:qa" } }); counting("recommit-g-hcp");
    expect((await judged("recommit-g-hcp")).failing_links).toContain("operator_act:hand-close");
  });
  it("[D] an operator-only field on an ANCESTOR counts", async () => {
    reset(); STORE.push({ id: "g-dlp", status: "open", classification_metadata: { latest_by: "2026-10-22T20:00:00Z" } }); counting("recommit-g-dlp");
    expect((await judged("recommit-g-dlp")).failing_link).toBe("operator_act:operator-field");
  });
  it("[D] a row filed only by detected_at reads its commits from that filing, not from the window", async () => {
    reset(); counting("g-det", { first_detected_at: undefined, created_at: undefined, detected_at: h(400), closed_at: h(48) });
    SITE_COMMITS = [{ sha: sha("7"), author: "An Operator", at: h(300), lane: false, files: ["src/thing.ts"] }];
    expect((await judged("g-det")).failing_link).toBe("operator_act:edit-site-commit");
  });
});
