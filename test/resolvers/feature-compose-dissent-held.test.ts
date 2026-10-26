// CHECK-FIRST: a SYSTEM-authored SOURCE landing's semantic dissent is HELD, not pushed-then-partial.
//
// Measured: since 2026-10-24 the semantic gate returned addresses:false on 12 SOURCE landings —
// including every gamed or hollow one — and ALL 12 landed as "landed_unverified" anyway.
// semanticGateDisposition's land:true-with-dissent branch (own check red->green, gate addresses:false,
// not hard_fail, not self-certification/hollow-write/edit-site-missed) pushed the draft unconditionally;
// settleSemanticDissent only recorded the gate's refusal as PARTIAL *after* that push. The judge's verdict
// was never load-bearing.
//
// FIX (this file pins): for a SYSTEM-authored landing (not goal-host's operator/edit-intent `directed`
// route) a semantic dissent now HOLDS instead of landing:
//   - systemAuthoredDissentHold(dissent, directed, gapId) — pure — is true only when a dissent exists,
//     the landing has a gap row to hold against, and it is NOT operator-directed;
//   - the cutover loop in feature-compose.ts, when that predicate is true, skips
//     resolveVesselMitosisCutover and settleSemanticDissent entirely (no push, no cutover, no
//     landed_partial, no narrowed child) and instead parks the verified patch with reason
//     "dissent_held";
//   - qa RULING (supersedes an earlier BUSY/park-and-renew design): a held draft is a FAILED attempt,
//     not a non-attempt. The held cutovers entry carries no `result` (no deferred/preserve_pending),
//     so landingVerdictFromCutovers reads UNFAVORABLE (not BUSY), the landing lease RELEASES normally
//     (cutoverPendingIn sees nothing pending — no renewal), and the EXISTING verdict-!==-FAVORABLE
//     lesson block (not a new call) writes the dissent's reason to failure_lessons, with its class
//     overridden to the queryable "semantic_dissent_held" instead of the generic fall-through;
//   - the parked-landing resume (readParkedLanding -> resumeParkedLanding) refuses to auto-resume a
//     dissent_held park, because resumeParkedLanding skips the semantic gate entirely ("the park
//     already passed ... the semantic gate") — auto-resuming would silently push the very thing this
//     fix exists to withhold.
// Operator-directed landings (`directed: true`) and check-only (test_writing) composes are unaffected:
// a test-writing diff can never carry a semantic_dissent (semanticGateDisposition's self-certification
// veto fires first, since every touched path is a test file), so systemAuthoredDissentHold is never
// even reached with a truthy dissent on that route.
//
// Part 1 (pure + AST wiring pin): no LLM, no network, no host process, no fs writes.
// Part 2 (resume-guard, integration): the REAL resolveFeatureCompose through its park-resume entry,
// with the real cutover module mocked (no git, no push) and the tools/LLM/gap-store fetch stubbed —
// the same harness as feature-compose-park-resume-untrusted.test.ts.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";
import * as fc from "../../src/resolvers/feature-compose.js";
import { installCutoverFetchGuard, restoreCutoverFetch, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

function exported<T>(name: string): T {
  const f = (fc as unknown as Record<string, unknown>)[name];
  expect(typeof f, `src/resolvers/feature-compose.ts must export ${name}`).toBe("function");
  return f as T;
}

const DISSENT = { reason: "2/2 refuters: advisory", gate_verdict: { addresses: false }, at: "2026-10-24T00:00:00.000Z", later_outcome: null };

// ── PART 1: the pure predicate + AST wiring pin ───────────────────────────────────────────────────
describe("systemAuthoredDissentHold: pure", () => {
  let guard: FetchGuard;
  let execGuard: ExecGuard;
  beforeEach(() => { guard = installCutoverFetchGuard(); execGuard = installCutoverExecGuard(); });
  afterEach(() => {
    const execViolations = execGuard.restore();
    expect(guard.restore()).toEqual([]);
    expect(execViolations).toEqual([]);
  });
  afterAll(() => { restoreCutoverFetch(); restoreCutoverExecModules(); });

  const held = exported<(d: unknown, directed: unknown, gapId: unknown) => boolean>("systemAuthoredDissentHold");

  it("MUST-FAIL: a dissent on a system (undirected) landing with a gap id holds", () => {
    expect(held(DISSENT, undefined, "gap-1")).toBe(true);
    expect(held(DISSENT, false, "gap-1")).toBe(true);
  });

  it("CONTROL: an OPERATOR-directed landing (directed:true) under the same dissent does not hold", () => {
    expect(held(DISSENT, true, "gap-1")).toBe(false);
  });

  it("CONTROL: no dissent, or no gap id, does not hold", () => {
    expect(held(null, undefined, "gap-1")).toBe(false);
    expect(held(DISSENT, undefined, undefined)).toBe(false);
    expect(held(DISSENT, undefined, null)).toBe(false);
    expect(held(DISSENT, undefined, "")).toBe(false);
  });

  it("CONTROL: a check-only (test_writing) diff never produces a dissent, so the hold is never reached", () => {
    const disposition = exported<(i: unknown) => { land: boolean; veto: string | null; semantic_dissent?: unknown }>("semanticGateDisposition");
    const ownCheck = { test_file: "test/x.test.ts", ran: true, tc_ok: true, base_red: ["t"], draft_red: [] as string[], contract_breach: null };
    // Every touched path is a test file -> self_certification veto fires before a dissent can be minted.
    const diff = ["### /vessels/v/test/x.test.ts", "--- a/v/test/x.test.ts", "+++ b/v/test/x.test.ts", "@@ -1,1 +1,2 @@", " it(\"t\", () => {});", "+it(\"t2\", () => {});"].join("\n");
    const d = disposition({ gate: { addresses: false, on_live_path: false, hard_fail: false, reason: "refused" }, own_check: ownCheck, diff, edit_site: null, src_files: {} });
    expect({ land: d.land, veto: d.veto, dissent: d.semantic_dissent ?? null }).toEqual({ land: false, veto: "self_certification", dissent: null });
    expect(held(d.semantic_dissent ?? null, undefined, "gap-1")).toBe(false);
  });
});

// A dissent-held draft is a FAILED attempt (qa ruling, superseding an earlier BUSY/park-and-renew design):
// it charges through the EXISTING verdict-!==-FAVORABLE path (failed_attempts/escalation increment the normal
// way), its lesson class is queryable as "semantic_dissent_held", and the landing lease is released normally —
// NOT renewed, because nothing in the held cutovers entry reads as pending.
describe("a held landing is a failed attempt: no lease renewal, charged as \"fix\"", () => {
  let guard: FetchGuard;
  let execGuard: ExecGuard;
  beforeEach(() => { guard = installCutoverFetchGuard(); execGuard = installCutoverExecGuard(); });
  afterEach(() => {
    const execViolations = execGuard.restore();
    expect(guard.restore()).toEqual([]);
    expect(execViolations).toEqual([]);
  });
  afterAll(() => { restoreCutoverFetch(); restoreCutoverExecModules(); });

  const pendingIn = exported<(o: { body?: { cutovers?: unknown } } | null) => boolean>("cutoverPendingIn");
  const failureKind = exported<(i: { verdict: string; terminal_refusal: string | null; cutover_env_class: string | null; verify: unknown[]; semantic_judge_unavailable?: boolean }) => string | null>("composeFailureKind");

  // The exact shape the held branch now pushes: {vessel, landed:false, reason} with NO `result` key.
  const HELD_CUTOVERS = [{ vessel: "v", landed: false, reason: "semantic gate addresses:false on a system-authored landing; held for operator review, not pushed" }];

  it("MUST-FAIL: a held landing's cutovers entry is NOT pending -> releaseOrKeepLandingLease releases, it does not renew", () => {
    expect(pendingIn({ body: { cutovers: HELD_CUTOVERS } })).toBe(false);
  });

  it("CONTROL: the OLD (now-removed) deferred:true shape WOULD have renewed the lease — proving the new shape is a deliberate choice, not an oversight", () => {
    expect(pendingIn({ body: { cutovers: [{ vessel: "v", landed: false, result: { deferred: true } }] } })).toBe(true);
  });

  it('MUST-FAIL: a held landing classifies as "fix" (charged, not a non-attempt) when verify passed and the judge was reachable', () => {
    const kind = failureKind({ verdict: "UNFAVORABLE", terminal_refusal: null, cutover_env_class: null, verify: [{ ok: true, output: "", own: false }], semantic_judge_unavailable: false });
    expect(kind).toBe("fix");
  });

  it("CONTROL: an actual environment condition (judge unavailable) still classifies as environment, not fix — the held case is distinct from an infra refusal", () => {
    const kind = failureKind({ verdict: "UNFAVORABLE", terminal_refusal: null, cutover_env_class: null, verify: [{ ok: true, output: "", own: false }], semantic_judge_unavailable: true });
    expect(kind).toBe("environment");
  });
});

describe("the cutover loop's dissent-hold wiring (AST, comments/reflow-proof)", () => {
  const SRC_PATH = new URL("../../src/resolvers/feature-compose.ts", import.meta.url).pathname;
  const src = readFileSync(SRC_PATH, "utf8");

  it("MUST-FAIL: the landing block computes systemDissentHold once (outside the per-vessel loop) from the exported helper, parks it dissent_held, and the held branch pushes NO `result` field, calls neither the cutover, settleSemanticDissent nor an explicit lesson write, and `continue`s", () => {
    const holdIdx = src.indexOf("const systemDissentHold = systemAuthoredDissentHold(");
    expect(holdIdx, "systemDissentHold must be computed from systemAuthoredDissentHold").toBeGreaterThan(-1);
    const parkReasonIdx = src.indexOf('reason: systemDissentHold ? "dissent_held" : "pre-cutover"');
    expect(parkReasonIdx, "the park's reason must switch on systemDissentHold").toBeGreaterThan(holdIdx);
    const ifHoldIdx = src.indexOf("if (systemDissentHold) {", parkReasonIdx);
    expect(ifHoldIdx, "a systemDissentHold branch must follow the park write").toBeGreaterThan(parkReasonIdx);
    const cutIdx = src.indexOf("const cut = await resolveVesselMitosisCutover({", ifHoldIdx);
    expect(cutIdx, "the cutover call must come after (textually below) the hold branch").toBeGreaterThan(ifHoldIdx);
    const holdBlock = src.slice(ifHoldIdx, cutIdx);
    expect(/\bcontinue;/.test(holdBlock)).toBe(true);
    // No fake pending result (qa ruling: no lease renewal), no explicit duplicate lesson write (the
    // existing verdict-!==-FAVORABLE block below writes it instead), and no cutover/settle call.
    expect(holdBlock.includes("deferred:")).toBe(false);
    expect(holdBlock.includes("preserve_pending")).toBe(false);
    expect(holdBlock.includes("appendComposeLesson(")).toBe(false);
    expect(holdBlock.includes("resolveVesselMitosisCutover(")).toBe(false);
    expect(holdBlock.includes("settleSemanticDissent(")).toBe(false);
    // The cutovers entry it DOES push carries `landed: false` and a `reason`, no `result`.
    expect(/cutovers\.push\(\{\s*vessel,\s*landed:\s*false,\s*reason:/.test(holdBlock)).toBe(true);
  });

  it('MUST-FAIL: the failure-lesson block (verdict !== FAVORABLE) overrides lessonClass to "semantic_dissent_held" for a held landing, reusing the EXISTING write-back instead of a new one', () => {
    const lessonClassIdx = src.indexOf("const lessonClass = systemDissentHold");
    expect(lessonClassIdx, "lessonClass must switch on systemDissentHold").toBeGreaterThan(-1);
    const window = src.slice(lessonClassIdx, lessonClassIdx + 220);
    expect(window.includes('"semantic_dissent_held"')).toBe(true);
    expect(window.includes("composeLessonClass(")).toBe(true);
    const appendIdx = src.indexOf("appendComposeLesson(lessonClass,", lessonClassIdx);
    expect(appendIdx, "the EXISTING appendComposeLesson(lessonClass, ...) call must follow").toBeGreaterThan(lessonClassIdx);
  });

  it("MUST-FAIL: the parked-landing resume refuses to auto-resume a dissent_held park", () => {
    const resumeGuardIdx = src.indexOf('if (park.reason === "dissent_held") {');
    expect(resumeGuardIdx, 'the resume entry must special-case reason === "dissent_held"').toBeGreaterThan(-1);
    const resumeCallIdx = src.indexOf("await resumeParkedLanding(pointer, park, toolsEndpoint)");
    expect(resumeCallIdx).toBeGreaterThan(resumeGuardIdx);
    // The guard's own branch must not call resumeParkedLanding (it only logs and falls through).
    const block = src.slice(resumeGuardIdx, src.indexOf("} else if", resumeGuardIdx));
    expect(block.includes("resumeParkedLanding(")).toBe(false);
  });

  it("MUST-FAIL (AST): systemAuthoredDissentHold is a function declaration exported from this module", () => {
    const sf = ts.createSourceFile(SRC_PATH, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found: ts.FunctionDeclaration | undefined;
    const walk = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "systemAuthoredDissentHold") found = n;
      n.forEachChild(walk);
    };
    walk(sf);
    expect(found !== undefined).toBe(true);
    expect(found!.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
  });
});

// ── PART 2: the resume guard, end to end through resolveFeatureCompose ──────────────────────────────
const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-dissent-held", { who: "feature-compose-dissent-held.test.ts" });

const realCutover = await import("../../src/resolvers/vessel-mitosis-cutover.js");
const REAL_CUTOVER = { ...realCutover };
let cutoverCalls: Array<Record<string, unknown>> = [];
mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async (p: Record<string, unknown>) => {
    cutoverCalls.push(p);
    return { shape: "cutoverApplied", body: { applied: true, push_status: "pushed", new_git_sha: "f".repeat(40) } };
  },
}));
const fc2 = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const VESSEL = "development-vessel";
const F = "src/resolvers/target.ts";
const F_PARKED = "// target module\nexport const alpha = 2; // PARK_MARKER\n";
const F_AT_B = "// target module\nexport const alpha = 1;\n";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let logs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  cutoverCalls = [];
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) return Response.json({ stdout: "TC_EXIT=0\n" });
    if (url === LLM) return new Response("unavailable (test)", { status: 503 });
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
    return new Response("unavailable (test)", { status: 503 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(ws, { recursive: true, force: true });
  await rm(RUNTIME, { recursive: true, force: true });
});
afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  mock.restore();
  // mock.restore() does not undo mock.module, and the gate runs the whole suite in ONE process.
  mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => REAL_CUTOVER);
  await rm(ROOT, { recursive: true, force: true });
});

