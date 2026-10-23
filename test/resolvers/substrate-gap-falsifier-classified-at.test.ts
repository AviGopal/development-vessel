import { afterAll, afterEach, beforeEach, describe, it, expect } from "bun:test";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

// falsifier_classified_at SAYS WHEN THE CLASSIFICATION LAST CHANGED, NOT WHEN THE ROW WAS LAST WRITTEN.
//
// The write seam re-classifies every write (it must: the merged metadata decides the label), and it re-stamped
// falsifier_classified_at each time. Every read-modify-write (a ledger update, a lease, a summary edit) moved it, so
// the field meant "last touched" and anything reading it as the classification's age (gap-check-supply's arm-age
// fallback) read the last write instead. The stamp now keeps the stored row's instant when the classification the
// write stamps is the one the row already carries, and moves only when it changes.

// Gap writes here must not reach the live event bus (test/resolvers/stub-gap-event-publish.ts).
const gapEventPublishStub = stubGapEventPublish();

// WORKSPACE_ROOT before the import: config.ts snapshots it at module load (see substrate-gap-falsifier.test.ts).
const testWorkspace = join(tmpdir(), `dev-vessel-gap-classified-at-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env["WORKSPACE_ROOT"] = testWorkspace;
isolateLearnedStateInProcess(testWorkspace);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// The store is held HERE: a write on a node that forwards its gap store goes to the holder (gapStoreIsLocal).
const prevGapStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
let prevRuntimeDir: string | undefined;
beforeEach(() => { prevRuntimeDir = process.env["MITOSIS_RUNTIME_DIR"]; process.env["MITOSIS_RUNTIME_DIR"] = testWorkspace; });
afterEach(() => { if (prevRuntimeDir === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = prevRuntimeDir; });
afterAll(() => {
  gapEventPublishStub.restore();
  if (prevGapStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = prevGapStoreEndpoint;
  try { rmSync(testWorkspace, { recursive: true, force: true }); } catch { /* temp */ }
});

const { resolveSubstrateGap, resolveSubstrateGapWrite, gapStoreRootForTest } =
  await import(`../../src/resolvers/substrate-gap.js?${"classified-at-isolated"}`);

const resolvedGapRoot = gapStoreRootForTest();
if (!resolvedGapRoot.startsWith(tmpdir())) throw new Error(`substrate-gap-falsifier-classified-at.test.ts is NOT isolated: its gap store root ${resolvedGapRoot} is not under ${tmpdir()}`);

// An injected vocabulary the classifier agrees to judge with (configs_read >= 5 AND >= 50 names), as the falsifier suite.
const vocab = (): { shapes: Set<string>; configs_read: number } => ({
  shapes: new Set(["trace_failure_pattern_report", "substrateGap", ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]),
  configs_read: 9,
});
const noNetworkBirthJudge = async (): Promise<string> => "present";
const opts = (): Record<string, unknown> => ({ vocabulary: vocab(), birthJudge: noNetworkBirthJudge });

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
async function stored(id: string): Promise<Row> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`no stored row ${id}`);
  return row;
}
async function write(gap: Row): Promise<void> {
  const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, opts() as never);
  if (r.shape === "structuredError") throw new Error("write refused: " + JSON.stringify(r.body));
}
const seedGap = (id: string, meta: Row): Row => ({
  id, category: "systematic_failure", source: "substrate_detected", status: "open",
  summary: `measured defect for ${id}: the resolver returns a stale row after a reopen`, detected_at: "2026-09-01T00:00:00Z", classification_metadata: meta,
});
/** Read the stored row, change one non-falsifier field, write the whole row back: a read-modify-write. */
async function rmw(id: string, edit: (meta: Row) => void): Promise<void> {
  const row = structuredClone(await stored(id));
  const meta = metaOf(row);
  edit(meta);
  row["classification_metadata"] = meta;
  await write(row);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe("falsifier_classified_at moves only when the falsifier classification changes", () => {
  it("[MUST-FAIL] a read-modify-write that leaves the falsifier as it is keeps falsifier_classified_at", async () => {
    const id = `classified-at-same-${RUN}`;
    await write(seedGap(id, { kind: "capability_gap" }));
    const before = metaOf(await stored(id));
    expect(before["falsifier"]).toBe("none");
    expect(typeof before["falsifier_classified_at"]).toBe("string");
    await tick();
    await rmw(id, (m) => { m["note"] = `touched ${RUN}`; });
    const after = metaOf(await stored(id));
    expect(after["note"]).toBe(`touched ${RUN}`); // the write landed
    expect(after["falsifier"]).toBe("none");
    expect(after["falsifier_classified_at"]).toBe(before["falsifier_classified_at"]);
  });

  it("[MUST-FAIL] an unresolvable row re-written with its same predicate keeps its classified_at, and its reason", async () => {
    const id = `classified-at-unres-${RUN}`;
    await write(seedGap(id, { evidence_resolve: { shape: "failurePatternReport" } }));
    const before = metaOf(await stored(id));
    expect(before["falsifier"]).toBe("unresolvable");
    await tick();
    await rmw(id, (m) => { m["note"] = `touched ${RUN}`; });
    const after = metaOf(await stored(id));
    expect(after["falsifier"]).toBe("unresolvable");
    expect(after["falsifier_unadvertised_shape"]).toBe(before["falsifier_unadvertised_shape"]);
    expect(after["falsifier_classified_at"]).toBe(before["falsifier_classified_at"]);
  });

  it("[CONTROL] a write that changes the falsifier classification re-stamps falsifier_classified_at", async () => {
    const id = `classified-at-change-${RUN}`;
    await write(seedGap(id, { kind: "capability_gap" }));
    const before = metaOf(await stored(id));
    expect(before["falsifier"]).toBe("none");
    await tick();
    await rmw(id, (m) => { m["evidence_resolve"] = { shape: "failurePatternReport" }; });
    const after = metaOf(await stored(id));
    expect(after["falsifier"]).toBe("unresolvable");
    expect(Date.parse(String(after["falsifier_classified_at"]))).toBeGreaterThan(Date.parse(String(before["falsifier_classified_at"])));
  });
});
