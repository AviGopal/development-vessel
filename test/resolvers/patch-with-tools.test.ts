import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/**
 * Scripted fetch covering the patch_with_tools dispatch surface:
 *  - discovery /resolve (llm_completion + shellResult vessel lookup)
 *  - the LLM endpoint (returns a queued sequence of action JSON objects)
 *  - the local-tools endpoint (fs_write writes the real file; code_typecheck OK)
 * No real network.
 */
function makeFetch(opts: { vesselsRoot: string; llmActions: string[] }): typeof fetch {
  const llmActions = opts.llmActions;
  let llmTurn = 0;
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(init.body as string) : {};

    // Discovery resolve — return a fake vessel whose resolve_endpoint encodes
    // its role so we can route LLM vs local-tools below.
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const shape = body.pointer.shape;
      const role = (shape === "llmCompletion" || shape === "llm_completion") ? "llm" : "tools";
      return new Response(JSON.stringify({
        content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] },
      }), { status: 200 });
    }

    // MODEL POLICY — answered WITHOUT consuming a scripted action.
    //
    // discoverFallbackModels (patch-with-tools.ts:302, called from resolvePatchWithTools before
    // the ReAct loop) POSTs { type: "llmModelPolicy" } to the same producer URL as a completion.
    // This stub matched on the URL alone, so that pre-loop discovery ate llmActions[0]: turn 1
    // then received the script's SECOND entry and every later turn got it too, since the index is
    // clamped once the script is exhausted.
    //
    // That is why "absent target with is_new_file:true …" failed with
    // "LLM declared done 2x without making any edit" while its scripted first action was a
    // call_tool it never saw. Sibling cases in this file survived only because their second entry
    // happens to be a usable action. Discriminating by body.type keeps every script aligned with
    // the turns it was written for.
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") {
      return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    }

    // LLM endpoint — emit queued action objects.
    if (url.endsWith("/llm")) {
      const content = llmActions[Math.min(llmTurn, llmActions.length - 1)] ?? '{"action":"fail","reason":"out of script"}';
      llmTurn++;
      return new Response(JSON.stringify({ content }), { status: 200 });
    }

    // Local-tools endpoint — dispatch tool by pointer.type.
    if (url.endsWith("/tools")) {
      const ptr = body?.impulse?.pointer ?? {};
      if (ptr.type === "fs_write") {
        const path = ptr.path as string;
        const content = (ptr.content as string) ?? "";
        // Mirror local-tools: write the real file, create parent dirs.
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
        return new Response(JSON.stringify({ shape: "fileWriteResult", path, ok: true }), { status: 200 });
      }
      if (ptr.type === "code_typecheck") {
        return new Response(JSON.stringify({ shape: "codeTypecheckResult", error_lines: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("patch_with_tools resolver — is_new_file authoring (Seam ③)", () => {
  let base: string;
  let vesselsRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "patch-tools-"));
    vesselsRoot = join(base, "vessels");
    workspaceRoot = join(base, "workspace");
    mkdirSync(join(vesselsRoot, "demo-vessel", "src", "resolvers"), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    process.env["METABOB_API_KEY"] = "test-key";
  });

  it("absent target with is_new_file:true does NOT short-circuit and stages the new subPath", async () => {
    const subPath = "src/resolvers/brand-new.ts";
    globalThis.fetch = makeFetch({
      vesselsRoot,
      llmActions: [
        JSON.stringify({ action: "call_tool", tool: "fs_write", args: { path: join(vesselsRoot, "demo-vessel", subPath), content: "export const NEW = 1;\n" } }),
        JSON.stringify({ action: "done", summary: "authored new file" }),
      ],
    });
    const r = await resolvePatchWithTools({
      type: "patch_with_tools",
      proposal_text: "author a net-new resolver file",
      target_file: `repos/demo-vessel/${subPath}`,
      is_new_file: true,
      vessels_root: vesselsRoot,
      workspace_root: workspaceRoot,
      max_attempts: 1,
    });
    expect(r.shape).toBe("mitosisStaged");
    const b = r.body as { staged_files: string[]; mitosis_root: string };
    expect(b.staged_files).toContain(subPath);
    // The staged file exists with the authored content.
    expect(existsSync(join(b.mitosis_root, subPath))).toBe(true);
    expect(readFileSync(join(b.mitosis_root, subPath), "utf-8")).toContain("export const NEW = 1;");
    // The live container path is UNLINKED (resetTarget), not left as a stub.
    expect(existsSync(join(vesselsRoot, "demo-vessel", subPath))).toBe(false);
  });

  it("absent target with is_new_file:false still errors (live source missing)", async () => {
    // No fetch needed — guard fires before any discovery call.
    const r = await resolvePatchWithTools({
      type: "patch_with_tools",
      proposal_text: "edit a file",
      target_file: "repos/demo-vessel/src/resolvers/missing.ts",
      is_new_file: false,
      vessels_root: vesselsRoot,
      workspace_root: workspaceRoot,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("live source missing");
  });

  it("present target with is_new_file:true errors (new-file collision)", async () => {
    const subPath = "src/resolvers/already-here.ts";
    writeFileSync(join(vesselsRoot, "demo-vessel", subPath), "export const X = 1;\n");
    const r = await resolvePatchWithTools({
      type: "patch_with_tools",
      proposal_text: "author a file that exists",
      target_file: `repos/demo-vessel/${subPath}`,
      is_new_file: true,
      vessels_root: vesselsRoot,
      workspace_root: workspaceRoot,
    });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("already exists");
  });
});

/**
 * DRIFT-PROOF SNAPSHOT/RESTORE (gap critical-patch-with-tools-edits-live-vessel-source).
 *
 * Reproduces the confirmed corruption mechanism: the drafter applies an edit to the
 * LIVE /vessels source, then the LLM plane exhausts on a later turn and the resolver
 * returns via the `llm failed turn` terminal — a path that did NOT resetTarget. Before
 * the fix that stranded broken code on disk (waiting to crash the next restart). The
 * snapshot/restore finally must leave EVERY touched live file byte-identical to its
 * pre-run content, including a file OTHER than the declared target_file.
 */
function makeFetchWithLlmFailure(opts: {
  llmActions: string[];
  failLlmFromTurn: number; // 1-indexed LLM turn from which /llm returns HTTP 500
}): typeof fetch {
  let llmTurn = 0;
  let typecheckCalls = 0;
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const shape = body.pointer.shape;
      const role = (shape === "llmCompletion" || shape === "llm_completion") ? "llm" : "tools";
      return new Response(JSON.stringify({
        content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] },
      }), { status: 200 });
    }

    if (url.endsWith("/llm")) {
      llmTurn++;
      // Exhaust the LLM plane from the configured turn: HTTP 500 is treated as a
      // non-transient producer failure, so after failover across every model the
      // resolver hits the `llm failed turn` terminal (the revert-gap under test).
      if (llmTurn >= opts.failLlmFromTurn) {
        return new Response(JSON.stringify({ error: "provider exhausted" }), { status: 500 });
      }
      const content = opts.llmActions[Math.min(llmTurn - 1, opts.llmActions.length - 1)] ?? '{"action":"fail","reason":"out of script"}';
      return new Response(JSON.stringify({ content }), { status: 200 });
    }

    if (url.endsWith("/tools")) {
      const ptr = body?.impulse?.pointer ?? {};
      if (ptr.type === "fs_edit") {
        const path = ptr.path as string;
        const oldStr = String(ptr.old_string ?? "");
        const newStr = String(ptr.new_string ?? "");
        const cur = readFileSync(path, "utf-8");
        if (!cur.includes(oldStr)) {
          return new Response(JSON.stringify({ success: false, error: "old_string not found" }), { status: 200 });
        }
        writeFileSync(path, cur.replace(oldStr, newStr));
        return new Response(JSON.stringify({ shape: "fileWriteResult", path, ok: true, success: true }), { status: 200 });
      }
      if (ptr.type === "code_verify_typecheck") {
        typecheckCalls++;
        // First call is the pre-edit baseline (clean); after the edit, report a NEW
        // target error so the verified-green terminal does NOT fire and the loop keeps
        // running until the LLM plane fails — exactly the window the revert-gap opened.
        const error_lines = typecheckCalls <= 1
          ? []
          : ["src/index.ts(3,1): error TS2451: Cannot redeclare block-scoped variable 'x'."];
        return new Response(JSON.stringify({ shape: "codeTypecheckResult", error_lines }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("patch_with_tools resolver — no drift on non-landing terminal", () => {
  let base: string;
  let vesselsRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "patch-tools-drift-"));
    vesselsRoot = join(base, "vessels");
    workspaceRoot = join(base, "workspace");
    mkdirSync(join(vesselsRoot, "demo-vessel", "src"), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    process.env["METABOB_API_KEY"] = "test-key";
  });

  it("an edit that ends in the LLM-failure terminal leaves the target byte-identical (no drift)", async () => {
    const subPath = "src/index.ts";
    const targetPath = join(vesselsRoot, "demo-vessel", subPath);
    const original = "let walkTerminationReason: string | undefined;\nexport const KEEP = 1;\n";
    writeFileSync(targetPath, original);

    globalThis.fetch = makeFetchWithLlmFailure({
      // Turn 1 applies a duplicating edit (the exact corruption class), then the LLM
      // plane fails from turn 2 → resolver returns via `llm failed turn`.
      llmActions: [
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: "let walkTerminationReason: string | undefined;", new_string: "let walkTerminationReason: string | undefined = undefined;\nvar walkTerminationReason: string | undefined;" } }),
      ],
      failLlmFromTurn: 2,
    });

    const r = await resolvePatchWithTools({
      type: "patch_with_tools",
      proposal_text: "adjust walkTerminationReason",
      target_file: `repos/demo-vessel/${subPath}`,
      vessels_root: vesselsRoot,
      workspace_root: workspaceRoot,
      max_attempts: 1,
    });

    expect(r.shape).toBe("structuredError");
    // The live target must be RESTORED — no stranded broken redeclare on disk.
    expect(readFileSync(targetPath, "utf-8")).toBe(original);
  });

  it("a multi-file run that fails restores EVERY touched file, not just the declared target", async () => {
    const subPath = "src/index.ts";
    const targetPath = join(vesselsRoot, "demo-vessel", subPath);
    const otherPath = join(vesselsRoot, "demo-vessel", "src", "helper.ts");
    const targetOriginal = "let walkTerminationReason: string | undefined;\nexport const KEEP = 1;\n";
    const otherOriginal = "export const HELPER = 42;\n";
    writeFileSync(targetPath, targetOriginal);
    writeFileSync(otherPath, otherOriginal);

    globalThis.fetch = makeFetchWithLlmFailure({
      llmActions: [
        // Turn 1: edit the declared target.
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: targetPath, old_string: "export const KEEP = 1;", new_string: "export const KEEP = 999;" } }),
        // Turn 2: edit a DIFFERENT file (absolute path) — the resetTarget-only revert
        // would never restore this; the snapshot map must.
        JSON.stringify({ action: "call_tool", tool: "fs_edit", args: { path: otherPath, old_string: "export const HELPER = 42;", new_string: "export const HELPER = 0; garbage syntax" } }),
      ],
      failLlmFromTurn: 3,
    });

    const r = await resolvePatchWithTools({
      type: "patch_with_tools",
      proposal_text: "edit two files",
      target_file: `repos/demo-vessel/${subPath}`,
      vessels_root: vesselsRoot,
      workspace_root: workspaceRoot,
      max_attempts: 1,
    });

    expect(r.shape).toBe("structuredError");
    // BOTH files restored to their pre-run bytes.
    expect(readFileSync(targetPath, "utf-8")).toBe(targetOriginal);
    expect(readFileSync(otherPath, "utf-8")).toBe(otherOriginal);
  });
});
