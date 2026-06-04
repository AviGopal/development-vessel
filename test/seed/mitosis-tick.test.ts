import { describe, it, expect } from "bun:test";
import { MITOSIS_TICK_TEMPLATE } from "../../src/seed/mitosis-tick.js";

describe("MITOSIS_TICK_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(MITOSIS_TICK_TEMPLATE.id).toBe("development-vessel:mitosis-tick");
    expect(typeof MITOSIS_TICK_TEMPLATE.name).toBe("string");
    expect(MITOSIS_TICK_TEMPLATE.outputShapes).toContain("vesselMitosisCutoverResult");
    expect(MITOSIS_TICK_TEMPLATE.outputShapes).toContain("cutoverApplied");
  });

  it("includes an extract_staged_files task feeding the cutover", () => {
    const tasks = MITOSIS_TICK_TEMPLATE.tasks;
    const extract = tasks.find((t) => t.id === "extract_staged_files");
    expect(extract).toBeDefined();
    expect(extract?.resolver).toBe("json_path_extract");
    const cfg = extract?.config as { path: string; type: string };
    expect(cfg.path).toBe("staged_files");
  });

  it("conditional_cutover task threads staged_files into vessel_mitosis_cutover pointer", () => {
    // This is the load-bearing assertion for the autonomous-commit chain:
    // without staged_files the cutover falls through to the legacy
    // systemd-mount path which never writes host-sync intents.
    const cutover = MITOSIS_TICK_TEMPLATE.tasks.find(
      (t) => t.id === "conditional_cutover",
    );
    expect(cutover).toBeDefined();
    expect(cutover?.resolver).toBe("vessel_mitosis_cutover");
    const cfg = cutover?.config as Record<string, unknown>;
    // The interpolation uses the _content suffix established in 1fcf142 for
    // cross-dispatcher safety (goal-host + light-dispatch both honour it).
    expect(cfg["staged_files"]).toBe("{{extract_staged_files_content}}");
    expect(cfg["staged_base_sha"]).toBe("{{extract_base_sha_content}}");
    expect(cfg["mitosis_root"]).toBe("{{extract_mitosis_root_content}}");
    expect(cfg["evaluation_evidence"]).toBe("{{evaluate_pair_content}}");
  });

  it("dispatches a tagged autonomous-loop template (boredom target)", () => {
    expect(MITOSIS_TICK_TEMPLATE.tags).toContain("lift.autonomous.loop");
    expect(MITOSIS_TICK_TEMPLATE.tags).toContain("boredom_target_template");
  });
});
