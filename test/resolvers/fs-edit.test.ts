import { describe, it, expect, beforeAll } from "bun:test";
import { resolveFsEdit } from "../../src/resolvers/fs-edit.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `dev-vessel-fs-edit-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env["WORKSPACE_ROOT"] = testDir;
});

describe("fs-edit resolver", () => {
  it("replaces exactly one occurrence and returns fileEditResult", async () => {
    const path = join(testDir, "edit-me.txt");
    writeFileSync(path, "hello world");
    const result = await resolveFsEdit({ type: "fs_edit", path, oldString: "world", newString: "earth" });
    expect(result.shape).toBe("fileEditResult");
    const body = result.body as { replacedCount: number };
    expect(body.replacedCount).toBe(1);
    expect(await Bun.file(path).text()).toBe("hello earth");
  });

  it("rejects when oldString is not found (0 occurrences)", async () => {
    const path = join(testDir, "no-match.txt");
    writeFileSync(path, "something else");
    await expect(
      resolveFsEdit({ type: "fs_edit", path, oldString: "not-present", newString: "x" }),
    ).rejects.toThrow("not found");
  });

  it("rejects when oldString matches more than once (>1 occurrences)", async () => {
    const path = join(testDir, "multi-match.txt");
    writeFileSync(path, "foo foo foo");
    await expect(
      resolveFsEdit({ type: "fs_edit", path, oldString: "foo", newString: "bar" }),
    ).rejects.toThrow("matches 3 times");
  });

  it("rejects when oldString === newString", async () => {
    const path = join(testDir, "same-strings.txt");
    writeFileSync(path, "identical");
    await expect(
      resolveFsEdit({ type: "fs_edit", path, oldString: "identical", newString: "identical" }),
    ).rejects.toThrow("identical");
  });
});
