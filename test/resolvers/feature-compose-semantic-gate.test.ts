import { describe, it, expect } from "bun:test";
import {
  extractChangedSymbols,
  reachabilityHardFail,
  verifyPatchAddressesGap,
  type ReachabilityFact,
} from "../../src/resolvers/feature-compose.js";

// Pins the SEMANTIC cutover-verification gate (2026-06-25, lever 5) — the reach-gate
// applied to code. typecheck=clean ≠ gap-fixed. The hollow landing this gate exists
// to reject: a net-new `recordOutcome`/`isNoOpBody` with zero callers that compiles
// fine but changes nothing. Three cases the spec mandates:
//  (a) dead-code-only diff  → UNFAVORABLE via reachability hard-fail, NO LLM call.
//  (b) diff to a function with real callers that genuinely changes gap behavior
//      → addresses=true (LLM judge mocked to addresses:true).
//  (c) LLM judge returns addresses:false → UNFAVORABLE.

const HOLLOW_DIFF = `### NEW FILE /vessels/goal-host-vessel/src/index.ts
+function recordOutcome(success: boolean, body: unknown) {
+  void success; void body;
+}
+function isNoOpBody(body: unknown): boolean {
+  return body == null;
+}`;

const LIVE_DIFF = `### /vessels/goal-host-vessel/src/index.ts
--- a/goal-host-vessel/src/index.ts
+function penaliseHollowTemplate(templateId: string, intensity: number) {
+  // now scales the beta penalty by intensity on the real feedback path
+  return postFeedback(templateId, { kind: "beta", intensity: intensity * 2 });
+}`;

describe("extractChangedSymbols", () => {
  it("extracts net-new function names from added definition lines", () => {
    const syms = extractChangedSymbols(HOLLOW_DIFF);
    const names = syms.map((s) => s.symbol).sort();
    expect(names).toContain("recordOutcome");
    expect(names).toContain("isNoOpBody");
    expect(syms.every((s) => s.isNewFunction)).toBe(true);
  });

  it("does not extract control-flow keywords as symbols", () => {
    const syms = extractChangedSymbols(`+  if (x) { return y; }\n+  for (const z of w) {}`);
    expect(syms.length).toBe(0);
  });
});

describe("reachabilityHardFail", () => {
  it("hard-fails when every changed symbol is dead code (0 callers, not entrypoint)", () => {
    const facts: ReachabilityFact[] = [
      { symbol: "recordOutcome", isNewFunction: true, callerCount: 0, isEntrypoint: false, reachable: false },
      { symbol: "isNoOpBody", isNewFunction: true, callerCount: 0, isEntrypoint: false, reachable: false },
    ];
    const r = reachabilityHardFail(facts);
    expect(r.hardFail).toBe(true);
    expect(r.reason).toContain("dead-code-only");
  });

  it("does NOT hard-fail when at least one symbol is reachable", () => {
    const facts: ReachabilityFact[] = [
      { symbol: "penaliseHollowTemplate", isNewFunction: false, callerCount: 2, isEntrypoint: false, reachable: true },
    ];
    expect(reachabilityHardFail(facts).hardFail).toBe(false);
  });

  it("does NOT hard-fail when no symbols were extracted (LLM judge handles it)", () => {
    expect(reachabilityHardFail([]).hardFail).toBe(false);
  });
});

describe("verifyPatchAddressesGap", () => {
  // (a) dead-code-only diff → UNFAVORABLE via reachability hard-fail, NO LLM call.
  it("rejects a dead-code-only patch via reachability hard-fail without calling the LLM", async () => {
    let llmCalled = false;
    const facts: ReachabilityFact[] = extractChangedSymbols(HOLLOW_DIFF).map((s) => ({
      symbol: s.symbol, isNewFunction: s.isNewFunction, callerCount: 0, isEntrypoint: false, reachable: false,
    }));
    const v = await verifyPatchAddressesGap({
      gapSummary: "trace outcome inconsistency: hollow completions still α-credit the wrapper template",
      diff: HOLLOW_DIFF,
      reachability: facts,
      llm: async () => { llmCalled = true; return "{}"; },
    });
    expect(v.addresses).toBe(false);
    expect(v.hard_fail).toBe(true);
    expect(v.llm_consulted).toBe(false);
    expect(llmCalled).toBe(false);
  });

  // (b) reachable diff that genuinely changes gap behavior → addresses=true.
  it("accepts a patch to a reachable function when the LLM judge says addresses:true", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "penaliseHollowTemplate", isNewFunction: false, callerCount: 3, isEntrypoint: true, reachable: true },
    ];
    const v = await verifyPatchAddressesGap({
      gapSummary: "trace outcome inconsistency: strengthen the β-penalty on hollow completions",
      diff: LIVE_DIFF,
      reachability: facts,
      llm: async () => JSON.stringify({ addresses: true, reason: "edits the live β-penalty path", on_live_path: true }),
    });
    expect(v.addresses).toBe(true);
    expect(v.on_live_path).toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.hard_fail ?? false).toBe(false);
  });

  // (c) LLM judge returns addresses:false → UNFAVORABLE (with suspected_real_location).
  it("rejects when the LLM judge returns addresses:false and surfaces suspected_real_location", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "recordOutcome", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true },
    ];
    const v = await verifyPatchAddressesGap({
      gapSummary: "trace outcome inconsistency",
      diff: LIVE_DIFF,
      reachability: facts,
      llm: async () => JSON.stringify({
        addresses: false,
        reason: "edits recordOutcome but the live β-penalty is penaliseHollowTemplate",
        on_live_path: false,
        suspected_real_location: "penaliseHollowTemplate",
      }),
    });
    expect(v.addresses).toBe(false);
    expect(v.on_live_path).toBe(false);
    expect(v.suspected_real_location).toBe("penaliseHollowTemplate");
  });
});
