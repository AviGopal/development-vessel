// A ROW detector_coverage_scan FILES CARRIES THE READING IT WAS FILED ON (gap row
// detectors-file-rows-without-a-detector-reading-so-the-armability-core-has-nothing-to-arm-from). Its rows name no
// check, no edit site and no file, so the write seam's contract (substrate-gap.ts detectorBirthContract) can arm one
// only from classification_metadata.detector_reading. The reading is the scan re-read under the row's own class
// (input.gap_class), with the filing run's parameters and emit_gap false; uncovered_clusters is its zero_field.
// Verified at the consumer: the armed check is run by the real judge (gap-check-judge.ts evaluateGapCheck) against
// this resolver, over a store that holds the filed row itself. Every value below is supplied by this test.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveDetectorCoverageScan } from "../../src/resolvers/detector-coverage-scan.js";
import { detectorBirthContract, DETECTOR_ROW_REFUSAL } from "../../src/resolvers/substrate-gap.js";
import { evaluateGapCheck } from "../../src/judge/gap-check-judge.js";

type Row = Record<string, unknown>;
const SHAPE = "detector_coverage_scan";
// A judgeable vocabulary (>= 5 configs, >= 50 names) that advertises the scan, so class2 means "advertised" here.
const VOCAB = { shapes: new Set<string>([SHAPE, ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]), configs_read: 10 };
const UNADVERTISED = { shapes: new Set<string>(Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)), configs_read: 10 };
const PARAMS = { window_hours: 12, trace_limit: 80, min_recurrence: 3, coverage_threshold: 0.25 };
const CLASS = "empty_body_development_vessel_widget_step";
const OTHER = "timeout_development_vessel_gadget_step";
const NOW = () => new Date().toISOString();
const failures = (activity: string, fm: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${fm}-${i}`, activity_id: activity, status: "failure", failure_mode: { type: fm, reason: "the step returned an empty body" }, executed_at: NOW() }));
const DEFECT = () => [...failures("development-vessel:widget-step", "empty_body", 3), ...failures("development-vessel:gadget-step", "timeout", 3)];

interface World { traces: unknown[]; tracesStatus?: number; store: Row[] }
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
    if (url.includes("/v2/activities/templates")) return Response.json({ templates: [] });
    if (url.endsWith("/v2/impulses/resolve")) {
      const pointer = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
      if (pointer.type === "substrateGap_write") {
        writes.push(pointer.gap);
        world.store = [...world.store.filter((g) => g["id"] !== pointer.gap.id), pointer.gap];
        return Response.json({ shape: "substrateGapWriteResult", body: { action: "created" } });
      }
      if (pointer.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: world.store } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedGapStore === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedGapStore;
});

/** Run the scan as its tick does (emitting) over the defect world, and return the row it filed for CLASS. */
async function filedRow(): Promise<Row> {
  world = { traces: DEFECT(), store: [] };
  await resolveDetectorCoverageScan({ type: SHAPE, ...PARAMS });
  const row = writes.find((g) => g["id"] === `detector-coverage-gap-${CLASS}`);
  expect(row).toBeDefined();
  return row as Row;
}
/** The judge's verdict on the armed check, the check resolved against this resolver (as SELF_RESOLVE_ENDPOINT does). */
async function judge(er: Row): Promise<string> {
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const pointer = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
    return Response.json(await resolveDetectorCoverageScan(pointer));
  }) as unknown as typeof fetch;
  return evaluateGapCheck({ id: `detector-coverage-gap-${CLASS}`, status: "open", classification_metadata: { evidence_resolve: er } }, { fetchImpl });
}

describe("MUST-FAIL: a row the coverage scan files is armed from its own reading", () => {
  it("MUST-FAIL: the filed row carries a detector_reading the core turns into a class2 check scoped to its class", async () => {
    const row = await filedRow();
    expect(row["source"]).toBe("substrate_detected");
    const verdict = detectorBirthContract(row, VOCAB as never);
    expect(verdict && "evidence_resolve" in verdict ? verdict.evidence_resolve : verdict).toEqual({
      shape: SHAPE,
      input: { gap_class: CLASS, ...PARAMS, emit_gap: false },
      zero_field: "uncovered_clusters",
    });
  });

  it("MUST-FAIL: the judge measures the armed check on this class alone, not covered by its own row, files nothing, and reads an unread store as unknown", async () => {
    const row = await filedRow();
    const verdict = detectorBirthContract(row, VOCAB as never);
    const er = verdict && "evidence_resolve" in verdict ? verdict.evidence_resolve : undefined;
    expect(er).toBeDefined();
    // the store now holds the filed rows, which cite the class's own traces: that is the filing, not coverage
    expect(world.store.map((g) => g["id"]).sort()).toEqual([`detector-coverage-gap-${CLASS}`, `detector-coverage-gap-${OTHER}`]);
    writes = [];
    expect(await judge(er as Row)).toBe("present");
    // a detector now files rows citing this class's traces; the other class is still uncovered, and is not this row's defect
    world.store = [...world.store, { id: "detect-empty-body-finding", status: "open", category: "systematic_failure", classification_metadata: { failure_examples: ["empty_body-0", "empty_body-1", "empty_body-2"] } }];
    expect(await judge(er as Row)).toBe("absent");
    // the class stopped recurring (below the filing minimum), with no detector covering it
    world = { traces: [...failures("development-vessel:widget-step", "empty_body", 2), ...failures("development-vessel:gadget-step", "timeout", 3)], store: [row] };
    expect(await judge(er as Row)).toBe("absent");
    // the trace store could not be read: not a measurement, never the defect gone
    world = { traces: [], tracesStatus: 503, store: [row] };
    expect(await judge(er as Row)).toBe("unknown");
    // a check never files a row
    expect(writes).toEqual([]);
  });
});

describe("CONTROL: a row with no usable reading is still reported unarmable (no reading is invented)", () => {
  it("CONTROL: the filed row with its reading removed names detector_row_unarmable_no_reading", async () => {
    const row = await filedRow();
    const meta = { ...((row["classification_metadata"] ?? {}) as Row) };
    delete meta["detector_reading"];
    const verdict = detectorBirthContract({ ...row, classification_metadata: meta }, VOCAB as never);
    expect(verdict && "rule" in verdict ? verdict.rule : verdict).toBe(DETECTOR_ROW_REFUSAL.no_reading);
  });

  it("CONTROL: a reading with no number, or over an unadvertised shape, names detector_row_unarmable_reading_unusable", async () => {
    const row = await filedRow();
    const meta = (row["classification_metadata"] ?? {}) as Row;
    const notANumber = detectorBirthContract({ ...row, classification_metadata: { ...meta, detector_reading: { shape: SHAPE, field: "uncovered_clusters", value: "several" } } }, VOCAB as never);
    expect(notANumber && "rule" in notANumber ? notANumber.rule : notANumber).toBe(DETECTOR_ROW_REFUSAL.reading_unusable);
    const unadvertised = detectorBirthContract({ ...row, classification_metadata: { ...meta, detector_reading: { shape: SHAPE, field: "uncovered_clusters", value: 1 } } }, UNADVERTISED as never);
    expect(unadvertised && "rule" in unadvertised ? unadvertised.rule : unadvertised).toBe(DETECTOR_ROW_REFUSAL.reading_unusable);
  });
});
