// THE DECOMPOSER LEARNS FROM ITS OWN REFUSALS AND ESCALATES LOCALISATION (gap row
// a-decomposition-refusal-is-never-written-back-as-a-failure-lesson-so-the-decomposer-repeats-the-same-refusal-and-never-escalates-localisation).
//
// The row's own check. decomposeGap's prompt reads the parent's failure_lessons (WHY ATTEMPTS FAILED), but a refusal of
// the arming (src/judge/gap-admission.ts armDecomposition) was recorded only in decomposition.reason, which no prompt
// reads, so the next call proposed the same refused step again. And with no edit site the parent was localised only by
// localizeGap(useLlm:false), so a parent the cheap localiser could not site was declined needs_information on every call.
// Must-fail (row): the refusal lesson appears in the next decomposeGap prompt; a parent the cheap localiser cannot site
// yields >= 1 child once the LLM localiser is tried. Control: the first call is unchanged.
//
// Harness: as test/resolvers/gap-decompose-refusal-lesson.test.ts (the real decomposeGap, arming, judge and in-process
// store; the LLM and shape descriptions injected; globalThis.fetch standing in for discovery and the LLM producer).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "../resolvers/gap-store-snapshot.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gd-r0-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state under the temp root, never /workspace
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, __setFleetVocabularyForTests } = sg;
const { decomposeGap } = g2f;

const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const ADVERTISED = new Set(["widget_frame_report", "poolImpulse"]); // poolImpulse: the autonomy scope and spend envelope are read from it (explicit open records)
const DESCRIPTIONS: Record<string, string> = { widget_frame_report: "counts widget frames rejected by the frame validator (defects)" };
const WIDGET = "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n";
const OWN_CHECK = { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } };
const REFUSAL = "step 1: its falsifier is the parent's own check, which one step will not flip";
const originalFetch = globalThis.fetch;

