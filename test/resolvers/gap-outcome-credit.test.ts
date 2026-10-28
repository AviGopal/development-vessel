// A SETTLED GAP CREDITS OR CHARGES THE EXECUTION THAT FILED IT (findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28, "detectors
// scored by consumption"; step (3)). A detector tick's posterior moved on its own run status, and the only detector credit
// (a name-keyed closure ledger written on a landed close) was read by nothing. Now a row that names its producer
// (producer_execution_id, from the tick's producer context) posts ONE consumer trace when it is closed or rejected: the
// producer is the trace's only composition_chain ancestor and its task's consumed_provenance names the gap, so
// activity-api's existing chain credit (propagateCreditAlongChain, declared data flow) gives the producer the outcome.
// MUST-FAIL on the parent: no gap outcome credit exists; nothing is posted when a producer-named gap settles.
// The receiver half (the producer's belief row moves) is read after install on the live store; it is not stubbed here.
// SEAM: fresh module instance under this file's temp root. Words from a 5-word draw (2026-10-28T07:04:54Z: tweet self
// trace confused campsite).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gap-outcome-credit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-outcome-credit"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;
const setSink = (sg as Record<string, unknown>)["__setGapOutcomeSinkForTests"] as ((fn: ((t: Record<string, unknown>) => void) | null) => void) | undefined;
const verdictOf = (sg as Record<string, unknown>)["gapOutcomeVerdict"] as ((g: Record<string, unknown>) => { credit: string | null }) | undefined;

const STORE = join(ROOT, "gaps", "gaps.json");
const realFetch = globalThis.fetch;
const AT = "2026-10-28T07:00:00.000Z";
const PRODUCER = { producer_execution_id: "exec_campsitetweet", producer_template_id: "development-vessel:detect-confused-campsite" };
const seed = (id: string, meta: Record<string, unknown>) => writeFileSync(STORE, JSON.stringify([{ id, category: "systematic_failure", source: "substrate_detected", summary: `the campsite trace self-tweet ${id}`, detected_at: AT, status: "open", classification_metadata: { detector: "campsite_scan", ...meta }, created_at: AT, updated_at: AT }]));
const settle = (id: string, status: "closed" | "rejected", meta: Record<string, unknown>) =>
  resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", summary: `the campsite trace self-tweet ${id}`, detected_at: AT, status, classification_metadata: meta } } as never, { vocabulary: null } as never) as Promise<{ shape: string }>;
let posted: Record<string, unknown>[] = [];
const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, "[]");
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  posted = [];
  setSink?.((t) => { posted.push(t); });
});
afterAll(() => { globalThis.fetch = realFetch; setSink?.(null); });

describe("a settled gap credits the execution that filed it, through the existing chain credit", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a durable close of a producer-named gap posts a reached consumer trace naming the producer as its ancestor", async () => {
    expect(typeof setSink).toBe("function");
    seed("campsite-tweet-1", PRODUCER);
    const r = await settle("campsite-tweet-1", "closed", { closed_reason: "landed_verified", landed_sha: "abc1234" });
    expect(r.shape).toBe("substrateGapWriteResult");
    await flush();
    expect(posted).toHaveLength(1);
    const t = posted[0]!;
    expect(t["composition_chain"]).toEqual(["exec_campsitetweet"]);
    expect(t["success"]).toBe(true);
    expect(t["tags"]).toContain("reached:true");
    const task = (t["tasks"] as Array<Record<string, unknown>>)[0]!;
    expect(task["consumed_provenance"]).toEqual([{ impulse_id: "campsite-tweet-1", producer_execution_id: "exec_campsitetweet", origin: "ancestor" }]);
    expect(task["resolver_tier"]).toBe("deterministic");
  });

  it("[MUST-FAIL] an expired producer-named gap charges the producer (a failed, blame-carrying consumer trace)", async () => {
    seed("campsite-tweet-2", PRODUCER);
    await settle("campsite-tweet-2", "closed", { closed_reason: "expired_not_redetected", closed_by: "gap_lifecycle_scan" });
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!["success"]).toBe(false);
    expect((posted[0]!["failure_mode"] as Record<string, unknown>)["type"]).toBe("verifier_negative");
    expect(posted[0]!["composition_chain"]).toEqual(["exec_campsitetweet"]);
  });

  it("[MUST-FAIL] a rejected producer-named gap charges the producer", async () => {
    seed("campsite-tweet-3", PRODUCER);
    await settle("campsite-tweet-3", "rejected", { rejected_reason: "false_positive", closed_by: "operator-review" });
    await flush();
    expect(posted.map((t) => t["success"])).toEqual([false]);
  });

  it("[CONTROL] a gap with no producer credits nothing", async () => {
    seed("campsite-tweet-4", {});
    await settle("campsite-tweet-4", "closed", { closed_reason: "landed_verified", landed_sha: "abc1234" });
    await flush();
    expect(posted).toEqual([]);
  });

  it("[CONTROL] a close that says nothing about the producer (condition gone, already resolved) credits nothing either way", async () => {
    seed("campsite-tweet-5", PRODUCER);
    await settle("campsite-tweet-5", "closed", { closed_reason: "condition_gone", closed_by: "self_fact_reconcile" });
    await flush();
    expect(posted).toEqual([]);
    expect(verdictOf?.({ status: "closed", classification_metadata: { closed_reason: "already_resolved" } }).credit).toBeNull();
  });

  it("[CONTROL] re-writing an already-closed row posts nothing (no second credit)", async () => {
    seed("campsite-tweet-6", PRODUCER);
    await settle("campsite-tweet-6", "closed", { closed_reason: "landed_verified", landed_sha: "abc1234" });
    await settle("campsite-tweet-6", "closed", { closed_reason: "landed_verified", landed_sha: "abc1234" });
    await flush();
    expect(posted).toHaveLength(1);
  });

  it("[CONTROL] the name-keyed closure ledger is gone: a landed close no longer writes detector_credit", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "judge", "gap-landing-verdict.ts"), "utf8");
    expect(src).not.toContain('table: "detector_credit"');
    expect(src).not.toContain("export function readDetectorClosureCredit");
  });
});
