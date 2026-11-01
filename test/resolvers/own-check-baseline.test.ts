// THE OWN-CHECK BASELINE (src/resolvers/own-check-baseline.ts): one gap's own check, run at its vessel's origin/dev and
// classified. Each run below goes through the REAL test_suite resolver (its discovery and shell transport stubbed with
// bun's printed output), the real classify, and the real substrateGap read/write shapes, FORWARDED: GAP_STORE_ENDPOINT
// is set, so this process is a node that does not hold the gap store, and the reading must reach the holder through the
// write shape (no direct store write).
//   - C1-shaped (a check importing a live DB client, the code's catch returning [], "Expected > 0 / Received 0"):
//     red_environmental under the policy, with the three signals named;
//   - code-red (the failing test throws inside src/): red_code_reachable with the frames' call path;
//   - a returned-value red with no src frame: the static call path, call_path_source "static";
//   - green: green_at_parent; unrunnable (no summary; named tests not in the file): unrunnable, no throw;
//   - the policy absent, or invalid: nothing is environmental (the C1 run reads red_code_reachable), env_policy says which;
//   - the re-measure grades a consumed environmental predecessor (agree / disagree), never an unconsumed one.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SUPER = join(ROOT, "super");
const NOPOLICY = join(ROOT, "super-without-policy");
const BADPOLICY = join(ROOT, "super-bad-policy");
const CLONES = join(ROOT, "clones");
const VESSEL = "fixture-vessel";
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const STORE = "http://127.0.0.1:9/v2/impulses/resolve";
const POLICY = {
  live_client_imports: ["/db/surreal", "surrealdb", "/db/client", "pg", "ioredis"],
  empty_result_received: ["0", "[]", "undefined", "null", "\"\""],
  count_assert_expected: ["> 0", ">= 1", "toBeGreaterThan", "toHaveLength"],
  precondition_failure_text: ["ECONNREFUSED", "Unable to connect", "connection refused", "not connected", "authentication failed"],
  min_failures_for_env: 1,
  require_all_failures_empty: 1,
};
const prior = { GAP_STORE_ENDPOINT: process.env["GAP_STORE_ENDPOINT"], VESSELS_CLONE_ROOT: process.env["VESSELS_CLONE_ROOT"] };
const originalFetch = globalThis.fetch;

const mod = await import("../../src/resolvers/own-check-baseline.js");
const credit = await import("../../src/resolvers/own-check-baseline-credit.js");
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

const C1_CHECK = [
  'import { describe, expect, it } from "bun:test";',
  'import { queryTraces } from "../src/services/routing-trace";',
  'import { db } from "../src/db/surreal";',
  'describe("phase5", () => {',
  '  it("returns traces", async () => {',
  "    const rows = await queryTraces(db, {});",
  "    expect(rows.length).toBeGreaterThan(0);",
  "  });",
  "});",
].join("\n");
const C1_RAW = [
  "VERIFIED_ROOT=/tmp/test-suite-base-c1", "VERIFIED_HEAD=aaaaaaa",
  "test/phase5.test.ts:",
  "6 |     const rows = await queryTraces(db, {});",
  "7 |     expect(rows.length).toBeGreaterThan(0);",
  "                            ^",
  "error: expect(received).toBeGreaterThan(expected)",
  "",
  "Expected: > 0",
  "Received: 0",
  "",
  "      at <anonymous> (/tmp/test-suite-base-c1/test/phase5.test.ts:7:25)",
  "(fail) phase5 > returns traces [3.00ms]",
  "", " 0 pass", " 1 fail", " 1 expect() calls", "Ran 1 test across 1 file. [20.00ms]",
].join("\n");
const CODE_RAW = [
  "VERIFIED_ROOT=/tmp/test-suite-base-cr", "VERIFIED_HEAD=aaaaaaa",
  "TypeError: widget.parts is undefined",
  "      at parseWidget (/tmp/test-suite-base-cr/src/widget.ts:7:11)",
  "      at <anonymous> (/tmp/test-suite-base-cr/test/widget.test.ts:5:5)",
  "(fail) widget > parses [1.00ms]",
  "", " 0 pass", " 1 fail", "Ran 1 test across 1 file.",
].join("\n");
const RETURNED_CHECK = [
  'import { expect, it } from "bun:test";',
  'import { countParts } from "../src/widget";',
  'it("counts parts", () => {',
  "  expect(countParts({ parts: [1, 2] })).toBe(2);",
  "});",
].join("\n");
const RETURNED_RAW = [
  "VERIFIED_ROOT=/tmp/test-suite-base-rv", "VERIFIED_HEAD=aaaaaaa",
  "error: expect(received).toBe(expected)", "", "Expected: 2", "Received: 3", "",
  "      at <anonymous> (/tmp/test-suite-base-rv/test/count.test.ts:4:42)",
  "(fail) counts parts [1.00ms]",
  "", " 0 pass", " 1 fail", " 1 expect() calls", "Ran 1 test across 1 file.",
].join("\n");
const GREEN_RAW = ["VERIFIED_ROOT=/tmp/x", "VERIFIED_HEAD=aaaaaaa", "(pass) phase5 > returns traces [1.00ms]", "", " 1 pass", " 0 fail", " 1 expect() calls", "Ran 1 test across 1 file."].join("\n");
const NO_SUMMARY_RAW = "VERIFIED_ROOT=/tmp/x\nVERIFIED_HEAD=aaaaaaa\nerror: test file not found: had no matches\n";
const SRC_WIDGET = "export function countParts(w: { parts: number[] }): number {\n  return w.parts.length + 1;\n}\n";

