// SHARED SETUP FOR THE DRAFTER-SPLIT PINS (test setup, not a test file; closed with test/drafter-split/).
//
// The drafter split gives the decompose prompt's ASSEMBLY to an open module (src/drafter/) behind closed clamps and
// a closed floor (today's assembly, kept in feature-compose.ts). These pins drive the REAL entry point,
// resolveFeatureCompose, over a fixed corpus of composes and record everything a verdict, a gate or a write could
// depend on: the verdict, stage and error, the plan's ops, what was applied, every gap-store write in order, every
// guarded fetch, every prompt (sha256 and byte length; the decompose prompt in full), lesson-file writes and the
// console, normalised. The corpus was recorded on the tree BEFORE the split (verdict-diff.golden.json) and must stay
// byte-identical after it.
//
// SEAMS (hermetic; nothing reaches a live path):
//   - the runtime root is the calling file's isolateRuntimeRoot temp dir (shape-vocabulary's roots are pinned to it);
//   - every fetch goes through one router: discovery (llm, tools, the own pool producer, nothing else), the tools
//     endpoint (fs_read / fs_edit / fs_write against the temp tree; shell commands emulated: find, grep, diff,
//     the verify script, the own-check runs), the LLM (planner, refiner, judge, refuter; scripted), the gap store
//     (an in-memory row set). A request no route answers is recorded and refused, so it shows in the recording;
//   - node:fs is wrapped (bun mock.module): the two compose lesson files read fixture text, so the recording does
//     not depend on the host or container the suite runs in, and every write outside the OS temp dir is refused and
//     recorded (the lesson appends land in the recording instead of /workspace);
//   - Math.random is seeded per fixture; ISO timestamps, epoch milliseconds and the temp root are normalised.
// restore() puts node:fs and the globals back; a test file calls it in afterAll.
import { mock } from "bun:test";
import * as realFs from "node:fs";
import * as realFsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
import { installCutoverExecGuard, type ExecGuard } from "../resolvers/cutover-exec-guard.js";
import { __setGapWriteEventsEnabledForTests } from "../../src/resolvers/substrate-gap.js";

export type Row = Record<string, any>;
export type PlanKind = "pass" | "verify_red" | "non_unique" | "off_target" | "create" | "no_ops" | "drafter_edit" | "seed_edit" | "seed_edit_bumped" | "seed_new" | "seed_new_versioned";
export interface Fixture {
  name: string;
  /** feature_compose pointer (type added). */
  pointer: Row;
  plan: PlanKind;
  /** Gap rows the store holds. */
  store?: Row[];
  /** Extra runtime files (vessel-relative "demo-vessel/src/x.ts" -> text). */
  files?: Record<string, string>;
  /** Files in the vessel CLONE (the own check is read from there). */
  clone?: Record<string, string>;
  /** autonomyScope excluded_paths (undirected composes read it). */
  scope?: string[];
  /** Other pool records the own pool producer holds, by shape (e.g. spendEnvelope for a landing compose). */
  pool?: Record<string, Row>;
}

/** In-process test adapter for module mocks. Production always uses the real terminable Worker; tests that replace a
 * drafter module use this facade so Bun's mock.module applies in the test isolate. */
export function installInlineDrafterWorker(): () => void {
  const previous = globalThis.Worker;
  type WireRequest = { variant: string; entry: "planDrafterReads" | "assembleDrafterContext"; facts: unknown };
  type WireReply = { ok: true; value: unknown } | { ok: false; error: string };
  class InlineDrafterWorker {
    onmessage: ((this: Worker, ev: MessageEvent<WireReply>) => unknown) | null = null;
    onerror: ((this: Worker, ev: ErrorEvent) => unknown) | null = null;
    postMessage(raw: unknown): void {
      void Promise.resolve().then(async () => {
        const input = raw as WireRequest;
        try {
          if (input.variant !== "drafter-v1" && !/^drafter-v[0-9]+[a-z0-9-]*$/.test(input.variant)) throw new Error("variant id is outside the allowlist");
          const specifier = input.variant === "drafter-v1" ? "../../src/drafter/index.ts" : `../../src/drafter/variants/${input.variant}/index.ts`;
          let mod: Record<string, unknown>;
          try { mod = await import(specifier) as Record<string, unknown>; }
          catch (err) {
            this.onmessage?.call(this as unknown as Worker, new MessageEvent<WireReply>("message", { data: { ok: false, error: `import_failed: ${String((err as Error)?.message ?? err)}` } }));
            return;
          }
          const fn = mod[input.entry];
          if (typeof fn !== "function") throw new Error(`module missing ${input.entry}`);
          const value = await (fn as (facts: unknown) => unknown)(input.facts);
          this.onmessage?.call(this as unknown as Worker, new MessageEvent<WireReply>("message", { data: { ok: true, value } }));
        } catch (err) {
          const stage = (raw as WireRequest)?.entry === "planDrafterReads" ? "plan_threw" : "assemble_threw";
          this.onmessage?.call(this as unknown as Worker, new MessageEvent<WireReply>("message", { data: { ok: false, error: `${stage}: ${String((err as Error)?.message ?? err)}` } }));
        }
      });
    }
    terminate(): void {}
  }
  globalThis.Worker = InlineDrafterWorker as unknown as typeof Worker;
  return () => { globalThis.Worker = previous; };
}
export interface Recording {
  name: string;
  verdict: unknown; stage: unknown; ok: unknown; error: string;
  ops: Array<{ kind: unknown; path: unknown; old: string }>;
  applied: string[];
  prompts: Array<{ kind: string; sha256: string; bytes: number }>;
  decompose_prompt: string;
  fetches: string[];
  gap_writes: string[];
  fs_writes: string[];
  console: string[];
}

