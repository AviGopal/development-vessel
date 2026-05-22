import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityCreateVariantPointer {
  type: "activity_create_variant";
  template: unknown;
  parentTemplateId?: string;
  /** When set, forcibly overrides the `outputShapes` field on the generated template
   *  regardless of what the LLM wrote. Accepts a JSON array or a JSON-string array. */
  output_shapes_override?: unknown;
}

export async function resolveActivityCreateVariant(pointer: ActivityCreateVariantPointer): Promise<ResolverResult> {
  const url = `${METABOB_ENDPOINT}/v2/activities/templates`;
  // Template may arrive as a JSON string (from LLM output via interpolation); parse if needed.
  let templateObj: unknown = pointer.template;
  if (typeof templateObj === "string") {
    // Strip markdown code fences if present (LLM output often wraps JSON in ```json...```).
    // Also handle case where only the JSON object is extracted (first { ... last }).
    let stripped = templateObj.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    const jsonStart = stripped.indexOf("{");
    const jsonEnd = stripped.lastIndexOf("}");
    if (jsonStart > 0) stripped = stripped.slice(jsonStart, jsonEnd + 1);
    try { templateObj = JSON.parse(stripped); } catch { /* leave as string; API will reject with clear error */ }
  }
  // Sanitize tags: replace hyphens with dots, drop non-alphanumeric/dot chars.
  if (templateObj && typeof templateObj === "object" && "tags" in templateObj) {
    const t = templateObj as Record<string, unknown>;
    if (Array.isArray(t["tags"])) {
      t["tags"] = (t["tags"] as unknown[]).map((tag) =>
        typeof tag === "string"
          ? tag.toLowerCase().replace(/-/g, ".").replace(/[^a-z0-9.]/g, "")
          : tag
      );
    }
  }
  // Normalize task fields: LLMs often use "name" instead of "description", "params" instead of "config".
  if (templateObj && typeof templateObj === "object" && "tasks" in templateObj) {
    const t = templateObj as Record<string, unknown>;
    if (Array.isArray(t["tasks"])) {
      t["tasks"] = (t["tasks"] as unknown[]).map((task) => {
        if (!task || typeof task !== "object") return task;
        const tt = { ...(task as Record<string, unknown>) };
        if (!tt["description"] && tt["name"]) { tt["description"] = tt["name"]; delete tt["name"]; }
        if (!tt["config"] && tt["params"]) { tt["config"] = tt["params"]; delete tt["params"]; }
        if (!tt["outputShapes"] && tt["produces"]) { tt["outputShapes"] = typeof tt["produces"] === "string" ? [tt["produces"]] : tt["produces"]; delete tt["produces"]; }
        if (!tt["inputShapes"] && tt["consumes"]) { tt["inputShapes"] = typeof tt["consumes"] === "string" ? [tt["consumes"]] : tt["consumes"]; delete tt["consumes"]; }
        return tt;
      });
    }
  }
  // Forcibly override outputShapes when the caller provides a deterministic value.
  if (pointer.output_shapes_override !== undefined && templateObj && typeof templateObj === "object") {
    let shapes: unknown = pointer.output_shapes_override;
    if (typeof shapes === "string") {
      try { shapes = JSON.parse(shapes); } catch { shapes = [shapes]; }
    }
    (templateObj as Record<string, unknown>)["outputShapes"] = shapes;
  }

  const body = pointer.parentTemplateId
    ? { ...templateObj as object, parent_template_id: pointer.parentTemplateId }
    : templateObj;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const adminNote = res.status === 403 ? "admin scope required for this operation" : undefined;
    return {
      shape: "structuredError",
      body: { resolver: "activity_create_variant", status: res.status, detail: text.slice(0, 200), adminNote },
    };
  }
  const result = await res.json() as { id?: string; template_id?: string };
  const variantId = result.id ?? result.template_id ?? "";
  return {
    shape: "variant_created",
    body: { variantId, parentTemplateId: pointer.parentTemplateId, accepted: true },
  };
}
