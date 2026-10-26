// TEST IDENTITY TRACKING FOR THE PRELOAD'S SHARED GUARDS (test setup, not a test file).
//
// The node gate runs the whole suite in ONE bun process. test/preload.ts's afterEach/afterAll, and the
// violation arrays cutover-exec-guard.ts / cutover-fs-guard.ts share across every file, are process-wide:
// a violation recorded ASYNCHRONOUSLY, after its own test's afterEach already ran, used to land in the
// SAME shared array before the NEXT test's afterEach fired — failing an innocent test, sometimes in a
// different file (measured 2026-10-24: ~52 failures across 13 files from exactly this leak).
//
// This module gives every violation the IDENTITY of the test that was running when it was recorded, so the
// preload's afterEach can fail only the test that actually caused it, and a late (post-afterEach) violation
// can still be charged to its own recording test's FILE instead of whichever test happens to be running when
// it finally fires.
//
//   - currentTestId(): the file+name+sequence of the test whose execution is causally responsible for the
//     code running right now, tracked with node:async_hooks AsyncLocalStorage. ALS keeps the ORIGINAL test's
//     context on any promise/timer continuation chained from inside it, even if that continuation's callback
//     fires while a different test is synchronously executing (proven: a setTimeout queued inside test A
//     still reports A's identity when it fires during test B's await). A plain "current test" variable does
//     not have this property — it would read whichever test is running RIGHT NOW, which is exactly the bug.
//   - mostRecentTestId(): the plain, non-ALS identity of the test whose body most recently started. It stays
//     set through that test's own afterEach (the next test has not started yet) and is what afterEach compares
//     a violation's ALS-recorded owner against to decide "is this violation mine".
//   - onFileEnd(cb): cb fires once per test FILE, after every test in that file (including nested describes)
//     has run — registered by wrapping test/it/describe so the first registration call seen for a new file
//     (Bun.main changes) installs a real, file-scoped `afterAll`. Calling bun:test's real afterAll while a
//     NESTED describe is being collected binds it to that describe, not the file (measured): the wrap only
//     calls it at describe/test nesting depth 0, which is always the first thing bun does for a new file.
//
// Scope, stated honestly: a test registered through a child process's own `bun test` is not covered (same as
// the exec/fs guards); `.each()`-produced cases and `.skip/.only/.todo/.if/.skipIf/.todoIf/.failing` are wrapped
// generically (recursively, since a modifier call itself returns another test-shaped function) so every file's
// existing use of them keeps working under this tracking.
import { AsyncLocalStorage } from "node:async_hooks";
import { mock } from "bun:test";

export type TestId = { readonly file: string; readonly name: string; readonly seq: number };

export function sameTestId(a: TestId | undefined, b: TestId | undefined): boolean {
  return !!a && !!b && a.file === b.file && a.name === b.name && a.seq === b.seq;
}

const als = new AsyncLocalStorage<TestId>();
let seq = 0;
let mostRecent: TestId | undefined;
let depth = 0;
let lastFile = "";
const fileEndCallbacks: Array<(file: string) => void> = [];
let installed = false;

/** The ALS-tracked identity of the test causally responsible for the code running now, or undefined when
 *  nothing (module top level, a beforeAll outside any test) is responsible. */
export function currentTestId(): TestId | undefined {
  return als.getStore();
}

/** The identity to tag a freshly recorded violation with: the ALS owner when inside a test's causal chain,
 *  else the current file with no test name — still drained at that file's own afterAll, never a later file's. */
export function ownerForRecord(): TestId {
  return als.getStore() ?? { file: Bun.main, name: "<outside a test>", seq: -1 };
}

/** The identity of the test whose body most recently started — stays set through that test's own afterEach. */
export function mostRecentTestId(): TestId | undefined {
  return mostRecent;
}

