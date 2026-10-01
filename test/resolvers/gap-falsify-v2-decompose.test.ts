// gap_falsify v2, the proposer half. decomposeGap's parent-check mode asks the SAME bounded LLM call for a class-2
// check on the parent gap itself (k=0), validates it through the SAME chain as the steps, and writes it only if the
// one judge reads it 'present' on today's tree. The call is shown what exists to be named (law 8): the advertised
// read shapes and the edit-site vessel's test files and matching test names. The investigation caller decomposes a
// gap at most once (decomposed_at), as the scan's pass already did.
//
// Driven through the real decomposeGap, the real validation, the real judge and the real store, with the LLM and
// the shape descriptions injected and globalThis.fetch standing in for discovery and the vessel's own resolve.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gf2-decompose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests } = sg;
const { decomposeGap, bumpFailedAttempts, __resetPolicyReadsForTests } = g2f;

const RUN = Math.random().toString(36).slice(2, 8);
const CLONES = join(ROOT, "clones");
const ADVERTISED = new Set(["test_suite", "widget_frame_report", "poolImpulse", "uiPanel_write"]);
const tree: Record<string, "pass" | "fail"> = { "widget counts rejected frames": "fail", "widget already passes": "pass" };
const DESCRIPTIONS: Record<string, string> = {
  widget_frame_report: "counts widget frames rejected by the frame validator (defects)",
  unrelated_report: "reports the weather",
  uiPanel_write: "writes a ui panel",
};
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let testSuiteCalls = 0;
let llmLookups = 0;
let runGoalCalls = 0;
let frameDefects = 2;
let llmMode: "none" | "serve" = "none";
let frameReportCalls = 0;
const FWD = "http://holder.test/v2/impulses/resolve";
const forwarded: Array<Record<string, unknown>> = [];
let llmReply: Record<string, unknown> = {};

function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") { llmLookups++; return Response.json({ content: { vessels: llmMode === "serve" ? [{ endpoint: "http://llm.test", resolve_endpoint: "/resolve" }] : [] } }); }
      const vessels = ADVERTISED.has(body.pointer.shape) ? [{ vesselId: "dv", endpoint: "http://node.test", resolve_endpoint: "/v2/impulses/resolve" }] : [];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: vessels.length > 0 } });
    }
    if (body?.impulse?.type === "poolImpulse") return Response.json({ body: { impulses: [] } });
    if (url === FWD) {
      const fp = body?.impulse?.pointer ?? {};
      if (fp.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [] } });
      forwarded.push(fp);
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "created" } });
    }
    if (url.endsWith("/run-goal")) { runGoalCalls++; return Response.json({ ok: true }); }
    if (url === "http://llm.test/resolve" && body?.type === "llm_completion") return Response.json({ content: JSON.stringify(llmReply) });
    if (url.endsWith("/registry/shape-descriptions")) return Response.json({ shape_descriptions: DESCRIPTIONS });
    const p = body?.impulse?.pointer;
    if (p?.type === "test_suite") {
      testSuiteCalls++;
      const only = (p.only_tests ?? []) as string[];
      const notPassing = only.filter((t) => tree[t] !== "pass").length;
      return Response.json({ shape: "test_suite", body: { ran: true, requested_not_passing: notPassing } });
    }
    if (p?.type === "widget_frame_report") frameReportCalls++;
    if (p?.type === "widget_frame_report") return Response.json({ shape: "widget_frame_report", body: { defects: frameDefects } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const TS_CHECK = (name: string, file = "test/widget.test.ts") => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: file, only_tests: [name] }, zero_field: "requested_not_passing" } });
async function parentGap(suffix: string, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = `gf2-parent-${suffix}-${RUN}`;
  const gap = { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `The widget frame validator counts rejected frames wrong (${suffix})`, classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...meta } };
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
  return gap;
}
async function row(id: string): Promise<Record<string, unknown> | null> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  return ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id) ?? null;
}
const metaOf = (g: Record<string, unknown> | null) => ((g?.classification_metadata ?? {}) as Record<string, unknown>);
function stubLlm(reply: Record<string, unknown>, prompts: string[] = []) {
  return async (prompt: string) => { prompts.push(prompt); return JSON.stringify(reply); };
}
const deps = (reply: Record<string, unknown>, prompts: string[] = []) => ({ llm: stubLlm(reply, prompts), shapeDescriptions: async () => DESCRIPTIONS });

