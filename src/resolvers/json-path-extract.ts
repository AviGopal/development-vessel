import type { ResolverResult } from "./types.js";

export interface JsonPathExtractPointer {
  type: "json_path_extract";
  json: string | unknown; // string (JSON text) or pre-parsed object (from interpolateVars exact-match substitution)
  path: string; // dot-notation path, e.g. "expected_emergence.activity_signature.output_shapes_must_include"
}

export async function resolveJsonPathExtract(pointer: JsonPathExtractPointer): Promise<ResolverResult> {
  // interpolateVars JSON-parses exact {{var}} substitutions, so pointer.json may arrive
  // as a pre-parsed object rather than a JSON string. Accept both forms.
  let obj: unknown;
  if (typeof pointer.json === "string") {
    try {
      obj = JSON.parse(pointer.json);
    } catch {
      return {
        shape: "structuredError",
        body: { resolver: "json_path_extract", detail: "input is not valid JSON" },
      };
    }
  } else {
    obj = pointer.json;
  }

  const parts = pointer.path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return {
        shape: "structuredError",
        body: { resolver: "json_path_extract", detail: `path not found at segment: ${part}` },
      };
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) {
      return {
        shape: "structuredError",
        body: { resolver: "json_path_extract", detail: `no key '${part}' at this level` },
      };
    }
  }

  return {
    shape: "json_extracted_value",
    body: {
      value: current,
      path: pointer.path,
      valueJson: JSON.stringify(current),
    },
  };
}
