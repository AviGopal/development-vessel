// THE SEMANTIC GATE RUNS UNCONDITIONALLY: NO SWITCH TURNS ITS FIVE CHECKS OFF (protected must-fail).
//
// feature-compose.ts guarded the whole semantic block (the shape-vocabulary, CJS-in-ESM, impulse-endpoint and
// inert-literal refusals, verifyPatchAddressesGap with its stub / reachability / zero-delta floors, and the
// dissent disposition) behind one module constant read from the environment at load:
//   SEMANTIC_CUTOVER_GATE = (process.env.SEMANTIC_CUTOVER_GATE ?? "1") !== "0"
// One env value, or a one-line edit of the default, turned every one of them off at once, and no test noticed.
// It was also env-gated behaviour (law 1): frozen at process start, invisible to traces and the walk.
//
// Expected (behavioural, through resolveFeatureCompose; no constant is pinned):
//   - feature-compose is imported TWICE as fresh module instances: once with SEMANTIC_CUTOVER_GATE="0" (kept set
//     for the whole compose, so a use-time read is caught too) and once with the variable unset;
//   - in BOTH, each of five drafts ends NOT FAVORABLE, refused by the named check at the semantic stage:
//       (1) an unadvertised shape literal in an evidence_resolve (shape vocabulary),
//       (2) a CommonJS accessor added to an ESM file whose target has no test (CJS-in-ESM),
//       (3) a POST to a non-existent /v2/impulses/<seg> route (impulse endpoint),
//       (4) a regex edit that behaves identically (inert literal),
//       (5) a new resolver whose body is `throw new Error("not implemented")` (verifyPatchAddressesGap stub floor);
//   - and the semantic stage judges a clean in-place edit (a semantic_gate verdict the judge produced is on the report);
//   - CONTROL: that clean edit ends FAVORABLE under both imports, so a refusal above is the gate speaking, not the
//     harness (the draft is typecheck-verified and nothing earlier refused it).
//
// The CJS gate runs only when a target has no test file (uncoveredTargets > 0). That condition is left as it is
// (it is not this change's to decide); fixture (2) meets it: compute.ts has no test, which the report states.
//
// No LLM (the judge, refuter and planner are fixture responders on a stubbed fetch), no network, no host process
// (the tools shell is a recorder that never runs a command), all writes under this file's temp root.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-semgate-uncond", { superRepo: true, who: "feature-compose-semantic-gate-unconditional.test.ts" });

const VESSEL = "demo-vessel";
const TARGET = "src/compute.ts";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR", "VESSEL_CLONE_ROOT", "SEMANTIC_CUTOVER_GATE"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let logs: string[] = [];
let planOps: Array<Record<string, unknown>> = [];
// How the fixture judge answers: a verdict, an outage (HTTP 400, so the LLM call throws), or prose with no JSON.
let judgeMode: "ok" | "down" | "garbage" = "ok";
let calls: Array<{ type: string; command?: string; path?: string }> = [];
const snapshots = new Map<string, string>();

