// THE self_fact_reconcile RESPONSE CONTRACT COVERS ITS BODY (substrate-gap.ts RESPONSE_CONTRACTS). The write seam
// stamps arming_invalid on a check naming a field its shape does not declare, so a body key the resolver returns
// undeclared (judgements, must_fail_controls, added with the §14 rows) would condemn every good arming that names it.
// check-response-contract.test.ts does not run this resolver (it reads the live substrate); here it runs with every
// row input stubbed, and every key of its body must be declared. Must-fail: red before the two keys were declared.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `sf-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { resolveSelfFactReconcile, __setJudgementDepsForTests } = await import("../../src/resolvers/self-fact-reconcile.js");
const { responseFields } = await import("../../src/resolvers/resolver-schema.js");

const SUPER = join(ROOT, "super");
const saved = process.env["SUPER_REPO_ROOT"];
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", SUPER, ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr)); };
beforeAll(() => {
  process.env["SUPER_REPO_ROOT"] = SUPER;
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  const row = (id: string, mf: string) => ({ id, instrument: id, profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/self-fact-reconcile.ts", must_fail: mf, window_hours: 168 });
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows: [row("repair_autonomy", "fixture:operator-armed-verified-landing"), row("lane_revert_within_1h", "fixture:regressed-settlement-no-revert")] }));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
  __setJudgementDepsForTests({ ledger: () => [], ledgerPresent: () => true, spool: () => [], readGaps: async () => [], readEvents: async () => ({ events: [], matched: 0 }), keymap: async () => null, labels: async () => null, scopeActs: async () => new Map(), persist: () => ({ appended: true }), now: () => Date.parse("2026-10-22T12:00:00Z"), log: () => {} });
});
afterAll(() => {
  __setJudgementDepsForTests(null);
  if (saved === undefined) delete process.env["SUPER_REPO_ROOT"]; else process.env["SUPER_REPO_ROOT"] = saved;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
describe("self_fact_reconcile's declared response fields", () => {
  it("every key of the report body is declared, the §14 rows' judgements and controls included", async () => {
    const r = await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false } as never);
    const keys = Object.keys((r as { body: Record<string, unknown> }).body);
    expect(keys).toContain("judgements");
    expect(keys.filter((k) => !(responseFields("self_fact_reconcile") ?? []).includes(k))).toEqual([]);
  });
});
