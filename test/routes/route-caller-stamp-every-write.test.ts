// THE ROUTE STAMP COMES FROM THE CREDENTIAL ON BOTH DOORS, FOR EVERY *_write SHAPE (2026-10-22).
//
// Measured: POST /resolvers/execute built its pointer from body.config and stamped _route_caller only for
// maintenanceLease_write, so a caller holding any valid key could send its own _route_caller in the config and reach
// substrateGap_write as a principal it chose (node-self, another key). The gap-write audit, the gap-write events and
// the autonomy measure all read that stamp. /v2/impulses/resolve stamped substrateGap_write and maintenanceLease_write
// only, so every other *_write shape carried the body's copy through. A write's event also could not say which door
// it came through, and an unstamped write reads as in-process, the system's own.
//
// CONTRACT pinned here:
//   - On /resolvers/execute and on /v2/impulses/resolve, a body-supplied _route_caller (and route name) is
//     overwritten by the route's own stamp for every *_write shape: the substrateGap_write event names the
//     principal the write gate validated, and a forwarding write shape (uiPanel_write) carries the route's stamp
//     onward, never the body's.
//   - Every gap-write event carries `route`: "impulses", "resolvers-execute", or "in-process" when no route stamped it.
//   - Control: a normal authenticated call with no body stamp still reaches the handler with the route's stamp.
//
// SEAMS. The real impulsesRouter (a query-string instance, past topology-chain's module mock) on a scratch gap store
// (no GAP_STORE_ENDPOINT), as in test/resolvers/gap-write-events.test.ts. identity-vessel and the ui write target are
// globalThis.fetch stubs; the gap-written publish is stubbed; any other call fails the test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
import { stubGapEventPublish } from "../resolvers/stub-gap-event-publish.js";

const gapEventPublishStub = stubGapEventPublish();

