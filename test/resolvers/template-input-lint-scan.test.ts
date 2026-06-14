import { describe, it, expect, afterEach } from "bun:test";
import { resolveTemplateInputLintScan } from "../../src/resolvers/template-input-lint-scan";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(templates: unknown[], emitSink: unknown[]) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v2/activities/templates")) {
      return new Response(JSON.stringify({ templates }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/v2/impulses/resolve")) {
      emitSink.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("template_input_lint_scan", () => {
  it("flags a template that declares an inputShape and a variable no task consumes", async () => {
    const emits: unknown[] = [];
    mockFetch([
      {
        id: "development-vessel:broken",
        inputShapes: ["recurringPatternCluster"],
        variables: [{ name: "pattern_cluster_id" }],
        // No task references the cluster shape or the variable.
        tasks: [{ id: "noop", resolver: "http_fetch", config: { type: "http_fetch", url: "http://x/y" } }],
      },
    ], emits);

    const res = await resolveTemplateInputLintScan({ type: "template_input_lint_scan" });
    expect(res.shape).toBe("templateInputLintReport");
    const body = res.body as { finding_count: number; findings: Array<{ unused_input_shapes: string[]; unused_variables: string[] }> };
    expect(body.finding_count).toBe(1);
    expect(body.findings[0]!.unused_input_shapes).toContain("recurringPatternCluster");
    expect(body.findings[0]!.unused_variables).toContain("pattern_cluster_id");
    // It emitted a substrateGap_write for the offending template.
    expect(emits.length).toBe(1);
    const gap = (emits[0] as { impulse: { pointer: { type: string; gap: { category: string; classification_metadata: { gap_subtype: string } } } } }).impulse.pointer;
    expect(gap.type).toBe("substrateGap_write");
    expect(gap.gap.classification_metadata.gap_subtype).toBe("template_declares_unused_input");
  });

  it("does NOT flag a template whose tasks consume its declared inputs/variables", async () => {
    const emits: unknown[] = [];
    mockFetch([
      {
        id: "development-vessel:wired",
        inputShapes: ["gapScenario"],
        variables: [{ name: "scenario_id" }],
        tasks: [
          { id: "load", resolver: "fs_read", config: { type: "fs_read", path: "/workspace/{{scenario_id}}.json" }, inputShapes: ["gapScenario"] },
        ],
      },
    ], emits);

    const res = await resolveTemplateInputLintScan({ type: "template_input_lint_scan" });
    const body = res.body as { finding_count: number };
    expect(body.finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("dry_run reports findings without emitting gaps", async () => {
    const emits: unknown[] = [];
    mockFetch([
      { id: "development-vessel:broken2", inputShapes: ["x"], tasks: [{ id: "n", resolver: "noop", config: {} }] },
    ], emits);
    const res = await resolveTemplateInputLintScan({ type: "template_input_lint_scan", dry_run: true });
    const body = res.body as { finding_count: number; dry_run: boolean };
    expect(body.finding_count).toBe(1);
    expect(body.dry_run).toBe(true);
    expect(emits.length).toBe(0);
  });

  it("respects idPattern scoping (ignores out-of-scope templates)", async () => {
    const emits: unknown[] = [];
    mockFetch([
      { id: "someone-else:thing", inputShapes: ["x"], tasks: [{ id: "n", resolver: "noop", config: {} }] },
    ], emits);
    const res = await resolveTemplateInputLintScan({ type: "template_input_lint_scan" });
    const body = res.body as { finding_count: number; in_scope: number };
    expect(body.in_scope).toBe(0);
    expect(body.finding_count).toBe(0);
  });
});