beforeAll(() => {
  for (const k of ["VESSELS_CLONE_ROOT", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  mkdirSync(join(CLONES, "fixture-vessel", "src"), { recursive: true });
  mkdirSync(join(CLONES, "fixture-vessel", "test"), { recursive: true });
  writeFileSync(join(CLONES, "fixture-vessel", "src", "widget.ts"), "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n");
  writeFileSync(join(CLONES, "fixture-vessel", "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\nit("widget already passes", () => {});\nit("unrelated gadget test", () => {});\n');
  install();
  __resetPolicyReadsForTests();
});
beforeEach(() => { frameDefects = 2; });
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("decomposeGap parent-check mode (k=0)", () => {
  it("(i) a proposed test_suite check that reads present on the tree is written onto the parent, evaluated once", async () => {
    const parent = await parentGap("valid");
    const before = testSuiteCalls;
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: TS_CHECK("widget counts rejected frames"), steps: [] }) });
    await __settleBirthEvaluationsForTests();
    expect(d.parent_check).toBe("written");
    const m = metaOf(await row(String(parent.id)));
    expect((m.evidence_resolve as { shape?: string }).shape).toBe("test_suite");
    expect(((m.evidence_resolve as { input?: { timeout_ms?: number } }).input ?? {}).timeout_ms).toBe(180000);
    expect(m.predicate_source).toBe("gap_falsify:parent_check");
    expect(m.falsifier).toBe("class2");
    expect(m.predicate_birth_verdict).toBe("present");
    expect(m.decomposed_at).toBeTruthy();
    expect(testSuiteCalls - before).toBe(1); // the proposer's run is handed to the seam, not repeated
  });

  it("(i') a proposed advertised read shape whose zero_field the judge reads as a present numeric count is written", async () => {
    const parent = await parentGap("shape");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } }, steps: [] }) });
    expect(d.parent_check).toBe("written");
    expect((metaOf(await row(String(parent.id))).evidence_resolve as { shape?: string }).shape).toBe("widget_frame_report");
  });

  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["an invented test file", TS_CHECK("widget counts rejected frames", "test/nonexistent.test.ts"), /does not exist/],
    ["an invented test name", TS_CHECK("widget counts phantom frames"), /is not in/],
    ["an unadvertised shape", { evidence_resolve: { shape: "invented_frame_report", input: {}, zero_field: "defects" } }, /not advertised/],
    ["a write shape", { evidence_resolve: { shape: "uiPanel_write", input: {}, zero_field: "defects" } }, /is a write/],
    ["a shape with no measured field", { evidence_resolve: { shape: "widget_frame_report", input: {} } }, /zero_field/],
    // qa C4 ruling (iv): only zero_field/nonzero_field on an advertised read shape, or test_suite +
    // requested_not_passing. A defect_field check is refused outright: a key the shape never returns reads fixed.
    ["a defect_field check", { evidence_resolve: { shape: "widget_frame_report", input: {}, defect_field: "defects" } }, /a defect_field check is refused: a missing key reads as fixed/],
    ["a defect_field beside a zero_field", { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects", defect_field: "defects" } }, /a missing key reads as fixed/],
    ["a test_suite check measured on another field", { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: ["widget counts rejected frames"] }, zero_field: "fail" } }, /judged by zero_field requested_not_passing/],
    // Whether the shape returns the field is proven by the judge on its real answer, not by its description:
    // widget_frame_report answers {defects}, so a zero_field it does not return reads unknown and is not written.
    ["a zero_field the shape does not return (the judge reads unknown)", { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "frames_dropped" } }, /its check reads unknown on the current tree/],
    ["a nonzero_field the shape does not return (the judge reads unknown)", { evidence_resolve: { shape: "widget_frame_report", input: {}, nonzero_field: "frames_ok" } }, /its check reads unknown on the current tree/],
    ["a literal", { expected_literal: "rejectedFrameCount" }, /literal is not a parent check/],
  ];
  for (const [what, check, why] of refused) {
    it(`(ii) ${what} is rejected by the existing validation and nothing is written`, async () => {
      const parent = await parentGap(what.replace(/\W+/g, "-"));
      const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [] }) });
      await __settleBirthEvaluationsForTests();
      expect(d.parent_check).toMatch(why);
      const m = metaOf(await row(String(parent.id)));
      expect(m.evidence_resolve).toBeUndefined();
      expect(m.expected_literal).toBeUndefined();
      expect(m.predicate_birth_verdict).toBeUndefined();
      expect(m.decomposed_at).toBeTruthy();
    });
  }

  it("(iii) a check that reads absent on the tree (its test already passes) is not written", async () => {
    const parent = await parentGap("absent");
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: TS_CHECK("widget already passes"), steps: [] }) });
    expect(d.parent_check).toMatch(/reads absent on the current tree/);
    expect(metaOf(await row(String(parent.id))).evidence_resolve).toBeUndefined();
  });

  it("a step class-2 check that reads absent is not written; one that reads present is, stamped present", async () => {
    const parent = await parentGap("steps");
    frameDefects = 0;
    const d0 = await decomposeGap(parent, { parentCheck: false, deps: deps({ steps: [{ edit_site: "repos/fixture-vessel/src/widget.ts", change: "validateFrame must reject zero frames and countRejected must use it", falsifier: { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } } }] }) });
    expect(d0.written).toEqual([]);
    expect(d0.reason).toMatch(/reads absent/);
    const parent2 = await parentGap("steps2");
    frameDefects = 3;
    const d1 = await decomposeGap(parent2, { parentCheck: false, deps: deps({ steps: [{ edit_site: "repos/fixture-vessel/src/widget.ts", change: "validateFrame must reject zero frames and countRejected must use it", falsifier: { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } } }] }) });
    await __settleBirthEvaluationsForTests();
    expect(d1.written).toEqual([`${String(parent2.id)}-step-1`]);
    expect(metaOf(await row(`${String(parent2.id)}-step-1`)).predicate_birth_verdict).toBe("present");
  });

  it("a step may not restate the parent check proposed in the same call", async () => {
    const parent = await parentGap("restate");
    const check = { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } };
    const d = await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: check, steps: [{ edit_site: "repos/fixture-vessel/src/widget.ts", change: "validateFrame must reject zero frames", falsifier: check }] }) });
    expect(d.parent_check).toBe("written");
    expect(d.written).toEqual([]);
    expect(d.reason).toMatch(/parent's own check/);
  });
});

