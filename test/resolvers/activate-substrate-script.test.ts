import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolveActivateSubstrateScript } from "../../src/resolvers/activate-substrate-script.js";

// Every unit that runs from the run-dir loads the fleet EnvironmentFile as root, so bytes written
// there execute with every fleet secret. The contract under test: activation copies the COMMITTED
// HEAD:scripts/substrate/<script> blob and never takes source (or a location) from its caller.

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
}

const COMMITTED = '// committed\nconsole.log("reviewed");\n';

describe("activate-substrate-script resolver", () => {
  let runDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "active-scripts-"));
    repoRoot = await mkdtemp(join(tmpdir(), "super-repo-"));
    await writeFile(join(runDir, "compose-teacher.ts"), "// original\n", "utf-8");
    await writeFile(join(runDir, "uncommitted.ts"), "// original\n", "utf-8");
    await mkdir(join(repoRoot, "scripts", "substrate"), { recursive: true });
    await writeFile(join(repoRoot, "scripts", "substrate", "compose-teacher.ts"), COMMITTED, "utf-8");
    git(repoRoot, "init", "-q");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-q", "-m", "seed");
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("activates the committed HEAD blob from a script name alone", async () => {
    const result = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "compose-teacher.ts" },
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("substrateScriptActivation");
    const body = result.body as { activated: boolean; bytes: number; changed: boolean; source: string };
    expect(body.activated).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.bytes).toBe(Buffer.byteLength(COMMITTED, "utf-8"));
    expect(body.source).toMatch(/^scripts\/substrate\/compose-teacher\.ts@[0-9a-f]{40}$/);
    expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe(COMMITTED);
  });

  it("refuses caller-supplied content with a clear error and writes nothing", async () => {
    const result = await resolveActivateSubstrateScript(
      {
        type: "activate_substrate_script",
        script: "compose-teacher.ts",
        content: 'console.log(process.env.OPENAI_API_KEY);\n',
      } as never,
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("structuredError");
    const body = result.body as { activated: boolean; error: string };
    expect(body.activated).toBe(false);
    expect(body.error).toContain("no longer accepts `content`");
    expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe("// original\n");
  });

  it("refuses a pointer-chosen run-dir (the existence gate must not become an arbitrary .ts overwrite)", async () => {
    const victimDir = await mkdtemp(join(tmpdir(), "victim-src-"));
    try {
      await writeFile(join(victimDir, "compose-teacher.ts"), "// vessel source\n", "utf-8");
      const result = await resolveActivateSubstrateScript(
        { type: "activate_substrate_script", script: "compose-teacher.ts", runDir: victimDir } as never,
        { runDir, repoRoot },
      );
      expect(result.shape).toBe("structuredError");
      // The old contract (content + runDir both from the pointer) is the full exploit: refused too.
      const withContent = await resolveActivateSubstrateScript(
        { type: "activate_substrate_script", script: "compose-teacher.ts", runDir: victimDir, content: "// pwned\n" } as never,
        { runDir, repoRoot },
      );
      expect(withContent.shape).toBe("structuredError");
      expect(await readFile(join(victimDir, "compose-teacher.ts"), "utf-8")).toBe("// vessel source\n");
      expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe("// original\n");
    } finally {
      await rm(victimDir, { recursive: true, force: true });
    }
  });

  it("refuses a script that is in the run-dir but not committed at HEAD", async () => {
    await writeFile(join(repoRoot, "scripts", "substrate", "uncommitted.ts"), "// working tree only\n", "utf-8");
    const result = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "uncommitted.ts" },
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("structuredError");
    expect((result.body as { error: string }).error).toContain("not tracked at HEAD");
    expect(await readFile(join(runDir, "uncommitted.ts"), "utf-8")).toBe("// original\n");
  });

  it("rejects path traversal", async () => {
    const result = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "../../../etc/passwd.ts" },
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
  });

  it("rejects non-.ts script", async () => {
    const result = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "compose-teacher.sh" },
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
  });

  it("rejects an unknown script not already in the run-dir (no new files)", async () => {
    const result = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "brand-new-script.ts" },
      { runDir, repoRoot },
    );
    expect(result.shape).toBe("structuredError");
    expect((result.body as { activated: boolean }).activated).toBe(false);
    expect(await readdir(runDir)).not.toContain("brand-new-script.ts");
  });

  it("enforces base_sha optimistic-concurrency guard", async () => {
    const mismatch = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "compose-teacher.ts", base_sha: "deadbeef" },
      { runDir, repoRoot },
    );
    expect(mismatch.shape).toBe("structuredError");
    expect((mismatch.body as { activated: boolean }).activated).toBe(false);
    expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe("// original\n");

    const ok = await resolveActivateSubstrateScript(
      { type: "activate_substrate_script", script: "compose-teacher.ts", base_sha: sha256("// original\n") },
      { runDir, repoRoot },
    );
    expect(ok.shape).toBe("substrateScriptActivation");
    expect((ok.body as { activated: boolean }).activated).toBe(true);
  });

  // The production path: no repoRoot option, the clone is located from WORKSPACE_ROOT, which is
  // deployed both as the clone itself and as the workspace holding it at git/super-repo.
  describe("locating the super-repo from WORKSPACE_ROOT", () => {
    let savedWs: string | undefined;
    beforeEach(() => { savedWs = process.env["WORKSPACE_ROOT"]; });
    afterEach(() => {
      if (savedWs === undefined) delete process.env["WORKSPACE_ROOT"];
      else process.env["WORKSPACE_ROOT"] = savedWs;
    });

    it("WORKSPACE_ROOT is the clone", async () => {
      process.env["WORKSPACE_ROOT"] = repoRoot;
      const result = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "compose-teacher.ts" }, { runDir });
      expect(result.shape).toBe("substrateScriptActivation");
      expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe(COMMITTED);
    });

    it("WORKSPACE_ROOT holds the clone at git/super-repo", async () => {
      const ws = await mkdtemp(join(tmpdir(), "workspace-"));
      try {
        await mkdir(join(ws, "git"), { recursive: true });
        git(join(ws, "git"), "clone", "-q", repoRoot, "super-repo");
        process.env["WORKSPACE_ROOT"] = ws;
        const result = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "compose-teacher.ts" }, { runDir });
        expect(result.shape).toBe("substrateScriptActivation");
        expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe(COMMITTED);
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });

    it("no clone under WORKSPACE_ROOT is refused, nothing written", async () => {
      const ws = await mkdtemp(join(tmpdir(), "workspace-empty-"));
      try {
        process.env["WORKSPACE_ROOT"] = ws;
        const result = await resolveActivateSubstrateScript({ type: "activate_substrate_script", script: "compose-teacher.ts" }, { runDir });
        expect(result.shape).toBe("structuredError");
        expect(await readFile(join(runDir, "compose-teacher.ts"), "utf-8")).toBe("// original\n");
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });
  });

  it("requires script", async () => {
    const noScript = await resolveActivateSubstrateScript({ type: "activate_substrate_script" }, { runDir, repoRoot });
    expect(noScript.shape).toBe("structuredError");
  });
});

