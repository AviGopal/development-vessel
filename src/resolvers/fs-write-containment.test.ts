// Pins write containment on THIS vessel's fs_write / fs_edit (the other producer
// of those shapes besides local-tools) and the lane's grant minting.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveFsEdit } from "./fs-edit";
import { resolveFsWrite } from "./fs-write";
import { resolveGitCommit } from "./git-commit";
import { signWriteGrant, withWriteGrant, WRITE_CONTAINMENT_ERROR, WRITE_GRANT_FIELD } from "./write-containment";

const KEY = "test-fleet-key-0123456789";
const PULL_SYNC = "#!/usr/bin/env bash\necho committed pull-sync\n";
const ENV_KEYS = ["WORKSPACE_ROOT", "EXTRA_WORKSPACE_ROOTS", "MITOSIS_RUNTIME_DIR", "MITOSIS_PUSH_CLONE_DIR", "COMPOSE_WS_DIR", "METABOB_API_KEY", "WRITE_ALLOWLIST", "SUPER_REPO_DIR", "MITOSIS_SUPER_REPO_DIR"];
const saved: Record<string, string | undefined> = {};
let base: string, superRepo: string, vessels: string, data: string;

const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
const edit = (path: string, oldString: string, newString: string, grant?: unknown) =>
  resolveFsEdit({ type: "fs_edit", path, oldString, newString, ...(grant ? { write_grant: grant } : {}) });

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), "dv-write-containment-")));
  superRepo = join(base, "git", "super-repo");
  vessels = join(base, "vessels");
  data = join(base, "data");
  put(join(superRepo, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/", "repos/development-vessel/src/resolvers/gap-to-feature.ts"] } }));
  put(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), PULL_SYNC);
  put(join(superRepo, ".gitmodules"), "");
  git(superRepo, "init", "-q"); git(superRepo, "add", "-A"); git(superRepo, "commit", "-qm", "base");
  put(join(vessels, "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const g = 1;\n");
  put(join(data, "report.md"), "report one\n");
  symlinkSync(join(superRepo, "scripts", "substrate"), join(data, "sublink"));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    WORKSPACE_ROOT: superRepo, EXTRA_WORKSPACE_ROOTS: `${data},${vessels}`, MITOSIS_RUNTIME_DIR: vessels,
    MITOSIS_PUSH_CLONE_DIR: join(base, "git", "vessels"), COMPOSE_WS_DIR: join(base, "git", "compose"), METABOB_API_KEY: KEY,
  });
});

afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(base, { recursive: true, force: true });
});

describe("development-vessel fs_edit / fs_write refuse what local-tools refuses", () => {
  it("refuses the 10-01 incident form (relative, excluded, in the live clone) with a scope reason", async () => {
    await expect(edit("scripts/substrate/substrate-pull-sync.sh", "committed", "UNCOMMITTED")).rejects.toThrow("autonomy-scope excluded path 'scripts/substrate/'");
    await expect(resolveFsWrite({ type: "fs_write", path: "scripts/substrate/planted.sh", content: "x" })).rejects.toThrow(WRITE_CONTAINMENT_ERROR);
    expect(readFileSync(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), "utf8")).toBe(PULL_SYNC);
  });

  it("refuses a symlink from a workspace root into the clone", async () => {
    await expect(edit(join(data, "sublink", "substrate-pull-sync.sh"), "committed", "UNCOMMITTED")).rejects.toThrow("autonomy-scope excluded path 'scripts/substrate/'");
    expect(readFileSync(join(superRepo, "scripts", "substrate", "substrate-pull-sync.sh"), "utf8")).toBe(PULL_SYNC);
  });

  it("allows a data path", async () => {
    const r = await edit(join(data, "report.md"), "one", "two");
    expect(r.shape).toBe("fileEditResult");
    expect(readFileSync(join(data, "report.md"), "utf8")).toBe("report two\n");
  });

  it("a vessel tree needs the lane grant; with it, an excluded file is writable", async () => {
    const p = join(vessels, "development-vessel", "src", "resolvers", "gap-to-feature.ts");
    await expect(edit(p, "= 1", "= 2")).rejects.toThrow("autonomy-scope excluded path 'repos/development-vessel/src/resolvers/gap-to-feature.ts'");
    await expect(edit(p, "= 1", "= 2", signWriteGrant("wrong-key", p))).rejects.toThrow(WRITE_CONTAINMENT_ERROR);
    const r = await edit(p, "= 1", "= 2", signWriteGrant(KEY, p));
    expect(r.shape).toBe("fileEditResult");
  });
});

