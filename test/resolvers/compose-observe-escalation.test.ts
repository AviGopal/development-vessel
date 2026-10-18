// AN OBSERVE COMPOSE ESCALATES NOTHING, TEACHES NO FILE AND IS NOT COUNTED BY A DETECTOR (src/resolvers/compose-observe.ts).
//
// qa on the observe-mode commit: a repeated refusal in feature_compose (the no-effect region site and the must_be_called
// constraint site) handed the gap to gap-to-feature's escalateToDecomposition, which stamps chronic_escalation through a
// raw gap-store write, runs decomposeGap (child gaps) and POSTs goal-host /run-goal "investigate and decompose" with no
// learning_mode: a learn dispatch from inside a probe. Both sites now hand escalateComposeRefusal, which returns before
// that path under observe. CONTRACT pinned here:
//   - [MUST-FAIL] observe: a repeated no-effect refusal and a repeated constraint refusal make no gap write (the store
//     file is byte-identical, no chronic_escalation), no decomposeGap (no LLM lookup) and no /run-goal; the refusals
//     themselves are still returned;
//     [CONTROL] learn: the same repeated refusal escalates (chronic_escalation stamped, decomposition looked up);
//     [CONTROL] the old wiring (escalateToDecomposition handed directly) under observe still writes and dispatches here,
//     so a zero above is the fix, not a harness that cannot see a write;
//   - [MUST-FAIL] both escalate sites go through escalateComposeRefusal (each keeps its own escalateToDecomposition edge,
//     which judge-modules-closed pins); no escalateToDecomposition call in the file is outside it;
//   - [MUST-FAIL] an observe compose's refusal journal line is not counted by the refusals-not-recorded detector;
//     [CONTROL] a learn compose's is;
//   - [MUST-FAIL] the files a grader or learner reads are not written under observe (compose report,
//     compose-file-lessons, locality shadow log, busy-refusals) and author_composed_capability is not delegated to.
// Harness: escalate-decomposition-guard.test.ts's (the real store under a temp root, fetch standing in for discovery's
// LLM lookup and goal-host's /run-goal).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `compose-observe-esc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const fc = await import("../../src/resolvers/feature-compose.js");
const co = await import("../../src/resolvers/compose-observe.js");
const re = await import("../../src/resolvers/retry-evidence.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
/** Each site's callback as feature-compose.ts builds it: the lane's escalation, behind escalateComposeRefusal. */
const siteEscalate = (g: Record<string, unknown>, why: string): Promise<string> => fc.escalateComposeRefusal(async () => g2f.escalateToDecomposition(g, why));
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const FC_SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
const RUN = Math.random().toString(36).slice(2, 8);

const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
const originalFetch = globalThis.fetch;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
let llmLookups = 0;
let runGoals = 0;
let storeFile = "";
let storeBefore: string | null = null;

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  storeFile = join(root, "gaps", "gaps.json");
  try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const policy = explicitOpenPolicy(body);
    if (policy) return policy;
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") llmLookups++;
      return Response.json({ content: { vessels: [] } });
    }
    if (url.endsWith("/run-goal")) { runGoals++; return Response.json({ ok: true }); }
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function stored(suffix: string): Promise<Record<string, unknown>> {
  const gap = { id: `obs-esc-${suffix}-${RUN}`, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `stuck gap ${suffix}`, classification_metadata: { edit_site: "repos/fixture-vessel/src/x.ts" } };
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  return gap;
}
async function storedMeta(id: string): Promise<Record<string, unknown>> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((g) => g.id === id);
  return (row?.classification_metadata ?? {}) as Record<string, unknown>;
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const observe = <T>(fn: () => Promise<T>): Promise<T> => co.composeObserveContext.run({ observe: true, announced: new Set() }, fn);
const learn = <T>(fn: () => Promise<T>): Promise<T> => co.composeObserveContext.run({ observe: false, announced: new Set() }, fn);
const refusal = (sha: string) => ({ path: "repos/fixture-vessel/src/x.ts", start: 4, end: 4, region_sha: sha, region_start: 3, region_end: 5 });
const noEffectLessons = (sha: string) => [{ at: new Date().toISOString(), class: "no_effect_region", stage: "apply", edited_spans: [], refusals: [refusal(sha)] }];
const constraint = { kind: "must_be_called" as const, symbol: "fixtureHelper", introduced_in: "repos/fixture-vessel/src/x.ts" };
const constraintLessons = [{ at: new Date().toISOString(), class: "constraint_unmet", stage: "own_check", edited_spans: [], refusals: [re.mustBeCalledRefusalRecord(constraint)] }];

