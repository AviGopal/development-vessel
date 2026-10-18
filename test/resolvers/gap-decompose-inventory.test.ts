// THE DRAFTER IS SHOWN THE FILES IT MAY NAME AND THE SCOPE IT WILL BE HELD TO, AND IS GIVEN ROOM TO ANSWER.
//
// decomposeGap's prompt required "each step changes exactly ONE existing source file" but listed no source files, and
// armDecomposition then refused steps for naming a file that does not exist or one the autonomy scope excludes. The
// prompt now carries the edit-site vessel's src files (the test inventory's walk, under its bounds) minus those the
// arming's own scope test would refuse, and those exclusions. And max_tokens was 1200 whatever the prompt asked for, so
// a full reply could be cut off mid-JSON and read as "unparseable decomposition"; it is now sized from the schema the
// prompt states, times the step bound it states.
// Harness: as gap-falsify-v2-decompose.test.ts (temp clones, real store, fetch stubbed); the autonomy scope through
// gap-policy's own test seam.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gd-inventory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state under the temp root, never /workspace
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { decomposeGap } = g2f;

const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const WIDGET = "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n";
const EXCLUDED = `repos/${VESSEL}/src/gadget.ts`;
const DEEP_DIR = "src/a/b/c/d/e/f/g";
const originalFetch = globalThis.fetch;
const llmBodies: Array<Record<string, unknown>> = [];

const shapeDescriptions = async () => ({ widget_frame_report: "counts widget frames rejected by the frame validator (defects)" });
const deps = (prompts: string[], reply: unknown = { steps: [] }) => ({
  llm: async (prompt: string) => { prompts.push(prompt); return typeof reply === "string" ? reply : JSON.stringify(reply); },
  shapeDescriptions,
});
async function parentGap(tag: string, meta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const gap = { id: `gd-inv-${tag}-${RUN}`, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(),
    summary: `The frame check validateFrame accepts a zero frame (${tag})`, classification_metadata: { edit_site: `repos/${VESSEL}/src/widget.ts`, ...meta } };
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never, { vocabulary: null } as never);
  return gap;
}
/** The block of the prompt under `heading`, up to the next blank line. */
const block = (prompt: string, heading: string): string => {
  const at = prompt.indexOf(heading);
  if (at < 0) return "";
  const end = prompt.indexOf("\n\n", at);
  return prompt.slice(at, end < 0 ? undefined : end);
};
const containedScope = () => g2fPolicy.__setAutonomyScopeDepsForTests({ live: async () => ({ excluded: [EXCLUDED], readable: true, reason: "test fixture: one excluded file" }) });

