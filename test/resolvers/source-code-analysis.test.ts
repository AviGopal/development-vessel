import { describe, it, expect } from "bun:test";
import { resolveSourceCodeAnalysis } from "../../src/resolvers/source-code-analysis.js";

describe("resolveSourceCodeAnalysis", () => {
  it("returns shape=sourceCodeAnalysis with a body", async () => {
    // Point at the development-vessel itself — guaranteed to exist in the workspace
    const result = await resolveSourceCodeAnalysis({
      type: "sourceCodeAnalysis",
      target_path: "repos/development-vessel",
    });
    expect(result.shape).toBe("sourceCodeAnalysis");
    expect(result.body).toBeDefined();
    const body = result.body as Record<string, unknown>;
    expect(typeof body["target_path"]).toBe("string");
    expect(typeof body["summary"]).toBe("string");
    expect(typeof body["file_count"]).toBe("number");
    expect(Array.isArray(body["files"])).toBe(true);
    expect(Array.isArray(body["purpose_signals"])).toBe(true);
  });

  it("defaults to repos/clock-vessel when no target_path given", async () => {
    const result = await resolveSourceCodeAnalysis({ type: "sourceCodeAnalysis" });
    expect(result.shape).toBe("sourceCodeAnalysis");
    const body = result.body as Record<string, unknown>;
    // target_path should default
    expect(body["target_path"]).toBe("repos/clock-vessel");
  });

  it("body contains numeric file counts", async () => {
    const result = await resolveSourceCodeAnalysis({
      type: "sourceCodeAnalysis",
      target_path: "repos/development-vessel",
    });
    const body = result.body as Record<string, unknown>;
    expect(typeof body["source_files"]).toBe("number");
    expect(typeof body["test_files"]).toBe("number");
    expect(typeof body["config_files"]).toBe("number");
    expect(typeof body["total_lines"]).toBe("number");
  });
});
