import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityFetch } from "../../src/resolvers/activity-fetch.js";

const originalFetch = globalThis.fetch;

describe("activity-fetch resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activity_template shape on 200", async () => {
    const fakeTemplate = { id: "test:t1", name: "test", tasks: [] };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fakeTemplate), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityFetch({ type: "activity_fetch", templateId: "test:t1" });
    expect(result.shape).toBe("activity_template");
    expect((result.body as { id: string }).id).toBe("test:t1");
  });

  it("returns structuredError shape on 404 without throwing", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const result = await resolveActivityFetch({ type: "activity_fetch", templateId: "missing:t" });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { resolver: string; status: number };
    expect(body.resolver).toBe("activity_fetch");
    expect(body.status).toBe(404);
  });

  it("includes templateId in the structuredError body", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const result = await resolveActivityFetch({ type: "activity_fetch", templateId: "foo:bar" });
    const body = result.body as { templateId: string };
    expect(body.templateId).toBe("foo:bar");
  });
});
