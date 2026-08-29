import { describe, it, expect, afterAll } from "bun:test";
import { resolvePickPriorityScenario } from "../../src/resolvers/pick-priority-scenario.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// sanitizeId mirror (gap-to-scenario-bridge): `:` -> `-`, other non
// [a-zA-Z0-9._-] -> `_`. Scenario files are named `${sanitizeId(id)}.json`.
const sanitize = (id: string): string => id.replace(/:/g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");

const testRoot = join(tmpdir(), `dev-vessel-pick-${Date.now()}`);
const scenariosDir = join(testRoot, "scenarios");
const gapsPath = join(testRoot, "gaps.json");

interface Gap {
  id: string;
  category: string;
  source?: string;
  status?: string;
  classification_metadata?: Record<string, unknown>;
}

function seed(gaps: Gap[]): void {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(scenariosDir, { recursive: true });
  // Every seeded gap needs `target_file_paths` to clear the picker's actionability
  // filter. `predictActionability` starts at 0.5 and subtracts 0.2 when the field is
  // absent (adds 0.3 when present); ACTIONABILITY_THRESHOLD is 0.35, so a gap without
  // it scores 0.3, is skipped at the `continue`, and — with every fixture skipped —
  // `candidates` empties and the resolver falls back to `no_gap_metadata_fallback_alpha`,
  // ranking alphabetically. These cases are about RANKING (category over severity,
  // severity ties, exclusion rules), not about the actionability filter, so the fixtures
  // must be actionable for the ranking assertions to reach the code under test.
  // Spread `...g` last so a case that sets its own target_file_paths still wins.
  writeFileSync(gapsPath, JSON.stringify(gaps.map((g) => ({ target_file_paths: ["src/probe.ts"], ...g }))));
  // Materialize a scenario file per gap (the picker only considers gaps whose
  // scenario file exists on disk).
  for (const g of gaps) writeFileSync(join(scenariosDir, `${sanitize(g.id)}.json`), "{}");
}

function call() {
  return resolvePickPriorityScenario({
    type: "pick_priority_scenario",
    scenarios_dir: scenariosDir,
    gaps_path: gapsPath,
    exclude_drafted: false, // skip the activity-api fetch — pure disk ranking, no network
    dispatch_drafter: false,
  });
}

afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

describe("pick_priority_scenario resolver", () => {
  it("ranks category priority ABOVE severity (architectural beats high-harm missing_capability)", async () => {
    seed([
      // huge severity but lower-priority category
      { id: "missing_capability:foo", category: "missing_capability", source: "substrate_detected", status: "open",
        classification_metadata: { samples: 50, success_rate: 0 } },
      // modest severity but top-priority category -> must win
      { id: "architectural_pattern:bar", category: "architectural_pattern", source: "substrate_detected", status: "open",
        classification_metadata: { samples: 5, success_rate: 0.9 } },
    ]);
    const r = await call() as { body: { scenario_id: string; reason: string } };
    expect(r.body.reason).toBe("value_ranked");
    expect(r.body.scenario_id).toBe("architectural_pattern-bar");
  });

  it("breaks ties within a category by severity (harm magnitude)", async () => {
    seed([
      { id: "missing_capability:mild", category: "missing_capability", source: "substrate_detected", status: "open",
        classification_metadata: { samples: 10, success_rate: 0.5 } },
      { id: "missing_capability:severe", category: "missing_capability", source: "substrate_detected", status: "open",
        classification_metadata: { samples: 10, success_rate: 0 } },
    ]);
    const r = await call() as { body: { scenario_id: string } };
    expect(r.body.scenario_id).toBe("missing_capability-severe");
  });

  it("excludes non-open and untrusted-source gaps", async () => {
    seed([
      { id: "architectural_pattern:closed", category: "architectural_pattern", source: "substrate_detected", status: "closed",
        classification_metadata: { samples: 5, success_rate: 0 } },
      { id: "missing_capability:ok", category: "missing_capability", source: "operator_seed", status: "open",
        classification_metadata: { samples: 5, success_rate: 0 } },
    ]);
    const r = await call() as { body: { scenario_id: string } };
    expect(r.body.scenario_id).toBe("missing_capability-ok");
  });
});
