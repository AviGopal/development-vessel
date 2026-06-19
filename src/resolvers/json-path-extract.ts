import type { ResolverResult } from "./types.js";

export interface JsonPathExtractPointer {
  type: "json_path_extract";
  json: string | unknown; // string (JSON text) or pre-parsed object (from interpolateVars exact-match substitution)
  path: string; // dot-notation path, e.g. "expected_emergence.activity_signature.output_shapes_must_include"
  fallback_path?: string;
  /**
   * Optional suffix to strip from the extracted value when it's a string.
   * Useful for derived ids like "auto-foo.json" → "auto-foo" without
   * needing a separate string resolver. (V18 producer-chain support, 2026-06-07).
   */
  strip_suffix?: string;
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

  function walk(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) {
        return { ok: false, reason: `null/undefined encountered at segment: ${part}` };
      }
      if (typeof current !== "object") {
        return { ok: false, reason: `path not found at segment: ${part}` };
      }
      current = (current as Record<string, unknown>)[part];
      if (current === undefined) {
        return { ok: false, reason: `no key '${part}' at this level` };
      }
    }
    return { ok: true, value: current };
  }

  let resolvedPath = pointer.path;
  let walked = walk(pointer.path);
  const primaryEmpty = walked.ok && (walked.value === "" || walked.value === null || walked.value === undefined);
  if ((!walked.ok || primaryEmpty) && typeof pointer.fallback_path === "string" && pointer.fallback_path.length > 0) {
    const fallback = walk(pointer.fallback_path);
    if (fallback.ok) {
      walked = fallback;
      resolvedPath = pointer.fallback_path;
    }
  }
  if (!walked.ok) {
    return missingResult(pointer.path, walked.reason);
  }
  let current: unknown = walked.value;

  if (current === null) {
    return missingResult(resolvedPath, "path resolved to null");
  }

  // Optional suffix strip (V18 2026-06-07): applies when value is a string
  // and ends with the supplied suffix. Lets callers derive a bare scenario id
  // from "scenario.json" without a separate string-transform resolver.
  if (typeof current === "string" && typeof pointer.strip_suffix === "string" && pointer.strip_suffix.length > 0 && current.endsWith(pointer.strip_suffix)) {
    current = current.slice(0, current.length - pointer.strip_suffix.length);
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
