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

// THE CLASS, NOT THE EXAMPLE. The test above names one verdict, so a patch reading
// `body.verdict === "pending_verification"` passes it while every BUSY / capacity / lease / budget /
// environment non-attempt still clears backoff. The cases below are the report bodies gap-to-feature
// actually returns for work it did not do (copied from its return sites), each anchored to the
// exported predicate isNonAttemptComposeResult (pending_verification is the one non-attempt the
// predicate does not cover; the gap names it explicitly). The predicate is loaded by dynamic import:
// a static import would freeze WORKSPACE_ROOT before this file points it at its scratch dir.
let isNonAttempt: (cb: Record<string, unknown> | null | undefined) => boolean = () => {
  throw new Error("isNonAttemptComposeResult not loaded");
};
beforeAll(async () => {
  const gtf = await import("../../src/resolvers/gap-to-feature.js");
  isNonAttempt = gtf.isNonAttemptComposeResult;
});

/** Every non-attempt body gap_to_feature answers HTTP 200 with (gap-to-feature.ts return sites). */
function nonAttemptBodies(id: string): Array<{ label: string; body: Record<string, unknown> }> {
  return [
    { label: "pending_verification (held, not re-composed)", body: { ok: true, gap_id: id, gap_category: "drain_backoff_probe", verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" } },
    { label: "BUSY stage lease", body: { ok: false, stage: "lease", verdict: "BUSY", error: "autonomous_pick lease held by probe", lease_holder: "probe", lease_expires_at: new Date(Date.now() + 60_000).toISOString(), skipped_selection: true } },
    { label: "BUSY stage capacity (lane full)", body: { ok: false, stage: "capacity", verdict: "BUSY", error: "compose lane full — selection skipped", observed: 2, cap: 2, skipped_selection: true } },
    { label: "BUSY stage capacity (llm_unavailable)", body: { ok: false, stage: "capacity", verdict: "BUSY", error: "llm_unavailable: no llm_completion producer advertised — selection skipped", reason: "llm_unavailable", skipped_selection: true } },
    { label: "BUSY stage budget", body: { ok: false, stage: "budget", verdict: "BUSY", error: "spend envelope: exhausted (selection skipped)", reason: "budget_exhausted", cap_usd: 1, spent_usd: 1, skipped_selection: true } },
    { label: "compose-forwarded BUSY capacity", body: { ok: false, gap_id: id, verdict: "BUSY", stage: "capacity", error: "compose slots full" } },
    { label: "failure_kind environment", body: { ok: false, gap_id: id, verdict: "UNFAVORABLE", failure_kind: "environment", error: "workspace unavailable" } },
  ];
}

describe("gap-drain observer: every non-attempt 200 keeps the gap backed off (class)", () => {
  test("fixture anchor: every non-attempt body except pending_verification satisfies gap-to-feature's isNonAttemptComposeResult", () => {
    const bodies = nonAttemptBodies("anchor");
    expect(bodies.length).toBeGreaterThanOrEqual(7);
    for (const { label, body } of bodies) {
      if (body["verdict"] === "pending_verification") continue;
      expect(isNonAttempt(body), `fixture "${label}" must be a non-attempt per isNonAttemptComposeResult`).toBe(true);
    }
    // and the predicate is not vacuous: a real landing is an attempt
    expect(isNonAttempt({ ok: true, verdict: "FAVORABLE", commit: "abc1234" })).toBe(false);
  });

  test("class: each non-attempt report gap_to_feature returns with HTTP 200 (pending_verification, BUSY lease/capacity/llm_unavailable/budget, failure_kind environment) leaves an expired backoff entry in force", async () => {
    const wrong: string[] = [];
    for (const [i, { label }] of nonAttemptBodies("x").entries()) {
      const id = `drain-probe-nonattempt-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const { body } = nonAttemptBodies(id)[i]!;
      writeGapStore([gapRow(id, {})]);
      calls = [];
      g.__drainInflight = new Set();
      // Expired: the gap is eligible now, so it IS dispatched, and the 200 that comes back is a non-attempt.
      g.__drainBackoff!.set(id, { until: Date.now() - 1, attempts: 2 });
      dispatchResponse = report(body);
      const before = Date.now();
      await makeObserver().handleEvent(writtenEvent(id));
      if (dispatches().length !== 1) { wrong.push(`${label}: dispatched ${dispatches().length}x (expected 1)`); continue; }
      const entry = g.__drainBackoff!.get(id);
      if (!entry) wrong.push(`${label}: backoff entry was CLEARED by a 200 non-attempt`);
      else if (!(entry.until > before)) wrong.push(`${label}: backoff entry not in force (until=${entry.until} <= ${before})`);
    }
    expect(wrong).toEqual([]);
  });

  test("class: a non-attempt 200 for a gap with NO prior backoff entry creates one in force", async () => {
    const wrong: string[] = [];
    for (const [i, { label }] of nonAttemptBodies("x").entries()) {
      const id = `drain-probe-nonattempt-fresh-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const { body } = nonAttemptBodies(id)[i]!;
      writeGapStore([gapRow(id, {})]);
      calls = [];
      g.__drainInflight = new Set();
      g.__drainBackoff!.delete(id);
      dispatchResponse = report(body);
      const before = Date.now();
      await makeObserver().handleEvent(writtenEvent(id));
      const entry = g.__drainBackoff!.get(id);
      if (dispatches().length !== 1) wrong.push(`${label}: dispatched ${dispatches().length}x (expected 1)`);
      else if (!entry || !(entry.until > before)) wrong.push(`${label}: no backoff entry in force after a non-attempt`);
    }
    expect(wrong).toEqual([]);
  });

  test("control: for every real landing (FAVORABLE with a commit) after an expired backoff, the entry is cleared — backoff is not sticky", async () => {
    // Kills the over-broad fix "never clear backoff on a 200": the same gaps, the same expired entries,
    // a real attempt instead of a non-attempt.
    const wrong: string[] = [];
    for (let i = 0; i < nonAttemptBodies("x").length; i++) {
      const id = `drain-probe-real-${i}-${Math.random().toString(36).slice(2, 8)}`;
      writeGapStore([gapRow(id, {})]);
      calls = [];
      g.__drainInflight = new Set();
      g.__drainBackoff!.set(id, { until: Date.now() - 1, attempts: 2 + i });
      const body = { ok: true, gap_id: id, gap_category: "drain_backoff_probe", verdict: "FAVORABLE", commit: `c0ffee${i}` };
      expect(isNonAttempt(body)).toBe(false);
      dispatchResponse = report(body);
      await makeObserver().handleEvent(writtenEvent(id));
      if (dispatches().length !== 1) wrong.push(`#${i}: dispatched ${dispatches().length}x`);
      else if (g.__drainBackoff!.has(id)) wrong.push(`#${i}: a real landing left the backoff entry in place`);
    }
    expect(wrong).toEqual([]);
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

// THE HOLD CLASS, NOT TWO FIELDS. The two tests above name operator_hold and one disposition, so a
// patch that checks exactly those two literals passes while the parking dispositions
// (needs_information, needs_info, awaiting_operator_review) are still dispatched. The grid below is
// driven by admission's own exported predicates: held = operator_hold === true || isParkingDisposition
// || isAwaitingLandVerification (which releases a pending_verification landing once regressed_by or a
// BEHAVIORAL VERIFICATION FAILED summary says it did not fix the gap). Arming is an axis too: the
// remedy gaps this path drains are often unarmed, and a hold must not depend on arming (nor may an
// unarmed, unheld gap stop being dispatched). Predicates load by dynamic import (WORKSPACE_ROOT).
type HoldPreds = {
  parking: readonly string[];
  isParking: (d: unknown) => boolean;
  awaitingLand: (gap: Record<string, unknown>) => boolean;
};
let holdPreds: HoldPreds | null = null;
beforeAll(async () => {
  const gtf = await import("../../src/resolvers/gap-to-feature.js");
  holdPreds = { parking: gtf.PARKING_DISPOSITIONS, isParking: gtf.isParkingDisposition, awaitingLand: gtf.isAwaitingLandVerification };
});

type HoldCase = { label: string; row: Record<string, unknown>; held: boolean };
function holdGrid(tag: string): HoldCase[] {
  const p = holdPreds!;
  const out: HoldCase[] = [];
  const holds: Array<[string, Record<string, unknown>]> = [["hold=absent", {}], ["hold=false", { operator_hold: false }], ["hold=true", { operator_hold: true, operator_hold_reason: "probe" }]];
  const dispositions: Array<[string, Record<string, unknown>]> = [
    ["disp=absent", {}],
    ["disp=''", { disposition: "" }],
    ["disp=pending_verification", { disposition: "pending_verification" }],
    ...p.parking.map((d): [string, Record<string, unknown>] => [`disp=${d}`, { disposition: d }]),
  ];
  const regressed: Array<[string, Record<string, unknown>]> = [["regressed=no", {}], ["regressed=yes", { regressed_by: { sha: "deadbee", verdict: "present" } }]];
  const summaries: Array<[string, string]> = [["summary=plain", ""], ["summary=BVF", " — BEHAVIORAL VERIFICATION FAILED after landing"]];
  const arming: Array<[string, Record<string, unknown>]> = [["unarmed", {}], ["armed", { falsifier: "class2", edit_site: "repos/development-vessel/src/services/gap-drain-observer.ts" }]];
  let n = 0;
  for (const [hl, hm] of holds) for (const [dl, dm] of dispositions) for (const [rl, rm] of regressed) for (const [sl, ss] of summaries) for (const [al, am] of arming) {
    const id = `drain-probe-hold-${tag}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
    const row = gapRow(id, { ...am, ...hm, ...dm, ...rm });
    row["summary"] = `probe gap ${id}${ss}`;
    const meta = row["classification_metadata"] as Record<string, unknown>;
    const held = meta["operator_hold"] === true || p.isParking(meta["disposition"]) || p.awaitingLand(row);
    out.push({ label: [hl, dl, rl, sl, al].join(" "), row, held });
  }
  return out;
}

async function dispatchCountFor(c: HoldCase): Promise<number> {
  const id = c.row["id"] as string;
  writeGapStore([c.row]);
  calls = [];
  g.__drainInflight = new Set();
  g.__drainBackoff = new Map();
  dispatchResponse = report({ ok: true, gap_id: id, gap_category: "drain_backoff_probe", verdict: "FAVORABLE", commit: "abc1234" });
  await makeObserver().handleEvent(writtenEvent(id));
  return dispatches().length;
}

describe("gap-drain observer: the admission hold class decides dispatch (grid)", () => {
  test("grid anchor: the hold grid covers every PARKING_DISPOSITIONS entry and both sides of isAwaitingLandVerification", () => {
    const p = holdPreds!;
    expect(p.parking.length).toBeGreaterThanOrEqual(3);
    const grid = holdGrid("anchor");
    for (const d of p.parking) expect(grid.some((c) => c.held && (c.row["classification_metadata"] as Record<string, unknown>)["disposition"] === d)).toBe(true);
    expect(grid.some((c) => c.held && p.awaitingLand(c.row))).toBe(true);
    // pending_verification released by regressed_by / BVF: not held unless something else holds it
    expect(grid.some((c) => !c.held && (c.row["classification_metadata"] as Record<string, unknown>)["disposition"] === "pending_verification")).toBe(true);
    expect(grid.filter((c) => c.held).length).toBeGreaterThan(0);
    expect(grid.filter((c) => !c.held).length).toBeGreaterThan(0);
  });

  test("class: every HELD row (operator_hold, each parking disposition, a pending_verification landing awaiting its verdict), armed or not, is never dispatched", async () => {
    const wrong: string[] = [];
    for (const c of holdGrid("held").filter((x) => x.held)) {
      const n = await dispatchCountFor(c);
      if (n !== 0) wrong.push(`${c.label}: dispatched ${n}x`);
    }
    expect(wrong).toEqual([]);
  });

  test("class: a written gap whose row parks it for a human (needs_information, needs_info, awaiting_operator_review) is not dispatched", async () => {
    const wrong: string[] = [];
    for (const d of holdPreds!.parking) {
      const id = `drain-probe-parked-${d}-${Math.random().toString(36).slice(2, 8)}`;
      const n = await dispatchCountFor({ label: d, row: gapRow(id, { disposition: d }), held: true });
      if (n !== 0) wrong.push(`disposition ${d}: dispatched ${n}x`);
    }
    expect(wrong).toEqual([]);
  });

  test("control: every UNHELD row in the same grid (incl. unarmed, operator_hold false, a pending_verification landing released by regressed_by or BVF) is dispatched exactly once", async () => {
    // Kills the over-broad fixes "skip anything with a disposition", "skip unarmed rows", "skip
    // pending_verification whatever its release state".
    const wrong: string[] = [];
    for (const c of holdGrid("unheld").filter((x) => !x.held)) {
      const n = await dispatchCountFor(c);
      if (n !== 1) wrong.push(`${c.label}: dispatched ${n}x (expected 1)`);
    }
    expect(wrong).toEqual([]);
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