function install(): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") return Response.json({ content: { vessels: [] } });
      const vessels = ADVERTISED.has(body.pointer.shape) ? [{ vesselId: "dv", endpoint: "http://node.test", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] : [];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: vessels.length > 0 } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    const p = body?.impulse?.pointer;
    if (p?.type === "widget_frame_report") return Response.json({ shape: "widget_frame_report", body: { defects: 2 } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function parentGap(suffix: string, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = `gd-r0-${suffix}-${RUN}`;
  const gap = { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `The widget frame validator counts rejected frames wrong (${suffix})`, classification_metadata: { edit_site: `repos/${VESSEL}/src/widget.ts`, ...OWN_CHECK, ...meta } };
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
  return gap;
}
async function row(id: string): Promise<Record<string, unknown>> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error(`no row ${id}`);
  return g;
}
const lessonsOf = (g: Record<string, unknown>) => (((g.classification_metadata ?? {}) as Record<string, unknown>).failure_lessons ?? []) as Array<Record<string, unknown>>;
const restating = { steps: [{ edit_site: `repos/${VESSEL}/src/widget.ts`, change: "validateFrame must reject zero frames and countRejected must use it", falsifier: OWN_CHECK }] };
const deps = (prompts: string[], reply: Record<string, unknown> = restating) => ({
  llm: async (prompt: string) => { prompts.push(prompt); return JSON.stringify(reply); },
  shapeDescriptions: async () => DESCRIPTIONS,
});

let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  __setFleetVocabularyForTests({ v: null });
  for (const base of [CLONES, RUNTIME]) {
    mkdirSync(join(base, VESSEL, "src"), { recursive: true });
    mkdirSync(join(base, VESSEL, "test"), { recursive: true });
    writeFileSync(join(base, VESSEL, "src", "widget.ts"), WIDGET);
    writeFileSync(join(base, VESSEL, "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\n');
  }
  install();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(async () => {
  await gapStore?.restore();
  __setFleetVocabularyForTests(null);
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2fPolicy.__resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const TWIN = "fixture-twin";
const TWIN_SRC = (n: string) => `export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; } // ${n}\n`;
const twinGap = async (suffix: string, meta: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const id = `gd-r0-${suffix}-${RUN}`;
  const gap = { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: "The frame check `validateFrame` accepts a zero frame, so `countRejected` undercounts", classification_metadata: meta };
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
  return gap;
};
const rankPrompts: string[] = [];
function installRank(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.test", resolve_endpoint: "/resolve" }] } });
    if (url === "http://llm.test/resolve" && body?.type === "llm_completion") {
      const prompt = String(body.prompt ?? "");
      rankPrompts.push(prompt);
      const idx = /\[(\d+)\] repos\/fixture-twin\/src\/beta\.ts/.exec(prompt)?.[1] ?? "-1";
      return Response.json({ content: idx });
    }
    return inner(input as never, init);
  }) as unknown as typeof fetch;
}
const literalStep = { steps: [{ edit_site: `repos/${TWIN}/src/beta.ts`, change: "validateFrame must reject a zero frame and countRejected must call it", falsifier: { expected_literal: "rejectZeroFrame", reader: "countRejected" } }] };


describe("the decomposer reads its own refusal and escalates localisation", () => {
  it("MUST-FAIL after a 'falsifier is the parent's own check' refusal, the next decomposeGap prompt carries it as a lesson", async () => {
    const parent = await parentGap("own");
    const prompts: string[] = [];
    const d1 = await decomposeGap(parent, { deps: deps(prompts) });
    expect(d1.written).toEqual([]);
    expect(d1.reason).toBe(`no valid step: ${REFUSAL}`);
    await decomposeGap(await row(String(parent.id)), { deps: deps(prompts) });
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain(`WHY ATTEMPTS FAILED (most recent last):\n- decomposition_refusal: decomposition refused: ${REFUSAL}\n`);
    expect(lessonsOf(await row(String(parent.id))).map((l) => l.class)).toEqual(["decomposition_refusal"]);
  });

  it("CONTROL the first call is unchanged: no lesson in its prompt, and a call with no refusal writes none", async () => {
    const parent = await parentGap("first");
    const prompts: string[] = [];
    await decomposeGap(parent, { deps: deps(prompts) });
    expect(prompts[0]).toContain("WHY ATTEMPTS FAILED (most recent last):\n(none recorded)\n");
    const ok = await parentGap("clean");
    const w = await decomposeGap(ok, { deps: deps([], { steps: [{ edit_site: `repos/${VESSEL}/src/widget.ts`, change: "validateFrame must reject a zero frame and countRejected must call it", falsifier: { expected_literal: "rejectZeroFrame", reader: "countRejected" } }] }) });
    await __settleBirthEvaluationsForTests();
    expect(w.written).toEqual([`${String(ok.id)}-step-1`]);
    expect(lessonsOf(await row(String(ok.id)))).toEqual([]);
  });

  describe("localisation escalates to the LLM rank before needs_information", () => {
    beforeAll(() => {
      for (const base of [CLONES, RUNTIME]) {
        mkdirSync(join(base, TWIN, "src"), { recursive: true });
        writeFileSync(join(base, TWIN, "src", "alpha.ts"), TWIN_SRC("alpha"));
        writeFileSync(join(base, TWIN, "src", "beta.ts"), TWIN_SRC("beta"));
      }
      installRank();
    });

    it("MUST-FAIL a parent the cheap localiser cannot site is ranked by the LLM once and yields >= 1 child", async () => {
      rankPrompts.length = 0;
      const parent = await twinGap("twin", { vessel: TWIN });
      const prompts: string[] = [];
      const d = await decomposeGap(parent, { deps: deps(prompts, literalStep) });
      await __settleBirthEvaluationsForTests();
      expect(rankPrompts.length).toBe(1);
      expect(d.reason).not.toContain("needs_information");
      expect(prompts[0]).toContain(`EDIT SITE repos/${TWIN}/src/beta.ts (excerpt):`);
      expect(d.written).toEqual([`${String(parent.id)}-step-1`]);
    });

    it("CONTROL a parent that localises to nothing is still refused before the decomposer, with the same reason", async () => {
      const none = await twinGap("none", {});
      const p2: string[] = [];
      const d = await decomposeGap({ ...none, summary: "something somewhere is a little off and nobody knows where" }, { deps: deps(p2) });
      expect(p2.length).toBe(0);
      expect(d.written).toEqual([]);
      expect(d.reason).toBe("needs_information: no readable edit site (no edit_site and nothing localises)");
    });
  });
});
