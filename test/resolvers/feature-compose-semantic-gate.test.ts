import { describe, it, expect } from "bun:test";
import {
  extractChangedSymbols,
  reachabilityHardFail,
  verifyPatchAddressesGap,
  diffIsCreateHeavy,
  detectNewCapabilityStub,
  stripCommentsAndStrings,
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

// FUNCTIONAL-COMPLETENESS / STUB DETECTION (2026-06-29). The hole this closes: a
// create-heavy architectural MOVE (new endpoint + wiring + call-site) can typecheck
// AND be reachable (on_live_path:true) AND have the LLM judge addresses:true (it IS
// wired) — but its body is a placeholder/stub. A wired stub must NOT land to
// origin/dev. The deterministic detector hard-fails create-heavy stubs BEFORE the LLM
// judge; surgical edits (non-create-heavy) are unaffected.

// A WIRED STUB: new function exists + is registered (reachable) but the body is a
// real code stub (a bare `TODO;` statement that survives comment-stripping). The
// comment-marker-only variant is now correctly deferred to the LLM judge (see the
// WIRED_STUB_COMMENT_ONLY_DIFF case below); this one trips the deterministic gate
// because the marker is actual CODE.
const WIRED_STUB_DIFF = `### NEW FILE /vessels/metabob-activity-api/src/routes/resolve-trace.ts
+import type { Context } from "hono";
+
+export function registerResolveTrace(app: import("hono").Hono) {
+  return doResolveTrace;
+}
+function doResolveTrace(c: Context) {
+  TODO;
+  return c.json({ ok: true });
+}`;

// A wired stub whose ONLY stub signal is a COMMENT marker — the deterministic gate now
// (correctly) does NOT trip on this; it is deferred to the strengthened LLM judge.
const WIRED_STUB_COMMENT_ONLY_DIFF = `### NEW FILE /vessels/metabob-activity-api/src/routes/resolve-trace.ts
+import type { Context } from "hono";
+
+// move the universal-resolver logic here from the trace store
+export function registerResolveTrace(app: import("hono").Hono) {
+  app.post("/v2/resolve/trace", (c: Context) => {
+    // TODO: implement the moved trace-resolution logic
+    return c.json({ ok: true });
+  });
+}`;

// A COMPLETE new endpoint: the moved logic is actually present in the body.
const COMPLETE_NEW_ENDPOINT_DIFF = `### NEW FILE /vessels/metabob-activity-api/src/routes/resolve-trace.ts
+import type { Context } from "hono";
+
+export function registerResolveTrace(app: import("hono").Hono) {
+  app.post("/v2/resolve/trace", async (c: Context) => {
+    const { trace_id } = await c.req.json();
+    const rows = await db.query("SELECT * FROM activity_execution_traces WHERE id = $id", { id: trace_id });
+    const trace = rows[0];
+    if (!trace) return c.json({ error: "not found" }, 404);
+    const resolved = hydrateImpulses(trace.impulse_resolutions, trace.tasks);
+    return c.json({ trace, resolved });
+  });
+}`;

// A return-null-only NEW handler (structural stub, no text marker).
const RETURN_NULL_STUB_DIFF = `### NEW FILE /vessels/x/src/handler.ts
+export function resolveUniversal(input: unknown) {
+  return null;
+}`;

describe("diffIsCreateHeavy", () => {
  it("flags a NEW FILE diff as create-heavy", () => {
    expect(diffIsCreateHeavy(WIRED_STUB_DIFF)).toBe(true);
  });
  it("flags a diff that adds a brand-new function as create-heavy", () => {
    expect(diffIsCreateHeavy(`### /vessels/x/src/a.ts\n+function brandNew() { return doWork(); }`)).toBe(true);
  });
  it("flags a diff that registers a route handler as create-heavy", () => {
    expect(diffIsCreateHeavy(`### /vessels/x/src/a.ts\n+  app.post("/v2/x", handler);`)).toBe(true);
  });
  it("does NOT flag a pure in-place surgical edit (no new file/fn/handler) as create-heavy", () => {
    expect(diffIsCreateHeavy(LIVE_DIFF.replace(/\+function[^\n]*\n/, "+  intensity = intensity * 3;\n"))).toBe(false);
    expect(diffIsCreateHeavy(`### /vessels/x/src/a.ts\n+  const seen = new Set();\n+  if (seen.has(k)) continue;`)).toBe(false);
  });
});

describe("detectNewCapabilityStub", () => {
  it("detects a wired-but-stub new endpoint via a TODO marker", () => {
    const v = detectNewCapabilityStub(WIRED_STUB_DIFF);
    expect(v.isStub).toBe(true);
    expect(v.marker).toBe("TODO");
  });
  it("detects a return-null-only new handler structurally (no text marker)", () => {
    const v = detectNewCapabilityStub(RETURN_NULL_STUB_DIFF);
    expect(v.isStub).toBe(true);
    expect(v.reason).toMatch(/return-only|stub/i);
  });
  it("detects a throw-not-implemented body", () => {
    const v = detectNewCapabilityStub(`### NEW FILE /vessels/x/src/h.ts\n+export function f() {\n+  throw new Error("not implemented yet");\n+}`);
    expect(v.isStub).toBe(true);
  });
  it("passes a COMPLETE new endpoint with real moved logic", () => {
    const v = detectNewCapabilityStub(COMPLETE_NEW_ENDPOINT_DIFF);
    expect(v.isStub).toBe(false);
  });
  it("is a NO-OP for surgical (non-create-heavy) edits — never trips on existing-file edits", () => {
    // even a TODO inside a surgical edit does not trip the gate (scoped to create-heavy)
    const surgical = `### /vessels/x/src/a.ts\n+  count = count + 1; // TODO revisit threshold later`;
    const v = detectNewCapabilityStub(surgical);
    expect(v.isStub).toBe(false);
  });

  // FALSE-POSITIVE FIX (2026-06-29): a marker word inside a doc-comment must NOT trip.
  // This is the orderRing refactor-move case: real ring-buffer logic extracted into a
  // new module, with an accurate doc-comment "When the ring has not yet wrapped…". The
  // `\bnot\s+yet\b` marker used to fire on that comment → false hard-fail.
  it("does NOT trip on a marker word inside a doc-comment (the orderRing false-positive)", () => {
    const diff = `### NEW FILE /vessels/goal-host-vessel/src/mem-ring.ts
+export function pushOrderRing(ring: number[], cap: number, value: number): number[] {
+  // When the ring has not yet wrapped, append; once full, drop the oldest first.
+  const next = ring.length < cap ? [...ring, value] : [...ring.slice(1), value];
+  return next;
+}
+export function readOrderRing(ring: number[]): number[] {
+  return ring.slice();
+}`;
    const v = detectNewCapabilityStub(diff);
    expect(v.isStub).toBe(false);
  });

  // A marker word inside a STRING/LOG must NOT trip either.
  it("does NOT trip on a marker word inside a log/string literal", () => {
    const diff = `### NEW FILE /vessels/x/src/svc.ts
+export function runStep(step: string): string {
+  const result = transform(step);
+  log.info("placeholder values are normalized; stub records are coalesced");
+  return result;
+}`;
    const v = detectNewCapabilityStub(diff);
    expect(v.isStub).toBe(false);
  });

  // TRUE-POSITIVE: a real marker in CODE (a bare TODO statement) still trips.
  it("still trips on a real stub marker that survives in code", () => {
    const diff = `### NEW FILE /vessels/x/src/svc.ts
+export function runStep(step: string): string {
+  TODO;
+  return step;
+}`;
    const v = detectNewCapabilityStub(diff);
    expect(v.isStub).toBe(true);
    expect(v.marker).toBe("TODO");
  });

  // TRUE-POSITIVE: `throw new Error("not implemented")` is a stub even though the
  // marker lives in the string — the throw structure is the signal.
  it("still trips on throw new Error(\"not implemented\") (string body inspected for throw)", () => {
    const diff = `### NEW FILE /vessels/x/src/svc.ts
+export function runStep(step: string): string {
+  throw new Error("not implemented");
+}`;
    const v = detectNewCapabilityStub(diff);
    expect(v.isStub).toBe(true);
  });
});

describe("stripCommentsAndStrings", () => {
  it("blanks line + block comments and string interiors but keeps code structure", () => {
    const src = `const x = "not yet"; // TODO later\n/* placeholder */ doWork();`;
    const out = stripCommentsAndStrings(src);
    expect(out).not.toMatch(/not yet/);
    expect(out).not.toMatch(/TODO/);
    expect(out).not.toMatch(/placeholder/);
    expect(out).toMatch(/const x =/);
    expect(out).toMatch(/doWork\(\)/);
  });
});

describe("verifyPatchAddressesGap — wired-stub hard-fail (functional completeness)", () => {
  it("rejects a WIRED STUB new endpoint BEFORE the LLM judge (addresses:false, no LLM call)", async () => {
    let llmCalled = false;
    // reachable: the endpoint IS registered. Pre-strengthening this would have reached
    // the LLM judge which (seeing it wired) could return addresses:true.
    const facts: ReachabilityFact[] = [
      { symbol: "registerResolveTrace", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true },
    ];
    const v = await verifyPatchAddressesGap({
      gapSummary: "backend is trace store, not universal resolver — move resolve logic to a dedicated endpoint",
      diff: WIRED_STUB_DIFF,
      reachability: facts,
      llm: async () => { llmCalled = true; return JSON.stringify({ addresses: true, reason: "it is wired", on_live_path: true }); },
    });
    expect(v.addresses).toBe(false);
    expect(v.hard_fail).toBe(true);
    expect(v.llm_consulted).toBe(false);
    expect(llmCalled).toBe(false);
    expect(v.reason).toMatch(/stub/i);
  });

  it("DEFERS a comment-marker-only wired stub to the LLM judge (no deterministic hard-fail)", async () => {
    let llmCalled = false;
    const facts: ReachabilityFact[] = [
      { symbol: "registerResolveTrace", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true },
    ];
    // the only stub signal is a `// TODO` comment → deterministic gate must NOT fire;
    // the strengthened LLM judge gets to decide. Here it (correctly) rejects.
    const v = await verifyPatchAddressesGap({
      gapSummary: "backend is trace store, not universal resolver — move resolve logic to a dedicated endpoint",
      diff: WIRED_STUB_COMMENT_ONLY_DIFF,
      reachability: facts,
      llm: async () => { llmCalled = true; return JSON.stringify({ addresses: false, reason: "wired stub, not a functional implementation", on_live_path: true }); },
    });
    expect(llmCalled).toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(false);
  });

  it("still ACCEPTS a COMPLETE new endpoint (reaches LLM judge, addresses:true)", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "registerResolveTrace", isNewFunction: true, callerCount: 1, isEntrypoint: true, reachable: true },
    ];
    const v = await verifyPatchAddressesGap({
      gapSummary: "backend is trace store, not universal resolver — move resolve logic to a dedicated endpoint",
      diff: COMPLETE_NEW_ENDPOINT_DIFF,
      reachability: facts,
      llm: async () => JSON.stringify({ addresses: true, reason: "endpoint contains the moved resolution logic", on_live_path: true }),
    });
    expect(v.addresses).toBe(true);
    expect(v.llm_consulted).toBe(true);
  });
});
