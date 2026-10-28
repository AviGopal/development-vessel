// A GAP A TICK FILES NAMES THE EXECUTION AND TEMPLATE THAT FILED IT (findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28,
// "detectors scored by consumption").
//
// A detector tick dispatched by light-dispatch runs with producer_execution_id / producer_template_id on its task
// pointer (light-dispatch src/producer-stamp.ts). Its resolver files gaps in-process or by a self-call. Before this,
// a gap row carried at most classification_metadata.detector (a NAME), so a close / reject / expiry could never be
// credited to the execution and template that produced the gap.
//
// MUST-FAIL on the parent: lib/call-credential.ts has no producer context; the rows carry no producer fields.
// SEAM: fresh module instance under this file's temp root (as gap-write-same-dispatch-dedupe).
// Fixture words from a 5-word draw (draw-words.sh 2026-10-27T05:51:57Z: blob enduring womanhood unsworn waving).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { producerFromHeaders, runWithProducer, PRODUCER_EXECUTION_HEADER } from "../../src/lib/call-credential.js";
import { selfAuthHeaders } from "../../src/lib/self-auth.js";

const ROOT = join(tmpdir(), `gap-write-producer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-producer"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, resolveSubstrateGap, gapStoreRootForTest } = sg;

const STORE = join(ROOT, "gaps", "gaps.json");
const realFetch = globalThis.fetch;
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;
/** The row as a consumer reads it: BY ID through the gap read. */
async function rowById(id: string): Promise<Record<string, any> | undefined> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, include_held: true } as never) as { body: Record<string, any> };
  const list = (r.body?.gaps ?? r.body?.items ?? (Array.isArray(r.body) ? r.body : [])) as Array<Record<string, any>>;
  return list.find((g) => g.id === id);
}
const TICK = { execution_id: "exec_unswornblob1", template_id: "development-vessel:detect-enduring-waving" };
const gapOf = (id: string, summary: string, meta: Record<string, unknown> = { detector: "waving_blob_scan" }) =>
  ({ id, category: "architectural_pattern", source: "substrate_detected", status: "open", summary, detected_at: new Date().toISOString(), classification_metadata: meta });

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, "[]");
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("a tick-filed gap row names its producing execution and template", () => {
  it("isolation: the store under test is the temp root of this file", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a gap filed inside a tick's producer context holds producer_execution_id and producer_template_id, read back by id", async () => {
    const r = await runWithProducer(TICK, () => write({ gap: gapOf("unsworn-blob-waving", "The enduring blob scan found an unsworn waving record.") }));
    expect(r.body.action).toBe("created");
    const row = await rowById("unsworn-blob-waving");
    expect(row?.classification_metadata?.producer_execution_id).toBe("exec_unswornblob1");
    expect(row?.classification_metadata?.producer_template_id).toBe("development-vessel:detect-enduring-waving");
    expect(row?.classification_metadata?.detector).toBe("waving_blob_scan"); // the name stays beside it
  });

  it("[MUST-FAIL] the self-call round-trip: selfAuthHeaders carries the producer, the route's header read restores it", async () => {
    const SELF = "http://127.0.0.1:8090/v2/impulses/resolve";
    const headers = await runWithProducer(TICK, async () => selfAuthHeaders(SELF, SELF));
    expect(headers[PRODUCER_EXECUTION_HEADER]).toBe("exec_unswornblob1");
    const restored = producerFromHeaders((n) => headers[n]);
    await runWithProducer(restored, () => write({ gap: gapOf("womanhood-enduring-blob", "An enduring blob of womanhood records was filed twice.") }));
    const row = await rowById("womanhood-enduring-blob");
    expect(row?.classification_metadata?.producer_execution_id).toBe("exec_unswornblob1");
    expect(row?.classification_metadata?.producer_template_id).toBe("development-vessel:detect-enduring-waving");
  });

  it("[MUST-FAIL] a pointer-level stamp (light-dispatch's, or one a forwarding node carried) is recorded", async () => {
    await write({ producer_execution_id: "exec_wavingblob22", producer_template_id: "development-vessel:detect-unsworn", gap: gapOf("waving-unsworn-entry", "A waving unsworn entry has no owner.") });
    const row = await rowById("waving-unsworn-entry");
    expect(row?.classification_metadata?.producer_execution_id).toBe("exec_wavingblob22");
    expect(row?.classification_metadata?.producer_template_id).toBe("development-vessel:detect-unsworn");
  });

  it("[CONTROL] no producer (a node whose light-dispatch does not stamp yet, a walk, an operator): the write goes on unchanged", async () => {
    const r = await write({ dispatch_id: "dispatch-walk-1", gap: gapOf("enduring-waving-walk", "A walk filed an enduring waving finding.") });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body.action).toBe("created");
    const row = await rowById("enduring-waving-walk");
    expect(row?.status).toBe("open");
    expect("producer_execution_id" in (row?.classification_metadata ?? {})).toBe(false);
    expect("producer_template_id" in (row?.classification_metadata ?? {})).toBe(false);
    expect(row?.classification_metadata?.origin_dispatch_id).toBe("dispatch-walk-1");
  });

  it("[CONTROL] producer fields written into the metadata are never taken as the stamp", async () => {
    await write({ gap: gapOf("blob-forged-producer", "A blob claims a producer it never ran under.", { detector: "waving_blob_scan", producer_execution_id: "exec_forged", producer_template_id: "forged" }) });
    const row = await rowById("blob-forged-producer");
    expect("producer_execution_id" in (row?.classification_metadata ?? {})).toBe(false);
    await runWithProducer(TICK, () => write({ gap: gapOf("blob-forged-under-tick", "A blob under a tick claims another producer.", { producer_execution_id: "exec_forged" }) }));
    expect((await rowById("blob-forged-under-tick"))?.classification_metadata?.producer_execution_id).toBe("exec_unswornblob1");
  });

  it("[CONTROL] a stored row keeps its first producer when a later tick re-files it; a row with none takes the first", async () => {
    await runWithProducer(TICK, () => write({ gap: gapOf("enduring-unsworn-row", "The enduring unsworn row was found.") }));
    await runWithProducer({ execution_id: "exec_laterwaving9", template_id: "development-vessel:detect-later" }, () => write({ gap: gapOf("enduring-unsworn-row", "The enduring unsworn row was found again.") }));
    expect((await rowById("enduring-unsworn-row"))?.classification_metadata?.producer_execution_id).toBe("exec_unswornblob1");
    await write({ gap: gapOf("unsworn-blob-legacy", "A legacy blob row filed before producers were stamped.") });
    await runWithProducer(TICK, () => write({ gap: gapOf("unsworn-blob-legacy", "A legacy blob row re-filed by a tick.") }));
    expect((await rowById("unsworn-blob-legacy"))?.classification_metadata?.producer_execution_id).toBe("exec_unswornblob1");
  });

  it("[CONTROL] selfAuthHeaders outside a producer context, or to another URL, carries no producer header", () => {
    const SELF = "http://127.0.0.1:8090/v2/impulses/resolve";
    expect(PRODUCER_EXECUTION_HEADER in selfAuthHeaders(SELF, SELF)).toBe(false);
    return runWithProducer(TICK, async () => {
      expect(selfAuthHeaders("http://elsewhere.example/v2/impulses/resolve", SELF)).toEqual({});
    });
  });
});
