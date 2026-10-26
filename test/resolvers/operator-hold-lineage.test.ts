// A HOLD COVERS ITS LINEAGE (10-26).
//
// Observed on node 1: an operator_hold on a gap stopped only its own row. Its recommit child
// (recommit-<held>-compose_execution_failure) was picked, leased and admitted for drafting 42 min after the hold,
// and when that compose failed a grandchild (recommit-recommit-...-verify_failed) was minted unheld and queued.
// Every failure of a held lineage minted a fresh unheld row. Pinned here, against the real emitters and the real
// (temp) gap store:
//   - INHERIT AT CREATION: a held parent's recommit and narrowed children are born held, with the reason, the
//     stamp and the row the hold was set on (operator_hold_inherited_from); an unheld parent's are not;
//   - LINEAGE AT THE SUPPLY: the default open-gap read omits an existing unheld child and grandchild of a held root
//     (recorded lineage keys or the recommit- / -narrowed id chain, past a pruned intermediate), and still lists an
//     unheld lineage's children and an unrelated gap;
//   - LINEAGE AT THE PICK: pickSkipPending skips a candidate whose ancestor in the index is held;
//   - the walk fails closed: an ancestor whose read fails counts as held.
// The new symbols are read off the module namespace, so at the fix parent each test fails on its own.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `hold-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fCredit = await import("../../src/judge/gap-attempt-credit.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const admission = await import("../../src/judge/gap-admission.js");
const elig = (await import("../../src/judge/gap-eligibility.js")) as Record<string, unknown>;
const fc = await import("../../src/resolvers/feature-compose.js");
const RUN = Math.random().toString(36).slice(2, 8);

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];

type Row = Record<string, unknown>;
const SITE = "repos/activity-api/src/routes/trace-aggregate-report.ts";
const HOLD = { operator_hold: true, operator_hold_reason: "fixture: the intent contradicts a ruling", operator_hold_at: "2026-10-26T12:59:42Z" };