describe("on a node whose gap store is held elsewhere", () => {
  it("a class-2 step is not judged here (the judge abstains off the holder): it is forwarded unstamped for the holder to judge", async () => {
    const parent = await parentGap("forwarding");
    const prev = process.env["GAP_STORE_ENDPOINT"];
    process.env["GAP_STORE_ENDPOINT"] = FWD;
    const calls0 = frameReportCalls;
    forwarded.length = 0;
    try {
      const d = await decomposeGap(parent, { deps: deps({ steps: [{ edit_site: "repos/fixture-vessel/src/widget.ts", change: "validateFrame must reject zero frames and countRejected must use it", falsifier: { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } } }] }) });
      expect(d.written).toEqual([`${String(parent.id)}-step-1`]);
    } finally { if (prev === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = prev; }
    expect(frameReportCalls - calls0).toBe(0);
    const step = forwarded.find((w) => String((w.gap as { id?: string } | undefined)?.id ?? "").endsWith("-step-1"));
    const m = ((step?.gap as { classification_metadata?: Record<string, unknown> } | undefined)?.classification_metadata ?? {});
    expect((m.evidence_resolve as { shape?: string } | undefined)?.shape).toBe("widget_frame_report");
    expect(m.predicate_birth_verdict).toBeUndefined();
  });
});

