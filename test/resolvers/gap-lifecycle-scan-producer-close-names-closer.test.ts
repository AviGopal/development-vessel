// GAP_LIFECYCLE_SCAN'S PRODUCER-NOW-EXISTS CLOSE MUST REACH THE STORE WITH ITS CLOSER (check-first, 2026-10-03).
//
// The store now refuses a close that carries a closed_reason but no evidence (close_needs_evidence).
// gap_lifecycle_scan step 1 closes a missing_capability gap once discovery finds a producer for its
// missing_shape, and passes closed_by: "gap_lifecycle_scan" to its local write helper; the helper
// built the gap from id/category/source/summary/status/detected_at/classification_metadata only and
// DROPPED closed_by, so the store saw closed_reason producer_now_exists with nothing naming the closer.
//
// The scan is driven for real: its discovery call is answered by a fixture, and its substrateGap_write
// POSTs are answered by the REAL store resolver (a fresh module instance under this file's temp root).
// MUST-FAIL: the close is refused and the gap stays open. CONTROL: the store accepts the same close
// once closed_by is carried.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-lifecycle-producer-close-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
mkdirSync(join(ROOT, "proposals", ".applied"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-lifecycle-producer-close"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite, gapStoreRootForTest } = sg;
const { resolveGapLifecycleScan } = await import("../../src/resolvers/gap-lifecycle-scan.js");

const STORE = join(ROOT, "gaps", "gaps.json");
const NOW = new Date().toISOString();
const GAP = { id: "lifecycle-fixture-missing-capability", category: "missing_capability", source: "substrate_detected", summary: "no producer for shape fixtureShape", detected_at: NOW, status: "open", classification_metadata: { missing_shape: "fixtureShape" }, created_at: NOW, updated_at: NOW };
const realFetch = globalThis.fetch;
const stored = (id: string): Record<string, any> | undefined => (JSON.parse(readFileSync(STORE, "utf8")) as Array<Record<string, any>>).find((g) => g.id === id);
let storeAnswers: Array<{ shape: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([GAP]));
  storeAnswers = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const pointer = body?.impulse?.pointer ?? {};
    if (pointer.type === "activity_discover_by_shapes") return Response.json({ success: true, body: { activities: [{ id: "fixture-producer" }] } });
    if (pointer.type === "substrateGap_write" && pointer.gap?.id === GAP.id) {
      const r = await resolveSubstrateGapWrite(pointer as never, { vocabulary: null } as never);
      storeAnswers.push(r as never);
      return Response.json({ success: r.shape !== "structuredError", shape: r.shape, body: r.body });
    }
    return Response.json({ success: true, body: {} });
  }) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("gap_lifecycle_scan producer_now_exists close carries its closer to the store", () => {
  it("isolation: the store under test is this file's temp root", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL] a discovered producer closes the missing_capability gap in the real store", async () => {
    await resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath: STORE, proposalsDir: join(ROOT, "proposals"), autoClose: true, staleHours: 100_000, devVesselImpulsesUrl: "http://fixture.invalid/v2/impulses/resolve" } as never);
    expect(storeAnswers.length).toBeGreaterThan(0);
    expect(storeAnswers[0]!.shape).toBe("substrateGapWriteResult");
    const row = stored(GAP.id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("producer_now_exists");
    expect(row.classification_metadata.closed_by).toBe("gap_lifecycle_scan");
  });

  it("[CONTROL] the store accepts the same close when closed_by is carried", async () => {
    const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...GAP, status: "closed", classification_metadata: { ...GAP.classification_metadata, closed_reason: "producer_now_exists", closed_by: "gap_lifecycle_scan" } } } as never, { vocabulary: null } as never);
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(stored(GAP.id)!.status).toBe("closed");
  });
});