/** Runs cb once, after every test in the given file (including nested describes) has run. */
export function onFileEnd(cb: (file: string) => void): void {
  fileEndCallbacks.push(cb);
}

function ensureFileHook(real: { afterAll: (fn: () => void | Promise<unknown>) => void }): void {
  const file = Bun.main;
  if (file === lastFile) return;
  lastFile = file;
  real.afterAll(() => { for (const cb of fileEndCallbacks) cb(file); });
}

function wrapBody<F extends (...a: unknown[]) => unknown>(fn: F, id: TestId): F {
  const wrapped = (...args: unknown[]) => {
    mostRecent = id;
    return als.run(id, () => fn(...args));
  };
  // bun picks done-callback style off fn.length (0 = no done arg); keep that signal intact.
  Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
  return wrapped as unknown as F;
}

type RealAfterAll = { afterAll: (fn: () => void | Promise<unknown>) => void };
type RunnerKind = "test" | "describe";

// test/it/describe expose `.skip`, `.only`, `.todo`, `.if`, `.skipIf`, `.todoIf`, `.failing`, `.each`,
// `.concurrent` as plain function-valued property reads (measured: NOT own or enumerable properties — neither
// Object.keys nor Object.getOwnPropertyNames sees them, so copying by enumeration silently drops every one of
// them and crashes the first file that calls `it.skipIf(...)` or `test.todo(...)`, both used in this suite).
// `describe` also THROWS (not just "undefined") on reading one of them (.failing), so each read is tried.
// Two shapes, both measured: `.skipIf`/`.todoIf`/`.if`/`.each` are FACTORIES — calling one returns ANOTHER
// runner-shaped function (`test.skipIf(cond)` returns something you then call with (name, fn)). `.skip`/
// `.only`/`.todo`/`.failing`/`.concurrent` are themselves already runner-shaped (`test.only` is directly
// callable as (name, fn, opts) AND itself carries further modifiers, e.g. `test.only.skipIf`) — so the
// property itself gets the full recursive wrap, not just its call result.
const RUNNER_MODIFIER_KEYS = ["skip", "only", "todo", "if", "skipIf", "todoIf", "failing", "each", "concurrent"] as const;
const FACTORY_MODIFIER_KEYS = new Set<string>(["if", "skipIf", "todoIf", "each"]);

/** Wraps a test/it/describe-shaped runner, and recursively every modifier it exposes, so that every path to
 *  registering a test runs through the same file-boundary and ALS-identity tracking. */
function wrapRunnerLike(real: RealAfterAll, orig: any, kind: RunnerKind): any {
  const wrapped = (name: string, fn: any, opts?: unknown) => {
    if (depth === 0) ensureFileHook(real);
    if (kind === "describe") {
      depth++;
      try { return orig(name, fn, opts); } finally { depth--; }
    }
    const id: TestId = { file: Bun.main, name: String(name), seq: seq++ };
    return orig(name, typeof fn === "function" ? wrapBody(fn, id) : fn, opts);
  };
  for (const key of RUNNER_MODIFIER_KEYS) {
    let v: unknown;
    try { v = orig[key]; } catch { continue; }
    if (typeof v !== "function") continue;
    (wrapped as any)[key] = FACTORY_MODIFIER_KEYS.has(key)
      ? (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(orig, args);
          return typeof result === "function" ? wrapRunnerLike(real, result, kind) : result;
        }
      : wrapRunnerLike(real, v, kind);
  }
  return wrapped;
}

/** Installs the test/it/describe wrapping (through mock.module, before any test file loads). Idempotent. */
export async function installTestIdentityTracking(): Promise<void> {
  if (installed) return;
  installed = true;
  const real = await import("bun:test");
  mock.module("bun:test", () => ({
    ...real,
    test: wrapRunnerLike(real, real.test, "test"),
    it: wrapRunnerLike(real, real.it, "test"),
    describe: wrapRunnerLike(real, real.describe, "describe"),
  }));
}
