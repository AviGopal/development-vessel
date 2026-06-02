import type { ResolverResult } from "./types.js";

export interface JsonPathExtractPointer {
  type: "json_path_extract";
  json: string | unknown; // string (JSON text) or pre-parsed object (from interpolateVars exact-match substitution)
  path: string; // dot-notation path, e.g. "expected_emergence.activity_signature.output_shapes_must_include"
}

/**
 * Strip markdown code fences from an LLM JSON output and slice to the first
 * top-level JSON object. Mirrors the inline logic in activity-create-variant
 * (lines ~261-267). Kept in-resolver to keep blast radius local.
 */
function stripFencesAndExtractObject(raw: string): string {
  let stripped = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
  const jsonStart = stripped.indexOf("{");
  const jsonEnd = stripped.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    stripped = stripped.slice(jsonStart, jsonEnd + 1);
  }
  return stripped;
}

function missingResult(path: string, reason: string): ResolverResult {
  // Tolerant return: callers downstream see `value` as empty-string so
  // string-interpolation produces "" rather than crashing the chain.
  // `missing: true` lets callers that care distinguish missing-path from
  // legitimately-empty values.
  return {
    shape: "json_extracted_value",
    body: {
      value: "",
      path,
      valueJson: '""',
      missing: true,
      reason,
    },
  };
}

export async function resolveJsonPathExtract(pointer: JsonPathExtractPointer): Promise<ResolverResult> {
  // interpolateVars JSON-parses exact {{var}} substitutions, so pointer.json may arrive
  // as a pre-parsed object rather than a JSON string. Accept both forms.
  let obj: unknown;
  if (typeof pointer.json === "string") {
    // LLM output frequently arrives wrapped in ```json ... ``` fences or with
    // narration before/after the JSON. Strip fences and slice to first {...}
    // before parsing — same as activity-create-variant's inline logic.
    const candidate = stripFencesAndExtractObject(pointer.json);
    try {
      obj = JSON.parse(candidate);
    } catch {
      return missingResult(pointer.path, "input is not valid JSON (after fence-strip)");
    }
  } else {
    obj = pointer.json;
  }

  const parts = pointer.path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return missingResult(pointer.path, `null/undefined encountered at segment: ${part}`);
    }
    if (typeof current !== "object" || Array.isArray(current)) {
      return missingResult(pointer.path, `path not found at segment: ${part}`);
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) {
      return missingResult(pointer.path, `no key '${part}' at this level`);
    }
  }

  if (current === null) {
    return missingResult(pointer.path, "path resolved to null");
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
