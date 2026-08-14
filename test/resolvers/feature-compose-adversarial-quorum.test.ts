// Adversarial-verify quorum on the close-verdict (§12.6 step 6). When the first judge PASSES, an
// INDEPENDENT refuter (diverse lens) runs; a HIGH-confidence, SPECIFIC refutation flips the verdict
// to addresses:false, but a low-confidence / vague / errored refuter leaves the pass intact
// (fail-open — no over-rejection). Fake `llm` returns the judge response first, the refuter second.
import { describe, it, expect } from "bun:test";
import { verifyPatchAddressesGap, type ReachabilityFact } from "../../src/resolvers/feature-compose";

// A real, reachable, non-header, non-vacuous change so the deterministic floors pass and the LLM
// judge (then the refuter) actually run.
const LIVE_DIFF = `--- a/repos/x/src/fs-write.ts
+++ b/repos/x/src/fs-write.ts
@@
   function fsWrite(p: string, data: string) {
-    return doWrite(p, data);
+    if (!allowlisted(p)) throw new Error("path not in write allowlist");
+    return doWrite(p, data);
   }
`;
const FACTS: ReachabilityFact[] = [
  { symbol: "fsWrite", isNewFunction: false, callerCount: 3, isEntrypoint: true, reachable: true },
];
function seqLlm(...responses: string[]): (p: string) => Promise<string> {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)] ?? "{}";
}

describe("verifyPatchAddressesGap — adversarial-verify quorum (step 6)", () => {
  it("flips a judge PASS to addresses:false on a HIGH-confidence, SPECIFIC refutation", async () => {
    const v = await verifyPatchAddressesGap({
      gapSummary: "WRITE_ALLOWLIST is env-gated and unset",
      diff: LIVE_DIFF,
      reachability: FACTS,
      llm: seqLlm(
        JSON.stringify({ addresses: true, reason: "edits fs-write on the live path", on_live_path: true }),
        JSON.stringify({ refuted: true, confidence: 0.95, reason: "the diff only renames the local variable; process.env[\"WRITE_ALLOWLIST\"] and the env-gate are untouched, so the gap condition still holds on the live path" }),
      ),
    });
    expect(v.addresses).toBe(false);
    expect(v.reason).toContain("adversarial refuter");
  });

  it("keeps the judge PASS when the refuter is LOW-confidence (no over-rejection)", async () => {
    const v = await verifyPatchAddressesGap({
      gapSummary: "WRITE_ALLOWLIST is env-gated and unset",
      diff: LIVE_DIFF,
      reachability: FACTS,
      llm: seqLlm(
        JSON.stringify({ addresses: true, reason: "edits fs-write on the live path", on_live_path: true }),
        JSON.stringify({ refuted: true, confidence: 0.4, reason: "might be surface-only but I am not certain" }),
      ),
    });
    expect(v.addresses).toBe(true);
  });

  it("keeps the judge PASS when the refuter errors (fail-open — a flaky second lens cannot wedge landing)", async () => {
    let call = 0;
    const v = await verifyPatchAddressesGap({
      gapSummary: "some gap",
      diff: LIVE_DIFF,
      reachability: FACTS,
      llm: async () => { call += 1; if (call === 1) return JSON.stringify({ addresses: true, reason: "ok", on_live_path: true }); throw new Error("refuter down"); },
    });
    expect(v.addresses).toBe(true);
  });
});
