import { describe, it, expect, afterAll } from "bun:test";
import { resolveCompositionCoverageReport } from "../../src/resolvers/composition-coverage-report.js";

const originalFetch = globalThis.fetch;

describe("composition-coverage-report resolver", () => {
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns composition_coverage_report carrying the fetched body on 200", async () => {
    const coverage = { covered: 3, total: 7 };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(coverage), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveCompositionCoverageReport({ type: "composition_coverage_report" });
    expect(result.shape).toBe("composition_coverage_report");
    expect(result.body).toEqual(coverage);
  });

  it("returns structuredError carrying the status on a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream exploded", { status: 503 })) as unknown as typeof fetch;

    const result = await resolveCompositionCoverageReport({ type: "composition_coverage_report" });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { message: string }).message).toContain("503");
    expect((result.body as { details: string }).details).toBe("upstream exploded");
  });
});
