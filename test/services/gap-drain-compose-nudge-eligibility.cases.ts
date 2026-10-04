// Pins which written gaps may nudge the composer (gap_to_feature) from the gap-drain observer.
//
// THE DEFECT. On a devvessel.gap.written event for any non-dispatchable gap the observer POSTs a
// bare gap_to_feature (no gap id: the auto-pick chooses its own gap), gated only by an in-flight
// flag and a 90 s floor. It never asks the store about the gap that fired the event. Measured over
// 24 h on both nodes (realign-measure, top15-hold-check): the most-nudged ids were a gap the store
// does not hold at all (shapeA, ~20 nudges), a CLOSED gap (some-real-gap, 29/37), a REJECTED gap
// (falsifier-none-001), falsifier none (cost-model-miscalibrated, ~30) and falsifier unresolvable
// (runtime-drift-uncovered-relevance-sink-vessel, 47). None of these can be composed: the picker's
// admission refuses each, so every one of those nudges was a compose pick spent on the wrong signal.
//
// THE RULE. A written gap nudges only when its STORE ROW exists, is open, is armed (falsifier class1
// or class2, the classes the lane's admission accepts), names an edit site, and is not held
// (operator_hold, a parking disposition, or a landing awaiting its verdict). Anything else is skipped
// with a reason counter, flushed as ONE summary line per window, never a line per event.
//
// The event payload is exactly what substrate-gap.ts publishes ({gap_id, category, route, remedy,
// status}) with status "open": the event-level status check must not be what refuses a closed or
// absent gap; the store row must.
//
// ISOLATION: same discipline as gap-drain-backoff.test.ts. WORKSPACE_ROOT points at a fresh scratch
// dir before anything is imported, the suite refuses to run against a live root, and fetch is
// mocked so nothing (the nudge, an event publish) leaves the process.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const SCRATCH = mkdtempSync(join(process.env["TEST_SCRATCH_PARENT"] ?? tmpdir(), "gap-drain-nudge-"));
process.env["WORKSPACE_ROOT"] = SCRATCH;
// Route store reads through the holder-forwarding path (forwardToGapStore) so they reach the fetch mock and can be
// COUNTED: without this the read is a direct scratch-file parse and a "read once per id" assertion would be vacuous.
// Port 1 is never contacted: every fetch is mocked below.
process.env["GAP_STORE_ENDPOINT"] = "http://127.0.0.1:1/gap-store";

type Obs = { handleEvent: (e: { type: string; data: unknown }) => Promise<void> };
type GateMod = {
  GapDrainObserver: new () => unknown;
  __resetComposeNudgeGateForTests?: () => void;
  __flushComposeNudgeSkipSummaryForTests?: () => void;
};
let mod: GateMod;
let makeObserver: () => Obs;
let ROOT = "";
let priorStore: string | null = null;

function isScratchRoot(root: string): boolean {
  const r = resolve(root);
  if (r === "/workspace" || r.startsWith("/workspace/") || r.includes("super-repo")) return false;
  if (r === resolve(process.cwd())) return false;
  const parents = [tmpdir(), process.env["TEST_SCRATCH_PARENT"] ?? ""].filter((x) => x.length > 0).map((x) => resolve(x));
  return parents.some((p) => r === p || r.startsWith(p + sep)) || r.includes(`${sep}tmp${sep}`);
}

beforeAll(async () => {
  const cfg = await import("../../src/config.js");
  const sg = await import("../../src/resolvers/substrate-gap.js");
  const root = cfg.WORKSPACE_ROOT;
  if (root !== sg.gapStoreRootForTest() || !isScratchRoot(root)) {
    throw new Error(
      `gap-drain-compose-nudge: WORKSPACE_ROOT is not a scratch dir (config=${cfg.WORKSPACE_ROOT}, gap store=${sg.gapStoreRootForTest()}); refusing to write a gap store.`,
    );
  }
  ROOT = root;
  try {
    priorStore = readFileSync(join(ROOT, "gaps", "gaps.json"), "utf8");
  } catch {
    priorStore = null;
  }
  mod = (await import("../../src/services/gap-drain-observer.js")) as unknown as GateMod;
  makeObserver = () => new mod.GapDrainObserver() as unknown as Obs;
});

