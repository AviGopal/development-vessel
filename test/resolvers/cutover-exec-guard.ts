// SHARED PROCESS-EXEC GUARD (test setup, not a test file). The third guard beside
// cutover-fetch-guard.ts (network) and cutover-fs-guard.ts (filesystem).
//
// Resolvers shell out to host-lifecycle tools: systemd-restart calls `systemctl restart <unit>`
// through Bun.spawn, and other paths reach docker, podman and vessel-ctl through child_process or a
// shell string. In `bun test` those run on whatever host runs the suite: on a dev host they restart
// (or fail to restart) the operator's own units, inside a substrate container they restart the LIVE
// fleet. Measured 2026-10-03: systemd-restart.test.ts called the host's real `systemctl restart`,
// and the result (pass in ~2 s, or a 5 s timeout) depended on the host, not on the code.
//
// installCutoverExecGuard() wraps Bun.spawn, Bun.spawnSync and node:child_process spawn / exec /
// execFile / fork and their sync forms (through bun's mock.module, under both "child_process" and
// "node:child_process"). A command whose program, or any command word of a shell string, is one of
// systemctl, docker, podman or vessel-ctl is BLOCKED (throws EPERM, nothing is executed) AND RECORDED,
// unless the test declared a route for it, in which case the route's fake result is returned and
// the call is recorded under `hits`. Recording matters: callers swallow spawn errors, so a throw
// alone would let a test pass on a fail-open path. Every other command passes through unchanged.
//
// RESTORE IS NOT AUTOMATIC (same as the fs guard: mock.restore() does not undo mock.module). Call
// restore() from afterEach and restoreCutoverExecModules() from afterAll.
//
// Scope, stated honestly: a child process (e.g. `bun --eval …`) is NOT covered; its own Bun.spawn is
// a fresh, unguarded one. A test that spawns a child which may run a blocked tool must instead pass
// the child an environment in which that tool cannot resolve.
import { mock } from "bun:test";
import * as realCp from "node:child_process";

const ORIG_CP: Record<string, any> = { ...realCp };
const ORIG_SPAWN = Bun.spawn;
const ORIG_SPAWN_SYNC = Bun.spawnSync;

export const BLOCKED_PROGRAMS = ["systemctl", "docker", "podman", "vessel-ctl"] as const;
const BLOCKED_WORD = new RegExp(`(?:^|[\\s;&|()\`'"/=])(${BLOCKED_PROGRAMS.join("|")})(?=$|[\\s;&|)\`'"])`);

/** The blocked program a command names (argv[0] basename, or a command word in a shell string), or null. */
export function blockedProgramIn(command: string): string | null {
  return BLOCKED_WORD.exec(command)?.[1] ?? null;
}

export type ExecRouteResult = { exitCode: number; stdout?: string; stderr?: string };
export type ExecRoute = { name: string; match: (command: string) => boolean; respond: (command: string) => ExecRouteResult };
export type ExecGuard = {
  route: (r: ExecRoute) => void;
  /** Blocked commands that matched no route, in order ("<api>: <command>"). */
  violations: string[];
  /** Routed (stubbed) blocked commands, by route name. */
  hits: string[];
  restore: () => string[];
};

const argvText = (cmd: unknown, args?: unknown): string => {
  if (Array.isArray(cmd)) return cmd.map(String).join(" ");
  if (cmd && typeof cmd === "object" && Array.isArray((cmd as { cmd?: unknown }).cmd)) return ((cmd as { cmd: unknown[] }).cmd).map(String).join(" ");
  return [String(cmd ?? ""), ...(Array.isArray(args) ? args.map(String) : [])].join(" ");
};
const stream = (s: string): ReadableStream<Uint8Array> => new Blob([s]).stream();

/** Re-installs the real node:child_process, Bun.spawn and Bun.spawnSync. Idempotent; safe in afterAll. */
export function restoreCutoverExecModules(): void {
  mock.module("node:child_process", () => ORIG_CP);
  mock.module("child_process", () => ORIG_CP);
  (Bun as unknown as { spawn: unknown }).spawn = ORIG_SPAWN;
  (Bun as unknown as { spawnSync: unknown }).spawnSync = ORIG_SPAWN_SYNC;
}

