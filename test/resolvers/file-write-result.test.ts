import { fileWriteResult } from "../../src/resolvers/file-write-result.js";
import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";

describe("fileWriteResult resolver", () => {
  afterEach(() => {
    if (existsSync("/tmp/audit_count.txt")) rmSync("/tmp/audit_count.txt");
  });

  it("writes word count to /tmp/audit_count.txt", async () => {
    const result = await fileWriteResult({});
    expect(result).toEqual({
      shape: "fileWriteResult",
      body: { written: true, path: "/tmp/audit_count.txt", count: 5 },
    });
    expect(existsSync("/tmp/audit_count.txt")).toBe(true);
  });
});