const ROOT = join(tmpdir(), `route-caller-stamp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const SAVED_EP = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
const gapMod = await import("../../src/resolvers/substrate-gap.js");
const { __resetCredentialCacheForTests } = await import("../../src/lib/caller-credential.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"route-caller-stamp-every-write"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const STORE_ROOT = gapMod.gapStoreRootForTest();
const EVENTS = join(STORE_ROOT, "gaps", "gap-write-events.jsonl");
const SUFFIX = Math.random().toString(36).slice(2, 8);
const IDENTITY = "http://127.0.0.1:59133";
const KEY = `sk-fixture-route-stamp-${SUFFIX}`;
const KEY_ID = `kidstamp${SUFFIX}`;
const OTHER_KEY_ID = `kidother${SUFFIX}`;
const AT = "2026-10-22T08:00:00.000Z";
// The principal a forger names: the node's own key, which the autonomy measure counts as the system.
const FORGED = { auth: "authenticated:node-self", remote: "remote-fixture-forged" };
const FORGED_KEY = { auth: `authenticated:key_id:${OTHER_KEY_ID}`, remote: "remote-fixture-forged" };
const STAMP = { auth: `authenticated:key_id:${KEY_ID}`, remote: "remote-fixture-door" };

type Ev = { gap_id: string | null; principal_kind: string; key_id: string | null; route_caller_remote: string | null; route?: string; outcome: string };
const eventsFor = (id: string): Ev[] => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf-8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev).filter((e) => e.gap_id === id);
const gap = (id: string) => ({ id, category: "systematic_failure", source: "human_reported", summary: `route stamp fixture ${id}`, detected_at: AT, status: "open", classification_metadata: {} });

const realFetch = globalThis.fetch;
let uiForwards: Array<Record<string, unknown>> = [];
let violations: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  // Never drive a live store: the root the gap module captured must be a scratch one.
  expect(gapMod.isScratchGapStoreRoot(STORE_ROOT)).toBe(true);
});
beforeEach(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "IDENTITY_VESSEL_URL", "METABOB_API_KEY", "DISCOVERY_ENDPOINT"]) saved[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["METABOB_API_KEY"];
  delete process.env["DISCOVERY_ENDPOINT"]; // the ui passthrough then delivers to its pinned endpoint only
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  __resetCredentialCacheForTests();
  uiForwards = []; violations = [];
  for (const m of ["log", "warn", "info", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
  const outer = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    const body = (() => { try { return JSON.parse(String(init?.body ?? "{}")); } catch { return {}; } })();
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      return body?.impulse?.pointer?.apiKey === KEY
        ? Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: KEY_ID, scopes: ["read", "write"] } })
        : Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u.endsWith("/v2/events/publish")) return outer(url as never, init as never);
    const p = body?.impulse?.pointer;
    if (u.endsWith("/resolve") && p?.type === "uiPanel_write") {
      uiForwards.push(p);
      return Response.json({ ok: true });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(violations).toEqual([]);
});
afterAll(() => {
  gapEventPublishStub.restore();
  if (SAVED_EP === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = SAVED_EP;
  rmSync(ROOT, { recursive: true, force: true });
});

const headers = { "Content-Type": "application/json", Authorization: `ApiKey ${KEY}`, "x-dv-remote-addr": STAMP.remote };
const execute = (resolver: string, config: Record<string, unknown>) => impulsesRouter.request("/resolvers/execute", { method: "POST", headers, body: JSON.stringify({ resolver, config }) });
const resolve = (pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers, body: JSON.stringify({ impulse: { pointer } }) });
async function gapEvent(id: string, send: () => Promise<Response>): Promise<Ev> {
  const before = eventsFor(id).length;
  const res = await send();
  expect(res.status).toBe(200);
  await gapMod.__settleGapWriteEventsForTests();
  const evs = eventsFor(id).slice(before);
  expect(evs).toHaveLength(1);
  return evs[0]!;
}

describe("route-stamp MUST-FAIL: a body-supplied _route_caller never reaches a writer", () => {
  it("route-stamp MUST-FAIL a forged node-self _route_caller in /resolvers/execute config is overwritten: the gap write is the validated key, route resolvers-execute", async () => {
    const id = `route-stamp-exec-${SUFFIX}`;
    const ev = await gapEvent(id, () => execute("substrateGap_write", { _route_caller: FORGED, _route: "impulses", gap: gap(id) }));
    expect(ev).toMatchObject({ outcome: "written", principal_kind: "key", key_id: KEY_ID.slice(0, 6), route_caller_remote: STAMP.remote, route: "resolvers-execute" });
  });

  it("route-stamp MUST-FAIL a forged other-key _route_caller on /v2/impulses/resolve is overwritten: the gap write is the validated key, route impulses", async () => {
    const id = `route-stamp-v2-${SUFFIX}`;
    const ev = await gapEvent(id, () => resolve({ type: "substrateGap_write", _route_caller: FORGED_KEY, _route: "resolvers-execute", gap: gap(id) }));
    expect(ev).toMatchObject({ outcome: "written", principal_kind: "key", key_id: KEY_ID.slice(0, 6), route_caller_remote: STAMP.remote, route: "impulses" });
  });

  it("route-stamp MUST-FAIL a *_write shape the route never named (uiPanel_write) carries the route stamp onward on both doors, never the body's", async () => {
    const panel = { id: `route-stamp-panel-${SUFFIX}`, title: "route stamp fixture", body: "b" };
    expect((await resolve({ type: "uiPanel_write", ...panel, _route_caller: FORGED, _route: "resolvers-execute" })).status).toBe(200);
    expect((await execute("uiPanel_write", { ...panel, _route_caller: FORGED, _route: "impulses" })).status).toBe(200);
    expect(uiForwards).toHaveLength(2);
    expect(uiForwards[0]!["_route_caller"]).toEqual(STAMP);
    expect(uiForwards[0]!["_route"]).toBe("impulses");
    expect(uiForwards[1]!["_route_caller"]).toEqual(STAMP);
    expect(uiForwards[1]!["_route"]).toBe("resolvers-execute");
  });

  it("route-stamp MUST-FAIL a write no route stamped records route in-process, even with a hand-set _route_caller", async () => {
    const bare = `route-stamp-inproc-${SUFFIX}`;
    const handSet = `route-stamp-handset-${SUFFIX}`;
    const write = gapMod.resolveSubstrateGapWrite as unknown as (p: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>;
    await write({ type: "substrateGap_write", gap: gap(bare) }, { vocabulary: null });
    await write({ type: "substrateGap_write", _route_caller: STAMP, gap: gap(handSet) }, { vocabulary: null });
    await gapMod.__settleGapWriteEventsForTests();
    expect(eventsFor(bare).map((e) => [e.principal_kind, e.route])).toEqual([["in-process", "in-process"]]);
    expect(eventsFor(handSet).map((e) => [e.principal_kind, e.route])).toEqual([["key", "in-process"]]);
  });
});

describe("route-stamp control", () => {
  it("route-stamp control a normal authenticated gap write on /v2/impulses/resolve still reaches the handler with the route's stamp", async () => {
    const id = `route-stamp-control-${SUFFIX}`;
    const ev = await gapEvent(id, () => resolve({ type: "substrateGap_write", gap: gap(id) }));
    expect(ev).toMatchObject({ outcome: "written", principal_kind: "key", key_id: KEY_ID.slice(0, 6), route_caller_remote: STAMP.remote });
  });

  it("route-stamp control a normal authenticated uiPanel_write through /resolvers/execute is delivered", async () => {
    const res = await execute("uiPanel_write", { id: `route-stamp-panel-ctl-${SUFFIX}`, title: "t", body: "b" });
    expect(res.status).toBe(200);
    expect(uiForwards).toHaveLength(1);
    expect(uiForwards[0]!["id"]).toBe(`route-stamp-panel-ctl-${SUFFIX}`);
  });
});
