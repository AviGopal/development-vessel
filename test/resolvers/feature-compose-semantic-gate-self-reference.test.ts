import { describe, it, expect } from "bun:test";
import {
  verifyPatchAddressesGap,
  type ReachabilityFact,
} from "../../src/resolvers/feature-compose.js";

// A draft whose added symbols are all unreachable is refused deterministically, whatever the LLM judge says. A
// reference from inside a symbol's own body (recursion), or from another symbol the same draft added that nothing
// calls, is not a caller.
//
// The instance: goal-host-vessel 81c9d93e added parseDeterministicWrongRegistryCountOperands,
// deterministicWrongRegistryCountCommand and deterministicWrongRegistryCountOracle. Nothing called command or oracle;
// parse was called only by itself (`return parseDeterministicWrongRegistryCountOperands(JSON.parse(t))`). The callers
// grep counted that recursive line, so the gate logged reachable_symbols:[parse], did not hard-fail, consulted the LLM
// judge, took its addresses:true, and the dead triad landed.
//
// The facts below are the ones the resolver built for that draft: parse with one caller line, which sits inside parse;
// command and oracle exported (isEntrypoint) with no caller at all.

const DIFF = `### /vessels/goal-host-vessel/src/index.ts
--- a/goal-host-vessel/src/index.ts
+export function parseDeterministicWrongRegistryCountOperands(v: unknown): DeterministicWrongRegistryCountOperands | null {
+  if (v !== null && typeof v === "object") {
+    const o = v as Record<string, unknown>;
+    const reg = o["registry"];
+    const exp = o["expected"];
+    if (typeof reg === "string" && typeof exp === "number" && Number.isFinite(exp)) {
+      return { registry: reg, expected: Math.trunc(exp) };
+    }
+  }
+  if (typeof v === "string") {
+    const t = v.trim();
+    if (t.startsWith("{") || t.startsWith("[")) {
+      try { return parseDeterministicWrongRegistryCountOperands(JSON.parse(t)); } catch { /* ignore */ }
+    }
+  }
+  return null;
+}
+
+export function deterministicWrongRegistryCountCommand(ops: DeterministicWrongRegistryCountOperands): string {
+  const n = Math.trunc(ops.expected);
+  return \`bash -lc 'printf "%d\\\\n" \${n}'\`;
+}
+
+export async function deterministicWrongRegistryCountOracle(
+  ops: DeterministicWrongRegistryCountOperands,
+  produced: number,
+): Promise<{ verified: boolean; observed: number; expected: number }> {
+  const expected = Math.trunc(ops.expected);
+  const observed = Math.trunc(produced);
+  return { verified: observed === expected, observed, expected };
+}`;

const PARSE = "parseDeterministicWrongRegistryCountOperands";
const COMMAND = "deterministicWrongRegistryCountCommand";
const ORACLE = "deterministicWrongRegistryCountOracle";

function judge(verdict: { addresses: boolean; on_live_path: boolean; reason: string }) {
  const prompts: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    // The first call is the judge; any refuter call refutes nothing, so the judge's verdict stands.
    return prompts.length === 1 ? JSON.stringify(verdict) : JSON.stringify({ refuted: false, confidence: 0, reason: "" });
  };
  return { llm, prompts };
}

function gate(facts: ReachabilityFact[], llm: (p: string) => Promise<string>, diff = DIFF) {
  return verifyPatchAddressesGap({
    gapSummary: "route-edit: reach_by_construction_recipe deterministic_wrong_registry_count",
    diff,
    reachability: facts,
    llm,
  });
}

describe("semantic gate: a draft whose added symbols are all unreachable is a deterministic hard fail", () => {
  it("MUST-FAIL: the 81c9d93e shape is refused without the judge, though the judge says addresses:true", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: PARSE, isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: [PARSE] },
      { symbol: COMMAND, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false, callerScopes: [] },
      { symbol: ORACLE, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false, callerScopes: [] },
    ];
    const j = judge({ addresses: true, on_live_path: true, reason: "the parse function is reachable" });
    const v = await gate(facts, j.llm);
    expect(v.addresses).toBe(false);
    expect(v.hard_fail).toBe(true);
    expect(v.llm_consulted).toBe(false);
    expect(j.prompts.length).toBe(0);
    expect(v.reason).toContain("self-reference is not a caller");
  });

  it("MUST-FAIL: a symbol called only by another added symbol nobody calls is not live either", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: COMMAND, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false, callerScopes: [] },
      { symbol: PARSE, isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: [COMMAND] },
    ];
    const j = judge({ addresses: true, on_live_path: true, reason: "wired through the command" });
    const v = await gate(facts, j.llm);
    expect(v.hard_fail).toBe(true);
    expect(v.addresses).toBe(false);
    expect(j.prompts.length).toBe(0);
  });

  it("CONTROL: one added symbol with a caller outside the draft is admitted as today", async () => {
    // parse also has a real caller at module scope (a route registration: scope null); command reaches parse's
    // liveness through it; the oracle stays dead. A partly reachable draft goes to the judge, as before.
    const facts: ReachabilityFact[] = [
      { symbol: PARSE, isNewFunction: true, callerCount: 2, isEntrypoint: true, reachable: true, callerScopes: [PARSE, null] },
      { symbol: COMMAND, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false, callerScopes: [] },
      { symbol: ORACLE, isNewFunction: true, callerCount: 0, isEntrypoint: true, reachable: false, callerScopes: [] },
    ];
    const j = judge({ addresses: true, on_live_path: true, reason: "parse is wired into the route" });
    const v = await gate(facts, j.llm);
    expect(v.hard_fail).not.toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(true);
    expect(j.prompts.length).toBeGreaterThan(0);
  });

  it("CONTROL: a caller inside an existing (not added) function is a real caller", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: PARSE, isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: ["handleReachVerdict"] },
    ];
    const j = judge({ addresses: true, on_live_path: true, reason: "called from handleReachVerdict" });
    const v = await gate(facts, j.llm);
    expect(v.hard_fail).not.toBe(true);
    expect(v.addresses).toBe(true);
  });

  it("CONTROL: facts without caller scopes are read exactly as before", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: PARSE, isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true },
    ];
    const j = judge({ addresses: true, on_live_path: true, reason: "reachable" });
    const v = await gate(facts, j.llm);
    expect(v.hard_fail).not.toBe(true);
    expect(v.addresses).toBe(true);
  });

  it("CONTROL: a draft with no added symbols is unchanged (no hard fail; the judge decides)", async () => {
    const diff = `### /vessels/goal-host-vessel/src/index.ts
--- a/goal-host-vessel/src/index.ts
-  const limit = 10;
+  const limit = 20;`;
    const j = judge({ addresses: true, on_live_path: true, reason: "raises the limit on the live path" });
    const v = await gate([], j.llm, diff);
    expect(v.hard_fail).not.toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(true);
  });
});
