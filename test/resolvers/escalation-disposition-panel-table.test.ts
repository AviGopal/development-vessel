// EVERY PANEL THE GAP JUDGE ASKS ON IS READ (row an-escalation-answer-for-a-pending-verify-panel-is-refused-as-
// unrecognised-so-the-human-verdict-is-never-read; qa ruling 2026-10-23, under the user's authorization). The applier
// recognised only needs-human- and reland-needs-human-, so an answer on landed-close-proposal-<gap> (the landed-open
// detector's question) or pending-verify-<gap> came back unrecognised_panel_id and the human verdict was never read.
//
// Through the REAL applier in a fresh process on a temp WORKSPACE_ROOT (gap store + interactor log), fetch stubbed.
// MUST-FAIL: a "close" answer on landed-close-proposal-<gap> closes that row landed_verified, linked to the question and
//   the proposal's commit (unrecognised_panel_id at the parent).
// MUST-FAIL: a pending-verify-<gap> answer is read with the existing verbs (a "drop" closes it human_dropped).
// CONTROL: a non-close answer on a close proposal leaves the row open; needs-human- and reland-needs-human- behave as
//   before (a "redefine" grants the bounded exemption and keeps the row open).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "./isolated-gap-store-run";
import * as eda from "../../src/resolvers/escalation-disposition-apply.js";

const ROOT = join(tmpdir(), `eda-panel-table-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const EDA = new URL("../../src/resolvers/escalation-disposition-apply.ts", import.meta.url).pathname;
const FIX = "d".repeat(40);

beforeAll(() => {
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  mkdirSync(join(ROOT, "interactor-log"), { recursive: true });
  const now = new Date().toISOString();
  const row = (id: string, meta: Record<string, unknown> = {}) => ({ id, category: `cat_${id}`, source: "substrate_detected", summary: `row ${id}`, detected_at: now, created_at: now, updated_at: now, status: "open", classification_metadata: { edit_site: "repos/development-vessel/src/x.ts", ...meta } });
  const proposal = { landed_close_proposal: { fixing_sha: FIX, head: FIX, verdict: "absent", detector: "gap-sweep:landed_close_proposal" } };
  writeFileSync(GAPS_PATH, JSON.stringify([row("lcp-yes", proposal), row("lcp-no", proposal), row("pv-drop"), row("nh-redefine"), row("rl-redefine")]));
  const answer = (panel_id: string, value: string, i: number) => JSON.stringify({ id: `fb-${i}`, pointer: { panel_id, value, kind: "answer" } });
  writeFileSync(join(ROOT, "interactor-log", "uiFeedback_write.jsonl"), [
    answer("landed-close-proposal-lcp-yes", "close it, the fix landed", 1),
    answer("landed-close-proposal-lcp-no", "do not close, the wiring is still missing", 2),
    answer("pending-verify-pv-drop", "drop it", 3),
    answer("needs-human-nh-redefine", "redefine the goal", 4),
    answer("reland-needs-human-rl-redefine", "redefine the goal", 5),
  ].join("\n") + "\n");
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function applyInIsolation(): { exit: number; out: string } {
  const code = [
    `globalThis.fetch = (async () => new Response("{}", { status: 404 }));`,
    `const { resolveEscalationDispositionApply } = await import(${JSON.stringify(EDA)});`,
    `const r = await resolveEscalationDispositionApply({ type: "escalation_disposition_apply" });`,
    `console.log("APPLY_RESULT " + JSON.stringify(r.body));`,
  ].join("\n");
  const env = isolatedChildEnv(ROOT, { HOME: process.env.HOME ?? ROOT, NODE_ENV: "test", TZ: "UTC" });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr) };
}

describe("escalation_disposition_apply reads every panel prefix the gap judge asks on", () => {
  let run: { exit: number; out: string } | null = null;
  let byId = new Map<unknown, Record<string, any>>();
  let report: Record<string, any> = {};
  const once = () => {
    if (run) return run;
    run = applyInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, any>>).map((g) => [g.id, g]));
    const line = run.out.split("\n").find((l) => l.startsWith("APPLY_RESULT "));
    report = line ? JSON.parse(line.slice("APPLY_RESULT ".length)) : {};
    return run;
  };
  const outcome = (panel: string) => (report.dispositions ?? []).find((d: Record<string, unknown>) => d.panel_id === panel)?.outcome ?? null;

  it("the applier ran", () => {
    const r = once();
    expect({ exit: r.exit, ran: r.out.includes("APPLY_RESULT ") }, r.out.slice(-2000)).toEqual({ exit: 0, ran: true });
  });
  it("MUST-FAIL: a close answer on landed-close-proposal-<gap> closes it landed_verified, linked to the question and the commit", () => {
    const r = once();
    const g = byId.get("lcp-yes")!;
    const m = g.classification_metadata;
    expect({ outcome: outcome("landed-close-proposal-lcp-yes"), status: g.status, reason: m.closed_reason, sha: m.landed_sha, panel: m.closed_by_answer?.panel_id, record: m.closed_by_answer?.record_id }, r.out.slice(-2000))
      .toEqual({ outcome: "applied", status: "closed", reason: "landed_verified", sha: FIX, panel: "landed-close-proposal-lcp-yes", record: "fb-1" });
  });
  it("MUST-FAIL: a pending-verify-<gap> answer is read with the existing verbs (drop closes it human_dropped)", () => {
    once();
    const g = byId.get("pv-drop")!;
    expect({ outcome: outcome("pending-verify-pv-drop"), status: g.status, reason: g.classification_metadata.closed_reason }).toEqual({ outcome: "applied", status: "closed", reason: "human_dropped" });
  });
  it("CONTROL: a non-close answer on a close proposal leaves the row open", () => {
    once();
    const g = byId.get("lcp-no")!;
    expect({ status: g.status, reason: g.classification_metadata.closed_reason ?? null }).toEqual({ status: "open", reason: null });
  });
  it("CONTROL: needs-human- and reland-needs-human- behave as before (redefine: open, bounded exemption)", () => {
    once();
    for (const id of ["nh-redefine", "rl-redefine"]) {
      const g = byId.get(id)!;
      expect({ id, status: g.status, verb: g.classification_metadata.human_disposition, ex: g.classification_metadata.human_exemption_attempts_remaining }).toEqual({ id, status: "open", verb: "redefine", ex: eda.HUMAN_EXEMPTION_ATTEMPTS });
    }
    expect(eda.gapIdFromPanelId("reland-needs-human-x")).toBe("x");
    expect(eda.gapIdFromPanelId("some-other-panel")).toBe("");
  });
});