afterAll(() => {
  if (ROOT !== "" && priorStore !== null) writeFileSync(join(ROOT, "gaps", "gaps.json"), priorStore, "utf8");
  if (SCRATCH.includes("gap-drain-nudge-")) rmSync(SCRATCH, { recursive: true, force: true });
});

type Call = { url: string; impulse: Record<string, unknown> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
const g = globalThis as unknown as { __composeDrainInflight?: boolean; __composeDrainLastAt?: number };

function writeGapStore(rows: Array<Record<string, unknown>>): void {
  if (ROOT === "") throw new Error("no scratch root; refusing to write a gap store");
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  writeFileSync(join(ROOT, "gaps", "gaps.json"), JSON.stringify(rows, null, 2), "utf8");
}

function readGapStore(): Array<Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(join(ROOT, "gaps", "gaps.json"), "utf8")) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function drainLog(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(ROOT, "pool", "drain-log.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function clearDrainLog(): void {
  mkdirSync(join(ROOT, "pool"), { recursive: true });
  writeFileSync(join(ROOT, "pool", "drain-log.jsonl"), "", "utf8");
}

function gapRow(id: string, over: Record<string, unknown>, meta: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    category: "compose_nudge_probe",
    source: "substrate_detected",
    status: "open",
    summary: `probe gap ${id}`,
    detected_at: now,
    created_at: now,
    updated_at: now,
    ...over,
    classification_metadata: meta,
  };
}

const ARMED = { falsifier: "class2", edit_site: "repos/development-vessel/src/services/gap-drain-observer.ts" };

/** The devvessel.gap.written event as substrate-gap.ts publishes it, for a composable (non-dispatchable) gap. */
function writtenEvent(id: string): { type: string; data: unknown } {
  return { type: "devvessel.gap.written", data: { gap_id: id, category: "compose_nudge_probe", status: "open" } };
}

const nudges = () => calls.filter((c) => c.impulse["type"] === "gap_to_feature");
const nudgedLines = () => drainLog().filter((l) => l["action"] === "compose_nudged");
const summaries = () => drainLog().filter((l) => l["action"] === "compose_nudge_skipped_summary");

