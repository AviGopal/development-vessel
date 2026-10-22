// A GAP WRITE THE HOLDER COULD NOT TAKE IS KEPT AND REPLAYED, ONCE (2026-10-22).
//
// CONTRACT (resolvers/substrate-gap.ts GAP-WRITE QUEUE, lib/gap-forward-queue.ts):
//   - a write whose principal is this node, failing TRANSIENTLY at the holder (unreachable, 502/503/504), is kept on
//     disk (tmp + rename, one file per write, no credential) and answered gap_store_unavailable + queued:true + write_id;
//   - it replays, oldest first, when the holder answers again, with the SAME write id, and leaves the queue;
//   - the holder applies a write id once, durably: a repeat answers duplicate_write_id and changes nothing;
//   - a write from a caller with its own key, and any refusal (4xx), are never queued;
//   - the queue is bounded (queue_full), a replay the holder refuses is dead-lettered with a typed reason, and a
//     transient failure during replay adds an attempt to the same entry, never a second entry;
//   - while writes wait, a new queueable write waits behind them (FIFO).
//
// SEAM: a fake holder on loopback (Bun.serve) whose mode the test sets, a stubbed identity on loopback, a scratch
// store root. No live service.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";

const publishStub = stubGapEventPublish();
const ROOT = join(tmpdir(), `gap-forward-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED: Record<string, string | undefined> = {};
for (const k of ["WORKSPACE_ROOT", "GAP_STORE_ENDPOINT", "METABOB_API_KEY", "IDENTITY_VESSEL_URL"]) SAVED[k] = process.env[k];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];
const gapMod = await import("../../src/resolvers/substrate-gap.js");
const queue = await import("../../src/lib/gap-forward-queue.js");
const cc = await import("../../src/lib/caller-credential.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-forward-queue"}`);
if (SAVED["WORKSPACE_ROOT"] === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED["WORKSPACE_ROOT"];

const STORE_ROOT = gapMod.gapStoreRootForTest();
const QDIR = join(STORE_ROOT, "gaps", "forward-queue");
const DEAD = join(QDIR, "dead");
const SUFFIX = Math.random().toString(36).slice(2, 8);
const NODE_KEY = `fixture-node-key-${SUFFIX}`;
const CALLER_KEY = `fixture-caller-key-${SUFFIX}`;
const AT = "2026-10-22T09:00:00.000Z";
const gap = (id: string, extra: Record<string, unknown> = {}) => ({ id, category: "systematic_failure", source: "substrate_detected", summary: `a fixture gap ${id} for the forward queue`, detected_at: AT, status: "open", classification_metadata: {}, ...extra });
const write = (g: Record<string, unknown>) => gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: g }, { vocabulary: null });

type Mode = "up" | "down503" | "refuse" | "refuse-read" | "rule" | "apply-then-503";
let mode: Mode = "up";
let sent: Array<{ type: string; gap_id: unknown; write_id: unknown }> = [];
let holder: ReturnType<typeof Bun.serve> | null = null;
let identity: ReturnType<typeof Bun.serve> | null = null;
let closedPort = 0;
const files = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort() : []);
const writesSent = () => sent.filter((s) => s.type === "substrateGap_write");
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
}

