// AN ARMING IS CLASSIFIED AGAINST WHAT ITS INSTRUMENT RETURNS (substrate-gap.ts RESPONSE CONTRACTS).
// Measured on one node over 24 h: 78 of 95 [gap-birth] evaluations read unknown, and most could never read anything
// else: the check named a field its instrument never returns (git_log zero_field "count"), or a test_suite file bun
// cannot run (a super-repo *.check.sh) or that is not a test. An unknown birth holds a non-directed gap inadmissible
// until a re-take reads present, so those gaps were held for good and said nothing.
//
// Such a check is classified "unresolvable" through the existing falsifier classification (falsifier_position,
// falsifier_unresolvable_reason), never birth-evaluated. Driven through the real write seam, the real judge (on a stub
// transport) and the real sweep; the judge is wrapped to count its calls.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "arming-contract-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { evaluateGapCheck } = await import("../../src/judge/gap-check-judge.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, class2PredicateKey, reevaluateBirthVerdicts, gapStoreRootForTest, __setFleetVocabularyForTests, RESPONSE_CONTRACT_REASON } = sg;

const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const tree: Record<string, "pass" | "fail"> = { "widget counts rejected frames": "fail" };
const stubFetch = (async (_input: unknown, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (body?.pointer?.type === "vesselCapability") {
    const vessels = [{ vesselId: "dv", endpoint: "http://pool.test", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }];
    return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  const p = body?.impulse?.pointer;
  if (p?.type === "test_suite") {
    const only = (p.only_tests ?? []) as string[];
    const notPassing = only.filter((t) => tree[t] !== "pass").length;
    return Response.json({ shape: "test_suite", body: { ran: true, total: only.length, pass: only.length - notPassing, fail: notPassing, requested_not_passing: only.length > 0 ? notPassing : null } });
  }
  if (p?.type === "goal_reach_verdict") return Response.json({ shape: "goalReachVerdict", body: { measured: true, goal_hash: p.goal_hash, runs: 3, unreached_since_last_reach: 3 } });
  if (p?.type === "git_log") return Response.json({ shape: "commandResult", body: { exitCode: 0, stdout: "fix: x\n", stderr: "", cwd: "/x" } });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;
const judged: string[] = [];
const countingJudge = (g: Record<string, unknown>) => { judged.push(String(g["id"])); return evaluateGapCheck(g, { fetchImpl: stubFetch }); };

const validTestSuite = (name: string) => ({ shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: [name], timeout_ms: 180000 }, zero_field: "requested_not_passing" });
// Shaped like the store's real unknown rows (field names and inputs as armed).
const gitLogCount = { shape: "git_log", input: { repo: "analysis-vessel", grep: "index.ts" }, zero_field: "count" };
const testReportNonField = { shape: "test_report", input: {}, zero_field: "number_of_queued_write_attempts" };
const testSuiteShellCheck = { shape: "test_suite", input: { vessel: "super-repo", test_file: "validation/scripts/substrate-status-keyless-spoke-fails-fast.check.sh" } };
const testSuiteShellCheckArmed = { shape: "test_suite", input: { vessel: "super-repo", test_file: "validation/scripts/gen-env-sibling-derivation-foreign-fleet.check.sh", only_tests: ["the sibling is not derived"] }, zero_field: "requested_not_passing" };
const testSuiteSourceNonField = { shape: "test_suite", input: { vessel: "development-vessel", test_file: "src/resolvers/test-suite.ts" }, zero_field: "test_suite_produced_no_countable_pass_fail_summary" };
const goalReachValid = { shape: "goal_reach_verdict", input: { goal_hash: "8202213c" }, zero_field: "unreached_since_last_reach" };

async function write(id: string, er: Record<string, unknown>): Promise<void> {
  const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id} for the arming tests`, detected_at: new Date().toISOString(), classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", evidence_resolve: er } } } as never, { vocabulary: null, birthJudge: countingJudge } as never);
  expect(res.shape).not.toBe("structuredError");
}
async function row(id: string): Promise<Record<string, unknown>> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error("row not found: " + id);
  return g;
}
const metaOf = (g: Record<string, unknown>) => (g.classification_metadata ?? {}) as Record<string, unknown>;
async function bornLogged(id: string, er: Record<string, unknown>): Promise<{ g: Record<string, unknown>; lines: string[] }> {
  const spy = spyOn(console, "log");
  try {
    await write(id, er);
    await __settleBirthEvaluationsForTests();
    return { g: await row(id), lines: spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`[gap-birth] ${id}:`)) };
  } finally { spy.mockRestore(); }
}

beforeAll(() => {
  for (const k of ["VESSELS_CLONE_ROOT", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "no-clones");
  mkdirSync(join(ROOT, "no-clones"), { recursive: true });
  globalThis.fetch = stubFetch;
  __setFleetVocabularyForTests({ v: null }); // the fleet vocabulary cannot judge here: only the response contracts can
  __resetPolicyReadsForTests();
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await __settleBirthEvaluationsForTests();
  globalThis.fetch = originalFetch;
  __setFleetVocabularyForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const contractReason = (m: Record<string, unknown>): string => String(m.falsifier_unresolvable_reason ?? "");

describe("an arming is classified at the write seam against what its instrument returns", () => {
  it("(a) a zero_field the instrument never returns (git_log count) is classified unresolvable, not run, and its [gap-birth] line says so", async () => {
    const id = `arm-gitlog-${RUN}`;
    const before = judged.length;
    const { g, lines } = await bornLogged(id, gitLogCount);
    const m = metaOf(g);
    expect(m.falsifier).toBe("unresolvable");
    expect(m.falsifier_position).toBe("evidence_resolve.zero_field");
    expect(contractReason(m).startsWith(RESPONSE_CONTRACT_REASON)).toBe(true);
    expect(contractReason(m)).toContain(`zero_field "count" is not a field git_log returns`);
    expect(m.predicate_birth_verdict).toBeUndefined(); // never birth-evaluated
    expect(judged.slice(before)).not.toContain(id);
    expect(lines.some((l) => l.includes("not evaluated: falsifier unresolvable"))).toBe(true);
  });

  it("(a) a test_suite zero_field it never returns, on a source file that is not a test, is classified unresolvable", async () => {
    const id = `arm-source-${RUN}`;
    const { g } = await bornLogged(id, testSuiteSourceNonField);
    expect(metaOf(g)).toMatchObject({ falsifier: "unresolvable", falsifier_position: "evidence_resolve.zero_field" });
  });

  it("(b) a test_suite arming at a super-repo .check.sh is classified unresolvable at input.test_file", async () => {
    for (const [n, er] of [["bare", testSuiteShellCheck], ["armed", testSuiteShellCheckArmed]] as const) {
      const id = `arm-checksh-${n}-${RUN}`;
      const before = judged.length;
      const { g } = await bornLogged(id, er);
      expect(metaOf(g)).toMatchObject({ falsifier: "unresolvable", falsifier_position: "evidence_resolve.input.test_file" });
      expect(contractReason(metaOf(g))).toContain("shell script");
      expect(judged.slice(before)).not.toContain(id);
    }
  });

  it("control: a valid arming (zero_field requested_not_passing + only_tests) is class2, run, and born present exactly as before", async () => {
    const id = `arm-valid-${RUN}`;
    const before = judged.length;
    const { g } = await bornLogged(id, validTestSuite("widget counts rejected frames"));
    expect(judged.slice(before)).toContain(id);
    expect(metaOf(g)).toMatchObject({ falsifier: "class2", predicate_birth_verdict: "present" });
    expect(metaOf(g).falsifier_unresolvable_reason).toBeUndefined();
  });

  it("control: a valid goal_reach_verdict arming (a field returned only when measured) and a shape with no contract are class2 and run", async () => {
    for (const [n, er] of [["grv", goalReachValid], ["nocontract", testReportNonField]] as const) {
      const id = `arm-ctl-${n}-${RUN}`;
      const before = judged.length;
      const { g } = await bornLogged(id, er);
      expect({ n, falsifier: metaOf(g).falsifier }).toEqual({ n, falsifier: "class2" });
      expect(judged.slice(before)).toContain(id);
    }
  });
});

describe("(c) the birth re-take sweep re-classifies the rows born before it", () => {
  // Rows as the store holds them today: class2, born unknown, classified before response contracts existed.
  const legacy = (id: string, er: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const meta: Record<string, unknown> = { edit_site: "repos/fixture-vessel/src/widget.ts", evidence_resolve: er, falsifier: "class2", falsifier_position: "evidence_resolve.shape", ...extra };
    return { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `legacy unknown row ${id}`, detected_at: "2026-10-19T04:00:00.000Z",
      classification_metadata: { ...meta, predicate_birth_key: class2PredicateKey(meta), predicate_birth_verdict: "unknown", predicate_birth_at: "2026-10-19T04:17:33.130Z" } };
  };
  const fixtures: Record<string, [Record<string, unknown>, string]> = {
    [`sw-gitlog-${RUN}`]: [gitLogCount, "evidence_resolve.zero_field"],
    [`sw-checksh-${RUN}`]: [testSuiteShellCheck, "evidence_resolve.input.test_file"],
    [`sw-checksh-armed-${RUN}`]: [testSuiteShellCheckArmed, "evidence_resolve.input.test_file"],
    [`sw-source-${RUN}`]: [testSuiteSourceNonField, "evidence_resolve.zero_field"],
  };
  const validIds = { ts: `sw-valid-ts-${RUN}`, grv: `sw-valid-grv-${RUN}`, lifted: `sw-lifted-${RUN}` };

  it("re-classifies each never-measurable row without running it, re-takes the valid ones, and lifts a contract verdict the contracts no longer support", async () => {
    await __settleBirthEvaluationsForTests();
    const path = join(gapStoreRootForTest(), "gaps", "gaps.json");
    const stored = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
    const lifted = legacy(validIds.lifted, validTestSuite("widget counts rejected frames"));
    // Classified unresolvable by an earlier contract, its check now measurable: lifted, then re-taken.
    Object.assign(lifted.classification_metadata, { falsifier: "unresolvable", falsifier_position: "evidence_resolve.input.test_file", falsifier_unresolvable_reason: `${RESPONSE_CONTRACT_REASON}an earlier contract` });
    const rows = [
      ...Object.entries(fixtures).map(([id, [er]]) => legacy(id, er)),
      legacy(validIds.ts, validTestSuite("widget counts rejected frames")),
      // A valid arming whose instrument answered measured:false at birth (no tally yet): an honest unknown, re-taken.
      legacy(validIds.grv, goalReachValid),
      lifted,
    ];
    writeFileSync(path, JSON.stringify([...stored, ...rows]));
    const before = judged.length;
    const spy = spyOn(console, "log");
    let taken: string[] = [];
    let lines: string[] = [];
    try { taken = await reevaluateBirthVerdicts(rows, 10, countingJudge); await __settleBirthEvaluationsForTests(); lines = spy.mock.calls.map((c) => String(c[0])); }
    finally { spy.mockRestore(); }
    const ran = judged.slice(before);
    for (const [id, [, position]] of Object.entries(fixtures)) {
      const m = metaOf(await row(id));
      expect({ id, falsifier: m.falsifier, position: m.falsifier_position }).toEqual({ id, falsifier: "unresolvable", position });
      expect(contractReason(m).startsWith(RESPONSE_CONTRACT_REASON)).toBe(true);
      expect(ran).not.toContain(id);
      expect(taken).not.toContain(id);
      expect(lines.some((l) => l.startsWith(`[gap-birth] ${id}:`) && l.includes("re-classified unresolvable"))).toBe(true);
    }
    for (const id of Object.values(validIds)) {
      const m = metaOf(await row(id));
      expect({ id, falsifier: m.falsifier, verdict: m.predicate_birth_verdict }).toEqual({ id, falsifier: "class2", verdict: "present" });
      expect(taken).toContain(id);
      expect(ran).toContain(id);
    }
  });

  it("a re-classified row is not re-taken by a later sweep (its check cannot measure until it is re-armed)", async () => {
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 500 } as never);
    const gaps = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []);
    const before = judged.length;
    const taken = await reevaluateBirthVerdicts(gaps, 10, countingJudge);
    await __settleBirthEvaluationsForTests();
    for (const id of Object.keys(fixtures)) { expect(taken).not.toContain(id); expect(judged.slice(before)).not.toContain(id); }
  });
});
