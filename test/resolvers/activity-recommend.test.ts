import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityRecommend } from "../../src/resolvers/activity-recommend.js";

const originalFetch = globalThis.fetch;

describe("activity-recommend resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activity_recommendations shape on 200 with recommendations array", async () => {
    const fakeRecs = [{ id: "t1", name: "template-one" }];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ recommendations: fakeRecs }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityRecommend({
      type: "activity_recommend",
      task_description: "detect code quality issues",
    });
    expect(result.shape).toBe("activity_recommendations");
    const body = result.body as { count: number; recommendations: unknown[] };
    expect(body.count).toBe(1);
    expect(body.recommendations).toEqual(fakeRecs);
  });

  it("falls back to activities key when recommendations is absent", async () => {
    const fakeRecs = [{ id: "t2" }];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ activities: fakeRecs }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityRecommend({
      type: "activity_recommend",
      task_description: "anything",
    });
    const body = result.body as { count: number };
    expect(body.count).toBe(1);
  });

  it("returns structuredError on non-200 without throwing", async () => {
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const result = await resolveActivityRecommend({
      type: "activity_recommend",
      task_description: "anything",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { resolver: string; status: number };
    expect(body.resolver).toBe("activity_recommend");
    expect(body.status).toBe(400);
  });

  it("returns empty recommendations array when count is zero", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ recommendations: [] }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityRecommend({
      type: "activity_recommend",
      task_description: "no match",
    });
    const body = result.body as { count: number; recommendations: unknown[] };
    expect(body.count).toBe(0);
    expect(body.recommendations).toEqual([]);
  });
});