describe("the proposer is shown what exists (law 8)", () => {
  it("the prompt carries the advertised read shapes and the vessel's test files and matching test names", async () => {
    const parent = await parentGap("prompt");
    const prompts: string[] = [];
    await decomposeGap(parent, { parentCheck: true, deps: deps({ parent_check: null, steps: [] }, prompts) });
    expect(prompts.length).toBe(1);
    const p = prompts[0]!;
    expect(p).toContain("ADVERTISED READ SHAPES");
    expect(p).toContain("- test_suite:");
    expect(p).toContain("- widget_frame_report: counts widget frames rejected");
    expect(p).not.toContain("uiPanel_write");
    expect(p).toContain("TEST FILES IN repos/fixture-vessel:\ntest/widget.test.ts");
    expect(p).toContain("test/widget.test.ts :: widget counts rejected frames");
    expect(p).not.toContain(":: unrelated gadget test");
    expect(p).toContain('"parent_check"');
    const prompts2: string[] = [];
    await decomposeGap(await parentGap("prompt-steps-only"), { deps: deps({ steps: [] }, prompts2) });
    expect(prompts2[0]).toContain("ADVERTISED READ SHAPES"); // the steps are starved of the same facts
    expect(prompts2[0]).not.toContain('"parent_check"');
  });
});

describe("the investigation caller decomposes a gap at most once", () => {
  const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(20); };
  const chronic = async (suffix: string, extra: Record<string, unknown>) => {
    const g = await parentGap(suffix, { failed_attempts: 2, failure_lessons: [{ class: "semantic_reject", reason: "draft did not address it" }], ...extra });
    return (await row(String(g.id)))!;
  };
  it("positive control: a chronic gap with no decomposed_at is decomposed (the LLM producer is looked up)", async () => {
    const g = await chronic("inv-control", {});
    const llm0 = llmLookups, rg0 = runGoalCalls;
    await bumpFailedAttempts(g);
    await waitFor(() => runGoalCalls > rg0);
    expect(runGoalCalls).toBeGreaterThan(rg0);
    expect(llmLookups - llm0).toBeGreaterThanOrEqual(1);
  });
  it("a gap already decomposed is not decomposed again (no LLM lookup); the walk still runs when no step was written", async () => {
    const g = await chronic("inv-guard", { decomposed_at: "2026-09-29T00:00:00Z", decomposition: { children: [], reason: "no valid step" } });
    const llm0 = llmLookups, rg0 = runGoalCalls;
    await bumpFailedAttempts(g);
    await waitFor(() => runGoalCalls > rg0);
    expect(runGoalCalls).toBeGreaterThan(rg0);
    expect(llmLookups - llm0).toBe(0);
  });
});

describe("the gap_falsify pass runs decomposition in parent-check mode", () => {
  it("a falsifier:none gap with an edit site gets its own check from the scan, through the default LLM path", async () => {
    const { resolveGapLifecycleScan } = await import("../../src/resolvers/gap-lifecycle-scan.js");
    const id = `gf2-scan-${RUN}`;
    const now = new Date().toISOString();
    const gap = { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: now, created_at: now, updated_at: now, summary: "The widget frame validator counts rejected frames wrong (scan)", classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", falsifier: "none" } };
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
    const scanDir = join(ROOT, "scan");
    mkdirSync(join(scanDir, "proposals", ".applied"), { recursive: true });
    writeFileSync(join(scanDir, "gaps.json"), JSON.stringify([gap]));
    llmMode = "serve";
    llmReply = { parent_check: TS_CHECK("widget counts rejected frames"), steps: [] };
    // The scan appends its funnel history under WORKSPACE_ROOT read at call time; another suite may have
    // pointed it at a directory it has since removed.
    const prevWs = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = scanDir;
    mkdirSync(join(scanDir, "gaps"), { recursive: true });
    try {
      const r = (await resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath: join(scanDir, "gaps.json"), proposalsDir: join(scanDir, "proposals"), autoClose: false, devVesselImpulsesUrl: "http://scan-emit.test/v2/impulses/resolve" } as never)) as unknown as { body: { falsified_ids: string[] } };
      await __settleBirthEvaluationsForTests();
      expect(r.body.falsified_ids).toContain(id);
      const m = metaOf(await row(id));
      expect(m.predicate_source).toBe("gap_falsify:parent_check");
      expect(m.predicate_birth_verdict).toBe("present");
    } finally { llmMode = "none"; if (prevWs === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevWs; }
  });
});
