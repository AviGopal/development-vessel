import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tick from "../../src/resolvers/substrate-health-tick.js";

// A vessel whose unit is active but which holds no discovery record is unreachable by routing. The ribosome
// registered `shapes: []`, discovery refused it with a 400 every minute for days, and every liveness view read the
// vessel as healthy because liveness was `systemctl is-active` alone. The health tick now joins the vessels running
// here against discovery's registry, reports the ones missing, and files ONE gap per vessel after N ticks.

const originalFetch = globalThis.fetch;
const TEMPLATES = [{ id: "t:0", created_at: new Date(Date.now() - 7200_000).toISOString() }];
const fetchStub = (async (url: string) => {
  const u = String(url);
  if (u.includes("/v2/activities/templates")) {
    const offset = Number(new URL(u, "http://x").searchParams.get("offset") ?? "0");
    return new Response(JSON.stringify({ templates: offset === 0 ? TEMPLATES : [], total: TEMPLATES.length }), { status: 200 });
  }
  if (u.includes("/v2/activities/execution-traces")) return new Response(JSON.stringify({ executions: [] }), { status: 200 });
  if (u.includes("/v2/activities/composition")) return new Response(JSON.stringify({ edges: [] }), { status: 200 });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const INVENTORY = {
  vessels: [
    { unit: "discovery-vessel.service", role: "registry", repo: "discovery-vessel", health_port: 8100 },
    { unit: "activity-api.service", role: "api", repo: "activity-api", health_port: 8080 },
    { unit: "concept-db.service", role: "store", repo: "concept-db", health_port: 8260 },
    { unit: "ribosome-vessel.service", role: "compute", repo: "ribosome-vessel", health_port: 8240 },
    { unit: "light-dispatch-vessel.service", role: "compute", repo: "light-dispatch-vessel", health_port: 8280 },
    { unit: "boredom-vessel.service", role: "compute", repo: "boredom-vessel" },
    { unit: "analysis-vessel.service", role: "compute", repo: "analysis-vessel", retired: true },
    { unit: "surrealdb.service", role: "store", repo: null },
  ],
};
const REFUSAL = "[DiscoveryRegistrationLoop] register failed: 400 (shapes must be a non-empty array of non-empty strings) for ribosome-vessel";

type Registration = {
  measured: boolean;
  registered: Record<string, string>;
  remote_only: Record<string, string>;
  unregistered: string[];
  not_expected: string[];
  unregistered_ticks: Record<string, number>;
  alarm_ticks: { value: number; source: string };
  gaps_filed: string[];
};
type Body = { vessel_registration: Registration; vessel_liveness: { statuses: Record<string, string>; down: string[]; vessel_set: { source: string } } };

let dir = "";
let invPath = "";
let gaps: Array<Record<string, unknown>> = [];
let registry: string[] | null = [];
let units: Record<string, { active: string; enabled: string }> = {};

function install(inv: unknown = INVENTORY): void {
  invPath = join(dir, `inventory-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(invPath, JSON.stringify(inv));
  tick.__setSubstrateHealthTickDepsForTests({
    unitState: async (unit) => units[unit] ?? { active: "active", enabled: "" },
    registryIds: async () => registry,
    lastRegisterFailure: async (unit) => (unit === "ribosome-vessel.service" ? REFUSAL : null),
    alarmTicks: async () => 3,
    writeGap: async (p) => { gaps.push(p); return { shape: "substrateGap_write", body: { success: true } }; },
    heartbeatPath: () => join(dir, "substrate-heartbeat.json"),
  });
}
async function run(): Promise<Body> {
  const r = await tick.resolveSubstrateHealthTick({ type: "substrate_health_tick", inventory_path: invPath });
  return r.body as unknown as Body;
}

describe("substrate_health_tick: running but unregistered", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
    globalThis.fetch = fetchStub;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    tick.__setSubstrateHealthTickDepsForTests?.(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "health-tick-reg-"));
    gaps = [];
    units = {};
    registry = ["activity-api-local", "concept-db-local", "light-dispatch-vessel", "development-vessel-local@peer-a"];
  };

  it("must-fail: a running vessel with an empty-shape registration is reported unregistered and files exactly one gap at N ticks", async () => {
    fresh();
    install();
    const first = await run();
    expect(typeof tick.__setSubstrateHealthTickDepsForTests).toBe("function");
    expect(first.vessel_registration.measured).toBe(true);
    expect(first.vessel_registration.unregistered).toEqual(["ribosome-vessel"]);
    expect(first.vessel_registration.alarm_ticks).toEqual({ value: 3, source: "tuning:substrate_health.unregistered_alarm_ticks" });
    expect(gaps.length).toBe(0);
    await run();
    expect(gaps.length).toBe(0);
    const third = await run();
    expect(third.vessel_registration.unregistered_ticks).toEqual({ "ribosome-vessel": 3 });
    expect(gaps.length).toBe(1);
    const gap = (gaps[0]!["gap"] ?? {}) as { id?: string; summary?: string; classification_metadata?: Record<string, unknown> };
    expect(gap.id).toBe(`${tick.UNREGISTERED_GAP_PREFIX}ribosome-vessel`);
    expect(gap.summary).toContain("ribosome-vessel");
    expect(gap.summary).toContain("shapes must be a non-empty array of non-empty strings");
    expect(gap.classification_metadata?.["vessel"]).toBe("ribosome-vessel");
    expect(third.vessel_registration.gaps_filed).toEqual([`${tick.UNREGISTERED_GAP_PREFIX}ribosome-vessel`]);
    // Once per episode: a fourth unregistered tick files nothing more.
    await run();
    expect(gaps.length).toBe(1);
  });

  it("control: registered vessels are not reported, the registry is not expected to list itself, and no gap is filed", async () => {
    fresh();
    registry = [...(registry ?? []), "ribosome-vessel"];
    install();
    for (let i = 0; i < 4; i++) {
      const b = await run();
      expect(b.vessel_registration.unregistered).toEqual([]);
      expect(b.vessel_registration.registered).toEqual({
        "activity-api": "activity-api-local",
        "concept-db": "concept-db-local",
        "ribosome-vessel": "ribosome-vessel",
        "light-dispatch-vessel": "light-dispatch-vessel",
      });
      expect(b.vessel_registration.not_expected).toEqual(["discovery-vessel"]);
      expect(b.vessel_registration.unregistered_ticks).toEqual({});
    }
    expect(gaps.length).toBe(0);
  });

  it("a vessel declared registers:false is not expected to register", async () => {
    fresh();
    install({ vessels: INVENTORY.vessels.map((r) => (r.repo === "ribosome-vessel" ? { ...r, registers: false } : r)) });
    for (let i = 0; i < 4; i++) {
      const b = await run();
      expect(b.vessel_registration.unregistered).toEqual([]);
      expect(b.vessel_registration.not_expected).toEqual(["discovery-vessel", "ribosome-vessel"]);
    }
    expect(gaps.length).toBe(0);
  });

  it("registering resets the streak; an unreadable registry leaves it unmeasured and unchanged", async () => {
    fresh();
    install();
    await run();
    await run();
    registry = null;
    const blind = await run();
    expect(blind.vessel_registration.measured).toBe(false);
    expect(blind.vessel_registration.unregistered_ticks).toEqual({ "ribosome-vessel": 2 });
    registry = ["activity-api-local", "concept-db-local", "light-dispatch-vessel", "ribosome-vessel"];
    const back = await run();
    expect(back.vessel_registration.unregistered_ticks).toEqual({});
    expect(gaps.length).toBe(0);
  });

  it("only a federated (@peer) row is remote_only, never alarmed", async () => {
    fresh();
    registry = ["activity-api-local", "concept-db-local", "light-dispatch-vessel", "ribosome-vessel@peer-a"];
    install();
    for (let i = 0; i < 4; i++) {
      const b = await run();
      expect(b.vessel_registration.remote_only).toEqual({ "ribosome-vessel": "ribosome-vessel@peer-a" });
      expect(b.vessel_registration.unregistered).toEqual([]);
    }
    expect(gaps.length).toBe(0);
  });

  it("the vessel set comes from the inventory, and a unit this node does not run is not_placed, not down", async () => {
    fresh();
    units = { "light-dispatch-vessel.service": { active: "inactive", enabled: "masked" }, "concept-db.service": { active: "inactive", enabled: "enabled" } };
    install();
    const b = await run();
    expect(b.vessel_liveness.vessel_set.source).toBe("inventory");
    expect(Object.keys(b.vessel_liveness.statuses).sort()).toEqual(["activity-api", "concept-db", "discovery-vessel", "light-dispatch-vessel", "ribosome-vessel"]);
    expect(b.vessel_liveness.statuses["light-dispatch-vessel"]).toBe("not_placed");
    expect(b.vessel_liveness.down).toEqual(["concept-db"]);
    // A vessel that is not running is not judged for registration.
    expect(b.vessel_registration.unregistered).toEqual(["ribosome-vessel"]);
  });
});
