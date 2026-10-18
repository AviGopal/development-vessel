// PATCH_WITH_TOOLS RUNS THE DOCUMENTED-CONTRACT FLOOR WHETHER OR NOT ITS JUDGE CAN.
//
// patch_with_tools judges a patch only `if (proposalText && llmEndpoints.length > 0)`. The resolver returns early when
// no LLM endpoint is discovered, so the judge-less path that reaches the gate is an EMPTY proposal text. The
// deterministic floor (contractNarrowingRefusal) used to run only inside the judge, so on that path a change narrowing
// its file's documented contract staged unchecked. Expected:
//   - MUST-FAIL: no proposal text + a narrowing edit -> semantic_reject naming the narrowing, nothing staged (on
//     0f3daf0b this staged);
//   - CONTROL: no proposal text + a NON-narrowing edit -> staged with no judge call, exactly as before the floor moved;
//   - CONTROL: with proposal text, a narrowing is refused by the floor before the judge is consulted, and a
//     non-narrowing edit is judged as before;
//   - a floor that THROWS fails closed as infrastructure (semantic_judge_unavailable, a non-attempt), the rule the
//     judge block already follows. Decided: fail closed on every path. Only a throw inside contractNarrowingRefusal
//     reaches it (feature-compose is already imported unconditionally earlier on this path), and a floor that could not
//     run did not verify the edit.
// No LLM (scripted fetch), no network, no host process, writes under a temp dir only.
import { describe, it, expect, afterEach, afterAll, beforeEach, mock } from "bun:test";
import { resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FC = "../../src/resolvers/feature-compose.js";
const REAL_FC = { ...(await import(FC)) } as Record<string, unknown>;
const elig = (await import("../../src/judge/gap-eligibility.js")) as unknown as { isInfraRefusalBody: (b: Record<string, unknown>) => boolean };
const restoreFc = () => { mock.module(FC, () => ({ ...REAL_FC })); };
const originalFetch = globalThis.fetch;
const JUDGE_PROMPT = "You verify whether a self-authored CODE PATCH GENUINELY addresses a substrate gap";
let judgeCalls = 0;

const SUB = "src/routes/list-things.ts";
const BEFORE = [
  "/**",
  " * GET /things",
  " *",
  " * Query params:",
  " * - limit: Max records to return (default: 50, max: 500)",
  " */",
  "export function listThings(limitParam: number): number {",
  "  const limit = Math.min(Math.max(limitParam, 1), 500);",
  "  return limit;",
  "}",
  "",
].join("\n");
const NARROWED = BEFORE.replace("Math.max(limitParam, 1), 500)", "Math.max(limitParam, 1), 100)");
const RAISED = BEFORE.replace("Math.max(limitParam, 1), 500)", "Math.max(limitParam, 1), 1000)");

function makeFetch(content: string, target: string): typeof fetch {
  let turn = 0;
  const actions = [
    JSON.stringify({ action: "call_tool", tool: "fs_write", args: { path: target, content } }),
    JSON.stringify({ action: "done", summary: "edited the list route" }),
  ];
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const shape = body.pointer.shape;
      const role = (shape === "llmCompletion" || shape === "llm_completion") ? "llm" : "tools";
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    if (url.endsWith("/llm") && String(body?.prompt ?? "").includes(JUDGE_PROMPT)) {
      judgeCalls++;
      return new Response(JSON.stringify({ content: JSON.stringify({ addresses: true, on_live_path: true, reason: "fixture judge: fine" }) }), { status: 200 });
    }
    if (url.endsWith("/llm") && String(body?.prompt ?? "").includes("ADVERSARIAL reviewer")) {
      return new Response(JSON.stringify({ content: JSON.stringify({ refuted: false, confidence: 0.1, reason: "nothing to refute" }) }), { status: 200 });
    }
    if (url.endsWith("/llm")) {
      const c = actions[Math.min(turn, actions.length - 1)]!;
      turn++;
      return new Response(JSON.stringify({ content: c }), { status: 200 });
    }
    if (url.endsWith("/tools")) {
      const ptr = body?.impulse?.pointer ?? {};
      if (ptr.type === "fs_write") {
        writeFileSync(String(ptr.path), String(ptr.content ?? ""));
        return new Response(JSON.stringify({ shape: "fileWriteResult", path: ptr.path, ok: true }), { status: 200 });
      }
      if (ptr.type === "code_typecheck") return new Response(JSON.stringify({ shape: "codeTypecheckResult", error_lines: [] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let base: string, vesselsRoot: string, workspaceRoot: string, target: string;
const saved = { key: process.env["METABOB_API_KEY"], clone: process.env["MITOSIS_PUSH_CLONE_DIR"] };
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pwt-contract-"));
  vesselsRoot = join(base, "vessels");
  workspaceRoot = join(base, "workspace");
  mkdirSync(join(vesselsRoot, "demo-vessel", "src", "routes"), { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  target = join(vesselsRoot, "demo-vessel", SUB);
  writeFileSync(target, BEFORE);
  process.env["METABOB_API_KEY"] = "test-key";
  // No push clone for the fixture vessel: the poisoned-baseline check reads nothing.
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(base, "no-clone");
  judgeCalls = 0;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreFc();
  for (const [k, v] of [["METABOB_API_KEY", saved.key], ["MITOSIS_PUSH_CLONE_DIR", saved.clone]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});
afterAll(() => { globalThis.fetch = originalFetch; restoreFc(); });

const run = (content: string, proposal: string) => {
  globalThis.fetch = makeFetch(content, target);
  return resolvePatchWithTools({
    type: "patch_with_tools",
    proposal_text: proposal,
    target_file: `repos/demo-vessel/${SUB}`,
    vessels_root: vesselsRoot,
    workspace_root: workspaceRoot,
    max_attempts: 1,
  });
};
const summary = (r: { shape: string; body: unknown }) => {
  const b = (r.body ?? {}) as Record<string, unknown>;
  return { shape: r.shape, detail: String(b.detail ?? ""), infra: elig.isInfraRefusalBody(b), live: readFileSync(target, "utf8") === BEFORE ? "reset" : "edited" };
};

describe("patch_with_tools: the documented-contract floor runs without the judge", () => {
  it("MUST-FAIL: no proposal text + a narrowing edit is refused (semantic_reject naming it), nothing staged", async () => {
    const s = summary(await run(NARROWED, ""));
    expect({ shape: s.shape, infra: s.infra, live: s.live }).toEqual({ shape: "structuredError", infra: false, live: "reset" });
    expect(s.detail).toContain("narrows_documented_contract:limit max 500 -> 100");
    expect(judgeCalls).toBe(0);
  });
  it("CONTROL: no proposal text + a NON-narrowing edit stages, with no judge call, exactly as before", async () => {
    const r = await run(RAISED, "");
    expect(r.shape).toBe("mitosisStaged");
    expect(judgeCalls).toBe(0);
  });
  it("CONTROL: with proposal text, a narrowing is refused by the floor before the judge is consulted", async () => {
    const s = summary(await run(NARROWED, "lower the list page size"));
    expect(s.shape).toBe("structuredError");
    expect(s.detail).toContain("narrows_documented_contract:limit max 500 -> 100");
    expect(judgeCalls).toBe(0);
  });
  it("CONTROL: with proposal text, a NON-narrowing edit is judged once and stages, as before", async () => {
    const r = await run(RAISED, "raise the list page size");
    expect(r.shape).toBe("mitosisStaged");
    expect(judgeCalls).toBe(1);
  });
  it("a floor that THROWS fails closed as infrastructure (a non-attempt), on the judge-less path too", async () => {
    mock.module(FC, () => ({ ...REAL_FC, contractNarrowingRefusal: () => { throw new Error("floor broke (test)"); } }));
    const r = await run(RAISED, "");
    expect(summary(r)).toMatchObject({ shape: "structuredError", detail: "semantic_judge_unavailable", infra: true, live: "reset" });
    expect(String(((r.body ?? {}) as Record<string, unknown>).why ?? "")).toContain("floor broke (test)");
  });
});
