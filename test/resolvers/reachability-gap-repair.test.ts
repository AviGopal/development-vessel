import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveReachabilityGapRepair } from "../../src/resolvers/reachability-gap-repair.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;

const GAP = {
  id: "reach-gap-widget-report",
  category: "unreachable_producer",
  status: "open",
  classification_metadata: {
    kind: "reachability_gap",
    unreachable_shape: "widgetReport",
    unreachable_producer_id: "development-vessel:make-widget-report",
    producer_required_inputs: ["rawWidgetTrace"],
  },
};

const PRODUCER_TEMPLATE = {
  id: "make-widget-report",
  name: "make-widget-report",
  input_shapes: ["rawWidgetTrace"],
  optional_input_shapes: [],
  output_shapes: ["widgetReport"],
  tasks: [{ id: "make", description: "make the report", resolver: "widget_reporter" }],
};

function scriptFetch(opts: {
  gapBody?: unknown;
  templateBody?: unknown;
  producerFor?: (shape: string) => boolean;
  onUpdate?: (body: unknown) => void;
  updateStatus?: number;
}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes("/v2/activities/templates/")) {
      return new Response(JSON.stringify(opts.templateBody ?? PRODUCER_TEMPLATE), { status: 200 });
    }
    if (url.includes("/v2/activities/discover-by-shapes")) {
      const shape = body?.required_shapes?.[0];
      const has = opts.producerFor ? opts.producerFor(shape) : true;
      return new Response(
        JSON.stringify({ activities: has ? [{ id: `producer-of-${shape}` }] : [] }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/impulses/resolve")) {
      // reachability_gap_repair calling itself never happens; this branch is
      // activityTemplate_update via the raw pointer POST.
      if (body?.pointer?.type === "activityTemplate_update") {
        opts.onUpdate?.(body.pointer);
        return new Response("ok", { status: opts.updateStatus ?? 200 });
      }
      return new Response("unexpected pointer", { status: 500 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("reachability-gap-repair resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns UNFAVORABLE when no producer id is supplied and no gap_id given", async () => {
    globalThis.fetch = scriptFetch({});
    const result = await resolveReachabilityGapRepair({ type: "reachability_gap_repair" });
    const body = result.body as Record<string, unknown>;
    expect(result.shape).toBe("reachabilityGapRepairReport");
    expect(body["verdict"]).toBe("UNFAVORABLE");
    expect(String(body["error"])).toContain("unreachable_producer_id required");
  });

  it("classifies gating_input_infeasible and mutates via activityTemplate_update", async () => {
    let updateBody: Record<string, unknown> | undefined;
    globalThis.fetch = scriptFetch({
      producerFor: (shape) => shape !== "rawWidgetTrace", // the gating input has NO producer
      onUpdate: (b) => { updateBody = b as Record<string, unknown>; },
    });

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      unreachable_producer_id: "development-vessel:make-widget-report",
      producer_required_inputs: ["rawWidgetTrace"],
    });
    const body = result.body as Record<string, unknown>;
    expect(result.shape).toBe("reachabilityGapRepairReport");
    expect(body["verdict"]).toBe("FAVORABLE");
    expect(body["classification"]).toBe("gating_input_infeasible");
    expect(body["infeasible_inputs"]).toEqual(["rawWidgetTrace"]);
    expect(body["updated_input_shapes"]).toEqual([]);
    expect(body["updated_optional_input_shapes"]).toEqual(["rawWidgetTrace"]);

    expect(updateBody).toBeDefined();
    expect(updateBody!["templateId"]).toBe("development-vessel:make-widget-report");
    const updates = updateBody!["updates"] as Record<string, unknown>;
    expect(updates["input_shapes"]).toEqual([]);
    expect(updates["optional_input_shapes"]).toEqual(["rawWidgetTrace"]);
    const evidence = updateBody!["evidence"] as Record<string, unknown>;
    expect(String(evidence["reason"])).toContain("rawWidgetTrace");
  });

  it("classifies chain_reachable and makes no mutation when every input has a producer", async () => {
    let updateCalls = 0;
    globalThis.fetch = scriptFetch({
      producerFor: () => true,
      onUpdate: () => { updateCalls += 1; },
    });

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      unreachable_producer_id: "make-widget-report",
      producer_required_inputs: ["rawWidgetTrace"],
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("NOT_APPLICABLE");
    expect(body["classification"]).toBe("chain_reachable");
    expect(updateCalls).toBe(0);
  });

  it("refuses a bulk clear when ALL of a many-input producer's inputs are infeasible", async () => {
    let updateCalls = 0;
    const scalarTemplate = {
      ...PRODUCER_TEMPLATE,
      input_shapes: ["path", "oldString", "newString", "cwd", "message"],
    };
    globalThis.fetch = scriptFetch({
      templateBody: scalarTemplate,
      producerFor: () => false, // none of the 5 scalar params has a producer
      onUpdate: () => { updateCalls += 1; },
    });

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      unreachable_producer_id: "add-resolver-to-vessel",
      producer_required_inputs: ["path", "oldString", "newString", "cwd", "message"],
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("NOT_APPLICABLE");
    expect(body["classification"]).toBe("bulk_clear_refused");
    expect(updateCalls).toBe(0);
  });

  it("dry_run classifies + proposes without calling activityTemplate_update", async () => {
    let updateCalls = 0;
    globalThis.fetch = scriptFetch({
      producerFor: (shape) => shape !== "rawWidgetTrace",
      onUpdate: () => { updateCalls += 1; },
    });

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      unreachable_producer_id: "make-widget-report",
      producer_required_inputs: ["rawWidgetTrace"],
      dry_run: true,
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("FAVORABLE");
    expect(body["proposed_optional_input_shapes"]).toEqual(["rawWidgetTrace"]);
    expect(updateCalls).toBe(0);
  });

  it("reads producer id + required inputs from a gap_id when no direct override is given", async () => {
    const base = join(tmpdir(), `reachability-gap-repair-test-${Date.now()}`);
    mkdirSync(join(base, "gaps"), { recursive: true });
    writeFileSync(join(base, "gaps", "gaps.json"), JSON.stringify([GAP]));
    process.env["WORKSPACE_ROOT"] = base;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.includes("/v2/activities/templates/")) return new Response(JSON.stringify(PRODUCER_TEMPLATE), { status: 200 });
      if (url.includes("/v2/activities/discover-by-shapes")) {
        const shape = body?.required_shapes?.[0];
        return new Response(JSON.stringify({ activities: shape === "rawWidgetTrace" ? [] : [{ id: "x" }] }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      gap_id: "reach-gap-widget-report",
      dry_run: true,
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("FAVORABLE");
    expect(body["gap_id"]).toBe("reach-gap-widget-report");
    expect(body["producer_id"]).toBe("development-vessel:make-widget-report");
    expect(body["proposed_optional_input_shapes"]).toEqual(["rawWidgetTrace"]);
    delete process.env["WORKSPACE_ROOT"];
  });

  it("returns UNFAVORABLE when the producer template cannot be fetched", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/v2/activities/templates/")) return new Response("not found", { status: 404 });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await resolveReachabilityGapRepair({
      type: "reachability_gap_repair",
      unreachable_producer_id: "no-such-template",
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("UNFAVORABLE");
    expect(String(body["error"])).toContain("template not found");
  });
});
