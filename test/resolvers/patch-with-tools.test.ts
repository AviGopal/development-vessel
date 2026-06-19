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
