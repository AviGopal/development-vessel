import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import * as mod from "../../src/resolvers/vessel-demand-report";

// vessel_demand_report builds gap_id as `vessel-demand-${shape}-${today}`, so one
// persisting condition opens a new row every day. The id must depend on the
// condition (shape) only.

const SHAPE_A = "widgetHealthReport";
const SHAPE_B = "gadgetUsageReport";

const realFetch = globalThis.fetch;

function makeTemplates(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const shape of [SHAPE_A, SHAPE_B]) {
    for (let i = 0; i < 6; i++) {
      const id = `check-tpl-${shape}-${i}`;
      out.push({
        id,
        template_id: id,
        templateId: id,
        name: id,
        input_shapes: [shape],
        inputShapes: [shape],
        input_impulse_shapes: [shape],
        tasks: [{ id: `t-${i}`, type: shape, input_shapes: [shape] }],
      });
    }
  }
  return out;
}

function fakeResponse(payload: unknown): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async (): Promise<unknown> => payload,
    text: async (): Promise<string> => JSON.stringify(payload),
  };
}

function installFetch(): void {
  const stub = async (input: unknown): Promise<unknown> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url ?? input);
    if (/\/shapes/.test(url)) return fakeResponse({ shapes: [] });
    const arr = makeTemplates();
    // Serve both an array and the common envelope keys, so whichever form the
    // resolver reads, it sees the same templates.
    const payload = Object.assign(arr, { templates: arr, items: arr, data: arr, activities: arr, results: arr });
    return fakeResponse(payload);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

const pointer = {
  type: "vessel_demand_report",
  dry_run: true,
  dryRun: true,
  min_templates: 1,
  minTemplates: 1,
  max_emits: 10,
  maxEmits: 10,
} as unknown as mod.VesselDemandReportPointer;

async function gapIdFor(shape: string, at: string): Promise<string | undefined> {
  setSystemTime(new Date(at));
  installFetch();
  const result = await mod.resolveVesselDemandReport(pointer);
  const body = result.body as { demand_entries?: Array<{ shape?: string; gap_id?: string }> };
  const entries = body.demand_entries ?? [];
  return entries.find((e) => e.shape === shape)?.gap_id;
}

describe("vessel_demand_report row id", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    setSystemTime();
  });
  test("MUST-FAIL: the same condition detected on two different days produces ONE row id", async () => {
    const day1 = await gapIdFor(SHAPE_A, "2026-11-04T10:00:00.000Z");
    const day2 = await gapIdFor(SHAPE_A, "2026-11-05T10:00:00.000Z");
    expect(typeof day1).toBe("string");
    expect(typeof day2).toBe("string");
    expect(day2).toBe(day1 as string);
  });

  test("CONTROL: two different conditions produce different row ids", async () => {
    setSystemTime(new Date("2026-11-04T10:00:00.000Z"));
    installFetch();
    const result = await mod.resolveVesselDemandReport(pointer);
    const body = result.body as { demand_entries?: Array<{ shape?: string; gap_id?: string }> };
    const entries = body.demand_entries ?? [];
    const a = entries.find((e) => e.shape === SHAPE_A)?.gap_id;
    const b = entries.find((e) => e.shape === SHAPE_B)?.gap_id;
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
    expect(a).not.toBe(b as string);
  });
});
