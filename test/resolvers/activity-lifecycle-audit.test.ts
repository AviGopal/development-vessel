import { describe, it, expect, afterEach } from "bun:test";
import { resolveActivityLifecycleAudit } from "../../src/resolvers/activity-lifecycle-audit.js";

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

describe("activity_lifecycle_audit", () => {
  it("ranks templates by combined_score (success × recency × affinity)", async () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 30 * 24 * 3600_000).toISOString();
    const templates = [
      { id: "hot-template", tags: [] },
      { id: "cold-template", tags: [] },
    ];
    const traces = [
      // hot-template: 3 successes, recent, varied signatures
      { status: "success", occurred_at: recent, metadata: { template_id: "hot-template", state_signature: "sig_a" } },
      { status: "success", occurred_at: recent, metadata: { template_id: "hot-template", state_signature: "sig_b" } },
      { status: "success", occurred_at: recent, metadata: { template_id: "hot-template", state_signature: "sig_c" } },
      // cold-template: 1 failure, very old
      { status: "failure", occurred_at: old, metadata: { template_id: "cold-template", state_signature: "sig_a" } },
    ];
    globalThis.fetch = routedFetch([
      { match: "/templates", body: { templates } },
      { match: "execution-traces", body: { executions: traces } },
    ]);
    const r = await resolveActivityLifecycleAudit({
      type: "activity_lifecycle_audit",
      dry_run: true,
    });
    expect(r.shape).toBe("activityLifecycleAudit");
    const body = r.body as any;
    expect(body.should_load_hot[0].template_id).toBe("hot-template");
    expect(body.should_unload[0].template_id).toBe("cold-template");
  });

  it("flags proposed templates with sufficient recent successes for promotion", async () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const templates = [
      { id: "candidate", tags: ["proposed"] },
    ];
    const traces = Array.from({ length: 4 }, () => ({
      status: "success",
      occurred_at: recent,
      metadata: { template_id: "candidate", state_signature: "sig" },
    }));
    globalThis.fetch = routedFetch([
      { match: "/templates", body: { templates } },
      { match: "execution-traces", body: { executions: traces } },
    ]);
    const r = await resolveActivityLifecycleAudit({
      type: "activity_lifecycle_audit",
      promoteThreshold: 3,
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.should_promote_proposed.length).toBeGreaterThan(0);
    expect(body.should_promote_proposed[0].template_id).toBe("candidate");
    const promoteFindings = body.findings.filter((f: any) => f.subtype === "should_promote_proposed");
    expect(promoteFindings.length).toBeGreaterThan(0);
  });

  it("returns templates_with_traces=0 when no traces exist", async () => {
    globalThis.fetch = routedFetch([
      { match: "/templates", body: { templates: [{ id: "x" }] } },
      { match: "execution-traces", body: { executions: [] } },
    ]);
    const r = await resolveActivityLifecycleAudit({
      type: "activity_lifecycle_audit",
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.templates_with_traces).toBe(0);
    expect(body.should_load_hot.length).toBe(0);
  });
});
