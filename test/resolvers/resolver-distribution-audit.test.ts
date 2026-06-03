import { describe, it, expect, afterEach } from "bun:test";
import { resolveResolverDistributionAudit } from "../../src/resolvers/resolver-distribution-audit.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedFetch(routes: Array<{ match: string; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const r of routes) {
      if (url.includes(r.match)) {
        return new Response(JSON.stringify(r.body), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("resolver_distribution_audit", () => {
  it("flags shape_orphan when shapes advertised but never invoked", async () => {
    globalThis.fetch = routedFetch([
      { match: "/shapes", body: { shapes: ["unused_a", "unused_b", "used_c"] } },
      { match: "/templates", body: { templates: [{ id: "tpl", inputShapes: ["used_c"], outputShapes: [] }] } },
      { match: "execution-traces", body: { executions: [{ metadata: { template_id: "tpl" } }] } },
      { match: "concepts/search", body: { concepts: [] } },
    ]);
    const r = await resolveResolverDistributionAudit({
      type: "resolver_distribution_audit",
      dry_run: true,
    });
    expect(r.shape).toBe("resolverDistributionAudit");
    const body = r.body as any;
    expect(body.orphan_count).toBeGreaterThan(0);
    const orphan = body.findings.find((f: any) => f.subtype === "shape_orphan");
    expect(orphan).toBeTruthy();
  });

  it("flags demand_supply_mismatch when N templates need an unadvertised shape", async () => {
    globalThis.fetch = routedFetch([
      { match: "/shapes", body: { shapes: [] } },
      {
        match: "/templates",
        body: {
          templates: [
            { id: "tpl-a", inputShapes: ["needed_x"], outputShapes: [] },
            { id: "tpl-b", inputShapes: ["needed_x"], outputShapes: [] },
            { id: "tpl-c", inputShapes: ["needed_x"], outputShapes: [] },
          ],
        },
      },
      { match: "execution-traces", body: { executions: [] } },
      { match: "concepts/search", body: { concepts: [] } },
    ]);
    const r = await resolveResolverDistributionAudit({
      type: "resolver_distribution_audit",
      minDemandTemplates: 3,
      dry_run: true,
    });
    const body = r.body as any;
    const dsm = body.findings.find((f: any) => f.subtype === "demand_supply_mismatch");
    expect(dsm).toBeTruthy();
    expect(dsm.shape).toBe("needed_x");
  });

  it("flags responsibility_imbalance when a vessel advertises a forbidden shape", async () => {
    globalThis.fetch = routedFetch([
      {
        match: "/shapes",
        body: {
          template_search: [{ vessel_id: "goal-host-vessel-instance-1" }],
          other_shape: [{ vessel_id: "other-vessel" }],
        },
      },
      { match: "/templates", body: { templates: [] } },
      { match: "execution-traces", body: { executions: [] } },
      {
        match: "concepts/search",
        body: {
          concepts: [
            {
              id: "p",
              metadata: {
                severity: "structural",
                principle_name: "backend_is_trace_store_not_universal_resolver",
                check_hints: [
                  {
                    target_vessel: "goal-host-vessel",
                    forbidden_pattern_regex: "^template_search$",
                    detail: "selection should live in activity-api",
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const r = await resolveResolverDistributionAudit({
      type: "resolver_distribution_audit",
      dry_run: true,
    });
    const body = r.body as any;
    const imb = body.findings.find((f: any) => f.subtype === "responsibility_imbalance");
    expect(imb).toBeTruthy();
    expect(imb.cited_principle).toBe("backend_is_trace_store_not_universal_resolver");
  });

  it("returns no findings on a clean registry", async () => {
    globalThis.fetch = routedFetch([
      { match: "/shapes", body: { shapes: ["a"] } },
      { match: "/templates", body: { templates: [{ id: "tpl", inputShapes: ["a"], outputShapes: [] }] } },
      { match: "execution-traces", body: { executions: [{ metadata: { template_id: "tpl" } }] } },
      { match: "concepts/search", body: { concepts: [] } },
    ]);
    const r = await resolveResolverDistributionAudit({
      type: "resolver_distribution_audit",
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.finding_count).toBe(0);
  });
});
