// A SCRUBBED CHILD RESOLVES EVERY LEARNED-STATE PATH UNDER ITS SCRATCH ROOT (2026-10-17; user ruling 17:44:08Z).
// The production twin of the test-harness leak: the lane's test_suite, typecheck and mitosis children get their env from
// src/test-child-env.ts, which dropped every learned-state redirect, so vessel code they ran resolved its live /workspace
// defaults (node1's gap-class-posteriors.json held fixture classes, cc-ctl-* among them, from a test with no redirect).
// Pins, against the REAL learning-credit module: (1) a child under testChildEnv(…, {workspaceRoot}) resolves all four
// tables under the root; (2) every derived learned-state name is set under the root; (3) the shell prefix carries the
// same names under its own root; (4) CONTROL: no credential-like name is passed and the passthrough is unchanged.
// MUST-FAIL on the parent (4be3e2e4): the child resolves /workspace/...; the helper exports no derived scan.
// The helper is imported dynamically, so at the parent the tests fail on assertions, not on load.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const HELPER = join(REPO, "src", "test-child-env.ts");
const LC = join(REPO, "src", "judge", "learning-credit.js");
const TABLES = ["class_posteriors", "close_oracle", "detector_credit", "priority_weights"];
const FAKE = "fake-cred-5ca1ab1e";
/** The qa ruling's credential shapes (plus JWT, COOKIE), applied to a name with its _PATH/_DIR suffix set aside. */
const CREDENTIAL_SHAPED = /KEY|TOKEN|SECRET|PASS|PAT|CRED|AUTH|JWT|COOKIE/i;

const scratch: string[] = [];
const mk = (tag: string): string => { const d = mkdtempSync(join(tmpdir(), `tce-ls-${tag}-`)); scratch.push(d); return d; };
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
const under = (p: string, root: string): boolean => resolve(p).startsWith(resolve(root) + "/");
const helper = async (): Promise<Record<string, unknown> | null> => (await import(HELPER).catch(() => null)) as Record<string, unknown> | null;
/** The derived name list, or [] when the helper exports no scan (the parent). */
async function derivedNames(): Promise<string[]> {
  const h = await helper();
  const f = h?.["learnedStateDefaults"] as (() => Map<string, string>) | undefined;
  return typeof f === "function" ? [...f().keys()].sort() : [];
}

