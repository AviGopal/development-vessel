import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolveGapToScenarioBridge } from "../../src/resolvers/gap-to-scenario-bridge.js";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testRoot = join(tmpdir(), `dev-vessel-bridge-${Date.now()}`);
const gapsPath = join(testRoot, "gaps", "gaps.json");
const scenariosDir = join(testRoot, "validation", "failure-modes", "scenarios");
const vesselScenariosDir = join(testRoot, "validation", "failure-modes", "vessel-scenarios");

function seed(gaps: unknown[]): void {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(join(testRoot, "gaps"), { recursive: true });
  mkdirSync(scenariosDir, { recursive: true });
  writeFileSync(gapsPath, JSON.stringify(gaps));
  process.env["WORKSPACE_ROOT"] = testRoot;
}

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("gap_to_scenario_bridge resolver", () => {
  beforeEach(() => {
    seed([]);
  });

  it("writes scenarios for open operator_seed + substrate_detected gaps", async () => {
    seed([
      {
        id: "gap-A",
        category: "detector_drift",
        source: "operator_seed",
        summary: "A summary about detector drift",
        status: "open",
        classification_metadata: {
          cite_principle: "resilient_against_unintended_changes",
          cited_evidence: ["repos/dev-vessel/src/foo.ts"],
        },
      },
      {
        id: "gap:B:with:colons",
        category: "missing_concept",
        source: "substrate_detected",
        summary: "B summary",
        status: "open",
      },
    ]);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    expect(r.shape).toBe("bridgeResult");
    const body = r.body as { scenarios_written: number; scenarios: Array<{ gap_id: string }> };
    expect(body.scenarios_written).toBe(2);
    expect(existsSync(join(scenariosDir, "gap-A.json"))).toBe(true);
    // colon sanitization
    expect(existsSync(join(scenariosDir, "gap-B-with-colons.json"))).toBe(true);
    const scenarioA = JSON.parse(readFileSync(join(scenariosDir, "gap-A.json"), "utf-8"));
    expect(scenarioA.id).toBe("gap-A");
    expect(scenarioA.mode_class).toBe("detector_drift");
    expect(scenarioA.bridge_source).toBe("gap_to_scenario_bridge");
    expect(scenarioA.source_gap_id).toBe("gap-A");
    expect(scenarioA.cite_principle).toBe("resilient_against_unintended_changes");
    expect(scenarioA.target_file_paths).toEqual(["repos/dev-vessel/src/foo.ts"]);
  });

  it("is idempotent — skips gaps with existing scenario files", async () => {
    seed([
      { id: "gap-X", category: "auto", source: "operator_seed", summary: "x", status: "open" },
    ]);
    const first = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    expect((first.body as { scenarios_written: number }).scenarios_written).toBe(1);
    const second = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    const body = second.body as { scenarios_written: number; gaps_skipped_existing: number };
    expect(body.scenarios_written).toBe(0);
    expect(body.gaps_skipped_existing).toBe(1);
  });

  it("dedups by gap CLASS — collapses timestamped duplicates to one scenario", async () => {
    // Same gap class re-emitted with three different timestamps (+ an exec-id
    // variant) must yield exactly ONE scenario, not four.
    seed([
      { id: "arch-pattern-catalogue-bloat-1781426564164", category: "architectural_pattern", source: "substrate_detected", summary: "bloat 1", status: "open" },
      { id: "arch-pattern-catalogue-bloat-1781426999999", category: "architectural_pattern", source: "substrate_detected", summary: "bloat 2", status: "open" },
      { id: "arch-pattern-catalogue-bloat-exec_h14758l3-1781427000000", category: "architectural_pattern", source: "substrate_detected", summary: "bloat 3", status: "open" },
      // a genuinely DISTINCT class must still be written
      { id: "dispatch-target-drift-1781427111111", category: "architectural_pattern", source: "substrate_detected", summary: "distinct", status: "open" },
    ]);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    const body = r.body as { created: number; skipped_class_duplicate: number };
    expect(body.created).toBe(2); // one catalogue-bloat + one dispatch-target-drift
    expect(body.skipped_class_duplicate).toBe(2); // the two extra bloat dupes
    expect(readdirSync(scenariosDir).filter((f) => f.startsWith("arch-pattern-catalogue-bloat")).length).toBe(1);
  });

  it("filters by status and source", async () => {
    seed([
      { id: "open-ok", category: "x", source: "operator_seed", summary: "y", status: "open" },
      { id: "closed", category: "x", source: "operator_seed", summary: "y", status: "closed" },
      { id: "bad-source", category: "x", source: "drafter_emitted", summary: "y", status: "open" },
    ]);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    const body = r.body as { scenarios: Array<{ gap_id: string }> };
    expect(body.scenarios.map((s) => s.gap_id)).toEqual(["open-ok"]);
  });

  it("honors limit", async () => {
    const gaps = Array.from({ length: 5 }, (_, i) => ({
      id: `gap-${i}`,
      category: "auto",
      source: "operator_seed",
      summary: `gap ${i}`,
      status: "open",
    }));
    seed(gaps);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge", limit: 2 });
    expect((r.body as { scenarios_written: number }).scenarios_written).toBe(2);
    expect(readdirSync(scenariosDir).length).toBe(2);
  });

  it("prioritises architecture-class gaps over trace_quality / incidental", async () => {
    // Mix: 4 trace_quality (low) + 1 missing_concept + 1 architectural_pattern
    // + 1 resolver_distribution. With limit=3, only the three priority gaps
    // should land scenarios, in the priority order declared by the resolver.
    seed([
      { id: "tq-1", category: "trace_quality", source: "substrate_detected", summary: "noise 1", status: "open", created_at: "2026-06-01T00:00:00Z" },
      { id: "tq-2", category: "trace_quality", source: "substrate_detected", summary: "noise 2", status: "open", created_at: "2026-06-01T00:00:01Z" },
      { id: "mc-old", category: "missing_concept", source: "substrate_detected", summary: "old missing concept", status: "open", created_at: "2026-06-01T00:00:00Z" },
      { id: "tq-3", category: "trace_quality", source: "substrate_detected", summary: "noise 3", status: "open", created_at: "2026-06-01T00:00:02Z" },
      { id: "arch-1", category: "architectural_pattern", source: "substrate_detected", summary: "arch gap", status: "open", created_at: "2026-06-02T00:00:00Z" },
      { id: "tq-4", category: "trace_quality", source: "substrate_detected", summary: "noise 4", status: "open", created_at: "2026-06-01T00:00:03Z" },
      { id: "rd-1", category: "resolver_distribution", source: "substrate_detected", summary: "rd gap", status: "open", created_at: "2026-06-02T00:00:00Z" },
    ]);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge", limit: 3 });
    const body = r.body as {
      scenarios_written: number;
      scenarios: Array<{ gap_id: string }>;
      priority_breakdown: Record<string, number>;
    };
    expect(body.scenarios_written).toBe(3);
    // Order: architectural_pattern (idx 0) → resolver_distribution (idx 1) → missing_concept (idx 5)
    expect(body.scenarios.map((s) => s.gap_id)).toEqual(["arch-1", "rd-1", "mc-old"]);
    expect(body.priority_breakdown).toEqual({
      architectural_pattern: 1,
      resolver_distribution: 1,
      missing_concept: 1,
    });
    // trace_quality gaps must NOT have been written
    expect(existsSync(join(scenariosDir, "tq-1.json"))).toBe(false);
    expect(existsSync(join(scenariosDir, "tq-4.json"))).toBe(false);
  });

  it("routes missing_capability gaps to the vessel-authoring queue, not the drafter", async () => {
    seed([
      {
        id: "vessel-demand-conceptGraph-2026-06-13",
        category: "missing_capability",
        source: "substrate_detected",
        summary: "Shape 'conceptGraph' required by 4 templates but no vessel advertises it.",
        status: "open",
        classification_metadata: {
          gap_subtype: "vessel_demand",
          shape: "conceptGraph",
          template_count: 4,
          sample_template_ids: ["t-1", "t-2"],
        },
      },
      // a normal recombination gap alongside it
      { id: "drift-1", category: "detector_drift", source: "operator_seed", summary: "drift", status: "open" },
    ]);
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    const body = r.body as {
      created: number;
      scenarios_written: number;
      vessel_authoring_scenarios_written: number;
      vessel_scenarios: Array<{ gap_id: string }>;
    };
    expect(body.created).toBe(2);
    // recombination count excludes the capability gap
    expect(body.scenarios_written).toBe(1);
    expect(body.vessel_authoring_scenarios_written).toBe(1);

    const capId = "vessel-demand-conceptGraph-2026-06-13";
    // capability gap is NOT in the drafter's folder
    expect(existsSync(join(scenariosDir, `${capId}.json`))).toBe(false);
    // it IS in the vessel-authoring queue, tagged with the routing target
    const capPath = join(vesselScenariosDir, `${capId}.json`);
    expect(existsSync(capPath)).toBe(true);
    const cap = JSON.parse(readFileSync(capPath, "utf-8"));
    expect(cap.routing_class).toBe("vessel_authoring");
    expect(cap.target_template_id).toBe("development-vessel:scaffold-and-publish-vessel");
    expect(cap.capability_shape).toBe("conceptGraph");
    expect(cap.demanding_template_count).toBe(4);
    expect(cap.sample_template_ids).toEqual(["t-1", "t-2"]);

    // recombination gap still carries its routing target
    const drift = JSON.parse(readFileSync(join(scenariosDir, "drift-1.json"), "utf-8"));
    expect(drift.routing_class).toBe("recombination");
    expect(drift.target_template_id).toBe("development-vessel:draft-gap-closing-activity");
  });

  it("is idempotent for vessel-authoring gaps too", async () => {
    const gap = {
      id: "vessel-demand-foo",
      category: "missing_capability",
      source: "substrate_detected",
      summary: "Shape 'foo' demanded, no supply.",
      status: "open",
      classification_metadata: { gap_subtype: "vessel_demand", shape: "foo", template_count: 3 },
    };
    seed([gap]);
    const first = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    expect((first.body as { vessel_authoring_scenarios_written: number }).vessel_authoring_scenarios_written).toBe(1);
    const second = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    const body = second.body as { vessel_authoring_scenarios_written: number; gaps_skipped_existing: number };
    expect(body.vessel_authoring_scenarios_written).toBe(0);
    expect(body.gaps_skipped_existing).toBe(1);
  });

  it("returns empty result when gaps file is missing", async () => {
    rmSync(testRoot, { recursive: true, force: true });
    process.env["WORKSPACE_ROOT"] = testRoot;
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    expect(r.shape).toBe("bridgeResult");
    expect((r.body as { scenarios_written: number }).scenarios_written).toBe(0);
  });
});
