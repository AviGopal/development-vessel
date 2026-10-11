import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setGitLogRootsForTests, buildGitLogArgv, gitLogSpawnEnv, resolveGitLog,
  GIT_LOG_MAX_LIMIT, GIT_LOG_SINCE_MAX_LEN, GIT_LOG_SINCE_RE, GIT_LOG_VESSEL_NAME_RE,
} from "../../src/resolvers/git-log.js";
import { resolveResolverSchema } from "../../src/resolvers/resolver-schema.js";
import { config } from "../../src/config.js";

// git_log against a TEMP layout, never a live clone. The layout mirrors the substrate's:
//   super/                 the super-repo clone (the default root), with an in-tree vessel at repos/inv-vessel
//   clones/ext-vessel/     a submodule vessel's push clone (MITOSIS_PUSH_CLONE_DIR/<vessel>)
//   outside/               a git repo OUTSIDE every root, reachable only through super/escape (a symlink)
//
// The resolver used to run `git log` in pointer.cwd and, given none, in the process cwd — on the live
// substrate /vessels/development-vessel, a runtime mirror with no .git — so every walk call answered
// "fatal: not a git repository" (exit 128). The first case is that defect.

type Body = { exitCode: number; stdout: string; stderr: string; refused?: boolean; error?: string; cwd?: string };

