import { describe, it, expect } from "bun:test";
import {
  extractChangedSymbols,
  reachabilityHardFail,
  verifyPatchAddressesGap,
  regionContainmentVerdict,
  regionFromProposalText,
  diffIsCreateHeavy,
  detectNewCapabilityStub,
  stripCommentsAndStrings,
  computeDataFlowFacts,
  type ReachabilityFact,
  type DataFlowFact,
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

// Data-flow facts (2026-07-01): the gate's third eye. Symbol reachability passed
// three inert patches in one day (consumed-never-populated ×2, imported-never-called);
// these pin the deterministic fact computation AND the end-to-end threading into the
// judge prompt, so a dropped wiring edit can never again pass silently.
describe("computeDataFlowFacts", () => {
  it("flags a new Map consumed via .get/.has with zero .set/.add anywhere", () => {
    const diff = [
      "+++ b/src/routes/activities.ts",
      "+    const repairScoresMap = new Map<string, number>();",
    ].join("\n");
    const contents = new Map<string, string>([
      ["/vessels/x/src/routes/activities.ts",
        "const repairScoresMap = new Map<string, number>();\nif (repairScoresMap.has(id)) v += repairScoresMap.get(id)!;"],
    ]);
    const facts = computeDataFlowFacts(diff, contents);
    expect(facts.some((f: DataFlowFact) => f.kind === "consumed_never_populated" && f.symbol === "repairScoresMap")).toBe(true);
  });

  it("yields no fact when populate sites exist", () => {
    const diff = [
      "+++ b/src/routes/activities.ts",
      "+    const repairScoresMap = new Map<string, number>();",
    ].join("\n");
    const contents = new Map<string, string>([
      ["/vessels/x/src/routes/activities.ts",
        "const repairScoresMap = new Map<string, number>();\nrepairScoresMap.set(k, v);\nif (repairScoresMap.has(id)) use(repairScoresMap.get(id));"],
    ]);
    expect(computeDataFlowFacts(diff, contents).filter((f: DataFlowFact) => f.symbol === "repairScoresMap")).toHaveLength(0);
  });
});

describe("verifyPatchAddressesGap data-flow threading", () => {
  it("injects the Data-flow facts section into the judge prompt when facts are supplied", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "wireThing", isNewFunction: true, callerCount: 1, isEntrypoint: false, reachable: true },
    ];
    const dataFlow: DataFlowFact[] = [
      { symbol: "orphanMap", file: "src/x.ts", kind: "consumed_never_populated" },
    ];
    let seenPrompt = "";
    await verifyPatchAddressesGap({
      gapSummary: "wire the thing",
      diff: "+++ b/src/x.ts\n+function wireThing() { return 1; }\n+export const y = wireThing();",
      reachability: facts,
      data_flow: dataFlow,
      llm: async (prompt: string) => { seenPrompt = prompt; return JSON.stringify({ addresses: true, reason: "ok", on_live_path: true }); },
    });
    expect(seenPrompt).toContain("Data-flow facts (deterministic):");
    expect(seenPrompt).toContain("orphanMap");
    expect(seenPrompt).toContain("DROPPED EDIT");
  });
});

