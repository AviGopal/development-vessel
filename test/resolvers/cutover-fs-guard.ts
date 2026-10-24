// SHARED FILESYSTEM GUARD FOR THE CUTOVER SUITES (test setup, not a test file).
//
// The cutover and the resolvers it calls write to absolute paths that are not under the test's
// temp root: /workspace/post-land-baseline/<vessel>.json (a literal), the gap store and other
// stores under a WORKSPACE_ROOT captured at MODULE LOAD (config.ts WORKSPACE_ROOT,
// substrate-gap.ts WORKSPACE_ROOT_AT_LOAD), which in `bun test` is whatever the first importer
// saw: process.cwd() (the repo checkout) on a dev host, /workspace/git/super-repo inside a
// substrate container — the LIVE store. A cutover unit test must never write there.
//
// installCutoverFsGuard() wraps every write-capable function of node:fs and node:fs/promises
// (through bun's mock.module, which also rebinds modules that already imported them, under any
// specifier: "fs", "node:fs", "fs/promises", "node:fs/promises", dynamic import) plus Bun.write.
// A write, create, rename, copy, delete, chmod or write-mode open whose target resolves outside
// os.tmpdir() is BLOCKED (throws EACCES) AND RECORDED. Recording matters: most callers swallow fs
// errors, so a throw alone would let the test pass. restore() re-installs the original modules
// and returns the violations so afterEach can fail the test on any of them.
//
// RESTORE IS NOT AUTOMATIC. bun's mock.restore() does NOT undo mock.module (measured on bun
// 1.3.14: a module mocked in one file stayed mocked for the next file in the same process even
// after mock.restore()). The only undo is re-mocking with the saved real module objects, which is
// what restoreCutoverFsModules() does. Each file calls it from afterEach (via restore()) AND from
// afterAll, so a file that ends early can never leave fs guarded for the next file in the process
// (pinned by test/resolvers/cutover-guard-leak-probe.test.ts).
//
// Scope, stated honestly: child processes (git, the shell producer stand-in) are not covered —
// they do not go through this process's fs module. installCutoverFsGuard() does not block reads.
//
// SECRET READS ARE BLOCKED FOR EVERY FILE (2026-10-24). Each node's pull-sync gate runs the whole suite
// inside the live container, where the fleet's env file, its persisted secrets and the vessels' identity
// keys sit at fixed paths, and a code default that the test scrub cannot see (a named-constant key path)
// resolved to the live identity key. test/preload.ts installs installSecretReadGuard() before any test
// file loads: a content read (readFile, open, createReadStream, copyFile/cp source, Bun.file) of a path
// under SECRET_READ_ROOTS, or of the path VESSEL_IDENTITY_KEY_PATH names when it is outside the tmpdir,
// throws EACCES and is RECORDED; the preload's afterEach fails the test that made one
// (takeSecretReadViolations()). That layer is the BASELINE: installCutoverFsGuard() stacks on it and its
// restore returns to it. existsSync/stat/readdir are not content reads and are not blocked.
import { mock } from "bun:test";
import * as realFsp from "node:fs/promises";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIG_P: Record<string, any> = { ...realFsp };
const ORIG_S: Record<string, any> = { ...realFs };
const ORIG_BUN_WRITE = Bun.write;
const ORIG_BUN_FILE = Bun.file;
// What restore returns to: the real modules, or the preload's secret-read guard once it is installed.
let BASE_P: Record<string, any> = ORIG_P;
let BASE_S: Record<string, any> = ORIG_S;
let BASE_BUN_FILE: unknown = ORIG_BUN_FILE;

const ALLOWED_ROOTS = (() => {
  const roots = new Set<string>([resolve(tmpdir())]);
  try { roots.add(realFs.realpathSync(tmpdir())); } catch { /* keep the lexical root */ }
  return [...roots];
})();
/** Also allow a scratch root the process was started with (the preload's per-run TMPDIR sits inside it, and the
 *  scrubbed suite env's WORKSPACE_ROOT is under it). */
