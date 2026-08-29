import { describe, it, expect, mock, beforeEach, afterAll} from "bun:test";

// Mock fetch globally before importing the resolver
const mockFetch = mock(async (url: string, opts?: RequestInit): Promise<Response> => {
  const body = opts?.body as string | undefined;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const type = parsed["type"] as string | undefined;

  if (type === "fs_read") {
    return new Response(
      JSON.stringify({
        shape: "fs_read",
        body: {
          content:
            `export const VESSEL_ID = process.env["VESSEL_ID"] ?? "clock-vessel";\n` +
            `export const PORT = parseInt(process.env["PORT"] ?? "8070", 10);\n` +
            `export const HOST = process.env["HOST"] ?? "0.0.0.0";\n` +
            `// The tick interval in milliseconds\n` +
            `export const TICK_INTERVAL_MS = parseInt(process.env["TICK_INTERVAL_MS"] ?? "60000", 10);\n`,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (type === "concept_search_by_source") {
    return new Response(
      JSON.stringify({
        shape: "concept_search_by_source",
        body: {
          concepts: [
            { id: "concept_abc", title: "clock-vessel config" },
            { id: "concept_def", title: "tick interval" },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (type === "git_log") {
    return new Response(
      JSON.stringify({
        shape: "git_log",
        body: {
          commits: [
            { hash: "abc123", date: "2026-07-01T00:00:00Z", message: "update config" },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ shape: "unknown", body: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// Module-scope install (required so the resolver imports against the mock) with no hook
// to take it back down — so without this afterAll it leaks into every suite bun runs
// afterwards. A leaked mock answers instantly with a canned 200, which turns any later
// test that needs a REAL network failure into a false pass and a red assertion.
// Reproduced: `bun test assessment-summary.test.ts discovery-vessel-registry-observer.test.ts`
// fails 2, while the victim alone passes 3/0.
const ORIGINAL_FETCH = globalThis.fetch;
globalThis.fetch = mockFetch as unknown as typeof fetch;
afterAll(() => { globalThis.fetch = ORIGINAL_FETCH; });

import { resolveAssessmentSummary } from "../../src/resolvers/assessment-summary.js";

describe("resolveAssessmentSummary", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it("returns shape=assessment_summary", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    expect(result.shape).toBe("assessment_summary");
  });

  it("body contains overall_score and grade", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    expect(typeof body["overall_score"]).toBe("number");
    expect(["A", "B", "C", "D", "F"]).toContain(body["grade"] as string);
  });

  it("body contains metrics with sub-scores", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    const metrics = body["metrics"] as Record<string, unknown>;
    expect(metrics).toBeDefined();
    expect(typeof (metrics["type_annotations"] as Record<string, unknown>)["score"]).toBe("number");
    expect(typeof (metrics["naming_conventions"] as Record<string, unknown>)["score"]).toBe("number");
    expect(typeof (metrics["documentation"] as Record<string, unknown>)["score"]).toBe("number");
    expect(typeof (metrics["module_size"] as Record<string, unknown>)["score"]).toBe("number");
  });

  it("body contains structural analysis", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    const structural = body["structural"] as Record<string, unknown>;
    expect(structural).toBeDefined();
    expect(typeof structural["export_count"]).toBe("number");
    expect(typeof structural["line_count"]).toBe("number");
  });

  it("body contains provenance with concept data", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    const provenance = body["provenance"] as Record<string, unknown>;
    expect(provenance).toBeDefined();
    expect(typeof provenance["concept_count"]).toBe("number");
    expect(Array.isArray(provenance["concept_sample"])).toBe(true);
  });

  it("issues is an array", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["issues"])).toBe(true);
  });

  it("summary string is non-empty", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    expect(typeof body["summary"]).toBe("string");
    expect((body["summary"] as string).length).toBeGreaterThan(0);
  });

  it("respects custom target_file pointer field", async () => {
    const result = await resolveAssessmentSummary({
      type: "assessment_summary",
      target_file: "/tmp/custom-config.ts",
    });
    const body = result.body as Record<string, unknown>;
    expect(body["target_file"]).toBe("/tmp/custom-config.ts");
  });

  it("overall_score is in range 0-100", async () => {
    const result = await resolveAssessmentSummary({ type: "assessment_summary" });
    const body = result.body as Record<string, unknown>;
    const score = body["overall_score"] as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