beforeEach(() => {
  calls = [];
  g.__composeDrainInflight = false;
  g.__composeDrainLastAt = undefined;
  mod.__resetComposeNudgeGateForTests?.();
  clearDrainLog();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let parsed: { impulse?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      /* not JSON */
    }
    const impulse = (parsed.impulse ?? {}) as Record<string, unknown>;
    calls.push({ url, impulse });
    if (impulse["type"] === "gap_to_feature") {
      return new Response(JSON.stringify({ success: true, shape: "gapToFeatureReport", body: {} }), { status: 200 });
    }
    const ptr = ((impulse["pointer"] ?? impulse) as Record<string, unknown>);
    if (ptr["type"] === "substrateGap") {
      const want = (ptr["id"] ?? ptr["gap_id"]) as string | undefined;
      if (want === "nudge-probe-read-fails") {
        return new Response(JSON.stringify({ shape: "structuredError", body: { detail: "holder unreachable" } }), { status: 502 });
      }
      const rows = readGapStore().filter((r) => want === undefined || r["id"] === want);
      return new Response(JSON.stringify({ success: true, shape: "substrateGap", body: { gaps: rows, total: rows.length } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, body: {} }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function expectSkipped(id: string, reason: string): Promise<void> {
  await makeObserver().handleEvent(writtenEvent(id));
  expect(nudges().length).toBe(0);
  expect(nudgedLines().length).toBe(0);
  // No line per event: the skip is only a counter until the window flushes.
  expect(drainLog().length).toBe(0);
  mod.__flushComposeNudgeSkipSummaryForTests?.();
  const s = summaries();
  expect(s.length).toBe(1);
  expect((s[0]!["skipped"] as Record<string, number>)[reason]).toBe(1);
}

describe("gap-drain observer: a written gap the lane cannot compose never nudges the composer", () => {
  test("a CLOSED gap (some-real-gap-like) is not nudged; counted not_open", async () => {
    const id = "nudge-probe-closed";
    writeGapStore([gapRow(id, { status: "closed" }, { falsifier: "none" })]);
    await expectSkipped(id, "not_open");
  });

  test("an id the store does not hold (shapeA-like) is not nudged; counted not_found", async () => {
    writeGapStore([gapRow("nudge-probe-some-other-gap", {}, ARMED)]);
    await expectSkipped("nudge-probe-absent", "not_found");
  });

  test("an open gap with falsifier none (cost-model-miscalibrated-like) is not nudged; counted unarmed", async () => {
    const id = "nudge-probe-falsifier-none";
    writeGapStore([gapRow(id, {}, { falsifier: "none", edit_site: ARMED.edit_site })]);
    await expectSkipped(id, "unarmed");
  });

  test("an open gap with falsifier unresolvable (runtime-drift-…-like) is not nudged; counted unarmed", async () => {
    const id = "nudge-probe-falsifier-unresolvable";
    writeGapStore([gapRow(id, {}, { falsifier: "unresolvable", edit_site: ARMED.edit_site })]);
    await expectSkipped(id, "unarmed");
  });

  test("an armed open gap with no edit site is not nudged; counted no_edit_site", async () => {
    const id = "nudge-probe-no-site";
    writeGapStore([gapRow(id, {}, { falsifier: "class2" })]);
    await expectSkipped(id, "no_edit_site");
  });

  test("an armed open gap under operator_hold is not nudged; counted held", async () => {
    const id = "nudge-probe-held";
    writeGapStore([gapRow(id, {}, { ...ARMED, operator_hold: true })]);
    await expectSkipped(id, "held");
  });

  test("a burst of skips writes one summary line carrying every reason, not a line per event", async () => {
    writeGapStore([
      gapRow("b-closed", { status: "closed" }, ARMED),
      gapRow("b-none", {}, { falsifier: "none", edit_site: ARMED.edit_site }),
      gapRow("b-unres", {}, { falsifier: "unresolvable", edit_site: ARMED.edit_site }),
    ]);
    const obs = makeObserver();
    for (const id of ["b-closed", "b-none", "b-unres", "b-absent", "b-absent"]) await obs.handleEvent(writtenEvent(id));
    expect(nudges().length).toBe(0);
    expect(drainLog().length).toBe(0);
    mod.__flushComposeNudgeSkipSummaryForTests?.();
    const s = summaries();
    expect(s.length).toBe(1);
    expect(s[0]!["skipped"]).toEqual({ not_found: 2, not_open: 1, unarmed: 2, no_edit_site: 0, held: 0, read_failed: 0 });
    // The store is read once per distinct gap within a window, not once per event: 4 ids, 5 events.
    expect(calls.filter((c) => ((c.impulse["pointer"] ?? c.impulse) as Record<string, unknown>)["type"] === "substrateGap").length).toBe(4);
  });
});

describe("gap-drain observer: a failed store read is not absence", () => {
  test("a read the holder cannot answer is not nudged; counted read_failed, not not_found", async () => {
    writeGapStore([gapRow("nudge-probe-read-fails", {}, ARMED)]);
    await expectSkipped("nudge-probe-read-fails", "read_failed");
  });
});

describe("gap-drain observer: control", () => {
  test("an armed open gap with an edit site IS nudged", async () => {
    const id = "nudge-probe-armed";
    writeGapStore([gapRow(id, {}, ARMED)]);
    await makeObserver().handleEvent(writtenEvent(id));
    expect(nudges().length).toBe(1);
    expect(nudgedLines().length).toBe(1);
    expect(nudgedLines()[0]!["gap_id"]).toBe(id);
  });

  test("an armed open class1 gap with an edit site IS nudged", async () => {
    const id = "nudge-probe-armed-class1";
    writeGapStore([gapRow(id, {}, { ...ARMED, falsifier: "class1" })]);
    await makeObserver().handleEvent(writtenEvent(id));
    expect(nudges().length).toBe(1);
  });
});
