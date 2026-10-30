// THE APPLY-FAILURE ESCALATION RUNS patch_with_tools IN AN ISOLATED COMPOSE WORKTREE.
//
// After a feature_compose apply failure, gap-to-feature escalates once to patch_with_tools. It handed pwt the runtime
// dir as vessels_root, so pwt would have edited the running tree, and the operator hold on live-tree writes refused
// every escalation: it never ran. The escalation now hands pwt a fresh worktree at origin/dev under the compose root,
// which the hold's own predicate classifies "compose" (writable while held); the hold itself is untouched.
//   MUST-FAIL: the vessels_root the default escalation hands pwt is classified "compose", and the worktree is
//     released after the run.
//   MUST-FAIL: the static gate's base root is the staged tree's sibling under any vessels root (the compose root and
//     the runtime dir alike).
//   MUST-FAIL: with the hold ACTIVE, the real pwt is not refused as live_tree_writes_held, reads the worktree, and the
//     runtime tree's file is byte-for-byte unchanged.
//   MUST-FAIL: with no worktree to be had, pwt is not run on the runtime tree; the compose failure is graded as with no
//     escalation and the one-shot is kept.
//   MUST-FAIL: a staged tree the inline cutover did not land keeps its worktree (the next mitosis tick's input).
//   CONTROL: a failure that is not an apply failure escalates nothing and makes no worktree (both ends).
//
// Every fixture lives under this file's own temp root: the runtime dir, the push clone (with its own origin), the
// compose root, the workspace root and the pool store. fetch is replaced for the whole file with loopback stubs.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const iso = await isolateRuntimeRoot("pwt-escalation-compose", { who: "test/resolvers/pwt-escalation-compose-worktree.test.ts" });
const base = realpathSync(iso.root);
const runtime = join(base, "runtime");
const clones = join(base, "clones");
const compose = join(base, "compose");
const ws = join(base, "ws");
const poolFile = join(base, "pool", "standing.json");
const prior: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries({ MITOSIS_RUNTIME_DIR: runtime, MITOSIS_PUSH_CLONE_DIR: clones, COMPOSE_WS_DIR: compose, WORKSPACE_ROOT: ws, METABOB_API_KEY: "test-node-key-pwt-escalation" })) {
  prior[k] = process.env[k];
  process.env[k] = v;
}

// pwt's admission reads the gap store: this process's own temp store (seeded below), never a holder over the network.
prior["GAP_STORE_ENDPOINT"] = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];

const landing = await import("../../src/judge/gap-landing-verdict.js");
const pwtMod = (await import("../../src/resolvers/patch-with-tools.js")) as Record<string, unknown>;
const { classifyVesselsRoot } = await import("../../src/lib/operator-hold.js");
const { resolvePoolImpulseWrite, __setPoolFileForTests } = await import("../../src/resolvers/pool-impulse.js");
const { gapStoreFilePath } = await import("../../src/resolvers/substrate-gap.js");

const VESSEL = "demo-vessel";
const SUB = "src/resolvers/existing.ts";
const ORIGINAL = "export function live(): number {\n  return 1;\n}\n";
const HOLD_ID = "pwt-live-tree-writes";
const SCOPE = "patch_with_tools:live_tree_writes";
const applyFailure = { ok: false, apply_failed: true, op_count: 1, rolled_back: true, verdict: "UNFAVORABLE" };
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const git = (cwd: string, ...args: string[]): void => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=dev", ...args], { cwd, stdio: "pipe" }); };

