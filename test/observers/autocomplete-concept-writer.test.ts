import { describe, it, expect } from "bun:test";
import {
  shouldWriteback,
  buildConceptWritePointer,
} from "../../src/observers/autocomplete-concept-writer.js";

// shouldWriteback and buildConceptWritePointer are pure — test directly.
// WebSocket plumbing is verified in-container under live boredom traffic.

describe("autocomplete-concept-writer: shouldWriteback predicate", () => {
  it("returns true for a substrate-authored gap-closing:auto-* template", () => {
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "gap-closing:auto-fm-50-obsidian-writeback-1780352106759",
      }),
    ).toBe(true);
  });

  it("returns true for apply-proposal-as-patch templates", () => {
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:apply-proposal-as-patch",
      }),
    ).toBe(true);
  });

  it("returns true for vessel-mitosis-cutover templates", () => {
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:vessel-mitosis-cutover",
      }),
    ).toBe(true);
  });

  it("strips activity:⟨…⟩ wrapping before matching", () => {
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "activity:⟨gap-closing:auto-fm-50-test-12345⟩",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated templates (e.g. coverage-tick, draft-gap-closing)", () => {
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:coverage-tick",
      }),
    ).toBe(false);
    expect(
      shouldWriteback({
        type: "lifecycle:execution:succeeded",
        activity_template_id: "development-vessel:draft-gap-closing-activity",
      }),
    ).toBe(false);
  });

  it("returns false when event.type is not lifecycle:execution:succeeded", () => {
    expect(
      shouldWriteback({
        type: "task.completed",
        activity_template_id: "gap-closing:auto-foo",
      }),
    ).toBe(false);
  });

  it("returns false when activity_template_id is missing", () => {
    expect(shouldWriteback({ type: "lifecycle:execution:succeeded" })).toBe(false);
  });
});

describe("autocomplete-concept-writer: buildConceptWritePointer", () => {
  it("emits a concept_write pointer with source_type=impulse_activity_pattern", () => {
    const ptr = buildConceptWritePointer({
      type: "lifecycle:execution:succeeded",
      activity_template_id: "gap-closing:auto-fm-50-obsidian-writeback-1780352106759",
      execution_id: "exec_abc123",
      output_shapes: ["activityRegistryChange", "fileContent"],
    });
    expect(ptr.type).toBe("concept_write");
    expect(ptr.source_type).toBe("impulse_activity_pattern");
    expect(ptr.name).toContain("gap-closing:auto-fm-50-obsidian-writeback-1780352106759");
    expect(ptr.content).toContain("exec_abc123");
    expect(ptr.content).toContain("activityRegistryChange");
  });

  it("handles missing execution_id and output_shapes gracefully", () => {
    const ptr = buildConceptWritePointer({
      type: "lifecycle:execution:succeeded",
      activity_template_id: "development-vessel:apply-proposal-as-patch",
    });
    expect(ptr.content).toContain("unknown");
    expect(ptr.content).toContain("(none reported)");
  });
});