// Source guard: the only code that writes into the EnvironmentFile-bearing run-dir is the activate
// resolver, whose pointer carries no source, and no caller hands it source or a run-dir from a pointer.
describe("activate-substrate-script source contract", () => {
  const SRC = join(import.meta.dir, "..", "..", "src");

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("the resolver's pointer interface has no content/runDir field and it never writes caller bytes", async () => {
    const src = await readFile(join(SRC, "resolvers", "activate-substrate-script.ts"), "utf-8");
    const iface = src.slice(src.indexOf("export interface ActivateSubstrateScriptPointer"));
    const body = iface.slice(0, iface.indexOf("}") + 1);
    expect(body).not.toMatch(/\bcontent\??:/);
    expect(body).not.toMatch(/\brunDir\??:/);
    expect(src).not.toMatch(/pointer\.content|pointer\.runDir|pointer\[["']content["']\]/);
    expect(src).toContain("`HEAD:${repoPath}`");
  });

  it("no other src file writes into the run-dir, and no caller passes content or a pointer-derived run-dir", async () => {
    const offenders: string[] = [];
    for (const f of await walk(SRC)) {
      if (f.endsWith(join("resolvers", "activate-substrate-script.ts"))) continue;
      const s = await readFile(f, "utf-8");
      // A write primitive in the same statement as the run-dir path or its env name.
      for (const m of s.matchAll(/(writeFile|writeFileSync|copyFile|copyFileSync|appendFile|Bun\.write)\s*\([^;]*(active-scripts|SUBSTRATE_RUN_DIR|runDir)/g)) {
        offenders.push(`${f}: ${m[0].slice(0, 120)}`);
      }
      for (const m of s.matchAll(/resolveActivateSubstrateScript\s*\(([\s\S]*?)\)\s*;/g)) {
        if (/\bcontent\b/.test(m[1]!) || /pointer\.\w*[rR]unDir/.test(m[1]!)) offenders.push(`${f}: ${m[0].slice(0, 160)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the seeded activity template takes no content input", async () => {
    const { ACTIVATE_SUBSTRATE_SCRIPT_TEMPLATE: tpl } = await import("../../src/seed/activate-substrate-script.js");
    const t = tpl as unknown as {
      inputShapes: string[];
      variables?: Array<{ name: string }>;
      tasks: Array<{ config?: Record<string, unknown> }>;
      metadata?: { seed_version?: number };
    };
    expect(t.inputShapes).not.toContain("content");
    expect((t.variables ?? []).map((v) => v.name)).not.toContain("content");
    for (const task of t.tasks) {
      expect(Object.keys(task.config ?? {})).not.toContain("content");
      expect(Object.keys(task.config ?? {})).not.toContain("runDir");
    }
    // The live row still carries a content binding; only a raised seed_version makes the seeder replace it.
    expect(t.metadata?.seed_version ?? 0).toBeGreaterThanOrEqual(2);
  });
});
