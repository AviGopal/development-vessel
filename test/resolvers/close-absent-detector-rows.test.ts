// A DETECTOR ROW WHOSE BIRTH READING IS ABSENT IS CLOSED condition_gone (substrate-gap.ts closeAbsentDetectorRows).
//
// The write seam arms a new detector row from its own reading (evidence_resolve_from detector_reading) and parks it
// needs_information; its check is then judged once at birth. A "present" drains the park (gap-admission
// detectorParkDrain). An "absent" did nothing: the sweep re-takes only unknown or stale-pending verdicts and the drain
// lifts only present, so the row stayed open and parked for good. For a detector row the check IS the detector's own
// reading re-read, so a measured absent means the condition is gone: the sweep closes it condition_gone, counts_as_fix
// false, through the seam as a named system closer. An ordinary row (a check not taken from a reading) is never closed
// this way: there an absent at birth means a suspect check, not a gone condition.
//
// Driven through the real write seam on a temp gap store, with a stub birth judge. Fields the seam never takes from a
// write (birth key drift, a tree-moved stamp, a pending verdict, a hold) are set by editing the scratch store file.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = mkdtempSync(join(tmpdir(), "close-absent-detector-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, gapStoreRootForTest, __setBirthJudgeForTests, class2PredicateKey } = sg;

type Row = Record<string, unknown>;
type Sweep = (gaps: Row[], limit?: number) => Promise<string[]>;
// Read off the module object, so a tree without the sweep fails its assertion instead of the whole file.
async function sweep(gaps: Row[], limit?: number): Promise<string[]> {
  const f = (sg as Record<string, unknown>)["closeAbsentDetectorRows"] as Sweep | undefined;
  expect(typeof f).toBe("function");
  return limit === undefined ? f!(gaps) : f!(gaps, limit);
}

const RUN = Math.random().toString(36).slice(2, 8);
const READING = { shape: "reach_rate_scan", input: { activity_id: "widget-family" }, field: "finding_count", value: 3 };
// The reading the orthogonality audit files its rows on (vector-space-orthogonality-audit.ts orthogonalClusterReading).
const ORTHO_READING = { shape: "vector_space_orthogonality_audit", input: { cluster_key: "widget-cluster", trace_window_hours: 24, similarity_threshold: 0.5, min_failure_traces: 3, trace_limit: 200, emit_gap: false }, field: "cluster_count", value: 1 };
const ORTHO_CAUSE = "the-orthogonality-audit-files-a-cluster-its-own-birth-check-reads-absent-seconds-later-because-a-failed-principle-lookup-scores-as-zero-similarity";
const SITELESS = "two shape families in the widget space read as one direction";
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
// The stub birth judge: "absent" unless the id is listed with another verdict.
const verdictFor: Record<string, string> = {};
let gapStore: { restore: () => Promise<void> } | null = null;

beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "ACTIVITY_API_ENDPOINT", "MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["ACTIVITY_API_ENDPOINT"];
  process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
  for (const d of ["gaps", "runtime", "clones"]) mkdirSync(join(ROOT, d), { recursive: true });
  gapStore = snapshotGapStore(gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
  __setBirthJudgeForTests(async (g: Row) => verdictFor[String(g["id"])] ?? "absent");
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await gapStore?.restore();
  __setBirthJudgeForTests(null);
  globalThis.fetch = originalFetch;
  __resetPolicyReadsForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function write(id: string, meta: Row, detectedAt = new Date().toISOString()): Promise<void> {
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: SITELESS, detected_at: detectedAt, classification_metadata: meta } } as never, { vocabulary: null } as never);
  await __settleBirthEvaluationsForTests();
}
async function stored(id: string): Promise<Row> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Row[] }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error(`no row ${id}`);
  return g;
}
const metaOf = (row: Row): Row => (row.classification_metadata ?? {}) as Row;
/** A detector row born from its reading: parked needs_information, its class2 check birth-judged by the stub. */
async function detectorRow(id: string, verdict = "absent", detectedAt?: string, reading: Row = READING): Promise<Row> {
  if (verdict !== "absent") verdictFor[id] = verdict;
  await write(id, { detector: reading["shape"], detector_reading: reading }, detectedAt);
  const row = await stored(id);
  // PRECONDITION: the seam parked it, armed from its reading, and stamped the stub's verdict on this check.
  expect(metaOf(row)).toMatchObject({ disposition: "needs_information", evidence_resolve_from: "detector_reading", falsifier: "class2", predicate_birth_verdict: verdict });
  expect(metaOf(row)["predicate_birth_key"]).toBe(class2PredicateKey(metaOf(row)));
  return row;
}
/** Edit one stored row in the scratch store file (fields the seam never takes from a write). */
function patchStored(id: string, edit: (row: Row) => void): void {
  const file = join(gapStoreRootForTest(), "gaps", "gaps.json");
  const rows = JSON.parse(readFileSync(file, "utf8")) as Row[];
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no stored row ${id}`);
  edit(row);
  writeFileSync(file, JSON.stringify(rows, null, 2));
}

describe("closeAbsentDetectorRows", () => {
  it("MUST-FAIL (a2) an open, unmarked detector row (not the orthogonality audit) whose birth reading is absent on its current check is closed condition_gone, not a fix, by the system closer, and unparked", async () => {
    const id = `det-absent-${RUN}`;
    const row = await detectorRow(id);
    const closed = await sweep([row]);
    expect(closed).toEqual([id]);
    const after = await stored(id);
    const m = metaOf(after);
    expect(after["status"]).toBe("closed");
    expect(m["closed_reason"]).toBe("condition_gone");
    expect(m["close_basis"]).toBe("birth_absent");
    expect(m["counts_as_fix"]).toBe(false);
    expect(m["closed_by"]).toBe("detector_birth_absent");
    expect("cause_gap" in m).toBe(false);
    expect(m["disposition"]).not.toBe("needs_information");
    expect(m["falsifier_exercise"]).toMatchObject({ detector: READING.shape, verdict: "absent", passed: true, ran_at: metaOf(row)["predicate_birth_at"], key: metaOf(row)["predicate_birth_key"] });
  });

  it("MUST-FAIL (a1) an orthogonality-audit row whose birth reading is absent is closed as a detector false positive from an unconfirmable filing read, naming its cause gap", async () => {
    const id = `det-ortho-${RUN}`;
    const row = await detectorRow(id, "absent", undefined, ORTHO_READING);
    expect(await sweep([row])).toEqual([id]);
    const after = await stored(id);
    const m = metaOf(after);
    expect(after["status"]).toBe("closed");
    expect(m["closed_reason"]).toBe("detector_false_positive");
    expect(m["close_basis"]).toBe("unconfirmable_filing_read");
    expect(m["cause_gap"]).toBe(ORTHO_CAUSE);
    expect(m["counts_as_fix"]).toBe(false);
    expect(m["closed_by"]).toBe("detector_birth_absent");
    expect(m["disposition"]).not.toBe("needs_information");
    expect(m["falsifier_exercise"]).toMatchObject({ detector: ORTHO_READING.shape, verdict: "absent", passed: true });
  });

  it("stamps birth_lag_s (birth verdict time minus detected_at, 0.1 s) in falsifier_exercise, and null when detected_at is unreadable", async () => {
    const id = `det-lag-${RUN}`;
    const base = Date.now() - 3600_000;
    const detectedAt = new Date(base).toISOString();
    const row = await detectorRow(id, "absent", detectedAt);
    patchStored(id, (r) => { (r.classification_metadata as Row)["predicate_birth_at"] = new Date(base + 12_345).toISOString(); });
    expect(await sweep([await stored(id)])).toEqual([id]);
    expect((metaOf(await stored(id))["falsifier_exercise"] as Row)["birth_lag_s"]).toBe(12.3);
    expect(row["detected_at"]).toBe(detectedAt);

    const noDetected = `det-lag-none-${RUN}`;
    await detectorRow(noDetected);
    patchStored(noDetected, (r) => { delete r["detected_at"]; });
    expect(await sweep([await stored(noDetected)])).toEqual([noDetected]);
    const ex = metaOf(await stored(noDetected))["falsifier_exercise"] as Row;
    expect("birth_lag_s" in ex).toBe(true);
    expect(ex["birth_lag_s"]).toBeNull();
  });

  describe("controls that stay open", () => {
    const stillOpen = async (id: string): Promise<void> => {
      expect(await sweep([await stored(id)])).toEqual([]);
      expect((await stored(id))["status"]).toBe("open");
    };
    it("birth verdict present", async () => { const id = `det-present-${RUN}`; await detectorRow(id, "present"); await stillOpen(id); });
    it("birth verdict unknown", async () => { const id = `det-unknown-${RUN}`; await detectorRow(id, "unknown"); await stillOpen(id); });
    it("birth verdict pending", async () => {
      const id = `det-pending-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { (r.classification_metadata as Row)["predicate_birth_verdict"] = "pending"; });
      await stillOpen(id);
    });
    it("absent, but the verdict describes another check (key differs)", async () => {
      const id = `det-key-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { (r.classification_metadata as Row)["predicate_birth_key"] = "{\"evidence_resolve\":null}"; });
      await stillOpen(id);
    });
    it("absent, with predicate_birth_tree_moved", async () => {
      const id = `det-moved-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { (r.classification_metadata as Row)["predicate_birth_tree_moved"] = true; });
      await stillOpen(id);
    });
    it("absent, with operator_hold true", async () => {
      const id = `det-held-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { (r.classification_metadata as Row)["operator_hold"] = true; });
      await stillOpen(id);
    });
    it("absent on a NON-detector row (no evidence_resolve_from): an ordinary absent is a suspect check, never a gone condition", async () => {
      const id = `det-ordinary-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { delete (r.classification_metadata as Row)["evidence_resolve_from"]; });
      const row = await stored(id);
      expect(metaOf(row)).toMatchObject({ falsifier: "class2", predicate_birth_verdict: "absent" });
      await stillOpen(id);
    });
    it("an already closed row", async () => {
      const id = `det-closed-${RUN}`;
      await detectorRow(id);
      patchStored(id, (r) => { r["status"] = "closed"; (r.classification_metadata as Row)["closed_reason"] = "fixture"; });
      expect(await sweep([await stored(id)])).toEqual([]);
      expect(metaOf(await stored(id))["closed_reason"]).toBe("fixture");
    });
  });

  it("closes at most `limit` rows per call", async () => {
    const ids = [0, 1, 2].map((i) => `det-limit-${i}-${RUN}`);
    const rows: Row[] = [];
    for (const id of ids) rows.push(await detectorRow(id));
    const first = await sweep(rows, 2);
    expect(first.length).toBe(2);
    const open = [];
    for (const id of ids) if ((await stored(id))["status"] === "open") open.push(id);
    expect(open.length).toBe(1);
    expect(await sweep(await Promise.all(ids.map(stored)), 2)).toEqual(open);
  });

  it("is a no-op where the store is not held (GAP_STORE_ENDPOINT set)", async () => {
    const id = `det-remote-${RUN}`;
    const row = await detectorRow(id);
    process.env["GAP_STORE_ENDPOINT"] = "http://holder.fixture";
    try { expect(await sweep([row])).toEqual([]); } finally { delete process.env["GAP_STORE_ENDPOINT"]; }
    expect((await stored(id))["status"]).toBe("open");
  });
});
