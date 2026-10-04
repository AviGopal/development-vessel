// Pins how the gap-drain observer treats a gap_to_feature dispatch that was NOT an attempt.
//
// THE DEFECT. On a devvessel.gap.written event for a route:dispatchable gap, the observer
// POSTs {type: remedy.impulse_type, triggered_by: "gap-drain", gap_id} and then does
// `if (resp.ok) __drainBackoff.delete(gapId)`. But gap_to_feature answers HTTP 200 for work
// it declined to do: verdict "pending_verification" ("held pending verification; not
// re-composed"), verdict "BUSY" / stage "capacity" (isNonAttemptComposeResult). A 200 is a
// statement about the transport, not about the gap. So a held or pending gap was re-dispatched
// on every gap-write event with no backoff at all.
//
// And the observer never asks whether the gap is admissible. Admission in gap-to-feature
// excludes classification_metadata.operator_hold === true, the parking dispositions
// (isParkingDisposition: needs_information, needs_info, awaiting_operator_review) and a landing
// awaiting its verdict (isAwaitingLandVerification: disposition pending_verification). This
// path dispatched them anyway.
//
// The event payload here is EXACTLY what substrate-gap.ts publishes for devvessel.gap.written:
// {gap_id, category, route, remedy, status}. It carries no classification_metadata, so the hold
// is visible only on the gap row in the store. A fix that reads metadata off the event would be
// hollow in production (nothing writes it there); the observer must consult the gap as the store
// holds it. Either read works here: an in-process store read sees the scratch gaps.json, and a
// substrateGap self-resolve over HTTP is answered from that same file by the fetch mock.
//
// ISOLATION. WORKSPACE_ROOT is frozen at module load (config.ts, substrate-gap.ts), and this suite
// writes gaps/gaps.json and pool/drain-log.jsonl under it. It points WORKSPACE_ROOT at a fresh
// temp dir before importing anything. In a multi-file run another suite may have frozen the root
// first; that root is accepted only if both modules agree on it AND it is a scratch dir (under the
// OS tmpdir, TEST_SCRATCH_PARENT, or a path containing /tmp/). A live store (/workspace, a
// super-repo, the repo checkout) makes the suite refuse to run rather than write. A pre-existing
// gaps.json under an accepted root is restored afterwards.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const SCRATCH = mkdtempSync(join(process.env["TEST_SCRATCH_PARENT"] ?? tmpdir(), "gap-drain-backoff-"));
const priorWorkspaceRoot = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = SCRATCH;

type Obs = { handleEvent: (e: { type: string; data: unknown }) => Promise<void> };
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
      `gap-drain-backoff: WORKSPACE_ROOT is not a scratch dir (config=${cfg.WORKSPACE_ROOT}, gap store=${sg.gapStoreRootForTest()}); refusing to write a gap store.`,
    );
  }
  ROOT = root;
  try {
    priorStore = readFileSync(join(ROOT, "gaps", "gaps.json"), "utf8");
  } catch {
    priorStore = null;
  }
  const { GapDrainObserver } = await import("../../src/services/gap-drain-observer.js");
  makeObserver = () => new GapDrainObserver() as unknown as Obs;
});

