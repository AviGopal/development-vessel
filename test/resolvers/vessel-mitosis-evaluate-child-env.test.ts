// PROTECTED (excluded_paths, with src/test-child-env.ts). A child that runs vessel code gets the scrubbed
// env from ONE shared helper, never the parent's.
//
// The development-vessel and local-tools-vessel units both load the fleet secrets file. The commands their
// children run are lane-authorable (package.json scripts for `bun run typecheck` and `bun install`, test files
// for `bun test`), so a child that inherits the parent's env can read every credential the node holds. This
// file pins:
//   - the helper's allowlist (exact, and no credential-shaped name), for both renderers;
//   - admission's default typecheck runner (gap-to-feature) spawning with that env;
//   - every bun/bunx command feature-compose builds for the shell producer starting from the shell prefix.
//
// The helper is imported dynamically inside each test, so at the parent (no helper) the behavioural tests fail
// on their assertions rather than the file failing to load. Every secret value here is a FAKE fixture.
import { describe, test, expect, afterEach } from "bun:test";
import ts from "typescript";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HELPER = "../../src/test-child-env.ts";
const SRC = join(import.meta.dir, "..", "..", "src");
const FAKE = "fake-cred-1c0ffee";
/** Where the running bun lives (the helper appends it to PATH). */
const EXEC_DIR = dirname(process.execPath);
/** A PATH directory holding an executable NAMED bun (a host install may run bun as `bun.exe` behind a symlink). */
const BUN_DIR = dirname(Bun.which("bun") ?? process.execPath);

/** The ONLY keys a scrubbed child env may carry. */
const ALLOWED_KEYS = ["HOME", "NODE_ENV", "PATH", "TZ", "WORKSPACE_ROOT"];
const CREDENTIAL_SHAPED = /PASS|KEY|TOKEN|SECRET|PAT\b|_PAT|JWT|CRED|AUTH|COOKIE|^METABOB_|^SUBSTRATE_|^SURREAL|^ACTIVITY_API/i;

/** A parent env as the units give it: fake credentials beside the two names a child needs. */
function credentialFixture(home: string): Record<string, string> {
  return {
    PATH: `/usr/bin:/bin:${BUN_DIR}`,
    HOME: home,
    TMPDIR: home, // the prefix's own mktemp lands in the scratch, never in /tmp
    SURREALDB_PASS: `${FAKE}-surreal-pass`,
    SURREALDB_PASSWORD: `${FAKE}-surreal-password`,
    SURREALDB_USER: `${FAKE}-surreal-user`,
    METABOB_API_KEY: `${FAKE}-metabob-key`,
    METABOB_ADMIN_TOKEN: `${FAKE}-metabob-admin`,
    SUBSTRATE_GIT_PAT: `${FAKE}-git-pat`,
    SUBSTRATE_API_KEY: `${FAKE}-substrate-key`,
    ACTIVITY_API_URL: `http://${FAKE}.invalid:8080`,
    ACTIVITY_API_TOKEN: `${FAKE}-activity-token`,
    VESSEL_JWT: `${FAKE}-jwt`,
    ANTHROPIC_API_KEY: `${FAKE}-llm-key`,
    GITHUB_TOKEN: `${FAKE}-gh-token`,
    NPM_CONFIG_TOKEN: `${FAKE}-npm-token`,
    WORKSPACE_ROOT: `/${FAKE}-live-workspace`,
  };
}

const scratch: string[] = [];
function mkScratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `child-env-${tag}-`));
  scratch.push(d);
  return d;
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `KEY=value` lines of an `env` dump, as [key, value] (multi-line values are not produced by these fixtures). */
function envLines(out: string): Array<[string, string]> {
  return out
    .split("\n")
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]);
}

/** Every non-test source file under src/. */
function srcFiles(dir: string = SRC): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}

