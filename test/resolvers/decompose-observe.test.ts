// AN OBSERVE DECOMPOSITION DRAFTS AND VALIDATES EXACTLY AS A LEARN ONE, AND WRITES NOTHING.
//
// The dry run's decomposer probe is an observe goal ("investigate and decompose", variables.decompose_gap_id); the walk
// resolves gapDecomposition -> resolveGapToFeature's decompose_gap_id branch -> decomposeGap -> armDecomposition, and
// none of it read the mode: it wrote the child gaps (<gap>-step-<k>), the parent's decomposed_at/decomposition and the
// birth verdicts onto the live store. The probe exists to READ the decomposer's output, so the draft (the one bounded LLM
// call) and the arming's per-step validation still run. CONTRACT, driven through the real gapDecomposition dispatch
// (resolveDispatch) over the real store under a temp root, the LLM producer and policy reads stubbed on fetch:
//   - [MUST-FAIL] observe: zero gap-store writes (the store file is byte-identical); the answer says observe, written
//     and created are empty, and would_be_children carry each drafted step's id, edit site, check and verdict: a step
//     on an existing in-scope file with a readable check is refusal null, a step on a NON-EXISTENT file carries the
//     arming's own refusal ("... does not exist", the text a learn decomposition records); the edit site the draft
//     was given rides the answer; the [gap-decompose] line is still logged;
//   - [MUST-FAIL] observe, unparseable reply: raw_len and raw_tail ride the answer, nothing is written;
//   - [CONTROL] observe, no readable edit site: the needs_information refusal before the LLM, nothing written;
//   - [CONTROL] learn: the same dispatch writes the valid step and the parent's decomposition, as before.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `decompose-observe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { resolveDispatch } = await import("../../src/routes/impulses.js");

const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const SITE = `repos/${VESSEL}/src/widget.ts`;
const MISSING = `repos/${VESSEL}/src/nope.ts`;
const WIDGET = "export function validateFrame(f: number): boolean {\n  return f > 0;\n}\nexport function countRejected(fs: number[]): number { return fs.filter((f) => !validateFrame(f)).length; }\n";
const STEPS = JSON.stringify({ steps: [
  { edit_site: SITE, change: "replace the comparison in validateFrame so a zero frame is rejected through frameFloorGuard", falsifier: { expected_literal: "frameFloorGuard", reader: "validateFrame" } },
  { edit_site: MISSING, change: "replace the frame comparison in the missing module with frameFloorGuard", falsifier: { expected_literal: "frameFloorGuard", reader: "validateFrame" } },
] });
let reply = STEPS;
let llmCalls = 0;
let storeFile = "";
let storeBefore: string | null = null;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  for (const base of [CLONES, RUNTIME]) {
    mkdirSync(join(base, VESSEL, "src"), { recursive: true });
    writeFileSync(join(base, VESSEL, "src", "widget.ts"), WIDGET);
  }
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  storeFile = join(root, "gaps", "gaps.json");
  try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    const cap = body?.pointer ?? body?.impulse?.pointer;
    // The policy reads (autonomyScope) find the pool, then the explicit open records (unrestricted).
    if (cap?.type === "vesselCapability" && cap.shape === "poolImpulse") return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    if (cap?.type === "vesselCapability" && cap.shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.fixture", resolve_endpoint: "/resolve" }] } });
    if (cap?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (url.startsWith("http://llm.fixture") && body?.type === "llm_completion") { llmCalls++; return Response.json({ content: reply }); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore);
  g2fPolicy.__resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function storedParent(suffix: string, meta: Record<string, unknown> = { edit_site: SITE }, summary = "The frame check `validateFrame` accepts a zero frame, so `countRejected` undercounts"): Promise<string> {
  const id = `dec-obs-${suffix}-${RUN}`;
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: meta } } as never);
  return id;
}
async function row(id: string): Promise<Record<string, unknown> | null> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((g) => g.id === id) ?? null;
}
async function dispatch(id: string, observe: boolean): Promise<{ body: Record<string, any>; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const r = await resolveDispatch({ type: "gapDecomposition", decompose_gap_id: id, ...(observe ? { learning_mode: "observe" } : {}) });
    await new Promise((res) => setTimeout(res, 50));
    return { body: (r.body ?? {}) as Record<string, any>, logs };
  } finally { console.log = orig; }
}

