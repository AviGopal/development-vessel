import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolveGapToScenarioBridge } from "../../src/resolvers/gap-to-scenario-bridge.js";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testRoot = join(tmpdir(), `dev-vessel-bridge-${Date.now()}`);
const gapsPath = join(testRoot, "gaps", "gaps.json");
const scenariosDir = join(testRoot, "validation", "failure-modes", "scenarios");

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

  it("returns empty result when gaps file is missing", async () => {
    rmSync(testRoot, { recursive: true, force: true });
    process.env["WORKSPACE_ROOT"] = testRoot;
    const r = await resolveGapToScenarioBridge({ type: "gap_to_scenario_bridge" });
    expect(r.shape).toBe("bridgeResult");
    expect((r.body as { scenarios_written: number }).scenarios_written).toBe(0);
  });
});
