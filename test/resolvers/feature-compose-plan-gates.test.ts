// THE PLAN GATES REFUSE WHEN THEY BREAK, AND REFUSE WHAT THEY EXIST TO CATCH (protected must-fail).
//
// Before any op is applied, resolveFeatureComposeInner (src/resolvers/feature-compose.ts) judges the drafter's plan
// with three helpers from src/vacuous-edit.ts: nonTerminatingEditReason and deadStoreEditReason (each op simulated
// against the target file) and vacuousEditReason (every edit op vacuous => refuse). Both blocks were wrapped in a
// catch that ADMITTED the plan on any throw ("a gate must never break convergence"), so a gate that broke was a gate
// that was off.
//
// Expected:
//   - a helper that THROWS refuses the plan (verdict REFUSED, the error names the plan gate) and nothing is applied
//     (no fs_edit / fs_write reaches the tools); one row per helper, the throw induced by re-binding that one export
//     of vacuous-edit.ts with mock.module (Bun re-binds the module's internal references too, so the row also pins
//     WHICH block refused), restored to the captured originals after every test;
//   - CONTROL: with no helper throwing, a plan with a real change is admitted and reaches the applier;
//   - the gates still refuse what they exist to catch: a self-call that cannot terminate, a dead store, a type-only
//     (vacuous) plan, each REFUSED with nothing applied.
//
// No LLM (fixture planner on a stubbed fetch), no network, no host process (the tools shell is a recorder that never
// runs a command), all writes under this file's temp root.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-plan-gates", { superRepo: true, who: "feature-compose-plan-gates.test.ts" });

const VESSEL = "demo-vessel";
const TARGET = "src/compute.ts";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR", "VESSEL_CLONE_ROOT"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let logs: string[] = [];
let planOps: Array<Record<string, unknown>> = [];
let calls: Array<{ type: string; command?: string; path?: string }> = [];
const snapshots = new Map<string, string>();

const TARGET_SRC = [
  "export function compute(x: number): number {",
  "  const base = x * 2;",
  "  return base + 1;",
  "}",
  "export function pick(pool: number[]): number {",
  "  const best = pool[0];",
  "  return best ?? 0;",
  "}",
  "export function tally(xs: number[]): number {",
  "  let n = 0;",
  "  n = xs.length;",
  "  return n;",
  "}",
  "",
].join("\n");

function lineDiff(label: string, before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const del = a.slice(p, a.length - s), add = b.slice(p, b.length - s);
  if (del.length === 0 && add.length === 0) return "";
  return [`--- a/${label}`, `+++ b/${label}`, `@@ -${p + 1},${del.length} +${p + 1},${add.length} @@`, ...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`), ""].join("\n");
}

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  await mkdir(join(RUNTIME, VESSEL, "src"), { recursive: true });
  await writeFile(join(RUNTIME, VESSEL, "package.json"), "{\"name\":\"demo-vessel\",\"type\":\"module\"}\n");
  await writeFile(join(RUNTIME, VESSEL, TARGET), TARGET_SRC);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["VESSEL_CLONE_ROOT"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  await mkdir(join(ws, "git", "vessels", VESSEL, "src"), { recursive: true });
  await writeFile(join(ws, "git", "vessels", VESSEL, TARGET), TARGET_SRC);
  logs = []; calls = []; snapshots.clear();
  const sink = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.log = sink; console.warn = sink; console.error = sink;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) {
      const p = body?.impulse?.pointer ?? {};
      const type = String(p.type ?? "");
      const command = typeof p.command === "string" ? p.command : "";
      calls.push({ type, command, path: typeof p.path === "string" ? p.path : undefined });
      if (type === "fs_read") {
        try { return Response.json({ content: await Bun.file(String(p.path)).text() }); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
      }
      if (type === "fs_edit") {
        const path = String(p.path);
        let cur = "";
        try { cur = await readFile(path, "utf8"); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
        const o = String(p.old_string ?? "");
        if (!path.startsWith(ROOT) || !o || cur.split(o).length !== 2) return Response.json({ error: "old_string not unique" }, { status: 400 });
        await writeFile(path, cur.replace(o, () => String(p.new_string ?? "")));
        return Response.json({ ok: true });
      }
      if (type === "fs_write") {
        const path = String(p.path);
        if (path.startsWith(ROOT)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, String(p.content ?? "")); }
        else snapshots.set(path, String(p.content ?? ""));
        return Response.json({ ok: true });
      }
      if (type === "shell") {
        if (command.startsWith("diff -u")) {
          for (const [tmp, orig] of snapshots) {
            if (!command.includes(tmp)) continue;
            const abs = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]!).find((x) => x.startsWith(ROOT)) ?? "";
            let cur = ""; try { cur = await readFile(abs, "utf8"); } catch { /* gone */ }
            snapshots.delete(tmp);
            return Response.json({ stdout: lineDiff(abs.replace(/^.*?\/(?=demo-vessel\/)/, ""), orig, cur) });
          }
          return Response.json({ stdout: "" });
        }
        if (command.includes("== typecheck ==")) return Response.json({ stdout: "== install ==\n== resolve ==\nDRYRUN_EXIT=0\n== typecheck ==\nTC_EXIT=0\n== shape-dispatch ==\nSD_EXIT=0\n== tests ==\n(pass) fixture > ok\n 1 pass\n 0 fail\n" });
        if (command.includes("find src")) return Response.json({ stdout: `${TARGET}\npackage.json\n` });
        if (command.startsWith("cat ")) {
          const abs = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]!)[0] ?? "";
          try { return Response.json({ stdout: await readFile(abs, "utf8") }); } catch { return Response.json({ stdout: "" }); }
        }
        if (command.startsWith("grep -rEn")) return Response.json({ stdout: `${RUNTIME}/${VESSEL}/src/index.ts:3:  compute(1);\n` });
      }
      return Response.json({ stdout: "" });
    }
    if (url === LLM) {
      const prompt = String(body?.prompt ?? "");
      if (prompt.includes("decomposing a feature specification")) {
        return Response.json({ content: JSON.stringify({ summary: "fixture plan", touched_vessels: [`repos/${VESSEL}`], ops: planOps }) });
      }
      if (prompt.includes("ADVERSARIAL reviewer")) return Response.json({ content: JSON.stringify({ refuted: false, confidence: 0.1, reason: "no refutation" }) });
      if (prompt.includes("addresses")) return Response.json({ content: JSON.stringify({ addresses: true, on_live_path: true, reason: "fixture judge: the change addresses the gap" }) });
      return new Response("unavailable (test)", { status: 400 });
    }
    if (body?.pointer?.type === "vesselCapability") {
      const shape = String(body.pointer.shape ?? "");
      if (shape === "shellResult") return Response.json({ content: { vessels: [{ endpoint: "http://tools.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url.startsWith("http://gap-store.fixture")) {
      const t = String(body?.impulse?.pointer?.type ?? "");
      if (t === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [] } });
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "noop" } });
    }
    return new Response("unavailable (test)", { status: 400 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG; console.warn = ORIGINAL_WARN; console.error = ORIGINAL_ERROR;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  await rm(RUNTIME, { recursive: true, force: true });
});
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

function pointer() {
  return {
    type: "feature_compose",
    spec: `In repos/${VESSEL}/${TARGET}, compute must add 2, not 1.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: { id: "fixture-gap-semgate", summary: `compute in repos/${VESSEL}/${TARGET} adds 1; it must add 2` },
  };
}



