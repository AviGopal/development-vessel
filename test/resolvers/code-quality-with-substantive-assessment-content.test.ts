import { describe, it, expect, afterEach } from "bun:test";
import { resolveCodeQualityWithSubstantiveAssessmentContent } from "../../src/resolvers/code-quality-with-substantive-assessment-content.js";

const SHAPE = "code_quality with substantive assessment content";

// The first two cases below point at a non-existent vesselRoot, so fs_list fails fast and they
// return early — they were never the problem. The third passed NO vesselRoot, so it fell back to
// the real clock-vessel path and did the whole job for real: list, read every file, then an LLM
// call with a 30s timeout, against bun's 5s test timeout. It failed as a timeout, and it asserted
// only that the shape string was right — which the early-return error paths satisfy too.
//
// Stubbed, the resolver's three distinct outcomes become separable: a real assessment, "listing
// failed", and "no source files found". Those read very differently to a consumer and previously
// nothing told them apart.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Route by impulse type: fs_list -> paths, fs_read -> content, llm_completion_dispatch -> text. */
const serve = (opts: { paths?: string[]; content?: string; completion?: string }): void => {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const t = JSON.parse(String(init?.body ?? "{}"));
    if (t.type === "fs_list") return json({ body: { paths: opts.paths ?? [] } });
    if (t.type === "fs_read") return json({ body: { content: opts.content ?? "export const x = 1;\n" } });
    if (t.type === "llm_completion_dispatch") return json({ body: { completion: opts.completion ?? "Overall quality: 7/10." } });
    return json({ body: {} });
  }) as unknown as typeof fetch;
};

describe("resolveCodeQualityWithSubstantiveAssessmentContent", () => {
  it("returns the correct shape even when vessel root is missing", async () => {
    globalThis.fetch = (async () => { throw new Error("ENOENT"); }) as unknown as typeof fetch;
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: SHAPE,
      vesselRoot: "/tmp/nonexistent-clock-vessel-test-path-xyz",
    });
    expect(result.shape).toBe(SHAPE);
    const body = result.body as Record<string, unknown>;
    expect(typeof body["assessment"]).toBe("string");
    expect((body["assessment"] as string).length).toBeGreaterThan(0);
    // the assessment field carries the REASON, not a bare empty string
    expect(body["assessment"] as string).toContain("Failed to list");
  });

  it("body always contains assessment and files_analyzed fields", async () => {
    globalThis.fetch = (async () => { throw new Error("ENOENT"); }) as unknown as typeof fetch;
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: SHAPE,
      vesselRoot: "/tmp/nonexistent-clock-vessel-test-path-abc",
    });
    const body = result.body as Record<string, unknown>;
    expect("assessment" in body).toBe(true);
    expect("files_analyzed" in body).toBe(true);
    expect(typeof body["files_analyzed"]).toBe("number");
  });

  it("produces the LLM assessment and counts the files it analysed", async () => {
    serve({
      paths: [
        "/w/clock-vessel/src/index.ts",
        "/w/clock-vessel/src/tick.ts",
        "/w/clock-vessel/src/types.d.ts",          // excluded: .d.ts
        "/w/clock-vessel/node_modules/dep/i.ts",   // excluded: node_modules
        "/w/clock-vessel/README.md",               // excluded: not .ts
      ],
      completion: "Overall quality: 8/10. Cohesion is good.",
    });
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: SHAPE,
      vesselRoot: "/w/clock-vessel",
    });
    expect(result.shape).toBe(SHAPE);
    const body = result.body as Record<string, unknown>;
    expect(body["assessment"]).toContain("8/10");
    // only the two real .ts sources survive the filter
    expect(body["files_analyzed"]).toBe(2);
  });

  it("says so when the vessel has no TypeScript sources, rather than assessing nothing", async () => {
    serve({ paths: ["/w/clock-vessel/README.md"] });
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: SHAPE,
      vesselRoot: "/w/clock-vessel",
    });
    expect(result.shape).toBe(SHAPE);
    const body = result.body as Record<string, unknown>;
    expect(body["assessment"] as string).toContain("No TypeScript source files");
    expect(body["files_analyzed"]).toBe(0);
  });
});
