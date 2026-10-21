// A SCRUBBED CHILD REACHES NO LIVE NODE: EVERY ENDPOINT IS THE DISCARD ADDRESS (2026-10-21).
// src/test-child-env.ts stripped the fleet key but left every endpoint on its live code default, so suites the lane ran in
// its children (feature-compose verify, test_suite, mitosis-evaluate) sent keyless requests to the live goal-host,
// activity-api and discovery all day, and live /run-goal dispatches. Pins: (1) testChildEnv sets GOAL_HOST_VESSEL_ENDPOINT
// and every fleet endpoint name pull-sync's scrubbed env lists to http://127.0.0.1:9, with or without a scratch root, a
// parent's value never inherited; (2) the REAL config module, imported in such a child, resolves its endpoints to the
// discard address; (3) the shell prefix carries the same names and value (behavioural, bare and nested); (4) the scan adds
// a name src reads with a URL default and leaves an override with no default alone; (5) CONTROL: PATH, HOME, NODE_ENV,
// TZ and WORKSPACE_ROOT are unchanged and no credential value reaches the child.
// MUST-FAIL on the parent (790328c0): no endpoint name is set; the helper exports no endpoint scan.
// The helper is imported dynamically, so at the parent the tests fail on assertions, not on load.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const HELPER = join(REPO, "src", "test-child-env.ts");
const CONFIG = join(REPO, "src", "config.ts");
const DISCARD = "http://127.0.0.1:9";
const FAKE = "fake-cred-e0d901e7";
/** The fleet endpoint names pull-sync's scrubbed env points at the discard address (its database address, fleet HTTP
 *  endpoints and the Obsidian listeners): every one must be the discard address in a scrubbed child too. */
const FLEET = [
  "SURREALDB_URL",
  "ACTIVITY_API_ENDPOINT", "ACTIVITY_API_URL", "METABOB_ENDPOINT", "TUNING_PARAM_ENDPOINT", "TEST_API_URL", "SUBSTRATE_API_URL",
  "DISCOVERY_VESSEL_ENDPOINT", "DISCOVERY_ENDPOINT", "PRODUCER_DISCOVERY_ENDPOINT", "PEER_DISCOVERY_ENDPOINT",
  "IDENTITY_VESSEL_URL",
  "DEV_VESSEL_ENDPOINT", "DEVELOPMENT_VESSEL_ENDPOINT", "DEV_VESSEL_IMPULSES_URL", "DEV_VESSEL_SELF_ENDPOINT", "SELF_ENDPOINT",
  "SELF_RESOLVE_ENDPOINT", "GAP_STORE_ENDPOINT", "FEATURE_COMPOSE_ENDPOINT", "GOAL_HOST_VESSEL_ENDPOINT", "GOAL_HOST_ENDPOINT",
  "CONCEPT_DB_ENDPOINT", "CONCEPT_DB_URL", "CONCEPT_DB_CLUSTER_ENDPOINT", "CONCEPT_DB_EMBED_ENDPOINT",
  "LLM_RESOLVER_VESSEL_ENDPOINT", "LLM_TOOL_DISPATCH_ENDPOINT", "LLM_VESSEL_ENDPOINT", "LLM_ROUTER_API_ENDPOINT",
  "RELEVANCE_SINK_ENDPOINT", "EVENT_BUS_ENDPOINT",
  "LIGHT_DISPATCH_ENDPOINT", "LIGHT_DISPATCH_VESSEL_ENDPOINT", "LIGHT_DISPATCH_URL",
  "STATEFUL_UI_VESSEL_ENDPOINT", "HUMAN_SURFACE_ENDPOINT", "TRANSPORT_VESSEL_ENDPOINT", "FED_TRANSPORT_EGRESS",
  "OBSIDIAN_ENDPOINT", "OBSIDIAN_LEARN_ENDPOINT", "OBSIDIAN_PLUGIN_ENDPOINT", "OBSIDIAN_PROBE_ENDPOINT",
];

type Env = Record<string, string>;
type ChildEnv = (s: Record<string, string | undefined>, o?: { workspaceRoot?: string }) => Env;
const scratch: string[] = [];
const mk = (tag: string): string => { const d = mkdtempSync(join(tmpdir(), `tce-ep-${tag}-`)); scratch.push(d); return d; };
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
const helper = async (): Promise<Record<string, unknown> | null> => (await import(HELPER).catch(() => null)) as Record<string, unknown> | null;
/** A parent env as a unit gives it: the two passthrough names, fake credentials, and a LIVE-looking value under every
 *  endpoint name (a decoy that must never reach the child). */
