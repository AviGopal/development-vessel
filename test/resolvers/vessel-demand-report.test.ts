import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselDemandReport } from "../../src/resolvers/vessel-demand-report.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedFetch(map: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const prefix of Object.keys(map)) {
      if (url.startsWith(prefix)) return map[prefix]!(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("vessel_demand_report", () => {
  it("flags shapes required by >= min templates with zero supply", async () => {
    globalThis.fetch = routedFetch({
      "http://templates/": () =>
        new Response(
          JSON.stringify({
            templates: [
              { id: "t1", inputShapes: ["needed_shape"] },
              { id: "t2", inputShapes: ["needed_shape"] },
              { id: "t3", inputShapes: ["needed_shape", "supplied"] },
            ],
          }),
          { status: 200 },
        ),
      "http://discovery/": () =>
        new Response(JSON.stringify({ shapes: ["supplied"] }), { status: 200 }),
      "http://dev-vessel/": () =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    });

    const r = await resolveVesselDemandReport({
      type: "vessel_demand_report",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
      devVesselImpulsesUrl: "http://dev-vessel/",
      minTemplates: 3,
    });
    expect(r.shape).toBe("vesselDemandReport");
    const body = r.body as any;
    expect(body.demand_entry_count).toBe(1);
    expect(body.top_priority.shape).toBe("needed_shape");
    expect(body.top_priority.template_count).toBe(3);
  });

  it("network failure returns structuredError gracefully", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await resolveVesselDemandReport({
      type: "vessel_demand_report",
      templatesUrl: "http://templates/",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("dry_run does not POST gaps", async () => {
    let postCalls = 0;
    globalThis.fetch = routedFetch({
      "http://templates/": () =>
        new Response(
          JSON.stringify({
            templates: [
              { id: "t1", inputShapes: ["x"] },
              { id: "t2", inputShapes: ["x"] },
              { id: "t3", inputShapes: ["x"] },
            ],
          }),
          { status: 200 },
        ),
      "http://discovery/": () =>
        new Response(JSON.stringify({ shapes: [] }), { status: 200 }),
      "http://dev-vessel/": () => {
        postCalls++;
        return new Response("ok", { status: 200 });
      },
    });
    const r = await resolveVesselDemandReport({
      type: "vessel_demand_report",
      templatesUrl: "http://templates/",
      discoveryShapesUrl: "http://discovery/",
      devVesselImpulsesUrl: "http://dev-vessel/",
      minTemplates: 3,
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.demand_entry_count).toBe(1);
    expect(postCalls).toBe(0);
  });
});
