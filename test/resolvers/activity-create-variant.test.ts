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

  it("returns variant_created shape on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "activity:new-variant" }), { status: 200 })) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("variant_created");
    const body = result.body as { variantId: string; accepted: boolean };
    expect(body.variantId).toBe("activity:new-variant");
    expect(body.accepted).toBe(true);
  });

  it("returns structuredError on 403 without throwing, with admin-scope note", async () => {
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
});