describe("a repeated refusal in an observe compose escalates nothing", () => {
  it("[MUST-FAIL] observe, no-effect site: no gap write, no decomposeGap, no /run-goal", async () => {
    const g = await stored("noeffect-observe");
    const before = readFileSync(storeFile, "utf8");
    const l0 = llmLookups, r0 = runGoals;
    const esc = await observe(() => re.escalateRepeatedRefusal(g, noEffectLessons("sha-a"), [refusal("sha-a")], siteEscalate));
    await settle();
    expect(esc?.outcome).toBe("not dispatched: observe: dry run, not landed");
    expect([llmLookups - l0, runGoals - r0]).toEqual([0, 0]);
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect((await storedMeta(String(g.id))).chronic_escalation).toBeUndefined();
  });
  it("[MUST-FAIL] observe, constraint site: the refusals are returned, nothing is written or dispatched", async () => {
    const g = await stored("constraint-observe");
    const before = readFileSync(storeFile, "utf8");
    const l0 = llmLookups, r0 = runGoals;
    const ce = await observe(() => re.constraintRefusalEvidence([{ constraint_unmet: [constraint] }], g, constraintLessons, siteEscalate));
    await settle();
    expect(ce.refusals.length).toBe(1);
    expect(ce.escalation?.outcome).toBe("not dispatched: observe: dry run, not landed");
    expect([llmLookups - l0, runGoals - r0]).toEqual([0, 0]);
    expect(readFileSync(storeFile, "utf8")).toBe(before);
    expect((await storedMeta(String(g.id))).chronic_escalation).toBeUndefined();
  });
  it("[CONTROL] learn: the same repeated refusal escalates (chronic_escalation stamped, decomposition looked up)", async () => {
    const g = await stored("noeffect-learn");
    const l0 = llmLookups;
    const esc = await learn(() => re.escalateRepeatedRefusal(g, noEffectLessons("sha-b"), [refusal("sha-b")], siteEscalate));
    await settle();
    expect(esc?.outcome).toBe("dispatched: decomposition, then investigation");
    expect(llmLookups - l0).toBeGreaterThanOrEqual(1);
    expect((await storedMeta(String(g.id))).chronic_escalation).toBeDefined();
  });
  it("[CONTROL] the bypass qa found is visible to this harness: escalateToDecomposition itself, under observe, writes and dispatches", async () => {
    const g = await stored("bypass-observe");
    const before = readFileSync(storeFile, "utf8");
    const l0 = llmLookups;
    const esc = await observe(() => re.escalateRepeatedRefusal(g, noEffectLessons("sha-c"), [refusal("sha-c")], (gap, why) => g2f.escalateToDecomposition(gap, why)));
    await settle();
    expect(esc?.outcome).toBe("dispatched: decomposition, then investigation");
    expect(llmLookups - l0).toBeGreaterThanOrEqual(1);
    expect(readFileSync(storeFile, "utf8")).not.toBe(before);
    expect((await storedMeta(String(g.id))).chronic_escalation).toBeDefined();
  });
  it("[MUST-FAIL] both escalate sites go through escalateComposeRefusal; every escalateToDecomposition call is behind it", () => {
    const site = 'escalateComposeRefusal(async () => (await import("./gap-to-feature.js")).escalateToDecomposition(g, why))';
    expect(FC_SRC).toContain(`const escalation = await escalateRepeatedRefusal(row, ownLessons, noEffectRefusals, (g, why) => ${site});`);
    expect(FC_SRC).toContain(`const ce = await constraintRefusalEvidence(verify, row, ownLessons, (g, why) => ${site});`);
    expect(FC_SRC.match(/\.escalateToDecomposition\(/g)?.length).toBe(FC_SRC.split(site).length - 1);
    expect(FC_SRC).toMatch(/export async function escalateComposeRefusal\([^\n]*\n\s*if \(composeObserveSkip\("escalation"\)\) return [^\n]*\n\s*return escalate\(\);/);
  });
});

describe("an observe compose's refusal journal line is not counted against the store", () => {
  const line = () => re.refusalJournalLine("op", "obs-journal-gap", "NO-EFFECT REGION REFUSED repos/fixture-vessel/src/x.ts:4-4 (locked 3-5)");
  it("[MUST-FAIL] observe: refusals-not-recorded counts nothing for it", async () => {
    const counted = await observe(async () => re.refusalJournalCounts([co.observeJournalLine(line())]));
    expect(counted.size).toBe(0);
    expect(FC_SRC).toContain("console.warn(observeJournalLine(refusalJournalLine(site, String(pointer.gap?.id ?? \"\"), detail)));");
  });
  it("[CONTROL] learn: the same line is counted", async () => {
    const counted = await learn(async () => re.refusalJournalCounts([co.observeJournalLine(line())]));
    expect(counted.get("obs-journal-gap")).toBe(1);
  });
});

describe("an observe compose writes no file a grader or learner reads, and mints nothing", () => {
  /** The guard appears once, and the write it guards follows within `span` characters. */
  const guarded = (guard: string, write: string, span = 700): void => {
    const g = FC_SRC.indexOf(guard);
    expect(g, `guard not found: ${guard}`).toBeGreaterThanOrEqual(0);
    expect(FC_SRC.indexOf(guard, g + 1), `guard not unique: ${guard}`).toBe(-1);
    const w = FC_SRC.indexOf(write, g);
    expect(w, `write not found after its guard: ${write}`).toBeGreaterThan(g);
    expect(w - g).toBeLessThan(span);
  };
  it("[MUST-FAIL] the compose report (goal-host's reconciler grades from it) is not written", () => {
    guarded('if (!composeObserveSkip("compose_report")) try {', "let reportPath = join(reportDir,", 900);
  });
  it("[MUST-FAIL] compose-file-lessons (the next drafter's prompt reads it) is not appended", () => {
    guarded('&& !composeObserveSkip("compose_file_lesson")) {', "appendFileLesson(COMPOSE_FILE_LESSONS_PATH,");
  });
  it("[MUST-FAIL] the locality shadow log (the miner measures agreement from it) is not appended", () => {
    guarded('if (!composeObserveSkip("locality_shadow_log")) try {', '"/workspace/locality/shadow-log.jsonl"', 1200);
  });
  it("[MUST-FAIL] busy-refusals (self_interference_scan files a gap from it) is not appended", () => {
    guarded('if (!composeObserveSkip("busy_refusal")) try {', '"/workspace/proposals/busy-refusals.jsonl"');
  });
  it("[MUST-FAIL] author_composed_capability is not delegated to; the report says what would have been", () => {
    guarded('if (composeObserveSkip("author_composed_capability")) {', 'pointer: { type: "author_composed_capability"', 900);
    expect(FC_SRC).toContain('...observeReportFields([]), would_delegate: { type: "author_composed_capability", goal: _delegateGoal } } };');
  });
});