let T: string;
let SUPER: string;
let CLONES: string;
let OUTSIDE: string;
let MARKER: string;

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: T,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...extraEnv,
    },
    stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function commit(repo: string, file: string, subject: string, date?: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), `${subject}\n`);
  git(repo, ["add", "--", file]);
  git(repo, ["commit", "-q", "-m", subject], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "dev"]);
}

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "git-log-test-")));
  SUPER = join(T, "super");
  CLONES = join(T, "clones");
  OUTSIDE = join(T, "outside");
  MARKER = join(T, "helper-ran");

  initRepo(SUPER);
  commit(SUPER, "old.txt", "super old commit", "2020-01-01T00:00:00Z");
  commit(SUPER, "repos/inv-vessel/package.json", "inv-vessel own commit", "2020-01-02T00:00:00Z");
  commit(SUPER, "README.md", "super recent commit");
  mkdirSync(join(SUPER, "docs"), { recursive: true });

  initRepo(join(CLONES, "ext-vessel"));
  commit(join(CLONES, "ext-vessel"), "src/index.ts", "ext vessel commit");

  initRepo(OUTSIDE);
  commit(OUTSIDE, "secret.txt", "outside commit");
  symlinkSync(OUTSIDE, join(SUPER, "escape"));
  symlinkSync("/etc", join(SUPER, "etc-link"));

  // A helper that WRITES a marker file if git ever runs it. Wired into the super clone's own config as a
  // diff driver, textconv, gpg program and pager: a plain read-only `git log` must run none of them.
  const helper = join(T, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\ntouch '${MARKER}'\ncat "$@" 2>/dev/null\n`);
  chmodSync(helper, 0o755);
  git(SUPER, ["config", "diff.external", helper]);
  git(SUPER, ["config", "diff.mk.textconv", helper]);
  git(SUPER, ["config", "gpg.program", helper]);
  git(SUPER, ["config", "log.showSignature", "true"]);
  git(SUPER, ["config", "core.pager", helper]);
  writeFileSync(join(SUPER, ".git", "info", "attributes"), "* diff=mk\n");
});

afterEach(() => __setGitLogRootsForTests({ superRepo: SUPER, cloneDir: CLONES }));
afterAll(() => {
  __setGitLogRootsForTests(null);
  rmSync(T, { recursive: true, force: true });
});

const run = async (p: Record<string, unknown>): Promise<Body> => {
  __setGitLogRootsForTests({ superRepo: SUPER, cloneDir: CLONES });
  const r = await resolveGitLog({ type: "git_log", ...p } as Parameters<typeof resolveGitLog>[0]);
  expect(r.shape).toBe("commandResult");
  return r.body as Body;
};
const subjects = (b: Body): string[] => b.stdout.trim().split("\n").filter(Boolean);

describe("git_log reads the substrate's own history by default", () => {
  it("(a) with no cwd it reads the super-repo clone: exit 0, that clone's commits", async () => {
    const b = await run({});
    expect(b.stderr).not.toContain("not a git repository");
    expect(b.exitCode).toBe(0);
    expect(subjects(b)[0]).toBe("super recent commit");
    expect(subjects(b)).toContain("super old commit");
    expect(b.cwd).toBe(SUPER);
  });

  it("(a) an uninterpolated {{cwd}} slot (the seeded templates' form) means no cwd, not a path", async () => {
    const b = await run({ cwd: "{{cwd}}" });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)[0]).toBe("super recent commit");
  });

  it("(a) without the test seam the default root is WORKSPACE_ROOT, read at call time", async () => {
    const saved = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = SUPER;
    try {
      __setGitLogRootsForTests(null);
      const r = await resolveGitLog({ type: "git_log", limit: 1 });
      const b = r.body as Body;
      expect(b.exitCode).toBe(0);
      expect(b.stdout.trim()).toBe("super recent commit");
    } finally {
      if (saved === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = saved;
    }
  });

  it("limit and format are honoured", async () => {
    const b = await run({ limit: 1, format: "%H" });
    expect(b.exitCode).toBe(0);
    expect(b.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a cwd inside the root is allowed (relative paths resolve against the super-repo clone)", async () => {
    const b = await run({ cwd: "docs", limit: 1 });
    expect(b.exitCode).toBe(0);
    expect(b.stdout.trim()).toBe("super recent commit");
    const c = await run({ cwd: join(CLONES, "ext-vessel", "src"), limit: 1 });
    expect(c.exitCode).toBe(0);
    expect(c.stdout.trim()).toBe("ext vessel commit");
  });
});

describe("git_log repo=<vessel>", () => {
  it("(b) a submodule vessel reads its push clone", async () => {
    const b = await run({ repo: "ext-vessel" });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)).toEqual(["ext vessel commit"]);
    expect(b.cwd).toBe(join(CLONES, "ext-vessel"));
  });

  it("(b) an in-tree vessel reads the super-repo log scoped to repos/<vessel>", async () => {
    const b = await run({ repo: "inv-vessel" });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)).toEqual(["inv-vessel own commit"]);
  });

  it("(e) an unknown vessel name is a clear error, not a fallback to another clone", async () => {
    const b = await run({ repo: "no-such-vessel" });
    expect(b.refused).toBe(true);
    expect(b.exitCode).not.toBe(0);
    expect(b.error).toContain("unknown repo");
    expect(b.error).toContain("no-such-vessel");
    expect(b.stdout).toBe("");
  });

  it("(e) a name that is not a vessel name is refused", async () => {
    for (const repo of ["../outside", "ext-vessel log", "Ext", "a/b"]) {
      const b = await run({ repo });
      expect(b.refused).toBe(true);
      expect(b.stdout).toBe("");
    }
    // "log" is a well-formed name that names no clone: refused as unknown, never run as a subcommand.
    const l = await run({ repo: "log" });
    expect(l.refused).toBe(true);
    expect(l.error).toContain("unknown repo");
  });

  it("repo and cwd together are refused", async () => {
    const b = await run({ repo: "ext-vessel", cwd: "docs" });
    expect(b.refused).toBe(true);
  });
});

describe("git_log containment: a cwd must realpath inside the clone roots", () => {
  for (const [label, cwd] of [
    ["/etc", "/etc"],
    ["../..", "../.."],
    ["a symlink out of the root", "escape"],
    ["an absolute path through that symlink", "SUPER/escape"],
    ["a symlink to /etc", "etc-link"],
    ["a nonexistent directory", "no/such/dir"],
  ] as const) {
    it(`(c) ${label} is refused`, async () => {
      const b = await run({ cwd: cwd.replace(/^SUPER/, SUPER) });
      expect(b.refused).toBe(true);
      expect(b.exitCode).not.toBe(0);
      expect(b.stdout).toBe("");
      expect(b.stdout).not.toContain("outside commit");
      expect(typeof b.error).toBe("string");
    });
  }
});

describe("git_log since", () => {
  it("(d) since=\"24 hours ago\" keeps only commits committed in the last day", async () => {
    const b = await run({ since: "24 hours ago", limit: 50 });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)).toEqual(["super recent commit"]);
    const all = await run({ limit: 50 });
    expect(subjects(all).length).toBe(3);
  });

  it("(e) since is ONE argv element --since=<value>", () => {
    const argv = buildGitLogArgv({ limit: 5, format: "%s", since: "24 hours ago" });
    expect(argv.slice(0, 2)).toEqual(["git", "log"]);
    expect(argv.filter((a) => a.startsWith("--since"))).toEqual(["--since=24 hours ago"]);
    expect(argv).not.toContain("--since");
    expect(argv).not.toContain("24 hours ago");
  });

  it("a since carrying shell metacharacters is refused", async () => {
    for (const since of ["yesterday; rm -rf /", "$(id)", "`id`", "1 day ago | cat", "a\nb"]) {
      const b = await run({ since });
      expect(b.refused).toBe(true);
    }
  });
});

describe("git_log is read-only: no field becomes an option or a subcommand", () => {
  it("(a) a value beginning with '-' is refused for since, format, repo and cwd, and git writes nothing", async () => {
    const cases: Array<[string, string]> = [
      ["since", "--output=OUT/since"],
      ["format", "--output=OUT/format"],
      ["repo", "--git-dir=/x"],
      ["cwd", "--output=OUT/cwd"],
      ["since", "-p"],
      ["format", " --output=OUT/format-sp"],
    ];
    for (const [field, raw] of cases) {
      const value = raw.replace("OUT", T);
      const b = await run({ [field]: value });
      expect(b.refused).toBe(true);
      expect(b.stdout).toBe("");
    }
    for (const f of ["since", "format", "cwd", "format-sp"]) expect(existsSync(join(T, f))).toBe(false);
  });

  it("(b) limit must be a positive integer no greater than 200; over the cap is refused, not clamped", async () => {
    for (const limit of [0, -1, 2.5, 201, 1e9, Number.NaN, "abc", "--output=x", "-1"]) {
      const b = await run({ limit });
      expect(b.refused).toBe(true);
      expect(b.stdout).toBe("");
    }
    const ok = await run({ limit: 200 });
    expect(ok.exitCode).toBe(0);
    const s = await run({ limit: "2" });
    expect(s.exitCode).toBe(0);
    expect(subjects(s).length).toBe(2);
  });

  it("(c) the argv is always [\"git\", \"log\", ...]: a shell-looking format is a literal pretty format", async () => {
    const victim = join(T, "victim");
    writeFileSync(victim, "x");
    const b = await run({ format: `%s; rm -f ${victim}`, limit: 1 });
    expect(b.exitCode).toBe(0);
    expect(b.stdout.trim()).toBe(`super recent commit; rm -f ${victim}`);
    expect(existsSync(victim)).toBe(true);
    const argv = buildGitLogArgv({ limit: 1, format: "x; rm", pathspec: ["."] });
    expect(argv.slice(0, 2)).toEqual(["git", "log"]);
    expect(argv).toContain("--pretty=x; rm");
    expect(argv.indexOf("--")).toBe(argv.length - 2);
  });

  it("(d) the clone's own config cannot run a helper: no diff/textconv/gpg/pager marker is written", async () => {
    rmSync(MARKER, { force: true });
    const b = await run({ limit: 10 });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)[0]).toBe("super recent commit");
    expect(existsSync(MARKER)).toBe(false);
    const argv = buildGitLogArgv({ limit: 1, format: "%s" });
    for (const flag of ["--no-ext-diff", "--no-textconv", "--no-show-signature"]) expect(argv).toContain(flag);
  });

  it("(d) the vessel's own global git config is not read: a pretty alias it defines is unknown to git_log", () => {
    // Run the resolver in a CHILD process whose environment carries GIT_CONFIG_GLOBAL, as the vessel's would:
    // Bun.spawn does not see process.env assignments made inside this process, so mutating it here would prove nothing.
    const globalCfg = join(T, "global.gitconfig");
    writeFileSync(globalCfg, '[pretty]\n\tgl = "GLOBAL-%s"\n');
    const mod = join(import.meta.dir, "../../src/resolvers/git-log.ts");
    const script =
      `const m = await import(${JSON.stringify(mod)});` +
      `m.__setGitLogRootsForTests({ superRepo: ${JSON.stringify(SUPER)}, cloneDir: ${JSON.stringify(CLONES)} });` +
      `const r = await m.resolveGitLog({ type: "git_log", format: "gl", limit: 1 });` +
      `process.stdout.write(JSON.stringify(r.body));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: T,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: T, GIT_CONFIG_GLOBAL: globalCfg, WORKSPACE_ROOT: T },
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const b = JSON.parse(child.stdout.toString()) as Body;
    expect(b.stdout).not.toContain("GLOBAL-");
    expect(b.stderr).toContain("invalid --pretty format");
    // Positive control through the same address: git itself does read that file when the env is inherited.
    const ctl = Bun.spawnSync(["git", "log", "-1", "--pretty=gl"], { cwd: SUPER, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: T, GIT_CONFIG_GLOBAL: globalCfg }, stdout: "pipe" });
    expect(ctl.stdout.toString()).toContain("GLOBAL-super recent commit");
  });

  it("(d) git spawns with no system or global config and an empty HOME", () => {
    const env = gitLogSpawnEnv("/tmp/empty-home");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(env["HOME"]).toBe("/tmp/empty-home");
    expect(Object.keys(env).some((k) => k === "GIT_DIR" || k === "GIT_WORK_TREE")).toBe(false);
  });
});

