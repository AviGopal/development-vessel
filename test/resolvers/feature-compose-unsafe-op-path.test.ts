// A MODEL-AUTHORED PLAN PATH IS SHAPE-CHECKED BEFORE IT REACHES ANY ROOT OR SHELL (security, check-first).
//
// feature_compose applies the drafter's plan. An op's `path` is model output: it was joined onto the
// vessel root and handed to the tools shell (`mkdir -p <dir>`, `cat <file>`, `rm -f <file>`, the
// staging `cp`) quoted with JSON.stringify, i.e. double quotes, inside which bash still expands a
// command substitution. Nothing checked its characters: the file-scope gate checks edit ops against the
// target files only, and create_file ops are exempt from it. The repair round's target path (fc-repair)
// was the same.
//
// Expected:
//   - plan acceptance refuses the whole plan (stage unsafe_op_path) when any op path is not a plain
//     vessel-relative path under repos/<vessel>/ in [A-Za-z0-9._/@+-], with no '..' and no leading '/';
//     the shell sees nothing derived from the path, nothing is written, and the drafter-facing reason
//     names only the rule, never the value;
//   - the op applier re-checks each path (a second layer under the first): the path never reaches a tool
//     call even when plan acceptance is bypassed;
//   - the repair round's target path gets the same check;
//   - CONTROL: a plain create_file under src/ is accepted and reaches the applier.
//
// The tools shell is a RECORDER: no command sent to it is ever run, so no payload in this file executes.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// feature-compose captures RUNTIME_ROOT / REPO_ROOT at module load: fix them before importing it.
const ROOT = mkdtempSync(join(tmpdir(), "fc-unsafe-op-path-"));
const RUNTIME = join(ROOT, "runtime");
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["MITOSIS_REPO_ROOT"] = RUNTIME;
process.env["MITOSIS_SUPER_REPO_DIR"] = join(ROOT, "no-super-repo");

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;

const VESSEL = "demo-vessel";
const EXISTING = "src/existing.ts";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";
const MARK = "MARKFILE";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
type ToolCall = { type: string; command?: string; path?: string };
let ws: string;
let calls: ToolCall[] = [];
let logs: string[] = [];
let planOps: Array<Record<string, unknown>> = [];
let planCalls = 0;

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  await mkdir(join(RUNTIME, VESSEL, "src"), { recursive: true });
  await writeFile(join(RUNTIME, VESSEL, "package.json"), "{\"name\":\"demo-vessel\"}\n");
  await writeFile(join(RUNTIME, VESSEL, EXISTING), "export const existing = 1;\n");
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  calls = [];
  logs = [];
  planCalls = 0;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) {
      const p = body?.impulse?.pointer ?? {};
      const call: ToolCall = { type: String(p.type ?? "") };
      if (typeof p.command === "string") call.command = p.command;
      if (typeof p.path === "string") call.path = p.path;
      calls.push(call);
      if (call.type === "shell" && (call.command ?? "").includes("find src")) return Response.json({ stdout: `${EXISTING}\npackage.json\n` });
      if (call.type === "fs_read") {
        try { return Response.json({ content: await Bun.file(String(p.path)).text() }); } catch { return Response.json({ error: "absent" }, { status: 404 }); }
      }
      if (call.type === "fs_write") return Response.json({ ok: true });
      return Response.json({ stdout: "" });
    }
    if (url === LLM) {
      if (String(body?.prompt ?? "").includes("decomposing a feature specification") && planCalls === 0) {
        planCalls++;
        return Response.json({ content: JSON.stringify({ summary: "fixture plan", touched_vessels: [`repos/${VESSEL}`], ops: planOps }) });
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
  console.log = ORIGINAL_LOG;
  console.warn = ORIGINAL_WARN;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  await rm(RUNTIME, { recursive: true, force: true });
});
afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  console.warn = ORIGINAL_WARN;
  await rm(ROOT, { recursive: true, force: true });
});

function pointer() {
  return {
    type: "feature_compose",
    spec: `Add a new helper module under repos/${VESSEL}/${EXISTING} for the fixture.`,
    verify_vessels: [`repos/${VESSEL}`],
    land: false,
    skip_push: true,
    directed: true,
    gap: { id: "fixture-gap-op-path", summary: "fixture gap for the op path check" },
  };
}
const createOp = (path: string) => ({ kind: "create_file", path, content: "export const created = 1;\n", rationale: "fixture" });
const pathCarrying = (c: ToolCall, needle: string) => (c.command ?? "").includes(needle) || (c.path ?? "").includes(needle);

describe("CONTROL: a plain create_file under src/ is accepted and reaches the applier", () => {
  it("the applier makes the file's directory and writes the file", async () => {
    planOps = [createOp(`repos/${VESSEL}/src/fresh/helper.ts`)];
    const r = await fc.resolveFeatureCompose(pointer());
    expect(planCalls).toBe(1);
    expect((r.body as Record<string, unknown>)["stage"]).not.toBe("unsafe_op_path");
    expect(calls.some((c) => c.type === "shell" && (c.command ?? "").startsWith("mkdir -p") && pathCarrying(c, `${VESSEL}/src/fresh`))).toBe(true);
    expect(calls.some((c) => c.type === "fs_write" && c.path === join(RUNTIME, VESSEL, "src/fresh/helper.ts"))).toBe(true);
  });
});

