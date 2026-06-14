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

/** Fake discovery + discover-by-shapes. `consumers` lists shapes that HAVE a consumer. */
function mockFetch(
  vessels: Array<{ vesselId: string; vesselName?: string; shapes?: string[] }>,
  opts: { consumers?: Set<string>; producers?: Set<string> } = {},
) {
  const consumers = opts.consumers ?? new Set<string>();
  const producers = opts.producers ?? new Set<string>();
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/resolve")) {
      return new Response(JSON.stringify({ content: { vessels } }), { status: 200 });
    }
    if (u.includes("/discover-by-shapes")) {
      const shape = body.required_shapes?.[0];
      const set = body.mode === "backward" ? consumers : producers;
      return new Response(
        JSON.stringify({ matched: set.has(shape), emergence_class: set.has(shape) ? "reuse" : "gap" }),
        { status: 200 },
      );
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

  it("missing api key degrades cleanly", async () => {
    const r = await resolveVesselArrivalScan({ type: "vessel_arrival_scan", apiKey: "", snapshotPath: path.join(tmp, "s.json") });
    expect((r.body as { error: string }).error).toBe("missing_api_key");
  });
});
