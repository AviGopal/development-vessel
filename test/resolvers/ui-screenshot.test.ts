import { describe, it, expect } from "bun:test";
import { resolveUiScreenshot } from "../../src/resolvers/ui-screenshot.js";

describe("ui_screenshot resolver", () => {
  it("returns a well-formed result for the obsidian:ui_screenshot shape", async () => {
    const r = await resolveUiScreenshot({ type: "ui_screenshot" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
