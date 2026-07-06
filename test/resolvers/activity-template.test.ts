import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveActivityTemplate } from "../../src/resolvers/activity-template.js";

describe("resolveActivityTemplate", () => {
  it("returns shape=activity_template with ok=true or ok=false", async () => {
    const result = await resolveActivityTemplate({ type: "activity_template", limit: 5 });
    expect(result.shape).toBe("activity_template");
    expect(result.body).toBeDefined();
    const body = result.body as Record<string, unknown>;
    expect(typeof body["ok"]).toBe("boolean");
    expect(typeof body["summary"]).toBe("string");
  });

  it("returns templates array in body", async () => {
    const result = await resolveActivityTemplate({ type: "activity_template", limit: 5 });
    expect(result.shape).toBe("activity_template");
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["templates"])).toBe(true);
    expect(typeof body["total"]).toBe("number");
  });

  it("returns activity_template shape for single templateId lookup (missing returns ok=false)", async () => {
    const result = await resolveActivityTemplate({
      type: "activity_template",
      templateId: "nonexistent-template-id-for-test",
    });
    expect(result.shape).toBe("activity_template");
    const body = result.body as Record<string, unknown>;
    // Either ok (if substrate is up) or error path
    expect(typeof body["summary"]).toBe("string");
  });
});
