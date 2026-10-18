// The trend-expectation battery dispatches ONE batch per cadence, as a probe nothing learns from.
//
// THE DEFECT. The battery's tick ran every two minutes, while one batch waits up to five minutes per probe. It
// wrote the family's last_run_at only AFTER the batch, so each tick in between read the old stamp and dispatched a
// batch of its own: 210 executions in about an hour. Its dispatches carried the tag operator:trend-expectation-check
// and no learning_mode, so the walks they caused grew paths, fed extraction and moved posteriors, and dominated the
// reach metrics the battery exists to measure.
//
// MUST-FAIL: two ticks inside one cadence dispatch exactly ONE batch, both when they overlap in one process (the
// interval firing during a batch) and when a second process starts mid-batch (a restart). CONTROLS: the probe still
// runs, still writes and byte-verifies its own trendcheck note, and still files and closes the gap it owns; each
// dispatch is tagged probe:trend-expectation-check and carries learning_mode "observe" at the top level of the body.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrendExpectationDeps } from "../../src/observers/trend-expectation-check";

// Loaded tolerantly, as test/long-running-in-flight.test.ts does: before the fix the tick is inline in index.ts and
// this module does not exist, so each test fails by name on its absence instead of the file failing to load.
const mod = (await import("../../src/observers/trend-expectation-check").catch(() => null)) as
  | { createTrendExpectationCheck?: (deps: TrendExpectationDeps) => () => Promise<void> }
  | null;
function createTrendExpectationCheck(deps: TrendExpectationDeps): () => Promise<void> {
  expect(typeof mod?.createTrendExpectationCheck).toBe("function");
  return mod!.createTrendExpectationCheck!(deps);
}

const TREND = "expectation-trend:product";

