// §14 #3 VISIBILITY: "rising over 7 days" is computable only if each run's aggregate is KEPT. repair_autonomy and
// lane_revert_within_1h append one selfFactAggregate record per row per run to the landing ledger (append-only: a
// repeated key is refused), observed or not, read back through the attemptLedger shape. Must-fail: with the append
// removed (mutant P1) the ledger holds nothing after a run.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-aggregate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const savedLedgerDir = process.env["ATTEMPT_LEDGER_DIR"];
process.env["ATTEMPT_LEDGER_DIR"] = join(ROOT, "ledger");

const { resolveSelfFactReconcile, __setJudgementDepsForTests } = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveAttemptLedger, __resetLedgerIndexForTests } = await import("../../src/resolvers/attempt-ledger.js");
type Deps = Parameters<typeof __setJudgementDepsForTests>[0];

const SUPER = join(ROOT, "super");
const savedEnv: Record<string, string | undefined> = {};
const git = (...args: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...args], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
const ROWS = [
  { id: "repair_autonomy", instrument: "repair_autonomy", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:operator-armed-verified-landing", window_hours: 168 },
  { id: "lane_revert_within_1h", instrument: "lane_revert_within_1h", profiles: ["standalone", "hub"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: "fixture:regressed-settlement-no-revert", window_hours: 168 },
];
let NOW = Date.parse("2026-10-22T12:00:00Z");
let PRESENT = true;
// Everything but `persist` is a stand-in; the append goes to the real (temp) ledger.
const deps: Deps = {
  ledger: () => [], ledgerPresent: () => PRESENT, spool: () => [], readGaps: async () => [], readEvents: async () => ({ events: [], matched: 0 }),
  keymap: async () => null, labels: async () => null, locate: () => null, cloneOf: () => null, revParse: () => null, fixCommit: () => null,
  siteCommits: () => [], firstCommit: () => undefined, revertsOf: () => [], commit: () => null, show: () => null,
  scopeActs: async () => new Map(), now: () => NOW, log: () => {},
};
const records = async () => {
  const r = await resolveAttemptLedger({ type: "attemptLedger", kind: "selfFactAggregate" as never });
  return ((r.body as { records?: Array<{ key: string; record: Record<string, unknown> }> }).records ?? []);
};

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "PROFILE", "PROFILE_EFFECTIVE", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["PROFILE"]; delete process.env["PROFILE_EFFECTIVE"]; delete process.env["GAP_STORE_ENDPOINT"];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: ROWS }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  const { persist: _real, ...rest } = deps!;
  __setJudgementDepsForTests(rest);
  __resetLedgerIndexForTests();
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (savedLedgerDir === undefined) delete process.env["ATTEMPT_LEDGER_DIR"]; else process.env["ATTEMPT_LEDGER_DIR"] = savedLedgerDir;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("one selfFactAggregate record per row per run, append-only", () => {
  it("a run appends one record for each row, with its aggregate, readable through attemptLedger", async () => {
    await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never);
    const r = await records();
    expect(r.map((x) => x.record["fact"]).sort()).toEqual(["lane_revert_within_1h", "repair_autonomy"]);
    const rep = r.find((x) => x.record["fact"] === "repair_autonomy")!;
    expect(rep.key).toContain(`repair_autonomy@`);
    expect(rep.key.endsWith(`@${new Date(NOW).toISOString()}@planted`)).toBe(true);
    expect(rep.record).toMatchObject({ observed: true, checked: 0, expected: 0, window_hours: 168, planted: true });
  });
  it("the next run appends again (a series, not an overwrite)", async () => {
    NOW += 3600_000;
    await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never);
    expect((await records()).length).toBe(4);
  });
  it("the same run key is refused (append-only), and the report says it was not appended", async () => {
    const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never)) as unknown as { body: { facts_checked: Array<{ fact: string; aggregate?: { persisted?: { appended: boolean } } }> } };
    expect((await records()).length).toBe(4);
    expect(r.body.facts_checked.find((f) => f.fact === "repair_autonomy")!.aggregate!.persisted!.appended).toBe(false);
  });
  it("an unobserved run is persisted too, marked observed:false", async () => {
    NOW += 3600_000; PRESENT = false;
    try { await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never); } finally { PRESENT = true; }
    const last = (await records()).filter((x) => x.key.includes(new Date(NOW).toISOString()));
    expect(last.map((x) => x.record["observed"])).toEqual([false, false]);
  });
});
