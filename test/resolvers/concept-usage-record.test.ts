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

// 2026-06-18: defensive placeholder hygiene. Some executor paths (notably
// light-dispatch) dispatch this resolver without binding the template variables,
// leaking `{{concept_id}}` / `{{trace_id}}` literals that pollute concept-db
// usage attribution and defeat per-trace dedup.
describe("concept_usage_record placeholder hygiene", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("skips the write when concept_id is an unsubstituted placeholder", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "{{extract_concept_id_value}}",
      trace_id: "autonomous_backfill_2026-06-18T00:00:00.000Z",
      outcome: "success",
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as any).detail).toContain("concept_id");
    expect(called).toBe(false);
  });

  it("synthesizes a unique trace_id when the placeholder leaks, and still records", async () => {
    let sentBody: any = {};
    globalThis.fetch = (async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "usage:1", recorded_at: "2026-06-18T00:00:00Z" }));
    }) as unknown as typeof fetch;
    const r = await resolveConceptUsageRecord({
      type: "concept_usage_record",
      concept_id: "concept_real_id",
      trace_id: "{{trace_id}}",
      outcome: "success",
    });
    expect(r.shape).toBe("conceptUsageRecorded");
    expect(String(sentBody.trace_id)).not.toBe("{{trace_id}}");
    expect(String(sentBody.trace_id)).toContain("autonomous_backfill_");
  });

  it("passes a real trace_id through unchanged", async () => {
    let sentBody: any = {};
    globalThis.fetch = (async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "usage:2" }));
    }) as unknown as typeof fetch;
    await resolveConceptUsageRecord({
      type: "concept_usage_record", concept_id: "concept_x", trace_id: "real-trace-99", outcome: "success",
    });
    expect(sentBody.trace_id).toBe("real-trace-99");
  });
});
