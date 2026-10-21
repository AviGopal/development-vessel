/**
 * THE environment a child that runs vessel code is given: a test suite, a typecheck, a `bun install`, a
 * shape-dispatch check. One allowlist, two renderers: an object for an in-process Bun.spawn, and a shell
 * prefix for a command sent to the local-tools `shell` producer.
 *
 * WHY. The development-vessel and local-tools-vessel units both load the fleet secrets file, so both
 * processes hold live credentials (the database root password, the fleet API key, the git PAT, ...). A
 * child spawned with no `env`, or with `{ ...process.env }`, inherits every one of them. The commands
 * these children run are lane-authorable: `bun run typecheck` and `bun install` execute package.json
 * scripts, and `bun test` executes test files, all of which a drafted change can write. A scrubbed child
 * cannot read a credential its parent holds, whichever spawn site starts it.
 *
 * WHAT IS PASSED. Derived from what the suites actually need: every inline `env -i` copy this replaces,
 * and every host and in-container suite run, gave the child only PATH and HOME, plus the fixed
 * NODE_ENV=test, TZ=UTC and a scratch WORKSPACE_ROOT. No unit sets a BUN_* variable (bun finds its
 * install cache under HOME), so none is passed. Every name added here is a loosening point: this file
 * is a judge, and the protected test pins the exact list.
 *
 * LEARNED STATE STAYS IN THE SCRATCH ROOT (2026-10-17). A scrubbed child also dropped every learned-state redirect
 * the scrubbed suite env sets, so vessel code under test resolved its live /workspace defaults: the lane's test_suite,
 * typecheck and mitosis children wrote fixture classes into the live gap-class-posteriors.json. With a scratch root,
 * every learned-state env name src reads with a /workspace default is given a FIXED value under that root (never the
 * parent's value). The names are DERIVED by one scan of this vessel's src (`learnedStateDefaults`, the same rule
 * pull-sync's scrubbed env derives its redirects by); the test harness imports this one definition. Both renderers
 * carry them. A redirect is a path, not a credential: the passthrough allowlist is unchanged.
 *
 * EVERY ENDPOINT IS THE DISCARD ADDRESS (2026-10-21). Stripping the key left every endpoint on its live code default
 * (GOAL_HOST_VESSEL_ENDPOINT -> the live goal-host, METABOB_ENDPOINT, DISCOVERY_ENDPOINT, ...), so suites run in these
 * children sent keyless requests to the live nodes all day (refused, but refused hits and live /run-goal dispatches the
 * scaffold posterior graded). Every endpoint name is now given the FIXED value TEST_CHILD_DISCARD_ENDPOINT, port 9 where
 * nothing listens, the address pull-sync's scrubbed env already gives the gate's suites. The names are that env's fleet
 * list (the shell prefix also runs OTHER vessels' suites, whose names this vessel's src cannot show) plus every name this
 * vessel's src reads with a URL default (`endpointDefaults`, derived like the learned-state scan, so a new live default
 * is covered with no edit here). Both renderers carry them, with or without a scratch root. A discard address is not a
 * credential: the passthrough allowlist is unchanged.
 *
 * Not configurable at runtime, by design: nothing reads an env var or a flag to widen it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

/** Inherited from the parent by name: non-secret, needed to find and run bun. */
export const TEST_CHILD_ENV_PASSTHROUGH: readonly string[] = Object.freeze(["PATH", "HOME"]);
/** Fixed values: never read from the parent. */
export const TEST_CHILD_ENV_FIXED: Readonly<Record<string, string>> = Object.freeze({ NODE_ENV: "test", TZ: "UTC" });

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** An env read with a /workspace default: `process` `.env.NAME` (or `["NAME"]`), `??` or `||`, a quoted /workspace path. */
const STATE_DEFAULT = /process\.env(?:\.([A-Z0-9_]+)|\[["']([A-Z0-9_]+)["']\])\s*(?:\?\?|\|\|)\s*["'`](\/workspace[^"'`]*)/g;
/** A default the renderers can place verbatim (also inside a shell word): plain path characters only. */
const PLAIN_DEFAULT = /^\/workspace\/[A-Za-z0-9._\/-]+$/;
/** This vessel's own src directory (this file lives at its top). */
const OWN_SRC = dirname(fileURLToPath(import.meta.url));
/** Names a redirect may never take: the passthrough and fixed names, and the scratch root itself. */
const RESERVED = (): Set<string> => new Set([...TEST_CHILD_ENV_PASSTHROUGH, ...Object.keys(TEST_CHILD_ENV_FIXED), "WORKSPACE_ROOT"]);
/** Names that change how a child STARTS (loader, runtime, package manager, VCS, ssh), refused as a redirect even with a
 *  scratch value: the scan reads src at run time, so a lane-written `process.env.NODE_OPTIONS ?? "/workspace/..."` would
 *  otherwise reach every child it spawns (qa ruling on the route-5 change, 2026-10-17). */
export const START_SHAPING_NAME = /^(LD_|DYLD_|NODE_|BUN_|NPM_|GIT_|SSH_)|_(OPTIONS|PRELOAD|LOADER)$/;
let stateDefaultsCache: Map<string, string> | null = null;

/** Where every endpoint of a scrubbed child points: port 9 (discard), where nothing listens, so a connect is refused at
 *  once and no request reaches a live node. The address pull-sync's scrubbed env uses. */
export const TEST_CHILD_DISCARD_ENDPOINT = "http://127.0.0.1:9";
/** The fleet's HTTP endpoint names, as pull-sync's scrubbed env lists them (its database address and fleet endpoints,
 *  the Obsidian listeners): the names other vessels' suites read, which a scan of this vessel's src cannot see. */
const FLEET_ENDPOINT_NAMES: readonly string[] = Object.freeze([
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
]);
/** An env read whose default is a URL literal (a live code default): `process` `.env.NAME` (or `["NAME"]`) `??`/`||`, or
 *  config's `env("NAME", …)`, then a quoted `scheme://`. An override read with no default is not matched: unset, it
 *  falls back to discovery, itself redirected; set, it would change the code path under test. */
const ENDPOINT_DEFAULT = /(?:process\.env(?:\.([A-Z0-9_]+)|\[["']([A-Z0-9_]+)["']\])\s*(?:\?\?|\|\|)|\benv\(\s*["']([A-Z0-9_]+)["']\s*,)\s*["'`][a-z][a-z0-9+.-]*:\/\//g;
let endpointNamesCache: string[] | null = null;

/**
 * Every learned-state env name in src with its /workspace default, scanned once and cached for the vessel's own src.
 * Excluded: the bare /workspace and source trees under /workspace/git*, test files, node_modules, a default with
 * anything but plain path characters, the reserved names (a redirect never overrides PATH, HOME or the root), and any
 * START_SHAPING_NAME (a redirect never changes how the child starts).
 */
export function learnedStateDefaults(srcDir: string = OWN_SRC): Map<string, string> {
  if (stateDefaultsCache && srcDir === OWN_SRC) return stateDefaultsCache;
  const reserved = RESERVED();
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); continue; }
      if (!/\.(ts|js)$/.test(n) || /\.test\.ts$/.test(n)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(STATE_DEFAULT)) {
        const name = m[1] ?? m[2]!; const dflt = m[3]!;
        if (dflt === "/workspace" || dflt === "/workspace/" || dflt.startsWith("/workspace/git")) continue;
        if (!PLAIN_DEFAULT.test(dflt) || reserved.has(name) || START_SHAPING_NAME.test(name)) continue;
        out.set(name, dflt);
      }
    }
  };
  walk(srcDir);
  if (srcDir === OWN_SRC) stateDefaultsCache = out;
  return out;
}

/**
 * Every endpoint name a scrubbed child is given the discard address under, sorted: the fleet list and every name src
 * reads with a URL default (scanned once and cached for the vessel's own src; test files and node_modules excluded). A
 * reserved name, a START_SHAPING_NAME and a learned-state name are never taken.
 */
export function endpointNames(srcDir: string = OWN_SRC): string[] {
  if (endpointNamesCache && srcDir === OWN_SRC) return endpointNamesCache;
  const reserved = RESERVED();
  const learned = learnedStateDefaults(srcDir);
  const out = new Set<string>(FLEET_ENDPOINT_NAMES);
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); continue; }
      if (!/\.(ts|js)$/.test(n) || /\.test\.ts$/.test(n)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(ENDPOINT_DEFAULT)) out.add((m[1] ?? m[2] ?? m[3])!);
    }
  };
  walk(srcDir);
  const names = [...out].filter((n) => !reserved.has(n) && !START_SHAPING_NAME.test(n) && !learned.has(n)).sort();
  if (srcDir === OWN_SRC) endpointNamesCache = names;
  return names;
}

