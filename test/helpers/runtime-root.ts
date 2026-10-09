// A TEST NEVER WRITES THE LIVE RUNTIME ROOT.
//
// shape-vocabulary.ts freezes RUNTIME_ROOT (MITOSIS_RUNTIME_DIR, default /vessels), REPO_ROOT
// (MITOSIS_REPO_ROOT, default RUNTIME_ROOT) and SUPER_REPO_ROOT (MITOSIS_SUPER_REPO_DIR) when it LOADS,
// and one `bun test` process shares one module registry across every test file. So setting the env
// var before `await import(...)` in a test file works only when that file is the first to load the
// module. In a whole-suite run (pull-sync's test gate, feature_compose's verify step, the test_suite
// resolver) an earlier file that imports feature-compose with no override freezes the root to the
// live /vessels, and a later test that resumes a parked landing or applies a plan writes its fixture
// files into the live tree.
//
// isolateRuntimeRoot() makes a writer test independent of load order:
//   1. a fresh mkdtemp root, written to the env vars before this file loads the module;
//   2. if an earlier loader already froze the module to another value, mock.module re-binds the
//      exports (Bun patches the live bindings every importer already holds) to this file's root;
//   3. assertRuntimeRootIsolated() then re-reads the module's EFFECTIVE values and refuses to go on
//      (throws at load, before any test body can write) unless every root is this file's temp root.
//
// The pin is deliberately not undone in afterAll: undoing it would re-bind the roots to /vessels for
// every later file. A pin left on a deleted temp dir is strictly safer than one on the live tree.
//
// Call it at the top level of the test file, BEFORE the first import (static or dynamic) of any
// module that reaches shape-vocabulary (feature-compose, vessel-mitosis-cutover, ...). A static
// `import` of such a module is hoisted above every statement and defeats step 1; use `await import`.
// test/runtime-root-isolation.test.ts lists every test file that loads such a module without this.
import { mock } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const SHAPE_VOCABULARY = join(import.meta.dir, "..", "..", "src", "shape-vocabulary.ts");

export interface RootBindings {
  RUNTIME_ROOT: string;
  REPO_ROOT: string;
  SUPER_REPO_ROOT?: string;
}

/** True when p is a path strictly inside the OS temp dir. */
export function isUnderTmp(p: string): boolean {
  if (!p || !isAbsolute(p)) return false;
  const roots = new Set([tmpdir()]);
  try { roots.add(realpathSync(tmpdir())); } catch { /* keep tmpdir() */ }
  return [...roots].some((t) => {
    const r = relative(t, p);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  });
}

/**
 * THE GUARD. Throws unless every effective root equals the expected one and the expected one is under
 * the OS temp dir (so never /vessels, never /workspace/...). Called on the values the module holds now.
 */
export function assertRuntimeRootIsolated(effective: RootBindings, expected: RootBindings, who = "this test"): void {
  const names = Object.keys(expected) as Array<keyof RootBindings>;
  for (const k of names) {
    const want = expected[k];
    const got = effective[k];
    if (want === undefined) continue;
    if (!isUnderTmp(want) || got !== want || got === "/vessels" || !isUnderTmp(String(got))) {
      throw new Error(`${who} would use ${k}=${String(got)} (expected its own temp root ${want} under ${tmpdir()}) - refusing to run against a real runtime root`);
    }
  }
}

export interface IsolatedRuntimeRoot {
  /** The file's own temp dir; RUNTIME (and REPO) live under it. */
  root: string;
  /** The effective RUNTIME_ROOT and REPO_ROOT of shape-vocabulary (and so of feature-compose). */
  runtime: string;
  /** The effective SUPER_REPO_ROOT, when superRepo was requested. */
  superRepo?: string;
}

/**
 * Give this test file its own temp runtime root (see the header). Options:
 *   superRepo: also isolate SUPER_REPO_ROOT (a path under the temp root that does not exist).
 */
export async function isolateRuntimeRoot(prefix: string, opts: { superRepo?: boolean; who?: string } = {}): Promise<IsolatedRuntimeRoot> {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const runtime = join(root, "runtime");
  const superRepo = opts.superRepo ? join(root, "no-super-repo") : undefined;
  process.env["MITOSIS_RUNTIME_DIR"] = runtime;
  process.env["MITOSIS_REPO_ROOT"] = runtime;
  if (superRepo) process.env["MITOSIS_SUPER_REPO_DIR"] = superRepo;
  const expected: RootBindings = { RUNTIME_ROOT: runtime, REPO_ROOT: runtime, ...(superRepo ? { SUPER_REPO_ROOT: superRepo } : {}) };

  const sv = (await import(SHAPE_VOCABULARY)) as Record<string, unknown>;
  const frozen = (k: keyof RootBindings) => sv[k] !== expected[k] && expected[k] !== undefined;
  if (frozen("RUNTIME_ROOT") || frozen("REPO_ROOT") || frozen("SUPER_REPO_ROOT")) {
    const real = { ...sv };
    mock.module(SHAPE_VOCABULARY, () => ({ ...real, ...expected }));
  }
  const now = (await import(SHAPE_VOCABULARY)) as Record<string, unknown>;
  assertRuntimeRootIsolated(
    { RUNTIME_ROOT: String(now["RUNTIME_ROOT"]), REPO_ROOT: String(now["REPO_ROOT"]), SUPER_REPO_ROOT: String(now["SUPER_REPO_ROOT"]) },
    expected,
    opts.who,
  );
  return { root, runtime, ...(superRepo ? { superRepo } : {}) };
}
