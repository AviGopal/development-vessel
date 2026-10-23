import { describe, test, expect, mock } from "bun:test";
import * as mod from "../../src/resolvers/template-audit-report.ts";
import type { TemplateAuditReportPointer } from "../../src/resolvers/template-audit-report.ts";

describe("template-audit-report: weak template detector with lifetime-only posterior", () => {
  test("fails to detect a subscriber with high lifetime success but sustained recent failure", async () => {
    // This test reproduces a defect where a template with a high lifetime success
    // rate is not flagged as "weak" even if it has been consistently failing recently.
    // The current implementation of resolveTemplateAuditReport looks at the lifetime
    // Thompson posterior mean (alpha / (alpha + beta)) without any recency window.

    // Per the spec for "validator-dispatch", alpha=472674, beta=650168.
    // Posterior mean = 472674 / (472674 + 650168) ≈ 0.421.
    // With the default weakThreshold of 0.3, this is not considered weak.
    const mockTemplateData = {
      templates: [
        {
          id: "activity:⟨validator-dispatch⟩",
          thompson_alpha: 472674,
          thompson_beta: 650168,
          total_executions: 1235754,
          proposed: false,
          deprecated: false,
        },
      ],
    };

    // Mock the global fetch to avoid network calls and provide controlled data.
    global.fetch = mock(async (): Promise<Response> => {
      return new Response(JSON.stringify(mockTemplateData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const pointer: TemplateAuditReportPointer = {
      type: "template_audit_report",
      // Use defaults for minSamples and weakThreshold to test the described failure.
    };

    const result = await mod.resolveTemplateAuditReport(pointer);

    expect(result.shape).toBe("templateAuditReport");

    // The type of `body` is inferred as `unknown` from `ResolverResult`. Cast it
    // to what we expect for a `templateAuditReport` shape.
    const body = result.body as { weak_templates: Array<{ template_id: string }> };
    const weakTemplateIds = body.weak_templates.map((t) => t.template_id);

    // This is the assertion that is expected to fail.
    // The resolver result will not include "validator-dispatch" in its `weak_templates` list
    // because its posterior mean (0.421) is above the `weakThreshold` (default 0.3).
    // The test asserts that it SHOULD be in the list, thus capturing the failure.
    expect(weakTemplateIds).toContain("validator-dispatch");
  });
});
