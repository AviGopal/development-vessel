import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveVesselArrivalScan } from "../../src/resolvers/vessel-arrival-scan.js";

const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vas-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Fake discovery + discover-by-shapes + (for the consumer_productivity_audit
 * the arrival scan now delegates to) template + trace fetches. `consumers`
 * lists shapes that have a PRODUCTIVE consumer: each such shape resolves to a
 * `prod-of-<shape>` template that declares the shape, references it, emits
 * concept_create_write, and has a success trace.
 */
function mockFetch(
  vessels: Array<{ vesselId: string; vesselName?: string; shapes?: string[] }>,
  opts: { consumers?: Set<string>; producers?: Set<string> } = {},
) {
  const consumers = opts.consumers ?? new Set<string>();
  const producers = opts.producers ?? new Set<string>();
  const prodId = (shape: string) => `prod-of-${shape}`;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/resolve")) {
      return new Response(JSON.stringify({ content: { vessels } }), { status: 200 });
    }
    if (u.includes("/discover-by-shapes")) {
      const shape = body.required_shapes?.[0];
      if (body.mode === "backward") {
        // audit's candidate discovery: a productive consumer iff shape ∈ consumers
        const ids = consumers.has(shape) ? [{ id: prodId(shape) }] : [];
        return new Response(JSON.stringify({ activities: ids }), { status: 200 });
      }
      // forward (producer) check stays a plain match
      return new Response(
        JSON.stringify({ matched: producers.has(shape), emergence_class: producers.has(shape) ? "reuse" : "gap" }),
        { status: 200 },
      );
    }
    if (u.includes("/v2/activities/templates/")) {
      const id = decodeURIComponent(u.split("/v2/activities/templates/")[1]!.split("?")[0]!);
      const shape = id.startsWith("prod-of-") ? id.slice("prod-of-".length) : "";
      return new Response(
        JSON.stringify({
          id,
          input_shapes: [shape],
          output_shapes: ["concept_create_write"],
          tasks: [{ id: "consume", resolver: "http_fetch", input_shapes: [shape], config: { body: shape }, output_shapes: ["concept_create_write"] }],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/execution-traces")) {
      // No server-side id filter; return success traces tagged with activity_id
      // for every productive consumer so the audit's client-side match works.
      const executions = [...consumers].map((shape) => ({
        status: "success",
        success: true,
        activity_id: prodId(shape),
        output_impulse_shapes: ["concept_create_write"],
      }));
      return new Response(JSON.stringify({ executions }), { status: 200 });
    }
    if (u.includes("/impulse-relevance")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("vessel_arrival_scan", () => {
  it("first run is a baseline: records the world, emits zero arrivals", async () => {
    mockFetch([{ vesselId: "a" }, { vesselId: "b" }]);
    const snapshotPath = path.join(tmp, "snap.json");
    const r = await resolveVesselArrivalScan({
      type: "vessel_arrival_scan",
      apiKey: "k",
      snapshotPath,
      scenariosDir: path.join(tmp, "scen"),
      creditOnCharacterize: false,
    });
    const body = r.body as { baseline: boolean; new_vessel_count: number; recorded_vessels: number };
    expect(body.baseline).toBe(true);
    expect(body.new_vessel_count).toBe(0);
    expect(body.recorded_vessels).toBe(2);
    // snapshot persisted
    const snap = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as { known: string[] };
    expect(snap.known.sort()).toEqual(["a", "b"]);
  });

  it("detects a new vessel on the second run and classifies shape coverage", async () => {
    const snapshotPath = path.join(tmp, "snap.json");
    const scenariosDir = path.join(tmp, "scen");
    // baseline: only vessel a
    mockFetch([{ vesselId: "a" }]);
    await resolveVesselArrivalScan({
      type: "vessel_arrival_scan",
      apiKey: "k",
      snapshotPath,
      scenariosDir,
      creditOnCharacterize: false,
    });
    // second run: vessel b arrives with one consumed + one orphaned shape
    mockFetch(
      [{ vesselId: "a" }, { vesselId: "b", vesselName: "B", shapes: ["x:covered", "x:orphan"] }],
      { consumers: new Set(["x:covered"]), producers: new Set(["x:covered"]) },
    );
    const r = await resolveVesselArrivalScan({
      type: "vessel_arrival_scan",
      apiKey: "k",
      snapshotPath,
      scenariosDir,
      creditOnCharacterize: false,
    });
    const body = r.body as {
      baseline: boolean;
      new_vessel_count: number;
      new_vessels: Array<{
        vessel_id: string;
        verdict: string;
        routing: string;
        uncovered_shapes: string[];
        scenario_id: string | null;
      }>;
      scenarios_written: number;
    };
    expect(body.baseline).toBe(false);
    expect(body.new_vessel_count).toBe(1);
    const v = body.new_vessels[0]!;
    expect(v.vessel_id).toBe("b");
    expect(v.verdict).toBe("needs_integration");
    expect(v.routing).toBe("draft_template");
    expect(v.uncovered_shapes).toEqual(["x:orphan"]);
    expect(body.scenarios_written).toBe(1);
    // deterministic gap scenario written to the drafter's polling dir
    const scen = JSON.parse(
      await fs.readFile(path.join(scenariosDir, "vessel-arrival-b.json"), "utf8"),
    ) as { mode_class: string; outcome_class: string; expected_input_shapes: string[]; bridge_source: string };
    expect(scen.mode_class).toBe("vessel_arrival");
    expect(scen.outcome_class).toBe("gap");
    expect(scen.expected_input_shapes).toContain("x:orphan");
    expect(scen.bridge_source).toBe("vessel_arrival_scan");
  });

  it("a fully-covered new vessel is integrated: no scenario, no routing", async () => {
    const snapshotPath = path.join(tmp, "snap.json");
    const scenariosDir = path.join(tmp, "scen");
    mockFetch([{ vesselId: "a" }]);
    await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    mockFetch(
      [{ vesselId: "a" }, { vesselId: "c", shapes: ["y:ok"] }],
      { consumers: new Set(["y:ok"]), producers: new Set(["y:ok"]) },
    );
    const r = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    const body = r.body as { new_vessels: Array<{ verdict: string; routing: string }>; scenarios_written: number };
    expect(body.new_vessels[0]!.verdict).toBe("integrated");
    expect(body.new_vessels[0]!.routing).toBe("none");
    expect(body.scenarios_written).toBe(0);
  });

  it("re-drives a pending arrival until integrated: integration-gap is the trigger, not arrival novelty", async () => {
    const snapshotPath = path.join(tmp, "snap.json");
    const scenariosDir = path.join(tmp, "scen");
    // baseline: only infra vessel `a` exists (b has NOT arrived yet)
    mockFetch([{ vesselId: "a" }]);
    await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    // run 2: b arrives uncovered → fresh arrival, enters pending, scenario written
    mockFetch([{ vesselId: "a" }, { vesselId: "b", shapes: ["x:orphan"] }], { producers: new Set(["x:orphan"]) });
    const r2 = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    const b2 = r2.body as { new_vessel_count: number; pending_count: number; scenarios_written: number };
    expect(b2.new_vessel_count).toBe(1);
    expect(b2.pending_count).toBe(1);
    expect(b2.scenarios_written).toBe(1);
    expect(await fs.exists(path.join(scenariosDir, "vessel-arrival-b.json"))).toBe(true);
    // run 3: b is now KNOWN (not a fresh arrival) but still uncovered → re-driven via pending
    mockFetch([{ vesselId: "a" }, { vesselId: "b", shapes: ["x:orphan"] }], { producers: new Set(["x:orphan"]) });
    const r3 = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    const b3 = r3.body as {
      new_vessel_count: number;
      reintegration_target_count: number;
      reintegration_targets: Array<{ vessel_id: string; uncovered_shapes: string[] }>;
      scenarios_written: number;
    };
    expect(b3.new_vessel_count).toBe(0); // no longer a fresh arrival
    expect(b3.reintegration_target_count).toBe(1); // but the gap re-enters the queue
    expect(b3.reintegration_targets[0]!.vessel_id).toBe("b");
    expect(b3.reintegration_targets[0]!.uncovered_shapes).toEqual(["x:orphan"]);
    expect(b3.scenarios_written).toBe(1);
  });

  it("does NOT re-drive the baseline infra fleet (no flood)", async () => {
    const snapshotPath = path.join(tmp, "snap.json");
    const scenariosDir = path.join(tmp, "scen");
    // baseline fleet has uncovered terminal-effect shapes (no consumer BY DESIGN)
    mockFetch([
      { vesselId: "activity-api", shapes: ["x:write"] },
      { vesselId: "dev-vessel", shapes: ["y:write"] },
    ]);
    await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    // second run: same fleet, still no consumers — must NOT be classified or queued
    mockFetch([
      { vesselId: "activity-api", shapes: ["x:write"] },
      { vesselId: "dev-vessel", shapes: ["y:write"] },
    ]);
    const r = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    const body = r.body as { classified_vessels: number; reintegration_target_count: number; pending_count: number; scenarios_written: number };
    expect(body.classified_vessels).toBe(0);
    expect(body.reintegration_target_count).toBe(0);
    expect(body.pending_count).toBe(0);
    expect(body.scenarios_written).toBe(0);
  });

  it("clears a stale scenario and drops from pending once the vessel becomes integrated", async () => {
    const snapshotPath = path.join(tmp, "snap.json");
    const scenariosDir = path.join(tmp, "scen");
    mockFetch([{ vesselId: "a" }]);
    await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    // b arrives uncovered → scenario written, pending
    mockFetch([{ vesselId: "a" }, { vesselId: "b", shapes: ["x:orphan"] }], { producers: new Set(["x:orphan"]) });
    await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    expect(await fs.exists(path.join(scenariosDir, "vessel-arrival-b.json"))).toBe(true);
    // a consumer now exists → b integrates, scenario cleared, leaves pending
    mockFetch([{ vesselId: "a" }, { vesselId: "b", shapes: ["x:orphan"] }], { producers: new Set(["x:orphan"]), consumers: new Set(["x:orphan"]) });
    const r = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "k", snapshotPath, scenariosDir, creditOnCharacterize: false });
    const body = r.body as { reintegration_target_count: number; scenarios_written: number; scenarios_cleared: number; pending_count: number };
    expect(body.reintegration_target_count).toBe(0);
    expect(body.scenarios_written).toBe(0);
    expect(body.scenarios_cleared).toBe(1);
    expect(body.pending_count).toBe(0);
    expect(await fs.exists(path.join(scenariosDir, "vessel-arrival-b.json"))).toBe(false);
  });

  it("missing api key degrades cleanly", async () => {
    const r = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "", snapshotPath: path.join(tmp, "s.json") });
    expect((r.body as { error: string }).error).toBe("missing_api_key");
  });
});
