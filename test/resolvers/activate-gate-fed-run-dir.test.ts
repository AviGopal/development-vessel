// The run-dir and the gate-public dir are gate-fed: pull-sync (root) and the boot seed write them from the
// accepted gate copy, and development-vessel's unit mounts them read-only. activate_substrate_script must
// refuse cleanly there, never error or write: "the run dir is gate-fed; land the change and let Gate P promote it".
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as act from "../../src/resolvers/activate-substrate-script.js";
const { resolveActivateSubstrateScript } = act;
const setDir = (d: string | null): void => { const f = (act as Record<string, unknown>)["__setGatePublicDirForTests"] as ((d: string | null) => void) | undefined; if (f) f(d); else if (d === null) delete process.env["SELF_FACTS_PUBLIC_DIR"]; else process.env["SELF_FACTS_PUBLIC_DIR"] = d; };
const isGateFedWriteError = (e: unknown): unknown => ((act as Record<string, unknown>)["isGateFedWriteError"] as ((e: unknown) => unknown) | undefined)?.(e);

const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }); if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr)); };
let base: string; let repoRoot: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "gate-fed-"));
  repoRoot = join(base, "super");
  await mkdir(join(repoRoot, "scripts", "substrate"), { recursive: true });
  await writeFile(join(repoRoot, "scripts", "substrate", "x.ts"), "// committed\n");
  git(repoRoot, "init", "-q"); git(repoRoot, "add", "."); git(repoRoot, "commit", "-q", "-m", "seed");
  setDir(join(base, "gate-public"));
});
afterEach(async () => { setDir(null); await rm(base, { recursive: true, force: true }); });

describe("activate_substrate_script and gate-fed dirs", () => {
  it("MUST-FAIL (g): a run_dir under the gate-public dir is ALWAYS refused, nothing written", async () => {
    const runDir = join(base, "gate-public", "sub");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "x.ts"), "// original\n");
    const r = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "x.ts" }, { runDir, repoRoot });
    expect(r.shape).not.toBe("substrateScriptActivation");
    expect(JSON.stringify(r.body)).toContain("gate-fed");
    expect(await readFile(join(runDir, "x.ts"), "utf8")).toBe("// original\n");
  });
  it("MUST-FAIL (h): a read-only run-dir file ⇒ the clean gate-fed refusal, not a raw write error", async () => {
    if (process.getuid?.() === 0) return;
    const runDir = join(base, "active-scripts");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "x.ts"), "// original\n");
    await chmod(join(runDir, "x.ts"), 0o444);
    const r = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "x.ts" }, { runDir, repoRoot });
    expect(JSON.stringify(r.body)).toContain("the run dir is gate-fed; land the change and let Gate P promote it");
  });
  it("MUST-FAIL (h2): EROFS, EACCES and EPERM are gate-fed write errors; others are not", () => {
    expect(isGateFedWriteError({ code: "EROFS" })).toBe(true);
    expect(isGateFedWriteError({ code: "EACCES" })).toBe(true);
    expect(isGateFedWriteError({ code: "EPERM" })).toBe(true);
    expect(isGateFedWriteError({ code: "ENOSPC" })).toBe(false);
    expect(isGateFedWriteError(new Error("x"))).toBe(false);
  });
  it("MUST-FAIL (i2): SELF_FACTS_PUBLIC_DIR in the environment does not move the refused dir", async () => {
    setDir(null);
    const runDir = join(base, "elsewhere");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "x.ts"), "// original\n");
    process.env["SELF_FACTS_PUBLIC_DIR"] = runDir;
    try {
      const r = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "x.ts" }, { runDir, repoRoot });
      expect(r.shape).toBe("substrateScriptActivation");
    } finally { delete process.env["SELF_FACTS_PUBLIC_DIR"]; }
  });
  it("CONTROL: a writable run-dir outside the gate-public dir still activates", async () => {
    const runDir = join(base, "active-scripts");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "x.ts"), "// original\n");
    const r = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "x.ts" }, { runDir, repoRoot });
    expect(r.shape).toBe("substrateScriptActivation");
  });
});