describe("plan acceptance: an unsafe op path refuses the whole plan before any root join or shell call", () => {
  const hostile: Array<[string, string]> = [
    ["a command substitution", `repos/${VESSEL}/src/$(touch ${MARK}).ts`],
    ["a ';' command separator", `repos/${VESSEL}/src/a;touch ${MARK}.ts`],
  ];
  for (const [label, path] of hostile) {
    it(`MUST-FAIL: a create_file path with ${label} is refused as unsafe_op_path; the shell sees no part of it and nothing is written`, async () => {
      planOps = [createOp(`repos/${VESSEL}/src/fresh/ok.ts`), createOp(path)];
      const r = await fc.resolveFeatureCompose(pointer());
      expect(planCalls).toBe(1);
      expect({
        reached_shell: calls.filter((c) => pathCarrying(c, MARK)),
        writes: calls.filter((c) => c.type === "fs_write"),
        stage: (r.body as Record<string, unknown>)["stage"],
      }).toEqual({ reached_shell: [], writes: [], stage: "unsafe_op_path" });
      // The reason names the rule, never the value.
      expect(JSON.stringify(r.body)).not.toContain(MARK);
      expect(logs.filter((l) => l.includes(MARK))).toEqual([]);
      expect(existsSync(join(RUNTIME, VESSEL, "src", MARK))).toBe(false);
    });
    it(`MUST-FAIL (second layer): a create_file path with ${label} never reaches a tool call, even past plan acceptance`, async () => {
      // Asserts only what the op applier's own re-check guarantees, so it holds with the plan-acceptance check off.
      planOps = [createOp(`repos/${VESSEL}/src/fresh/ok.ts`), createOp(path)];
      await fc.resolveFeatureCompose(pointer());
      expect(planCalls).toBe(1);
      expect(calls.filter((c) => pathCarrying(c, MARK))).toEqual([]);
    });
  }
});

describe("planPathProblem: the one rule for a model-derived path", () => {
  it("accepts plain vessel-relative paths under repos/<vessel>/", () => {
    expect(typeof csa.planPathProblem).toBe("function");
    for (const ok of [`repos/${VESSEL}/src/a.ts`, `repos/${VESSEL}/test/checks/x.check.ts`, `repos/${VESSEL}/src/@scope/a+b-c_d.ts`, `./repos/${VESSEL}/src/a.ts`]) {
      expect(csa.planPathProblem(ok)).toBeNull();
    }
  });
  it("MUST-FAIL: refuses metacharacters, whitespace, quotes, '..', '.' or empty segments, absolute and rootless paths, naming only the rule", () => {
    expect(typeof csa.planPathProblem).toBe("function");
    const bad = [
      `repos/${VESSEL}/src/$(x).ts`, `repos/${VESSEL}/src/\`x\`.ts`, `repos/${VESSEL}/src/a;b.ts`, `repos/${VESSEL}/src/a|b.ts`,
      `repos/${VESSEL}/src/a&b.ts`, `repos/${VESSEL}/src/a<b.ts`, `repos/${VESSEL}/src/a>b.ts`, `repos/${VESSEL}/src/a b.ts`,
      `repos/${VESSEL}/src/a'b.ts`, `repos/${VESSEL}/src/a"b.ts`, `repos/${VESSEL}/src/a\\b.ts`, `repos/${VESSEL}/src/a\nb.ts`,
      `repos/${VESSEL}/src/a\u0000b.ts`, `repos/${VESSEL}/src/$HOME.ts`, `repos/${VESSEL}/../x.ts`, `/vessels/${VESSEL}/src/a.ts`,
      `src/a.ts`, `repos/${VESSEL}`, `repos/./src/a.ts`, `repos/${VESSEL}/./a.ts`, `repos/${VESSEL}//a.ts`, "", 42,
    ];
    for (const b of bad) {
      const why = csa.planPathProblem(b);
      expect(typeof why).toBe("string");
      if (typeof b === "string" && b.length > 3) expect(why).not.toContain(b);
    }
  });
});

describe("fc-repair: the repair round's target path gets the same check", () => {
  it("MUST-FAIL: a repair target with a metacharacter or outside the vessel resolves to nothing", () => {
    expect(typeof fc.repairTargetPath).toBe("function");
    expect(fc.repairTargetPath(`src/$(touch ${MARK}).ts`, `repos/${VESSEL}`)).toBeNull();
    expect(fc.repairTargetPath(`/etc/x.ts`, `repos/${VESSEL}`)).toBeNull();
    expect(fc.repairTargetPath(`../x.ts`, `repos/${VESSEL}`)).toBeNull();
    expect(fc.repairTargetPath(`repos/${VESSEL}/src/a b.ts`, `repos/${VESSEL}`)).toBeNull();
  });
  it("CONTROL: a vessel-relative or repos/ repair target resolves as before", () => {
    expect(typeof fc.repairTargetPath).toBe("function");
    expect(fc.repairTargetPath("src/a.ts", `repos/${VESSEL}`)).toBe(`repos/${VESSEL}/src/a.ts`);
    expect(fc.repairTargetPath("src/a.ts", VESSEL)).toBe(`repos/${VESSEL}/src/a.ts`);
    expect(fc.repairTargetPath(`repos/${VESSEL}/src/a.ts`, `repos/${VESSEL}`)).toBe(`repos/${VESSEL}/src/a.ts`);
    expect(fc.repairTargetPath("", `repos/${VESSEL}`)).toBeNull();
  });
});
