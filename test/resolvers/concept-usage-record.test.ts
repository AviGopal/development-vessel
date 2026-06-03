import { describe, it, expect, afterEach } from "bun:test";
import { resolveConceptUsageRecord } from "../../src/resolvers/concept-usage-record.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("concept_usage_record", () => {
  it("POSTs to /concepts/:id/usage with trace_id + outcome", async () => {
    let postedUrl = "";
    let postedBody: any = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      postedUrl = typeof input === "string" ? input : input.toString();
      postedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: "concept_usage:usage_abc",
          concept_id: "concept:concept_xyz",
          trace_id: "exec_test",
          outcome: "success",
          recorded_at: "2026-06-03T05:00:00Z",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "concept:concept_xyz",
      trace_id: "exec_test",
      outcome: "success",
      conceptDbUrl: "http://test/concepts",
    });

    expect(r.shape).toBe("conceptUsageRecorded");
    const body = r.body as any;
    expect(body.concept_id).toBe("concept:concept_xyz");
    expect(body.trace_id).toBe("exec_test");
    expect(body.outcome).toBe("success");
    expect(body.usage_record_id).toBe("concept_usage:usage_abc");

    expect(postedUrl).toBe("http://test/concepts/concept%3Aconcept_xyz/usage");
    expect(postedBody.trace_id).toBe("exec_test");
    expect(postedBody.outcome).toBe("success");
  });

  it("includes weight when provided", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_: any, init?: any) => {
      postedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "u1" }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "c",
      trace_id: "t",
      outcome: "success",
      weight: 0.75,
    });
    expect(postedBody.weight).toBe(0.75);
  });

  it("returns structuredError on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("missing concept", { status: 404 })) as unknown as typeof fetch;
    const r = await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "c",
      trace_id: "t",
      outcome: "success",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("returns structuredError on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const r = await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "c",
      trace_id: "t",
      outcome: "failure",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("URL-encodes concept_id properly (handles colon in id)", async () => {
    let postedUrl = "";
    globalThis.fetch = (async (input: any) => {
      postedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ id: "u" }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "concept:concept_with:colons",
      trace_id: "t",
      outcome: "success",
      conceptDbUrl: "http://t/c",
    });
    expect(postedUrl).toContain("concept%3Aconcept_with%3Acolons");
  });
});
