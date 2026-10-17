// RUN A GAP-STORE HARNESS FILE IN ITS OWN PROCESS, REPORTING EVERY CASE BY NAME.
//
// substrate-gap captures WORKSPACE_ROOT once, at module load, and `bun test` shares one module registry across
// files: in the full suite the store root is frozen by whichever file imported it first (the checkout), so a
// harness file that drives the real store through gap-to-feature trips its own temp-dir guard in beforeAll and
// the suite reports one "(unnamed)" failure — its cases never run, which is the same as unenforced. A query-
// string fresh import does not help when the code under test imports substrate-gap itself.
//
// This runs `<name>.cases.ts` in a child `bun test` with a fresh temp WORKSPACE_ROOT, output captured to a FILE
// (never a pipe), and returns one row per case so the caller declares one named test per case. A child that
// reports no cases, or fails to run, yields a row that fails by name.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// LEARNED STATE STAYS IN THE CHILD'S TEMP ROOT (2026-10-17). A child spawned with an env built from scratch drops every
// state redirect the scrubbed suite env sets, so code under test fell back to its live defaults: fixture classes
// (stale-flap, stale-ctrl, sweep-*) landed in node1's LIVE /workspace/gap-class-posteriors.json during gate suites.
// Every `process.env.X ?? "/workspace/..."` default in src (the rule pull-sync's scrubbed_env derives its redirects by)
// is pointed under the child's own root, and the spawn is refused if any of them would still resolve outside tmpdir.
const STATE_DEFAULT = /process\.env(?:\.([A-Z0-9_]+)|\[["']([A-Z0-9_]+)["']\])\s*(?:\?\?|\|\|)\s*["'`](\/workspace[^"'`]*)/g;
let stateDefaultsCache: Map<string, string> | null = null;
/** Every learned-state env name in src with its /workspace default (source trees under /workspace/git and /workspace itself excluded). */
export function learnedStateDefaults(srcDir: string = join(import.meta.dir, "..", "..", "src")): Map<string, string> {
  if (stateDefaultsCache && srcDir === join(import.meta.dir, "..", "..", "src")) return stateDefaultsCache;
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); continue; }
      if (!/\.(ts|js)$/.test(n) || /\.test\.ts$/.test(n)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(STATE_DEFAULT)) {
        const name = m[1] ?? m[2]!; const dflt = m[3]!;
        if (dflt === "/workspace" || dflt === "/workspace/" || dflt.startsWith("/workspace/git")) continue;
        out.set(name, dflt);
      }
    }
  };
  walk(srcDir);
  if (srcDir === join(import.meta.dir, "..", "..", "src")) stateDefaultsCache = out;
  return out;
}
const underTmp = (p: string): boolean => { const r = resolve(p), t = resolve(tmpdir()); return r === t || r.startsWith(t + sep) || r.startsWith("/tmp/"); };
/** The env for an isolated child: as clean as before (HOME, PATH, WORKSPACE_ROOT=root, the compose-trigger skip, extras),
 *  plus every learned-state default pointed under `root`. Refuses (throws) if any learned-state path is outside tmpdir. */
export function isolatedChildEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root, SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1" };
  for (const [name, dflt] of learnedStateDefaults()) env[name] = join(root, "ws", dflt.slice("/workspace".length));
  Object.assign(env, extra);
  for (const name of learnedStateDefaults().keys()) {
    if (!underTmp(env[name]!)) throw new Error(`isolated child refused: ${name}=${env[name]} is not under tmpdir (the child would write live learned state)`);
  }
  if (!underTmp(env["WORKSPACE_ROOT"]!)) throw new Error(`isolated child refused: WORKSPACE_ROOT=${env["WORKSPACE_ROOT"]} is not under tmpdir`);
  return env;
}

export type CaseRow = { name: string; ok: boolean; detail: string };

export function runCasesIsolated(casesFile: string): CaseRow[] {
  const root = mkdtempSync(join(tmpdir(), "gap-harness-"));
  const out = join(root, "out.txt");
  try {
    const env = isolatedChildEnv(root);
    const p = Bun.spawnSync(["bash", "-c", `bun test ${JSON.stringify(casesFile)} > ${JSON.stringify(out)} 2>&1`], { env, cwd: join(import.meta.dir, "..", ".."), timeout: 120_000 });
    const text = (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })();
    // Child output is quoted ("  | ") when echoed, so its (pass)/(fail) lines are never read as the parent's.
    const quoted = (t: string): string => t.split("\n").map((l) => `  | ${l}`).join("\n");
    const rows: CaseRow[] = [];
    for (const line of text.split("\n")) {
      const m = /^\((pass|fail)\) (.*?)(?: \[[0-9.]+m?s\])?$/.exec(line);
      if (m) rows.push({ name: m[2]!, ok: m[1] === "pass", detail: m[1] === "fail" ? quoted(text.slice(0, 4000)) : "" });
    }
    if (rows.length === 0 || p.exitCode !== 0) rows.push({ name: `${casesFile} child run (exit ${String(p.exitCode)})`, ok: rows.length > 0 && p.exitCode === 0, detail: quoted(text.slice(-4000)) });
    return rows;
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
