// patch_with_tools REFUSES WHAT feature_compose ADMISSION REFUSES.
//
// Every compose refusal could escalate to patch_with_tools, which had no admission, and land through the cutover. pwt
// now asks compose-admission-core's composeAdmission over the same evidence feature_compose gathers (the stored row,
// its hold and lineage hold, composeEligibilitySkipReason, the check-supply ledger verdict) before any write.
//   MUST-FAIL: a pwt run for a stored UNARMED gap is refused (ineligible) before any tool call, with no file changed.
//   MUST-FAIL: a pwt run for a stored gap under operator_hold is refused (operator_hold).
//   MUST-FAIL: the apply-failure escalation for an unarmed stored gap reaches pwt and is refused there.
//   CONTROL: an ARMED stored gap proceeds to the tool calls, directly and through the escalation.
//   CONTROL: a run with no gap_id, or an id the store does not hold, proceeds (feature_compose admits those too).
//
// The gap rows are seeded into this process's own gap store file (gapStoreFilePath(), which must lie under the OS temp
// dir) and the file is restored afterwards. The vessels root is a temp sandbox. fetch is replaced with loopback stubs.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const iso = await isolateRuntimeRoot("pwt-admission", { who: "test/resolvers/pwt-admission.test.ts" });
const priorEndpoint = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
const { resolvePatchWithTools } = await import("../../src/resolvers/patch-with-tools.js");
const { gapStoreFilePath } = await import("../../src/resolvers/substrate-gap.js");
const landing = await import("../../src/judge/gap-landing-verdict.js");

const base = realpathSync(iso.root);
const vessels = join(base, "sandbox-vessels");
const ws = join(base, "ws");
const VESSEL = "demo-vessel";
const SUB = "src/resolvers/existing.ts";
const SITE = `repos/${VESSEL}/${SUB}`;
const ORIGINAL = "export function live(): number {\n  return 1;\n}\n";
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

const STORE = gapStoreFilePath();
const storeUnderTmp = STORE.startsWith(realpathSync(tmpdir()) + "/") || STORE.startsWith(tmpdir() + "/");
const storeBefore = existsSync(STORE) ? readFileSync(STORE, "utf8") : null;
const now = new Date().toISOString();
const row = (id: string, meta: Record<string, unknown>) => ({ id, category: "bug", source: "detector", summary: `pwt admission fixture ${id}`, status: "open", detected_at: now, created_at: now, updated_at: now, classification_metadata: { edit_site: SITE, ...meta } });
const UNARMED = "pwt-admission-fixture-unarmed";
const ARMED = "pwt-admission-fixture-armed";
const HELD = "pwt-admission-fixture-held";
if (storeUnderTmp) {
  const prior = storeBefore ? (JSON.parse(storeBefore) as unknown[]) : [];
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify([...prior, row(UNARMED, {}), row(ARMED, { falsifier: "class2" }), row(HELD, { falsifier: "class2", operator_hold: true })]));
}