const TARGET_SRC = [
  "export const GUARD_RE = /\\?\\?/;",
  "export function compute(x: number): number {",
  "  const base = x * 2;",
  "  return base + 1;",
  "}",
  "",
].join("\n");
// Five sibling vessel configs make the REAL shape-vocabulary loader judge (configs_read >= 5); with fewer it abstains.
const SIBLINGS = ["alpha-vessel", "beta-vessel", "gamma-vessel", "delta-vessel"];
const CONFIG_SRC = 'export const discovery = { shapes: ["trace_failure_pattern_report", "substrateGap", "concept"] };\n';

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
  await writeFile(join(RUNTIME, VESSEL, "src", "config.ts"), CONFIG_SRC);
  for (const v of SIBLINGS) { await mkdir(join(RUNTIME, v, "src"), { recursive: true }); await writeFile(join(RUNTIME, v, "src", "config.ts"), CONFIG_SRC); }
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["VESSEL_CLONE_ROOT"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  logs = []; calls = []; snapshots.clear(); judgeMode = "ok";
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
      if (prompt.includes("addresses")) {
        if (judgeMode === "down") return new Response("judge unavailable (test)", { status: 400 });
        if (judgeMode === "garbage") return Response.json({ content: "Looks reasonable to me; the change seems fine." });
        return Response.json({ content: JSON.stringify({ addresses: true, on_live_path: true, reason: "fixture judge: the change addresses the gap" }) });
      }
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


type Fc = {
  resolveFeatureCompose: (p: unknown) => Promise<{ body: Record<string, any> }>;
  verifyPatchAddressesGap: (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  shapeVocabularyRefusal: (diff: string, opts?: Record<string, unknown>) => Record<string, unknown> | null;
};
// A FRESH module instance per mode: the query makes Bun load feature-compose again, so its module-level
// constants are evaluated under THIS environment whatever an earlier test file froze.
let seq = 0;
async function freshFc(mode: "off" | "unset"): Promise<Fc> {
  if (mode === "off") process.env["SEMANTIC_CUTOVER_GATE"] = "0";
  else delete process.env["SEMANTIC_CUTOVER_GATE"];
  return (await import(`../../src/resolvers/feature-compose.ts?semgate=${mode}-${++seq}`)) as Fc;
}

const T = `repos/${VESSEL}/${TARGET}`;
const editOp = (old_string: string, new_string: string) => ({ kind: "edit", path: T, old_string, new_string, rationale: "fixture" });
const FIXTURES: Array<{ name: string; ops: Array<Record<string, unknown>>; reason: RegExp }> = [
  {
    name: "(1) an unadvertised shape literal in an evidence_resolve (shape vocabulary)",
    ops: [editOp("  return base + 1;", ["  const check = {", "    evidence_resolve: {", '      shape: "failurePatternReport",', "    },", "  };", "  return base + Object.keys(check).length;"].join("\n"))],
    reason: /failurePatternReport[\s\S]*discovery\.shapes/,
  },
  {
    name: "(2) a CommonJS accessor added to an ESM file with no test (CJS-in-ESM)",
    ops: [editOp("  return base + 1;\n}", "  return base + 2;\n}\nmodule.exports.computeTwice = (x: number) => compute(compute(x));")],
    reason: /fc-cjs-in-esm/,
  },
  {
    name: "(3) a POST to a non-existent impulse route (impulse endpoint)",
    ops: [editOp("  return base + 1;", "  void fetch(`${process.env.DEV_VESSEL_ENDPOINT}/v2/impulses/emit`, { method: \"POST\", body: JSON.stringify({ base }) });\n  return base + 2;")],
    reason: /fc-impulse-endpoint/,
  },
  {
    name: "(4) a regex edit that behaves identically (inert literal)",
    ops: [editOp("export const GUARD_RE = /\\?\\?/;", "export const GUARD_RE = /\\?\\?|\\?\\?=/;")],
    reason: /fc-inert-regex/,
  },
  {
    name: "(5) a new resolver that is a stub (verifyPatchAddressesGap)",
    ops: [
      editOp("  return base + 1;", "  return base + 2;"),
      { kind: "create_file", path: `repos/${VESSEL}/src/resolvers/compute-report.ts`, content: "export async function resolveComputeReport(): Promise<unknown> {\n  throw new Error(\"not implemented\");\n}\n", rationale: "fixture" },
    ],
    reason: /stub/,
  },
];

for (const mode of ["off", "unset"] as const) {
  const label = mode === "off" ? 'SEMANTIC_CUTOVER_GATE="0"' : "SEMANTIC_CUTOVER_GATE unset";
  describe(`the semantic gate runs with ${label}`, () => {
    it(`CONTROL: a clean in-place edit is FAVORABLE (${label}), so a refusal below is not the harness`, async () => {
      const fc = await freshFc(mode);
      planOps = [editOp("  return base + 1;", "  return base + 2;")];
      const r = await fc.resolveFeatureCompose(pointer());
      expect(r.body.verdict).toBe("FAVORABLE");
    });
    it(`${mode === "off" ? "MUST-FAIL" : "MUST-FAIL (default)"}: the semantic stage judges the clean edit, its verdict on the report (${label})`, async () => {
      const fc = await freshFc(mode);
      planOps = [editOp("  return base + 1;", "  return base + 2;")];
      const r = await fc.resolveFeatureCompose(pointer());
      const g = (r.body.semantic_gate ?? null) as Record<string, unknown> | null;
      expect({ verdict: r.body.verdict, gate: g ? { addresses: g.addresses, llm_consulted: g.llm_consulted, verified: g.verified } : null })
        .toEqual({ verdict: "FAVORABLE", gate: { addresses: true, llm_consulted: true, verified: true } });
    });
    for (const f of FIXTURES) {
      it(`${mode === "off" ? "MUST-FAIL" : "MUST-FAIL (default)"}: ${f.name} is NOT FAVORABLE (${label})`, async () => {
        const fc = await freshFc(mode);
        planOps = f.ops;
        const r = await fc.resolveFeatureCompose(pointer());
        const gate = (r.body.semantic_gate ?? null) as Record<string, unknown> | null;
        // The draft got as far as the semantic stage: typecheck-verified, nothing refused it earlier.
        expect(Array.isArray(r.body.verify) && r.body.verify.length > 0 && r.body.verify.every((v: { ok?: boolean }) => v.ok === true)).toBe(true);
        expect({ verdict: r.body.verdict, refused_by_gate: gate !== null && gate.addresses === false && gate.hard_fail === true })
          .toEqual({ verdict: "UNFAVORABLE", refused_by_gate: true });
        expect(String(gate?.reason ?? "")).toMatch(f.reason);
      });
    }
  });
}

// ── FAIL CLOSED: A JUDGE THAT DID NOT JUDGE IS NOT A PASS ────────────────────────────────────────────────────
// verifyPatchAddressesGap returned addresses:true when the injected judge threw (an outage) and when it answered
// with no parseable verdict, so every judge outage passed whatever cleared the deterministic floors. Both now
// return addresses:false (verified:false); the compose that carries such a patch is not FAVORABLE.
const LIVE_DIFF = [
  `--- a/${VESSEL}/${TARGET}`, `+++ b/${VESSEL}/${TARGET}`, "@@ -4,1 +4,1 @@", "-  return base + 1;", "+  return base + 2;", "",
].join("\n");
const LIVE_FACTS = [{ symbol: "compute", isNewFunction: false, callerCount: 2, isEntrypoint: true, reachable: true }];
const judgeArgs = (llm: (p: string) => Promise<string>) => ({ gapSummary: "compute adds 1; it must add 2", diff: LIVE_DIFF, reachability: LIVE_FACTS, llm, runSemanticJudge: true });

describe("verifyPatchAddressesGap fails closed when its judge does not judge", () => {
  it("CONTROL: a judge verdict of addresses:true passes the clean diff, judged", async () => {
    const fc = await freshFc("unset");
    const v = await fc.verifyPatchAddressesGap(judgeArgs(async (p) => p.includes("ADVERSARIAL reviewer")
      ? JSON.stringify({ refuted: false, confidence: 0.1, reason: "none" })
      : JSON.stringify({ addresses: true, on_live_path: true, reason: "judged: it adds 2" })));
    expect({ addresses: v.addresses, verified: v.verified, llm_consulted: v.llm_consulted }).toEqual({ addresses: true, verified: true, llm_consulted: true });
  });
  it("MUST-FAIL: the injected judge THROWS (an outage) -> addresses:false, unverified, the outage named", async () => {
    const fc = await freshFc("unset");
    const v = await fc.verifyPatchAddressesGap(judgeArgs(async () => { throw new Error("all LLM endpoints failed (test)"); }));
    expect({ addresses: v.addresses, verified: v.verified }).toEqual({ addresses: false, verified: false });
    expect(String(v.reason)).toContain("all LLM endpoints failed (test)");
  });
  it("MUST-FAIL: the judge answers with NO parseable verdict -> addresses:false, unverified", async () => {
    const fc = await freshFc("unset");
    for (const answer of ["Looks reasonable to me.", "{\"addresses\": \"yes\"}", "{not json at all}"]) {
      const v = await fc.verifyPatchAddressesGap(judgeArgs(async () => answer));
      expect({ answer, addresses: v.addresses, verified: v.verified }).toEqual({ answer, addresses: false, verified: false });
    }
  });
  it("MUST-FAIL (compose): a judge outage leaves the clean edit NOT FAVORABLE, refused at the semantic stage", async () => {
    const fc = await freshFc("unset");
    judgeMode = "down";
    planOps = [editOp("  return base + 1;", "  return base + 2;")];
    const r = await fc.resolveFeatureCompose(pointer());
    const g = (r.body.semantic_gate ?? {}) as Record<string, unknown>;
    expect(Array.isArray(r.body.verify) && r.body.verify.every((v: { ok?: boolean }) => v.ok === true)).toBe(true);
    expect({ verdict: r.body.verdict, addresses: g.addresses, verified: g.verified }).toEqual({ verdict: "UNFAVORABLE", addresses: false, verified: false });
  });
  it("MUST-FAIL (compose): an unparseable judge answer leaves the clean edit NOT FAVORABLE", async () => {
    const fc = await freshFc("unset");
    judgeMode = "garbage";
    planOps = [editOp("  return base + 1;", "  return base + 2;")];
    const r = await fc.resolveFeatureCompose(pointer());
    const g = (r.body.semantic_gate ?? {}) as Record<string, unknown>;
    expect({ verdict: r.body.verdict, addresses: g.addresses, verified: g.verified }).toEqual({ verdict: "UNFAVORABLE", addresses: false, verified: false });
  });
});
