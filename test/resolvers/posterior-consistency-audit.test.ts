import { describe, it, expect, afterEach } from "bun:test";
import { resolvePosteriorConsistencyAudit } from "../../src/resolvers/posterior-consistency-audit.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockRouter(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("posterior_consistency_audit", () => {
  it("flags drift when claimed mean diverges from empirical", async () => {
    const templates = [
      { id: "actA", metrics: { thompson_alpha: 50, thompson_beta: 1 } }, // claimed mean ~0.98
    ];
    // Empirical: 5 success, 15 failure → mean ~ 6/22 ~ 0.27, drift ~0.71
    const executions = [
      ...Array.from({ length: 5 }, (_, i) => ({ activity_id: "actA", status: "success" })),
      ...Array.from({ length: 15 }, (_, i) => ({ activity_id: "actA", status: "failure" })),
    ];
    const emitCalls: any[] = [];
    mockRouter([
      // PAGINATE. The resolver loops `offset += rows.length` until a page comes back empty
      // (or `total` is reached), guarded at 200 iterations. A mock that returns the SAME page
      // for every offset never terminates that loop: it ran all 200 iterations and accumulated
      // 200 copies of the single fixture template, so drifted_cells.length was 200 instead of 1.
      // The resolver's pagination is correct; the mock has to emulate the end of the list.
      (url) => {
        if (!url.includes("/v2/activities/templates")) return null;
        const off = Number(new URL(url, "http://x").searchParams.get("offset") ?? 0);
        return new Response(
          JSON.stringify({ templates: templates.slice(off), total: templates.length }),
          { status: 200 },
        );
      },
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
      (url, init) => url.endsWith("/v2/impulses/resolve")
        ? (emitCalls.push(JSON.parse(init?.body as string)), new Response("{}", { status: 200 })) : null,
    ]);
    const r = await resolvePosteriorConsistencyAudit({ type: "posterior_consistency_audit" });
    const body = r.body as any;
    expect(body.drifted_cells.length).toBe(1);
    expect(body.drifted_cells[0].activity_id).toBe("actA");
    expect(body.drifted_cells[0].drift).toBeGreaterThan(0.2);
    expect(body.gaps_emitted).toBe(1);
    expect(emitCalls[0].impulse.pointer.gap.category).toBe("posterior_consistency_drift");
  });

  it("ignores cells below min_samples", async () => {
    const templates = [{ id: "actB", metrics: { thompson_alpha: 50, thompson_beta: 1 } }];
    const executions = [{ activity_id: "actB", status: "failure" }, { activity_id: "actB", status: "failure" }];
    mockRouter([
      // PAGINATE. The resolver loops `offset += rows.length` until a page comes back empty
      // (or `total` is reached), guarded at 200 iterations. A mock that returns the SAME page
      // for every offset never terminates that loop: it ran all 200 iterations and accumulated
      // 200 copies of the single fixture template, so drifted_cells.length was 200 instead of 1.
      // The resolver's pagination is correct; the mock has to emulate the end of the list.
      (url) => {
        if (!url.includes("/v2/activities/templates")) return null;
        const off = Number(new URL(url, "http://x").searchParams.get("offset") ?? 0);
        return new Response(
          JSON.stringify({ templates: templates.slice(off), total: templates.length }),
          { status: 200 },
        );
      },
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
    ]);
    const r = await resolvePosteriorConsistencyAudit({ type: "posterior_consistency_audit", min_samples: 10 });
    const body = r.body as any;
    expect(body.drifted_cells.length).toBe(0);
  });

  it("returns no drift when claimed and empirical agree", async () => {
    const templates = [{ id: "actC", metrics: { thompson_alpha: 10, thompson_beta: 10 } }]; // mean 0.50
    const executions = [
      ...Array.from({ length: 10 }, () => ({ activity_id: "actC", status: "success" })),
      ...Array.from({ length: 10 }, () => ({ activity_id: "actC", status: "failure" })),
    ];
    mockRouter([
      // PAGINATE. The resolver loops `offset += rows.length` until a page comes back empty
      // (or `total` is reached), guarded at 200 iterations. A mock that returns the SAME page
      // for every offset never terminates that loop: it ran all 200 iterations and accumulated
      // 200 copies of the single fixture template, so drifted_cells.length was 200 instead of 1.
      // The resolver's pagination is correct; the mock has to emulate the end of the list.
      (url) => {
        if (!url.includes("/v2/activities/templates")) return null;
        const off = Number(new URL(url, "http://x").searchParams.get("offset") ?? 0);
        return new Response(
          JSON.stringify({ templates: templates.slice(off), total: templates.length }),
          { status: 200 },
        );
      },
      (url) => url.includes("/v2/activities/execution-traces") ? new Response(JSON.stringify({ executions }), { status: 200 }) : null,
    ]);
    const r = await resolvePosteriorConsistencyAudit({ type: "posterior_consistency_audit" });
    const body = r.body as any;
    expect(body.drifted_cells.length).toBe(0);
  });
});