const originalFetch = globalThis.fetch;
let calls: { tools: number; llm: number; offOrigin: string[] };
function stubFetch(): typeof fetch {
  let turn = 0;
  return (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") { calls.offOrigin.push(url); throw new Error(`network guard: ${url} is not a stub origin`); }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const role = body.pointer.shape === "llmCompletion" || body.pointer.shape === "llm_completion" ? "llm" : "tools";
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    if (url.endsWith("/llm")) {
      calls.llm++;
      const content = turn++ === 0
        ? JSON.stringify({ action: "call_tool", tool: "code_search", args: { path: SITE, pattern: "return 1" } })
        : JSON.stringify({ action: "fail", reason: "test script ends here" });
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    if (url.endsWith("/tools")) { calls.tools++; return new Response(JSON.stringify({ ok: true, matches: [{ line: 2, text: "  return 1;" }] }), { status: 200 }); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
const pwt = (over: Record<string, unknown> = {}) => resolvePatchWithTools({
  type: "patch_with_tools", proposal_text: "make live() return 2", target_file: SITE,
  vessels_root: vessels, workspace_root: ws, max_attempts: 1, max_iterations: 2, ...over,
} as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeEach(() => {
  mkdirSync(join(vessels, VESSEL, "src", "resolvers"), { recursive: true });
  writeFileSync(join(vessels, VESSEL, SUB), ORIGINAL);
  mkdirSync(ws, { recursive: true });
  calls = { tools: 0, llm: 0, offOrigin: [] };
  globalThis.fetch = stubFetch();
});
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => {
  if (storeUnderTmp) { if (storeBefore === null) writeFileSync(STORE, "[]"); else writeFileSync(STORE, storeBefore); }
  if (priorEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = priorEndpoint;
});

describe("patch_with_tools applies feature_compose's admission", () => {
  it("the fixture store is this process's own temp store", () => { expect(storeUnderTmp).toBe(true); });

  it("MUST-FAIL: a stored unarmed gap is refused (ineligible) before any tool call; nothing changes", async () => {
    const before = sha(join(vessels, VESSEL, SUB));
    const r = await pwt({ gap_id: UNARMED, proposal_id: UNARMED });
    expect({ shape: r.shape, stage: r.body.stage, verdict: r.body.verdict }).toEqual({ shape: "structuredError", stage: "ineligible", verdict: "REFUSED" });
    expect(calls.tools).toBe(0);
    expect(calls.llm).toBe(0);
    expect(sha(join(vessels, VESSEL, SUB))).toBe(before);
    expect(existsSync(join(ws, "mitosis-pending.json"))).toBe(false);
  });

  it("MUST-FAIL: a stored gap under operator_hold is refused (operator_hold) before any tool call", async () => {
    const r = await pwt({ gap_id: HELD, proposal_id: HELD });
    expect({ stage: r.body.stage, verdict: r.body.verdict }).toEqual({ stage: "operator_hold", verdict: "BUSY" });
    expect(calls.tools).toBe(0);
  });

  it("MUST-FAIL: the apply-failure escalation for an unarmed stored gap is refused at pwt", async () => {
    const replies: Array<{ body?: Record<string, unknown> }> = [];
    const gap = row(UNARMED, {}) as Record<string, unknown>;
    await landing.escalateApplyFailureToPwt(gap, { ok: false, apply_failed: true, op_count: 1, rolled_back: true, verdict: "UNFAVORABLE" }, "make live() return 2", { predicted: false, p: 0.2 }, {
      resolvePwt: async (p: Record<string, unknown>) => { const r = await pwt({ ...p, vessels_root: vessels, workspace_root: ws }); replies.push(r); return r as never; },
      updateClassPosterior: () => { /* stubbed */ },
      bumpFailedAttempts: async () => { /* stubbed */ },
      closeLandedGap: async () => ({ closed: true }),
      persistGapMeta: async () => { /* stubbed */ },
      holdStillHeld: () => true,
    } as never);
    expect(replies.length).toBe(1);
    expect(replies[0]!.body?.stage).toBe("ineligible");
    expect(calls.tools).toBe(0);
  });

  it("CONTROL: an armed stored gap proceeds to the tool calls, directly and through the escalation", async () => {
    const r = await pwt({ gap_id: ARMED, proposal_id: ARMED });
    expect(r.body.stage).not.toBe("ineligible");
    expect(calls.tools).toBeGreaterThan(0);
    calls = { tools: 0, llm: 0, offOrigin: [] };
    globalThis.fetch = stubFetch();
    const replies: Array<{ body?: Record<string, unknown> }> = [];
    await landing.escalateApplyFailureToPwt(row(ARMED, { falsifier: "class2" }) as Record<string, unknown>, { ok: false, apply_failed: true, op_count: 1, rolled_back: true, verdict: "UNFAVORABLE" }, "make live() return 2", { predicted: false, p: 0.2 }, {
      resolvePwt: async (p: Record<string, unknown>) => { const res = await pwt({ ...p, vessels_root: vessels, workspace_root: ws }); replies.push(res); return res as never; },
      updateClassPosterior: () => { /* stubbed */ },
      bumpFailedAttempts: async () => { /* stubbed */ },
      closeLandedGap: async () => ({ closed: true }),
      persistGapMeta: async () => { /* stubbed */ },
      holdStillHeld: () => true,
    } as never);
    expect(replies.length).toBe(1);
    expect(["ineligible", "operator_hold"]).not.toContain(String(replies[0]!.body?.stage ?? ""));
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.offOrigin).toEqual([]);
  }, 30_000);

  it("CONTROL: no gap_id, or an id the store does not hold, proceeds as feature_compose admits it", async () => {
    const r1 = await pwt({});
    expect(r1.body.stage).not.toBe("ineligible");
    const t1 = calls.tools;
    expect(t1).toBeGreaterThan(0);
    globalThis.fetch = stubFetch();
    const r2 = await pwt({ gap_id: "pwt-admission-fixture-not-in-store" });
    expect(r2.body.stage).not.toBe("ineligible");
    expect(calls.tools).toBeGreaterThan(t1);
  }, 30_000);
});
