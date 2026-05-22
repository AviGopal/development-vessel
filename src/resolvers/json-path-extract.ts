import type { ResolverResult } from "./types.js";

export interface JsonPathExtractPointer {
  type: "json_path_extract";
  json: string;
  path: string; // dot-notation path, e.g. "expected_emergence.activity_signature.output_shapes_must_include"
}

export async function resolveJsonPathExtract(pointer: JsonPathExtractPointer): Promise<ResolverResult> {
  let obj: unknown;
  try {
    obj = JSON.parse(pointer.json);
  } catch {
    return {
      shape: "structuredError",
      body: { resolver: "json_path_extract", detail: "input is not valid JSON" },
    };
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