describe("git_log advertises its pointer fields", () => {
  const FIELDS = ["repo", "cwd", "limit", "format", "since"];

  it("the registered description names repo, cwd, limit, format and since, with the enforced limit cap", () => {
    const d = (config.discovery.shapeDescriptions as Record<string, string>)["git_log"] ?? "";
    for (const field of FIELDS) expect(d).toContain(field);
    expect(d).toContain(`1-${GIT_LOG_MAX_LIMIT}`);
    expect(config.discovery.shapes as readonly string[]).toContain("git_log");
  });

  // What goal-host's llmExtractPointerArgs reads: it resolves pointer {type:"resolver_schema", shape} on the
  // owning vessel (this one) and builds its AUTHORITATIVE PAYLOAD CONTRACT block from body.fields / body.notes.
  it("the resolver_schema contract arg synthesis reads lists all five fields, all optional, flat", () => {
    const r = resolveResolverSchema({ shape: "git_log" });
    expect(r.shape).toBe("resolver_schema");
    const b = r.body as { known: boolean; envelope?: string; fields: Array<{ name: string; required: boolean }>; required: string[]; notes: string };
    expect(b.known).toBe(true);
    expect(b.envelope).toBeUndefined();
    expect(b.fields.map((f) => f.name).sort()).toEqual([...FIELDS].sort());
    expect(b.fields.map((f) => f.name)).toContain("since");
    expect(b.required).toEqual([]);
  });

  it("the contract's notes carry the SAME constraints the resolver enforces", () => {
    const notes = (resolveResolverSchema({ shape: "git_log" }).body as { notes: string }).notes;
    expect(notes).toContain(GIT_LOG_VESSEL_NAME_RE.source);
    expect(notes).toContain(`from 1 to ${GIT_LOG_MAX_LIMIT}`);
    expect(notes).toContain(GIT_LOG_SINCE_RE.source);
    expect(notes).toContain(`at most ${GIT_LOG_SINCE_MAX_LEN} characters`);
    expect(notes).toContain("No value may begin with '-'");
  });

  it("CONFORMANCE: the constraints in the contract are the ones the resolver applies at their boundaries", async () => {
    // At each limit/length boundary the resolver accepts, and one past it refuses.
    expect((await run({ limit: GIT_LOG_MAX_LIMIT })).exitCode).toBe(0);
    expect((await run({ limit: GIT_LOG_MAX_LIMIT + 1 })).refused).toBe(true);
    const longSince = "1".repeat(GIT_LOG_SINCE_MAX_LEN);
    expect((await run({ since: longSince })).refused).toBeUndefined();
    expect((await run({ since: longSince + "1" })).refused).toBe(true);
    // A payload built from every field the contract lists (repo, not cwd: they are exclusive) is accepted.
    const b = await run({ repo: "ext-vessel", limit: 3, format: "%s", since: "24 hours ago" });
    expect(b.exitCode).toBe(0);
    expect(subjects(b)).toEqual(["ext vessel commit"]);
  });
});
