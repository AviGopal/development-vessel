// A DECOMPOSITION REFUSAL IS WRITTEN BACK AS A FAILURE LESSON, SO THE NEXT CALL SEES IT.
//
// decomposeGap's prompt reads the parent's failure_lessons ("WHY ATTEMPTS FAILED"), but armDecomposition recorded its
// own refusals only in decomposition.reason, which no prompt reads: the next call proposed the same refused step again
// (e.g. a step whose falsifier is the parent's own check). The arming's one parent write now appends the call's
// refusals as one decomposition_refusal lesson.
//
// Harness: as gap-falsify-v2-decompose.test.ts (the real decomposeGap, arming, judge and in-process store; the LLM and
// shape descriptions injected; globalThis.fetch standing in for discovery and the vessel's own resolve). The second
// call is handed the parent row as the store holds it after the first, as the real callers read it. A second block
// pins that a parent the cheap localiser cannot site is tried with the LLM localiser before needs_information.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gd-refusal-lesson-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
  const id = `gd-rl-${suffix}-${RUN}`;
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
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s.replaceAll(RUN, "<run>")).digest("hex");

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

describe("a decomposition refusal is the next call's lesson", () => {
  it("MUST-FAIL after one 'falsifier is the parent's own check' refusal, the next decomposeGap prompt carries it (prompt golden)", async () => {
    const parent = await parentGap("own");
    const prompts: string[] = [];
    const d1 = await decomposeGap(parent, { deps: deps(prompts) });
    expect(d1.written).toEqual([]);
    expect(d1.reason).toBe(`no valid step: ${REFUSAL}`);
    const fresh = await row(String(parent.id));
    await decomposeGap(fresh, { deps: deps(prompts) });
    expect(prompts.length).toBe(2);
    // GOLDEN: the second prompt is the first with exactly the lesson line in WHY ATTEMPTS FAILED, nothing else.
    const before = "WHY ATTEMPTS FAILED (most recent last):\n(none recorded)\n";
    expect(prompts[0]).toContain(before);
    expect(prompts[1]).toBe(prompts[0]!.replace(before, `WHY ATTEMPTS FAILED (most recent last):\n- decomposition_refusal: decomposition refused: ${REFUSAL}\n`));
  });

  it("MUST-FAIL the refusal lesson is written once: an identical refusal on a later call appends nothing", async () => {
    const parent = await parentGap("dedupe");
    await decomposeGap(parent, { deps: deps([]) });
    const once = lessonsOf(await row(String(parent.id)));
    expect(once.map((l) => [l.class, l.reason])).toEqual([["decomposition_refusal", `decomposition refused: ${REFUSAL}`]]);
    await decomposeGap(await row(String(parent.id)), { deps: deps([]) });
    expect(lessonsOf(await row(String(parent.id))).length).toBe(1);
  });

  it("CONTROL the first call's prompt and outcome are unchanged; an observe call writes no lesson; a call with no refusal writes none", async () => {
    const parent = await parentGap("first");
    const prompts: string[] = [];
    const d = await decomposeGap(parent, { deps: deps(prompts) });
    expect(d.reason).toBe(`no valid step: ${REFUSAL}`);
    // the whole first prompt, fingerprinted, so a run on the parent tree and one on the fixed tree can be compared
    console.log(`CONTROL first-call prompt sha256 ${sha(prompts[0]!.replace(String(parent.id), "<parent>"))}`);
    const obs = await parentGap("observe");
    const o = await decomposeGap(obs, { deps: deps([]), observe: true });
    expect(o.reason).toBe(`no valid step: ${REFUSAL}`);
    expect(lessonsOf(await row(String(obs.id)))).toEqual([]);
    const ok = await parentGap("clean");
    const w = await decomposeGap(ok, { deps: deps([], { steps: [{ edit_site: `repos/${VESSEL}/src/widget.ts`, change: "validateFrame must reject a zero frame and countRejected must call it", falsifier: { expected_literal: "rejectZeroFrame", reader: "countRejected" } }] }) });
    await __settleBirthEvaluationsForTests();
    expect(w.written).toEqual([`${String(ok.id)}-step-1`]);
    expect(lessonsOf(await row(String(ok.id)))).toEqual([]);
  });
});

// THE LLM LOCALISER IS TRIED BEFORE needs_information. With no edit site, decomposeGap localised the parent only with
// localizeGap(useLlm:false) and declined as needs_information whenever the cheap localiser could not choose among
// comparable files; localizeGap's LLM rank (the escalation feature-compose already uses) was never tried there. The
// rank call is stubbed deterministically: it answers the index of beta.ts in the candidate list it is shown.
const TWIN = "fixture-twin";
const TWIN_SRC = (n: string) => `export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; } // ${n}\n`;
const twinGap = async (suffix: string, meta: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const id = `gd-rl-${suffix}-${RUN}`;
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

describe("decomposeGap escalates to the LLM localiser before declining as needs_information", () => {
  beforeAll(() => {
    for (const base of [CLONES, RUNTIME]) {
      mkdirSync(join(base, TWIN, "src"), { recursive: true });
      writeFileSync(join(base, TWIN, "src", "alpha.ts"), TWIN_SRC("alpha"));
      writeFileSync(join(base, TWIN, "src", "beta.ts"), TWIN_SRC("beta"));
    }
    installRank();
  });

  it("MUST-FAIL the ESCALATED call (the one the LLM localiser runs on) yields >= 1 child for a parent the cheap localiser cannot site", async () => {
    rankPrompts.length = 0;
    const parent = await twinGap("twin", { vessel: TWIN });
    const prompts: string[] = [];
    const d = await decomposeGap(parent, { deps: deps(prompts, literalStep) });
    await __settleBirthEvaluationsForTests();
    expect(rankPrompts.length).toBe(1);
    expect(d.reason).not.toContain("needs_information");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(`EDIT SITE repos/${TWIN}/src/beta.ts (excerpt):`);
    expect(d.written.length).toBeGreaterThanOrEqual(1);
    expect(d.written).toEqual([`${String(parent.id)}-step-1`]);
  });

  it("CONTROL a parent the cheap localiser sites is not ranked by the LLM; one that localises to nothing is still refused before the decomposer", async () => {
    rankPrompts.length = 0;
    const sited = await twinGap("sited", { vessel: VESSEL });
    const prompts: string[] = [];
    await decomposeGap(sited, { deps: deps(prompts, literalStep) });
    expect(rankPrompts.length).toBe(0);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(`EDIT SITE repos/${VESSEL}/src/widget.ts (excerpt):`);
    const none = await twinGap("none", {});
    const p2: string[] = [];
    const d = await decomposeGap({ ...none, summary: "something somewhere is a little off and nobody knows where" }, { deps: deps(p2) });
    expect(p2.length).toBe(0);
    expect(d.written).toEqual([]);
    expect(d.reason).toBe("needs_information: no readable edit site (no edit_site and nothing localises)");
  });
});