export function installCutoverExecGuard(): ExecGuard {
  const routes: ExecRoute[] = [];
  const violations: string[] = [];
  const hits: string[] = [];
  /** null = pass through; otherwise the routed result. Throws (after recording) when blocked and unrouted. */
  const decide = (api: string, command: string): ExecRouteResult | null => {
    if (blockedProgramIn(command) === null) return null;
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i]!;
      if (r.match(command)) { hits.push(r.name); return r.respond(command); }
    }
    violations.push(`${api}: ${command}`);
    const err = new Error(`cutover exec guard: blocked ${api} of a host-lifecycle tool: ${command}`) as NodeJS.ErrnoException;
    err.code = "EPERM";
    throw err;
  };

  (Bun as unknown as { spawn: unknown }).spawn = (cmd: unknown, opts?: unknown) => {
    const routed = decide("Bun.spawn", argvText(cmd));
    if (!routed) return (ORIG_SPAWN as (...a: unknown[]) => unknown)(cmd, opts);
    return {
      pid: -1,
      exitCode: routed.exitCode,
      signalCode: null,
      killed: false,
      exited: Promise.resolve(routed.exitCode),
      stdout: stream(routed.stdout ?? ""),
      stderr: stream(routed.stderr ?? ""),
      stdin: undefined,
      kill: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    };
  };
  (Bun as unknown as { spawnSync: unknown }).spawnSync = (cmd: unknown, opts?: unknown) => {
    const routed = decide("Bun.spawnSync", argvText(cmd));
    if (!routed) return (ORIG_SPAWN_SYNC as (...a: unknown[]) => unknown)(cmd, opts);
    return { exitCode: routed.exitCode, success: routed.exitCode === 0, stdout: Buffer.from(routed.stdout ?? ""), stderr: Buffer.from(routed.stderr ?? ""), pid: -1 };
  };

  const CP: Record<string, any> = { ...ORIG_CP };
  const fail = (api: string, command: string, r: ExecRouteResult): Error => {
    const e = new Error(`Command failed: ${command}\n${r.stderr ?? ""}`) as Error & { status?: number; code?: number; stdout?: string; stderr?: string };
    e.status = r.exitCode; e.code = r.exitCode; e.stdout = r.stdout ?? ""; e.stderr = r.stderr ?? "";
    void api;
    return e;
  };
  // sync forms
  CP.execSync = (command: string, opts?: unknown) => {
    const r = decide("child_process.execSync", String(command));
    if (!r) return ORIG_CP.execSync(command, opts);
    if (r.exitCode !== 0) throw fail("execSync", String(command), r);
    return Buffer.from(r.stdout ?? "");
  };
  CP.execFileSync = (file: string, args?: unknown, opts?: unknown) => {
    const command = argvText(file, args);
    const r = decide("child_process.execFileSync", command);
    if (!r) return ORIG_CP.execFileSync(file, args, opts);
    if (r.exitCode !== 0) throw fail("execFileSync", command, r);
    return Buffer.from(r.stdout ?? "");
  };
  CP.spawnSync = (file: string, args?: unknown, opts?: unknown) => {
    const command = argvText(file, args);
    const r = decide("child_process.spawnSync", command);
    if (!r) return ORIG_CP.spawnSync(file, args, opts);
    return { pid: -1, status: r.exitCode, signal: null, output: [null, Buffer.from(r.stdout ?? ""), Buffer.from(r.stderr ?? "")], stdout: Buffer.from(r.stdout ?? ""), stderr: Buffer.from(r.stderr ?? "") };
  };
  // async forms: a routed call answers through the callback / a minimal emitter
  const fakeChild = (r: ExecRouteResult) => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const child = {
      pid: -1,
      stdout: { on: (ev: string, fn: (d: unknown) => void) => { if (ev === "data" && r.stdout) queueMicrotask(() => fn(Buffer.from(r.stdout!))); return child.stdout; } },
      stderr: { on: (ev: string, fn: (d: unknown) => void) => { if (ev === "data" && r.stderr) queueMicrotask(() => fn(Buffer.from(r.stderr!))); return child.stderr; } },
      on: (ev: string, fn: (...a: unknown[]) => void) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); return child; },
      once: (ev: string, fn: (...a: unknown[]) => void) => child.on(ev, fn),
      kill: () => true,
    };
    setTimeout(() => { for (const ev of ["exit", "close"]) for (const fn of listeners.get(ev) ?? []) fn(r.exitCode, null); }, 0);
    return child;
  };
  const withCallback = (api: string, command: string, cb: unknown, r: ExecRouteResult) => {
    if (typeof cb === "function") setTimeout(() => (cb as (...a: unknown[]) => void)(r.exitCode === 0 ? null : fail(api, command, r), r.stdout ?? "", r.stderr ?? ""), 0);
    return fakeChild(r);
  };
  CP.exec = (command: string, ...rest: unknown[]) => {
    const r = decide("child_process.exec", String(command));
    if (!r) return ORIG_CP.exec(command, ...rest);
    return withCallback("exec", String(command), rest.find((x) => typeof x === "function"), r);
  };
  CP.execFile = (file: string, ...rest: unknown[]) => {
    const command = argvText(file, Array.isArray(rest[0]) ? rest[0] : []);
    const r = decide("child_process.execFile", command);
    if (!r) return ORIG_CP.execFile(file, ...rest);
    return withCallback("execFile", command, rest.find((x) => typeof x === "function"), r);
  };
  CP.spawn = (file: string, args?: unknown, opts?: unknown) => {
    const command = argvText(file, Array.isArray(args) ? args : []);
    const r = decide("child_process.spawn", command);
    if (!r) return ORIG_CP.spawn(file, args, opts);
    return fakeChild(r);
  };
  CP.fork = (mod: string, args?: unknown, opts?: unknown) => {
    const command = argvText(mod, Array.isArray(args) ? args : []);
    const r = decide("child_process.fork", command);
    if (!r) return ORIG_CP.fork(mod, args, opts);
    return fakeChild(r);
  };
  CP["default"] = CP;
  mock.module("node:child_process", () => CP);
  mock.module("child_process", () => CP);

  return {
    route: (r) => { routes.push(r); },
    violations,
    hits,
    restore: () => {
      restoreCutoverExecModules();
      return [...violations];
    },
  };
}
