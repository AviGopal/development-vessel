// EVERY GAP WRITE LEAVES ONE SHAPED EVENT, NAMES ONLY (2026-10-20).
//
// gaps.json keeps only each row's latest state, /gaps/ is not in git, and substrateGap_write is not traced, so who
// wrote which field when could not be established from the store; the [gap-audit] journal line covers only writes
// carrying the operator marker.
//
// CONTRACT: every resolveSubstrateGapWrite call (saved, refused or thrown) appends exactly one event to
// gaps/gap-write-events.jsonl beside the store, in the same call: gap_id, fields_changed (names), status_from,
// status_to, outcome (written | refused:<rule> | threw), principal_kind, key_id (first 6 chars of the identity key
// id), route_caller_remote, operator_marker, store, ts. No field value, no summary text, nothing derived from a
// presented key. The gapWriteEvent shape reads them back, filtered by gap_id / since / limit. A failed append is
// logged with the gap id and the write's own result is unchanged.
//
// SEAM: resolveSubstrateGapWrite in-process with a hand-set _route_caller (the route's overwrite of a client copy is
// pinned by gap-write-operator-marker-audit.test.ts), plus one write through the real impulsesRouter with a stubbed
// identity, all on a scratch store (no GAP_STORE_ENDPOINT).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";

const gapEventPublishStub = stubGapEventPublish();