const originalFetch = globalThis.fetch;
let calls: { tools: number; llm: number; offOrigin: string[] };
/** discovery, the model policy, the LLM and local-tools, all on loopback; the LLM gives up on its second turn. */
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
        ? JSON.stringify({ action: "call_tool", tool: "code_search", args: { path: `repos/${VESSEL}/${SUB}`, pattern: "return 1" } })
        : JSON.stringify({ action: "fail", reason: "test script ends here" });
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    if (url.endsWith("/tools")) { calls.tools++; return new Response(JSON.stringify({ ok: true, matches: [{ line: 2, text: "  return 1;" }] }), { status: 200 }); }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// An ARMED stored gap: the compose it escalates from was admitted, so pwt's admission admits it too.
const gapRow = (): Record<string, unknown> => ({ id: "demo-gap-esc", category: "bug", source: "detector", summary: "s", status: "open", classification_metadata: { edit_site: `repos/${VESSEL}/${SUB}`, falsifier: "class2" } });
const STORE = gapStoreFilePath();
const storeUnderTmp = STORE.startsWith(realpathSync(tmpdir()) + "/") || STORE.startsWith(tmpdir() + "/");
const storeBefore = existsSync(STORE) ? readFileSync(STORE, "utf8") : null;
if (storeUnderTmp) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify([...(storeBefore ? (JSON.parse(storeBefore) as unknown[]) : []), gapRow()]));
}
/** The production deps with every grading write stubbed; resolvePwt is wrapped so the pointer and the reply are seen. */
function deps(seen: { pointers: Array<Record<string, unknown>>; replies: unknown[]; bumps: number }, run: (p: Record<string, unknown>) => Promise<unknown>) {
  return {
    ...landing.defaultPwtEscalationDeps(),
    resolvePwt: async (p: Record<string, unknown>) => { seen.pointers.push(p); const r = await run(p); seen.replies.push(r); return r as never; },
    updateClassPosterior: () => { /* stubbed */ },
    bumpFailedAttempts: async () => { seen.bumps++; },
    closeLandedGap: async () => ({ closed: true }),
    persistGapMeta: async () => { /* stubbed */ },
    holdStillHeld: () => true,
  };
}
const worktrees = (): string[] => (existsSync(compose) ? readdirSync(compose).filter((e) => e !== "packages") : []);

beforeEach(() => {
  // The runtime tree (the live zone) and a push clone whose origin/dev holds the same file.
  mkdirSync(join(runtime, VESSEL, "src", "resolvers"), { recursive: true });
  writeFileSync(join(runtime, VESSEL, SUB), ORIGINAL);
  const origin = join(base, "origin", VESSEL);
  if (!existsSync(origin)) {
    mkdirSync(join(origin, "src", "resolvers"), { recursive: true });
    writeFileSync(join(origin, SUB), ORIGINAL);
    git(origin, "init", "-q");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "seed");
    mkdirSync(clones, { recursive: true });
    git(clones, "clone", "-q", "--branch", "dev", origin, VESSEL);
  }
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(base, "pool"), { recursive: true });
  __setPoolFileForTests(poolFile);
  calls = { tools: 0, llm: 0, offOrigin: [] };
  globalThis.fetch = stubFetch();
});
afterEach(() => { globalThis.fetch = originalFetch; __setPoolFileForTests(null); });
afterAll(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (storeUnderTmp) writeFileSync(STORE, storeBefore ?? "[]");
});

