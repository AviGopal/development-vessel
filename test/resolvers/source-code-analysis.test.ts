import { describe, it, expect, afterEach } from "bun:test";
import { resolveSourceCodeAnalysis } from "../../src/resolvers/source-code-analysis.js";

// HERMETIC. This resolver discovers and reads files by calling its OWN vessel over HTTP
// (POST /v2/impulses/resolve with fs_list / fs_read), one round trip per file, up to 40 files,
// with a 30s timeout — against bun's 5s test timeout. Unstubbed, these tests therefore failed as
// timeouts under substrate load rather than on their assertions.
//
// They were also existence-only (typeof file_count === "number", Array.isArray(files)), which the
// error branch `{error: "root_not_found"}` does NOT satisfy but an almost-empty directory does —
// so the counting and classification logic this resolver exists for went unasserted.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Serve a fake vessel tree. `tree` maps an absolute dir path to its entries; `files` maps an
 * absolute file path to its contents. Anything unlisted answers empty, which is what the real
 * fs_list does for a missing directory.
 */
const serveTree = (tree: Record<string, string[]>, files: Record<string, string>): void => {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const impulse = JSON.parse(String(init?.body ?? "{}")).impulse ?? {};
    if (impulse.type === "fs_list") return json({ body: { entries: tree[impulse.path] ?? [] } });
    if (impulse.type === "fs_read") return json({ body: { content: files[impulse.path] ?? "" } });
    return json({ body: {} });
  }) as unknown as typeof fetch;
};

const ROOT = `${process.env["WORKSPACE_ROOT"] ?? process.cwd()}/repos/demo-vessel`;

describe("resolveSourceCodeAnalysis", () => {
  it("classifies and counts source, test and config files", async () => {
    serveTree(
      {
        [ROOT]: [`${ROOT}/index.ts`, `${ROOT}/package.json`, `${ROOT}/src`],
        [`${ROOT}/src`]: [`${ROOT}/src/scan.ts`, `${ROOT}/src/scan.test.ts`],
      },
      {
        [`${ROOT}/index.ts`]: "export const main = 1;\n",
        [`${ROOT}/package.json`]: '{"name":"demo-vessel"}\n',
        [`${ROOT}/src/scan.ts`]: "import { x } from 'node:fs';\nexport function scan() { return 1; }\n",
        [`${ROOT}/src/scan.test.ts`]: "import { describe } from 'bun:test';\nexport const t = 1;\n",
      },
    );
    const result = await resolveSourceCodeAnalysis({
      type: "sourceCodeAnalysis",
      target_path: "repos/demo-vessel",
    });
    expect(result.shape).toBe("sourceCodeAnalysis");
    const body = result.body as Record<string, any>;
    expect(body["target_path"]).toBe("repos/demo-vessel");
    expect(body["file_count"]).toBeGreaterThan(0);
    expect(body["test_files"]).toBeGreaterThanOrEqual(1);
    expect(body["config_files"]).toBeGreaterThanOrEqual(1);
    expect(body["total_lines"]).toBeGreaterThan(0);
    expect(Array.isArray(body["files"])).toBe(true);
    expect(Array.isArray(body["purpose_signals"])).toBe(true);
    expect(typeof body["summary"]).toBe("string");
  });

  it("extracts exports and imports from source files", async () => {
    serveTree(
      { [ROOT]: [`${ROOT}/src`], [`${ROOT}/src`]: [`${ROOT}/src/scan.ts`] },
      { [`${ROOT}/src/scan.ts`]: "import { readFile } from 'node:fs/promises';\nexport function scan() {}\nexport const VERSION = '1';\n" },
    );
    const body = (await resolveSourceCodeAnalysis({
      type: "sourceCodeAnalysis",
      target_path: "repos/demo-vessel",
    })).body as Record<string, any>;
    expect(body["all_exports"].length).toBeGreaterThan(0);
    // all_imports is deliberately reduced to PACKAGE ROOTS (`i.split("/")[0]`) because it feeds
    // the "External dependencies" summary line — so `node:fs/promises` is reported as `node:fs`.
    // Asserting the full specifier here would be asserting a bug that does not exist.
    expect(body["all_imports"]).toContain("node:fs");
    // relative imports are excluded from the dependency list
    expect(body["all_imports"].some((i: string) => i.startsWith("."))).toBe(false);
  });

  it("defaults target_path to repos/clock-vessel when none is given", async () => {
    serveTree({}, {});
    const body = (await resolveSourceCodeAnalysis({ type: "sourceCodeAnalysis" })).body as Record<string, any>;
    expect(body["target_path"]).toBe("repos/clock-vessel");
  });

  it("reports root_not_found (naming what it tried) rather than an empty success", async () => {
    // The distinction that matters: "I could not find the vessel" must not look like
    // "the vessel has no files". The error branch carries attempted_paths for exactly that.
    serveTree({}, {});
    const body = (await resolveSourceCodeAnalysis({
      type: "sourceCodeAnalysis",
      target_path: "repos/does-not-exist",
    })).body as Record<string, any>;
    expect(body["error"]).toBe("root_not_found");
    expect(Array.isArray(body["attempted_paths"])).toBe(true);
    expect(body["attempted_paths"].length).toBeGreaterThan(0);
  });
});