describe("development-vessel git_commit confines its cwd like the fs writers", () => {
  const head = (d: string) => execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  it("refuses the live clone, by relative-to-cwd absolute path, and commits nothing", async () => {
    put(join(superRepo, "docs", "staged.md"), "x\n");
    git(superRepo, "add", "docs/staged.md");
    const before = head(superRepo);
    await expect(resolveGitCommit({ type: "git_commit", message: "planted", cwd: superRepo })).rejects.toThrow("the live super-repo clone");
    // Not even with a grant: nothing lands in the live clone by a tool.
    await expect(resolveGitCommit({ type: "git_commit", message: "planted", cwd: superRepo, write_grant: signWriteGrant(KEY, superRepo) })).rejects.toThrow(WRITE_CONTAINMENT_ERROR);
    expect(head(superRepo)).toBe(before);
    git(superRepo, "reset", "-q", "docs/staged.md");
  });

  it("a vessel tree needs the lane grant; with it the commit runs there", async () => {
    const repo = join(vessels, "demo-repo");
    put(join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    put(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "add", "-A");
    await expect(resolveGitCommit({ type: "git_commit", message: "no grant", cwd: repo })).rejects.toThrow("no lane write grant");
    await expect(resolveGitCommit({ type: "git_commit", message: "forged", cwd: repo, write_grant: signWriteGrant("wrong-key", repo) })).rejects.toThrow(WRITE_CONTAINMENT_ERROR);
    const r = await resolveGitCommit({ type: "git_commit", message: "granted", cwd: repo, write_grant: signWriteGrant(KEY, repo) });
    expect(r.shape).toBe("commandResult");
    expect((r.body as { exitCode: number }).exitCode).toBe(0);
  });

  it("an unprotected directory commits as before", async () => {
    const repo = join(data, "scratch-repo");
    put(join(repo, "a.txt"), "1\n");
    git(repo, "init", "-q"); git(repo, "add", "-A");
    const r = await resolveGitCommit({ type: "git_commit", message: "data", cwd: repo });
    expect((r.body as { exitCode: number }).exitCode).toBe(0);
  });

  it("a secret location is refused before git runs", async () => {
    await expect(resolveGitCommit({ type: "git_commit", message: "x", cwd: "/etc" })).rejects.toThrow("secret location");
  });
});

describe("the lane mints a grant for write tools only", () => {
  it("withWriteGrant signs exactly the path it sends, and nothing else", () => {
    const w = withWriteGrant("fs_edit", { path: "/vessels/x/src/a.ts", old_string: "a", new_string: "b" }, KEY);
    expect((w as Record<string, unknown>)[WRITE_GRANT_FIELD]).toBeDefined();
    expect((withWriteGrant("shell", { command: "ls", path: "/x" }, KEY) as Record<string, unknown>)[WRITE_GRANT_FIELD]).toBeUndefined();
    expect((withWriteGrant("fs_edit", { path: "/x" }, "") as Record<string, unknown>)[WRITE_GRANT_FIELD]).toBeUndefined();
  });

  it("every lane callTool that reaches local-tools attaches it", () => {
    for (const f of ["feature-compose.ts", "patch-with-tools.ts", "perf-canary-resolve.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      const body = src.slice(src.indexOf("async function callTool("), src.indexOf("async function callTool(") + 1400);
      expect(`${f}: ${/withWriteGrant\(tool,/.test(body)}`).toBe(`${f}: true`);
    }
  });
});
