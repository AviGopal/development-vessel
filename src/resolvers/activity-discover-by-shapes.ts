import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityDiscoverByShapesPointer {
  type: "activity_discover_by_shapes";
  /** Shapes the found activities must produce (forward mode) or consume (backward mode). */
  required_shapes: string[] | string;
  mode?: "forward" | "backward";
  limit?: number;
}

export async function resolveActivityDiscoverByShapes(pointer: ActivityDiscoverByShapesPointer): Promise<ResolverResult> {
  const url = `${METABOB_ENDPOINT}/v2/activities/discover-by-shapes`;

  // Accept JSON-string array from interpolateVars exact-match substitution.
  let requiredShapes: string[] = [];
  if (typeof pointer.required_shapes === "string") {
    try { requiredShapes = JSON.parse(pointer.required_shapes) as string[]; } catch { requiredShapes = [pointer.required_shapes]; }
  } else {
    requiredShapes = pointer.required_shapes;
  }

  if (requiredShapes.length === 0) {
    return {
      shape: "discovered_activities",
      body: { activities: [], total: 0, matched: false, first_id: null, emergence_class: "gap" },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      required_shapes: requiredShapes,
      mode: pointer.mode ?? "forward",
      limit: pointer.limit ?? 20,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "structuredError",
      body: { resolver: "activity_discover_by_shapes", status: res.status, detail: text.slice(0, 200) },
    };
  }

  const json = await res.json() as { activities?: unknown[]; total?: number };
  const raw = json.activities ?? [];

  // Normalise: discover-by-shapes uses output_schema.produces_shapes, not output_shapes.
  const activities = raw.map((a: unknown) => {
    const act = a as Record<string, unknown>;
    const outputSchema = act["output_schema"] as { produces_shapes?: string[] } | undefined;
    const inputSchema = act["input_schema"] as { required_shapes?: string[] } | undefined;
    return {
      id: (act["variant_id"] ?? act["activity_id"] ?? act["id"]) as string | undefined,
      name: (act["variant_name"] ?? act["name"]) as string | undefined,
      output_shapes: (act["output_shapes"] as string[] | undefined) ?? outputSchema?.produces_shapes ?? [],
      input_shapes: (act["input_shapes"] as string[] | undefined) ?? inputSchema?.required_shapes ?? [],
      tags: (act["tags"] as string[] | undefined) ?? [],
    };
  });

  const matched = activities.length > 0;
  const first = activities[0];

  return {
    shape: "discovered_activities",
    body: {
      activities,
      total: activities.length,
      matched,
      first_id: first?.id ?? null,
      first_output_shapes: first?.output_shapes ?? [],
      // Derived emergence class: shape-indexed match is authoritative reuse.
      emergence_class: matched ? "reuse" : "gap",
    },
  };
}
