import { describe, it, expect } from "bun:test";
import { resolveJsonPathExtract } from "../../src/resolvers/json-path-extract.js";

const scenario = {
  id: "fp-11",
  expected_emergence: {
    activity_signature: {
      output_shapes_must_include: ["semanticValidatorProposal"],
      tags_pattern: "validation.semantic.*",
    },
  },
};
const scenarioJson = JSON.stringify(scenario);

describe("json-path-extract resolver", () => {
  it("extracts a nested array via dot path", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.activity_signature.output_shapes_must_include",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; path: string; valueJson: string };
    expect(body.value).toEqual(["semanticValidatorProposal"]);
    expect(body.valueJson).toBe('["semanticValidatorProposal"]');
  });

  it("extracts a string value", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "id",
    });
    expect(result.shape).toBe("json_extracted_value");
    expect((result.body as { value: unknown }).value).toBe("fp-11");
  });

  it("returns structuredError for invalid JSON", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: "not-json",
      path: "foo",
    });
    expect(result.shape).toBe("structuredError");
  });

  it("returns structuredError for missing path segment", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.nonexistent_field",
    });
    expect(result.shape).toBe("structuredError");
  });

  it("returns structuredError when traversing through an array", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.activity_signature.output_shapes_must_include.0",
    });
    expect(result.shape).toBe("structuredError");
  });
});
