import { describe, it, expect, beforeAll } from "bun:test";
import { resolveFsList } from "../../src/resolvers/fs-list.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-fs-list-${Date.now()}`);

beforeAll(() => {
  mkdirSync(join(testDir, "sub"), { recursive: true });
  writeFileSync(join(testDir, "a.ts"), "");
  writeFileSync(join(testDir, "b.md"), "");
  writeFileSync(join(testDir, ".hidden"), "");
  writeFileSync(join(testDir, "sub", "c.ts"), "");
  process.env["WORKSPACE_ROOT"] = testDir;
});

describe("fs-list resolver", () => {
  it("lists top-level entries and returns directoryListing shape", async () => {
    const result = await resolveFsList({ type: "fs_list", path: testDir });
    expect(result.shape).toBe("directoryListing");
    const body = result.body as { entries: { name: string }[]; count: number };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("a.ts");
    expect(names).toContain("b.md");
    expect(names).toContain("sub");
    expect(names).not.toContain(".hidden");
    expect(body.count).toBe(names.length);
  });

  it("includes hidden entries when includeHidden is true", async () => {
    const result = await resolveFsList({ type: "fs_list", path: testDir, includeHidden: true });
    const body = result.body as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name)).toContain(".hidden");
  });

  it("recurses into subdirectories when recursive is true", async () => {
    const result = await resolveFsList({ type: "fs_list", path: testDir, recursive: true });
    const body = result.body as { entries: { path: string }[] };
    const paths = body.entries.map((e) => e.path);
    expect(paths.some((p) => p.includes("c.ts"))).toBe(true);
  });

  it("applies glob filter", async () => {
    const result = await resolveFsList({ type: "fs_list", path: testDir, glob: "*.ts" });
    const body = result.body as { entries: { name: string }[] };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("a.ts");
    expect(names).not.toContain("b.md");
  });

  it("rejects a path outside the workspace root", async () => {
    await expect(
      resolveFsList({ type: "fs_list", path: "/etc" }),
    ).rejects.toThrow("path outside workspace root");
  });
});
