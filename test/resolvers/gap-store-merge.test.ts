// MERGING A LEFT-BEHIND GAP STORE INTO THE HOLDER'S, BY MIGRATION (2026-10-22).
//
// CONTRACT. A node whose gap store moved to another holder pushes its old rows to the holder
// (resolvers/gap-store-merge-migration.ts), and the holder merges them (substrate-gap.ts GAP-STORE MERGE) by id:
//   - equal content is no conflict;
//   - otherwise the newer updated_at wins, and a tie or an unparseable timestamp goes to the holder;
//   - the loser is kept in gaps/_previous.jsonl, never dropped, and never kept twice (a second run changes nothing);
//   - the holder's own shadow rows (a second row of one id) stay where and as they are;
//   - the effect is checked on the bytes read back, and a read-back that lost a row restores the prior store;
//   - only node-self or an admin-scoped key may merge, as named by the route.
// The forwarder sends every row of one id in one chunk, accepts only a verified read-back whose counts add up, and
// marks the migration done only when every chunk verified.
//
// FIXTURE STORES ONLY: a scratch WORKSPACE_ROOT (asserted), a fake holder on loopback, and a stubbed identity on
// loopback. Nothing here reads or writes a live store.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";

const publishStub = stubGapEventPublish();
const ROOT = join(tmpdir(), `gap-store-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const SAVED_EP = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
const SAVED_KEY = process.env["METABOB_API_KEY"];
const SAVED_ID = process.env["IDENTITY_VESSEL_URL"];
const gapMod = await import("../../src/resolvers/substrate-gap.js");
const merge = await import("../../src/lib/gap-store-merge.js");
const migration = await import("../../src/resolvers/gap-store-merge-migration.js");
const queueLib = await import("../../src/lib/gap-forward-queue.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-store-merge"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const STORE_ROOT = gapMod.gapStoreRootForTest();
const GAPS = join(STORE_ROOT, "gaps", "gaps.json");
const PREVIOUS = join(STORE_ROOT, "gaps", "_previous.jsonl");
const MERGES = join(STORE_ROOT, "gaps", "gap-store-merges.jsonl");
const MARKER = join(STORE_ROOT, "gaps", "gap-store-merge.done.json");
const SIDE_FILES = [PREVIOUS, MERGES, MARKER];
let savedStore: Buffer | null = null;

type Row = Record<string, unknown> & { id: string };
const row = (id: string, updated_at: string, note: string, extra: Record<string, unknown> = {}): Row =>
  ({ id, category: "systematic_failure", source: "substrate_detected", summary: `fixture ${id}`, detected_at: "2026-10-01T00:00:00.000Z", status: "open", created_at: "2026-10-01T00:00:00.000Z", updated_at, classification_metadata: { note }, ...extra });
const T1 = "2026-10-10T00:00:00.000Z", T2 = "2026-10-12T00:00:00.000Z";
// holder: a (older), b, a shadow of c, c; source: a (newer, differs), b (identical), d (new), e with a differing shadow
const HOLDER: Row[] = [row("m-a", T1, "holder-a"), row("m-b", T1, "same"), row("m-c", T1, "c-live"), row("m-c", T1, "c-shadow")];
const SOURCE: Row[] = [row("m-a", T2, "source-a"), row("m-b", T1, "same"), row("m-d", T1, "new-d"), row("m-e", T2, "e-live"), row("m-e", T1, "e-shadow")];
const readStore = (): Row[] => JSON.parse(readFileSync(GAPS, "utf-8")) as Row[];
const keptLines = (): Array<{ id: string; content_hash: string; from: string; row: Row }> =>
  existsSync(PREVIOUS) ? readFileSync(PREVIOUS, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetStore = (rows: Row[]): void => { writeFileSync(GAPS, JSON.stringify(rows, null, 2)); for (const f of SIDE_FILES) rmSync(f, { force: true }); gapMod.__resetGapReadSnapshotForTests(); };
const NODE_SELF = { principal: { node_self: true } };

beforeAll(() => {
  if (!gapMod.isScratchGapStoreRoot(STORE_ROOT)) throw new Error(`gap-store-merge test refused: store root ${STORE_ROOT} is not a scratch root`);
  savedStore = existsSync(GAPS) ? readFileSync(GAPS) : null;
});
afterAll(() => {
  if (savedStore) writeFileSync(GAPS, savedStore); else rmSync(GAPS, { force: true });
  for (const f of SIDE_FILES) rmSync(f, { force: true });
  gapMod.__setGapStoreMergeAfterSaveHookForTests(null);
  gapMod.__resetGapReadSnapshotForTests();
  if (SAVED_EP === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = SAVED_EP;
  if (SAVED_KEY === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = SAVED_KEY;
  if (SAVED_ID === undefined) delete process.env["IDENTITY_VESSEL_URL"]; else process.env["IDENTITY_VESSEL_URL"] = SAVED_ID;
  publishStub.restore();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the merge plan (pure)", () => {
  it("[MUST-FAIL] dedupes by id, the newer row wins, the loser is kept, holder shadows stay in place", () => {
    const p = merge.planGapStoreMerge(HOLDER, SOURCE);
    expect(p.counts).toEqual({ holder_before: 4, source_rows: 5, source_ids: 4, source_shadow_rows: 1, holder_shadow_rows: 1, added: 2, identical: 1, holder_won: 0, source_won: 1, after: 6 });
    expect(p.rows.map((r) => `${r.id}:${(r.classification_metadata as { note: string }).note}`)).toEqual(["m-a:source-a", "m-b:same", "m-c:c-live", "m-c:c-shadow", "m-d:new-d", "m-e:e-live"]);
    expect(p.previous.map((k) => `${k.id}:${k.from}:${(k.row.classification_metadata as { note: string }).note}`).sort()).toEqual(["m-a:holder:holder-a", "m-e:source:e-shadow"]);
  });
  it("[MUST-FAIL] a newer source row replaces the holder's FIRST row of its id (the live one), never its shadow", () => {
    const p = merge.planGapStoreMerge(HOLDER, [row("m-c", T2, "c-source")]);
    expect(p.rows.map((r) => (r.classification_metadata as { note: string }).note)).toEqual(["holder-a", "same", "c-source", "c-shadow"]);
    expect(p.previous.map((k) => (k.row.classification_metadata as { note: string }).note)).toEqual(["c-live"]);
  });
  it("[MUST-FAIL] a tie goes to the holder; an unparseable timestamp loses to a parseable one", () => {
    const tie = merge.planGapStoreMerge([row("t", T1, "h")], [row("t", T1, "s")]);
    expect([tie.counts.holder_won, (tie.rows[0]!.classification_metadata as { note: string }).note, tie.previous[0]!.from]).toEqual([1, "h", "source"]);
    const badSource = merge.planGapStoreMerge([row("t", T1, "h")], [row("t", "{{goal.updated_at}}", "s")]);
    expect((badSource.rows[0]!.classification_metadata as { note: string }).note).toBe("h");
    const badHolder = merge.planGapStoreMerge([row("t", "not-a-date", "h")], [row("t", T1, "s")]);
    expect([badHolder.counts.source_won, (badHolder.rows[0]!.classification_metadata as { note: string }).note]).toEqual([1, "s"]);
  });
  it("[MUST-FAIL] a second run of the same merge keeps nothing again and changes nothing", () => {
    const first = merge.planGapStoreMerge(HOLDER, SOURCE);
    const kept = new Set(first.previous.map((k) => `${k.id}:${k.content_hash}`));
    const second = merge.planGapStoreMerge(first.rows, SOURCE, kept);
    expect(second.previous).toEqual([]);
    expect(second.counts.added + second.counts.source_won).toBe(0);
    expect(merge.canonicalRow(second.rows)).toBe(merge.canonicalRow(first.rows));
  });
  it("[MUST-FAIL] the check names a dropped row, a moved holder row, and a loser that was not kept", () => {
    const p = merge.planGapStoreMerge(HOLDER, SOURCE);
    const kept = new Set(p.previous.map((k) => `${k.id}:${k.content_hash}`));
    expect(merge.verifyGapStoreMerge(HOLDER, SOURCE, p.rows, kept)).toEqual([]);
    expect(merge.verifyGapStoreMerge(HOLDER, SOURCE, p.rows.slice(0, -1), kept).join(" | ")).toContain("m-e is missing");
    expect(merge.verifyGapStoreMerge(HOLDER, SOURCE, [p.rows[1]!, p.rows[0]!, ...p.rows.slice(2)], kept).join(" | ")).toContain("changed or moved");
    expect(merge.verifyGapStoreMerge(HOLDER, SOURCE, p.rows, new Set()).join(" | ")).toContain("neither live nor kept");
  });
});

describe("the holder applies a merge as a migration, checked on the bytes read back", () => {
  it("[MUST-FAIL] merges a fixture store: counts before and after, the loser kept on disk, one ledger line", async () => {
    resetStore(HOLDER);
    const r = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-fixture-1", chunk_index: 0, rows: SOURCE }, NODE_SELF);
    expect(r.shape).toBe("substrateGapMerge_write");
    const body = r.body as { verified: boolean; counts: Record<string, number> };
    expect(body.verified).toBe(true);
    expect([body.counts.holder_before, body.counts.added, body.counts.after, body.counts.previous_kept]).toEqual([4, 2, 6, 2]);
    expect(readStore().length).toBe(6);
    expect(keptLines().map((k) => `${k.id}:${k.from}`).sort()).toEqual(["m-a:holder", "m-e:source"]);
    expect(readFileSync(MERGES, "utf-8").split("\n").filter(Boolean).length).toBe(1);
  });
  it("[MUST-FAIL] running the same merge again writes nothing new", async () => {
    const storeBefore = readFileSync(GAPS, "utf-8");
    const r = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-fixture-1", chunk_index: 0, rows: SOURCE }, NODE_SELF);
    expect((r.body as { verified: boolean }).verified).toBe(true);
    expect((r.body as { counts: Record<string, number> }).counts.previous_kept).toBe(0);
    expect(readFileSync(GAPS, "utf-8")).toBe(storeBefore);
    expect(keptLines().length).toBe(2);
  });
  it("[MUST-FAIL] a read-back that lost a row is refused and the prior store is restored", async () => {
    resetStore(HOLDER);
    gapMod.__setGapStoreMergeAfterSaveHookForTests(async () => { writeFileSync(GAPS, JSON.stringify(readStore().slice(0, -1), null, 2)); });
    try {
      const r = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-fixture-2", rows: SOURCE }, NODE_SELF);
      expect(r.shape).toBe("structuredError");
      expect((r.body as { failure_mode: string; restored: boolean })).toMatchObject({ failure_mode: "merge_verification_failed", restored: true });
      expect(merge.canonicalRow(readStore())).toBe(merge.canonicalRow(HOLDER));
      expect(existsSync(MERGES)).toBe(false);
    } finally { gapMod.__setGapStoreMergeAfterSaveHookForTests(null); }
  });
  it("[CONTROL] a source identical to the holder merges as no change, and the store file is not rewritten", async () => {
    resetStore(HOLDER);
    const before = readFileSync(GAPS, "utf-8");
    const r = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-fixture-3", rows: [HOLDER[0]!, HOLDER[1]!] }, NODE_SELF);
    expect((r.body as { counts: Record<string, number> }).counts).toMatchObject({ identical: 2, added: 0, after: 4, previous_kept: 0 });
    expect(readFileSync(GAPS, "utf-8")).toBe(before);
    expect(existsSync(PREVIOUS)).toBe(false);
  });
  it("[MUST-FAIL] without node-self or admin the merge is refused and nothing is written; a malformed row refuses the whole chunk", async () => {
    resetStore(HOLDER);
    const before = readFileSync(GAPS, "utf-8");
    const none = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-x", rows: SOURCE });
    expect((none.body as { failure_mode: string }).failure_mode).toBe("merge_principal_required");
    const bad = await gapMod.resolveSubstrateGapMergeWrite({ type: "substrateGapMerge_write", migration_id: "mig-x", rows: [SOURCE[0], { summary: "no id" }] }, { principal: { admin: true } });
    expect((bad.body as { failure_mode: string }).failure_mode).toBe("invalid_merge");
    expect(readFileSync(GAPS, "utf-8")).toBe(before);
  });
});

describe("the route names the merge's principal", () => {
  const KEY = `fixture-node-key-${Math.random().toString(36).slice(2)}`;
  const OTHER = `fixture-other-key-${Math.random().toString(36).slice(2)}`;
  let identity: ReturnType<typeof Bun.serve> | null = null;
  beforeAll(() => {
    identity = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ success: true, data: { authenticated: true, scopes: ["read", "write"], keyId: "fixturekeyid" } }) });
    process.env["METABOB_API_KEY"] = KEY;
    process.env["IDENTITY_VESSEL_URL"] = `http://127.0.0.1:${identity.port}`;
  });
  afterAll(() => { identity?.stop(true); });
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ impulse: { pointer } }),
  });
  const ptr = (mid: string) => ({ type: "substrateGapMerge_write", migration_id: mid, rows: SOURCE, principal: { admin: true }, _route_caller: { auth: "authenticated:node-self" } });
  it("[MUST-FAIL] the node's own key merges; a read/write key is 403; no key is 401; a body claim counts for nothing", async () => {
    resetStore(HOLDER);
    const noKey = await post(null, ptr("mig-route-0"));
    expect(noKey.status).toBe(401);
    const other = await post(`ApiKey ${OTHER}`, ptr("mig-route-1"));
    expect(other.status).toBe(403);
    expect(readStore().length).toBe(4);
    const self = await post(`ApiKey ${KEY}`, ptr("mig-route-2"));
    const j = (await self.json()) as { success: boolean; body: { verified: boolean; counts: { after: number } } };
    expect([self.status, j.success, j.body.verified, j.body.counts.after]).toEqual([200, true, true, 6]);
  });
});

