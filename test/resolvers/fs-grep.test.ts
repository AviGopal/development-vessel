import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFsGrep } from "../../src/resolvers/fs-grep.js";

describe("fs-grep resolver", () => {
  let workspace: string;
  let origWorkspaceRoot: string | undefined;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fsgrep-test-"));
    origWorkspaceRoot = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = workspace;
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "// concept-db wires graph state\nexport const x = 1;\n");
    await writeFile(join(workspace, "src", "readme.md"), "Concept-DB is the persistence layer.\nIt stores concepts as impulses.\n");
    await writeFile(join(workspace, "irrelevant.bin"), "binary garbage");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "noise.ts"), "concept-db noise");
  });

  afterAll(async () => {
    if (origWorkspaceRoot !== undefined) {
      process.env["WORKSPACE_ROOT"] = origWorkspaceRoot;
    } else {
      delete process.env["WORKSPACE_ROOT"];
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns line-level matches with path + line number", async () => {
    const result = await resolveFsGrep({
      type: "fs_grep",
      path: workspace,
      pattern: "concept-db",
    });
    expect(result.shape).toBe("fileSearchResult");
    const body = result.body as { matches: Array<{ path: string; line: number; text: string }> };
    expect(body.matches.length).toBeGreaterThan(0);
    for (const m of body.matches) {
      expect(m.path).toBeDefined();
      expect(typeof m.line).toBe("number");
      expect(m.text.toLowerCase()).toContain("concept-db");
    }
  });

  it("skips node_modules and binary-looking extensions", async () => {
    const result = await resolveFsGrep({
      type: "fs_grep",
      path: workspace,
      pattern: "concept",
    });
    const body = result.body as { matches: Array<{ path: string }> };
    for (const m of body.matches) {
      expect(m.path).not.toContain("node_modules");
      expect(m.path).not.toContain(".bin");
    }
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(
      resolveFsGrep({ type: "fs_grep", path: "/etc", pattern: "x" }),
    ).rejects.toThrow(/outside workspace root/);
  });

  it("rejects invalid regex", async () => {
    await expect(
      resolveFsGrep({ type: "fs_grep", path: workspace, pattern: "[unterminated" }),
    ).rejects.toThrow(/invalid regex/);
  });

  it("honours maxMatches", async () => {
    const result = await resolveFsGrep({
      type: "fs_grep",
      path: workspace,
      pattern: "concept",
      maxMatches: 1,
    });
    const body = result.body as { matches: unknown[]; truncated: boolean };
    expect(body.matches.length).toBe(1);
    expect(body.truncated).toBe(true);
  });
});
