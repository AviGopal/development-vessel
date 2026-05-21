import { describe, it, expect, beforeAll } from "bun:test";
import { resolveFsRead } from "../../src/resolvers/fs-read.js";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-test-${Date.now()}`);
const testFile = join(testDir, "hello.txt");

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(testFile, "hello world");
  // Allow /tmp paths in tests
  process.env["WORKSPACE_ROOT"] = tmpdir();
});

describe("fs-read resolver", () => {
  it("reads a file and returns fileContent shape", async () => {
    const result = await resolveFsRead({ type: "fs_read", path: testFile });
    expect(result.shape).toBe("fileContent");
    const body = result.body as { path: string; content: string; truncated: boolean };
    expect(body.content).toBe("hello world");
    expect(body.truncated).toBe(false);
  });

  it("throws for missing files", async () => {
    await expect(resolveFsRead({ type: "fs_read", path: join(testDir, "does-not-exist.txt") })).rejects.toThrow("file not found");
  });
});
