// THE §14 ROWS' 7-DAY TREND (REALIGNMENT §14 #3: is repair autonomy RISING over 7 days?). Every run of repair_autonomy
// and lane_revert_within_1h appends its checked/expected aggregate to the ledger (attemptLedger kind
// selfFactAggregate); nothing read that series back, so "rising over 7 days" was never computed. Each run now reads it
// (aggregateTrend) and reports body.trends.<row>: rising / flat / falling / insufficient_data with its slope and the
// per-day checked/expected, and files a divergence when the share is falling.
// Driven through the real resolver with planted aggregate records (rows in a real git repo, every row input injected):
//   MUST-FAIL  7 days of a rising share read "rising" with a positive slope;
//   MUST-FAIL  7 days of a falling share read "falling" and file the row's trend-falling divergence;
//   CONTROL    6 days read insufficient_data, never rising;
//   CONTROL    a share that rises only in UNJUDGED items is not autonomy: checked stays 0, so it reads flat, not rising;
//   CONTROL    another node's runs, unobserved runs and runs with nothing expected give no share.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-trend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveSelfFactReconcile, __setJudgementDepsForTests, thisNode } = sfr;

const SUPER = join(ROOT, "super");
const saved: Record<string, string | undefined> = {};
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const NOW = Date.parse("2026-10-22T12:00:00Z");
const dayAt = (daysAgo: number, hour = 6) => new Date(Date.parse("2026-10-22T00:00:00Z") - daysAgo * 86_400_000 + hour * 3600_000).toISOString();
type Rec = { key: string; at: string; record: Record<string, unknown> };
let AGG: Rec[] = [];
/** One persisted run of `fact` on `daysAgo` with checked/expected (unjudged = expected - checked unless given). */
const run1 = (fact: string, daysAgo: number, checked: number, expected: number, over: Record<string, unknown> = {}): Rec => {
  const ran_at = dayAt(daysAgo, (over["hour"] as number | undefined) ?? 6);
  return { key: `${fact}@${thisNode()}@${ran_at}@recheck`, at: ran_at, record: { fact, node: thisNode(), ran_at, planted: false, observed: true, checked, expected, counted: checked, unjudged: expected - checked, window_hours: 168, ...over } };
};
const series = (fact: string, shares: Array<[number, number]>): Rec[] => shares.map(([c, e], i) => run1(fact, shares.length - 1 - i, c, e));

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  const row = (id: string, mf: string) => ({ id, instrument: id, profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: mf, window_hours: 168 });
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [row("repair_autonomy", "fixture:operator-armed-verified-landing"), row("lane_revert_within_1h", "fixture:regressed-settlement-no-revert")] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  // The ledger holds no landings and no settlements; the aggregate series is the planted one. This run's own append is
  // not added to it (persist records nothing), so the trend reads exactly the planted days.
  __setJudgementDepsForTests({
    ledger: (kind) => (kind === "selfFactAggregate" ? AGG : []), ledgerPresent: () => true, spool: () => [],
    readGaps: async () => [], readEvents: async () => ({ events: [], matched: 0 }), keymap: async () => null, labels: async () => null,
    scopeActs: async () => new Map(), persist: () => ({ appended: true }), now: () => NOW, log: () => {},
  });
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

type Trend = { trend: string; slope: number | null; days_with_share: number; days: Array<{ day: string; checked: number | null; expected: number | null; share: number | null }> };
type Report = { body: { trends?: Record<string, Trend>; divergences: Array<{ fact: string; key: string; detail: string }> } };
const report = async (): Promise<Report> => (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never)) as unknown as Report;
const trendOf = (r: Report, fact: string): Trend | undefined => r.body.trends?.[fact];
const fell = (r: Report, fact: string) => r.body.divergences.some((d) => d.fact === fact && d.key === "trend-falling");

describe("§14 rows: the 7-day trend over the persisted aggregates", () => {
  it("MUST-FAIL: 7 days of a rising checked/expected share read rising, with its slope", async () => {
    AGG = series("repair_autonomy", [[1, 10], [2, 10], [2, 10], [4, 10], [5, 10], [5, 10], [7, 10]]);
    const r = await report();
    const t = trendOf(r, "repair_autonomy");
    expect({ trend: t?.trend, days: t?.days_with_share, positive: (t?.slope ?? 0) > 0 }).toEqual({ trend: "rising", days: 7, positive: true });
    expect(t!.days.map((d) => d.share)).toEqual([0.1, 0.2, 0.2, 0.4, 0.5, 0.5, 0.7]);
    expect(fell(r, "repair_autonomy")).toBe(false);
  });
  it("MUST-FAIL: 7 days of a falling share read falling and file the row's trend-falling divergence", async () => {
    AGG = series("repair_autonomy", [[7, 10], [6, 10], [6, 10], [4, 10], [3, 10], [1, 10], [0, 10]]);
    const r = await report();
    const t = trendOf(r, "repair_autonomy");
    expect({ trend: t?.trend, negative: (t?.slope ?? 0) < 0 }).toEqual({ trend: "falling", negative: true });
    expect(fell(r, "repair_autonomy")).toBe(true);
  });
  it("MUST-FAIL: the lane-revert row reads its own series the same way", async () => {
    AGG = series("lane_revert_within_1h", [[0, 2], [1, 2], [1, 2], [1, 2], [2, 2], [2, 2], [2, 2]]);
    const r = await report();
    expect(trendOf(r, "lane_revert_within_1h")?.trend).toBe("rising");
    expect(trendOf(r, "repair_autonomy")?.trend).toBe("insufficient_data");
  });
  it("CONTROL: fewer than 7 days of records read insufficient_data (never rising), with no slope and no divergence", async () => {
    AGG = series("repair_autonomy", [[1, 10], [2, 10], [3, 10], [4, 10], [5, 10], [6, 10]]);
    const r = await report();
    const t = trendOf(r, "repair_autonomy");
    expect({ trend: t?.trend, slope: t?.slope, days: t?.days_with_share }).toEqual({ trend: "insufficient_data", slope: null, days: 6 });
    expect(fell(r, "repair_autonomy")).toBe(false);
  });
  it("CONTROL: unjudged items are never autonomy: a series that grows only in unjudged items reads flat, not rising", async () => {
    AGG = series("repair_autonomy", [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7]]);
    const t = trendOf(await report(), "repair_autonomy");
    expect({ trend: t?.trend, slope: t?.slope }).toEqual({ trend: "flat", slope: 0 });
  });
  it("CONTROL: another node's runs, an unobserved run and a run with nothing expected give no share; a day's latest run decides", async () => {
    const base = series("repair_autonomy", [[1, 10], [2, 10], [3, 10], [4, 10], [5, 10], [6, 10], [7, 10]]);
    AGG = [
      ...base.slice(0, 4),
      { ...base[4]!, record: { ...base[4]!.record, node: "another-node" } },
      { ...base[5]!, record: { ...base[5]!.record, observed: false } },
      run1("repair_autonomy", 0, 0, 0),
      run1("repair_autonomy", 3, 9, 10, { hour: 2 }), // an earlier run that day: the 06:00 run (4/10) decides
    ];
    const t = trendOf(await report(), "repair_autonomy");
    expect({ trend: t?.trend, days: t?.days_with_share, shares: t?.days.map((d) => d.share) }).toEqual({ trend: "insufficient_data", days: 4, shares: [0.1, 0.2, 0.3, 0.4, null, null, null] });
  });
});
