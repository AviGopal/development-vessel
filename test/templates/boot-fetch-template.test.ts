import { describe, it, expect } from "bun:test";
import { BOOT_FETCH_TEMPLATE } from "../../src/templates/boot-fetch-template.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";

describe("boot-fetch-template", () => {
  it("has the correct id and output shape", () => {
    expect(BOOT_FETCH_TEMPLATE.id).toBe("development-vessel:boot-fetch-template");
    expect(BOOT_FETCH_TEMPLATE.outputShapes).toContain("activityTemplate");
  });

  it("has exactly one task using activity_fetch resolver", () => {
    expect(BOOT_FETCH_TEMPLATE.tasks).toHaveLength(1);
    const task = BOOT_FETCH_TEMPLATE.tasks[0]!;
    expect(task.resolver).toBe("activity_fetch");
  });

  it("task config has templateId interpolation placeholder", () => {
    const task = BOOT_FETCH_TEMPLATE.tasks[0]!;
    expect(task.config?.templateId).toBe("{{templateId}}");
  });

  it("activity_fetch resolver is advertised in DISCOVERY_SHAPES", () => {
    expect(DISCOVERY_SHAPES).toContain("activity_fetch");
  });
});