const ROOT = join(tmpdir(), `gap-write-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const SAVED_EP = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
const gapMod = (await import("../../src/resolvers/substrate-gap.js")) as Record<string, unknown> & typeof import("../../src/resolvers/substrate-gap.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-write-events"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const write = gapMod.resolveSubstrateGapWrite as (p: Record<string, unknown>, o?: Record<string, unknown>) => Promise<{ shape: string; body: Record<string, unknown> }>;
const readEvents = gapMod["resolveGapWriteEvent"] as undefined | ((p: Record<string, unknown>) => Promise<{ shape: string; body: { events: Array<Record<string, unknown>>; matched: number } }>);
const settle = async () => { await (gapMod["__settleGapWriteEventsForTests"] as undefined | (() => Promise<void>))?.(); };

// The root this module actually writes (it may have lost the module-load race in a multi-file run).
const STORE_ROOT = gapMod.gapStoreRootForTest();
const EVENTS = join(STORE_ROOT, "gaps", "gap-write-events.jsonl");
const SUFFIX = Math.random().toString(36).slice(2, 8);
const ROW = `gap-write-events-fixture-row-${SUFFIX}`;
const AT = "2026-10-20T10:00:00.000Z";
const SUMMARY = `SUMMARY-SENTINEL-${SUFFIX} an open gap the event layer must never copy`;
const VALUE = `VALUE-SENTINEL-${SUFFIX}`;
const SECRET = `sk-fixture-gap-write-events-SECRET-${SUFFIX}`;
const KEY_ID = `kid${SUFFIX}0123456789abcdef`;
const base = (id: string, extra: Record<string, unknown> = {}) => ({ id, category: "systematic_failure", source: "human_reported", summary: SUMMARY, detected_at: AT, status: "open", classification_metadata: { note: VALUE }, ...extra });

type Ev = { gap_id: string | null; fields_changed: string[]; status_from: string; status_to: string; outcome: string; principal_kind: string; key_id: string | null; route_caller_remote: string | null; operator_marker: boolean; store: string; ts: string };
const fileText = (): string => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf-8") : "");
const eventsFor = (id: string): Ev[] => fileText().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev).filter((e) => e.gap_id === id);
/** Run one write and return it with the events it appended for `id`. */
async function writeAndCollect(id: string, pointer: Record<string, unknown>): Promise<{ r: { shape: string; body: Record<string, unknown> }; evs: Ev[] }> {
  const before = eventsFor(id).length;
  const r = await write({ type: "substrateGap_write", ...pointer }, { vocabulary: null });
  await settle();
  return { r, evs: eventsFor(id).slice(before) };
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  // Never drive a live store: the root this module captured must be a scratch one.
  expect(gapMod.isScratchGapStoreRoot(STORE_ROOT)).toBe(true);
});
afterAll(() => {
  gapEventPublishStub.restore();
  if (SAVED_EP === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = SAVED_EP;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("every gap write leaves exactly one names-only event", () => {
  it("[MUST-FAIL] a marked authenticated write and an unmarked write on one row each leave one event with its fields, transition, principal and marker", async () => {
    const c = await writeAndCollect(ROW, { gap: base(ROW) });
    expect(c.r.shape).toBe("substrateGapWriteResult");
    expect(c.evs).toHaveLength(1);
    expect(c.evs[0]).toMatchObject({ gap_id: ROW, status_from: "absent", status_to: "open", outcome: "written", principal_kind: "in-process", key_id: null, operator_marker: false, store: "local" });
    expect(c.evs[0]!.fields_changed).toEqual(expect.arrayContaining(["summary", "status", "classification_metadata.note"]));

    const u = await writeAndCollect(ROW, {
      _route_caller: { auth: "authenticated:node-self", remote: "remote-fixture-b" },
      gap: base(ROW, { summary: `${SUMMARY} (refreshed)` }),
    });
    expect(u.r.shape).toBe("substrateGapWriteResult");
    expect(u.evs).toHaveLength(1);
    expect(u.evs[0]).toMatchObject({ gap_id: ROW, status_from: "open", status_to: "open", outcome: "written", principal_kind: "node-self", key_id: null, route_caller_remote: "remote-fixture-b", operator_marker: false });
    expect(u.evs[0]!.fields_changed).toContain("summary");
    expect(u.evs[0]!.fields_changed).not.toContain("status");
    expect(u.evs[0]!.fields_changed).not.toContain("classification_metadata.note");

    const m = await writeAndCollect(ROW, {
      operator: "operator:fixture",
      _route_caller: { auth: `authenticated:key_id:${KEY_ID}`, remote: "remote-fixture-a" },
      gap: base(ROW, { summary: `${SUMMARY} (refreshed)`, status: "closed", classification_metadata: { note: VALUE, closed_reason: "fixture_superseded" } }),
    });
    expect(m.r.shape).toBe("substrateGapWriteResult");
    expect(m.evs).toHaveLength(1);
    expect(m.evs[0]).toMatchObject({ gap_id: ROW, status_from: "open", status_to: "closed", outcome: "written", principal_kind: "key", key_id: KEY_ID.slice(0, 6), route_caller_remote: "remote-fixture-a", operator_marker: true });
    expect(m.evs[0]!.fields_changed).toEqual(expect.arrayContaining(["status", "closed_at", "classification_metadata.closed_reason"]));
    expect(m.evs[0]!.fields_changed).not.toContain("summary");
  });

  it("[MUST-FAIL] a refused write records outcome refused with its rule, before and after the store is read", async () => {
    const id = `${ROW}-refused`;
    await writeAndCollect(id, { gap: base(id) });
    const r = await writeAndCollect(id, { gap: base(id, { status: "closed", classification_metadata: {} }) });
    expect(r.r.shape).toBe("structuredError");
    expect(r.evs).toHaveLength(1);
    expect(r.evs[0]).toMatchObject({ gap_id: id, status_from: "open", status_to: "closed", outcome: "refused:close_needs_evidence", principal_kind: "in-process", operator_marker: false });
    expect(r.evs[0]!.fields_changed).toContain("status");
    const early = await writeAndCollect(id, { gap: { ...base(id), classification_metadata: "not-an-object" } });
    expect(early.r.shape).toBe("structuredError");
    expect(early.evs).toHaveLength(1);
    expect(early.evs[0]).toMatchObject({ gap_id: id, status_from: "?", outcome: "refused:classification_metadata_must_be_object" });
  });

  it("[MUST-FAIL] a write through the route is recorded with the principal its write gate validated", async () => {
    const IDENTITY = "http://127.0.0.1:59131";
    const savedIdentity = process.env["IDENTITY_VESSEL_URL"];
    process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
    const prior = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url) === `${IDENTITY}/v1/auth/resolve`) {
        const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
        return key === SECRET ? Response.json({ success: true, data: { authenticated: true, scopes: ["read", "write"], keyId: KEY_ID } }) : Response.json({ success: false }, { status: 401 });
      }
      return prior(url as never, init as never);
    }) as unknown as typeof fetch;
    const id = `${ROW}-route`;
    try {
      const before = eventsFor(id).length;
      const res = await impulsesRouter.request("/v2/impulses/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${SECRET}`, "x-dv-remote-addr": "remote-fixture-route" },
        body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: base(id) } } }),
      });
      expect(res.status).toBe(200);
      await settle();
      const evs = eventsFor(id).slice(before);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ gap_id: id, outcome: "written", principal_kind: "key", key_id: KEY_ID.slice(0, 6), route_caller_remote: "remote-fixture-route", operator_marker: false });
    } finally {
      globalThis.fetch = prior;
      if (savedIdentity === undefined) delete process.env["IDENTITY_VESSEL_URL"]; else process.env["IDENTITY_VESSEL_URL"] = savedIdentity;
    }
  });

  it("[MUST-FAIL] no event carries a key, a hash prefix of one, the full key id, the summary or any field value", async () => {
    const id = `${ROW}-noleak`;
    await writeAndCollect(id, { _route_caller: { auth: `authenticated:key_id:${KEY_ID}`, remote: "remote-fixture-a" }, apiKey: SECRET, gap: base(id, { classification_metadata: { note: VALUE, carried_key: SECRET } }) });
    expect(eventsFor(id)).toHaveLength(1);
    const text = fileText();
    expect(text.length).toBeGreaterThan(0);
    const needles = [SECRET, KEY_ID, KEY_ID.slice(0, 7), SUMMARY, `SUMMARY-SENTINEL-${SUFFIX}`, VALUE];
    for (const alg of ["sha256", "sha1"]) {
      const hex = createHash(alg).update(SECRET).digest("hex");
      for (let n = 8; n <= hex.length; n++) needles.push(hex.slice(0, n));
    }
    for (const n of needles) expect(text.toLowerCase().includes(n.toLowerCase())).toBe(false);
  });

  it("[MUST-FAIL] the gapWriteEvent shape returns the events filtered by gap_id, since and limit", async () => {
    expect(typeof readEvents).toBe("function");
    const all = await readEvents!({ type: "gapWriteEvent", gap_id: ROW });
    expect(all.shape).toBe("gapWriteEvent");
    expect(all.body.events).toHaveLength(3);
    expect(all.body.events.every((e) => e["gap_id"] === ROW)).toBe(true);
    expect(all.body.events.map((e) => e["status_to"])).toEqual(["open", "open", "closed"]);
    const last = await readEvents!({ type: "gapWriteEvent", gap_id: ROW, limit: 1 });
    expect(last.body.events).toHaveLength(1);
    expect(last.body.events[0]!["status_to"]).toBe("closed");
    const later = await readEvents!({ type: "gapWriteEvent", gap_id: ROW, since: "2999-01-01T00:00:00Z" });
    expect(later.body.events).toHaveLength(0);
    const viaRoute = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "gapWriteEvent", gap_id: `${ROW}-refused` } } }) });
    const j = (await viaRoute.json()) as { shape?: string; body?: { events?: Array<Record<string, unknown>> } };
    expect(j.shape).toBe("gapWriteEvent");
    expect(j.body?.events?.map((e) => e["outcome"])).toEqual(["written", "refused:close_needs_evidence", "refused:classification_metadata_must_be_object"]);
  });

  it("[UNIT] retention keeps the newest events under the cap", async () => {
    const setCap = gapMod["__setGapWriteEventsMaxBytesForTests"] as (n: number | null) => void;
    const id = `${ROW}-retention`;
    setCap(4096);
    try {
      for (let i = 0; i < 12; i++) await writeAndCollect(id, { gap: base(id, { summary: `${SUMMARY} ${i}` }) });
      await settle();
      expect(Buffer.byteLength(fileText())).toBeLessThanOrEqual(4096);
      const kept = eventsFor(id);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(12);
      expect(kept.at(-1)!.status_from).toBe("open");
    } finally { setCap(null); }
  });
});