function parentFixture(home: string): Record<string, string> {
  const fx: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, METABOB_API_KEY: `${FAKE}-key`, SURREALDB_PASS: `${FAKE}-pass`, WORKSPACE_ROOT: `/${FAKE}-ws` };
  for (const n of FLEET) fx[n] = `http://${FAKE}.invalid:8210`;
  return fx;
}
const envLines = (out: string): Env =>
  Object.fromEntries(out.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("testChildEnv: every endpoint is the discard address", () => {
  it("[MUST-FAIL] a child built by testChildEnv has GOAL_HOST_VESSEL_ENDPOINT and every fleet endpoint equal to http://127.0.0.1:9, with or without a scratch root, none inherited", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    const childEnv = h!["testChildEnv"] as ChildEnv;
    const home = mk("obj");
    const fx = parentFixture(home);
    for (const env of [childEnv(fx), childEnv(fx, { workspaceRoot: mk("obj-ws") })]) {
      expect(env["GOAL_HOST_VESSEL_ENDPOINT"]).toBe(DISCARD);
      for (const n of FLEET) expect(env[n], n).toBe(DISCARD);
      expect(JSON.stringify(env)).not.toContain(FAKE);
    }
  });

  it("[MUST-FAIL] the REAL config module, imported in a child spawned with testChildEnv, resolves goal-host, activity-api, discovery and concept-db to the discard address", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    const root = mk("cfg");
    const env = (h!["testChildEnv"] as ChildEnv)(parentFixture(root), { workspaceRoot: root });
    const names = ["GOAL_HOST_VESSEL_ENDPOINT", "METABOB_ENDPOINT", "DISCOVERY_ENDPOINT", "CONCEPT_DB_ENDPOINT"];
    const code = `const c = await import(${JSON.stringify(CONFIG)}); console.log("CFG=" + JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, c[n]]))));`;
    const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = new TextDecoder().decode(p.stdout);
    const m = /CFG=(\{.*\})/.exec(out);
    expect(m, (out + new TextDecoder().decode(p.stderr)).slice(-1500)).not.toBeNull();
    const cfg = JSON.parse(m![1]!) as Record<string, string>;
    for (const n of names) expect(cfg[n], n).toBe(DISCARD);
  }, 90_000);

  it("[MUST-FAIL] the shell prefix gives a child every fleet endpoint at the discard address, bare and nested in \"$( … )\" (behavioural)", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    const prefix = (h!["testChildEnvShellPrefix"] as () => string)();
    const home = mk("prefix");
    for (const script of [`${prefix} env`, `OUT="$(${prefix} env)"; printf '%s\\n' "$OUT"`]) {
      const p = Bun.spawnSync(["bash", "-c", script], { env: parentFixture(home), stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode, p.stderr.toString()).toBe(0);
      expect(p.stdout.toString()).not.toContain(FAKE);
      const env = envLines(p.stdout.toString());
      for (const n of FLEET) expect(env[n], n).toBe(DISCARD);
      const ws = env["WORKSPACE_ROOT"] ?? "";
      expect(resolve(ws).startsWith(resolve(home) + "/"), `WORKSPACE_ROOT=${ws}`).toBe(true);
    }
  });

  it("[MUST-FAIL] the scan adds a name src reads with a URL default (?? / || / config env()), and leaves an override with no default and a start-shaping name alone", async () => {
    const h = await helper();
    expect(typeof h?.["endpointNames"]).toBe("function");
    const scan = h!["endpointNames"] as (d?: string) => string[];
    const dir = mk("decoy");
    writeFileSync(join(dir, "decoy.ts"), [
      'const a = process.env.DECOY_NEW_ENDPOINT ?? "http://127.0.0.1:8999";',
      'const b = process.env["DECOY_OTHER_URL"] || `https://decoy.invalid/${a}`;',
      'const c = env("DECOY_CFG_ENDPOINT", "http://127.0.0.1:8998");',
      'const d = process.env["DECOY_OVERRIDE_ENDPOINT"] ?? "";',
      'const e = process.env.NODE_DECOY_URL ?? "http://127.0.0.1:8997";',
      'const f = process.env.DECOY_LEDGER_PATH ?? "/workspace/decoy.json";',
    ].join("\n"));
    writeFileSync(join(dir, "decoy.test.ts"), 'const t = process.env.DECOY_TESTFILE_ENDPOINT ?? "http://127.0.0.1:8996";\n');
    const names = scan(dir);
    for (const n of ["DECOY_NEW_ENDPOINT", "DECOY_OTHER_URL", "DECOY_CFG_ENDPOINT"]) expect(names).toContain(n);
    for (const n of ["DECOY_OVERRIDE_ENDPOINT", "NODE_DECOY_URL", "DECOY_LEDGER_PATH", "DECOY_TESTFILE_ENDPOINT"]) expect(names).not.toContain(n);
    // the fleet list is always carried, whatever the scanned tree holds
    for (const n of FLEET) expect(names).toContain(n);
  });

  it("[CONTROL] PATH, HOME, NODE_ENV, TZ and WORKSPACE_ROOT are unchanged; learned state stays under the root; no credential value", async () => {
    const h = await helper();
    expect(h).not.toBeNull();
    const childEnv = h!["testChildEnv"] as ChildEnv;
    const root = mk("ctl");
    const parent = { PATH: "/usr/bin:/bin", HOME: "/home/fixture", METABOB_API_KEY: `${FAKE}-key`, WORKSPACE_ROOT: `/${FAKE}-ws` };
    const env = childEnv(parent, { workspaceRoot: root });
    expect(env["PATH"]!.split(":").slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(env["HOME"]).toBe("/home/fixture");
    expect(env["NODE_ENV"]).toBe("test");
    expect(env["TZ"]).toBe("UTC");
    expect(env["WORKSPACE_ROOT"]).toBe(root);
    expect(env["GAP_CLASS_POSTERIOR_PATH"]!.startsWith(root + "/")).toBe(true);
    expect(JSON.stringify(env)).not.toContain(FAKE);
    expect(env["METABOB_API_KEY"]).toBeUndefined();
    // without a root, no WORKSPACE_ROOT is set (the parent's is never inherited)
    expect(childEnv(parent)["WORKSPACE_ROOT"]).toBeUndefined();
  });
});