type World = { raw: string; meta: Record<string, unknown>; sources: Record<string, string>; writes: Array<Record<string, unknown>>; storeCalls: string[] };
let world: World;
function gapRow(meta: Record<string, unknown>): Record<string, unknown> {
  return { id: "ocb-gap-1", category: "systematic_failure", source: "substrate_detected", summary: "phase5 traces are empty", detected_at: "2026-01-01T00:00:00Z", status: "open", classification_metadata: meta };
}
const check = (test_file: string, only_tests: string[]) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file, only_tests }, zero_field: "requested_not_passing" } });
const git = (_dir: string, args: string[]): string | null => {
  if (args[0] === "rev-parse") return SHA;
  if (args[0] === "show") { const rel = String(args[1]).split(":").slice(1).join(":"); return world.sources[rel] ?? null; }
  return null;
};
const deps = (env: string, extra: Record<string, unknown> = {}) => ({ git, env: { SUPER_REPO_DIR: env }, runTestSuite: (i: Record<string, unknown>) => resolveTestSuite(i as never), ...extra });

beforeAll(() => {
  for (const d of [SUPER, NOPOLICY, BADPOLICY]) mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(SUPER, "policies"), { recursive: true });
  writeFileSync(join(SUPER, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify(POLICY));
  mkdirSync(join(BADPOLICY, "policies"), { recursive: true });
  writeFileSync(join(BADPOLICY, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ ...POLICY, live_client_imports: "not-a-list" }));
  mkdirSync(join(CLONES, VESSEL, "src"), { recursive: true });
  mkdirSync(join(CLONES, VESSEL, "test"), { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), SRC_WIDGET);
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  process.env["GAP_STORE_ENDPOINT"] = STORE;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const b = init?.body ? JSON.parse(String(init.body)) : {};
    if (b?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/v2/impulses/resolve" }] } });
    const p = b?.impulse?.pointer ?? {};
    if (p.type === "shell") return Response.json({ stdout: world.raw });
    if (String(u) === STORE) {
      world.storeCalls.push(String(p.type));
      if (p.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [gapRow(world.meta)], total: 1 } });
      if (p.type === "substrateGap_write") { world.writes.push(p); return Response.json({ shape: "substrateGap", body: { id: p.gap?.id, written: true } }); }
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});
const fresh = (raw: string, meta: Record<string, unknown>, sources: Record<string, string> = {}): void => { world = { raw, meta, sources, writes: [], storeCalls: [] }; };
const written = (): Record<string, any> => (world.writes[0]?.["gap"] as { classification_metadata?: Record<string, unknown> } | undefined)?.classification_metadata?.["own_check_baseline"] as Record<string, any>;

