// AN ISOLATED CHILD WRITES NO LIVE LEARNED STATE (2026-10-17; user ruling 02:49:22Z "stop leak ... before RUN 2").
// runCasesIsolated and gap-sweep-landed-partial's child built their env from scratch, which dropped every state
// redirect, so code under test fell back to its live defaults: fixture classes (stale-flap, stale-ctrl, sweep-*) landed
// in node1's LIVE /workspace/gap-class-posteriors.json during gate suites. Both now use isolatedChildEnv.
// MUST-FAIL on the parent (a4d74f11): isolatedChildEnv does not exist (the children resolve the live default).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedChildEnv, learnedStateDefaults } from "./isolated-gap-store-run";

const REPO = join(import.meta.dir, "..", "..");
const SRC = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("an isolated child's learned state stays under its temp root", () => {
  it("[MUST-FAIL] the class posterior the REAL module resolves in the child is under tmpdir, never /workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-env-"));
    try {
      const code = `const lc = await import(${JSON.stringify(join(REPO, "src", "judge", "learning-credit.js"))}); console.log("PATH=" + lc.tablePath("class_posteriors"));`;
      const p = Bun.spawnSync(["bun", "-e", code], { env: isolatedChildEnv(root), cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const out = new TextDecoder().decode(p.stdout);
      const got = /PATH=(.*)/.exec(out)?.[1]?.trim() ?? "";
      expect(got, new TextDecoder().decode(p.stderr).slice(-1500)).not.toBe("");
      expect(got.startsWith("/workspace")).toBe(false);
      expect(resolve(got).startsWith(resolve(root))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);

  it("[MUST-FAIL] every learned-state default src names is redirected under the root (derived from src, as pull-sync derives it)", () => {
    const names = learnedStateDefaults();
    expect(names.has("GAP_CLASS_POSTERIOR_PATH")).toBe(true);
    expect(names.size).toBeGreaterThan(3);
    const env = isolatedChildEnv(join(tmpdir(), "iso-env-check"));
    for (const n of names.keys()) expect(env[n]!.startsWith(join(tmpdir(), "iso-env-check"))).toBe(true);
  });

  it("[CONTROL] a root outside tmpdir is REFUSED (the spawn never happens with a live path)", () => {
    expect(() => isolatedChildEnv("/workspace")).toThrow(/refused/);
    expect(() => isolatedChildEnv(join(tmpdir(), "ok"), { GAP_CLASS_POSTERIOR_PATH: "/workspace/gap-class-posteriors.json" })).toThrow(/refused/);
  });

  it("[WIRING] both children use it: runCasesIsolated and gap-sweep-landed-partial's sweep child", () => {
    expect(SRC("test/resolvers/isolated-gap-store-run.ts")).toContain("const env = isolatedChildEnv(root);");
    expect(SRC("test/resolvers/gap-sweep-landed-partial.test.ts")).toContain("const env = isolatedChildEnv(ROOT, {");
  });
});
