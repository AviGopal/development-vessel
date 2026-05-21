import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolvePropagateJudgment } from "../../src/resolvers/propagate-judgment.js";

const originalFetch = globalThis.fetch;

const basePointer = {
  type: "propagate_judgment" as const,
  activity_variant_id: "activity:test-variant",
  impulse_id: "impulse:test",
  relevance_score: 0.8,
  source_tier: "human" as const,
};

describe("propagate-judgment resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends weight=1.0 for human tier", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolvePropagateJudgment({ ...basePointer, source_tier: "human" });
    expect((capturedBody as { weight: number }).weight).toBe(1.0);
  });

  it("sends weight=0.7 for verifier tier", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolvePropagateJudgment({ ...basePointer, source_tier: "verifier" });
    expect((capturedBody as { weight: number }).weight).toBe(0.7);
  });

  it("sends weight=0.4 for automatic tier", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolvePropagateJudgment({ ...basePointer, source_tier: "automatic" });
    expect((capturedBody as { weight: number }).weight).toBe(0.4);
  });

  it("returns judgmentPropagated with impulse_relevance_call_succeeded=false on 403", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const result = await resolvePropagateJudgment(basePointer);
    expect(result.shape).toBe("judgmentPropagated");
    const body = result.body as { impulse_relevance_call_succeeded: boolean; status: number };
    expect(body.impulse_relevance_call_succeeded).toBe(false);
    expect(body.status).toBe(403);
  });

  it("returns judgmentPropagated with impulse_relevance_call_succeeded=true on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ recorded: true }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolvePropagateJudgment(basePointer);
    const body = result.body as { impulse_relevance_call_succeeded: boolean };
    expect(body.impulse_relevance_call_succeeded).toBe(true);
  });
});
