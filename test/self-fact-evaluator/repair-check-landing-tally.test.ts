// CHECK LANDINGS ARE A SEPARATE TALLY (user ruling: "Separate tally"). A lane landing whose commit only adds or edits
// test/checks/<id>.check.ts lands a gap's check, not its repair: it leaves repair_autonomy's denominator (expected,
// checked) and is counted in check_landings; the counted-repair rate is over SOURCE landings only, and the note reports
// both tallies with its existing fields kept.
//
// MUST-FAIL: a check-only landing used to be an expected repair (expected 2 for one source and one check landing).
// Controls: a source landing stays in the denominator; a landing whose commit cannot be read stays a repair (unknown
// never leaves it); a check landing never hides a source landing of the same gap; the note keeps its fields.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-check-tally-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, any>;
const { resolveSelfFactReconcile, __setJudgementDepsForTests, ledgerLandings } = sfr;

const SUPER = join(ROOT, "super");
const savedEnv: Record<string, string | undefined> = {};
const git = (...args: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...args], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const ROWS = [{ id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 }];
const NOW = Date.parse("2030-01-10T00:00:00Z");
const h = (n: number) => new Date(NOW - n * 3600_000).toISOString();
const sha = (c: string) => c.repeat(40);
const SITE = "repos/v/src/thing.ts";
type Rec = { key: string; at: string; record: Record<string, unknown> };
let LEDGER: Record<string, Rec[]> = {};
const FILES: Record<string, string[] | null> = {};
const LOG: string[] = [];
const land = (gapId: string, s: string, at: string, att: string, files: string[] | null) => {
  (LEDGER["attemptIntent"] ??= []).push({ key: att, at, record: { attempt_id: att, route: "gap_to_feature", gap_id: gapId, directed: false } });
  (LEDGER["landingEvent"] ??= []).push({ key: `spool:${att}`, at, record: { event: "commit", repo: "/workspace/git/vessels/v", sha: s, at, attempt_id: att } });
  FILES[s] = files;
};
const gap = (id: string) => ({ id, status: "open", source: "substrate_detected", first_detected_at: h(100), classification_metadata: { edit_site: SITE, check_supply: { state: "armed", test_file: `test/checks/${id}.check.ts` }, predicate_birth_verdict: "present" } });
const deps = {
  ledger: (k: string) => LEDGER[k] ?? [], ledgerPresent: () => true, spool: () => [],
  readGaps: async () => [gap("g-src"), gap("g-chk"), gap("g-both"), gap("g-unread")], readEvents: async () => ({ events: [], matched: 0 }),
  keymap: async () => null, labels: async () => null, locate: () => null,
  cloneOf: (v: string) => (v === "v" ? "/clones/v" : null), revParse: (_d: string, s: string) => (s in FILES ? s : null),
  fixCommit: (_d: string, s: string) => (FILES[s] ? { author: "Substrate Autonomous", at: h(50), files: FILES[s]!, on_origin_dev: true } : null),
  siteCommits: () => [], firstCommit: () => undefined, revertsOf: () => [], commit: () => null, show: () => null,
  scopeActs: async () => new Map(), now: () => NOW, log: (l: string) => { LOG.push(l); }, persist: () => ({ appended: true }),
};
const reset = () => {
  LEDGER = { attemptIntent: [], landingEvent: [], attemptSettlement: [] }; LOG.length = 0;
  land("g-src", sha("a"), h(50), "att-src", ["src/thing.ts"]);
  land("g-chk", sha("b"), h(50), "att-chk", ["test/checks/g-chk.check.ts"]);
};
type Report = { body: { judgements: Record<string, Array<{ gap_id: string }>>; facts_checked: Array<{ fact: string; note: string; aggregate?: Record<string, unknown> }> } };
const run = async () => (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never)) as unknown as Report;
const fact = (r: Report) => r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!;

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: ROWS }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  __setJudgementDepsForTests(deps as never);
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("repair_autonomy: check landings leave the repair denominator for their own tally", () => {
  it("MUST-FAIL: one source and one check landing read expected 1 (source only) and check_landings 1", async () => {
    reset();
    const f = fact(await run());
    expect([f.aggregate?.["expected"], f.aggregate?.["check_landings"]]).toEqual([1, 1]);
  });
  it("MUST-FAIL: the note reports both tallies, the rate over source landings only", async () => {
    reset();
    const note = fact(await run()).note;
    expect(note).toContain("checked 0 of expected 1 (source landings)");
    expect(note).toContain("check landings=1");
  });
  it("MUST-FAIL: the check landing is judged and logged as a check landing, outside the repair judgements", async () => {
    reset();
    const r = await run();
    expect(r.body.judgements["repair_autonomy"]!.map((j) => j.gap_id)).toEqual(["g-src"]);
    const line = LOG.find((l) => l.includes("[self-fact-judgement]") && l.includes('"g-chk"'));
    expect(line).toBeDefined();
    expect(line!).toContain('"landing_kind":"check"');
  });
  it("control: the note keeps its existing fields", async () => {
    reset();
    const note = fact(await run()).note;
    for (const k of ["ledger landing(s) over 168h:", "counted=", "not_counted=", "pending=", "unjudged=", "checked 0 of expected"]) expect(note).toContain(k);
  });
  it("control: a source landing stays in the denominator, and an unreadable commit stays a repair", async () => {
    reset();
    land("g-unread", sha("c"), h(50), "att-unread", null);
    const ids = (await run()).body.judgements["repair_autonomy"]!.map((j) => j.gap_id);
    expect(ids).toContain("g-src");
    expect(ids).toContain("g-unread");
  });
  it("MUST-FAIL: ledgerLandings splits by kind, newest per gap on each side (a later check never hides the gap's source landing)", () => {
    reset();
    land("g-both", sha("d"), h(60), "att-both-src", ["src/thing.ts"]);
    land("g-both", sha("e"), h(40), "att-both-chk", ["test/checks/g-both.check.ts"]);
    const kindOf = (_repo: string, s: string) => (FILES[s] ? (FILES[s]!.every((x) => x.startsWith("test/checks/")) ? "check" : "source") : null);
    const l = ledgerLandings(deps, NOW - 168 * 3600_000, kindOf);
    expect([l.landings.map((x: { gap_id: string; sha: string }) => `${x.gap_id}@${x.sha[0]}`), (l.check_landings ?? []).map((x: { gap_id: string; sha: string }) => `${x.gap_id}@${x.sha[0]}`)])
      .toEqual([["g-both@d", "g-src@a"], ["g-both@e", "g-chk@b"]]);
  });
  it("control: without a classifier every landing is a repair, as before", () => {
    reset();
    expect(ledgerLandings(deps, NOW - 168 * 3600_000).landings.map((x: { gap_id: string }) => x.gap_id)).toEqual(["g-chk", "g-src"]);
  });
  it("isCheckOnlyCommit: only check files, at least one", () => {
    expect(typeof sfr["isCheckOnlyCommit"]).toBe("function");
    const f = sfr["isCheckOnlyCommit"] as (x: string[] | null) => boolean;
    expect([f(["test/checks/a.check.ts"]), f(["test/checks/a.check.ts", "test/checks/b.check.ts"]), f(["test/checks/a.check.ts", "src/a.ts"]), f(["test/a.test.ts"]), f([]), f(null)]).toEqual([true, true, false, false, false, false]);
  });
});
