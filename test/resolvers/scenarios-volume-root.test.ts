// The failure-mode scenario queue lives on the /workspace volume, not under WORKSPACE_ROOT (the env
// file points that at the super-repo clone). Every writer and reader resolves the one constant.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A WORKSPACE_ROOT that is NOT the volume, set before config loads, so a site that still derives the
// queue from it resolves somewhere else and fails here.
const SUPER_CLONE = join(tmpdir(), `scenarios-volume-root-${process.pid}`);
process.env["WORKSPACE_ROOT"] = SUPER_CLONE;

const VOLUME = "/workspace/validation/failure-modes/scenarios";
const VESSEL_VOLUME = "/workspace/validation/failure-modes/vessel-scenarios";
const SRC = join(import.meta.dir, "../../src");
const source = (rel: string): string => readFileSync(join(SRC, rel), "utf-8");

const config = await import("../../src/config.js");
const { DEFAULT_SCENARIOS_DIR } = await import("../../src/observers/registry-change-observer.js");
const { resolveScenariosDir } = await import("../../src/resolvers/failure-mode-matrix-score.js");
const { bridgeScenarioDirs } = await import("../../src/resolvers/gap-to-scenario-bridge.js");
const { HARNESS_RUN_MATRIX_TEMPLATE } = await import("../../src/seed/harness-run-matrix.js");
const { HARNESS_CHECK_SCENARIO_TEMPLATE } = await import("../../src/seed/harness-check-scenario.js");

describe("scenario queue resolves to the volume root", () => {
  it("config carries one constant per queue, on the volume", () => {
    expect(config.WORKSPACE_ROOT).toBe(SUPER_CLONE);
    expect(config.FAILURE_MODE_SCENARIOS_DIR).toBe(VOLUME);
    expect(config.FAILURE_MODE_VESSEL_SCENARIOS_DIR).toBe(VESSEL_VOLUME);
  });

  it("registry-change-observer rescores the volume queue", () => {
    expect(DEFAULT_SCENARIOS_DIR).toBe(VOLUME);
  });

  it("failure_mode_matrix_score defaults to the volume queue", () => {
    expect(resolveScenariosDir(undefined)).toBe(VOLUME);
    expect(resolveScenariosDir("")).toBe(VOLUME);
    expect(resolveScenariosDir("{{scenarios_dir}}")).toBe(VOLUME);
  });

  it("failure_mode_matrix_score keeps explicit inputs (control)", () => {
    expect(resolveScenariosDir("/abs/dir")).toBe("/abs/dir");
    expect(resolveScenariosDir("rel/dir")).toBe(join(SUPER_CLONE, "rel/dir"));
  });

  it("gap_to_scenario_bridge (the writer) defaults to the volume queues", () => {
    expect(bridgeScenarioDirs({})).toEqual({ scenariosDir: VOLUME, vesselScenariosDir: VESSEL_VOLUME });
    expect(bridgeScenarioDirs({ scenarios_dir: "/a", vessel_scenarios_dir: "/b" })).toEqual({ scenariosDir: "/a", vesselScenariosDir: "/b" });
  });

  it("gap-lifecycle-scan reprobes from the shared constant, not a path beside the vessel source", () => {
    const s = source("resolvers/gap-lifecycle-scan.ts");
    expect(s).toContain("const scenariosDir = FAILURE_MODE_SCENARIOS_DIR;");
    expect(s).not.toMatch(/import\.meta\.dir,\s*"\.\.\/\.\.\/validation\/failure-modes\/scenarios"/);
  });

  it("the harness seeds name the volume queue", () => {
    const dirVar = HARNESS_RUN_MATRIX_TEMPLATE.variables!.find((v) => v.name === "scenarios_dir")!;
    expect(dirVar.description).toContain(`Default: ${VOLUME}`);
    const pathVar = HARNESS_CHECK_SCENARIO_TEMPLATE.variables!.find((v) => v.name === "scenario_path")!;
    expect(pathVar.description).toContain(`${VOLUME}/`);
  });

  it("no site joins the scenario queue onto a root", () => {
    for (const rel of [
      "observers/registry-change-observer.ts",
      "resolvers/failure-mode-matrix-score.ts",
      "resolvers/gap-to-scenario-bridge.ts",
    ]) {
      expect(source(rel)).not.toMatch(/join\([^)]*failure-modes[^)]*\)/);
    }
  });

  it("control: the sites already on the volume root are unchanged and agree with the constant", () => {
    expect(source("resolvers/pick-priority-scenario.ts")).toContain(`"${VOLUME}"`);
    expect(source("resolvers/vessel-arrival-scan.ts")).toContain(`"${VOLUME}"`);
    expect(source("seed/drafter-trigger-tick.ts")).toContain(`"${VOLUME}"`);
    expect(source("seed/vessel-scaffold-trigger-tick.ts")).toContain(`"${VESSEL_VOLUME}"`);
  });
});