/** The endpoint redirects, name -> TEST_CHILD_DISCARD_ENDPOINT. */
export function endpointRedirects(): Record<string, string> {
  return Object.fromEntries(endpointNames().map((n) => [n, TEST_CHILD_DISCARD_ENDPOINT]));
}

/** Where a learned-state default lands under a scratch root: `<root>/<path below /workspace>`, the live layout with
 *  /workspace replaced by the root (the root stands where /workspace stands for WORKSPACE_ROOT-relative code too). */
export function scratchStatePath(root: string, dflt: string): string {
  return join(root, dflt.slice("/workspace".length));
}

/** The learned-state redirects for a scratch root, name -> fixed scratch path. */
export function learnedStateRedirects(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, dflt] of learnedStateDefaults()) out[name] = scratchStatePath(root, dflt);
  return out;
}

/** The parent directories of the redirected paths below the root, the root itself excluded (the writers are best-effort
 *  and create none). */
function redirectParents(): string[] {
  return [...new Set([...learnedStateDefaults().values()].map((d) => dirname(d.slice("/workspace/".length))))].filter((r) => r !== ".").sort();
}

/**
 * The scrubbed env object for Bun.spawn / Bun.spawnSync. With an explicit env, argv[0] is resolved on
 * THAT env's PATH, so the directory of the running bun is appended in case the parent's PATH lacks it
 * (a no-op when it is already there).
 */
