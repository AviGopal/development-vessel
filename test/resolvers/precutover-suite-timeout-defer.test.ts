// PRE-CUTOVER SUITE TIMEOUT DEFER (development-vessel:precutover-suite-timeout-defer, precutover-suite-timeout-defer.ts).
// A pre-cutover suite killed at its budget printed no summary, read ran:false, and the gate refused an undirected
// landing as pre_cutover_suite_not_run even when the host was contended. Variant-1 defers that case instead.
//   CONTROL: variant-0 (no mask) never defers; a would-defer case is logged as such; no trace, no state written.
//   (a) MUST-FAIL: variant-1 defers a timeout on a contended host under the cap, posts its trace, counts the deferral.
//   (b) MUST-FAIL: variant-1 refuses when any one condition is missing: not a timeout, not contended, cap reached.
//   (c) MUST-FAIL: no threshold row (or 0) is not contended, as pull-sync reads the same row.
//   (d) MUST-FAIL: the count lives in the state file, so a restarted process sees it (cap reached from the file alone).
//   (e) MUST-FAIL: the gap's next suite settles the deferral: measured -> reached:true and the count resets;
//       timed out again -> reached:false; no next suite within 24 h -> ungraded, logged.
// The mask, the tuning rows, PSI and the trace sink are seams; the state file is in a temp dir.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as d from "../../src/resolvers/precutover-suite-timeout-defer.js";

type Row = Record<string, unknown>;
const DIR = mkdtempSync(join(tmpdir(), "pstd-"));
const STATE = join(DIR, "state.json");
const T0 = Date.parse("2099-01-01T00:00:00.000Z");
const PSI_HOT = "some avg10=50.00 avg60=44.00 avg300=31.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
const PSI_IDLE = "some avg10=1.00 avg60=2.00 avg300=3.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
const mask = (variant: number): Row => ({ id: "mask-pstd", body: { activity_id: d.PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY, active_variant: variant, from: "2000-01-01T00:00:00Z", until: "2099-12-31T00:00:00Z", by: "operator:test", reason: "fixture" } });

let masks: Row[] = [];
let traces: Row[] = [];
let rows: Record<string, number | null> = {};
let psi = PSI_HOT;
let now = T0;
const logs: string[] = [];
const origLog = console.log;

beforeEach(() => {
  masks = []; traces = []; logs.length = 0; now = T0; psi = PSI_HOT;
  rows = { [d.SUITE_CONTENDED_PSI_ROW]: 30, [d.PRECUTOVER_SUITE_TIMEOUT_DEFER_MAX_ROW]: 2 };
  rmSync(STATE, { force: true });
  d.__setPrecutoverSuiteTimeoutDeferDepsForTests({
    readMasks: () => masks as never,
    postTrace: async (t) => { traces.push(t); return 201; },
    nowMs: () => now,
    psiCpu: () => psi,
    readTuning: async (name) => rows[name] ?? null,
    stateFile: STATE,
  });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  d.__setPrecutoverSuiteTimeoutDeferDepsForTests(null);
  console.log = origLog;
  rmSync(DIR, { recursive: true, force: true });
});

