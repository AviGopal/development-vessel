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
 * Not configurable at runtime, by design: nothing reads an env var or a flag to widen it.
 */
import { dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** Inherited from the parent by name: non-secret, needed to find and run bun. */
export const TEST_CHILD_ENV_PASSTHROUGH: readonly string[] = Object.freeze(["PATH", "HOME"]);
/** Fixed values: never read from the parent. */
export const TEST_CHILD_ENV_FIXED: Readonly<Record<string, string>> = Object.freeze({ NODE_ENV: "test", TZ: "UTC" });

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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
  Object.assign(env, TEST_CHILD_ENV_FIXED);
  if (opts.workspaceRoot) env["WORKSPACE_ROOT"] = opts.workspaceRoot;
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
 * `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test TZ=UTC WORKSPACE_ROOT="$(mktemp -d)"`.
 * Put it immediately before the `bun`/`bunx` word (after any `timeout N`).
 */
export function testChildEnvShellPrefix(): string {
  const passthrough = TEST_CHILD_ENV_PASSTHROUGH.map((n) => `${n}="$${n}"`);
  const fixed = Object.entries(TEST_CHILD_ENV_FIXED).map(([k, v]) => `${k}=${v}`);
  return ["env -i", ...passthrough, ...fixed, `WORKSPACE_ROOT="$(mktemp -d)"`].join(" ");
}