function allowScratchRoot(root: string): void {
  for (const r of [resolve(root), (() => { try { return realFs.realpathSync(root); } catch { return resolve(root); } })()]) {
    if (!ALLOWED_ROOTS.includes(r)) ALLOWED_ROOTS.push(r);
  }
}

function toPath(p: unknown): string | null {
  if (typeof p === "number") return null; // a file descriptor: its open() was checked
  if (typeof p === "string") return resolve(p);
  if (p instanceof URL) return resolve(fileURLToPath(p));
  if (p instanceof Uint8Array) return resolve(Buffer.from(p).toString());
  if (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string") return resolve((p as { name: string }).name); // BunFile
  return null;
}
function insideTmp(abs: string): boolean {
  return ALLOWED_ROOTS.some((r) => abs === r || abs.startsWith(r + "/"));
}
function writeFlags(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return (flags & (realFs.constants.O_WRONLY | realFs.constants.O_RDWR | realFs.constants.O_CREAT | realFs.constants.O_APPEND | realFs.constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
}

export type FsGuard = { violations: string[]; restore: () => string[] };

/** Re-installs the baseline node:fs, node:fs/promises, Bun.write and Bun.file: the preload's secret-read guard
 *  when it is installed, else the real ones. Idempotent; safe in afterAll. */
export function restoreCutoverFsModules(): void {
  mock.module("node:fs/promises", () => BASE_P);
  mock.module("node:fs", () => BASE_S);
  (Bun as unknown as { write: unknown }).write = ORIG_BUN_WRITE;
  (Bun as unknown as { file: unknown }).file = BASE_BUN_FILE;
}

/** Where a test may never read content: the fleet env and config, the persisted and scoped secrets, the
 *  vessels' identity keys, mounted secrets. */
export const SECRET_READ_ROOTS: readonly string[] = Object.freeze([
  "/etc/substrate", "/workspace/.substrate-secrets", "/workspace/.substrate-private", "/workspace/keys", "/run/secrets",
]);
function secretTarget(abs: string): boolean {
  const under = (root: string) => abs === root || abs.startsWith(root + "/") || (root === "/workspace/.substrate-secrets" && abs.startsWith(root));
  if (SECRET_READ_ROOTS.some(under)) return true;
  const key = process.env["VESSEL_IDENTITY_KEY_PATH"];
  return !!key && abs === resolve(key) && !insideTmp(abs);
}
let secretGuard: FsGuard | null = null;
/** The test preload's always-on secret-read layer (test/preload.ts); makes itself the baseline. `scratchRoots`: the
 *  tmp root(s) the process started with, which stay writable for installCutoverFsGuard() and never count as a key
 *  location. Idempotent. */
export function installSecretReadGuard(scratchRoots: readonly string[] = []): FsGuard {
  if (secretGuard) return secretGuard;
  for (const r of scratchRoots) allowScratchRoot(r);
  const violations: string[] = [];
  const check = (op: string, target: unknown): void => {
    const lexical = toPath(target);
    if (lexical === null) return;
    let real = lexical;
    try { real = realFs.realpathSync(lexical); } catch { /* absent: the lexical path decides */ }
    if (!secretTarget(lexical) && !secretTarget(real)) return;
    violations.push(`${op} ${lexical}`);
    const err = new Error(`test secret-read guard: ${op} of a secret path: ${lexical}`) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  // which argument(s) name the read path
  const reads: Record<string, (a: unknown[]) => unknown[]> = {
    readFile: (a) => [a[0]], open: (a) => [a[0]], createReadStream: (a) => [a[0]],
    copyFile: (a) => [a[0]], cp: (a) => [a[0]], openAsBlob: (a) => [a[0]],
  };
  const P: Record<string, any> = { ...ORIG_P };
  const S: Record<string, any> = { ...ORIG_S };
  for (const [name, pick] of Object.entries(reads)) {
    if (typeof ORIG_P[name] === "function") {
      P[name] = async (...a: unknown[]) => { for (const t of pick(a)) check(`fs/promises.${name}`, t); return ORIG_P[name](...a); };
    }
    if (typeof ORIG_S[name] === "function") {
      S[name] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${name}`, t); return ORIG_S[name](...a); };
    }
    const sync = `${name}Sync`;
    if (typeof ORIG_S[sync] === "function") {
      S[sync] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${sync}`, t); return ORIG_S[sync](...a); };
    }
  }
  P["default"] = P;
  S["promises"] = P;
  S["default"] = S;
  BASE_P = P;
  BASE_S = S;
  mock.module("node:fs/promises", () => P);
  mock.module("node:fs", () => S);
  const bunFile = (path: unknown, ...rest: unknown[]) => { check("Bun.file", path); return (ORIG_BUN_FILE as (...a: unknown[]) => unknown)(path, ...rest); };
  BASE_BUN_FILE = bunFile;
  (Bun as unknown as { file: unknown }).file = bunFile;
  secretGuard = { violations, restore: () => [...violations] };
  return secretGuard;
}
/** The preload's secret-read guard, or null when this process runs without the preload. */
export const secretReadGuard = (): FsGuard | null => secretGuard;
/** The secret reads the preload's guard blocked since the last take, cleared (as takePreloadExecViolations). */
export function takeSecretReadViolations(): string[] {
  return secretGuard ? secretGuard.violations.splice(0) : [];
}

export function installCutoverFsGuard(): FsGuard {
  const violations: string[] = [];
  const check = (op: string, target: unknown): void => {
    const abs = toPath(target);
    if (abs === null || insideTmp(abs)) return;
    violations.push(`${op} ${abs}`);
    const err = new Error(`cutover fs guard: ${op} outside the test tmpdir: ${abs}`) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  // which argument(s) name the written path
  const targets: Record<string, (a: unknown[]) => unknown[]> = {
    writeFile: (a) => [a[0]], appendFile: (a) => [a[0]], mkdir: (a) => [a[0]], mkdtemp: (a) => [a[0]],
    rename: (a) => [a[0], a[1]], copyFile: (a) => [a[1]], cp: (a) => [a[1]], rm: (a) => [a[0]],
    rmdir: (a) => [a[0]], unlink: (a) => [a[0]], symlink: (a) => [a[1]], link: (a) => [a[1]],
    truncate: (a) => [a[0]], chmod: (a) => [a[0]], chown: (a) => [a[0]], utimes: (a) => [a[0]],
    lchown: (a) => [a[0]], lutimes: (a) => [a[0]],
    open: (a) => (writeFlags(a[1]) ? [a[0]] : []),
    createWriteStream: (a) => [a[0]],
  };
  const P: Record<string, any> = { ...BASE_P };
  const S: Record<string, any> = { ...BASE_S };
  for (const [name, pick] of Object.entries(targets)) {
    if (typeof BASE_P[name] === "function") {
      P[name] = async (...a: unknown[]) => { for (const t of pick(a)) check(`fs/promises.${name}`, t); return BASE_P[name](...a); };
    }
    if (typeof BASE_S[name] === "function") {
      S[name] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${name}`, t); return BASE_S[name](...a); };
    }
    const sync = `${name}Sync`;
    if (typeof BASE_S[sync] === "function") {
      S[sync] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${sync}`, t); return BASE_S[sync](...a); };
    }
  }
  P["default"] = P;
  S["promises"] = P;
  S["default"] = S;
  mock.module("node:fs/promises", () => P);
  mock.module("node:fs", () => S);
  (Bun as unknown as { write: unknown }).write = (dest: unknown, ...rest: unknown[]) => {
    try { check("Bun.write", dest); } catch (e) { return Promise.reject(e); }
    return (ORIG_BUN_WRITE as (...a: unknown[]) => unknown)(dest, ...rest);
  };
  return {
    violations,
    restore: () => {
      restoreCutoverFsModules();
      return [...violations];
    },
  };
}
