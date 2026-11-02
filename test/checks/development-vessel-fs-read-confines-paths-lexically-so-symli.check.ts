import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as mod from "../../src/resolvers/fs-read";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let oldWR: string | undefined;
let rootDir = "";
let outsideDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "wr-"));
  outsideDir = await mkdtemp(join(tmpdir(), "out-"));
  oldWR = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = rootDir;
  // Ensure no extra roots accidentally permit our outside dir.
  delete process.env["FS_READ_EXTRA_ROOTS"];
  delete process.env["EXTRA_WORKSPACE_ROOTS"];
});

afterEach(async () => {
  if (oldWR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = oldWR;
  await rm(rootDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("fs_read containment across realpath vs lexical", () => {
  test("SYMLINK ESCAPE: throws 'path outside workspace root:' for symlink escaping WORKSPACE_ROOT", async () => {
    // Arrange: a file OUTSIDE the workspace, and a symlink INSIDE pointing to it.
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "top secret\n");
    const leakyLink = join(rootDir, "leak.txt");
    await symlink(outsideFile, leakyLink, "file");

    const pointer: mod.FsReadPointer = {
      type: "fs_read",
      path: leakyLink,
      encoding: "utf-8",
    };

    // Correct behavior: a symlink that resolves outside WORKSPACE_ROOT is rejected by the workspace guard.
    await expect(mod.resolveFsRead(pointer)).rejects.toThrow(/path outside workspace root:/);
  });

  test("CONTROL: reading a regular file inside WORKSPACE_ROOT returns shape=fileContent with its content", async () => {
    const insideFile = join(rootDir, "ok.txt");
    const content = "hello world\n";
    await writeFile(insideFile, content);

    const result = await mod.resolveFsRead({ type: "fs_read", path: insideFile, encoding: "utf-8" });

    expect(result.shape).toBe("fileContent");
    // Assert on the same returned shape as the early-missing path at fs-read.ts:48.
    expect((result as any).body.path).toBe(insideFile);
    expect((result as any).body.content).toBe(content);
    expect((result as any).body.truncated).toBe(false);
    expect(typeof (result as any).body.bytes).toBe("number");
    expect((result as any).body.bytes).toBeGreaterThanOrEqual(content.length);
  });
});