describe("an observe decomposition writes nothing and reports what it would write", () => {
  it("[MUST-FAIL] observe: zero gap-store writes; would-be children carry their verdicts (in-scope null, missing file refused)", async () => {
    const id = await storedParent("observe");
    reply = STEPS;
    const before = readFileSync(storeFile, "utf8");
    const l0 = llmCalls;
    const { body, logs } = await dispatch(id, true);
    expect(llmCalls - l0).toBe(1); // the draft still runs
    expect(readFileSync(storeFile, "utf8")).toBe(before); // nothing written: no child, no parent decomposition
    expect(await row(`${id}-step-1`)).toBeNull();
    expect(((await row(id))?.classification_metadata as Record<string, unknown>).decomposed_at).toBeUndefined();
    expect(body.observe).toBe(true);
    expect(body.children).toEqual([]);
    expect(body.created).toEqual([]);
    expect(body.edit_site).toBe(SITE);
    expect(String(body.excerpt)).toContain("validateFrame");
    const kids = body.would_be_children as Array<Record<string, unknown>>;
    expect(kids.map((k) => [k.id, k.edit_site])).toEqual([[`${id}-step-1`, SITE], [`${id}-step-2`, MISSING]]);
    expect(kids[0]!.refusal).toBeNull();
    expect(kids[0]!.check).toEqual({ expected_literal: "frameFloorGuard", literal_reader: "validateFrame" });
    expect(kids[1]!.refusal).toBe(`step 2: ${MISSING} does not exist`);
    expect(String(body.reason)).toContain("would write 1 step(s)");
    expect(logs.some((l) => l.startsWith(`[gap-decompose] ${id}: would write 1 step(s)`) && l.includes("(observe: nothing written)"))).toBe(true);
  });
  it("[MUST-FAIL] observe, unparseable reply: raw_len and raw_tail ride the answer, nothing is written", async () => {
    const id = await storedParent("unparse");
    reply = "no JSON here, sorry: the tail sentinel";
    const before = readFileSync(storeFile, "utf8");
    const { body } = await dispatch(id, true);
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect(body.observe).toBe(true);
    expect(body.reason).toBe("unparseable decomposition");
    expect(body.raw_len).toBe(reply.length);
    expect(body.raw_tail).toBe("no JSON here, sorry: the tail sentinel");
    expect(body.edit_site).toBe(SITE);
  });
  it("[CONTROL] observe, no readable edit site: the needs_information refusal before the LLM, nothing written", async () => {
    const id = await storedParent("noside", {}, "something somewhere is a little off and nobody knows where");
    const before = readFileSync(storeFile, "utf8");
    const l0 = llmCalls;
    const { body } = await dispatch(id, true);
    expect(llmCalls - l0).toBe(0);
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect(String(body.reason)).toContain("needs_information");
  });
  it("[CONTROL] learn: the same dispatch writes the valid step and the parent's decomposition", async () => {
    const id = await storedParent("learn");
    reply = STEPS;
    const { body } = await dispatch(id, false);
    expect(body.observe).toBeUndefined();
    expect(body.children).toEqual([`${id}-step-1`]);
    expect(body.created).toEqual([`${id}-step-1`]);
    expect(await row(`${id}-step-1`)).not.toBeNull();
    expect(((await row(id))?.classification_metadata as Record<string, unknown>).decomposed_at).toBeDefined();
    expect(String(body.reason)).toContain(`wrote 1 step(s); refused: step 2: ${MISSING} does not exist`);
  });
});
