import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tick from "../../src/resolvers/substrate-health-tick.js";
import * as gapStore from "../../src/resolvers/substrate-gap.js";
import { evaluateGapCheck } from "../../src/judge/gap-check-judge.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";
import { resolveDiscoveryVesselRegistryObserver } from "../../src/resolvers/discovery-vessel-registry-observer.js";

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
  // The registry, for the observer the gap judge runs (verify-at-the-consumer test below).
  if (u.startsWith("http://registry.test/")) return Response.json({ content: { vessels: (registry ?? []).map((vesselId) => ({ vesselId, lastSeen: new Date().toISOString() })) } });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const INVENTORY = {
  vessels: [
    { unit: "discovery-vessel.service", role: "registry", repo: "discovery-vessel", health_port: 8100, registers: false },
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
let stored: Record<string, Record<string, unknown>> = {};
let armReads: Record<string, number | null> = {};

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
    readGap: async (id) => stored[id] ?? null,
    editSiteFor: (repo) => (repo === "ribosome-vessel" ? "repos/ribosome-vessel/src/index.ts" : null),
    armRead: async (vessel) => (vessel in armReads ? armReads[vessel]! : registry === null ? null : registry.some((id) => id === vessel) ? 0 : 1),
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
    stored = {};
    armReads = {};
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

  it("control: registered vessels are not reported, a registers:false row (discovery) is not expected, and no gap is filed", async () => {
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

  it("must-fail: the exemption is the inventory flag only; a role does not exempt (discovery without registers:false alarms)", async () => {
    fresh();
    registry = [...(registry ?? []), "ribosome-vessel"];
    install({ vessels: INVENTORY.vessels.map((r) => (r.repo === "discovery-vessel" ? { unit: r.unit, role: r.role, repo: r.repo, health_port: r.health_port } : r)) });
    for (let i = 0; i < 3; i++) expect((await run()).vessel_registration.unregistered).toEqual(["discovery-vessel"]);
    expect(gaps.map((g) => (g["gap"] as Record<string, unknown>)["id"])).toEqual([`${tick.UNREGISTERED_GAP_PREFIX}discovery-vessel`]);
  });

  // ── The gap the tick files carries the check the tick measured ────────────────────────────────────────────────
  const filedMeta = (): Record<string, unknown> => ((gaps[0]!["gap"] as Record<string, unknown>)["classification_metadata"] ?? {}) as Record<string, unknown>;
  const fileOne = async (): Promise<void> => { install(); await run(); await run(); await run(); expect(gaps.length).toBe(1); };

  it("must-fail: the filed gap is armed with a class-2 evidence_resolve over the registry observer's top-level missing_count", async () => {
    fresh();
    await fileOne();
    const meta = filedMeta();
    expect(meta["evidence_resolve"]).toEqual({ shape: "discovery_vessel_registry_observer", input: { vessel_ids: ["ribosome-vessel"] }, zero_field: "missing_count" });
    expect(meta["edit_site"]).toBe("repos/ribosome-vessel/src/index.ts");
    // An explicit vocabulary: a fail-open "cannot see" scan also returns class2, which would pass for the wrong reason.
    const vocab = { shapes: new Set(DISCOVERY_SHAPES), configs_read: 2 } as unknown as Parameters<typeof gapStore.classifyFalsifier>[1];
    const c = gapStore.classifyFalsifier(meta, vocab);
    expect(c.falsifier).toBe("class2");
    expect(c.predicate_position).toBe("evidence_resolve.shape");
  });

  // Birth (i)'s contract check. It is not on this tree's base yet; until it is, this test is SKIPPED (counted as a
  // skip, never a pass). With the observer's RESPONSE_CONTRACTS entry it certifies missing_count with vessel_ids given.
  const armingCheck = (gapStore as unknown as { checkArmingProblem?: (er: unknown) => unknown }).checkArmingProblem;
  it.skipIf(typeof armingCheck !== "function")("must-fail: the filed evidence_resolve passes checkArmingProblem", async () => {
    fresh();
    await fileOne();
    expect(armingCheck!(filedMeta()["evidence_resolve"])).toBeNull();
  });

  it("a vessel whose index.ts builds no registration loop gets no edit_site", async () => {
    fresh();
    registry = ["activity-api-local", "concept-db-local", "ribosome-vessel"];
    install();
    await run(); await run(); await run();
    expect(gaps.length).toBe(1);
    const gap = gaps[0]!["gap"] as Record<string, unknown>;
    expect(gap["id"]).toBe(`${tick.UNREGISTERED_GAP_PREFIX}light-dispatch-vessel`);
    expect("edit_site" in filedMeta()).toBe(false);
  });

  it("an existing row keeps its summary and category: the write carries only the merged metadata and the check", async () => {
    fresh();
    stored[`${tick.UNREGISTERED_GAP_PREFIX}ribosome-vessel`] = { id: `${tick.UNREGISTERED_GAP_PREFIX}ribosome-vessel`, summary: "filed by hand first", category: "detection", status: "open" };
    await fileOne();
    const gap = gaps[0]!["gap"] as Record<string, unknown>;
    expect("summary" in gap).toBe(false);
    expect("category" in gap).toBe(false);
    expect((filedMeta()["evidence_resolve"] as Record<string, unknown>)["zero_field"]).toBe("missing_count");
  });

  it("registers:true explicitly, running and absent alarms", async () => {
    fresh();
    install({ vessels: INVENTORY.vessels.map((r) => (r.repo === "ribosome-vessel" ? { ...r, registers: true } : r)) });
    await run(); await run(); await run();
    expect(gaps.map((g) => (g["gap"] as Record<string, unknown>)["id"])).toEqual([`${tick.UNREGISTERED_GAP_PREFIX}ribosome-vessel`]);
  });

  it("fail closed: when the live arming read is not > 0 the row is filed unarmed and says why", async () => {
    for (const read of [0, null]) {
      fresh();
      armReads = { "ribosome-vessel": read };
      await fileOne();
      expect("evidence_resolve" in filedMeta()).toBe(false);
      expect(String(filedMeta()["arming_skipped"])).toContain(read === null ? "unmeasured" : "missing_count 0");
    }
  });

  it("verify at the consumer: the gap judge runs the filed check and reads present, then absent once the vessel registers", async () => {
    fresh();
    await fileOne();
    const row = { id: (gaps[0]!["gap"] as Record<string, unknown>)["id"], status: "open", classification_metadata: filedMeta() };
    // The judge POSTs {impulse:{pointer}} to this vessel's own resolve route; answer it with the observer itself,
    // pointed at the stub registry.
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const p = (JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: Record<string, unknown> } }).impulse?.pointer ?? {};
      expect(p["type"]).toBe("discovery_vessel_registry_observer");
      const r = await resolveDiscoveryVesselRegistryObserver({ ...(p as { type: "discovery_vessel_registry_observer" }), endpoint: "http://registry.test", apiKey: "k" });
      return Response.json(r);
    }) as unknown as typeof fetch;
    // The judge abstains on a node that forwards its gap store (GAP_STORE_ENDPOINT set, as the gate's scrubbed
    // environment sets it); this test measures as the store's holder does.
    const saved = process.env["GAP_STORE_ENDPOINT"];
    delete process.env["GAP_STORE_ENDPOINT"];
    try {
      expect(await evaluateGapCheck(row, { fetchImpl })).toBe("present");
      registry = [...(registry ?? []), "ribosome-vessel"];
      expect(await evaluateGapCheck(row, { fetchImpl })).toBe("absent");
      registry = [...(registry ?? []).filter((id) => id !== "ribosome-vessel"), "ribosome-vessel@peer-a"];
      expect(await evaluateGapCheck(row, { fetchImpl })).toBe("present");
    } finally {
      if (saved === undefined) delete process.env["GAP_STORE_ENDPOINT"];
      else process.env["GAP_STORE_ENDPOINT"] = saved;
    }
  });
});
