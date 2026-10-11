// PATCH_WITH_TOOLS' SEMANTIC GATE FAILS CLOSED, AND A JUDGE THAT COULD NOT JUDGE IS INFRASTRUCTURE (protected must-fail).
//
// patch_with_tools self-lands a staged mitosis after running the same judge feature_compose runs
// (verifyPatchAddressesGap). Its block was documented "FAILS OPEN BY CONSTRUCTION": a throw anywhere in it was caught
// and the patch staged anyway. And once the judge itself failed closed, an outage came back as an ordinary
// semantic_reject, which charges the gap a failed attempt.
//
// Expected (qa ruling: "semantic judge unavailable" is an INFRA refusal, a non-attempt):
//   - a judge outage, or an answer with no parseable verdict, refuses with detail semantic_judge_unavailable (NOT
//     semantic_reject) and failure_kind "environment", which gap-to-feature's isInfraRefusalBody reads as a
//     non-attempt; nothing is staged and the live target is reset;
//   - a THROW in the gate block refuses the same way (it used to stage the patch);
//   - CONTROL: a judge that passes the patch stages it; a judge that JUDGED addresses:false is still a semantic_reject,
//     charged as before.
//
// The gate throw is induced by re-binding verifyPatchAddressesGap with mock.module, restored to the captured
// original after every test. No LLM (scripted fetch), no network, no host process, writes under a temp dir only.
import { describe, it, expect, afterEach, afterAll, beforeEach, mock } from "bun:test";
import { resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FC = "../../src/resolvers/feature-compose.js";
const REAL_FC = { ...(await import(FC)) } as Record<string, unknown>;
const gtf = (await import("../../src/resolvers/gap-to-feature.js")) as unknown as { isInfraRefusalBody: (b: Record<string, unknown>) => boolean };
const gtfElig = (await import("../../src/judge/gap-eligibility.js")) as unknown as { isInfraRefusalBody: (b: Record<string, unknown>) => boolean };
const restoreFc = () => { mock.module(FC, () => ({ ...REAL_FC })); };

const originalFetch = globalThis.fetch;
const JUDGE_PROMPT = "You verify whether a self-authored CODE PATCH GENUINELY addresses a substrate gap";
type JudgeMode = "pass" | "down" | "garbage" | "reject";
let judgeMode: JudgeMode = "pass";
let judgeCalls = 0;

/** The patch_with_tools dispatch surface: discovery, the model policy, the scripted ReAct turns, the judge, local tools. */
function makeFetch(llmActions: string[]): typeof fetch {
  let turn = 0;
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const shape = body.pointer.shape;
      const role = (shape === "llmCompletion" || shape === "llm_completion") ? "llm" : "tools";
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") {
      return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && String(body?.prompt ?? "").includes(JUDGE_PROMPT)) {
      judgeCalls++;
      if (judgeMode === "down") return new Response("judge unavailable (test)", { status: 400 });
      if (judgeMode === "garbage") return new Response(JSON.stringify({ content: "Looks fine to me." }), { status: 200 });
      const v = judgeMode === "pass"
        ? { addresses: true, on_live_path: true, reason: "fixture judge: the new resolver implements the request" }
        : { addresses: false, on_live_path: true, reason: "fixture judge: the file does not implement what the proposal asks" };
      return new Response(JSON.stringify({ content: JSON.stringify(v) }), { status: 200 });
    }
    if (url.endsWith("/llm") && String(body?.prompt ?? "").includes("ADVERSARIAL reviewer")) {
      return new Response(JSON.stringify({ content: JSON.stringify({ refuted: false, confidence: 0.1, reason: "nothing to refute" }) }), { status: 200 });
    }
    if (url.endsWith("/llm")) {
      const content = llmActions[Math.min(turn, llmActions.length - 1)] ?? '{"action":"fail","reason":"out of script"}';
      turn++;
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    if (url.endsWith("/tools")) {
      const ptr = body?.impulse?.pointer ?? {};
      if (ptr.type === "fs_write") {
        const path = String(ptr.path);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, String(ptr.content ?? ""));
        return new Response(JSON.stringify({ shape: "fileWriteResult", path, ok: true }), { status: 200 });
      }
      if (ptr.type === "code_typecheck") return new Response(JSON.stringify({ shape: "codeTypecheckResult", error_lines: [] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let base: string, vesselsRoot: string, workspaceRoot: string;
const SUB = "src/resolvers/compute-report.ts";
const savedKey = process.env["METABOB_API_KEY"];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pwt-semgate-"));
  vesselsRoot = join(base, "vessels");
  workspaceRoot = join(base, "workspace");
  mkdirSync(join(vesselsRoot, "demo-vessel", "src", "resolvers"), { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  process.env["METABOB_API_KEY"] = "test-key";
  judgeMode = "pass";
  judgeCalls = 0;
  globalThis.fetch = makeFetch([
    JSON.stringify({ action: "call_tool", tool: "fs_write", args: { path: join(vesselsRoot, "demo-vessel", SUB), content: "export function computeReport(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n" } }),
    JSON.stringify({ action: "done", summary: "authored the report resolver" }),
  ]);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreFc();
  if (savedKey === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = savedKey;
  rmSync(base, { recursive: true, force: true });
});
afterAll(() => { globalThis.fetch = originalFetch; restoreFc(); });

const run = () => resolvePatchWithTools({
  type: "patch_with_tools",
  proposal_text: "author a compute-report resolver that sums the inputs",
  target_file: `repos/demo-vessel/${SUB}`,
  is_new_file: true,
  vessels_root: vesselsRoot,
  workspace_root: workspaceRoot,
  max_attempts: 1,
});
const summary = (r: { shape: string; body: unknown }) => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  return { shape: r.shape, detail: b.detail ?? null, infra: gtfElig.isInfraRefusalBody(b), live_target_left: existsSync(join(vesselsRoot, "demo-vessel", SUB)) };
};

describe("patch_with_tools: the semantic gate passes only a judged patch", () => {
  it("CONTROL: a judge that passes the patch stages it", async () => {
    const r = await run();
    expect(judgeCalls).toBe(1);
    expect(r.shape).toBe("mitosisStaged");
  });
  it("CONTROL: a judge that JUDGED addresses:false is still a semantic_reject, charged (not infrastructure)", async () => {
    judgeMode = "reject";
    const r = await run();
    // (structuredError's body carries the judge's reason as `detail`, overriding the "semantic_reject" code that is logged.)
    expect(summary(r)).toEqual({ shape: "structuredError", detail: "fixture judge: the file does not implement what the proposal asks", infra: false, live_target_left: false });
  });
  it("MUST-FAIL: a judge OUTAGE is semantic_judge_unavailable, an infrastructure non-attempt, NOT a semantic_reject", async () => {
    judgeMode = "down";
    const r = await run();
    expect(summary(r)).toEqual({ shape: "structuredError", detail: "semantic_judge_unavailable", infra: true, live_target_left: false });
  });
  it("MUST-FAIL: an UNPARSEABLE judge answer is semantic_judge_unavailable, an infrastructure non-attempt", async () => {
    judgeMode = "garbage";
    const r = await run();
    expect(summary(r)).toEqual({ shape: "structuredError", detail: "semantic_judge_unavailable", infra: true, live_target_left: false });
  });
  it("MUST-FAIL: a THROW in the gate block refuses (it used to stage the patch), as infrastructure", async () => {
    mock.module(FC, () => ({ ...REAL_FC, verifyPatchAddressesGap: async () => { throw new Error("semantic gate broke (test)"); } }));
    const r = await run();
    expect(summary(r)).toEqual({ shape: "structuredError", detail: "semantic_judge_unavailable", infra: true, live_target_left: false });
    expect(String(((r.body ?? {}) as Record<string, unknown>).why ?? "")).toContain("semantic gate broke (test)");
  });
});
