// ONE DECOMPOSITION PER GAP, INSIDE THE ESCALATION (09-30, qa B1). escalateToDecomposition is reached by the
// chronic-failure path (bumpFailedAttempts) and by feature_compose's repeated no-effect refusal. It reads the
// STORED row fresh and decomposes a gap at most once, the rule gap_falsify put on the investigation caller (606
// decompositions on one gap): already decomposed with steps -> nothing dispatched; already decomposed without
// steps -> the investigation walk only; never decomposed -> decomposition first.
//
// Driven through the real escalateToDecomposition and the real store, with globalThis.fetch standing in for
// discovery (the LLM lookup decomposition makes first) and goal-host's /run-goal.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `esc-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const RUN = Math.random().toString(36).slice(2, 8);
// The policy reads (autonomyScope, spendEnvelope) fail closed when they cannot be read or hold no record, so this
// fixture answers them as a read that SUCCEEDS and finds the explicit open records (unrestricted, uncapped).
const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
const originalFetch = globalThis.fetch;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
let llmLookups = 0;
let runGoals = 0;
let storeFile = "";
let storeBefore: string | null = null;

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  storeFile = join(root, "gaps", "gaps.json");
  try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const policy = explicitOpenPolicy(body);
    if (policy) return policy;
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") llmLookups++;
      return Response.json({ content: { vessels: [] } });
    }
    if (url.endsWith("/run-goal")) { runGoals++; return Response.json({ ok: true }); }
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function stored(suffix: string, meta: Record<string, unknown>): Promise<Record<string, unknown>> {
  const gap = { id: `esc-guard-${suffix}-${RUN}`, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `stuck gap ${suffix}`, classification_metadata: { edit_site: "repos/fixture-vessel/src/x.ts", ...meta } };
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  return gap;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("escalateToDecomposition decomposes a gap at most once, by the stored row", () => {
  it("already decomposed with steps: nothing dispatched, no LLM lookup, no walk", async () => {
    const g = await stored("with-steps", { decomposed_at: "2026-09-29T00:00:00Z", decomposition: { children: ["x-step-1"], reason: "wrote 1 step(s)" } });
    const l0 = llmLookups, r0 = runGoals;
    const out = await g2f.escalateToDecomposition({ id: g.id, summary: g.summary }, "test");
    await settle();
    expect(out).toBe("not dispatched: already decomposed at 2026-09-29T00:00:00Z");
    expect([llmLookups - l0, runGoals - r0]).toEqual([0, 0]);
  });

  it("the caller's copy does not decide: a stale copy without decomposed_at is still refused by the stored row", async () => {
    const g = await stored("stale-copy", { decomposed_at: "2026-09-29T01:00:00Z", decomposition: { children: ["y-step-1"], reason: "wrote 1 step(s)" } });
    const out = await g2f.escalateToDecomposition({ id: g.id, summary: g.summary, classification_metadata: { edit_site: "repos/fixture-vessel/src/x.ts" } }, "test");
    expect(out).toBe("not dispatched: already decomposed at 2026-09-29T01:00:00Z");
  });

  it("already decomposed without steps: no second decomposition, the investigation walk runs", async () => {
    const g = await stored("no-steps", { decomposed_at: "2026-09-29T02:00:00Z", decomposition: { children: [], reason: "no valid step" } });
    const l0 = llmLookups, r0 = runGoals;
    const out = await g2f.escalateToDecomposition({ id: g.id, summary: g.summary }, "test");
    await settle();
    expect(out).toContain("dispatched: investigation");
    expect([llmLookups - l0, runGoals - r0]).toEqual([0, 1]);
  });

  it("positive control: a gap never decomposed is decomposed first (the LLM producer is looked up)", async () => {
    const g = await stored("fresh", {});
    const l0 = llmLookups;
    const out = await g2f.escalateToDecomposition({ id: g.id, summary: g.summary, classification_metadata: { edit_site: "repos/fixture-vessel/src/x.ts" } }, "test");
    await settle();
    expect(out).toBe("dispatched: decomposition, then investigation");
    expect(llmLookups - l0).toBe(1);
  });

  it("a gap the store does not hold is not dispatched (fail closed)", async () => {
    expect(await g2f.escalateToDecomposition({ id: `esc-guard-absent-${RUN}` }, "test")).toBe("not dispatched: the stored row could not be read");
  });
});
