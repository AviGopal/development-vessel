import { describe, it, expect, beforeAll } from "bun:test";
import { resolveCodeIntrospect } from "../../src/resolvers/code-introspect.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-code-introspect-${Date.now()}`);
const sourceFile = join(testDir, "example.ts");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(sourceFile, `export function hello() {\n  return "world";\n}\nexport function greet(name: string) {\n  return \`hi \${name}\`;\n}\n`);
  process.env["WORKSPACE_ROOT"] = testDir;
});

describe("code-introspect resolver", () => {
  it("returns codeIntrospectResult with lineCount", async () => {
    const result = await resolveCodeIntrospect({ type: "code_introspect", path: sourceFile });
    expect(result.shape).toBe("codeIntrospectResult");
    const body = result.body as { lineCount: number; matches: unknown[] };
    expect(body.lineCount).toBeGreaterThan(0);
    expect(Array.isArray(body.matches)).toBe(true);
  });

  it("finds a symbol and returns match extents (line + column)", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "function \\w+",
    });
    const body = result.body as { matches: Array<{ line: number; column: number; text: string }> };
    expect(body.matches.length).toBe(2);
    const first = body.matches[0];
    expect(first).toBeDefined();
    expect(first!.line).toBeGreaterThanOrEqual(1);
    expect(first!.column).toBeGreaterThanOrEqual(1);
    expect(first!.text).toContain("function");
  });

  it("returns empty matches when pattern is not found", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "class NotPresent",
    });
    const body = result.body as { matches: unknown[] };
    expect(body.matches.length).toBe(0);
  });

  it("respects maxMatches limit", async () => {
    const result = await resolveCodeIntrospect({
      type: "code_introspect",
      path: sourceFile,
      pattern: "function \\w+",
      maxMatches: 1,
    });
    const body = result.body as { matches: unknown[] };
    expect(body.matches.length).toBe(1);
  });
});
