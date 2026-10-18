// SAME DISPATCH, SAME GAP (2026-10-18).
//
// goal-host's floor offers substrateGap_write as a tool, and the model invents the gap id. One goal's
// attempts filed two open rows for one finding (`repair-light-dispatch-vessel-pull-sync-test-failure`,
// `repair-needed-light-dispatch-vessel-6-consecutive-runs`): the ids share no volatile token, so neither the
// exact-id match nor gapClassKey collapses them, and the consumption cap covers detector sources only.
// What the writes share is the pointer-level `dispatch_id` goal-host stamps on every floor tool call.
//
// RULE: a NEW open write whose dispatch already filed an open row within the window, with a near-identical
// summary (token-set Jaccard), lands on that row; the result names the existing id and the reason.
// Different dispatches, or clearly different summaries from one dispatch, still create.
//
// SEAM: fresh module instance under this file's temp root (same as gap-write-birth-fields-immutable).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gap-write-same-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-same-dispatch"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const realFetch = globalThis.fetch;
const rows = (): Array<Record<string, any>> => JSON.parse(readFileSync(STORE, "utf8"));
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

const SUMMARY_A = "Repair needed: the pull-sync test for light-dispatch-vessel has failed 6 consecutive times, exceeding the maximum allowed of 3. The test files are not loading as expected.";
const SUMMARY_A2 = "Repair needed: the pull-sync test for light-dispatch-vessel has failed 6 consecutive runs, exceeding the maximum allowed of 3. The test files are not loading as expected.";
const SUMMARY_B = "The relay transport drops frames over 1200 bytes when the peer handshake renegotiates, so federated resolves time out.";
const gapOf = (id: string, summary: string) => ({ id, category: "repair", source: "light-dispatch-vessel", status: "open", summary, detected_at: new Date().toISOString() });

let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, "[]");
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { logSpy?.mockRestore(); });
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write: one dispatch does not file the same gap twice under invented ids", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] same dispatch, different invented ids, near-identical summaries: the second lands on the first", async () => {
    const r1 = await write({ dispatch_id: "dispatch-same-1", execution_id: "dispatch-same-1", gap: gapOf("repair-light-dispatch-vessel-pull-sync-test-failure", SUMMARY_A) });
    expect(r1.shape).toBe("substrateGapWriteResult");
    expect(r1.body.action).toBe("created");
    const r2 = await write({ dispatch_id: "dispatch-same-1", execution_id: "dispatch-same-1", gap: gapOf("repair-needed-light-dispatch-vessel-6-consecutive-runs", SUMMARY_A2) });
    expect(r2.shape).toBe("substrateGapWriteResult");
    expect(r2.body.id).toBe("repair-light-dispatch-vessel-pull-sync-test-failure");
    expect(r2.body.action).toBe("updated");
    expect(String(r2.body.reason)).toContain("deduplicated: same goal, near-identical summary");
    expect(rows().filter((g) => g.status === "open").map((g) => g.id)).toEqual(["repair-light-dispatch-vessel-pull-sync-test-failure"]);
    expect(logs.some((l) => l.includes("[gap-audit] origin-deduplicated") && l.includes("repair-needed-light-dispatch-vessel-6-consecutive-runs"))).toBe(true);
  });

  it("[CONTROL A] two different dispatches with similar summaries both create", async () => {
    await write({ dispatch_id: "dispatch-a-1", gap: gapOf("repair-light-dispatch-vessel-pull-sync-test-failure", SUMMARY_A) });
    const r2 = await write({ dispatch_id: "dispatch-a-2", gap: gapOf("repair-needed-light-dispatch-vessel-6-consecutive-runs", SUMMARY_A2) });
    expect(r2.body.action).toBe("created");
    expect(r2.body.reason).toBeUndefined();
    expect(rows().length).toBe(2);
  });

  it("[CONTROL B] one dispatch, clearly different summaries, both create", async () => {
    await write({ dispatch_id: "dispatch-b-1", gap: gapOf("repair-light-dispatch-vessel-pull-sync-test-failure", SUMMARY_A) });
    const r2 = await write({ dispatch_id: "dispatch-b-1", gap: gapOf("relay-transport-drops-large-frames", SUMMARY_B) });
    expect(r2.body.action).toBe("created");
    expect(rows().length).toBe(2);
  });

  it("[CONTROL D] an execution_id without a floor dispatch_id is not an origin", async () => {
    await write({ execution_id: "exec-d-1", gap: gapOf("repair-light-dispatch-vessel-pull-sync-test-failure", SUMMARY_A) });
    const r2 = await write({ execution_id: "exec-d-1", gap: gapOf("repair-needed-light-dispatch-vessel-6-consecutive-runs", SUMMARY_A2) });
    expect(r2.body.action).toBe("created");
    expect(rows().length).toBe(2);
  });

  it("[CONTROL C] a write carrying no dispatch is unaffected", async () => {
    await write({ gap: gapOf("repair-light-dispatch-vessel-pull-sync-test-failure", SUMMARY_A) });
    const r2 = await write({ gap: gapOf("repair-needed-light-dispatch-vessel-6-consecutive-runs", SUMMARY_A2) });
    expect(r2.body.action).toBe("created");
    expect(rows().length).toBe(2);
  });
});
