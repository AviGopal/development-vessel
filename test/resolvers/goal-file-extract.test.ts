import { describe, it, expect } from "bun:test";
import {
  resolveGoalFileExtract,
  extractFilePaths,
  normalizeToContainerPath,
} from "../../src/resolvers/goal-file-extract.js";

describe("goal_file_extract resolver", () => {
  it("lifts a dir-separated path out of goal prose and normalizes it for the producer", async () => {
    const r = await resolveGoalFileExtract({
      type: "goal_file_extract",
      goal: "Examine repos/discovery-vessel/src/index.ts and report the top risks.",
    });
    expect(r.shape).toBe("filePaths");
    // body is a BARE STRING so {{impulse:slot}} interpolation stays clean, and is
    // normalized to a container-openable path (repos/ → /vessels/) so the
    // downstream file-reading resolver does not ENOENT (→ HOLLOW reach).
    expect(r.body).toBe("/vessels/discovery-vessel/src/index.ts");
  });

  it("normalizeToContainerPath maps the super-repo idiom to the container root", () => {
    expect(normalizeToContainerPath("repos/discovery-vessel/src/index.ts")).toBe(
      "/vessels/discovery-vessel/src/index.ts",
    );
    // already-absolute is preserved
    expect(normalizeToContainerPath("/vessels/x/src/a.ts")).toBe("/vessels/x/src/a.ts");
    // bare relative is anchored under the vessels root
    expect(normalizeToContainerPath("analysis-vessel/src/a.ts")).toBe(
      "/vessels/analysis-vessel/src/a.ts",
    );
    // empty stays empty
    expect(normalizeToContainerPath("")).toBe("");
  });

  it("prefers the most-specific (deepest) path when several appear", () => {
    const paths = extractFilePaths({
      type: "goal_file_extract",
      goal: "compare index.ts with src/a/b/deep.ts and also util.js",
    });
    expect(paths[0]).toBe("src/a/b/deep.ts");
    expect(paths).toContain("index.ts");
    expect(paths).toContain("util.js");
  });

  it("ignores version-number-like tokens and sentence punctuation", () => {
    const paths = extractFilePaths({
      type: "goal_file_extract",
      goal: "activity-api 1.20.9 needs a fix, etc. See main.go please.",
    });
    expect(paths).toEqual(["main.go"]);
  });

  it("scans non-goal string fields too (goal surviving under another key)", () => {
    const paths = extractFilePaths({
      type: "goal_file_extract",
      // no goal/text key — path arrives under an unexpected field
      description: "please analyze pkg/server/handler.rs",
    } as never);
    expect(paths).toEqual(["pkg/server/handler.rs"]);
  });

  it("does not match unresolved placeholders", () => {
    const paths = extractFilePaths({
      type: "goal_file_extract",
      goal: "analyze {{source_code}} carefully",
    });
    expect(paths).toEqual([]);
  });

  it("returns empty string body when no path is present", async () => {
    const r = await resolveGoalFileExtract({
      type: "goal_file_extract",
      goal: "improve the overall code quality of the substrate",
    });
    expect(r.body).toBe("");
  });
});
