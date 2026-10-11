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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("[MUST-FAIL] no inline `env -i` copy remains in feature-compose.ts, and the prefix comes from the shared helper", () => {
    const src = readFileSync(FC_PATH, "utf8");
    expect(src).not.toContain("env -i");
    expect(src).toMatch(/import \{ testChildEnvShellPrefix \} from "\.\.\/test-child-env\.js";/);
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
  });
});
