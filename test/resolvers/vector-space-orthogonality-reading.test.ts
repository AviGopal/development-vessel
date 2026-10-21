// A ROW vector_space_orthogonality_audit FILES CARRIES THE READING IT WAS FILED ON (gap row
// detectors-file-rows-without-a-detector-reading-so-the-armability-core-has-nothing-to-arm-from). Its rows name no
// check, no edit site and no file, so the write seam's contract (substrate-gap.ts detectorBirthContract) can arm one
// only from classification_metadata.detector_reading. The reading is the audit re-read under the row's own cluster
// (input.cluster_key), with the filing run's parameters and emit_gap false; cluster_count is its zero_field.
// Verified at the consumer: the armed check is run by the real judge (gap-check-judge.ts evaluateGapCheck) against
// this resolver. Every value below is supplied by this test.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveVectorSpaceOrthogonalityAudit } from "../../src/resolvers/vector-space-orthogonality-audit.js";
import { detectorBirthContract, DETECTOR_ROW_REFUSAL } from "../../src/resolvers/substrate-gap.js";
import { evaluateGapCheck } from "../../src/judge/gap-check-judge.js";

type Row = Record<string, unknown>;
const SHAPE = "vector_space_orthogonality_audit";
// A judgeable vocabulary (>= 5 configs, >= 50 names) that advertises the audit, so class2 means "advertised" here.
const VOCAB = { shapes: new Set<string>([SHAPE, ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]), configs_read: 10 };
const UNADVERTISED = { shapes: new Set<string>(Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)), configs_read: 10 };
const PARAMS = { trace_window_hours: 6, similarity_threshold: 0.5, min_failure_traces: 3, trace_limit: 50 };
const NOW = () => new Date().toISOString();
const failures = (activity: string, fm: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${activity}-${fm}-${i}`, activity_id: activity, status: "failure", failure_mode: { type: fm, reason: "the step returned an empty body" }, executed_at: NOW(), tasks: [] }));

interface World { traces: unknown[]; tracesStatus?: number; covered: Set<string> }
let world: World;
let writes: Row[] = [];
const originalFetch = globalThis.fetch;
const savedGapStore = process.env["GAP_STORE_ENDPOINT"];
beforeEach(() => {
  writes = [];
  delete process.env["GAP_STORE_ENDPOINT"]; // the judge abstains on a node whose store is held elsewhere
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/v2/activities/execution-traces")) {
      return world.tracesStatus ? new Response("down", { status: world.tracesStatus }) : Response.json({ executions: world.traces });
    }
    if (url.includes("/concepts/search")) {
      // A principle covers an activity's failures when the world says so (its summary leads with the activity id).
      const q = new URL(url).searchParams.get("query") ?? "";
      const sim = [...world.covered].some((a) => q.startsWith(`${a} `)) ? 0.8 : 0.1;
      return Response.json({ concepts: [{ id: "concept_p1", name: "some_principle", _dense_score: sim }] });
    }
    if (url.endsWith("/v2/impulses/resolve")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const gap = body?.impulse?.pointer?.gap;
      if (gap) writes.push(gap);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedGapStore === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedGapStore;
});

/** Run the audit as its tick does (emitting) over the defect world, and return the row it filed for `key`. */
async function filedRow(key: string): Promise<Row> {
  world = { traces: [...failures("actA", "novel_fm", 3), ...failures("actB", "other_fm", 3)], covered: new Set() };
  await resolveVectorSpaceOrthogonalityAudit({ type: SHAPE, ...PARAMS });
  const row = writes.find((g) => ((g["classification_metadata"] ?? {}) as Row)["cluster_key"] === key);
  expect(row).toBeDefined();
  return row as Row;
}
/** The judge's verdict on the armed check, the check resolved against this resolver (as SELF_RESOLVE_ENDPOINT does). */
async function judge(er: Row): Promise<string> {
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const pointer = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
    return Response.json(await resolveVectorSpaceOrthogonalityAudit(pointer));
  }) as unknown as typeof fetch;
  return evaluateGapCheck({ id: "novel-failure-fixture", status: "open", classification_metadata: { evidence_resolve: er } }, { fetchImpl });
}

describe("MUST-FAIL: a row the orthogonality audit files is armed from its own reading", () => {
  it("MUST-FAIL: the filed row carries a detector_reading the core turns into a class2 check scoped to its cluster", async () => {
    const row = await filedRow("actA|novel_fm");
    expect(row["source"]).toBe("substrate_detected");
    const verdict = detectorBirthContract(row, VOCAB as never);
    expect(verdict && "evidence_resolve" in verdict ? verdict.evidence_resolve : verdict).toEqual({
      shape: SHAPE,
      input: { cluster_key: "actA|novel_fm", ...PARAMS, emit_gap: false },
      zero_field: "cluster_count",
    });
  });

  it("MUST-FAIL: the judge measures the armed check on this row's cluster alone, files nothing, and reads an unread store as unknown", async () => {
    const row = await filedRow("actA|novel_fm");
    const verdict = detectorBirthContract(row, VOCAB as never);
    const er = verdict && "evidence_resolve" in verdict ? verdict.evidence_resolve : undefined;
    expect(er).toBeDefined();
    writes = [];
    // the defect stands: the cluster is still orthogonal and still recurring
    expect(await judge(er as Row)).toBe("present");
    // a principle now covers this cluster; the other cluster is still orthogonal, and is not this row's defect
    world.covered = new Set(["actA"]);
    expect(await judge(er as Row)).toBe("absent");
    // the cluster's failures stopped recurring (below the filing minimum)
    world = { traces: [...failures("actA", "novel_fm", 2), ...failures("actB", "other_fm", 3)], covered: new Set() };
    expect(await judge(er as Row)).toBe("absent");
    // the trace store could not be read: not a measurement, never the defect gone
    world = { traces: [], tracesStatus: 503, covered: new Set() };
    expect(await judge(er as Row)).toBe("unknown");
    // a check never files a row
    expect(writes).toEqual([]);
  });
});

describe("CONTROL: a row with no usable reading is still reported unarmable (no reading is invented)", () => {
  it("CONTROL: the filed row with its reading removed names detector_row_unarmable_no_reading", async () => {
    const row = await filedRow("actA|novel_fm");
    const meta = { ...((row["classification_metadata"] ?? {}) as Row) };
    delete meta["detector_reading"];
    const verdict = detectorBirthContract({ ...row, classification_metadata: meta }, VOCAB as never);
    expect(verdict && "rule" in verdict ? verdict.rule : verdict).toBe(DETECTOR_ROW_REFUSAL.no_reading);
  });

  it("CONTROL: a reading with no number, or over an unadvertised shape, names detector_row_unarmable_reading_unusable", async () => {
    const row = await filedRow("actA|novel_fm");
    const meta = (row["classification_metadata"] ?? {}) as Row;
    const notANumber = detectorBirthContract({ ...row, classification_metadata: { ...meta, detector_reading: { shape: SHAPE, field: "cluster_count", value: "several" } } }, VOCAB as never);
    expect(notANumber && "rule" in notANumber ? notANumber.rule : notANumber).toBe(DETECTOR_ROW_REFUSAL.reading_unusable);
    const unadvertised = detectorBirthContract({ ...row, classification_metadata: { ...meta, detector_reading: { shape: SHAPE, field: "cluster_count", value: 1 } } }, UNADVERTISED as never);
    expect(unadvertised && "rule" in unadvertised ? unadvertised.rule : unadvertised).toBe(DETECTOR_ROW_REFUSAL.reading_unusable);
  });
});
