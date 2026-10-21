import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readdirSync } from "node:fs";
import * as mod from "../../src/resolvers/maintenance-lease.js";
import { __resetMaintenanceLeaseCacheForTests } from "../../src/resolvers/http-retry.js";

// WHO HOLDS A LEASE (maintenance-lease.ts): the holder is the principal the resolve route stamped in _route_caller,
// never the body's `holder`; only node-self takes, renews or releases a system lease; a hold is bounded in total.
// The route stamps exactly these labels (routes/caller-identity.ts callerAuthLabel). An unstamped call is in-process.
// Each case uses its own lease name, so the cases do not depend on one another's state.
const dir = join(tmpdir(), `dev-vessel-lease-authority-${process.pid}-${Date.now()}`);
process.env["MAINTENANCE_LEASE_PATH"] = join(dir, "maintenance.json");

const KEY_A = { auth: "authenticated:key_id:aaaaaa111111", remote: "test" };
const KEY_B = { auth: "authenticated:key_id:bbbbbb222222", remote: "test" };
const NODE = { auth: "authenticated:node-self", remote: "test" };

// The clock and the bound's tuning read, injected where the module offers them (no network).
let clock = Date.now();
let boundS: number | null = null;
const setDeps = (mod as Record<string, unknown>)["__setMaintenanceLeaseDepsForTests"] as
  | ((d: { now?: () => number; maxTotalHoldS?: () => Promise<number | null> } | null) => void)
  | undefined;
setDeps?.({ now: () => clock, maxTotalHoldS: async () => boundS });

afterAll(() => {
  setDeps?.(null);
  rmSync(dir, { recursive: true, force: true });
  __resetMaintenanceLeaseCacheForTests();
});

