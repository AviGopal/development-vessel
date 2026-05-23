import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveReachableUnlearnedReport } from "../../src/resolvers/reachable-unlearned-report.js";

const originalFetch = globalThis.fetch;

const TEMPLATES = [
  { id: "t:a", output_shapes: ["shapeX", "shapeY"], thompson_alpha: 3 },
  { id: "t:b", output_shapes: ["shapeZ"], thompson_alpha: 1 },
];

// shapeX is learned (in a trace), shapeY and shapeZ are not
const TRACES_WITH_X = [{ output_shapes: ["shapeX"] }];

function makeFetch(templates = TEMPLATES, traces = TRACES_WITH_X) {
  return (async (url: string) => {
    if (String(url).includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates, total: templates.length }), { status: 200 });
    }
    if (String(url).includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("reachable-unlearned-report resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns reachableButUnlearnedReport shape", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(result.shape).toBe("reachableButUnlearnedReport");
  });

  it("excludes shapes that have traces", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: Array<{ shape: string }> };
    const shapes = body.entries.map(e => e.shape);
    expect(shapes).not.toContain("shapeX");
    expect(shapes).toContain("shapeY");
    expect(shapes).toContain("shapeZ");
  });

  it("total matches entries length", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: unknown[]; total: number };
    expect(body.total).toBe(body.entries.length);
  });

  it("entries include best_template_id", async () => {
    globalThis.fetch = makeFetch();
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { entries: Array<{ shape: string; best_template_id: string }> };
    const shapeY = body.entries.find(e => e.shape === "shapeY");
    expect(shapeY?.best_template_id).toBe("t:a");
  });

  it("returns empty entries when all shapes are learned", async () => {
    const allLearned = [{ output_shapes: ["shapeX", "shapeY", "shapeZ"] }];
    globalThis.fetch = makeFetch(TEMPLATES, allLearned);
    const result = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    const body = result.body as { total: number };
    expect(body.total).toBe(0);
  });
});
