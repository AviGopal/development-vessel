import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityCreateVariant } from "../../src/resolvers/activity-create-variant.js";

const originalFetch = globalThis.fetch;

describe("activity-create-variant resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activityRegistryChange shape on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "activity:new-variant" }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    // activityRegistryChange signals minibob to include this in output_shapes when emitting
    // lifecycle:execution:succeeded, which triggers the registry-change observer.
    expect(result.shape).toBe("activityRegistryChange");
    const body = result.body as { variantId: string; accepted: boolean };
    expect(body.variantId).toBe("activity:new-variant");
    expect(body.accepted).toBe(true);
  });

  it("returns structuredError on 403 — NOT activityRegistryChange (no registry change occurred)", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(403);
    expect(typeof body.adminNote).toBe("string");
    expect(body.adminNote).toContain("admin");
  });

  it("returns structuredError on other 4xx without an admin note", async () => {
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(400);
    expect(body.adminNote).toBeUndefined();
  });

  it("strips and re-timestamps id when strip_id is set", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      postedBody = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "v:timestamped" }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:original", name: "t1", tasks: [] },
      strip_id: true,
    });
    expect(typeof postedBody?.["id"]).toBe("string");
    expect(String(postedBody?.["id"])).not.toBe("test:original");
    expect(String(postedBody?.["id"])).toMatch(/^test:original-\d+$/);
  });

  it("body carries variantId from API response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "v:my-id" }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t2", name: "t2", tasks: [] },
      parentTemplateId: "test:parent",
    });
    const body = result.body as { variantId: string; parentTemplateId?: string };
    expect(body.variantId).toBe("v:my-id");
    expect(body.parentTemplateId).toBe("test:parent");
  });
});