describe("the forwarder pushes its old store once, by id-whole chunks, verified", () => {
  let holderRows: Row[] = [];
  let calls: Array<{ rows: Row[] }> = [];
  let lieOnChunk = -1;
  let order: string[] = [];
  let fake: ReturnType<typeof Bun.serve> | null = null;
  beforeAll(() => {
    fake = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: async (req) => {
        const p = ((await req.json()) as { impulse: { pointer: { type: string; rows: Row[]; chunk_index: number; gap?: { id?: unknown } } } }).impulse.pointer;
        order.push(p.type);
        if (p.type === "substrateGap") return Response.json({ success: true, shape: "substrateGap", body: { gaps: [], total: 0 } });
        if (p.type === "substrateGap_write") return Response.json({ success: true, shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "updated" } });
        calls.push({ rows: p.rows });
        const plan = merge.planGapStoreMerge(holderRows, p.rows);
        holderRows = plan.rows;
        const counts = { ...plan.counts, previous_kept: plan.previous.length, after: p.chunk_index === lieOnChunk ? plan.counts.after - 1 : plan.counts.after };
        return Response.json({ success: true, shape: "substrateGapMerge_write", body: { verified: true, counts } });
      },
    });
  });
  afterAll(() => { fake?.stop(true); delete process.env["GAP_STORE_ENDPOINT"]; });
  const LOCAL: Row[] = [row("f-1", T1, "1"), row("f-2", T1, "2a"), row("f-2", T1, "2b"), row("f-3", T1, "3"), row("f-4", T1, "4")];
  const setup = () => {
    resetStore(LOCAL); holderRows = [row("f-1", T2, "holder-1")]; calls = []; lieOnChunk = -1;
    process.env["GAP_STORE_ENDPOINT"] = `http://127.0.0.1:${fake!.port}/v2/impulses/resolve`;
  };
  it("[MUST-FAIL] every row reaches the holder, no id is split across chunks, and a done marker is written", async () => {
    setup();
    const r = await migration.runGapStoreMergeMigration({ chunkRows: 2 });
    expect(r.status).toBe("merged");
    expect(calls.map((c) => c.rows.map((x) => x.id))).toEqual([["f-1"], ["f-2", "f-2"], ["f-3", "f-4"]]);
    expect(holderRows.map((x) => x.id).sort()).toEqual(["f-1", "f-2", "f-3", "f-4"]);
    expect(existsSync(MARKER)).toBe(true);
    const again = await migration.runGapStoreMergeMigration({ chunkRows: 2 });
    expect(again).toEqual({ status: "skipped", reason: "already_merged" });
    expect(calls.length).toBe(3);
  });
  it("[MUST-FAIL] a chunk whose counts do not add up stops the migration and leaves no marker", async () => {
    setup();
    lieOnChunk = 1;
    const r = await migration.runGapStoreMergeMigration({ chunkRows: 2 });
    expect(r).toMatchObject({ status: "incomplete", chunk_index: 1 });
    expect(existsSync(MARKER)).toBe(false);
    expect(calls.length).toBe(2);
  });
  it("[MUST-FAIL] a queued gap write does not replay between merge chunks; it replays after the merge", async () => {
    setup();
    gapMod.__allowGapForwardQueueFromScratchForTests(true);
    const qdir = join(STORE_ROOT, "gaps", "forward-queue");
    try {
      const q = queueLib.enqueueGapWrite(qdir, "wid-merge-order-0123", { type: "substrateGap_write", write_id: "wid-merge-order-0123", gap: { id: "f-1", category: "systematic_failure", source: "substrate_detected", summary: "a queued fixture write of f-1", detected_at: T1, status: "open" } });
      expect(q.queued).toBe(true);
      order = [];
      const r = await migration.runGapStoreMergeMigration({ chunkRows: 2 });
      expect(r.status).toBe("merged");
      await new Promise((res) => setTimeout(res, 50));
      expect(order.filter((t) => t !== "substrateGapMerge_write")).toEqual([]);
      expect(queueLib.queuedFiles(qdir).length).toBe(1);
      await gapMod.drainGapForwardQueue();
      expect(order.slice(-1)).toEqual(["substrateGap_write"]);
      expect(queueLib.queuedFiles(qdir).length).toBe(0);
    } finally {
      gapMod.__allowGapForwardQueueFromScratchForTests(false);
      rmSync(qdir, { recursive: true, force: true });
    }
  });
  it("[CONTROL] the holder itself (no GAP_STORE_ENDPOINT) never pushes", async () => {
    setup();
    delete process.env["GAP_STORE_ENDPOINT"];
    expect(await migration.runGapStoreMergeMigration()).toEqual({ status: "skipped", reason: "holds_the_store" });
    expect(calls.length).toBe(0);
  });
});