const fc = (await import("../../src/resolvers/feature-compose.js")) as unknown as { resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, any> }> };
const VE = "../../src/vacuous-edit.js";
const REAL = { ...(await import(VE)) } as Record<string, (...a: unknown[]) => unknown>;
const restoreHelpers = () => { mock.module(VE, () => ({ ...REAL })); };
function throwing(name: "nonTerminatingEditReason" | "deadStoreEditReason" | "vacuousEditReason"): void {
  mock.module(VE, () => ({ ...REAL, [name]: () => { throw new Error(`${name} broke (test)`); } }));
}
afterEach(() => restoreHelpers());
afterAll(() => restoreHelpers());

const T = `repos/${VESSEL}/${TARGET}`;
const editOp = (old_string: string, new_string: string) => ({ kind: "edit", path: T, old_string, new_string, rationale: "fixture" });
const applierCalls = () => calls.filter((c) => c.type === "fs_edit" || c.type === "fs_write");
const REAL_CHANGE = editOp("  return base + 1;", "  return base + 2;");

describe("CONTROL: with no helper throwing, a real-change plan is admitted", () => {
  it("the plan passes the plan gates and reaches the applier", async () => {
    planOps = [REAL_CHANGE];
    const r = await fc.resolveFeatureCompose(pointer());
    expect(r.body.verdict).not.toBe("REFUSED");
    expect(calls.some((c) => c.type === "fs_edit" && c.path === join(RUNTIME, VESSEL, TARGET))).toBe(true);
  });
});

describe("a plan gate that throws refuses the plan (fail closed)", () => {
  // The stage and the anchored reason name WHICH block refused: a throwing nonTerminatingEditReason also breaks the
  // vacuous block (vacuousEditReason calls it internally, and mock.module re-binds module-internal references too),
  // so a reason that only contained "plan gate error" would let the vacuous block's refusal mask an open first block.
  const rows: Array<["nonTerminatingEditReason" | "deadStoreEditReason" | "vacuousEditReason", string, RegExp]> = [
    ["nonTerminatingEditReason", "plan", /^plan gate error[\s\S]*nonTerminatingEditReason broke \(test\)/],
    ["deadStoreEditReason", "plan", /^plan gate error[\s\S]*deadStoreEditReason broke \(test\)/],
    ["vacuousEditReason", "scope", /^vacuous plan gate error[\s\S]*vacuousEditReason broke \(test\)/],
  ];
  for (const [helper, stage, reason] of rows) {
    it(`MUST-FAIL: ${helper} throws -> the plan is REFUSED by its own gate (stage ${stage}) and nothing is applied`, async () => {
      throwing(helper);
      planOps = [REAL_CHANGE];
      const r = await fc.resolveFeatureCompose(pointer());
      expect({ verdict: r.body.verdict, stage: r.body.stage, applied: applierCalls() }).toEqual({ verdict: "REFUSED", stage, applied: [] });
      expect(String(r.body.error ?? "")).toMatch(reason);
    });
  }
});

describe("the plan gates refuse what they exist to catch", () => {
  const rows: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a self-call that cannot terminate", editOp("  return best ?? 0;", "  return pick(pool);"), /non-terminating edit/],
    ["a dead store (the next statement overwrites the added assignment)", editOp("  n = xs.length;", "  n = xs.length * 2;\n  n = xs.length;"), /dead store/],
    ["a type-only (vacuous) plan", editOp("  return base + 1;", "  return base + 1 as number;"), /vacuous plan refused/],
  ];
  for (const [name, op, reason] of rows) {
    it(`MUST-FAIL: ${name} is REFUSED before any op is applied`, async () => {
      planOps = [op];
      const r = await fc.resolveFeatureCompose(pointer());
      expect({ verdict: r.body.verdict, applied: applierCalls() }).toEqual({ verdict: "REFUSED", applied: [] });
      expect(String(r.body.error ?? "")).toMatch(reason);
    });
  }
});