const decide = (timedOut = true, gapId = "gap-a") => d.precutoverSuiteTimeoutDecision({ vessel: "fixture-vessel", gapId, mitosisVersionId: "fixture-mitosis", timedOut });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the timeout-defer decision", () => {
  it("[CONTROL] variant-0: a contended timeout under the cap is NOT deferred, logged would-defer, no trace, no state written", async () => {
    const r = await decide();
    await flush();
    expect(r).toMatchObject({ variant: 0, defer: false });
    expect(r.outcome).toContain("would defer (variant-0: refused as before)");
    expect(logs.some((l) => l.includes(d.PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY) && l.includes("timed_out=true") && l.includes("psi_avg60=44") && l.includes("psi_avg300=31") && l.includes("threshold=30") && l.includes("contended=true") && l.includes("deferrals=0/2"))).toBe(true);
    expect(traces).toEqual([]);
    expect(existsSync(STATE)).toBe(false);
  });
  it("[MUST-FAIL] variant-1: a contended timeout under the cap defers, posts its trace, and counts the deferral", async () => {
    masks = [mask(1)];
    const r = await decide();
    await flush();
    expect(r).toMatchObject({ variant: 1, defer: true });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ activity_id: `${d.PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY}-v1`, input_shapes: ["test_suite"], output_shapes: ["precutoverSuiteTimeout"] });
    expect((traces[0]!.metadata as Row)["precutoverSuiteTimeout"]).toMatchObject({ variant: 1, timed_out: true, contended: true, deferrals: 0, max: 2, deferred: true, threshold: 30, psi_avg60: 44, psi_avg300: 31 });
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    expect(st.counts["gap-a"].n).toBe(1);
    expect(st.pending).toHaveLength(1);
  });
  it("[MUST-FAIL] variant-1 refuses a run that did not time out, without reading the host or the rows", async () => {
    masks = [mask(1)];
    const reads: string[] = [];
    d.__setPrecutoverSuiteTimeoutDeferDepsForTests({ readMasks: () => masks as never, postTrace: async (t) => { traces.push(t); return 201; }, nowMs: () => now, psiCpu: () => { reads.push("psi"); return psi; }, readTuning: async (name) => { reads.push(name); return rows[name] ?? null; }, stateFile: STATE });
    const r = await decide(false);
    expect(r).toMatchObject({ variant: 1, defer: false });
    expect(r.outcome).toBe("refused: did not run, not a timeout");
    expect(reads).toEqual([]);
    expect(logs.some((l) => l.includes("timed_out=false psi=not_read threshold=not_read"))).toBe(true);
  });
  it("[MUST-FAIL] variant-1 refuses a timeout on an uncontended host", async () => {
    masks = [mask(1)];
    psi = PSI_IDLE;
    const r = await decide();
    expect(r).toMatchObject({ defer: false });
    expect(r.outcome).toBe("refused: timed out without contention");
  });
  it("[MUST-FAIL] variant-1 refuses once the gap's deferrals reach the cap, and counts per gap", async () => {
    masks = [mask(1)];
    expect((await decide()).defer).toBe(true);
    expect((await decide()).defer).toBe(true);
    const third = await decide();
    expect(third.defer).toBe(false);
    expect(third.outcome).toBe("refused: deferral cap reached (2/2)");
    expect((await decide(true, "gap-b")).defer).toBe(true);
  });
  it("[MUST-FAIL] no threshold row, or 0, is not contended (pull-sync's reading of the same row)", async () => {
    masks = [mask(1)];
    rows[d.SUITE_CONTENDED_PSI_ROW] = null;
    expect((await decide()).outcome).toBe("refused: timed out without contention");
    rows[d.SUITE_CONTENDED_PSI_ROW] = 0;
    expect((await decide()).outcome).toBe("refused: timed out without contention");
    expect(logs.some((l) => l.includes("threshold=0 (row absent)"))).toBe(true);
  });
  it("[MUST-FAIL] the count is read from the state file, so a restarted process sees the cap", async () => {
    masks = [mask(1)];
    writeFileSync(STATE, JSON.stringify({ pending: [], counts: { "gap-a": { n: 2, lastMs: T0 } } }));
    const r = await decide();
    expect(r.defer).toBe(false);
    expect(r.outcome).toBe("refused: deferral cap reached (2/2)");
  });
  it("[CONTROL] a decision that throws reads variant-0, refused", async () => {
    masks = [mask(1)];
    d.__setPrecutoverSuiteTimeoutDeferDepsForTests({ readMasks: () => masks as never, postTrace: async () => 201, nowMs: () => now, psiCpu: () => psi, readTuning: async () => { throw new Error("boom"); }, stateFile: STATE });
    const r = await decide();
    expect(r.defer).toBe(false);
  });
});

describe("the consumer: the gap's next pre-cutover suite", () => {
  it("[MUST-FAIL] a next suite that measured settles the deferral reached:true and resets the gap's count", async () => {
    masks = [mask(1)];
    const r = await decide();
    d.settlePrecutoverSuiteTimeoutDefer("gap-a", { ran: true, pass: 10, fail: 1 });
    await flush();
    const credit = traces.find((t) => t["activity_id"] === d.PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY);
    expect(credit).toMatchObject({ success: true, composition_chain: [r.traceId], tags: expect.arrayContaining(["reached:true"]) });
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    expect(st.pending).toEqual([]);
    expect(st.counts["gap-a"]).toBeUndefined();
    expect(logs.some((l) => l.includes(`settled ${r.traceId} reached=true next_run=measured`))).toBe(true);
  });
  it("[MUST-FAIL] a next suite that timed out again settles reached:false and keeps the count", async () => {
    masks = [mask(1)];
    const r = await decide();
    d.settlePrecutoverSuiteTimeoutDefer("gap-a", { ran: false, timedOut: true, pass: 0, fail: 0 });
    await flush();
    const credit = traces.find((t) => t["activity_id"] === d.PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY);
    expect(credit).toMatchObject({ success: false, tags: expect.arrayContaining(["reached:false"]) });
    expect(JSON.parse(readFileSync(STATE, "utf8")).counts["gap-a"].n).toBe(1);
    expect(logs.some((l) => l.includes(`settled ${r.traceId} reached=false next_run=timed_out`))).toBe(true);
  });
  it("[MUST-FAIL] no next suite within 24 h: the deferral is logged ungraded and dropped", async () => {
    masks = [mask(1)];
    const r = await decide();
    now = T0 + 24 * 3_600_000 + 1;
    d.settlePrecutoverSuiteTimeoutDefer("gap-other", { ran: true, pass: 1, fail: 0 });
    expect(logs.some((l) => l.includes(`ungraded ${r.traceId}: no pre-cutover suite for gap gap-a within 24 h`))).toBe(true);
    expect(JSON.parse(readFileSync(STATE, "utf8")).pending).toEqual([]);
  });
  it("[CONTROL] another gap's suite settles nothing and writes no state", async () => {
    d.settlePrecutoverSuiteTimeoutDefer("gap-x", { ran: true, pass: 1, fail: 0 });
    expect(existsSync(STATE)).toBe(false);
    expect(traces).toEqual([]);
  });
});

describe("parsePsiSome", () => {
  it("reads the some line's avg60 and avg300; anything else is null", () => {
    expect(d.parsePsiSome(PSI_HOT)).toEqual({ avg60: 44, avg300: 31 });
    expect(d.parsePsiSome("not psi")).toBeNull();
  });
});