// The write's own answer, pinned: the same literal on the parent (no event layer) and with it, on, off, and failing.
const SEQUENCE = (id: string) => [
  { gap: base(id) },
  { gap: base(id, { summary: `${SUMMARY} (refreshed)` }) },
  { gap: base(id, { status: "closed", classification_metadata: {} }) },
  { operator: "operator:fixture", gap: base(id, { status: "closed", classification_metadata: { closed_reason: "fixture_superseded" } }) },
];
const EXPECTED = (id: string) => JSON.stringify([
  { shape: "substrateGapWriteResult", body: { id, action: "created", gap_class: id, falsifier: "none" } },
  { shape: "substrateGapWriteResult", body: { id, action: "updated", gap_class: id, falsifier: "none" } },
  { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "validation_rejected", rule: "close_needs_evidence", detail: `gap ${id}: a closed write needs closed_reason (or rejected_reason) plus evidence; missing closed_reason or rejected_reason (a non-empty string in classification_metadata or on the gap). The row stays open.` } },
  { shape: "substrateGapWriteResult", body: { id, action: "updated", gap_class: id, falsifier: "none" } },
]);
async function runSequence(id: string): Promise<string> {
  const out: unknown[] = [];
  for (const p of SEQUENCE(id)) out.push(await write({ type: "substrateGap_write", ...p }, { vocabulary: null }));
  await settle();
  return JSON.stringify(out);
}

describe("the event layer never changes the write's own result", () => {
  it("[CONTROL] the write results are byte-identical to the pinned literal (parent and fix alike)", async () => {
    const id = `${ROW}-ctl-on`;
    expect(await runSequence(id)).toBe(EXPECTED(id));
  });
  it("[CONTROL] with the event layer off the results are the same literal", async () => {
    const off = gapMod["__setGapWriteEventsEnabledForTests"] as undefined | ((on: boolean) => void);
    const id = `${ROW}-ctl-off`;
    off?.(false);
    try { expect(await runSequence(id)).toBe(EXPECTED(id)); } finally { off?.(true); }
    if (off) expect(eventsFor(id)).toHaveLength(0);
  });
  it("[CONTROL] an append that fails is logged with the gap id and the results are the same literal", async () => {
    const id = `${ROW}-ctl-fail`;
    const moved = `${EVENTS}.moved`;
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const { renameSync } = await import("node:fs");
    if (existsSync(EVENTS)) renameSync(EVENTS, moved);
    mkdirSync(EVENTS); // a directory where the file goes: every append fails
    try {
      expect(await runSequence(id)).toBe(EXPECTED(id));
      if (readEvents) expect(lines.some((l) => l.includes("[gap-write-event]") && l.includes(`gap=${id}`))).toBe(true);
    } finally {
      spy.mockRestore();
      rmSync(EVENTS, { recursive: true, force: true });
      if (existsSync(moved)) renameSync(moved, EVENTS);
    }
  });
});