describe("the apply-failure escalation hands patch_with_tools an isolated compose worktree", () => {
  it("the fixture gap store is this process's own temp store", () => { expect(storeUnderTmp).toBe(true); });

  it("MUST-FAIL: the vessels_root handed to pwt is classified compose, and the worktree is released after the run", async () => {
    const seen = { pointers: [] as Array<Record<string, unknown>>, replies: [] as unknown[], bumps: 0 };
    let during: string[] = [];
    const out = await landing.escalateApplyFailureToPwt(gapRow(), applyFailure, "make live() return 2", { predicted: false, p: 0.2 },
      deps(seen, async (p) => {
        during = worktrees();
        const root = String(p.vessels_root ?? "");
        return { shape: "structuredError", body: { resolver: "patch_with_tools", detail: "stub", file_present: existsSync(join(root, VESSEL, SUB)) } };
      }));
    expect(seen.pointers.length).toBe(1);
    const root = String(seen.pointers[0]!.vessels_root ?? "/vessels");
    expect(classifyVesselsRoot(root).kind).toBe("compose");
    expect((seen.replies[0] as { body: { file_present: boolean } }).body.file_present).toBe(true);
    expect(during.length).toBe(1);
    expect(worktrees()).toEqual([]);
    expect(out.escalated).toBe(true);
    expect(out.held).toBe(false);
    expect(seen.bumps).toBe(1);
  });

  it("MUST-FAIL: the static gate's base root is the staged tree's sibling under the compose root and the runtime dir", () => {
    const evaluatorBaseRoot = pwtMod.evaluatorBaseRoot as undefined | ((m: string, v: string) => string);
    const wsRoot = join(compose, "pwt-escalation-x");
    expect(evaluatorBaseRoot?.(join(wsRoot, `${VESSEL}-mitosis-2026-01-01T00-00-00-000Z`), VESSEL)).toBe(join(wsRoot, VESSEL));
    expect(evaluatorBaseRoot?.(`/vessels/${VESSEL}-mitosis-2026-01-01T00-00-00-000Z`, VESSEL)).toBe(`/vessels/${VESSEL}`);
  });

  it("MUST-FAIL: with the hold ACTIVE the real pwt runs in the worktree (not live_tree_writes_held) and the runtime file is unchanged", async () => {
    const now = new Date();
    const w = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: HOLD_ID, shape: "operatorHold", source: "test", body: {
      hold_id: HOLD_ID, scope: SCOPE, active: true, harm: true, by: "operator:test", at: now.toISOString(), reason: "pwt edits live trees",
      evidence: ["gap-a"], lift: "pwt writes an isolated compose worktree by default", review_by: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    } } as never, { operator: true, key_id: "test-admin" } as never) as { body: { ok?: boolean } };
    expect(w.body.ok).toBe(true);
    const before = sha(join(runtime, VESSEL, SUB));
    const seen = { pointers: [] as Array<Record<string, unknown>>, replies: [] as unknown[], bumps: 0 };
    const real = pwtMod.resolvePatchWithTools as (p: unknown) => Promise<unknown>;
    const out = await landing.escalateApplyFailureToPwt(gapRow(), applyFailure, "make live() return 2", { predicted: false, p: 0.2 },
      deps(seen, (p) => real({ ...p, workspace_root: ws, max_attempts: 1, max_iterations: 2 })));
    const reply = seen.replies[0] as { body?: Record<string, unknown> } | undefined;
    expect(reply?.body?.stage).not.toBe("live_tree_writes_held");
    expect(out.held).toBe(false);
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.offOrigin).toEqual([]);
    expect(sha(join(runtime, VESSEL, SUB))).toBe(before);
    expect(worktrees()).toEqual([]);
  }, 30_000);

  it("MUST-FAIL: with no worktree to be had, pwt is not run on the runtime tree; the compose failure is graded and the one-shot kept", async () => {
    const seen = { pointers: [] as Array<Record<string, unknown>>, replies: [] as unknown[], bumps: 0 };
    const gap = { ...gapRow(), classification_metadata: { edit_site: "repos/no-such-vessel/src/x.ts" } };
    const out = await landing.escalateApplyFailureToPwt(gap, applyFailure, "spec", { predicted: false, p: 0.2 },
      deps(seen, async () => ({ shape: "structuredError", body: { resolver: "patch_with_tools", detail: "not expected" } })));
    expect(seen.pointers).toEqual([]);
    expect(out.escalated).toBe(false);
    expect(seen.bumps).toBe(1);
    expect((gap.classification_metadata as Record<string, unknown>).pwt_escalated).toBeUndefined();
  });

  it("MUST-FAIL: a staged tree the inline cutover did not land keeps its worktree for the cutover", async () => {
    const seen = { pointers: [] as Array<Record<string, unknown>>, replies: [] as unknown[], bumps: 0 };
    let staged = "";
    await landing.escalateApplyFailureToPwt(gapRow(), applyFailure, "spec", { predicted: false, p: 0.2 },
      deps(seen, async (p) => {
        staged = join(String(p.vessels_root ?? "/vessels"), `${VESSEL}-mitosis-x`);
        if (classifyVesselsRoot(String(p.vessels_root ?? "/vessels")).kind === "compose") mkdirSync(staged, { recursive: true });
        return { shape: "mitosisStaged", body: { dispatched: true, landed: false, push_status: "cutover_failed", mitosis_root: staged } };
      }));
    expect(worktrees().length).toBe(1);
    expect(existsSync(staged)).toBe(true);
    for (const e of worktrees()) rmSync(join(compose, e), { recursive: true, force: true });
    execFileSync("git", ["-C", join(clones, VESSEL), "worktree", "prune"], { stdio: "pipe" });
  });

  it("CONTROL: a failure that is not an apply failure escalates nothing and makes no worktree", async () => {
    const seen = { pointers: [] as Array<Record<string, unknown>>, replies: [] as unknown[], bumps: 0 };
    const out = await landing.escalateApplyFailureToPwt(gapRow(), { ok: false, verdict: "UNFAVORABLE", stage: "verify" }, "spec", { predicted: false, p: 0.2 },
      deps(seen, async () => ({ shape: "structuredError", body: { resolver: "patch_with_tools", detail: "not expected" } })));
    expect(seen.pointers).toEqual([]);
    expect(out.escalated).toBe(false);
    expect(seen.bumps).toBe(1);
    expect(worktrees()).toEqual([]);
  });
});
