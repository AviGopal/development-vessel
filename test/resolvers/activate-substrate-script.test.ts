import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolveActivateSubstrateScript } from "../../src/resolvers/activate-substrate-script.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

describe("activate-substrate-script resolver", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "active-scripts-"));
    await writeFile(join(runDir, "compose-teacher.ts"), "// original\n", "utf-8");
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("overwrites an existing run-dir script and returns substrateScriptActivation", async () => {
    const content = '// new\nconsole.log("marker");\n';
    const result = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "compose-teacher.ts",
      content,
      runDir,
    });
    expect(result.shape).toBe("substrateScriptActivation");
    const body = result.body as { activated: boolean; bytes: number; changed: boolean };
    expect(body.activated).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.bytes).toBe(Buffer.byteLength(content, "utf-8"));
    expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe(content);
  });

  it("rejects path traversal", async () => {
    const result = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "../../../etc/passwd.ts",
      content: "x",
      runDir,
    });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
  });

  it("rejects non-.ts script", async () => {
    const result = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "compose-teacher.sh",
      content: "x",
      runDir,
    });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
  });

  it("rejects an unknown script not already in the run-dir (no new files)", async () => {
    const result = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "brand-new-script.ts",
      content: "x",
      runDir,
    });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
  });

  it("enforces base_sha optimistic-concurrency guard", async () => {
    const mismatch = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "compose-teacher.ts",
      content: "// new",
      base_sha: "deadbeef",
      runDir,
    });
    expect(mismatch.shape).toBe("structuredError");
    expect((mismatch.body as { activated: boolean }).activated).toBe(false);
    // unchanged on disk
    expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe("// original\n");

    const ok = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "compose-teacher.ts",
      content: "// new",
      base_sha: sha256("// original\n"),
      runDir,
    });
    expect(ok.shape).toBe("substrateScriptActivation");
    expect((ok.body as { activated: boolean }).activated).toBe(true);
  });

  it("requires script and content", async () => {
    const noScript = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      content: "x",
      runDir,
    });
    expect(noScript.shape).toBe("structuredError");
    const noContent = await resolveActivateSubstrateScript({
      type: "activate_substrate_script",
      script: "compose-teacher.ts",
      runDir,
    });
    expect(noContent.shape).toBe("structuredError");
  });
});
