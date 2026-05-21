import { describe, it, expect, beforeAll } from "bun:test";
import { resolveFsWrite } from "../../src/resolvers/fs-write.js";
import { mkdirSync } from "fs";
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
});
