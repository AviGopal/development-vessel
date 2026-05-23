import { describe, it, expect } from "bun:test";
import { shouldRescore } from "../../src/observers/registry-change-observer.js";

// shouldRescore is a pure function — test it directly without WebSocket fakes.
// The WebSocket integration is verified in-container (§6.3).

describe("registry-change-observer: shouldRescore predicate", () => {
  it("returns true for draft-gap-closing-activity template id", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:draft-gap-closing-activity",
      }),
    ).toBe(true);
  });

  it("returns true for prune-activity template id", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:prune-activity",
      }),
    ).toBe(true);
  });

  it("returns true for replace-activity template id", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "some-vessel:replace-activity",
      }),
    ).toBe(true);
  });

  it("returns true when output_shapes includes activityRegistryChange", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:activity_create_variant",
        output_shapes: ["activityRegistryChange", "activityTemplateVariant"],
      }),
    ).toBe(true);
  });

  it("returns false for an unrelated template id with no activityRegistryChange", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:git_status",
      }),
    ).toBe(false);
  });

  it("returns false for task.completed event type (wrong type)", () => {
    expect(
      shouldRescore({
        type: "task.completed",
        activity_template_id: "development-vessel:draft-gap-closing-activity",
      }),
    ).toBe(false);
  });

  it("returns false when output_shapes is missing activityRegistryChange", () => {
    expect(
      shouldRescore({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:coverage-tick",
        output_shapes: ["coverageReport"],
      }),
    ).toBe(false);
  });
});