describe("own_check_baseline_classify: one gap's own check at its base, classified", () => {
  it("MUST-FAIL the C1-shaped check (live DB import, an empty result asserted non-empty) reads red_environmental under the policy", async () => {
    fresh(C1_RAW, check("test/phase5.test.ts", ["phase5 > returns traces"]), { "test/phase5.test.ts": C1_CHECK });
    const r = await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER));
    expect(r.shape).toBe("ownCheckBaseline");
    const b = r.body as Record<string, any>;
    expect(b.verdict).toBe("red_environmental");
    expect(b.env_policy).toBe("policy");
    expect(b.env_signals).toEqual(expect.arrayContaining(["S_live_import", "S_empty_received", "S_count_expected"]));
    expect(b.base_sha).toBe(SHA);
    expect(b.red).toEqual(["phase5 > returns traces"]);
    expect(b.expect_count).toBe(1);
  });

  it("the reading reaches the gap-store holder through the substrateGap write shape (this node does not hold the store)", async () => {
    fresh(C1_RAW, check("test/phase5.test.ts", ["phase5 > returns traces"]), { "test/phase5.test.ts": C1_CHECK });
    await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER));
    expect(world.storeCalls).toContain("substrateGap_write");
    expect(world.writes).toHaveLength(1);
    const m = (world.writes[0]!["gap"] as { classification_metadata: Record<string, unknown> }).classification_metadata;
    expect(Object.keys(m)).toEqual(["own_check_baseline"]);
    expect(written().verdict).toBe("red_environmental");
  });

  it("MUST-FAIL a check that throws inside src/ reads red_code_reachable with the frames' call path", async () => {
    fresh(CODE_RAW, check("test/widget.test.ts", ["widget > parses"]), { "test/widget.test.ts": 'import { parseWidget } from "../src/widget";\n' });
    const b = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER))).body as Record<string, any>;
    expect(b.verdict).toBe("red_code_reachable");
    expect(b.call_path_source).toBe("frames");
    expect(b.call_path).toEqual([{ path: `repos/${VESSEL}/src/widget.ts`, fn: "parseWidget", line: 7 }]);
  });

  it("a returned-value red with no src frame gets the static call path, recorded as static", async () => {
    fresh(RETURNED_RAW, check("test/count.test.ts", ["counts parts"]), { "test/count.test.ts": RETURNED_CHECK, "src/widget.ts": SRC_WIDGET });
    const b = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER))).body as Record<string, any>;
    expect(b.verdict).toBe("red_code_reachable");
    expect(b.call_path_source).toBe("static");
    expect(b.call_path).toEqual([{ path: `repos/${VESSEL}/src/widget.ts`, fn: "countParts", line: 1 }]);
  });

  it("green at base reads green_at_parent", async () => {
    fresh(GREEN_RAW, check("test/phase5.test.ts", ["phase5 > returns traces"]), { "test/phase5.test.ts": C1_CHECK });
    const b = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER))).body as Record<string, any>;
    expect(b.verdict).toBe("green_at_parent");
    expect(b.red).toEqual([]);
  });

  it("a run with no summary (missing file) and a validation refusal both read unrunnable, without throwing", async () => {
    fresh(NO_SUMMARY_RAW, check("test/missing.test.ts", ["anything"]));
    const b = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER))).body as Record<string, any>;
    expect(b.verdict).toBe("unrunnable");
    fresh(GREEN_RAW, check("test/phase5.test.ts", ["phase5 > returns traces"]));
    const refused = async () => ({ shape: "structuredError", body: { resolver: "test_suite", failure_mode: "validation_rejected", field: "only_tests" } });
    const b2 = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, { ...deps(SUPER), runTestSuite: refused } as never)).body as Record<string, any>;
    expect(b2.verdict).toBe("unrunnable");
  });

  it("CONTROL with the policy absent, or invalid, nothing is environmental: the C1 run reads red_code_reachable", async () => {
    fresh(C1_RAW, check("test/phase5.test.ts", ["phase5 > returns traces"]), { "test/phase5.test.ts": C1_CHECK });
    const absent = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(NOPOLICY))).body as Record<string, any>;
    expect(absent.verdict).toBe("red_code_reachable");
    expect(absent.env_policy).toBe("absent");
    expect(absent.env_signals).toEqual([]);
    const invalid = (await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(BADPOLICY))).body as Record<string, any>;
    expect(invalid.verdict).toBe("red_code_reachable");
    expect(invalid.env_policy).toBe("invalid");
  });

  it("CONTROL a gap with no evidence_resolve is refused by name, nothing run, nothing written", async () => {
    fresh(C1_RAW, { edit_site: `repos/${VESSEL}/src/widget.ts` });
    const r = await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER));
    expect(r.shape).toBe("structuredError");
    expect(world.writes).toEqual([]);
  });
});

describe("the re-measure grades its predecessor only when admission consumed it", () => {
  const prev = (consumed: boolean, verdict = "red_environmental", env_signals = ["S_live_import", "S_empty_received", "S_count_expected"]) => ({
    gap_id: "ocb-gap-1", vessel: VESSEL, test_file: "test/phase5.test.ts", only_tests: ["phase5 > returns traces"], base_sha: OLD, verdict, red: ["phase5 > returns traces"], failing: [], expect_count: 1,
    call_path: [], call_path_source: null, env_signals, env_policy: "policy", dispatch_id: "d-old", measured_at: "2026-01-01T00:00:00Z",
    ...(consumed ? { consumed: { by: "admission", at: "2026-01-01T00:01:00Z" } } : {}),
  });
  const run = async (meta: Record<string, unknown>, raw: string) => {
    credit.__resetBaselineCreditForTests();
    const posts: Array<Record<string, any>> = [];
    fresh(raw, meta, { "test/phase5.test.ts": C1_CHECK });
    await mod.resolveOwnCheckBaselineClassify({ gap_id: "ocb-gap-1", base_ref: SHA }, deps(SUPER, { credit: { post: async (t: Record<string, any>) => { posts.push(t); return 200; }, executionIdOf: async () => "exec-old", markPaid: async () => {} } }));
    return posts;
  };
  const meta = (p: Record<string, unknown>) => ({ ...check("test/phase5.test.ts", ["phase5 > returns traces"]), own_check_baseline: p, own_check_baseline_dispatches: [{ base_sha: OLD, dispatch_id: "d-old" }] });

  it("a consumed environmental reading, environmental again at the new sha: one agreeing post on the old execution", async () => {
    const posts = await run(meta(prev(true)), C1_RAW);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.success).toBe(true);
    expect(posts[0]!.composition_chain).toEqual(["exec-old"]);
  });
  it("a consumed environmental reading that re-measures green: one disagreeing post", async () => {
    const posts = await run(meta(prev(true)), GREEN_RAW);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.success).toBe(false);
    expect(posts[0]!.tags).toContain("reached:false");
  });
  it("CONTROL an unconsumed predecessor is never graded", async () => {
    expect(await run(meta(prev(false)), C1_RAW)).toEqual([]);
  });
});