async function setup(gapId: string): Promise<void> {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);
  const seed = join(ws, "seed");
  await put(seed, "README.md", "seed\n");
  await put(seed, F, F_AT_B);
  git(ws, "init", "-b", "dev", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "commit.gpgsign", "false");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "dev");
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, join(ws, "git", "vessels", VESSEL));
}
function park(gapId: string, reason: string) {
  return {
    gap_id: gapId,
    compose_id: `${VESSEL}-fc-test`,
    vessel: VESSEL,
    files: [{ path: F, content: F_PARKED, base_content: F_AT_B }],
    verify: { typecheck: true, shape_dispatch: true, tests: true },
    judge: { addresses: false, reason: "advisory dissent (fixture)" },
    parked_at: new Date().toISOString(),
    reason,
    attempt_id: null,
  };
}
function entryPointer(gapId: string) {
  return { type: "feature_compose", spec: "fixture spec", land: true, skip_push: true, directed: true, gap: { id: gapId } };
}

describe("a dissent_held park is never auto-resumed; a pre-cutover park still is", () => {
  it("MUST-FAIL: a dissent_held park is NOT resumed — no cutover call, the compose falls through to a normal (re-)draft", async () => {
    const gapId = "gap-dissent-held-resume";
    await setup(gapId);
    await fc2.writeParkedLanding(park(gapId, "dissent_held"));
    const r = await fc2.resolveFeatureCompose(entryPointer(gapId));
    expect(cutoverCalls.length).toBe(0);
    expect((r.body as Record<string, unknown>)["resumed_from"]).toBeUndefined();
    expect(logs.some((l) => l.includes("dissent_held") && l.includes("not auto-resumed"))).toBe(true);
    // The park is left on disk — a human can still find it; it is not silently dropped.
    const stillParked = await fc2.readParkedLanding(gapId);
    expect(stillParked?.reason).toBe("dissent_held");
  });

  it("CONTROL: a pre-cutover park still auto-resumes and reaches the cutover, as before", async () => {
    const gapId = "gap-pre-cutover-resume";
    await setup(gapId);
    await fc2.writeParkedLanding(park(gapId, "pre-cutover"));
    const r = await fc2.resolveFeatureCompose(entryPointer(gapId));
    expect(cutoverCalls.length).toBe(1);
    expect((r.body as Record<string, unknown>)["resumed_from"]).toBe(`${VESSEL}-fc-test`);
  });
});
