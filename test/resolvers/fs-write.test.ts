import { describe, it, expect, beforeAll } from "bun:test";
import { resolveFsWrite } from "../../src/resolvers/fs-write.js";
import { mkdirSync , writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-fs-write-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env["WORKSPACE_ROOT"] = testDir;
});

describe("fs-write resolver", () => {
  it("writes a file and returns fileWriteResult", async () => {
    const path = join(testDir, "out.txt");
    const result = await resolveFsWrite({ type: "fs_write", path, content: "hello" });
    expect(result.shape).toBe("fileWriteResult");
    const body = result.body as { path: string; bytesWritten: number };
    expect(body.path).toBe(path);
    expect(body.bytesWritten).toBe(5);
    expect(await Bun.file(path).text()).toBe("hello");
  });

  it("creates intermediate directories when createDirs is true", async () => {
    const path = join(testDir, "sub/dir/nested.txt");
    const result = await resolveFsWrite({ type: "fs_write", path, content: "nested", createDirs: true });
    expect(result.shape).toBe("fileWriteResult");
    expect(await Bun.file(path).text()).toBe("nested");
  });

  it("rejects a path outside the workspace root", async () => {
    // /etc is outside testDir
    await expect(
      resolveFsWrite({ type: "fs_write", path: "/etc/shadow-test.txt", content: "nope" }),
    ).rejects.toThrow("path outside workspace root");
  });

  describe("WRITE_ALLOWLIST scoping", () => {
    it("allows arbitrary in-workspace writes when env unset", async () => {
      delete process.env["WRITE_ALLOWLIST"];
      const path = join(testDir, "anywhere.txt");
      const result = await resolveFsWrite({ type: "fs_write", path, content: "ok" });
      expect(result.shape).toBe("fileWriteResult");
    });

    it("allows writes under an allowlisted prefix", async () => {
      process.env["WRITE_ALLOWLIST"] = "openspec/changes/,validation/failure-modes/proposals/";
      mkdirSync(join(testDir, "openspec/changes/2026-05-30-x"), { recursive: true });
      const path = join(testDir, "openspec/changes/2026-05-30-x/proposal.md");
      const result = await resolveFsWrite({ type: "fs_write", path, content: "# spec" });
      expect(result.shape).toBe("fileWriteResult");
      delete process.env["WRITE_ALLOWLIST"];
    });

    it("rejects writes outside an allowlisted prefix", async () => {
      process.env["WRITE_ALLOWLIST"] = "openspec/changes/";
      const path = join(testDir, "repos/some-vessel/src/index.ts");
      await expect(
        resolveFsWrite({ type: "fs_write", path, content: "evil", createDirs: true }),
      ).rejects.toThrow("path outside write allowlist");
      delete process.env["WRITE_ALLOWLIST"];
    });
  });

  // -------------------------------------------------------------------------
  // The WHERE guards above bound where a write may land. This one bounds WHAT it
  // may contain — the two are not substitutes, and `fs_write` is advertised by
  // BOTH this vessel and local-tools-vessel, so a shape-routed caller can land on
  // either. Only the sibling refused truncation; this producer refused nothing.
  // -------------------------------------------------------------------------
  describe("truncation guard", () => {
    it("REFUSES a whole-file write that collapses an existing substantial file", async () => {
      const path = join(testDir, "collapse-me.ts");
      writeFileSync(path, "x".repeat(190_000));
      const result = await resolveFsWrite({ type: "fs_write", path, content: "y".repeat(160) });
      expect(result.shape).toBe("structuredError");
      expect(JSON.stringify(result.body)).toContain("would_truncate");
      // and the file on disk is UNTOUCHED — refusing must not be a partial write
      expect(readFileSync(path, "utf8").length).toBe(190_000);
    });

    it("CONTROL: growth is allowed — a real edit adds an import or a type", async () => {
      const path = join(testDir, "grow-me.ts");
      writeFileSync(path, "export const x = 1;\n");
      const result = await resolveFsWrite({ type: "fs_write", path, content: "import a from 'a';\nexport const x: number = 1;\n" });
      expect(result.shape).toBe("fileWriteResult");
    });

    it("CONTROL: a modest shrink is allowed — deleting dead code is a real edit", async () => {
      const path = join(testDir, "shrink-a-little.ts");
      writeFileSync(path, "z".repeat(1000));
      const result = await resolveFsWrite({ type: "fs_write", path, content: "z".repeat(800) });
      expect(result.shape).toBe("fileWriteResult");
    });

    it("CONTROL: creating a NEW file is never a truncation", async () => {
      const path = join(testDir, "brand-new.ts");
      const result = await resolveFsWrite({ type: "fs_write", path, content: "tiny" });
      expect(result.shape).toBe("fileWriteResult");
    });
  });
});
