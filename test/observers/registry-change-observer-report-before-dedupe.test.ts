import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// A probe success used to re-run the FULL reachable_unlearned_report (it pages the whole template catalogue) BEFORE
// the 60 s dedupe check, so every lifecycle event for a probe template paid for a catalogue-wide scan even when the
// dispatch was then deduped; and the topology chain ran the same report twice (fan-out + probe).
// Mock resolveDispatch BEFORE importing the observer so the module binds to the mock (Bun hoists mock.module).
const dispatchCalls: Array<Record<string, unknown>> = [];

mock.module("../../src/routes/impulses.js", () => ({
  resolveDispatch: async (payload: Record<string, unknown>) => {
    dispatchCalls.push(payload);
    const t = payload["type"] as string;
    if (t === "reachable_unlearned_report") {
      return { shape: "reachableButUnlearnedReport", body: { total: 3, top_template_id: "development-vessel:some-producer" } };
    }
    return { shape: t, body: {} };
  },
}));

const { dispatchRecommendationForProbe, _resetDispatchDedupe, runTopologyChain, resetAggregatorDebounce } = await import(
  "../../src/observers/registry-change-observer.js"
);

const PROBE = "development-vessel:probe-reachable-unlearned";
const realFetch = globalThis.fetch;
const realNow = Date.now;
let runGoalPosts = 0;

function reportCalls(): number {
  return dispatchCalls.filter((c) => c["type"] === "reachable_unlearned_report").length;
}

describe("registry-change-observer: a probe report runs at most once per 60 s window, checked before the report", () => {
  beforeEach(() => {
    dispatchCalls.length = 0;
    runGoalPosts = 0;
    _resetDispatchDedupe();
    resetAggregatorDebounce();
    globalThis.fetch = (async () => {
      runGoalPosts++;
      return new Response(JSON.stringify({ dispatchId: `d${runGoalPosts}` }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  });

  it("MUST-FAIL: 16 probe-success events inside 60 s run the report ONCE, not 16 times", async () => {
    const results = [];
    for (let i = 0; i < 16; i++) results.push(await dispatchRecommendationForProbe(PROBE, `exec-${i}`));
    expect(reportCalls()).toBe(1);
    expect(results.filter((r) => r.dispatched).length).toBe(1);
    expect(results.slice(1).every((r) => r.reason === "deduped")).toBe(true);
    expect(runGoalPosts).toBe(1);
  });

  it("MUST-FAIL: replays of one probe execution inside 60 s run the report ONCE", async () => {
    for (let i = 0; i < 5; i++) await dispatchRecommendationForProbe(PROBE, "exec-replayed");
    expect(reportCalls()).toBe(1);
  });

  it("MUST-FAIL: a topology chain runs the reachable-unlearned report once even when its total is non-zero", async () => {
    await runTopologyChain();
    expect(reportCalls()).toBe(1);
  });

  it("CONTROL: a first event still computes the report and dispatches its top template", async () => {
    const r = await dispatchRecommendationForProbe(PROBE, "exec-2");
    expect(reportCalls()).toBe(1);
    expect(r.dispatched).toBe(true);
    expect(r.targetTemplateId).toBe("development-vessel:some-producer");
    expect(r.dispatchId).toBe("d1");
    expect(runGoalPosts).toBe(1);
  });

  it("CONTROL: an event after the dedupe window recomputes the report", async () => {
    let t = realNow();
    Date.now = () => t;
    await dispatchRecommendationForProbe(PROBE, "exec-3");
    expect(reportCalls()).toBe(1);
    t += 61_000;
    const r = await dispatchRecommendationForProbe(PROBE, "exec-3");
    expect(reportCalls()).toBe(2);
    expect(r.dispatched).toBe(true);
  });

  it("CONTROL: another vessel's probe template has its own window", async () => {
    await dispatchRecommendationForProbe(PROBE, "exec-4");
    const r = await dispatchRecommendationForProbe("other-vessel:probe-reachable-unlearned", "exec-5");
    expect(reportCalls()).toBe(2);
    expect(r.dispatched).toBe(true);
  });
});
