import { describe, it, expect, afterEach } from "bun:test";
import { resolveCreditVesselShapes } from "../../src/resolvers/credit-vessel-shapes.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("credit_vessel_shapes", () => {
  it("errors when required fields are missing", async () => {
    const r = await resolveCreditVesselShapes({
      type: "credit_vessel_shapes",
      vesselId: "",
      shapes: [],
      activityVariantId: "",
      apiKey: "k",
    });
    expect(r.shape).toBe("vesselShapeCreditResult");
    expect((r.body as { credited: number }).credited).toBe(0);
    expect((r.body as { error?: string }).error).toContain("required");
  });

  it("errors on missing api key", async () => {
    const r = await resolveCreditVesselShapes({
      type: "credit_vessel_shapes",
      vesselId: "v1",
      shapes: ["s:a"],
      activityVariantId: "av1",
      apiKey: "",
    });
    expect((r.body as { error?: string }).error).toBe("missing_api_key");
  });

  it("POSTs one impulse-relevance record per shape with the reward-edge body", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await resolveCreditVesselShapes({
      type: "credit_vessel_shapes",
      metabobEndpoint: "http://api",
      apiKey: "k",
      vesselId: "obsidian-vessel-devbob",
      shapes: ["obsidian:note", "obsidian:search"],
      activityVariantId: "development-vessel:characterize-arrived-vessel",
      outcome: "success",
    });

    const body = r.body as { credited: number; errors: number; replay_weight: number };
    expect(body.credited).toBe(2);
    expect(body.errors).toBe(0);
    expect(body.replay_weight).toBe(0.5);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/v2/activities/impulse-relevance");
    expect(calls[0]!.body["impulse_id"]).toBe("vessel:obsidian-vessel-devbob:obsidian:note");
    expect(calls[0]!.body["was_loaded"]).toBe(true);
    expect(calls[0]!.body["execution_succeeded"]).toBe(true);
    expect(calls[0]!.body["source"]).toBe("vessel_arrival_characterization");
  });

  it("counts HTTP failures without throwing", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await resolveCreditVesselShapes({
      type: "credit_vessel_shapes",
      apiKey: "k",
      vesselId: "v",
      shapes: ["s:a"],
      activityVariantId: "av",
    });
    const body = r.body as { credited: number; errors: number };
    expect(body.credited).toBe(0);
    expect(body.errors).toBe(1);
  });
});