afterAll(() => {
  // An ABSENT store is restored too: when another suite froze the root, the rows written here would
  // otherwise stay in that shared store (substrate-gap.test.ts then read an extra open row).
  if (ROOT !== "") {
    if (priorStore !== null) writeFileSync(join(ROOT, "gaps", "gaps.json"), priorStore, "utf8");
    else rmSync(join(ROOT, "gaps", "gaps.json"), { force: true });
  }
  if (SCRATCH.includes("gap-drain-backoff-")) rmSync(SCRATCH, { recursive: true, force: true });
  if (priorWorkspaceRoot === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = priorWorkspaceRoot;
});

type Call = { url: string; impulse: Record<string, unknown> };
let calls: Call[] = [];
let dispatchResponse: () => Response = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

const g = globalThis as unknown as {
  __drainBackoff?: Map<string, { until: number; attempts: number }>;
  __drainInflight?: Set<string>;
};

beforeEach(() => {
  calls = [];
  g.__drainBackoff = new Map();
  g.__drainInflight = new Set();
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
    if (impulse["type"] === "maintenanceLease") {
      return new Response(JSON.stringify({ success: true, shape: "maintenanceLease", body: { held: false } }), { status: 200 });
    }
    if (impulse["type"] === "gap_to_feature") return dispatchResponse();
    // A gap read over HTTP (the observer already self-resolves maintenanceLease this way) is
    // answered from the scratch store, exactly as resolveSubstrateGap would: filter by id, {gaps, total}.
    const ptr = ((impulse["pointer"] ?? impulse) as Record<string, unknown>);
    if (ptr["type"] === "substrateGap") {
      const want = (ptr["id"] ?? ptr["gap_id"]) as string | undefined;
      const rows = readGapStore().filter((r) => want === undefined || r["id"] === want);
      return new Response(JSON.stringify({ success: true, shape: "substrateGap", body: { gaps: rows, total: rows.length } }), { status: 200 });
    }
    // Anything else (a publish, …) — answer empty rather than reach the network.
    return new Response(JSON.stringify({ success: true, body: {} }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Write the gap store the observer (and gap-to-feature admission) reads, under the scratch root only. */
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

function gapRow(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    category: "drain_backoff_probe",
    source: "substrate_detected",
    status: "open",
    summary: `probe gap ${id}`,
    detected_at: now,
    created_at: now,
    updated_at: now,
    route: "dispatchable",
    remedy: { impulse_type: "gap_to_feature" },
    classification_metadata: meta,
  };
}

/** The devvessel.gap.written event exactly as substrate-gap.ts publishes it. */
function writtenEvent(id: string): { type: string; data: unknown } {
  return {
    type: "devvessel.gap.written",
    data: { gap_id: id, category: "drain_backoff_probe", route: "dispatchable", remedy: { impulse_type: "gap_to_feature" }, status: "open" },
  };
}

const report = (body: Record<string, unknown>, status = 200) => () =>
  new Response(JSON.stringify({ success: status < 300, shape: "gapToFeatureReport", body }), { status });

const dispatches = () => calls.filter((c) => c.impulse["type"] === "gap_to_feature");

describe("gap-drain observer: a 200 that was not an attempt must not clear backoff", () => {
  test("a 200 gapToFeatureReport with verdict pending_verification leaves the gap backed off", async () => {
    const id = "drain-probe-pending-response";
    writeGapStore([gapRow(id, {})]);
    dispatchResponse = report({
      ok: true,
      gap_id: id,
      gap_category: "drain_backoff_probe",
      verdict: "pending_verification",
      note: "landed once but unmeasured — held pending verification; not re-composed",
    });
    const before = Date.now();
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(1); // it was dispatched once (the gap row itself is admissible)
    const entry = g.__drainBackoff?.get(id);
    expect(entry).toBeDefined();
    expect(entry!.until).toBeGreaterThan(before);
  });
});

describe("gap-drain observer: a gap admission would exclude is never dispatched", () => {
  test("a written gap whose row carries classification_metadata.operator_hold true is not dispatched", async () => {
    const id = "drain-probe-operator-hold";
    writeGapStore([gapRow(id, { operator_hold: true, operator_hold_reason: "probe" })]);
    dispatchResponse = report({ ok: true, gap_id: id, verdict: "FAVORABLE", commit: "abc1234" });
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(0);
  });

  test("a written gap whose row carries disposition pending_verification is not dispatched", async () => {
    const id = "drain-probe-disposition-pending";
    writeGapStore([gapRow(id, { disposition: "pending_verification" })]);
    dispatchResponse = report({ ok: true, gap_id: id, verdict: "FAVORABLE", commit: "abc1234" });
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(0);
  });
});

describe("gap-drain observer: controls (current correct behaviour)", () => {
  test("a 200 report showing a real attempt (FAVORABLE landing) clears an existing backoff", async () => {
    const id = "drain-probe-real-attempt";
    writeGapStore([gapRow(id, {})]);
    // An expired entry: the gap is eligible now, and a real attempt must clear the record.
    g.__drainBackoff!.set(id, { until: Date.now() - 1, attempts: 3 });
    dispatchResponse = report({ ok: true, gap_id: id, gap_category: "drain_backoff_probe", verdict: "FAVORABLE", commit: "abc1234" });
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(1);
    expect(g.__drainBackoff!.has(id)).toBe(false);
  });

  test("a non-2xx dispatch grows backoff exponentially", async () => {
    const id = "drain-probe-http-error";
    writeGapStore([gapRow(id, {})]);
    g.__drainBackoff!.set(id, { until: Date.now() - 1, attempts: 1 });
    dispatchResponse = () => new Response(JSON.stringify({ success: false, error: "boom" }), { status: 500 });
    const before = Date.now();
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(1);
    const entry = g.__drainBackoff!.get(id)!;
    expect(entry.attempts).toBe(2);
    expect(entry.until).toBeGreaterThanOrEqual(before + 120_000);
  });

  test("a gap still inside its backoff window is not dispatched", async () => {
    const id = "drain-probe-in-window";
    writeGapStore([gapRow(id, {})]);
    g.__drainBackoff!.set(id, { until: Date.now() + 60_000, attempts: 1 });
    await makeObserver().handleEvent(writtenEvent(id));
    expect(dispatches().length).toBe(0);
  });
});
