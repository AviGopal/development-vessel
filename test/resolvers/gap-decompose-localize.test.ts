// A PARENT WITH NO EDIT SITE IS DECOMPOSED AGAINST THE FILE ITS OWN EVIDENCE NAMES, OR NOT AT ALL.
//
// decomposeGap took the drafter's file only from meta.edit_site. With none, the prompt read "EDIT SITE (none)" with no
// excerpt and no test inventory, yet required each step to change one existing source file, and armDecomposition
// refused every step for naming none. The autonomous caller (the lifecycle scan) refuses before the LLM when there is
// no readable edit site; the on-request route did not. Now decomposeGap localizes the parent (localizeGap without the
// LLM, as the check supply does) and drafts against that file, and refuses before the LLM when nothing localises.
// Harness: as gap-falsify-v2-decompose.test.ts (temp clones, the LLM and shape descriptions injected, fetch stubbed),
// plus a temp runtime root, since localizeGap reads the runtime tree and the excerpt reads the clone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gd-localize-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { decomposeGap } = g2f;

const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const WIDGET = "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n";
const originalFetch = globalThis.fetch;

const deps = (prompts: string[], reply = JSON.stringify({ steps: [] })) => ({
  llm: async (prompt: string) => { prompts.push(prompt); return reply; },
  shapeDescriptions: async () => ({ widget_frame_report: "counts widget frames rejected by the frame validator (defects)" }),
});
const gap = (id: string, summary: string, meta: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary, classification_metadata: meta });

beforeAll(() => {
  for (const base of [CLONES, RUNTIME]) {
    mkdirSync(join(base, VESSEL, "src"), { recursive: true });
    mkdirSync(join(base, VESSEL, "test"), { recursive: true });
    writeFileSync(join(base, VESSEL, "src", "widget.ts"), WIDGET);
    writeFileSync(join(base, VESSEL, "src", "gadget.ts"), "export const gadget = 1;\n");
    writeFileSync(join(base, VESSEL, "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\n');
  }
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if ((body?.pointer ?? body?.impulse?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2fPolicy.__resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("decomposeGap with no edit site", () => {
  it("MUST-FAIL a parent whose summary names a symbol in one existing file is drafted against that file, its excerpt and its tests", async () => {
    const prompts: string[] = [];
    await decomposeGap(gap(`gd-loc-named-${RUN}`, "The frame check `validateFrame` accepts a zero frame, so `countRejected` undercounts", { vessel: VESSEL }), { deps: deps(prompts) });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("EDIT SITE (none)");
    expect(prompts[0]).toContain(`EDIT SITE repos/${VESSEL}/src/widget.ts (excerpt):`);
    expect(prompts[0]).toContain("export function validateFrame");
    expect(prompts[0]).toContain(`TEST FILES IN repos/${VESSEL}:\ntest/widget.test.ts`);
  });

  it("MUST-FAIL a parent that localises to nothing is refused before the LLM", async () => {
    const prompts: string[] = [];
    const d = await decomposeGap(gap(`gd-loc-nothing-${RUN}`, "something somewhere is a little off and nobody knows where"), { deps: deps(prompts) });
    expect(prompts.length).toBe(0);
    expect(d.written).toEqual([]);
    expect(d.reason).toContain("needs_information");
  });

  it("MUST-FAIL an unparseable reply is answered and logged with its length and its tail; the pinned reason is unchanged", async () => {
    const reply = "I could not produce JSON for this gap,\nsorry: the tail sentinel";
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    let d: { reason: string; raw_len?: number; raw_tail?: string };
    try { d = await decomposeGap(gap(`gd-loc-unparse-${RUN}`, "x", { edit_site: `repos/${VESSEL}/src/widget.ts` }), { deps: deps([], reply) }); }
    finally { console.log = origLog; }
    expect(d.reason).toBe("unparseable decomposition");
    expect(d.raw_len).toBe(reply.length);
    expect(d.raw_tail).toBe("I could not produce JSON for this gap, sorry: the tail sentinel");
    const line = logged.find((l) => l.includes(`gd-loc-unparse-${RUN}: unparseable decomposition`)) ?? "";
    expect(line).toContain(`reply ${reply.length} chars`);
    expect(line).toContain("sorry: the tail sentinel");
    expect(line).not.toContain("\n");
  });

  it("CONTROL a parent with an edit site is drafted against it, as before", async () => {
    const prompts: string[] = [];
    await decomposeGap(gap(`gd-loc-set-${RUN}`, "The frame check `validateFrame` accepts a zero frame", { edit_site: `repos/${VESSEL}/src/gadget.ts` }), { deps: deps(prompts) });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(`EDIT SITE repos/${VESSEL}/src/gadget.ts (excerpt):`);
    expect(prompts[0]).not.toContain("EDIT SITE (none)");
    // the whole prompt, fingerprinted, so a run on the parent tree and one on the fixed tree can be compared
    console.log(`CONTROL prompt sha256 ${new Bun.CryptoHasher("sha256").update(prompts[0]!.replaceAll(RUN, "<run>")).digest("hex")}`);
  });
});
