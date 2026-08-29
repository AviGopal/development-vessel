import { describe, it, expect, afterEach } from "bun:test";
import { applyEdits, reachGate, parseJson } from "../../src/resolvers/doc-drift-fix.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Fake discovery(llm_completion) + the llm endpoint. The discovery URL ends in
// "/resolve"; the llm endpoint is a distinct host ("llmcall") so we can route both.
function fakeLlm(content: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("llmcall")) {
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    // discovery: return the llm vessel endpoint
    return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://llmcall", resolve_endpoint: "/x" }] } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("doc_drift_fix / applyEdits", () => {
  it("applies an edit whose old_string anchors, misses one that does not", () => {
    const doc = "The foo vessel exposes no HTTP endpoints and cannot be reached.";
    const { text, applied, missed } = applyEdits(doc, [
      { old_string: "exposes no HTTP endpoints and cannot be reached", new_string: "exposes /health and /resolve over HTTP" },
      { old_string: "THIS TEXT IS NOT IN THE DOC", new_string: "whatever" },
    ]);
    expect(applied.length).toBe(1);
    expect(missed.length).toBe(1);
    expect(text).toContain("/health and /resolve over HTTP");
    expect(text).not.toContain("cannot be reached");
  });

  it("drops a malformed edit (missing old_string) as missed, mutates nothing", () => {
    const doc = "unchanged prose";
    const { text, applied, missed } = applyEdits(doc, [{ old_string: "", new_string: "x" } as never]);
    expect(applied.length).toBe(0);
    expect(missed.length).toBe(1);
    expect(text).toBe(doc);
  });
});

describe("doc_drift_fix / parseJson", () => {
  it("extracts JSON from a fenced/prose-wrapped response", () => {
    const v = parseJson<{ reached: boolean }>("sure!\n```json\n{\"reached\": true}\n```\n");
    expect(v?.reached).toBe(true);
  });
});

describe("doc_drift_fix / reachGate", () => {
  // The model is asked for PER-CLAIM judgments — {"claims":[{"n":1,"still_asserted":bool}],
  // "regression":bool,"reason":"..."} — and `reached` is COMPUTED from them by the resolver
  // (doc-drift-fix.ts:133-146). It is deliberately NOT read from a raw model boolean: models
  // emitted `reached:false` alongside reasons stating every claim was resolved, and per-claim
  // booleans are far harder to garble. These fixtures previously returned the old raw-`reached`
  // schema, which has no `claims` array, so reachGate bailed at
  // `if (!v || !Array.isArray(v.claims)) return null` and every assertion read `undefined`.
  // Mocking a raw `reached` again would re-introduce trust in the field that was garbling.
  const claimQuote = "It exposes no HTTP endpoints and cannot be reached.";
  const claims = [{ quote: claimQuote }];

  it("REJECTS a revision that still leaves a claim asserted (reached:false)", async () => {
    globalThis.fetch = fakeLlm(JSON.stringify({ claims: [{ n: 1, still_asserted: true }], regression: false, reason: "still asserted" }));
    const v = await reachGate("docs/thing.md", "It exposes no HTTP endpoints and cannot be reached. (unchanged)", claims);
    expect(v?.reached).toBe(false);
    // reached is DERIVED: the still_asserted claim must surface by quote in unresolved[]
    expect(v?.unresolved).toEqual([claimQuote]);
    // the resolver treats reached:false as UNFAVORABLE (do not land)
    const favorable = !!v && v.reached && !v.regression;
    expect(favorable).toBe(false);
  });

  it("REJECTS a revision that resolves the claim but introduces a regression", async () => {
    globalThis.fetch = fakeLlm(JSON.stringify({ claims: [{ n: 1, still_asserted: false }], regression: true, reason: "falsified a previously-true line" }));
    const v = await reachGate("docs/thing.md", "It exposes /health now (but broke another claim).", claims);
    const favorable = !!v && v.reached && !v.regression;
    expect(favorable).toBe(false);
  });

  it("ACCEPTS a revision that removes the claim with no regression (favorable)", async () => {
    globalThis.fetch = fakeLlm(JSON.stringify({ claims: [{ n: 1, still_asserted: false }], regression: false, reason: "claim removed" }));
    const v = await reachGate("docs/thing.md", "The foo vessel exposes /health and /resolve over HTTP.", claims);
    expect(v?.reached).toBe(true);
    const favorable = !!v && v.reached && !v.regression;
    expect(favorable).toBe(true);
  });

  it("returns null on an unparseable verdict (treated as UNFAVORABLE by caller)", async () => {
    globalThis.fetch = fakeLlm("the model rambled without emitting json");
    const v = await reachGate("docs/thing.md", "whatever", claims);
    expect(v).toBeNull();
  });
});