let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (p?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (url.endsWith("/run-goal")) return Response.json({ ok: true });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { g2fPolicy.__resetPolicyReadsForTests(); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
async function seed(id: string, meta: Row): Promise<Row> {
  const gap = { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `hold-lineage fixture ${id}: the report reads a dead table`, classification_metadata: { edit_site: SITE, ...meta } };
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  return JSON.parse(JSON.stringify((await storeRow(id))!)) as Row;
}
const LESSON = { failed_attempts: 2, failure_lessons: [{ at: "2026-10-26T12:00:00.000Z", class: "verify_failed", reason: "THE GAP'S OWN CHECK IS STILL RED on this draft" }] };
async function narrowAndRecommit(parent: Row): Promise<{ narrowed: Row; recommit: Row }> {
  const id = String(parent["id"]);
  await fc.appendComposeLesson("verify_failed", "THE GAP'S OWN CHECK IS STILL RED on this draft again", "activity-api", parent as never);
  await g2fCredit.bumpFailedAttempts(JSON.parse(JSON.stringify((await storeRow(id))!)) as Row, { escalate: g2f.escalateToDecomposition });
  await sg.__settleBirthEvaluationsForTests();
  const narrowed = await storeRow(`${id}-narrowed`);
  const recommit = await storeRow(`recommit-${id}-verify_failed`);
  expect(narrowed).toBeDefined();
  expect(recommit).toBeDefined();
  return { narrowed: narrowed!, recommit: recommit! };
}
async function openIds(): Promise<string[]> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", status: "open", limit: Number.MAX_SAFE_INTEGER } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? []).map((g) => String(g["id"]));
}

describe("a held gap's derived rows are born held (inherit at creation)", () => {
  it("[MUST-FAIL MF1] the recommit and narrowed children of a held gap carry its operator_hold, reason, stamp and origin", async () => {
    const id = `hl-held-${RUN}`;
    const parent = await seed(id, { ...LESSON, ...HOLD });
    expect(metaOf(parent)["operator_hold"]).toBe(true);
    const { narrowed, recommit } = await narrowAndRecommit(parent);
    for (const child of [narrowed, recommit]) {
      const m = metaOf(child);
      expect(m["operator_hold"]).toBe(true);
      expect(m["operator_hold_reason"]).toBe(HOLD.operator_hold_reason);
      expect(m["operator_hold_at"]).toBe(HOLD.operator_hold_at);
      expect(m["operator_hold_inherited_from"]).toBe(id);
    }
    expect(await openIds()).not.toContain(`recommit-${id}-verify_failed`);
    expect(await openIds()).not.toContain(`${id}-narrowed`);
  });

  it("[CONTROL] an unheld gap's children are born unheld and stay in the open supply", async () => {
    const id = `hl-free-${RUN}`;
    const parent = await seed(id, { ...LESSON });
    const { narrowed, recommit } = await narrowAndRecommit(parent);
    for (const child of [narrowed, recommit]) {
      expect(metaOf(child)["operator_hold"] ?? false).toBe(false);
      expect(metaOf(child)["operator_hold_inherited_from"]).toBeUndefined();
    }
    const open = await openIds();
    expect(open).toContain(`recommit-${id}-verify_failed`);
    expect(open).toContain(`${id}-narrowed`);
  });

  it("[MUST-FAIL MF1] inheritedOperatorHold keeps the row the hold was set on through a second generation, and gives nothing for an unheld parent", () => {
    const inh = elig["inheritedOperatorHold"] as (p: string, m: Row) => Row;
    expect(inh("P", { ...HOLD })).toEqual({ ...HOLD, operator_hold_inherited_from: "P" });
    expect(inh("recommit-P-x", { ...HOLD, operator_hold_inherited_from: "P" })["operator_hold_inherited_from"]).toBe("P");
    expect(inh("P", {})).toEqual({});
    expect(inh("P", { operator_hold: false, operator_hold_reason: "lifted" })).toEqual({});
  });
});

describe("an existing unheld descendant of a held gap is out of the open supply (lineage at the read)", () => {
  const H = `hl-root-${RUN}`;
  const C = `recommit-${H}-compose_execution_failure`;
  const GC = `recommit-${C}-verify_failed`;
  const N = `${H}-narrowed`;
  const PRUNED = `recommit-recommit-${H}-anchor_not_found-syntax_break`; // its intermediate row was never stored
  const R = `hl-freeroot-${RUN}`;
  const RC = `recommit-${R}-verify_failed`;
  const U = `hl-unrelated-${RUN}`;
  beforeAll(async () => {
    await seed(H, { ...HOLD });
    await seed(C, { re_commit: true, source_gap_id: H, root_gap_id: H });
    await seed(GC, { re_commit: true, source_gap_id: C, root_gap_id: H });
    await seed(N, { parent_gap_id: H });
    await seed(PRUNED, {});
    await seed(R, {});
    await seed(RC, { re_commit: true, source_gap_id: R, root_gap_id: R });
    await seed(U, {});
  });

  it("[MUST-FAIL MF2] an unheld recommit child and an unheld narrowed child of a held root are omitted", async () => {
    const open = await openIds();
    expect(open).not.toContain(H);
    expect(open).not.toContain(C);
    expect(open).not.toContain(N);
  });
  it("[MUST-FAIL MF3] a grandchild (recommit-recommit-...) of a held root is omitted, also past a pruned intermediate (id chain only)", async () => {
    const open = await openIds();
    expect(open).not.toContain(GC);
    expect(open).not.toContain(PRUNED);
  });
  it("[CONTROL] an unheld lineage's root and child, and a gap unrelated to the held one, are listed; by-id and include_held reads still see the held lineage", async () => {
    const open = await openIds();
    expect(open).toContain(R);
    expect(open).toContain(RC);
    expect(open).toContain(U);
    expect((await storeRow(C))?.["id"]).toBe(C);
    const all = await sg.resolveSubstrateGap({ type: "substrateGap", status: "open", limit: Number.MAX_SAFE_INTEGER, include_held: true } as never);
    const allIds = ((all.body as { gaps?: Row[] }).gaps ?? []).map((g) => String(g["id"]));
    for (const id of [H, C, GC, N, PRUNED]) expect(allIds).toContain(id);
  });
});

describe("lineage at the pick and the walk's own rules", () => {
  const row = (id: string, meta: Row): Row => ({ id, status: "open", classification_metadata: meta });
  const held = row("P", { ...HOLD });
  const child = row("recommit-P-compose_execution_failure", { re_commit: true, source_gap_id: "P" });
  const grand = row("recommit-recommit-P-compose_execution_failure-verify_failed", { re_commit: true, source_gap_id: "recommit-P-compose_execution_failure", root_gap_id: "P" });
  const free = row("Q", {});
  const freeChild = row("recommit-Q-verify_failed", { re_commit: true, source_gap_id: "Q" });

  it("[MUST-FAIL MF2] pickSkipPending skips an unheld child, and a grandchild, whose ancestor in the index is held", () => {
    const index = new Map<string, Row>([["P", held], [String(child["id"]), child], [String(grand["id"]), grand]]);
    expect(admission.pickSkipPending(child, [child, grand], index)).toBe(true);
    expect(admission.pickSkipPending(grand, [child, grand], index)).toBe(true);
  });
  it("[CONTROL] pickSkipPending does not skip an unheld lineage's child or an unrelated gap beside a held one", () => {
    const index = new Map<string, Row>([["P", held], ["Q", free], [String(freeChild["id"]), freeChild]]);
    expect(admission.pickSkipPending(freeChild, [freeChild, free], index)).toBe(false);
    expect(admission.pickSkipPending(free, [freeChild, free], index)).toBe(false);
  });
  it("[MUST-FAIL] heldLineageAncestor fails closed on an unreadable ancestor, walks past an absent one, and names the held one", () => {
    const walk = elig["heldLineageAncestor"] as (r: Row, l: (id: string) => Row[] | null) => { id: string; why: string } | null;
    expect(walk(child, () => null)).toEqual({ id: "P", why: "unreadable" });
    expect(walk(grand, (id) => (id === "P" ? [held] : []))).toEqual({ id: "P", why: "operator_hold" });
    expect(walk(row("recommit-recommit-P-a-b", {}), (id) => (id === "P" ? [held] : []))).toEqual({ id: "P", why: "operator_hold" });
    expect(walk(row("P-dissent-narrowed", { parent_gap_id: "P" }), (id) => (id === "P" ? [held] : []))).toEqual({ id: "P", why: "operator_hold" });
    expect(walk(freeChild, (id) => (id === "Q" ? [free] : []))).toBeNull();
    expect(walk(free, () => null)).toBeNull(); // a root names no ancestor, so nothing is read
  });
});
