import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityCreateVariant } from "../../src/resolvers/activity-create-variant.js";

const originalFetch = globalThis.fetch;

function makeFetch(templateResponse: Response, traceResponse?: Response) {
  let callCount = 0;
  return (async (url: string) => {
    callCount++;
    if (String(url).includes("/v2/activities/execution-traces")) {
      return traceResponse ?? new Response("{}", { status: 201 });
    }
    return templateResponse;
  }) as unknown as typeof fetch;
}

describe("activity-create-variant resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns activityRegistryChange shape on success", async () => {
    globalThis.fetch = makeFetch(
      new Response(JSON.stringify({ id: "activity:new-variant" }), { status: 200 }),
    );
    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("activityRegistryChange");
    const body = result.body as { variantId: string; accepted: boolean };
    expect(body.variantId).toBe("activity:new-variant");
    expect(body.accepted).toBe(true);
  });

  it("posts a synthetic trace to activity-api on success", async () => {
    const traceCalls: string[] = [];
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v2/activities/execution-traces")) {
        traceCalls.push(urlStr);
        const body = JSON.parse(String(opts?.body ?? "{}")) as { output_shapes?: string[] };
        expect(body.output_shapes).toContain("activityRegistryChange");
        expect(body.output_shapes).toContain("variant_created");
        return new Response("{}", { status: 201 });
      }
      return new Response(JSON.stringify({ id: "v:ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(traceCalls.length).toBe(1);
  });

  it("does NOT post a trace on failure — returns structuredError on 403", async () => {
    const traceCalls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/v2/activities/execution-traces")) {
        traceCalls.push(String(url));
        return new Response("{}", { status: 201 });
      }
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(403);
    expect(typeof body.adminNote).toBe("string");
    // No trace posted on failure
    expect(traceCalls.length).toBe(0);
  });

  it("returns structuredError on other 4xx without an admin note", async () => {
    globalThis.fetch = makeFetch(new Response("bad request", { status: 400 }));
    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { status: number; adminNote?: string };
    expect(body.status).toBe(400);
    expect(body.adminNote).toBeUndefined();
  });

  it("does not throw when the trace POST fails — variant creation still succeeds", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/v2/activities/execution-traces")) {
        throw new Error("network error");
      }
      return new Response(JSON.stringify({ id: "v:ok2" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveActivityCreateVariant({
      type: "activity_create_variant",
      template: { id: "test:t1", name: "t1", tasks: [] },
    });
    expect(result.shape).toBe("activityRegistryChange");
    const body = result.body as { variantId: string };
    expect(body.variantId).toBe("v:ok2");
  });
});