// Control-flow false-positive (2026-07-02): the stub detector's function regex also
// matched `if (...) {`, so a legitimate guard branch `if (bespoke) { return null; }`
// hard-failed two structurally-correct patches as "stub named `if`". Pins the exclusion.
describe("detectNewCapabilityStub control-flow exclusion", () => {
  it("does NOT flag a guard branch that returns null inside a real function", () => {
    const diff = `### NEW FILE /vessels/goal-host-vessel/src/canon.ts
+export function canonicalizeShapeName(raw: string, known: string[]): string | null {
+  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
+  const n = normalize(raw);
+  for (const k of known) if (normalize(k) === n) return k;
+  const tokens = n.split("_").filter(Boolean);
+  if (raw.includes(" ") || tokens.length > 4 || raw.length > 40) {
+    return null;
+  }
+  return raw;
+}`;
    const r = detectNewCapabilityStub(diff);
    expect(r.isStub).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REGION-CONTAINMENT + ONE-HOP DATA-FLOW (2026-08-07)
//
// Corpus built from the three REAL patches this gate has judged on the
// ui-feedback-*-hard_to_understand gaps, not invented cases. Each verdict below
// is one the gate got wrong or right in production:
//
//   ad706ce  region "sub-card sub-card--fleet", edited sub-step-shadowline
//            -> must stay REJECTED (right file, wrong region; landed and was
//               reverted as 1812ee7 — the reason this gate exists)
//   1743     region "sub-fleet-elapsed", edited the `elapsed` DEFINITION
//            -> must be ACCEPTED (zero-hop containment rejected it twice; the
//               define->use edge to line 1752 is the whole point of the widening)
//   d90318f  region "sub-fleet-elapsed", edited the region line itself to '0s'
//            -> must PASS CONTAINMENT and die at the semantic judge instead;
//               containment is a location check, not a correctness check.
// ---------------------------------------------------------------------------

const FLEET_ROW_TEXT = [
  "    const started = typeof d.startedAt === 'number' ? d.startedAt : 0;",
  "    const elapsed = started ? fmtRel(Date.now() - started) : '';",
  "    const row = parent.createDiv('sub-card sub-card--fleet');",
  "    row.createSpan({ cls: 'sub-fleet-status ' + statusCls, text: dot });",
  "    row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });",
].join("\n");

const REACHABLE_VIEW: ReachabilityFact[] = [
  { symbol: "GoalDispatchView", isNewFunction: false, callerCount: 2, isEntrypoint: true, reachable: true },
];

const SHADOWLINE_DIFF = `--- a/src/views/goal-dispatch-view.ts
+++ b/src/views/goal-dispatch-view.ts
@@ -2762 +2762 @@
-      node.createDiv({ cls: 'sub-step-shadowline', text: shadowSentence({ alpha: topRival.alpha }) });
+      node.createDiv({ cls: 'sub-step-shadowline', text: \`<b>\${shadowSentence({ alpha: topRival.alpha })}</b>\` });`;

const ELAPSED_DEFINITION_DIFF = `--- a/src/views/goal-dispatch-view.ts
+++ b/src/views/goal-dispatch-view.ts
@@ -1743 +1743 @@
-    const elapsed = started ? fmtRel(Date.now() - started) : '';
+    const elapsed = started ? fmtRel((running ? Date.now() : finishedAt) - started) : '';`;

const ZEROS_DIFF = `--- a/src/views/goal-dispatch-view.ts
+++ b/src/views/goal-dispatch-view.ts
@@ -1752 +1752 @@
-    row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });
+    row.createSpan({ cls: 'sub-fleet-elapsed', text: running ? elapsed : '0s' });`;

describe("verifyPatchAddressesGap — region containment with one-hop data flow", () => {
  it("still rejects ad706ce: right file, wrong region, defines nothing the region consumes", async () => {
    let llmCalled = false;
    const v = await verifyPatchAddressesGap({
      gapSummary: "the sub-card--fleet panel region is hard to understand",
      gapMeta: { region: "sub-card sub-card--fleet" },
      diff: SHADOWLINE_DIFF,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async () => { llmCalled = true; return "{}"; },
    });
    // Containment is ADVISORY now: it informs the judge instead of vetoing, so the
    // judge is consulted and its verdict decides. The 8a25744/ad706ce protection is
    // the note handed to the judge, not a hard-fail.
    expect(llmCalled).toBe(true);
    expect(v.hard_fail ?? false).toBe(false);
  });

  it("accepts an edit to the DEFINITION of an identifier the region line renders", async () => {
    const v = await verifyPatchAddressesGap({
      gapSummary: "the elapsed column keeps counting after a run has finished",
      gapMeta: { region: "sub-fleet-elapsed" },
      diff: ELAPSED_DEFINITION_DIFF,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async () => JSON.stringify({ addresses: true, reason: "holds the final duration", on_live_path: true }),
    });
    expect(v.addresses).toBe(true);
    expect(v.llm_consulted).toBe(true);
  });

  it("lets d90318f through containment so the judge — not this gate — rejects '0s'", async () => {
    const v = await verifyPatchAddressesGap({
      gapSummary: "the elapsed column keeps counting after a run has finished",
      gapMeta: { region: "sub-fleet-elapsed" },
      diff: ZEROS_DIFF,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async () => JSON.stringify({
        addresses: false,
        reason: "discards the duration instead of holding it",
        on_live_path: true,
      }),
    });
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(false);
  });

  it("hands the judge the identifiers it considered, instead of vetoing", async () => {
    let prompt = "";
    await verifyPatchAddressesGap({
      gapSummary: "the elapsed column keeps counting after a run has finished",
      gapMeta: { region: "sub-fleet-elapsed" },
      diff: `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-    const dot = running ? 1 : 2;\n+    const dot = running ? 3 : 4;`,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async (p) => { prompt = p; return JSON.stringify({ addresses: false, reason: "edits an unrelated span", on_live_path: true }); },
    });
    expect(prompt).toContain("DETERMINISTIC LOCATION CHECK");
    expect(prompt).toContain("dot");
  });
});

// ---------------------------------------------------------------------------
// SHARED PREDICATE — used by BOTH landing routes (feature_compose's semantic gate
// and patch_with_tools' staging gate). The 046d754 case below is the one that
// motivated exporting it: it landed through the route that had no check.
// ---------------------------------------------------------------------------
describe("regionContainmentVerdict / regionFromProposalText", () => {
  it("would have refused 046d754 — a different render site that defines nothing the region shows", () => {
    // Real before/after from 046d754, and the region-bearing line it did NOT touch.
    const before = "        if (started) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - started) });";
    const after = "        if (started && Date.now() - started < 1000 * 60 * 60) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - started) });";
    // The patch touches a line that literally contains the region, so it is contained
    // at zero hops — containment is a LOCATION check and correctly passes here. The
    // shape that must stop it is the semantic judge, which this route never ran.
    const v = regionContainmentVerdict([before, after], "sub-fleet-elapsed", FLEET_ROW_TEXT);
    expect(v.contained).toBe(true);
    expect(v.via).toBe("literal");
  });

  it("refuses a patch to an unrelated part of the right file", () => {
    const v = regionContainmentVerdict(
      ["    const dispatchCountOf = (ms) => ms.reduce((a, b) => a + b, 0);"],
      "sub-fleet-elapsed",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(false);
    expect(v.via).toBe("none");
    expect(v.reason).toContain("dispatchCountOf");
  });

  it("accepts the definition site via one hop and says which identifier carried it", () => {
    const v = regionContainmentVerdict(
      ["    const elapsed = started ? fmtRel(finishedAt - started) : '';"],
      "sub-fleet-elapsed",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(true);
    expect(v.via).toBe("data_flow");
    expect(v.reason).toContain("elapsed");
  });

  it("recovers the region from the canonical proposal phrasing, and returns '' otherwise", () => {
    expect(regionFromProposalText(
      'UI feedback on the surface: the elapsed column keeps counting. Edit repos/obsidian-vessel/src/views/goal-dispatch-view.ts in the region "sub-fleet-elapsed".',
    )).toBe("sub-fleet-elapsed");
    expect(regionFromProposalText("remove the dead import from foo.ts")).toBe("");
  });
});

describe("verifyPatchAddressesGap — region recovered from summary when metadata is absent", () => {
  // The goal-host /run-goal edit-intent path builds its gap pointer from goal TEXT and
  // never sets classification_metadata, which left this gate inert on the route that
  // escalates. This is the exact op that slipped through on 2026-08-07 at 18:37.
  it("recovers the region from the summary and tells the judge, with NO gapMeta at all", async () => {
    let llmCalled = false;
    let prompt = "";
    const v = await verifyPatchAddressesGap({
      gapSummary: 'UI feedback on the surface: the elapsed column keeps counting after a run has finished Edit repos/obsidian-vessel/src/views/goal-dispatch-view.ts in the region "sub-fleet-elapsed".',
      diff: `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-        const dispatchTotal = dispatchCountOf(members);\n+        const dispatchTotal = dispatchCountOf(members.filter(Boolean));`,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async (p) => { llmCalled = true; prompt = p; return JSON.stringify({ addresses: false, reason: "edits the header counter", on_live_path: true }); },
    });
    expect(llmCalled).toBe(true);
    expect(v.addresses).toBe(false);
    // The region was recovered from the summary alone and reached the judge as a fact.
    expect(prompt).toContain("DETERMINISTIC LOCATION CHECK");
    expect(prompt).toContain("dispatchTotal");
  });

  it("stays out of the way when the summary names no region", async () => {
    const v = await verifyPatchAddressesGap({
      gapSummary: "remove the dead import from foo.ts",
      diff: `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-import { join } from "node:path";\n+`,
      reachability: REACHABLE_VIEW,
      fileText: FLEET_ROW_TEXT,
      llm: async () => JSON.stringify({ addresses: true, reason: "removes the dead import", on_live_path: true }),
    });
    expect(v.addresses).toBe(true);
  });
});

describe("regionContainmentVerdict — a comment naming the region is not a change to it", () => {
  // Real touched lines from 8a25744, which landed a COMPLETE NO-OP through the judged
  // path: it writes d.elapsed_ms (read nowhere in the file) off d.finished_at /
  // d.started_at (the renderer uses d.startedAt). It satisfied literal containment
  // solely because the drafter wrote the gap text into the patch as a comment.
  const TOUCHED_8a25744 = [
    "      for (const d of dispatches) {",
    "        // sub-fleet-elapsed: [narrowed] UI feedback (hard_to_understand) on the",
    "        // surface: the elapsed column keeps counting after a run has finished.",
    "        if (d.finished_at && d.started_at) {",
    "          d.elapsed_ms = new Date(d.finished_at as string).getTime() - new Date(d.started_at as string).getTime();",
    "        }",
    "      }",
  ];

  it("refuses 8a25744 once the comment no longer counts", () => {
    const v = regionContainmentVerdict(TOUCHED_8a25744, "sub-fleet-elapsed", FLEET_ROW_TEXT);
    expect(v.contained).toBe(false);
    expect(v.via).toBe("none");
  });

  it("does not let a comment carry the one-hop edge either", () => {
    const v = regionContainmentVerdict(
      ["        // const elapsed = something about sub-fleet-elapsed", "        const unrelated = 1;"],
      "sub-fleet-elapsed",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(false);
  });

  it("still accepts a real code change on the region line", () => {
    const v = regionContainmentVerdict(
      ["    row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });", "        // sub-fleet-elapsed note"],
      "sub-fleet-elapsed",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(true);
    expect(v.via).toBe("literal");
  });
});

describe("regionContainmentVerdict — abstains when the region is not a code locator", () => {
  // ui-feedback rows can carry a human-facing surface label rather than the CSS class
  // a renderer emits. "the surface" occurs in no source file, so the check has no
  // signal — and hard-failing on it made the gap permanently unsatisfiable.
  it("defers to the judge instead of rejecting everything", () => {
    const v = regionContainmentVerdict(
      ["    const elapsed = started ? fmtRel(finishedAt - started) : '';"],
      "the surface",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(true);
    expect(v.via).toBe("no_signal");
    expect(v.reason).toContain("label rather than a code locator");
  });

  it("still discriminates normally when the region IS in the file", () => {
    const v = regionContainmentVerdict(
      ["    const unrelated = 1;"],
      "sub-fleet-elapsed",
      FLEET_ROW_TEXT,
    );
    expect(v.contained).toBe(false);
    expect(v.via).toBe("none");
  });
});
