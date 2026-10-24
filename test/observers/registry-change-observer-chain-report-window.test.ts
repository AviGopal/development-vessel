import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Every rescore event (each completion of a draft-gap-closing-activity, for one) runs the topology chain, and the
// chain's fan-out ran the full reachable_unlearned_report (it pages the whole template catalogue) with no rate check:
// two such completions seconds apart ran the report twice, though the probe path already held it to once per 60 s.
// The fan-out IS this vessel's probe-reachable-unlearned report, so it takes that probe's window.
// MUST-FAIL: two chains inside 60 s, or a chain then this vessel's probe -> the report runs ONCE.
// CONTROL: the same two chains 61 s apart -> twice; another vessel's probe keeps its own window.
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

function reportCalls(): number {
  return dispatchCalls.filter((c) => c["type"] === "reachable_unlearned_report").length;
}

describe("registry-change-observer: the topology chain's report shares the probe's 60 s window", () => {
  beforeEach(() => {
    dispatchCalls.length = 0;
    _resetDispatchDedupe();
    resetAggregatorDebounce();
    globalThis.fetch = (async () => new Response(JSON.stringify({ dispatchId: "d1" }), { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  });

  it("MUST-FAIL: two rescore chains 9 s apart run the report ONCE", async () => {
    let t = realNow();
    Date.now = () => t;
    await runTopologyChain();
    t += 9_000;
    await runTopologyChain();
    expect(reportCalls()).toBe(1);
  });

  it("MUST-FAIL: two concurrent rescore chains run the report ONCE", async () => {
    await Promise.all([runTopologyChain(), runTopologyChain()]);
    expect(reportCalls()).toBe(1);
  });

  it("MUST-FAIL: a chain then this vessel's probe success inside 60 s run the report ONCE", async () => {
    await runTopologyChain();
    const r = await dispatchRecommendationForProbe(PROBE, "exec-1");
    expect(reportCalls()).toBe(1);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe("deduped");
  });

  it("CONTROL: the same two chains 61 s apart run the report twice", async () => {
    let t = realNow();
    Date.now = () => t;
    await runTopologyChain();
    t += 61_000;
    await runTopologyChain();
    expect(reportCalls()).toBe(2);
  });

  it("CONTROL: a chain then another vessel's probe keeps that probe's own window", async () => {
    await runTopologyChain();
    const r = await dispatchRecommendationForProbe("other-vessel:probe-reachable-unlearned", "exec-2");
    expect(reportCalls()).toBe(2);
    expect(r.dispatched).toBe(true);
  });

  it("CONTROL: a probe success after the chain's window recomputes and dispatches", async () => {
    let t = realNow();
    Date.now = () => t;
    await runTopologyChain();
    t += 61_000;
    const r = await dispatchRecommendationForProbe(PROBE, "exec-3");
    expect(reportCalls()).toBe(2);
    expect(r.dispatched).toBe(true);
  });
});