describe("test-child-env: the allowlist", () => {
  test("[MUST-FAIL] testChildEnv(credentialFixture) returns only allowlisted keys and no credential value", async () => {
    const helper = await import(HELPER).catch(() => null);
    expect(helper).not.toBeNull();
    const fx = credentialFixture("/home/fixture");
    const env = helper!.testChildEnv(fx) as Record<string, string>;
    for (const k of Object.keys(env)) expect(ALLOWED_KEYS).toContain(k);
    for (const k of Object.keys(fx)) if (!ALLOWED_KEYS.includes(k)) expect(env[k]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(FAKE);
    // the parent's WORKSPACE_ROOT is never inherited: only an explicit scratch root is set
    expect(env["WORKSPACE_ROOT"]).toBeUndefined();
    const ws = helper!.testChildEnv(fx, { workspaceRoot: "/tmp/scratch-ws" }) as Record<string, string>;
    expect(ws["WORKSPACE_ROOT"]).toBe("/tmp/scratch-ws");
    expect(JSON.stringify(ws)).not.toContain(FAKE);
  });

  test("[MUST-FAIL] the exported allowlist is exactly PATH+HOME passthrough and NODE_ENV=test, TZ=UTC fixed; no name is credential-shaped", async () => {
    const helper = await import(HELPER).catch(() => null);
    expect(helper).not.toBeNull();
    const pass = [...(helper!.TEST_CHILD_ENV_PASSTHROUGH as readonly string[])].sort();
    expect(pass).toEqual(["HOME", "PATH"]);
    expect({ ...(helper!.TEST_CHILD_ENV_FIXED as Record<string, string>) }).toEqual({ NODE_ENV: "test", TZ: "UTC" });
    for (const n of [...pass, ...Object.keys(helper!.TEST_CHILD_ENV_FIXED)]) expect(n).not.toMatch(CREDENTIAL_SHAPED);
  });

  test("[MUST-FAIL] the shell prefix starts from an empty env and a child under it sees only allowlisted keys (behavioural)", async () => {
    const helper = await import(HELPER).catch(() => null);
    expect(helper).not.toBeNull();
    const prefix = helper!.testChildEnvShellPrefix() as string;
    expect(prefix.startsWith("env -i ")).toBe(true);
    // the two renderers name the same passthrough set
    const named = [...prefix.matchAll(/([A-Z_]+)="\$([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(named).toEqual([...(helper!.TEST_CHILD_ENV_PASSTHROUGH as readonly string[])].sort());
    const home = mkScratch("prefix-home");
    const p = Bun.spawnSync(["bash", "-c", `${prefix} env`], { env: credentialFixture(home), stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    const lines = envLines(out);
    expect(lines.map(([k]) => k)).toContain("PATH");
    for (const [k] of lines) expect(ALLOWED_KEYS).toContain(k);
    expect(out).not.toContain(FAKE);
    const ws = lines.find(([k]) => k === "WORKSPACE_ROOT")?.[1] ?? "";
    if (ws) rmSync(ws, { recursive: true, force: true }); // the prefix's mktemp scratch
  });

  test("[CONTROL] the child keeps what it needs: PATH (with the running bun's dir), HOME, NODE_ENV=test, TZ=UTC", async () => {
    const helper = await import(HELPER).catch(() => null);
    expect(helper).not.toBeNull();
    const env = helper!.testChildEnv({ PATH: "/usr/bin:/bin", HOME: "/home/fixture" }) as Record<string, string>;
    expect(env["HOME"]).toBe("/home/fixture");
    expect(env["PATH"]!.split(":")).toEqual(expect.arrayContaining(["/usr/bin", "/bin", EXEC_DIR]));
    expect(env["NODE_ENV"]).toBe("test");
    expect(env["TZ"]).toBe("UTC");
  });
});

describe("gap-to-feature admission: the default typecheck runner spawns with the scrubbed env", () => {
  // The runner runs in a CHILD bun whose real environ holds the fake credentials, as the unit's process does. Setting
  // process.env in this test process would prove nothing: a spawn with no `env` inherits the process's original
  // environ, not later process.env writes (measured: an env-less mutant passed that version of this test).
  test("[MUST-FAIL] a lane-authorable `typecheck` script run during admission sees no parent credential (behavioural)", () => {
    const root = mkScratch("tc-root");
    const vessel = "fixture-vessel";
    const vdir = join(root, vessel);
    mkdirSync(vdir, { recursive: true });
    const marker = join(root, "child-env.txt");
    // The script dumps its env to a marker and exits non-zero if any fixture credential reached it.
    writeFileSync(join(vdir, "probe.sh"), `env > ${JSON.stringify(marker)}\nif env | grep -q ${FAKE}; then exit 7; fi\nexit 0\n`);
    writeFileSync(join(vdir, "package.json"), JSON.stringify({ name: "fixture-vessel", private: true, scripts: { typecheck: "sh ./probe.sh" } }));
    const driver = join(root, "drive.ts");
    writeFileSync(
      driver,
      `const g = (await import(${JSON.stringify(join(SRC, "resolvers", "gap-to-feature.ts"))})) as Record<string, unknown>;\n` +
        `const run = g["defaultTypecheckRunner"] as ((v: string) => unknown) | undefined;\n` +
        `console.log("RUNNER=" + (typeof run === "function" ? JSON.stringify(run(${JSON.stringify(vessel)})) : "absent"));\n` +
        `process.exit(0);\n`,
    );
    const home = join(root, "home");
    mkdirSync(home);
    const parentWs = join(root, "parent-ws");
    mkdirSync(parentWs);
    const env = { ...credentialFixture(home), WORKSPACE_ROOT: parentWs, MITOSIS_RUNTIME_DIR: root };
    const p = Bun.spawnSync([process.execPath, driver], { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const out = p.stdout.toString();
    expect(out).toContain("RUNNER=");
    expect(out).not.toContain("RUNNER=absent"); // the seam: the runner is exported
    expect(existsSync(marker)).toBe(true); // positive control: the script ran
    const dumped = readFileSync(marker, "utf8");
    expect(dumped).not.toContain(FAKE);
    for (const [k] of envLines(dumped)) {
      // bun run adds its own npm_* / lifecycle names; nothing from the parent beyond the allowlist
      if (/^(npm_|BUN_|_$|PWD$|OLDPWD$|SHLVL$|INIT_CWD$|NODE$|COLOR$|FORCE_COLOR$)/.test(k)) continue;
      expect(ALLOWED_KEYS).toContain(k);
    }
    const childWs = envLines(dumped).find(([k]) => k === "WORKSPACE_ROOT")?.[1] ?? "";
    expect(childWs).not.toBe("");
    expect(childWs).not.toBe(parentWs); // a scratch root, never the parent's workspace
    expect(existsSync(childWs)).toBe(false); // ...removed after the run
    expect(out).toContain(`RUNNER=${JSON.stringify({ ran: true, clean: true })}`);
  });

  test("[MUST-FAIL] the runner's Bun.spawnSync passes `env` from the shared helper (source)", () => {
    const src = readFileSync(join(SRC, "resolvers", "gap-to-feature.ts"), "utf8");
    const sf = ts.createSourceFile("gap-to-feature.ts", src, ts.ScriptTarget.Latest, true);
    let fn: ts.FunctionDeclaration | undefined;
    sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === "defaultTypecheckRunner") fn = n; });
    expect(fn).toBeDefined();
    const spawns: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && /^Bun\.spawn(Sync)?$/.test(n.expression.getText(sf))) spawns.push(n);
      n.forEachChild(visit);
    };
    visit(fn!);
    expect(spawns.length).toBe(1);
    const call = spawns[0]!;
    const opts = call.arguments[1];
    expect(opts && ts.isObjectLiteralExpression(opts)).toBe(true);
    const envProp = (opts as ts.ObjectLiteralExpression).properties.find((p) => p.name?.getText(sf) === "env");
    expect(envProp).toBeDefined();
    expect(envProp!.getText(sf)).not.toContain("process.env");
    // the env is the helper's: the spawn sits inside withTestChildEnv((env) => …)
    let up: ts.Node | undefined = call.parent;
    let wrapped = false;
    while (up && up !== fn) {
      if (ts.isCallExpression(up) && up.expression.getText(sf) === "withTestChildEnv") wrapped = true;
      up = up.parent;
    }
    expect(wrapped).toBe(true);
    expect(src).toMatch(/import \{ withTestChildEnv \} from "\.\.\/test-child-env\.js";/);
  });
});

describe("feature-compose: every bun command built for the shell producer starts from the shared prefix", () => {
  const FC_PATH = join(SRC, "resolvers", "feature-compose.ts");
  const PREFIX_CALL = "${testChildEnvShellPrefix()}";

  /** Template/string literals that ARE shell commands: `command:` initializers and the bodies of `*Command` builders. */
  function commandLiterals(): Array<{ where: string; text: string }> {
    const src = readFileSync(FC_PATH, "utf8");
    const sf = ts.createSourceFile("feature-compose.ts", src, ts.ScriptTarget.Latest, true);
    const roots: Array<{ where: string; node: ts.Node }> = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "command") roots.push({ where: `command@${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`, node: n.initializer });
      if (ts.isFunctionDeclaration(n) && n.name && /Command$/.test(n.name.text) && n.body) roots.push({ where: n.name.text, node: n.body });
      n.forEachChild(visit);
    };
    visit(sf);
    const out: Array<{ where: string; text: string }> = [];
    for (const r of roots) {
      const lit = (n: ts.Node): void => {
        if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
          out.push({ where: r.where, text: n.getText(sf) });
          return; // nested templates inside spans are part of this text already
        }
        n.forEachChild(lit);
      };
      lit(r.node);
    }
    return out;
  }

  /** Every `bun`/`bunx` invocation in a command literal, with the text just before it. */
  function bunInvocations(): Array<{ where: string; before: string; at: string }> {
    const found: Array<{ where: string; before: string; at: string }> = [];
    for (const { where, text } of commandLiterals()) {
      for (const m of text.matchAll(/(?<![\w\-./$])(bunx|bun)(?=\s)/g)) {
        const i = m.index ?? 0;
        found.push({ where, before: text.slice(0, i), at: text.slice(i, i + 40) });
      }
    }
    return found;
  }

  test("[MUST-FAIL] each bun/bunx word in a command builder is immediately preceded by testChildEnvShellPrefix() (source)", () => {
    const inv = bunInvocations();
    // not vacuous: install, dry-run, typecheck, shape-dispatch, the suites, the own-check runs, resume tsc, baseline
    expect(inv.length).toBeGreaterThanOrEqual(15);
    const bare = inv.filter((x) => !x.before.trimEnd().endsWith(PREFIX_CALL)).map((x) => `${x.where}: …${x.before.slice(-40)}⟦${x.at}⟧`);
    expect(bare).toEqual([]);
    const verify = inv.filter((x) => x.where === "composeVerifyCommand").map((x) => x.at.split(/\s+/).slice(0, 3).join(" "));
    expect(verify.length).toBe(5);
  });

  test("[MUST-FAIL] no inline `env -i` copy remains anywhere in src (only the helper renders it), and feature-compose imports the helper", () => {
    const src = readFileSync(FC_PATH, "utf8");
    expect(src).toMatch(/import \{ testChildEnvShellPrefix \} from "\.\.\/test-child-env\.js";/);
    // The ONE other `env -i` is falsify-authored-test's namespace sandbox: a stricter env with fixed /mnt paths inside
    // an unshare namespace, deliberately not the shared allowlist. Exact text, so a second copy there is still caught.
    const SANDBOX = '"env -i PATH=/mnt/bin:/usr/bin:/bin HOME=/mnt/home TMPDIR=/tmp WORKSPACE_ROOT=/mnt/ws NO_COLOR=1"';
    const copies: string[] = [];
    for (const f of srcFiles()) {
      if (f.endsWith("/test-child-env.ts")) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!l.includes("env -i") || /^\s*(\/\/|\*)/.test(l)) return;
        if (f.endsWith("/resolvers/falsify-authored-test.ts") && l.trim() === `: ${SANDBOX};`) return;
        copies.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(copies).toEqual([]);
  });

  test("[MUST-FAIL] the built verify command runs install/typecheck/shape-dispatch without the parent's credentials (behavioural)", async () => {
    const fc = (await import("../../src/resolvers/feature-compose.ts")) as Record<string, unknown>;
    const build = fc["composeVerifyCommand"] as (vAbs: string, check: string) => string;
    expect(typeof build).toBe("function");
    const root = mkScratch("verify");
    const v = join(root, "fixture-vessel");
    mkdirSync(join(v, "node_modules"), { recursive: true });
    mkdirSync(join(v, "src", "routes"), { recursive: true });
    writeFileSync(join(v, "src", "config.ts"), "export {};\n");
    writeFileSync(join(v, "src", "routes", "impulses.ts"), "export {};\n");
    // the typecheck script is lane-authorable: it prints what it can see, then fails (so the suite stage is skipped)
    writeFileSync(join(v, "leak.sh"), `echo "LEAK[$SURREALDB_PASS][$METABOB_API_KEY][$SUBSTRATE_GIT_PAT]"\nenv | grep ${FAKE} || true\nexit 1\n`);
    writeFileSync(join(v, "package.json"), JSON.stringify({ name: "fixture-vessel", private: true, scripts: { typecheck: "sh ./leak.sh" } }));
    const check = join(root, "sd-check.ts");
    writeFileSync(check, `const leaked = Object.values(process.env).some((x) => String(x).includes(${JSON.stringify(FAKE)}));\nconsole.log(leaked ? "SD_ENV_LEAKED" : "SD_ENV_CLEAN");\n`);
    const home = join(root, "home");
    mkdirSync(home);
    const p = Bun.spawnSync(["bash", "-c", build(v, check)], { env: credentialFixture(home), stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(out).toContain("LEAK[][][]"); // positive control: the typecheck script ran, with nothing to print
    expect(out).toContain("SD_ENV_CLEAN"); // the shape-dispatch child ran, and saw no credential
    expect(out).toContain("DRYRUN_EXIT=");
    expect(out).not.toContain(FAKE);
    // ONE scratch dir per verify, removed at the end: no mktemp leftovers in the (fixture) TMPDIR
    expect(readdirSync(home).filter((n) => n.startsWith("tmp."))).toEqual([]);
  });
});

describe("vessel_mitosis_evaluate: the static-check and suite children get the scrubbed env", () => {
  // The ORIGINAL evalenv gap (mitosis-evaluate-runcheck-spawns-bun-test-with-the-live-environment): runCheck spawned
  // `bun run lint` and `bun test` with `{ ...process.env }`. Driven in a CHILD bun whose real environ holds the fake
  // credentials, through the exported staticEvaluate, on a fixture whose lint script and test file dump their env.
  test("[MUST-FAIL] the evaluate path's lint script and suite see no parent credential and only allowlisted keys (behavioural)", () => {
    const root = mkScratch("eval-root");
    const tree = join(root, "tree");
    mkdirSync(join(tree, "test"), { recursive: true });
    const lintMarker = join(root, "lint-env.txt");
    const testMarker = join(root, "test-env.json");
    writeFileSync(join(tree, "probe.sh"), `env > ${JSON.stringify(lintMarker)}\nexit 0\n`);
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "fixture-vessel", private: true, scripts: { lint: "sh ./probe.sh" } }));
    writeFileSync(
      join(tree, "test", "leak.test.ts"),
      `import { test, expect } from "bun:test";\nimport { writeFileSync } from "node:fs";\n` +
        `test("dump", () => { writeFileSync(${JSON.stringify(testMarker)}, JSON.stringify(process.env)); expect(1).toBe(1); });\n`,
    );
    const driver = join(root, "drive.ts");
    writeFileSync(
      driver,
      `const m = (await import(${JSON.stringify(join(SRC, "resolvers", "vessel-mitosis-evaluate.ts"))})) as Record<string, any>;\n` +
        `const r = await m.staticEvaluate(${JSON.stringify(tree)}, process.execPath, undefined, undefined, ["lint"], false);\n` +
        `console.log("EVAL=" + JSON.stringify({ attempted: r.attempted, ok: r.ok, checks: (r.checks ?? []).map((c: any) => [c.name, c.exit_code, c.timed_out]) }));\n` +
        `process.exit(0);\n`,
    );
    const home = join(root, "home");
    mkdirSync(home);
    const parentWs = join(root, "parent-ws");
    mkdirSync(parentWs);
    const env = { ...credentialFixture(home), WORKSPACE_ROOT: parentWs };
    const p = Bun.spawnSync([process.execPath, driver], { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    const out = p.stdout.toString();
    expect(out).toContain("EVAL=");
    // positive controls: both children ran (a saturated host defers them, which fails here, never passes)
    expect(existsSync(lintMarker)).toBe(true);
    expect(existsSync(testMarker)).toBe(true);
    const lintDump = readFileSync(lintMarker, "utf8");
    const testEnv = JSON.parse(readFileSync(testMarker, "utf8")) as Record<string, string>;
    expect(lintDump).not.toContain(FAKE);
    expect(JSON.stringify(testEnv)).not.toContain(FAKE);
    const skip = /^(npm_|BUN_|_$|PWD$|OLDPWD$|SHLVL$|INIT_CWD$|NODE$|COLOR$|FORCE_COLOR$)/;
    for (const [k] of envLines(lintDump)) if (!skip.test(k)) expect(ALLOWED_KEYS).toContain(k);
    for (const k of Object.keys(testEnv)) if (!skip.test(k)) expect(ALLOWED_KEYS).toContain(k);
    expect(testEnv["WORKSPACE_ROOT"] ?? "").not.toBe("");
    expect(testEnv["WORKSPACE_ROOT"]).not.toBe(parentWs); // a scratch root, never the parent's workspace
    expect(existsSync(testEnv["WORKSPACE_ROOT"]!)).toBe(false); // ...removed when the run settled
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// CLASS CHECK (law 6: detect the class, not the sites). Every child-process spawn in src/ is enumerated by AST:
//   - argv spawns: Bun.spawn/spawnSync, child_process spawn/spawnSync/exec/execSync/execFile/execFileSync, and
//     promisify(execFile|exec) aliases;
//   - wrapped argv: a plain function called with an argv whose program is bun/bunx/node/npm/npx/process.execPath;
//   - shell commands: bun/bunx/npm/npx/node/git/systemctl words in command position inside a `command:` value, a
//     cmd/command/script/bunRun/*Cmd/*Command/*Script variable, a *Command/*Script function, or an `sh|bash -c` argv.
// Each site is SCRUBBED (argv: `env` from withTestChildEnv/testChildEnv, never process.env; shell: the bun word is
// immediately preceded by ${testChildEnvShellPrefix()}) or it is in CHILD_SPAWN_ALLOWLIST below, by key
// file#function#kind:head, with a count and a one-line reason. Anything else fails. This file is protected, so a
// lane cannot allowlist its own new spawn; a test/suite/typecheck/install child in the evaluator path can never be
// allowlisted at all.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SpawnSite { file: string; line: number; fn: string; kind: "argv" | "sh" | "wrapped"; head: string; scrubbed: boolean; detail: string }
const SPAWN_CALLEE = /^(Bun\.spawn|Bun\.spawnSync|spawn|spawnSync|exec|execSync|execFile|execFileSync|child_process\.\w+|cp\.\w+)$/;
const SHELL_WORD = /(?<![\w\-./$"'=])(bunx|bun|npm|npx|node|git|systemctl)(?=\s)/g;
const CMD_VAR = /^(cmd|command|script|bunRun)$|(Cmd|Command|Script)$/;
const CMD_FN = /(Command|Script)$/;
const SHELL_PREFIX_CALL = "${testChildEnvShellPrefix()}";

function childSpawnCensus(srcRoot: string = SRC): SpawnSite[] {
  const repoRoot = dirname(srcRoot);
  const out: SpawnSite[] = [];
  for (const f of srcFiles(srcRoot)) {
    const text = readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const file = f.slice(repoRoot.length + 1);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const fnOf = (n: ts.Node): string => {
      for (let u: ts.Node | undefined = n.parent; u; u = u.parent) {
        if ((ts.isFunctionDeclaration(u) || ts.isMethodDeclaration(u)) && u.name) return u.name.getText(sf);
        if ((ts.isArrowFunction(u) || ts.isFunctionExpression(u)) && ts.isVariableDeclaration(u.parent)) return u.parent.name.getText(sf);
      }
      return "<module>";
    };
    const aliases = new Set<string>();
    const findAliases = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(sf) === "promisify" && /^(execFile|exec)$/.test(n.initializer.arguments[0]?.getText(sf) ?? "")) aliases.add(n.name.getText(sf));
      n.forEachChild(findAliases);
    };
    findAliases(sf);
    const insideHelperCall = (n: ts.Node): boolean => {
      for (let u: ts.Node | undefined = n.parent; u; u = u.parent) if (ts.isCallExpression(u) && u.expression.getText(sf) === "withTestChildEnv") return true;
      return false;
    };
    const shellLiteral = (lit: ts.Node, ctx: string): void => {
      const t = lit.getText(sf);
      for (const m of t.matchAll(SHELL_WORD)) {
        const word = m[1]!;
        const at = m.index ?? 0;
        const scrubbed = (word === "bun" || word === "bunx") && t.slice(0, at).trimEnd().endsWith(SHELL_PREFIX_CALL);
        out.push({ file, line: line(lit), fn: fnOf(lit), kind: "sh", head: word, scrubbed, detail: `${ctx}: …${t.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, " ")}` });
      }
    };
    const literalsIn = (n: ts.Node, ctx: string): void => {
      if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) { shellLiteral(n, ctx); return; }
      n.forEachChild((c) => literalsIn(c, ctx));
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (SPAWN_CALLEE.test(callee) || aliases.has(callee)) {
          const a0 = n.arguments[0];
          let head = a0 ? a0.getText(sf) : "";
          if (a0 && ts.isArrayLiteralExpression(a0) && a0.elements[0]) head = a0.elements[0].getText(sf);
          head = head.replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, " ").slice(0, 60);
          const opts = n.arguments.find((a, i) => i > 0 && ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined;
          const envP = opts?.properties.find((p) => p.name?.getText(sf) === "env");
          const envText = envP ? (ts.isShorthandPropertyAssignment(envP) ? "env" : (envP as ts.PropertyAssignment).initializer.getText(sf)) : "";
          const scrubbed = envText !== "" && !envText.includes("process.env") && ((envText === "env" && insideHelperCall(n)) || envText.includes("testChildEnv("));
          out.push({ file, line: line(n), fn: fnOf(n), kind: "argv", head, scrubbed, detail: `${callee} env=${envText ? envText.slice(0, 60).replace(/\s+/g, " ") : "<inherited>"}` });
          if (a0 && ts.isArrayLiteralExpression(a0) && /^(sh|bash|\/bin\/sh|\/bin\/bash)$/.test(head)) for (const el of a0.elements.slice(1)) literalsIn(el, "sh -c");
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !SPAWN_CALLEE.test(n.expression.getText(sf)) && !aliases.has(n.expression.getText(sf))) {
        const a0 = n.arguments[0];
        const h = a0 && ts.isArrayLiteralExpression(a0) && a0.elements[0] ? a0.elements[0].getText(sf).replace(/^["'`]|["'`]$/g, "") : "";
        if (/^(bun|bunx|node|npm|npx|process\.execPath)$/.test(h)) out.push({ file, line: line(n), fn: fnOf(n), kind: "wrapped", head: h, scrubbed: false, detail: `${n.expression.getText(sf)}([${h}, …])` });
      }
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "command") { literalsIn(n.initializer, "command:"); return; }
      if (ts.isVariableDeclaration(n) && n.initializer && CMD_VAR.test(n.name.getText(sf)) && !ts.isArrowFunction(n.initializer) && !ts.isFunctionExpression(n.initializer)) { literalsIn(n.initializer, `${n.name.getText(sf)} =`); return; }
      if (ts.isFunctionDeclaration(n) && n.name && CMD_FN.test(n.name.text) && n.body) { literalsIn(n.body, `${n.name.text}()`); return; }
      if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && CMD_FN.test(n.name.getText(sf))) { literalsIn(n.initializer, `${n.name.getText(sf)}()`); return; }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

const siteKey = (s: SpawnSite): string => `${s.file}#${s.fn}#${s.kind}:${s.head}`;

/** The evaluator path: its test/suite/typecheck/install children must be scrubbed and can never be allowlisted. */
const EVALUATOR_FILES = ["src/resolvers/feature-compose.ts", "src/resolvers/gap-to-feature.ts", "src/resolvers/vessel-mitosis-evaluate.ts", "src/resolvers/test-suite.ts", "src/test-child-env.ts"];
const RUNS_VESSEL_CODE = /^(bun|bunx|node|npm|npx|process\.execPath)$|bunCmd|execPath/;

const GIT = "git binary, runs no vessel code; inherits the env (repo-local config risk: PLAN4 §8, lower-risk follow-up)";
const GIT_SH = "git through the shell producer, runs no vessel code; PLAN4 §8 lower-risk follow-up";
const UNIT = "systemctl/journalctl: unit control or log read, runs no vessel code";
const CORE = "coreutils on fixed paths, runs no vessel code";
/** Allowlisted unscrubbed spawns: key → [max count, reason]. A FLAG reason is an open follow-up, not an endorsement. */
const CHILD_SPAWN_ALLOWLIST: Record<string, [number, string]> = {
  "src/resolvers/activate-substrate-script.ts#git#argv:git": [1, GIT],
  "src/resolvers/attempt-checks.ts#evaluateChecks#argv:systemctl": [1, UNIT],
  "src/resolvers/attempt-checks.ts#takeSnapshot#argv:git": [1, GIT],
  "src/resolvers/compose-workspace.ts#acquireComposeWorkspace#argv:ln": [1, CORE],
  "src/resolvers/compose-workspace.ts#acquireComposeWorkspace#argv:rm": [1, CORE],
  "src/resolvers/compose-workspace.ts#git#argv:git": [1, GIT],
  "src/resolvers/compose-workspace.ts#sweepStaleWorkspaces#argv:rm": [1, CORE],
  "src/resolvers/composer-interruption-sweep.ts#resolveComposerInterruptionSweep#argv:journalctl": [1, UNIT],
  "src/resolvers/disk-space-observer.ts#probeMount#argv:df": [1, CORE],
  "src/resolvers/docs-align-tick.ts#deriveNamingVocabulary#argv:git": [2, GIT],
  "src/resolvers/falsify-authored-test.ts#containmentSelfCheck#argv:git": [1, GIT],
  "src/resolvers/falsify-authored-test.ts#containmentUnavailableReason#argv:unshare": [1, "namespace probe with an explicit literal env (PATH only); no parent env"],
  "src/resolvers/falsify-authored-test.ts#nsScript#sh:bun": [3, "sandboxed run inside an unshare namespace under its OWN `env -i` with fixed /mnt paths: stricter than the shared allowlist, deliberately not collapsed onto it"],
  "src/resolvers/falsify-authored-test.ts#runContained#argv:unshare": [1, "the sandbox launcher: explicit literal env (PATH only); the drafted test runs inside under nsScript's own env -i"],
  "src/resolvers/falsify-authored-test.ts#worktreeStatus#argv:git": [1, GIT],
  "src/resolvers/feature-compose.ts#ownParentRun#sh:git": [4, GIT_SH],
  "src/resolvers/feature-compose.ts#resolveFeatureComposeInner#sh:git": [5, GIT_SH],
  "src/resolvers/feature-compose.ts#runVerifySuite#sh:git": [3, GIT_SH],
  "src/resolvers/gap-to-feature.ts#admitActionableGaps#argv:git": [1, GIT],
  "src/judge/gap-landing-verdict.ts#cloneHeadsFingerprint#argv:git": [1, GIT],
  "src/judge/gap-landing-verdict.ts#landedCommitRunningHere#argv:systemctl": [2, UNIT],
  "src/judge/gap-check-judge.ts#landedCommitVerdict#argv:git": [2, GIT],
  "src/judge/gap-landing-verdict.ts#landedCommitViaLineage#argv:git": [1, GIT],
  "src/judge/gap-landing-verdict.ts#shaIsAncestorOfAnyClone#argv:git": [1, GIT],
  "src/judge/gap-check-judge.ts#shaWasRevertedInAnyClone#argv:git": [2, GIT],
  "src/judge/gap-check-judge.ts#sweepGitOut#argv:git": [1, GIT],
  "src/judge/gap-landing-verdict.ts#systemdUnitStartedAt#argv:systemctl": [1, UNIT],
  "src/resolvers/git-add.ts#resolveGitAdd#argv:git": [1, GIT],
  "src/resolvers/git-branch-create.ts#resolveGitBranchCreate#argv:git": [1, GIT],
  "src/resolvers/git-commit.ts#resolveGitCommit#argv:git": [1, GIT],
  "src/resolvers/git-diff.ts#resolveGitDiff#argv:git": [1, GIT],
  "src/resolvers/git-log.ts#resolveGitLog#argv:git": [1, GIT],
  "src/resolvers/git-push.ts#pushUrlOf#argv:git": [1, GIT],
  "src/resolvers/git-push.ts#resolveGitPush#argv:git": [1, GIT],
  "src/resolvers/goal-reach-tick.ts#gitLines#argv:git": [1, GIT],
  "src/resolvers/intervention-evaluate.ts#isSubstrateAuthoredFile#argv:git": [1, GIT],
  "src/resolvers/orphaned-capability-scan.ts#findCandidateConsumers#argv:grep": [1, CORE],
  "src/resolvers/perf-canary-resolve.ts#resolvePerfCanaryResolve#sh:systemctl": [2, UNIT],
  "src/resolvers/prior-seed-efficacy-scan.ts#resolvePriorSeedEfficacyScan#argv:journalctl": [1, UNIT],
  "src/resolvers/pull-cutover.ts#sh#argv:cmd": [1, "pull_cutover's argv wrapper (git/systemctl/bash, and the bun build flagged below); inherits the env"],
  "src/resolvers/pull-cutover.ts#resolvePullCutover#wrapped:bun": [1, "FLAG (follow-up, not the evaluator path): `bun --cwd <release> run build` of the origin/dev tree after landing inherits the full env"],
  "src/resolvers/push-health-observer.ts#probePatGitAuth#argv:git": [1, "git auth probe that needs the PAT from the parent env by design (the credential's own use, no vessel code)"],
  "src/resolvers/scope-earn-in.ts#vesselGitRun#argv:git": [1, GIT],
  "src/resolvers/self-fact-reconcile.ts#countSites#argv:git": [1, GIT],
  "src/resolvers/self-fact-reconcile.ts#g#argv:git": [1, GIT],
  "src/resolvers/self-fact-reconcile.ts#git#argv:git": [1, GIT],
  "src/resolvers/self-fact-reconcile.ts#readJournalLines#argv:args": [1, "journalctl argv built in-function; log read, runs no vessel code"],
  "src/resolvers/self-fact-reconcile.ts#refAgeHours#argv:git": [2, GIT],
  "src/resolvers/self-fact-reconcile.ts#sys#argv:systemctl": [1, UNIT],
  "src/resolvers/self-fact-reconcile.ts#unitActive#argv:systemctl": [1, UNIT],
  "src/resolvers/self-fact-reconcile.ts#unitWorkingDirectory#argv:systemctl": [1, UNIT],
  "src/resolvers/service-oom-cascade-scan.ts#<module>#argv:systemctl": [1, UNIT],
  "src/resolvers/substrate-gap.ts#birthTreeChange#argv:git": [1, GIT],
  "src/resolvers/substrate-gap.ts#readBirthTreeSha#argv:git": [1, GIT],
  "src/resolvers/substrate-gap.ts#resolveSubstrateGapWriteInner#argv:systemctl": [2, UNIT],
  "src/resolvers/substrate-health-tick.ts#checkVesselLiveness#argv:systemctl": [1, UNIT],
  "src/resolvers/super-repo-checkout.ts#superRepoCheckoutCall#sh:git": [1, GIT_SH],
  "src/resolvers/systemd-restart.ts#resolveSystemdRestart#argv:systemctl": [2, UNIT],
  "src/resolvers/systemd-unit-health-observer.ts#discoverTimerServices#argv:systemctl": [1, UNIT],
  "src/resolvers/systemd-unit-health-observer.ts#journalError#argv:journalctl": [1, UNIT],
  "src/resolvers/systemd-unit-health-observer.ts#probeUnit#argv:systemctl": [1, UNIT],
  "src/resolvers/test-suite.ts#mutationRevertScript#sh:git": [2, GIT_SH],
  "src/resolvers/test-suite.ts#resolveTestSuite#sh:git": [6, GIT_SH],
  'src/resolvers/vessel-mitosis-cutover.ts#resolveVesselMitosisCutover#argv:process.env["GIT_CMD"] ?? "git': [1, GIT],
  "src/resolvers/vessel-mitosis-cutover.ts#runGit#argv:gitCmd": [1, "the cutover git wrapper (git binary, no vessel code); PLAN4 §8 lower risk"],
  "src/resolvers/vessel-mitosis-cutover.ts#runGitAwareCutoverInner#argv:process.execPath": [1, "FLAG (follow-up, not the evaluator path): the post-landing `substrate:deploy` package.json hook runs with { ...process.env, SUBSTRATE_BASE_ROOT }; a deploy script may need more than the test allowlist, so scrubbing it needs its own review"],
  'src/resolvers/vessel-mitosis-cutover.ts#runGitAwareCutoverInner#argv:selfRestartAlreadyOwed(vessel_name) ? ["/bin/true"] : [sysdR': [1, UNIT],
  "src/resolvers/vessel-mitosis-cutover.ts#runGitAwareCutoverInner#argv:sysdRun": [1, UNIT],
  "src/resolvers/vessel-mitosis-cutover.ts#runGitAwareCutoverInner#argv:systemctl": [1, UNIT],
  "src/resolvers/vessel-mitosis-cutover.ts#runGitAwareCutoverInner#sh:systemctl": [2, UNIT],
  "src/resolvers/vessel-mitosis-cutover.ts#runSystemctl#argv:cmd": [1, "the cutover systemctl wrapper; unit control, no vessel code"],
  "src/resolvers/vessel-mitosis-cutover.ts#selfRestartAlreadyOwed#argv:systemctl": [1, UNIT],
  "src/resolvers/vessel-write-error-scan.ts#journalMatchCount#argv:journalctl": [1, UNIT],
  "src/resolvers/write-containment.ts#readCommittedScope#argv:git": [1, GIT],
};

describe("CLASS CHECK: every child-process spawn in src is scrubbed or consciously allowlisted", () => {
  test("[MUST-FAIL] no spawn is in neither class: unscrubbed sites must be allowlisted, within their count", () => {
    const sites = childSpawnCensus();
    expect(sites.length).toBeGreaterThan(100); // not vacuous
    const counts = new Map<string, SpawnSite[]>();
    for (const s of sites) if (!s.scrubbed) counts.set(siteKey(s), [...(counts.get(siteKey(s)) ?? []), s]);
    const offenders: string[] = [];
    for (const [key, list] of counts) {
      const allowed = CHILD_SPAWN_ALLOWLIST[key];
      if (!allowed) offenders.push(`NOT ALLOWLISTED ${list.map((s) => `${s.file}:${s.line}`).join(",")} ${key} (${list[0]!.detail})`);
      else if (list.length > allowed[0]) offenders.push(`OVER COUNT ${key}: ${list.length} > ${allowed[0]} at ${list.map((s) => s.line).join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("[MUST-FAIL] the evaluator path's test/suite/typecheck/install children are all scrubbed, and none is allowlistable", () => {
    const sites = childSpawnCensus().filter((s) => EVALUATOR_FILES.includes(s.file) && RUNS_VESSEL_CODE.test(s.head));
    // the known scrubbed sites exist (not vacuous): evaluate runCheck, admission typecheck, compose builders, test-suite
    expect(sites.filter((s) => s.file === "src/resolvers/vessel-mitosis-evaluate.ts").length).toBeGreaterThanOrEqual(1);
    expect(sites.filter((s) => s.file === "src/resolvers/gap-to-feature.ts").length).toBeGreaterThanOrEqual(1);
    expect(sites.filter((s) => s.file === "src/resolvers/test-suite.ts").length).toBeGreaterThanOrEqual(3);
    expect(sites.filter((s) => s.file === "src/resolvers/feature-compose.ts").length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => !s.scrubbed).map((s) => `${s.file}:${s.line} ${siteKey(s)} ${s.detail}`)).toEqual([]);
    const bad = Object.keys(CHILD_SPAWN_ALLOWLIST).filter((k) => {
      const [file, , kh] = k.split("#");
      return EVALUATOR_FILES.includes(file!) && RUNS_VESSEL_CODE.test(kh!.slice(kh!.indexOf(":") + 1));
    });
    expect(bad).toEqual([]);
  });

  test("[CONTROL] the census sees a spawn added with no env (a seeded fixture tree)", () => {
    const root = mkScratch("census");
    mkdirSync(join(root, "src", "resolvers"), { recursive: true });
    writeFileSync(
      join(root, "src", "resolvers", "seeded.ts"),
      `export function runIt(): void { Bun.spawnSync(["bun", "test"]); }\n` +
        `export function okIt(env: Record<string, string>): void { withTestChildEnv((env) => Bun.spawnSync(["bun", "test"], { env })); }\n` +
        `export function viaShell(): unknown { return { command: \`cd x && bun test\` }; }\n`,
    );
    const sites = childSpawnCensus(join(root, "src"));
    expect(sites.map((s) => `${s.fn}:${s.kind}:${s.head}:${s.scrubbed}`).sort()).toEqual(["okIt:argv:bun:true", "runIt:argv:bun:false", "viaShell:sh:bun:false"]);
  });
});
