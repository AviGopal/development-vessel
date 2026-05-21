import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveVesselRegisterPassthrough } from "../../src/resolvers/vessel-register-passthrough.js";

const originalFetch = globalThis.fetch;

describe("vessel-register-passthrough resolver", () => {
  beforeAll(() => {
    process.env["DISCOVERY_ENDPOINT"] = "https://discovery.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards the registration payload and returns vessel_registered shape", async () => {
    let captured: unknown;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ registered: true, vessel_id: "test-vessel" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveVesselRegisterPassthrough({
      type: "vessel_register_passthrough",
      registration: {
        shapes: ["git_status"],
        resolve_endpoint: "/v2/impulses/resolve",
        endpoint: "http://dev-vessel:8090",
      },
    });

    expect(result.shape).toBe("vessel_registered");
    const body = result.body as { registered: boolean };
    expect(body.registered).toBe(true);
    expect((captured as { shapes: string[] }).shapes).toContain("git_status");
  });

  it("throws on HTTP error from discovery", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(
      resolveVesselRegisterPassthrough({
        type: "vessel_register_passthrough",
        registration: { shapes: [], resolve_endpoint: "/v2/impulses/resolve" },
      }),
    ).rejects.toThrow("401");
  });
});