describe("testChildEnv: learned state resolves under the scratch root", () => {
  it("[MUST-FAIL] a child spawned with testChildEnv(process.env, {workspaceRoot}) resolves all four REAL learning-credit tables under the root", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    const root = mk("child");
    const env = (h!["testChildEnv"] as (s: Record<string, string | undefined>, o: { workspaceRoot: string }) => Record<string, string>)(process.env, { workspaceRoot: root });
    const code = `const lc = await import(${JSON.stringify(LC)}); console.log("TABLES=" + JSON.stringify(Object.fromEntries(${JSON.stringify(TABLES)}.map((t) => [t, lc.tablePath(t)]))));`;
    const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = new TextDecoder().decode(p.stdout);
    const m = /TABLES=(\{.*\})/.exec(out);
    expect(m, (out + new TextDecoder().decode(p.stderr)).slice(-1500)).not.toBeNull();
    const tables = JSON.parse(m![1]!) as Record<string, string>;
    expect(Object.keys(tables).sort()).toEqual([...TABLES].sort());
    for (const [t, path] of Object.entries(tables)) {
      expect(path.startsWith("/workspace"), `${t}=${path}`).toBe(false);
      expect(under(path, root), `${t}=${path}`).toBe(true);
    }
  }, 90_000);

  it("[MUST-FAIL] every derived learned-state name is in testChildEnv's output, under <root> (non-vacuous: >3 names, GAP_CLASS_POSTERIOR_PATH among them)", async () => {
    const names = await derivedNames();
    expect(names.length).toBeGreaterThan(3);
    expect(names).toContain("GAP_CLASS_POSTERIOR_PATH");
    const h = await helper();
    const root = mk("names");
    const env = (h!["testChildEnv"] as (s: Record<string, string | undefined>, o: { workspaceRoot: string }) => Record<string, string>)({ PATH: "/usr/bin:/bin", HOME: root }, { workspaceRoot: root });
    for (const n of names) {
      expect(env[n], n).toBeDefined();
      expect(under(env[n]!, root), `${n}=${env[n]}`).toBe(true);
    }
  });

  it("[MUST-FAIL] the shell prefix carries the same derived names, each under the prefix's own WORKSPACE_ROOT (behavioural)", async () => {
    const names = await derivedNames();
    expect(names.length).toBeGreaterThan(3);
    const h = await helper();
    const prefix = (h!["testChildEnvShellPrefix"] as () => string)();
    const home = mk("prefix");
    // bare, and nested inside "$( … )" as test_suite's mutation run and feature-compose nest it; the parent's own
    // WORKSPACE_ROOT and redirect values are decoys that must never reach the child
    for (const script of [`${prefix} env`, `OUT="$(${prefix} env)"; printf '%s\\n' "$OUT"`]) {
      const p = Bun.spawnSync(["bash", "-c", script], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, WORKSPACE_ROOT: `/${FAKE}-ws`, GAP_CLASS_POSTERIOR_PATH: `/${FAKE}-gcp` }, stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode, p.stderr.toString()).toBe(0);
      expect(p.stdout.toString()).not.toContain(FAKE);
      const env = Object.fromEntries(p.stdout.toString().split("\n").filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      const ws = env["WORKSPACE_ROOT"] ?? "";
      expect(under(ws, home), `WORKSPACE_ROOT=${ws}`).toBe(true);
      for (const n of names) {
        expect(env[n], n).toBeDefined();
        expect(under(env[n]!, ws), `${n}=${env[n]}`).toBe(true);
      }
    }
  });

  it("[CONTROL] the passthrough is unchanged (PATH, HOME), no credential value or credential-named variable reaches the child", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    expect([...(h!["TEST_CHILD_ENV_PASSTHROUGH"] as readonly string[])].sort()).toEqual(["HOME", "PATH"]);
    const root = mk("ctl");
    const parent = { PATH: "/usr/bin:/bin", HOME: root, SURREALDB_PASS: `${FAKE}-pass`, METABOB_API_KEY: `${FAKE}-key`, SUBSTRATE_GIT_PAT: `${FAKE}-pat`, GITHUB_TOKEN: `${FAKE}-tok` };
    const env = (h!["testChildEnv"] as (s: Record<string, string | undefined>, o: { workspaceRoot: string }) => Record<string, string>)(parent, { workspaceRoot: root });
    expect(JSON.stringify(env)).not.toContain(FAKE);
    const names = await derivedNames();
    // every key the child gets is the passthrough, the fixed pair, the root, or a derived redirect, whose credential-
    // shaped names (after their _PATH/_DIR suffix) are only the signing-key PATH, a scratch path here
    for (const k of Object.keys(env)) expect(["HOME", "PATH", "NODE_ENV", "TZ", "WORKSPACE_ROOT", ...names]).toContain(k);
    const base = ["HOME", "PATH", "NODE_ENV", "TZ", "WORKSPACE_ROOT"]; // pinned above / in the protected allowlist test
    const shaped = Object.keys(env).filter((k) => !base.includes(k) && CREDENTIAL_SHAPED.test(k.replace(/_(PATH|DIR)$/, "")));
    expect(shaped.filter((k) => k !== "VESSEL_IDENTITY_KEY_PATH")).toEqual([]);
    if (env["VESSEL_IDENTITY_KEY_PATH"]) expect(under(env["VESSEL_IDENTITY_KEY_PATH"], root)).toBe(true);
  });
});

describe("a learned-state name that changes how a child STARTS is never carried (qa ruling, route 5)", () => {
  it("[MUST-FAIL] a decoy src line declaring NODE_OPTIONS / LD_PRELOAD (and kin) defaults is NOT carried; a plain *_PATH is", async () => {
    const tce = (await import("../../src/test-child-env.ts")) as unknown as { learnedStateDefaults: (d?: string) => Map<string, string>; START_SHAPING_NAME?: RegExp };
    const dir = mkdtempSync(join(tmpdir(), "tce-decoy-"));
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "decoy.ts"), [
        'const a = process.env.NODE_OPTIONS ?? "/workspace/node-opts";',
        'const b = process.env["LD_PRELOAD"] ?? "/workspace/evil.so";',
        'const c = process.env.BUN_INSTALL ?? "/workspace/bun";',
        'const d = process.env.GIT_DIR ?? "/workspace/repo.git";',
        'const e = process.env.SSH_AUTH_SOCK ?? "/workspace/agent.sock";',
        'const f = process.env.DYLD_INSERT_LIBRARIES ?? "/workspace/x.dylib";',
        'const g = process.env.NPM_CONFIG_PREFIX ?? "/workspace/npm";',
        'const h = process.env.JAVA_TOOL_OPTIONS ?? "/workspace/jto";',
        'const i = process.env.MY_LOADER ?? "/workspace/loader";',
        'const j = process.env.DECOY_LEDGER_PATH ?? "/workspace/decoy-ledger.json";',
      ].join("\n"));
      const names = [...tce.learnedStateDefaults(dir).keys()].sort();
      expect(names).toEqual(["DECOY_LEDGER_PATH"]);
      expect(tce.START_SHAPING_NAME).toBeInstanceOf(RegExp);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