beforeAll(async () => {
  if (!gapMod.isScratchGapStoreRoot(STORE_ROOT)) throw new Error("forward-queue test refused: the store root is not a scratch root");
  gapMod.__allowGapForwardQueueFromScratchForTests(true);
  holder = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (req) => {
      const p = ((await req.json()) as { impulse: { pointer: { type: string; write_id?: unknown; gap?: { id?: unknown } } } }).impulse.pointer;
      sent.push({ type: p.type, gap_id: p.gap?.id, write_id: p.write_id });
      if (mode === "down503") return new Response("upstream down", { status: 503 });
      if (mode === "refuse-read") return Response.json({ success: false, error: "caller_credential_required: fixture" }, { status: 401 });
      if (p.type === "substrateGap") return Response.json({ success: true, shape: "substrateGap", body: { gaps: [], total: 0 } });
      if (mode === "refuse") return Response.json({ success: false, error: "caller_credential_required: fixture" }, { status: 401 });
      if (mode === "rule") return Response.json({ success: false, shape: "structuredError", body: { resolver: "substrateGap_write", rule: "fixture_rule", detail: "refused by a fixture gate" } });
      if (mode === "apply-then-503") { mode = "up"; return new Response("applied, answer lost", { status: 503 }); }
      return Response.json({ success: true, shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "created" } });
    },
  });
  identity = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (req) => {
      const key = ((await req.json()) as { impulse?: { pointer?: { apiKey?: string } } }).impulse?.pointer?.apiKey;
      return key === CALLER_KEY ? Response.json({ success: true, data: { authenticated: true, scopes: ["read", "write"], keyId: "fixturecaller" } }) : Response.json({ success: false }, { status: 401 });
    },
  });
  const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  closedPort = tmp.port; tmp.stop(true);
});
afterAll(async () => {
  await gapMod.drainGapForwardQueue().catch(() => undefined);
  rmSync(QDIR, { recursive: true, force: true });
  gapMod.__allowGapForwardQueueFromScratchForTests(false);
  holder?.stop(true); identity?.stop(true);
  publishStub.restore();
  for (const [k, v] of Object.entries(SAVED)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(async () => {
  await gapMod.drainGapForwardQueue().catch(() => undefined);
  rmSync(QDIR, { recursive: true, force: true });
  sent = []; mode = "up";
  cc.__resetCredentialCacheForTests();
  process.env["METABOB_API_KEY"] = NODE_KEY;
  process.env["IDENTITY_VESSEL_URL"] = `http://127.0.0.1:${identity!.port}`;
  process.env["GAP_STORE_ENDPOINT"] = `http://127.0.0.1:${holder!.port}/v2/impulses/resolve`;
});

describe("a write the holder could not take is kept and replayed", () => {
  it("[MUST-FAIL] the holder unreachable: the write is kept on disk, whole, with its write id and no credential", async () => {
    process.env["GAP_STORE_ENDPOINT"] = `http://127.0.0.1:${closedPort}/v2/impulses/resolve`;
    const r = await write(gap(`q-down-${SUFFIX}`));
    const b = r.body as { failure_mode: string; queued: boolean; write_id: string };
    expect([r.shape, b.failure_mode, b.queued]).toEqual(["structuredError", "gap_store_unavailable", true]);
    const f = files(QDIR);
    expect(f.length).toBe(1);
    const text = readFileSync(join(QDIR, f[0]!), "utf-8");
    const entry = JSON.parse(text) as { write_id: string; pointer: { gap: { id: string } }; attempts: number };
    expect([entry.write_id, entry.pointer.gap.id, entry.attempts]).toEqual([b.write_id, `q-down-${SUFFIX}`, 0]);
    expect(text).not.toContain(NODE_KEY);
  });
  it("[MUST-FAIL] when the holder answers again, the kept write replays by itself with the same write id, and leaves the queue", async () => {
    mode = "down503";
    const r = await write(gap(`q-replay-${SUFFIX}`));
    const wid = (r.body as { write_id: string }).write_id;
    expect(files(QDIR).length).toBe(1);
    // the drain the write scheduled runs while the holder is still down, and stops there; nothing else is pending
    await new Promise((r) => setTimeout(r, 50));
    expect((await gapMod.drainGapForwardQueue()).stopped).toBe("the holder is still unreachable");
    await new Promise((r) => setTimeout(r, 50));
    expect(files(QDIR).length).toBe(1);
    mode = "up"; sent = [];
    await gapMod.resolveSubstrateGap({ type: "substrateGap", id: "any" } as never); // any answer from the holder
    expect(await waitFor(() => files(QDIR).length === 0)).toBe(true);
    expect(writesSent().map((s) => [s.gap_id, s.write_id])).toEqual([[`q-replay-${SUFFIX}`, wid]]);
  });
  it("[MUST-FAIL] a holder that applied the write but whose answer was lost gets the same write id on the replay", async () => {
    mode = "apply-then-503";
    await write(gap(`q-lost-${SUFFIX}`));
    expect(files(QDIR).length).toBe(1);
    await gapMod.drainGapForwardQueue();
    const ids = writesSent().map((s) => s.write_id);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(files(QDIR).length).toBe(0);
  });
  it("[MUST-FAIL] while writes wait, a new write waits behind them, and the drain sends them in order", async () => {
    mode = "down503";
    await write(gap(`q-fifo-a-${SUFFIX}`));
    mode = "up"; sent = [];
    const r = await write(gap(`q-fifo-b-${SUFFIX}`));
    expect((r.body as { queued?: boolean }).queued).toBe(true);
    await waitFor(() => files(QDIR).length === 0);
    await gapMod.drainGapForwardQueue();
    expect(writesSent().map((s) => s.gap_id)).toEqual([`q-fifo-a-${SUFFIX}`, `q-fifo-b-${SUFFIX}`]);
  });
});

describe("what is never queued, and the bounds", () => {
  it("[MUST-FAIL] a caller with its own key is not queued: queue_refused principal_not_this_node", async () => {
    mode = "down503";
    const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${CALLER_KEY}` }, body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: gap(`q-caller-${SUFFIX}`) } } }) });
    const j = (await res.json()) as { body: { queued: boolean; queue_refused: string } };
    expect([j.body.queued, j.body.queue_refused]).toEqual([false, "principal_not_this_node"]);
    expect(files(QDIR)).toEqual([]);
  });
  it("[MUST-FAIL] a refusal (HTTP 401) is never queued", async () => {
    mode = "refuse";
    const r = await write(gap(`q-refuse-${SUFFIX}`));
    expect(r.shape).toBe("structuredError");
    expect((r.body as { queued?: unknown }).queued).toBeUndefined();
    expect(files(QDIR)).toEqual([]);
  });
  it("[MUST-FAIL] a holder that answers the gate read with a refusal (HTTP 401) queues nothing", async () => {
    mode = "refuse-read";
    const r = await write(gap(`q-refuse-read-${SUFFIX}`));
    expect((r.body as { failure_mode: string; queued: boolean })).toMatchObject({ failure_mode: "gap_store_unavailable", queued: false });
    expect(files(QDIR)).toEqual([]);
  });
  it("[MUST-FAIL] a full queue keeps nothing more and says queue_full", async () => {
    mkdirSync(QDIR, { recursive: true });
    for (let i = 0; i < queue.GAP_FORWARD_QUEUE_MAX_ENTRIES; i++) writeFileSync(join(QDIR, `000000000000001-${String(i).padStart(6, "0")}-filler.json`), "{}");
    mode = "down503";
    const r = await write(gap(`q-full-${SUFFIX}`));
    expect((r.body as { queued: boolean; queue_refused: string })).toMatchObject({ queued: false, queue_refused: "queue_full" });
    expect(files(QDIR).length).toBe(queue.GAP_FORWARD_QUEUE_MAX_ENTRIES);
    rmSync(QDIR, { recursive: true, force: true });
  });
  it("[MUST-FAIL] a replay the holder refuses is dead-lettered with its typed reason", async () => {
    mode = "down503";
    await write(gap(`q-dead-${SUFFIX}`));
    mode = "rule";
    await gapMod.drainGapForwardQueue();
    expect(files(QDIR)).toEqual([]);
    const d = files(DEAD);
    expect(d.length).toBe(1);
    expect((JSON.parse(readFileSync(join(DEAD, d[0]!), "utf-8")) as { dead_reason: string }).dead_reason).toBe("refused_on_replay:fixture_rule");
  });
  it("[MUST-FAIL] a transient failure during replay adds an attempt to the same entry, never a second entry", async () => {
    mode = "down503";
    await write(gap(`q-again-${SUFFIX}`));
    const r = await gapMod.drainGapForwardQueue();
    expect(r.stopped).toBe("the holder is still unreachable");
    const f = files(QDIR);
    expect(f.length).toBe(1);
    expect((JSON.parse(readFileSync(join(QDIR, f[0]!), "utf-8")) as { attempts: number }).attempts).toBe(1);
  });
  it("[CONTROL] with the holder up, a write goes straight through and nothing is queued", async () => {
    const r = await write(gap(`q-up-${SUFFIX}`));
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(files(QDIR)).toEqual([]);
    expect(writesSent().length).toBe(1);
  });
});

describe("a scratch store root does not queue unless a test opts in", () => {
  it("[CONTROL] with the opt-in off, a down holder fails closed as before: nothing queued, no write id sent", async () => {
    gapMod.__allowGapForwardQueueFromScratchForTests(false);
    try {
      mode = "down503";
      const r = await write(gap(`q-scratch-${SUFFIX}`));
      expect((r.body as { failure_mode: string }).failure_mode).toBe("gap_store_unavailable");
      expect(Object.keys(r.body as object).sort()).toEqual(["detail", "failure_mode", "resolver"]);
      expect(files(QDIR)).toEqual([]);
      expect(sent.every((s) => s.write_id === undefined)).toBe(true);
    } finally { gapMod.__allowGapForwardQueueFromScratchForTests(true); }
  });
});

describe("the holder applies a write id once", () => {
  it("[MUST-FAIL] a repeat of a write id answers duplicate_write_id and changes nothing, also after a restart", async () => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const wid = `wid-${SUFFIX}-0123456789`;
    const first = await gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", write_id: wid, gap: gap(`q-holder-${SUFFIX}`) }, { vocabulary: null });
    expect(first.shape).toBe("substrateGapWriteResult");
    const changed = { type: "substrateGap_write", write_id: wid, gap: gap(`q-holder-${SUFFIX}`, { classification_metadata: { note: "CHANGED-must-not-land" } }) };
    const again = await gapMod.resolveSubstrateGapWrite(changed, { vocabulary: null });
    expect((again.body as { action: string }).action).toBe("duplicate_write_id");
    gapMod.__resetAppliedWriteIdsForTests();
    const afterRestart = await gapMod.resolveSubstrateGapWrite(changed, { vocabulary: null });
    expect((afterRestart.body as { action: string }).action).toBe("duplicate_write_id");
    const rows = JSON.parse(readFileSync(join(STORE_ROOT, "gaps", "gaps.json"), "utf-8")) as Array<{ id: string; classification_metadata?: { note?: unknown } }>;
    expect(rows.filter((g) => g.id === `q-holder-${SUFFIX}`).map((g) => g.classification_metadata?.note ?? null)).toEqual([null]);
  });
  it("[CONTROL] a different write id for the same gap is applied", async () => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const r = await gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", write_id: `wid-other-${SUFFIX}-012345`, gap: gap(`q-holder-${SUFFIX}`, { classification_metadata: { note: "lands" } }) }, { vocabulary: null });
    expect((r.body as { action: string }).action).toBe("updated");
    const rows = JSON.parse(readFileSync(join(STORE_ROOT, "gaps", "gaps.json"), "utf-8")) as Array<{ id: string; classification_metadata?: { note?: unknown } }>;
    expect(rows.filter((g) => g.id === `q-holder-${SUFFIX}`).map((g) => g.classification_metadata?.note ?? null)).toEqual(["lands"]);
  });
});
