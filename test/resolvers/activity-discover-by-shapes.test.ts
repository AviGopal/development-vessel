import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityDiscoverByShapes } from "../../src/resolvers/activity-discover-by-shapes.js";

const originalFetch = globalThis.fetch;

describe("activity-discover-by-shapes resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns discovered_activities with emergence_class=reuse when activities found", async () => {
    const fakeActivity = {
      variant_id: "v:abc",
      variant_name: "detect-issues",
      output_schema: { produces_shapes: ["codeQualityReport"] },
      input_schema: { required_shapes: ["sourceCode"] },
      tags: ["quality"],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ activities: [fakeActivity] }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: ["codeQualityReport"],
    });
    expect(result.shape).toBe("discovered_activities");
    const body = result.body as {
      emergence_class: string;
      matched: boolean;
      first_id: string;
      activities: unknown[];
    };
    expect(body.emergence_class).toBe("reuse");
    expect(body.matched).toBe(true);
    expect(body.first_id).toBe("v:abc");
    expect(body.activities).toHaveLength(1);
  });

  it("normalises output_schema.produces_shapes into output_shapes", async () => {
    const fakeActivity = {
      variant_id: "v:xyz",
      output_schema: { produces_shapes: ["shapeFoo", "shapeBar"] },
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ activities: [fakeActivity] }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: ["shapeFoo"],
    });
    const body = result.body as { activities: Array<{ output_shapes: string[] }> };
    expect(body.activities[0]?.output_shapes).toEqual(["shapeFoo", "shapeBar"]);
  });

  it("accepts required_shapes as a JSON-encoded string", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ activities: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: '["executionTrace"]',
    });
    expect(capturedBody).not.toBeNull();
    const sent = JSON.parse(capturedBody!) as { required_shapes: string[] };
    expect(sent.required_shapes).toEqual(["executionTrace"]);
  });

  it("returns emergence_class=gap and matched=false when no activities found", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ activities: [] }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: ["unknownShape"],
    });
    const body = result.body as { emergence_class: string; matched: boolean; first_id: null };
    expect(body.emergence_class).toBe("gap");
    expect(body.matched).toBe(false);
    expect(body.first_id).toBeNull();
  });

  it("returns empty result without calling API when required_shapes is empty", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;

    const result = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: [],
    });
    expect(called).toBe(false);
    const body = result.body as { emergence_class: string; total: number };
    expect(body.emergence_class).toBe("gap");
    expect(body.total).toBe(0);
  });

  it("returns structuredError on non-200 without throwing", async () => {
    globalThis.fetch = (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;

    const result = await resolveActivityDiscoverByShapes({
      type: "activity_discover_by_shapes",
      required_shapes: ["someShape"],
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { resolver: string; status: number };
    expect(body.resolver).toBe("activity_discover_by_shapes");
    expect(body.status).toBe(500);
  });
});
