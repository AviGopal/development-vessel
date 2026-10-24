import { describe, it, expect } from "bun:test";
import {
  verifyPatchAddressesGap,
  draftReachability,
  enclosingTopLevelSymbol,
  type ReachabilityFact,
} from "../../src/resolvers/feature-compose.js";

// OVER-REFUSAL CONTROLS for the self-reference rule (a reference from inside a symbol's own body, or from another added
// symbol that is not live, is not a caller). A false hard_fail blocks a legitimate edit with no LLM call and teaches the
// drafter a wrong [deterministic] lesson, so recursion is only discounted when it is the ONLY evidence of use.

const DIFF = `### /vessels/goal-host-vessel/src/index.ts
--- a/goal-host-vessel/src/index.ts
+export function walkTree(n: Node | null): number {
+  if (!n) return 0;
+  return 1 + walkTree(n.left) + walkTree(n.right);
+}`;

function judgeSays(addresses: boolean) {
  const prompts: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return prompts.length === 1
      ? JSON.stringify({ addresses, on_live_path: true, reason: "judged" })
      : JSON.stringify({ refuted: false, confidence: 0, reason: "" });
  };
  return { llm, prompts };
}

async function gate(facts: ReachabilityFact[]) {
  const j = judgeSays(true);
  const v = await verifyPatchAddressesGap({ gapSummary: "count tree nodes on the reach path", diff: DIFF, reachability: facts, llm: j.llm });
  return { v, prompts: j.prompts };
}

const reach = (facts: ReachabilityFact[]) => new Map(draftReachability(facts).map((f) => [f.symbol, f.reachable]));

describe("self-reference rule: recursion with a live caller is never refused", () => {
  it("a recursive added function that also has a live external caller is reachable; no hard_fail", async () => {
    // Scopes built the way the resolver builds them: from the caller lines' positions in the post-patch file.
    const file = [
      "export function walkTree(n: Node | null): number {", // 1
      "  if (!n) return 0;",                                // 2
      "  return 1 + walkTree(n.left) + walkTree(n.right);", // 3
      "}",                                                  // 4
      "export function handleReach(req: Req) {",            // 5
      "  return walkTree(req.root);",                       // 6
      "}",                                                  // 7
    ].join("\n");
    const callerScopes = [3, 6].map((l) => enclosingTopLevelSymbol(file, l));
    expect(callerScopes).toEqual(["walkTree", "handleReach"]);
    const facts: ReachabilityFact[] = [
      { symbol: "walkTree", isNewFunction: true, callerCount: 2, isEntrypoint: true, reachable: true, callerScopes },
    ];
    expect(reach(facts).get("walkTree")).toBe(true);
    const { v, prompts } = await gate(facts);
    expect(v.hard_fail).not.toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it("mutual recursion between two added symbols, one with a live external caller: both reachable; no hard_fail", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "isEven", isNewFunction: true, callerCount: 2, isEntrypoint: true, reachable: true, callerScopes: ["isOdd", null] },
      { symbol: "isOdd", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: ["isEven"] },
    ];
    const r = reach(facts);
    expect(r.get("isEven")).toBe(true);
    expect(r.get("isOdd")).toBe(true);
    const { v } = await gate(facts);
    expect(v.hard_fail).not.toBe(true);
    expect(v.addresses).toBe(true);
  });

  it("the same mutual pair is reachable whichever of the two holds the live caller", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "isEven", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: ["isOdd"] },
      { symbol: "isOdd", isNewFunction: true, callerCount: 2, isEntrypoint: true, reachable: true, callerScopes: ["isEven", "routeHandler"] },
    ];
    const r = reach(facts);
    expect(r.get("isEven")).toBe(true);
    expect(r.get("isOdd")).toBe(true);
    const { v } = await gate(facts);
    expect(v.hard_fail).not.toBe(true);
  });

  it("a recursive EXISTING function (not added by the draft) is unaffected", async () => {
    // The symbol-less in-place path: the enclosing function is an existing symbol (isNewFunction:false). Even carrying
    // only self scopes it keeps the reachability it had.
    const facts: ReachabilityFact[] = [
      { symbol: "walkTree", isNewFunction: false, callerCount: 1, isEntrypoint: true, reachable: true, callerScopes: ["walkTree"] },
    ];
    expect(reach(facts).get("walkTree")).toBe(true);
    const { v } = await gate(facts);
    expect(v.hard_fail).not.toBe(true);
    expect(v.addresses).toBe(true);
  });

  it("an existing recursive function whose signature the draft edits, with an existing live caller, stays reachable", async () => {
    // extractChangedSymbols marks a symbol on an edited `+` definition line as isNewFunction, so an edited existing
    // function is read as "added": its live caller elsewhere keeps it reachable.
    const facts: ReachabilityFact[] = [
      { symbol: "walkTree", isNewFunction: true, callerCount: 3, isEntrypoint: true, reachable: true, callerScopes: ["walkTree", "walkTree", "renderFleetRow"] },
    ];
    expect(reach(facts).get("walkTree")).toBe(true);
    const { v } = await gate(facts);
    expect(v.hard_fail).not.toBe(true);
  });
});