/** One shared memory store, a producer that answers each probe, and a gate on the poll's sleep. */
function harness(opts: { correct?: boolean; dropWritesWhileHeld?: boolean } = {}) {
  const notes = new Map<string, string>();
  const runGoalBodies: Array<Record<string, unknown>> = [];
  const gaps: Array<Record<string, unknown>> = [];
  let correct = opts.correct ?? true;
  let release: () => void = () => {};
  let gate: Promise<void> | null = null;
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/run-goal")) {
      runGoalBodies.push(body);
      const goal = String(body.goal ?? "");
      const m = goal.match(/product (\d+)\*(\d+)/);
      const t = goal.match(/titled (\S+)\.$/);
      if (m && t) notes.set(t[1]!, correct ? String(Number(m[1]) * Number(m[2])) : "0");
      return new Response(JSON.stringify({ dispatchId: `d-${runGoalBodies.length}` }));
    }
    if (u.includes("/executions/")) return new Response(JSON.stringify({ status: "completed" }));
    if (u.endsWith("/v2/impulses/resolve")) {
      const note = (body.note ?? {}) as { id?: string; retire?: boolean };
      if (body.type === "memoryNote_write" && note.retire && note.id) notes.delete(note.id);
      return new Response(JSON.stringify({ success: true }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const deps = {
    self: "http://dv.test",
    goalHost: "http://gh.test",
    key: "",
    resolveNote: async (prefix: string) => [...notes].filter(([title]) => title.startsWith(prefix)).map(([title, body]) => ({ title, body })),
    write: async (id: string, body: string) => { if (!(opts.dropWritesWhileHeld && gate)) notes.set(id, body); },
    gapWrite: async (gap: Record<string, unknown>) => { gaps.push(gap); },
    fetch: fetchMock,
    sleep: (_ms: number) => gate ?? Promise.resolve(),
  };
  return {
    notes, runGoalBodies, gaps, deps,
    setCorrect: (v: boolean) => { correct = v; },
    hold: () => { gate = new Promise<void>((res) => { release = res; }); },
    open: () => { gate = null; release(); },
    spec: () => JSON.parse(notes.get(TREND)!) as Record<string, unknown>,
  };
}

const commit = (n = 2) => JSON.stringify({ family: "product", n, bar_min_r: n, cadence_minutes: 360 });
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(pred()).toBe(true);
}

describe("trend-expectation battery: one batch per cadence", () => {
  // The store write is dropped while the batch runs (a write that answers non-2xx does not throw), so only the
  // in-flight guard stands between the second tick and a second batch.
  test("must-fail: a tick that fires while a batch is in flight dispatches nothing", async () => {
    const h = harness({ dropWritesWhileHeld: true });
    h.notes.set(TREND, commit(2));
    const tick = createTrendExpectationCheck(h.deps);
    h.hold();
    const first = tick();
    await until(() => h.runGoalBodies.length === 1);
    const second = tick();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    h.open();
    await Promise.all([first, second]);
    expect(h.runGoalBodies.length).toBe(2);
  });

  // A fresh process holds no in-flight flag, so only the stamp written before the first dispatch stops it.
  test("must-fail: a process that starts mid-batch (a restart) waits out the cadence", async () => {
    const h = harness();
    h.notes.set(TREND, commit(2));
    const before = createTrendExpectationCheck(h.deps);
    const after = createTrendExpectationCheck(h.deps);
    h.hold();
    const first = before();
    await until(() => h.runGoalBodies.length === 1);
    const second = after();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    h.open();
    await Promise.all([first, second]);
    expect(h.runGoalBodies.length).toBe(2);
  });

  test("control: a second tick after the batch, inside the cadence, dispatches nothing", async () => {
    const h = harness();
    h.notes.set(TREND, commit(2));
    const tick = createTrendExpectationCheck(h.deps);
    await tick();
    await tick();
    expect(h.runGoalBodies.length).toBe(2);
  });
});

describe("trend-expectation battery: a probe, still a checker", () => {
  test("each dispatch is tagged probe:, not operator:, with learning_mode observe at the top level", async () => {
    const h = harness();
    h.notes.set(TREND, commit(3));
    await createTrendExpectationCheck(h.deps)();
    expect(h.runGoalBodies.length).toBe(3);
    for (const b of h.runGoalBodies) {
      expect(b.learning_mode).toBe("observe");
      expect(b.tags).toEqual(["probe:trend-expectation-check", "product"]);
      expect((b.tags as string[]).some((t) => t.startsWith("operator:"))).toBe(false);
      expect((b.variables as Record<string, unknown> | undefined)?.learning_mode).toBeUndefined();
    }
  });

  test("control: the probe still byte-verifies its own trendcheck notes, records the score, and retires them", async () => {
    const h = harness();
    h.notes.set(TREND, commit(3));
    await createTrendExpectationCheck(h.deps)();
    const s = h.spec();
    expect(s.last_score).toBe("3/3");
    expect(s.open_violation).toBe(false);
    expect((s.history as unknown[]).length).toBe(1);
    expect(typeof s.last_run_at).toBe("string");
    expect([...h.notes.keys()].filter((k) => k.startsWith("trendcheck-"))).toEqual([]);
    expect(h.gaps).toEqual([]);
  });

  test("control: a miss still files the family's gap, and a later recovery closes it", async () => {
    const h = harness({ correct: false });
    h.notes.set(TREND, commit(2));
    const tick = createTrendExpectationCheck(h.deps);
    await tick();
    expect(h.spec().last_score).toBe("0/2");
    expect(h.gaps.length).toBe(1);
    expect(h.gaps[0]!.id).toBe("gap-trend-expectation-violated-product");
    expect(h.gaps[0]!.status).toBe("open");
    // The cadence elapses; the producer recovers.
    h.notes.set(TREND, JSON.stringify({ ...h.spec(), last_run_at: new Date(Date.now() - 361 * 60000).toISOString() }));
    h.setCorrect(true);
    await tick();
    expect(h.runGoalBodies.length).toBe(4);
    expect(h.gaps.length).toBe(2);
    expect(h.gaps[1]!.status).toBe("closed");
    expect((h.gaps[1]!.classification_metadata as Record<string, unknown>).closed_by).toBe("trend_expectation_check");
    expect(h.spec().open_violation).toBe(false);
  });

  test("index.ts wires the checker to its interval and dispatches no trend probe of its own", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");
    expect(/createTrendExpectationCheck\s*\(/.test(src)).toBe(true);
    expect(/void trendExpectationTick\(\)/.test(src)).toBe(true);
    expect(src.includes("operator:trend-expectation-check")).toBe(false);
  });
});