export function testChildEnv(
  source: Record<string, string | undefined> = process.env,
  opts: { workspaceRoot?: string; pathAppend?: readonly string[] } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TEST_CHILD_ENV_PASSTHROUGH) {
    const v = source[name];
    if (v !== undefined && v !== "") env[name] = v;
  }
  const path = env["PATH"] ?? DEFAULT_PATH;
  const dirs = path.split(":");
  for (const extra of [...(opts.pathAppend ?? []), dirname(process.execPath)]) if (extra && !dirs.includes(extra)) dirs.push(extra);
  env["PATH"] = dirs.join(":");
  Object.assign(env, TEST_CHILD_ENV_FIXED, endpointRedirects());
  if (opts.workspaceRoot) {
    env["WORKSPACE_ROOT"] = opts.workspaceRoot;
    Object.assign(env, learnedStateRedirects(opts.workspaceRoot));
    for (const rel of redirectParents()) {
      try { mkdirSync(join(opts.workspaceRoot, rel), { recursive: true }); } catch { /* best-effort, as the writers are */ }
    }
  }
  return env;
}

/**
 * Run `fn` with a scrubbed env whose WORKSPACE_ROOT is a fresh scratch directory, removed afterwards
 * (after the returned promise settles, when `fn` is async). A child that defaults its writes to
 * WORKSPACE_ROOT therefore never writes the live workspace.
 */
export function withTestChildEnv<T>(
  fn: (env: Record<string, string>) => T,
  source: Record<string, string | undefined> = process.env,
  opts: { pathAppend?: readonly string[] } = {},
): T {
  const ws = mkdtempSync(`${tmpdir()}/test-child-ws-`);
  const remove = (): void => {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort scratch removal */ }
  };
  let deferred = false;
  try {
    const out = fn(testChildEnv(source, { workspaceRoot: ws, pathAppend: opts.pathAppend }));
    if (out instanceof Promise) {
      deferred = true;
      return out.finally(remove) as T;
    }
    return out;
  } finally {
    if (!deferred) remove();
  }
}

/**
 * The same allowlist as a shell prefix, for a command run through the shell producer:
 * `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test TZ=UTC ENDPOINT=http://127.0.0.1:9 … WORKSPACE_ROOT="$(mktemp -d)" env -S " NAME=\${WORKSPACE_ROOT}/… …"`.
 * Each endpoint word is a literal (no quote, no `$`), so the gate reads it as an assignment.
 * The parent's shape is kept: ONE flat `$(mktemp -d)` substitution (run by the outer shell, so a caller's TMPDIR still
 * places the root), no inline program, no `;` (the prefix sits inside callers' `( … )`, and the local-tools shell gate
 * refuses a substitution or command word it cannot read literally). The redirects are expanded by the SECOND `env`
 * (GNU `env -S` expands `${NAME}` from its own environment, which holds only the scrubbed set), so every redirect lies
 * under the child's own WORKSPACE_ROOT; the escapes keep the outer shell from expanding the parent's value. Redirects
 * directly below the root have an existing parent (the mktemp root); a redirect in a subdirectory (keys/, quiesce/, …)
 * has none until the child creates it, so its write is dropped inside the scratch root, never made live.
 * Put it immediately before the `bun`/`bunx` word (after any `timeout N`).
 */
export function testChildEnvShellPrefix(): string {
  const passthrough = TEST_CHILD_ENV_PASSTHROUGH.map((n) => `${n}="$${n}"`);
  const fixed = Object.entries(TEST_CHILD_ENV_FIXED).map(([k, v]) => `${k}=${v}`);
  // One `env -S` word: double-quoted, opening with a space, `\${…}` escaped for the outer shell. The local-tools gate
  // lexes the command without shell nesting, so where a caller wraps the prefix in "$( … )" (test_suite's mutation run,
  // feature-compose) its quote parity is flipped: the leading space ends the word before it at ` env -S ` (a literal
  // word), and every other word it then sees holds no `$` in a command position.
  const redirects = [...learnedStateDefaults()].map(([n, d]) => `${n}=\\\${WORKSPACE_ROOT}/${d.slice("/workspace/".length)}`);
  const endpoints = endpointNames().map((n) => `${n}=${TEST_CHILD_DISCARD_ENDPOINT}`);
  const parts = ["env -i", ...passthrough, ...fixed, ...endpoints, `WORKSPACE_ROOT="$(mktemp -d)"`];
  if (redirects.length > 0) parts.push(`env -S " ${redirects.join(" ")}"`);
  return parts.join(" ");
}