export const VESSEL = "demo-vessel";
export const OTHER = "helper-vessel";
const TOOLS = "http://tools.drafter-split/resolve";
const LLM = "http://llm.drafter-split/resolve";
const POOL = "http://pool.drafter-split";
const STORE = "http://gap-store.drafter-split/resolve";
export const COMPOSE_LESSONS = "/workspace/proposals/compose-lessons.jsonl";
export const COMPOSE_FILE_LESSONS = "/workspace/proposals/compose-file-lessons.jsonl";

// ── fixture text ─────────────────────────────────────────────────────────────────────────────────────────────
export const COMPUTE_SRC = [
  'import { scale } from "./helper.js";',
  "export const GUARD_RE = /\\?\\?/;",
  "export function compute(x: number): number {",
  "  const base = scale(x);",
  "  return base + 1;",
  "}",
  "export function twice(x: number): number {",
  "  return compute(x) + compute(x);",
  "}",
  "",
].join("\n");
export const HELPER_SRC = ["export function scale(x: number): number {", "  return x * 2;", "}", ""].join("\n");
/** A large file (well past one 6000-byte window) with a distinctive site deep inside. */
export const BIG_SRC = (() => {
  const out: string[] = ["// big fixture module", "export const TABLE: number[] = [];"];
  for (let i = 0; i < 400; i++) out.push(`export function filler${i}(n: number): number { return n + ${i}; } // padding line ${i}`);
  out.push("export function deepSite(n: number): number {", "  const deepMarker = n * 3;", "  return deepMarker + 7;", "}");
  for (let i = 400; i < 520; i++) out.push(`export function filler${i}(n: number): number { return n - ${i}; } // padding line ${i}`);
  return out.join("\n") + "\n";
})();
export const CHECK_SRC = [
  'import { describe, it, expect } from "bun:test";',
  'import { compute } from "../src/compute.js";',
  'import { scale } from "../src/helper.js";',
  "",
  "describe(\"compute\", () => {",
  "  it(\"adds two to the scaled value\", () => {",
  "    expect(compute(1)).toBe(scale(1) + 2);",
  "  });",
  "  it(\"is pure\", () => {",
  "    expect(compute(2)).toBe(compute(2));",
  "  });",
  "});",
  "",
].join("\n");
/** A synthetic seed template (src/seed/) with one task, for the seed-delivery verify rule (seed_edit plans; no corpus
 *  fixture uses it). */
export const SEED_T = `repos/${VESSEL}/src/seed/demo-sweep-tick.ts`;
/** A new seed file the seed_new plans create. */
export const SEED_NEW_T = `repos/${VESSEL}/src/seed/demo-audit-tick.ts`;
export const SEED_CONFIG_LINE = '      config: { type: "demo_sweep", staleHours: 48, autoClose: true },';
export const SEED_TICK_SRC = [
  'import type { ActivityTemplate } from "@avigopal/ias-executor-ts";',
  "",
  "export const DEMO_SWEEP_TICK_TEMPLATE: ActivityTemplate = {",
  '  id: "demo-vessel:demo-sweep-tick",',
  '  name: "demo-sweep-tick",',
  '  description: "Runs demo_sweep over the fixture store.",',
  "  inputShapes: [],",
  '  outputShapes: ["demoSweepReport"],',
  '  tags: ["demo"],',
  "  variables: [],",
  "  tasks: [",
  "    {",
  '      id: "run_demo_sweep",',
  '      description: "Run demo_sweep with auto-close enabled.",',
  '      resolver: "demo_sweep",',
  SEED_CONFIG_LINE,
  '      outputShapes: ["demoSweepReport"],',
  "    },",
  "  ],",
  "};",
  "",
].join("\n");
const LESSONS_JSONL = [
  { at: "2026-10-01T00:00:00.000Z", class: "anchor_not_found", reason: "old_string was not in the file" },
  { at: "2026-10-01T00:01:00.000Z", class: "verify_failed", reason: "tsc failed: TS2304 Cannot find name 'scal'" },
  { at: "2026-10-01T00:02:00.000Z", class: "anchor_not_found", reason: "anchor reconstructed from memory" },
  { at: "2026-10-01T00:03:00.000Z", class: "semantic_reject", reason: "the diff did not change the value the gap named" },
].map((r) => JSON.stringify(r)).join("\n") + "\n";
const FILE_LESSONS_JSONL = [
  { at: "2026-10-01T00:00:00.000Z", files: [`repos/${VESSEL}/src/compute.ts`], tsc: "src/compute.ts(5,10): error TS2304: Cannot find name 'scal'." },
  { at: "2026-10-01T00:05:00.000Z", files: [`repos/${VESSEL}/src/compute.ts`], tsc: "a landing on compute.ts later broke compute.test.ts", kind: "attempt_consequence" },
  { at: "2026-10-01T00:06:00.000Z", files: ["repos/other-vessel/src/x.ts"], tsc: "unrelated" },
].map((r) => JSON.stringify(r)).join("\n") + "\n";

// ── node:fs wrapper ──────────────────────────────────────────────────────────────────────────────────────────
const ORIG_S: Record<string, any> = { ...realFs };
const ORIG_P: Record<string, any> = { ...realFsp };
const OVERLAY = new Map<string, string>([[COMPOSE_LESSONS, LESSONS_JSONL], [COMPOSE_FILE_LESSONS, FILE_LESSONS_JSONL]]);
function insideTmp(p: string): boolean {
  for (const t of new Set([tmpdir(), (() => { try { return realFs.realpathSync(tmpdir()); } catch { return tmpdir(); } })()])) {
    const r = relative(t, p);
    if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) return true;
  }
  return false;
}
const toPath = (p: unknown): string | null => (typeof p === "string" ? p : p instanceof URL ? p.pathname : null);