let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  sg.__setFleetVocabularyForTests({ v: null });
  for (const base of [CLONES, RUNTIME]) {
    mkdirSync(join(base, VESSEL, "src", "lib"), { recursive: true });
    mkdirSync(join(base, VESSEL, "test"), { recursive: true });
    writeFileSync(join(base, VESSEL, "src", "widget.ts"), WIDGET);
    writeFileSync(join(base, VESSEL, "src", "gadget.ts"), "export const gadget = 1;\n");
    writeFileSync(join(base, VESSEL, "src", "lib", "frames.ts"), "export const frames = 1;\n");
    writeFileSync(join(base, VESSEL, "src", "lib", "frames.test.ts"), 'import { it } from "bun:test";\nit("frames", () => {});\n');
    writeFileSync(join(base, VESSEL, "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\n');
    // below the walk's depth bound: never collected by the walk
    mkdirSync(join(base, VESSEL, DEEP_DIR), { recursive: true });
    writeFileSync(join(base, VESSEL, DEEP_DIR, "deep.ts"), WIDGET);
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    const cap = body?.pointer ?? body?.impulse?.pointer;
    if (cap?.type === "vesselCapability") {
      if (cap.shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.inventory.test", resolve_endpoint: "/resolve" }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url === "http://llm.inventory.test/resolve" && body?.type === "llm_completion") { llmBodies.push(body); return Response.json({ content: JSON.stringify({ steps: [] }) }); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { g2fPolicy.__setAutonomyScopeDepsForTests(null); });
afterAll(async () => {
  await gapStore?.restore();
  sg.__setFleetVocabularyForTests(null);
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2fPolicy.__resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the decompose prompt names what a step may change", () => {
  it("MUST-FAIL the prompt lists the vessel's source files and the scope exclusions the arming would apply", async () => {
    containedScope();
    const prompts: string[] = [];
    await decomposeGap(await parentGap("listed"), { deps: deps(prompts) });
    expect(prompts.length).toBe(1);
    const sources = block(prompts[0]!, `SOURCE FILES IN repos/${VESSEL}`);
    expect(sources).toContain("src/widget.ts");
    expect(sources).toContain("src/lib/frames.ts");
    // the edit site first (it survives the list's bound), tests and out-of-scope files never
    expect(sources.split("\n")[1]).toBe("src/widget.ts");
    expect(sources).not.toContain("frames.test.ts");
    expect(sources).not.toContain("gadget.ts");
    expect(block(prompts[0]!, "OUTSIDE THE AUTONOMY SCOPE")).toContain(EXCLUDED);
  });

  it("MUST-FAIL the edit site leads the list even where the walk's bounds did not reach it", async () => {
    containedScope();
    const prompts: string[] = [];
    await decomposeGap(await parentGap("deep", { edit_site: `repos/${VESSEL}/${DEEP_DIR}/deep.ts` }), { deps: deps(prompts) });
    expect(block(prompts[0]!, `SOURCE FILES IN repos/${VESSEL}`).split("\n")[1]).toBe(`${DEEP_DIR}/deep.ts`);
  });

  it("MUST-FAIL a directed decomposition is told the scope does not refuse its steps, and the excluded file is nameable", async () => {
    containedScope();
    const prompts: string[] = [];
    await decomposeGap(await parentGap("directed"), { directed: true, deps: deps(prompts) });
    expect(block(prompts[0]!, `SOURCE FILES IN repos/${VESSEL}`)).toContain("src/gadget.ts");
    expect(block(prompts[0]!, "OUTSIDE THE AUTONOMY SCOPE")).toContain("directed work");
  });

  it("CONTROL a step naming a listed, in-scope file still arms", async () => {
    containedScope();
    const prompts: string[] = [];
    const parent = await parentGap("arms");
    const step = { edit_site: `repos/${VESSEL}/src/widget.ts`, change: "make validateFrame reject a zero frame so countRejected counts it", falsifier: { expected_literal: `invLiteral_${RUN}`, reader: "validateFrame" } };
    const d = await decomposeGap(parent, { deps: deps(prompts, { steps: [step] }) });
    await sg.__settleBirthEvaluationsForTests();
    expect(prompts.length).toBe(1);
    expect(d.written).toEqual([`${String(parent.id)}-step-1`]);
  });

  it("CONTROL a step naming the excluded file is still refused by the arming, with its pinned reason", async () => {
    containedScope();
    const step = { edit_site: EXCLUDED, change: "make gadget reject a zero frame", falsifier: { expected_literal: `invGadget_${RUN}`, reader: "gadget" } };
    const d = await decomposeGap(await parentGap("refused"), { deps: deps([], { steps: [step] }) });
    expect(d.written).toEqual([]);
    expect(d.reason).toContain(`step 1: ${EXCLUDED} is inside the autonomy scope`);
  });

  it("CONTROL an unparseable reply keeps its pinned reason", async () => {
    const d = await decomposeGap(await parentGap("unparse"), { deps: deps([], "no json here") });
    expect(d.reason).toBe("unparseable decomposition");
    expect(d.raw_len).toBe("no json here".length);
  });
});

describe("the decompose call has room for the reply the prompt asks for", () => {
  // The reply the prompt asks for at its own stated bound: that many steps of the step schema the prompt states, each
  // <placeholder> filled with a one-sentence value, as a reply of raw_len chars (the evidence an unparseable reply
  // logs), against the chars max_tokens allows at the vessel's chars-per-token estimate.
  const statedFullReplyChars = (prompt: string): number => {
    const bound = Number(/Decompose it into 1 to (\d+) SMALL steps/.exec(prompt)?.[1] ?? NaN);
    const from = prompt.indexOf('"steps":[') + '"steps":['.length;
    const stepSchema = prompt.slice(from, prompt.indexOf('],"cannot_falsify"', from));
    const filled = stepSchema.replace(/<[^>]*>/g, "x".repeat(300));
    expect(bound).toBeGreaterThan(0);
    expect(stepSchema).toContain('"edit_site"');
    return `{"steps":[${Array.from({ length: bound }, () => filled).join(",")}],"cannot_falsify":"${"x".repeat(200)}"}`.length;
  };

  it("MUST-FAIL max_tokens covers the stated step bound times the stated step schema", async () => {
    llmBodies.length = 0;
    await decomposeGap(await parentGap("budget"), { deps: { shapeDescriptions } });
    expect(llmBodies.length).toBe(1);
    const prompt = String(llmBodies[0]!.prompt);
    const maxTokens = Number(llmBodies[0]!.max_tokens);
    expect(maxTokens * 4).toBeGreaterThanOrEqual(statedFullReplyChars(prompt));
  });

  it("MUST-FAIL a parent-check call is given more room than a steps-only call (the budget follows what is asked)", async () => {
    llmBodies.length = 0;
    await decomposeGap(await parentGap("budget-steps"), { deps: { shapeDescriptions } });
    await decomposeGap(await parentGap("budget-pc"), { parentCheck: true, deps: { shapeDescriptions } });
    expect(llmBodies.length).toBe(2);
    expect(Number(llmBodies[1]!.max_tokens)).toBeGreaterThan(Number(llmBodies[0]!.max_tokens));
  });
});