type Body = Record<string, unknown>;
const write = async (p: Record<string, unknown>): Promise<{ shape: string; body: Body }> =>
  (await mod.resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", ...p } as mod.MaintenanceLeaseWritePointer)) as { shape: string; body: Body };
const status = async (name: string): Promise<Body> => (await mod.resolveMaintenanceLease({ type: "maintenanceLease", name })).body as Body;

describe("maintenanceLease_write: the holder is the credential", () => {
  it("a body-supplied holder does not become the holder of a stamped call", async () => {
    const r = await write({ op: "acquire", name: "ops_window_a", holder: "cutover:goal-host-vessel", _route_caller: KEY_A });
    expect(r.body["acquired"]).toBe(true);
    expect(r.body["holder"]).toBe("key_id:aaaaaa");
    expect((await status("ops_window_a"))["holder"]).toBe("key_id:aaaaaa");
    await write({ op: "release", name: "ops_window_a", token: r.body["token"], _route_caller: KEY_A });
  });

  it("knowing a hold's holder name does not take it over: another key naming it is refused and gets no token", async () => {
    const own = await write({ op: "acquire", name: "ops_window_b", holder: "ops-a", _route_caller: KEY_A });
    expect(own.body["acquired"]).toBe(true);
    const r = await write({ op: "acquire", name: "ops_window_b", holder: String(own.body["holder"]), _route_caller: KEY_B });
    await write({ op: "release", name: "ops_window_b", token: r.body["token"] ?? own.body["token"], _route_caller: KEY_A });
    expect(r.body["acquired"]).toBe(false);
    expect(r.body["token"]).toBeUndefined();
  });
});

describe("maintenanceLease_write: system leases are node-self's", () => {
  it("a key that is not node-self is refused autonomous_pick by name", async () => {
    const r = await write({ op: "acquire", name: "autonomous_pick", holder: "operator-window", _route_caller: KEY_A });
    const held = (await status("autonomous_pick"))["held"];
    if (r.body["token"]) await write({ op: "release", name: "autonomous_pick", token: r.body["token"] });
    expect(r.body["error"]).toBe("system_lease_requires_node_self");
    expect(held).toBe(false);
  });

  it("an in-process cutover hold is not taken over by a key presenting its holder name", async () => {
    const own = await write({ op: "acquire", name: "cutover", holder: "cutover:goal-host-vessel", ttl_ms: 600_000 });
    expect(own.body["acquired"]).toBe(true);
    const r = await write({ op: "acquire", name: "cutover", holder: "cutover:goal-host-vessel", _route_caller: KEY_A });
    await write({ op: "release", name: "cutover", token: r.body["token"] ?? own.body["token"] });
    expect(r.body["token"]).toBeUndefined();
    expect(r.body["error"]).toBe("system_lease_requires_node_self");
  });

  it("a key holding a system lease's token still cannot release it", async () => {
    const own = await write({ op: "acquire", name: "trace_store", holder: "trace-store-reconcile", ttl_ms: 300_000 });
    const r = await write({ op: "release", name: "trace_store", token: own.body["token"], _route_caller: KEY_A });
    const held = (await status("trace_store"))["held"];
    await write({ op: "release", name: "trace_store", token: own.body["token"] });
    expect(r.body["error"]).toBe("system_lease_requires_node_self");
    expect(held).toBe(true);
  });

  it("a key cannot take the unnamed global hold, which excludes every name", async () => {
    const r = await write({ op: "acquire", holder: "manual-db-work", _route_caller: KEY_A });
    if (r.body["token"]) await write({ op: "release", token: r.body["token"] });
    expect(r.body["error"]).toBe("system_lease_requires_node_self");
  });
});

describe("maintenanceLease_write: a hold has a total bound", () => {
  it("a renew past the bound releases the hold", async () => {
    boundS = 7200;
    const own = await write({ op: "acquire", name: "ops_window_c", holder: "ops-c", ttl_ms: 3_600_000, _route_caller: KEY_A });
    expect(own.body["acquired"]).toBe(true);
    clock += 3_000_000;
    expect((await write({ op: "renew", name: "ops_window_c", token: own.body["token"], ttl_ms: 3_600_000, _route_caller: KEY_A })).body["renewed"]).toBe(true);
    clock += 3_000_000;
    expect((await write({ op: "renew", name: "ops_window_c", token: own.body["token"], ttl_ms: 3_600_000, _route_caller: KEY_A })).body["renewed"]).toBe(true);
    clock += 3_000_000; // 9,000 s since the acquire, past the 7,200 s bound
    const r = await write({ op: "renew", name: "ops_window_c", token: own.body["token"], ttl_ms: 3_600_000, _route_caller: KEY_A });
    const fileLeft = readdirSync(dir).some((f) => f.includes("ops_window_c"));
    if (r.body["renewed"] === true) await write({ op: "release", name: "ops_window_c", token: own.body["token"], _route_caller: KEY_A });
    boundS = null;
    expect(r.body["renewed"]).toBe(false);
    expect(r.body["error"]).toBe("total_hold_bound_reached");
    expect(fileLeft).toBe(false);
  });

  it("re-acquiring a held lease keeps its acquired_at, so it does not restart the count", async () => {
    const first = await write({ op: "acquire", name: "ops_window_d", holder: "ops-d", _route_caller: KEY_A });
    const firstAt = (await status("ops_window_d"))["acquired_at"];
    clock += 60_000;
    await new Promise((r) => setTimeout(r, 5)); // where no clock can be injected, real time still moves
    const again = await write({ op: "acquire", name: "ops_window_d", holder: "ops-d", _route_caller: KEY_A });
    const againAt = (await status("ops_window_d"))["acquired_at"];
    await write({ op: "release", name: "ops_window_d", token: again.body["token"] ?? first.body["token"], _route_caller: KEY_A });
    expect(first.body["acquired"]).toBe(true);
    expect(again.body["acquired"]).toBe(true);
    expect(againAt).toBe(firstAt);
  });
});

describe("maintenanceLease_write: re-acquiring past the bound", () => {
  it("when the bound is lowered under a live hold, its own holder re-acquiring is refused, not handed a fresh hold", async () => {
    const own = await write({ op: "acquire", name: "ops_window_f", holder: "ops-f", ttl_ms: 3_600_000, _route_caller: KEY_A });
    expect(own.body["acquired"]).toBe(true);
    boundS = 3200; // the tuning row is lowered; this renew starts the read, so the next op sees 3,200 s
    clock += 3_000_000;
    const renewed = await write({ op: "renew", name: "ops_window_f", token: own.body["token"], ttl_ms: 3_600_000, _route_caller: KEY_A });
    clock += 300_000; // 3,300 s since the acquire, past the lowered bound, the hold still unexpired
    const r = await write({ op: "acquire", name: "ops_window_f", holder: "ops-f", ttl_ms: 3_600_000, _route_caller: KEY_A });
    const fileLeft = readdirSync(dir).some((f) => f.includes("ops_window_f"));
    await write({ op: "release", name: "ops_window_f", token: r.body["token"] ?? own.body["token"], _route_caller: KEY_A });
    boundS = null;
    expect(renewed.body["renewed"]).toBe(true);
    expect(r.body["acquired"]).toBe(false);
    expect(r.body["token"]).toBeUndefined();
    expect(r.body["error"]).toBe("total_hold_bound_reached");
    expect(fileLeft).toBe(false);
  });
});

describe("maintenanceLease_write: controls", () => {
  it("in process (the cutover's own calls), node-self takes, renews and releases a system lease, and two labels still exclude each other", async () => {
    const own = await write({ op: "acquire", name: "cutover", holder: "cutover:goal-host-vessel", ttl_ms: 600_000 });
    expect(own.body["acquired"]).toBe(true);
    expect(own.body["holder"]).toBe("cutover:goal-host-vessel");
    const other = await write({ op: "acquire", name: "cutover", holder: "proposal:p-1", ttl_ms: 600_000 });
    expect(other.body["acquired"]).toBe(false);
    expect(other.body["held_by"]).toBe("cutover:goal-host-vessel");
    expect((await write({ op: "renew", name: "cutover", token: own.body["token"], ttl_ms: 600_000 })).body["renewed"]).toBe(true);
    expect((await write({ op: "release", name: "cutover", token: own.body["token"] })).body["released"]).toBe(true);
    expect((await status("cutover"))["held"]).toBe(false);
  });

  it("through the route, node-self takes and releases trace_store", async () => {
    const own = await write({ op: "acquire", name: "trace_store", holder: "trace-store-reconcile", ttl_ms: 300_000, _route_caller: NODE });
    expect(own.body["acquired"]).toBe(true);
    expect((await status("trace_store"))["held"]).toBe(true);
    expect((await write({ op: "release", name: "trace_store", token: own.body["token"], _route_caller: NODE })).body["released"]).toBe(true);
    expect((await status("trace_store"))["held"]).toBe(false);
  });

  it("an authenticated key takes, renews and releases a non-system lease, and another key is refused it meanwhile", async () => {
    const own = await write({ op: "acquire", name: "ops_window_e", holder: "my-window", _route_caller: KEY_A });
    expect(own.body["acquired"]).toBe(true);
    expect((await write({ op: "acquire", name: "ops_window_e", holder: "their-window", _route_caller: KEY_B })).body["acquired"]).toBe(false);
    expect((await write({ op: "renew", name: "ops_window_e", token: own.body["token"], _route_caller: KEY_A })).body["renewed"]).toBe(true);
    expect((await write({ op: "release", name: "ops_window_e", token: own.body["token"], _route_caller: KEY_A })).body["released"]).toBe(true);
  });
});