/** The ordered gate events of the current run (not part of a recording): "decompose", "verify", "own_check:parent",
 *  "own_check:draft", "judge", "refuter", and whatever a test marks (the cutover stand-in, the scope floor). */
export const events: string[] = [];
export const markEvent = (e: string): void => { events.push(e); };

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────
export function createHarness(ROOT: string, RUNTIME: string) {
  let execGuard: ExecGuard | null = null;
  const CLONES = join(ROOT, "clones");
  const norm = (s: string): string => s
    .split(RUNTIME).join("<RUNTIME>")
    .split(CLONES).join("<CLONES>")
    .split(ROOT).join("<ROOT>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ISO>")
    .replace(/\b1[6-9]\d{11}\b/g, "<MS>")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<DUR>")
    .replace(/https?:\/\/(?!(?:tools|llm|pool|gap-store)\.drafter-split)[^/\s'"`]+/g, "<EXT>")
    .replace(/\bfc-[a-z0-9]{6,}-[a-z0-9]{4,}\b/g, "fc-<ID>")
    // The child-env prefix's redirect list (src/test-child-env.ts testChildEnvShellPrefix) is built from a walk of
    // src in readdir order, which differs between filesystems: the same set came out in another order on the gate's
    // tree than where the corpus was recorded. Sorted here, so the recording pins the set, not the walk order.
    .replace(/env -S " ([^"]*)"/g, (_m, list: string) => `env -S " ${list.trim().split(/\s+/).sort().join(" ")}"`);
  let rec: Recording;
  let fx: Fixture;
  let storeRows: Row[] = [];
  let snapshots = new Map<string, string>();
  let active = false;
  let originalFetch: typeof fetch = globalThis.fetch;
  const ORIGINAL = { log: console.log, warn: console.warn, error: console.error, random: Math.random };

  function installFs(): void {
    const check = (op: string, target: unknown): void => {
      const abs = toPath(target);
      if (abs === null || insideTmp(abs)) return;
      if (rec) rec.fs_writes.push(norm(`${op} ${abs}`));
      const err = new Error(`drafter-split fs guard: ${op} outside the test tmpdir: ${abs}`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    const targets: Record<string, (a: unknown[]) => unknown[]> = {
      writeFile: (a) => [a[0]], appendFile: (a) => [a[0]], mkdir: (a) => [a[0]], rename: (a) => [a[1]], copyFile: (a) => [a[1]],
      rm: (a) => [a[0]], unlink: (a) => [a[0]], truncate: (a) => [a[0]], symlink: (a) => [a[1]],
    };
    const P: Record<string, any> = { ...ORIG_P };
    const S: Record<string, any> = { ...ORIG_S };
    for (const [name, pick] of Object.entries(targets)) {
      if (typeof ORIG_P[name] === "function") P[name] = async (...a: unknown[]) => { for (const t of pick(a)) check(`fs/promises.${name}`, t); return ORIG_P[name](...a); };
      if (typeof ORIG_S[name] === "function") S[name] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${name}`, t); return ORIG_S[name](...a); };
      const sync = `${name}Sync`;
      if (typeof ORIG_S[sync] === "function") S[sync] = (...a: unknown[]) => { for (const t of pick(a)) check(`fs.${sync}`, t); return ORIG_S[sync](...a); };
    }
    P["readFile"] = async (...a: unknown[]) => { const k = toPath(a[0]); if (k && OVERLAY.has(k)) return OVERLAY.get(k); return ORIG_P["readFile"](...a); };
    S["readFileSync"] = (...a: unknown[]) => { const k = toPath(a[0]); if (k && OVERLAY.has(k)) return OVERLAY.get(k); return ORIG_S["readFileSync"](...a); };
    S["existsSync"] = (...a: unknown[]) => { const k = toPath(a[0]); if (k && OVERLAY.has(k)) return true; return ORIG_S["existsSync"](...a); };
    P["default"] = P; S["promises"] = P; S["default"] = S;
    mock.module("node:fs/promises", () => P);
    mock.module("node:fs", () => S);
  }

  function listing(vessel: string): string {
    const base = join(RUNTIME, vessel);
    const out: string[] = [];
    const walk = (d: string): void => {
      let ents: realFs.Dirent[] = [];
      try { ents = realFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(relative(base, p));
      }
    };
    walk(join(base, "src"));
    for (const f of ["tsconfig.json", "package.json", "esbuild.config.mjs"]) if (realFs.existsSync(join(base, f))) out.push(f);
    return [...new Set(out)].sort().slice(0, 400).join("\n");
  }
  /** grep -rnE <pattern> src (declarations); POSIX classes mapped to JS. */
  function grep(vessel: string, pattern: string, after: number): string {
    let re: RegExp;
    try { re = new RegExp(pattern.replace(/\[\[:space:\]\]/g, "\\s").replace(/\\b/g, "\\b")); } catch { return ""; }
    const base = join(RUNTIME, vessel);
    const lines: string[] = [];
    for (const rel of listing(vessel).split("\n").filter((f) => f.startsWith("src/") && !f.endsWith(".test.ts"))) {
      let text = "";
      try { text = realFs.readFileSync(join(base, rel), "utf8"); } catch { continue; }
      const ls = text.split("\n");
      ls.forEach((l, i) => {
        if (!re.test(l)) return;
        lines.push(`${rel}:${i + 1}:${l}`);
        for (let k = 1; k <= after && i + k < ls.length; k++) lines.push(`${rel}-${i + 1 + k}-${ls[i + k]}`);
      });
    }
    return lines.join("\n");
  }
  function vesselOf(command: string): string {
    for (const v of [VESSEL, OTHER]) if (command.includes(`/${v}'`) || command.includes(`/${v}"`) || command.includes(`/${v} `) || command.includes(`/${v}/`)) return v;
    const m = new RegExp(`${RUNTIME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([\\w.-]+)`).exec(command);
    return m?.[1] ?? VESSEL;
  }
  function anyFileHas(vessel: string, marker: string): boolean {
    for (const rel of listing(vessel).split("\n")) {
      try { if (realFs.readFileSync(join(RUNTIME, vessel, rel), "utf8").includes(marker)) return true; } catch { /* skip */ }
    }
    return false;
  }
  function lineDiff(label: string, before: string, after: string): string {
    const a = before.split("\n"), b = after.split("\n");
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const del = a.slice(p, a.length - s), add = b.slice(p, b.length - s);
    if (del.length === 0 && add.length === 0) return "";
    return [`--- a/${label}`, `+++ b/${label}`, `@@ -${p + 1},${del.length} +${p + 1},${add.length} @@`, ...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`), ""].join("\n");
  }
  function planOps(): Row[] {
    const T = `repos/${VESSEL}/src/compute.ts`;
    const edit = (old_string: string, new_string: string, path = T) => ({ kind: "edit", path, old_string, new_string, rationale: "fixture" });
    switch (fx.plan) {
      case "pass": return [edit("  return base + 1;", "  return base + 2;")];
      case "verify_red": return [edit("  return base + 1;", "  return base + VERIFY_RED_MARKER;")];
      case "non_unique": return [edit("compute(x)", "compute(x + 0)")];
      case "off_target": return [edit("  return x * 2;", "  return x * 3;", `repos/${VESSEL}/src/helper.ts`)];
      case "create": return [{ kind: "create_file", path: `repos/${VESSEL}/src/fresh.ts`, content: "export const FRESH = 1;\n", rationale: "fixture" }];
      case "no_ops": return [];
      case "drafter_edit": return [edit("export const DRAFTER_FIXTURE = 1;", "export const DRAFTER_FIXTURE = 2;", "repos/development-vessel/src/drafter/index.ts")];
      case "seed_edit": return [edit(SEED_CONFIG_LINE, SEED_CONFIG_LINE.replace("autoClose: true }", "autoClose: true, auditOnly: true }"), SEED_T)];
      case "seed_new":
      case "seed_new_versioned": return [{
        kind: "create_file", path: SEED_NEW_T, rationale: "fixture",
        content: SEED_TICK_SRC.replace("DEMO_SWEEP_TICK_TEMPLATE", "DEMO_AUDIT_TICK_TEMPLATE").replace(/demo-sweep-tick/g, "demo-audit-tick")
          .replace('  tags: ["demo"],', fx.plan === "seed_new_versioned" ? '  tags: ["demo"],\n  metadata: { seed_version: 1 },' : '  tags: ["demo"],'),
      }];
      case "seed_edit_bumped": return [
        edit(SEED_CONFIG_LINE, SEED_CONFIG_LINE.replace("autoClose: true }", "autoClose: true, auditOnly: true }"), SEED_T),
        edit('  tags: ["demo"],', '  tags: ["demo"],\n  metadata: { seed_version: 1 },', SEED_T),
      ];
    }
  }

  async function router(input: unknown, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Row = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
    const ptr = (body?.impulse?.pointer ?? body?.pointer ?? body?.impulse ?? {}) as Row;
    const type = String(ptr.type ?? "");
    const tag = (extra = "") => rec.fetches.push(norm(`${url} ${type}${extra}`).slice(0, 240));
    if (url === TOOLS) {
      const command = typeof ptr.command === "string" ? ptr.command : "";
      tag(` ${type === "shell" ? command : String(ptr.path ?? "")}`);
      if (type === "fs_read") {
        try { return Response.json({ content: await Bun.file(String(ptr.path)).text() }); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
      }
      if (type === "fs_edit") {
        const path = String(ptr.path);
        let cur = "";
        try { cur = await realFsp.readFile(path, "utf8"); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
        const o = String(ptr.old_string ?? "");
        if (!path.startsWith(ROOT) || !o || cur.split(o).length !== 2) return Response.json({ error: "old_string not unique" }, { status: 400 });
        rec.applied.push(norm(`edit ${path}`));
        await ORIG_P["writeFile"](path, cur.replace(o, () => String(ptr.new_string ?? "")));
        return Response.json({ ok: true });
      }
      if (type === "fs_write") {
        const path = String(ptr.path);
        if (path.startsWith(ROOT)) { rec.applied.push(norm(`write ${path}`)); await ORIG_P["mkdir"](dirname(path), { recursive: true }); await ORIG_P["writeFile"](path, String(ptr.content ?? "")); }
        else snapshots.set(path, String(ptr.content ?? ""));
        return Response.json({ ok: true });
      }
      if (type === "shell") {
        const v = vesselOf(command);
        if (command.startsWith("diff -u")) {
          for (const [tmp, orig] of snapshots) {
            if (!command.includes(tmp)) continue;
            const abs = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]!).find((x) => x.startsWith(ROOT)) ?? "";
            let cur = ""; try { cur = await realFsp.readFile(abs, "utf8"); } catch { /* gone */ }
            snapshots.delete(tmp);
            return Response.json({ stdout: lineDiff(abs.replace(/^.*?\/(?=demo-vessel\/)/, ""), orig, cur) });
          }
          return Response.json({ stdout: "" });
        }
        if (command.includes("== typecheck ==")) {
          events.push("verify");
          const red = anyFileHas(v, "VERIFY_RED_MARKER");
          return Response.json({ stdout: `== install ==\n== resolve ==\nDRYRUN_EXIT=0\n== typecheck ==\n${red ? "src/compute.ts(5,17): error TS2304: Cannot find name 'VERIFY_RED_MARKER'.\nTC_EXIT=2" : "TC_EXIT=0"}\n== shape-dispatch ==\nSD_EXIT=0\n== tests ==\n${red ? "SKIPPED_TYPECHECK_FAILED" : "(pass) fixture > ok\n 1 pass\n 0 fail"}\n` });
        }
        if (/bun test '\.\/test\//.test(command)) {
          const parent = command.includes("worktree add");
          events.push(parent ? "own_check:parent" : "own_check:draft");
          return Response.json({ stdout: parent ? "(fail) compute > adds two to the scaled value\n(pass) compute > is pure\n 1 pass\n 1 fail\n" : "(pass) compute > adds two to the scaled value\n(pass) compute > is pure\n 2 pass\n 0 fail\n" });
        }
        if (command.includes("bun test")) return Response.json({ stdout: "(pass) fixture > ok\n 1 pass\n 0 fail\nSUITE_RC=0\n" });
        if (command.includes("find src")) return Response.json({ stdout: listing(v) });
        if (/^test -d '\/workspace\/git\/vessels\//.test(command)) return Response.json({ stdout: "yes\n" });
        if (command.includes("rev-parse HEAD")) return Response.json({ stdout: "0123456789abcdef0123456789abcdef01234567\n" });
        if (command.startsWith("cat ")) {
          const abs = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]!)[0] ?? "";
          try { return Response.json({ stdout: await realFsp.readFile(abs, "utf8") }); } catch { return Response.json({ stdout: "" }); }
        }
        if (command.startsWith("grep -rEn")) return Response.json({ stdout: `${RUNTIME}/${VESSEL}/src/index.ts:3:  compute(1);\n` });
        const g = /grep -rnE(?: -A(\d+))? '([^']+)' src/.exec(command);
        if (g) return Response.json({ stdout: grep(v, g[2]!, Number(g[1] ?? 0)).split("\n").slice(0, g[1] ? 4 : 1).join("\n") });
      }
      return Response.json({ stdout: "" });
    }
    if (url === LLM) {
      const prompt = String(body?.prompt ?? "");
      const kind = prompt.includes("decomposing a feature specification") ? "decompose"
        : prompt.startsWith("You are a spec editor") ? "refine"
        : prompt.includes("ADVERSARIAL reviewer") ? "refuter"
        : prompt.includes("addresses") ? "judge" : "other";
      rec.prompts.push({ kind, sha256: createHash("sha256").update(norm(prompt)).digest("hex"), bytes: Buffer.byteLength(norm(prompt)) });
      tag(` ${kind}`);
      events.push(kind);
      if (kind === "decompose") {
        if (!rec.decompose_prompt) rec.decompose_prompt = norm(prompt);
        const ops = planOps();
        const touched = [...new Set(ops.map((o) => String(o.path).split("/").slice(0, 2).join("/")))];
        return Response.json({ content: JSON.stringify({ summary: "fixture plan", touched_vessels: touched.length ? touched : [`repos/${VESSEL}`], ops }) });
      }
      if (kind === "refine") return Response.json({ content: "short" });
      if (kind === "refuter") return Response.json({ content: JSON.stringify({ refuted: false, confidence: 0.1, reason: "no refutation" }) });
      if (kind === "judge") return Response.json({ content: JSON.stringify({ addresses: true, on_live_path: true, reason: "fixture judge: the change addresses the gap" }) });
      return new Response("unavailable (fixture)", { status: 400 });
    }
    if (body?.pointer?.type === "vesselCapability") {
      const shape = String(body.pointer.shape ?? "");
      tag(` ${shape}`);
      if (shape === "shellResult") return Response.json({ content: { vessels: [{ endpoint: "http://tools.drafter-split", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.drafter-split", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (shape === "poolImpulse") return Response.json({ content: { vessels: [{ vesselId: "development-vessel-local", endpoint: POOL, resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url.startsWith(POOL)) {
      tag(` ${String(body?.impulse?.shape ?? "")}`);
      if (body?.impulse?.type === "poolImpulse" && body.impulse.shape === "autonomyScope" && fx.scope) {
        return Response.json({ body: { impulses: [{ shape: "autonomyScope", updated_at: "2026-10-01T00:00:00.000Z", body: { excluded_paths: fx.scope } }] } });
      }
      const shape = String(body?.impulse?.shape ?? "");
      if (body?.impulse?.type === "poolImpulse" && fx.pool && fx.pool[shape]) {
        return Response.json({ body: { impulses: [{ shape, updated_at: "2026-10-01T00:00:00.000Z", body: fx.pool[shape] }] } });
      }
      return Response.json({ body: { impulses: [] } });
    }
    if (url === STORE) {
      const p = (body?.impulse?.pointer ?? {}) as Row;
      const t = String(p.type ?? "");
      if (t === "substrateGap") {
        tag(` read ${String(p.id ?? "")}`);
        const rows = storeRows.filter((r) => p.id === undefined || r.id === p.id).map((r) => structuredClone(r));
        return Response.json({ shape: "substrateGap", body: { gaps: rows } });
      }
      if (t === "substrateGap_write") {
        const g = (p.gap ?? {}) as Row;
        tag(` write ${String(g.id ?? "")}`);
        rec.gap_writes.push(norm(JSON.stringify(g)));
        const i = storeRows.findIndex((r) => r.id === g.id);
        if (i >= 0) {
          const cur = storeRows[i]!;
          storeRows[i] = { ...cur, ...g, classification_metadata: { ...(cur.classification_metadata ?? {}), ...(g.classification_metadata ?? {}) } };
          return Response.json({ shape: "substrateGapWriteResult", body: { action: "updated", id: g.id } });
        }
        return Response.json({ shape: "substrateGapWriteResult", body: { action: "noop" } });
      }
      tag(` ${t}`);
      if (t === "substrateGapLease_write") {
        return Response.json({ shape: "substrateGapLease", body: { action: String(p.action ?? "acquire"), gap_id: String(p.gap_id ?? ""), granted: true, held_by: String(p.holder ?? "drafter-split"), until: "2026-10-01T01:00:00.000Z" } });
      }
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "noop" } });
    }
    tag(" UNROUTED");
    return new Response("unrouted (drafter-split fixture)", { status: 400 });
  }

  function seedRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  async function writeTree(): Promise<void> {
    await ORIG_P["rm"](RUNTIME, { recursive: true, force: true });
    await ORIG_P["rm"](CLONES, { recursive: true, force: true });
    const files: Record<string, string> = {
      [`${VESSEL}/package.json`]: "{\"name\":\"demo-vessel\",\"type\":\"module\"}\n",
      [`${VESSEL}/src/compute.ts`]: COMPUTE_SRC,
      [`${VESSEL}/src/helper.ts`]: HELPER_SRC,
      [`${VESSEL}/src/config.ts`]: 'export const discovery = { shapes: ["computeReport"] };\n',
      [`${OTHER}/src/config.ts`]: 'export const discovery = { shapes: ["helperReport"] };\n',
      ...(fx.files ?? {}),
    };
    for (const [rel, text] of Object.entries(files)) {
      await ORIG_P["mkdir"](dirname(join(RUNTIME, rel)), { recursive: true });
      await ORIG_P["writeFile"](join(RUNTIME, rel), text);
    }
    for (const [rel, text] of Object.entries(fx.clone ?? {})) {
      await ORIG_P["mkdir"](dirname(join(CLONES, rel)), { recursive: true });
      await ORIG_P["writeFile"](join(CLONES, rel), text);
    }
  }

  // LEARNED STATE, ISOLATED IN PROCESS (INTERIM: the env-sweep row owns the src reads). The compose path is a
  // learned-state writer, so each run goes through test/resolvers/isolated-gap-store-run.ts
  // isolateLearnedStateInProcess, the shared in-process helper (the class detector in
  // test/resolvers/learned-state-isolation-sites.test.ts requires it): every learned-state default src names, and
  // WORKSPACE_ROOT, points under the OS temp dir, and a redirect the gate's scrubbed_env already put there is kept. So
  // the compose's report dir (feature-compose.ts PROPOSALS_DIR), the credit tables and the authoring-inflight marker
  // all land inside the fs guard's tmpdir, unrecorded, in a plain shell and under the gate's scrubbed_env alike. The
  // helper's values are restored after the run.
  const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "VESSEL_CLONE_ROOT", "VESSELS_CLONE_ROOT", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR", "SEMANTIC_CUTOVER_GATE", "WORKSPACE_ROOT"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  return {
    norm,
    /** Install the node:fs wrapper (once per file). */
    install(): void {
      if (active) return;
      active = true;
      // The golden observes compose outcomes and routed writes. This separate filesystem audit is covered by
      // gap-write-events.test.ts; disable it here because substrate-gap may have captured WORKSPACE_ROOT before
      // this fixture's isolation and its append would otherwise escape the fixture under multi-file Bun runs.
      __setGapWriteEventsEnabledForTests(false);
      installFs();
      // The compose's attempt checks read the target unit's LoadState (attempt-checks.ts systemd_units). Never the
      // host's systemctl (the node gate runs this inside the live container): answered as a host with no systemd, so
      // that check reads unknown wherever the suite runs.
      execGuard = installCutoverExecGuard();
      execGuard.route({ name: "attempt-check-unit", match: (c) => /systemctl show \S+ -p LoadState --value/.test(c), respond: () => ({ exitCode: 1, stdout: "" }) });
    },
    /** Put node:fs, fetch, console and Math.random back. */
    restore(): void {
      if (!active) return;
      active = false;
      __setGapWriteEventsEnabledForTests(true);
      mock.module("node:fs/promises", () => ORIG_P);
      mock.module("node:fs", () => ORIG_S);
      const unrouted = execGuard?.restore() ?? [];
      execGuard = null;
      if (unrouted.length > 0) throw new Error(`drafter-split harness: blocked host spawn(s) with no route: ${unrouted.join("; ")}`);
    },
    /** Run one fixture through `fc.resolveFeatureCompose` and return its recording. */
    async run(fc: { resolveFeatureCompose: (p: unknown) => Promise<{ body: Row }> }, fixture: Fixture, onBody?: (body: Row) => void): Promise<Recording> {
      fx = fixture;
      events.length = 0;
      rec = { name: fixture.name, verdict: null, stage: null, ok: null, error: "", ops: [], applied: [], prompts: [], decompose_prompt: "", fetches: [], gap_writes: [], fs_writes: [], console: [] };
      storeRows = structuredClone(fixture.store ?? []);
      snapshots = new Map();
      await writeTree();
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
      const ws = join(ROOT, "ws");
      process.env["MITOSIS_PUSH_CLONE_DIR"] = CLONES;
      process.env["VESSEL_CLONE_ROOT"] = CLONES;
      process.env["VESSELS_CLONE_ROOT"] = CLONES;
      process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
      process.env["GAP_STORE_ENDPOINT"] = STORE;
      process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
      process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
      delete process.env["SEMANTIC_CUTOVER_GATE"];
      const beforeIsolation: Record<string, string | undefined> = { ...process.env };
      const isolated = Object.keys(isolateLearnedStateInProcess(join(ws, "learned")));
      originalFetch = globalThis.fetch;
      const sink = (...a: unknown[]) => { rec.console.push(norm(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" "))); };
      console.log = sink; console.warn = sink; console.error = sink;
      Math.random = seedRandom(7);
      globalThis.fetch = router as unknown as typeof fetch;
      try {
        const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
        __resetPolicyReadsForTests();
        // ORDER-INDEPENDENT CAPACITY READ (INTERIM). compose-slots.ts caches the composeCapacity record for 30 s per
        // process (COMPOSE_CAPACITY_TTL_MS), and __resetPolicyReadsForTests does not clear it: the read showed only
        // when a fixture was the first compose of a cold process, so the recording depended on what ran before it.
        // Clearing it per run (the null reader is the module's own) makes every fixture read it, in any order.
        const { __setComposeCapacityReaderForTests } = await import("../../src/compose-slots.js");
        __setComposeCapacityReaderForTests(null);
        const r = await fc.resolveFeatureCompose({ type: "feature_compose", ...fixture.pointer });
        const b = (r?.body ?? {}) as Row;
        onBody?.(b);
        rec.verdict = b.verdict ?? null;
        rec.stage = b.stage ?? null;
        rec.ok = b.ok ?? null;
        rec.error = norm(String(b.error ?? "")).slice(0, 600);
        const ops = Array.isArray(b.ops) ? b.ops : Array.isArray(b.plan?.ops) ? b.plan.ops : [];
        rec.ops = (ops as Row[]).map((o) => ({ kind: o?.kind ?? null, path: o?.path ?? null, old: norm(String(o?.old_string ?? "")).slice(0, 80) }));
      } finally {
        globalThis.fetch = originalFetch;
        console.log = ORIGINAL.log; console.warn = ORIGINAL.warn; console.error = ORIGINAL.error;
        Math.random = ORIGINAL.random;
        for (const k of isolated) { if (beforeIsolation[k] === undefined) delete process.env[k]; else process.env[k] = beforeIsolation[k]; }
        for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
        await ORIG_P["rm"](ws, { recursive: true, force: true });
      }
      return rec;
    },
  };
}

// ── the corpus ───────────────────────────────────────────────────────────────────────────────────────────────
const T = `repos/${VESSEL}/src/compute.ts`;
const gapRow = (id: string, meta: Row, extra: Row = {}): Row => ({ id, status: "open", category: "code_quality", summary: `compute in ${T} adds 1; it must add 2`, classification_metadata: meta, ...extra });
const basePointer = (gapId: string, extra: Row = {}): Row => ({
  spec: `In ${T}, compute must add 2, not 1.`,
  verify_vessels: [`repos/${VESSEL}`],
  land: false,
  skip_push: true,
  directed: true,
  gap: { id: gapId, summary: `compute in ${T} adds 1; it must add 2` },
  ...extra,
});
const OWN_CHECK_META = { edit_site: T, evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: "test/compute.test.ts", only_tests: ["compute > adds two to the scaled value"] } } };
const PRIOR_LESSONS = [
  { at: "2026-09-30T10:00:00.000Z", class: "anchor_not_found", reason: "old_string not found in compute.ts", stage: "apply", edited_spans: [], own_check: { test_file: "test/compute.test.ts", failing: [{ name: "compute > adds two to the scaled value", expected: "Expected: 4", received: "Received: 3" }] } },
  { at: "2026-09-30T11:00:00.000Z", class: "semantic_reject", reason: "the new helper `bumpBase` is never called", stage: "semantic", edited_spans: [{ path: T, start: 4, end: 5, base: "x", text_sha: "y" }], no_effect_vs_parent: true, constraints: [{ kind: "must_be_called", symbol: "bumpBase", introduced_in: T }] },
];

export const CORPUS: Fixture[] = [
  { name: "directed / pass / no region / no own check", pointer: basePointer("ds-1"), plan: "pass", store: [gapRow("ds-1", { edit_site: T })] },
  { name: "directed / verify red", pointer: basePointer("ds-2"), plan: "verify_red", store: [gapRow("ds-2", { edit_site: T })] },
  { name: "directed / non-unique anchor", pointer: basePointer("ds-3"), plan: "non_unique", store: [gapRow("ds-3", { edit_site: T })] },
  { name: "directed / off-target edit", pointer: basePointer("ds-4"), plan: "off_target", store: [gapRow("ds-4", { edit_site: T })] },
  { name: "directed / no ops", pointer: basePointer("ds-5"), plan: "no_ops", store: [gapRow("ds-5", { edit_site: T })] },
  { name: "undirected / pass (scope readable, compute open)", pointer: basePointer("ds-6", { directed: false }), plan: "pass", store: [gapRow("ds-6", { edit_site: T })], scope: [`repos/${VESSEL}/src/config.ts`] },
  { name: "undirected / pass (scope excludes the target)", pointer: basePointer("ds-7", { directed: false }), plan: "pass", store: [gapRow("ds-7", { edit_site: T })], scope: [T] },
  { name: "directed / region named, max_ops unset", pointer: basePointer("ds-8"), plan: "pass", store: [gapRow("ds-8", { edit_site: T, region: "return base + 1" })] },
  { name: "directed / region named, max_ops 2", pointer: basePointer("ds-9", { max_ops: 2 }), plan: "pass", store: [gapRow("ds-9", { edit_site: T, region: "return base + 1" })] },
  { name: "directed / max_ops 1", pointer: basePointer("ds-10", { max_ops: 1 }), plan: "pass", store: [gapRow("ds-10", { edit_site: T })] },
  {
    name: "undirected / own check present, helper excluded (read-only import)",
    pointer: basePointer("ds-11", { directed: false }), plan: "pass",
    store: [gapRow("ds-11", OWN_CHECK_META)],
    clone: { [`${VESSEL}/test/compute.test.ts`]: CHECK_SRC, [`${VESSEL}/src/compute.ts`]: COMPUTE_SRC, [`${VESSEL}/src/helper.ts`]: HELPER_SRC },
    scope: [`repos/${VESSEL}/src/helper.ts`],
  },
  {
    name: "directed / own check present, imports added as targets",
    pointer: basePointer("ds-12"), plan: "pass",
    store: [gapRow("ds-12", OWN_CHECK_META)],
    clone: { [`${VESSEL}/test/compute.test.ts`]: CHECK_SRC, [`${VESSEL}/src/compute.ts`]: COMPUTE_SRC, [`${VESSEL}/src/helper.ts`]: HELPER_SRC },
  },
  {
    name: "directed / prior attempt history (own lessons, gate reason, landed sha, literal criterion)",
    pointer: basePointer("ds-13"), plan: "pass",
    store: [gapRow("ds-13", { edit_site: T, failure_lessons: PRIOR_LESSONS, semantic_gate_reason: "compute still adds 1", suspected_real_location: `${T}:5`, pending_outcome_verification: "abcdef1234567", verify_failure_reason: "TS2304 at compute.ts:5", expected_literal: "base + 2", hardcoded_url: "base + 1" })],
  },
  {
    name: "directed / ancestor lessons (source gap carries refused regions and a must_be_called constraint)",
    pointer: basePointer("ds-14"), plan: "pass",
    store: [gapRow("ds-14", { edit_site: T, source_gap_id: "ds-14-src" }), gapRow("ds-14-src", { edit_site: T, failure_lessons: PRIOR_LESSONS, evidence_resolve: { shape: "computeReport", input: { x: 1 } } })],
  },
  {
    name: "directed / decomposed step with a parent check",
    pointer: basePointer("ds-15-step-1"), plan: "pass",
    store: [gapRow("ds-15-step-1", { edit_site: T, parent_gap_id: "ds-15", predicate_source: "decompose" }), gapRow("ds-15", { edit_site: T, verify_shape: "computeReport", failure_lessons: PRIOR_LESSONS })],
  },
  {
    name: "directed / large target, explicit line hint",
    pointer: { ...basePointer("ds-16"), spec: `In repos/${VESSEL}/src/big.ts, deepSite must add 8 (see ~l.405-406).` }, plan: "pass",
    files: { [`${VESSEL}/src/big.ts`]: BIG_SRC },
    store: [gapRow("ds-16", { edit_site: `repos/${VESSEL}/src/big.ts` }, { summary: `deepSite in repos/${VESSEL}/src/big.ts adds 7 (~l.405-406)` })],
  },
  {
    name: "directed / large target, mined probe (no line hint)",
    pointer: { ...basePointer("ds-17"), spec: "In repos/demo-vessel/src/big.ts, `deepMarker` must be multiplied by 4 instead of 3 in deepSite." }, plan: "pass",
    files: { [`${VESSEL}/src/big.ts`]: BIG_SRC },
    store: [gapRow("ds-17", { edit_site: `repos/${VESSEL}/src/big.ts` })],
  },
  {
    name: "directed / net-new create target",
    pointer: { ...basePointer("ds-18"), spec: `Create repos/${VESSEL}/src/fresh.ts exporting FRESH = 1.` }, plan: "create",
    store: [gapRow("ds-18", { edit_site: `repos/${VESSEL}/src/fresh.ts` })],
  },
  {
    name: "directed / a named symbol declared in another file (cross-file grounding)",
    pointer: { ...basePointer("ds-19"), spec: `In ${T}, compute must call twiceScale (declared in repos/${VESSEL}/src/extra.ts) instead of scale.` }, plan: "pass",
    files: { [`${VESSEL}/src/extra.ts`]: "export interface ScaleOpts { factor: number }\nexport function twiceScale(\n  x: number,\n  opts: ScaleOpts,\n): number {\n  return x * opts.factor * 2;\n}\n" },
    store: [gapRow("ds-19", { edit_site: T })],
  },
  {
    name: "directed / two verify vessels, second vessel's files in the window",
    pointer: basePointer("ds-20", { verify_vessels: [`repos/${VESSEL}`, `repos/${OTHER}`] }), plan: "pass",
    store: [gapRow("ds-20", { edit_site: T })],
  },
  {
    name: "directed / spec long enough to be refined",
    pointer: { ...basePointer("ds-21"), spec: `In ${T}, compute must add 2, not 1. ` + "The change must keep the helper import and the guard regex untouched. ".repeat(60) }, plan: "pass",
    store: [gapRow("ds-21", { edit_site: T })],
  },
];
