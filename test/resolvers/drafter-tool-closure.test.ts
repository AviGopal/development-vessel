import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFTER_TOOLS, drafterToolPointer } from "../../src/resolvers/patch-with-tools.js";

// The drafter's tool calls are model output (2026-09-30). The pointer was built as { type: tool, ...args }, so an
// args.type replaced the tool that every guard had checked — a call named fs_read carrying type: "fs_write" passed
// run-root containment and the truncation guard as a read and was routed as a write — and any tool name was
// dispatched, including ones the catalog never offered (shell, served by the same local-tools endpoint).
const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/patch-with-tools.ts"), "utf8");

describe("a drafter tool pointer's type is the checked tool's", () => {
  test("args carrying type: fs_write on an fs_read-named call still route as the named tool", () => {
    const p = drafterToolPointer("code_read_lines", { path: "src/a.ts", start_line: 1, end_line: 2, type: "fs_write", content: "" });
    expect(p.type).toBe("code_read_lines");
    expect(p.path).toBe("src/a.ts");
  });

  test("a non-object args value carries no fields", () => {
    expect(drafterToolPointer("code_search", ["type", "shell"] as unknown as Record<string, unknown>)).toEqual({ type: "code_search" });
  });
});

describe("the drafter's tool set is closed to the catalog it is shown", () => {
  test("shell and other uncatalogued names are not drafter tools", () => {
    for (const t of ["shell", "fs_read", "web_search", "resolve_impulse", ""]) expect(DRAFTER_TOOLS.has(t)).toBe(false);
  });

  test("every tool the catalog offers is a drafter tool, and nothing else is", () => {
    const start = SRC.indexOf("const TOOL_CATALOG_HELP = `");
    const catalog = SRC.slice(start, SRC.indexOf("`;", start));
    const offered = [...catalog.matchAll(/^\s*\d+[a-z]?\. ([a-z_]+) \{/gm)].map((m) => m[1]!).sort();
    expect(offered.length).toBeGreaterThan(0);
    expect([...DRAFTER_TOOLS].sort()).toEqual(offered);
  });

  test("the turn loop refuses an uncatalogued tool before any guard or dispatch", () => {
    const loop = SRC.slice(SRC.indexOf('const tool = String(action.tool ?? "");'));
    const refuse = loop.indexOf("!DRAFTER_TOOLS.has(tool)");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(loop.indexOf("RUN-ROOT CONTAINMENT"));
    expect(refuse).toBeLessThan(loop.indexOf("await callTool(toolsEndpoint, tool, args)"));
  });

  test("callTool builds its pointer through drafterToolPointer", () => {
    expect(SRC).not.toMatch(/\{\s*type:\s*tool\s*,\s*\.\.\.args\s*\}/);
    expect(SRC).toContain("pointer: drafterToolPointer(tool, args)");
  });
});
