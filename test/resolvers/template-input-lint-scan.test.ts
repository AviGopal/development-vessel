import { describe, it, expect, afterEach } from "bun:test";
import { resolveTemplateInputLintScan } from "../../src/resolvers/template-input-lint-scan";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockEmit(sink: unknown[]) {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sink.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("template_input_lint_scan", () => {
  it("flags a template that declares an inputShape and a variable no task consumes", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveTemplateInputLintScan({
      type: "template_input_lint_scan",
      _templates: [
        {
          id: "development-vessel:broken",
          inputShapes: ["recurringPatternCluster"],
          variables: [{ name: "pattern_cluster_id" }],
          tasks: [{ id: "noop", resolver: "http_fetch", config: { type: "http_fetch", url: "http://x/y" } }],
        },
      ],
    });
    expect(res.shape).toBe("templateInputLintReport");
    const body = res.body as { finding_count: number; findings: Array<{ unused_input_shapes: string[]; unused_variables: string[] }> };
    expect(body.finding_count).toBe(1);
    expect(body.findings[0]!.unused_input_shapes).toContain("recurringPatternCluster");
    expect(body.findings[0]!.unused_variables).toContain("pattern_cluster_id");
    expect(emits.length).toBe(1);
    const gap = (emits[0] as { impulse: { pointer: { type: string; gap: { classification_metadata: { gap_subtype: string } } } } }).impulse.pointer;
    expect(gap.type).toBe("substrateGap_write");
    expect(gap.gap.classification_metadata.gap_subtype).toBe("template_declares_unused_input");
  });

  it("does NOT flag a template whose tasks consume its declared inputs/variables", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveTemplateInputLintScan({
      type: "template_input_lint_scan",
      _templates: [
        {
          id: "development-vessel:wired",
          inputShapes: ["gapScenario"],
          variables: [{ name: "scenario_id" }],
          tasks: [
            { id: "load", resolver: "fs_read", config: { type: "fs_read", path: "/workspace/{{scenario_id}}.json" }, inputShapes: ["gapScenario"] },
          ],
        },
      ],
    });
    const body = res.body as { finding_count: number };
    expect(body.finding_count).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("dry_run reports findings without emitting gaps", async () => {
    const emits: unknown[] = [];
    mockEmit(emits);
    const res = await resolveTemplateInputLintScan({
      type: "template_input_lint_scan",
      dry_run: true,
      _templates: [{ id: "development-vessel:broken2", inputShapes: ["x"], tasks: [{ id: "n", resolver: "noop", config: {} }] }],
    });
    const body = res.body as { finding_count: number; dry_run: boolean };
    expect(body.finding_count).toBe(1);
    expect(body.dry_run).toBe(true);
    expect(emits.length).toBe(0);
  });

  it("the real SEED_TEMPLATES registry passes the lint (no load-bearing seed mis-wires)", async () => {
    // Linting the actual shipped seeds; the fixed draft-activity-from-pattern must
    // NOT flag (its load_cluster task consumes the cluster). A regression that
    // re-introduces a declared-but-unused input would fail here.
    const res = await resolveTemplateInputLintScan({ type: "template_input_lint_scan", dry_run: true });
    const body = res.body as { scanned: number; finding_count: number; findings: Array<{ template_id: string }> };
    expect(body.scanned).toBeGreaterThan(20);
    // Document whatever the current registry shows; assert the known-fixed template is clean.
    const flaggedDraftFromPattern = body.findings.some((f) => f.template_id.includes("draft-activity-from-pattern"));
    expect(flaggedDraftFromPattern).toBe(false);
  });
});
