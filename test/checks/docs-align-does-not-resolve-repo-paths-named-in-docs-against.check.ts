import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/docs-align-tick.js";
import type { DocsAlignTickPointer } from "../../src/resolvers/docs-align-tick.js";

// LAW 9 and REALIGNMENT §2.1: docs are expectations; the evaluator must match reality.
// Measured defect: three docs still name validation/scripts/failure-mode-harness.ts
// after super-repo 74e12112 removed it. The docs-align loop did NOT report that the
// path is "not in live_truth.existing_paths" — it failed to resolve repo paths named
// in docs against the live dev sha.
// This test asserts the expected behavior (an accuracy finding), reproducing the
// defect by failing on today's code.

describe("docs-align tick — accuracy should flag paths named in docs that are not in live_truth.existing_paths", () => {
  test("MEASURED: 'validation/scripts/failure-mode-harness.ts' named in docs must produce an accuracy finding", async () => {
    // Avoid network delay to discovery endpoint; failure is fine, scan degrades gracefully.
    process.env["DISCOVERY_ENDPOINT"] = "http://127.0.0.1:9";

    // Exercise the producer referenced in the evidence as well (walkScripts) — no assertion on arrays.
    try {
      const _ = mod.walkScripts("/workspace/scripts", 1);
      void _;
    } catch {
      // If the workspace is absent in this environment, resolveDocsAlignTick still proceeds with empty live_truth.advertised_shapes.
    }

    const pointer: DocsAlignTickPointer = { type: "docs_align_tick", dry_run: true, max_fixes: 0 };
    const res = await mod.resolveDocsAlignTick(pointer);

    expect(res.shape).toBe("docsAlignTickReport");

    const body = res.body as Record<string, unknown>;
    const byInvariant = (body["by_invariant"] ?? {}) as Record<string, number>;

    // EXPECTATION (what reality demands): at least one accuracy finding should be present
    // for the removed path still named in docs. DEFECT: current code returns 0 here because
    // the docs-align loop does not resolve repo paths named in docs against the live dev sha.
    const accuracy = byInvariant["accuracy"] ?? 0;
    expect(accuracy).toBeGreaterThan(0);
  });
});
