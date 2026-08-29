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
    const body = result.body as { value: unknown; path: string; valueJson: string; missing?: boolean };
    expect(body.value).toEqual(["semanticValidatorProposal"]);
    expect(body.valueJson).toBe('["semanticValidatorProposal"]');
    expect(body.missing).toBeUndefined();
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

  it("tolerates invalid JSON by returning empty value with missing flag", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: "not-json",
      path: "foo",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("");
    expect(body.missing).toBe(true);
  });

  it("tolerates missing path segment by returning empty value with missing flag", async () => {
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.nonexistent_field",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("");
    expect(body.missing).toBe(true);
  });

  it("traverses INTO an array via a numeric segment (documented dot-notation)", async () => {
    // POLICY REVERSAL, deliberate — this case previously asserted that a numeric segment
    // returned empty + missing, which is what the resolver did while line 65 rejected arrays
    // outright (`typeof current !== "object" || Array.isArray(current)`). That rejection was
    // removed on purpose in 2a21456: the documented syntax `selected.0.id` had never worked,
    // and concept-usage-backfill — THE ONLY AUTONOMOUS WRITER of times_succeeded — had been
    // broken since ship as a result. Re-asserting the old limitation would re-break autonomous
    // concept-relevancy increments, so the case is inverted rather than deleted.
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.activity_signature.output_shapes_must_include.0",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("semanticValidatorProposal");
    // NOTE the asymmetry: `missing` is set to true only by missingResult(); the success path
    // omits the field entirely, so a consumer testing `missing === false` reads undefined.
    // Assert "not flagged missing" rather than pretending the field is present.
    expect(body.missing).not.toBe(true);
  });

  it("still reports missing for an OUT-OF-RANGE array index", async () => {
    // The discriminator: array traversal must succeed for a real index and still fail for a
    // bogus one. Without this, the case above would pass equally well against a resolver that
    // had stopped checking anything at all.
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: scenarioJson,
      path: "expected_emergence.activity_signature.output_shapes_must_include.99",
    });
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("");
    expect(body.missing).toBe(true);
  });

  it("strips markdown json fences before parsing", async () => {
    const fenced = "```json\n" + scenarioJson + "\n```";
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: fenced,
      path: "id",
    });
    expect(result.shape).toBe("json_extracted_value");
    expect((result.body as { value: unknown }).value).toBe("fp-11");
  });

  it("strips plain ``` fences and surrounding narration", async () => {
    const fenced = "Here is the scenario:\n```\n" + scenarioJson + "\n```\nThanks.";
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: fenced,
      path: "expected_emergence.activity_signature.tags_pattern",
    });
    expect(result.shape).toBe("json_extracted_value");
    expect((result.body as { value: unknown }).value).toBe("validation.semantic.*");
  });

  it("tolerates null encountered mid-path", async () => {
    const withNull = JSON.stringify({ scenario: null, reason: "no gap met the bar" });
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: withNull,
      path: "scenario.id",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("");
    expect(body.missing).toBe(true);
  });

  it("tolerates value resolving to null", async () => {
    const withNull = JSON.stringify({ scenario: null });
    const result = await resolveJsonPathExtract({
      type: "json_path_extract",
      json: withNull,
      path: "scenario",
    });
    expect(result.shape).toBe("json_extracted_value");
    const body = result.body as { value: unknown; missing: boolean };
    expect(body.value).toBe("");
    expect(body.missing).toBe(true);
  });
});
