import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityCreateVariantPointer {
  type: "activity_create_variant";
  template: unknown;
  parentTemplateId?: string;
  /** When set, forcibly overrides the `outputShapes` field on the generated template
   *  regardless of what the LLM wrote. Accepts a JSON array or a JSON-string array. */
  output_shapes_override?: unknown;
  /** When true, removes the `id` field from the template before posting so activity-api
   *  always assigns a fresh UUID. Prevents silent no-ops when the id already exists. */
  strip_id?: boolean;
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
  // Normalize camelCase → snake_case shape fields so activity-api's Zod schema reads them.
  // TypeScript ActivityTemplate uses camelCase (outputShapes, inputShapes); the API reads snake_case.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    if (t["outputShapes"] !== undefined && t["output_shapes"] === undefined) {
      t["output_shapes"] = t["outputShapes"];
    }
    if (t["inputShapes"] !== undefined && t["input_shapes"] === undefined) {
      t["input_shapes"] = t["inputShapes"];
    }
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
  // Append a timestamp to the id when strip_id is set — prevents silent no-ops when
  // the declared id already exists in activity-api (POST is idempotent-ish on existing ids).
  if (pointer.strip_id && templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const baseId = typeof t["id"] === "string" ? t["id"] : "variant";
    t["id"] = `${baseId}-${Date.now()}`;
  }

  // Forcibly override output shapes when the caller provides a valid array.
  // activity-api's CreateTemplateRequestSchema reads snake_case `output_shapes`, not
  // camelCase `outputShapes` — Zod strips unknown keys so the camelCase form is ignored.
  // Skip the override if the value isn't a valid string-array (e.g. an error object from
  // a failed upstream task) — in that case the LLM-generated outputShapes are used as-is.
  if (pointer.output_shapes_override !== undefined && templateObj && typeof templateObj === "object") {
    let shapes: unknown = pointer.output_shapes_override;
    if (typeof shapes === "string") {
      try { shapes = JSON.parse(shapes); } catch { shapes = undefined; }
    }
    // Only apply if it's a non-empty array of strings (not an error object)
    if (Array.isArray(shapes) && shapes.length > 0 && shapes.every((s) => typeof s === "string")) {
      const t = templateObj as Record<string, unknown>;
      t["output_shapes"] = shapes;   // snake_case: read by Zod schema
      t["outputShapes"] = shapes;    // camelCase: kept for any non-Zod readers
    }
  }

  // Validate gap-closing templates: mechanically enforce the constraints that LLM
  // prompt instructions alone cannot reliably enforce. Templates that fail validation
  // are rejected here (structuredError) rather than registered and failing at execution.
  // This makes LLM failures loud and early instead of silent-success + runtime-failure.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const templateId = String(t["id"] ?? "");
    if (templateId.startsWith("gap-closing:") || (pointer as unknown as Record<string,unknown>)["validate_gap_closing"]) {
      const tasks = Array.isArray(t["tasks"]) ? (t["tasks"] as Record<string, unknown>[]) : [];
      const ALLOWED_RESOLVERS = new Set(["fs_read","fs_write","llm_completion_dispatch","json_path_extract","http_fetch","noop"]);
      const JMESPATH_CHARS = /[\[\]\*\?\(\)]/;
      const WORKSPACE_PREFIX = "/workspace/";
      const VALID_HTTP_HOSTS = ["127.0.0.1:8080","127.0.0.1:8090","127.0.0.1:8260","127.0.0.1:8270","127.0.0.1:8100","127.0.0.1:8210"];

      for (const task of tasks) {
        const resolver = String(task["resolver"] ?? "");
        const cfg = (task["config"] ?? {}) as Record<string, unknown>;

        if (!ALLOWED_RESOLVERS.has(resolver)) {
          return { shape: "structuredError", body: {
            resolver: "activity_create_variant", failure_mode: "validation_rejected",
            detail: `Task '${task["id"]}' uses disallowed resolver '${resolver}'. Allowed: ${[...ALLOWED_RESOLVERS].join(",")}`,
          }};
        }

        // json_path_extract: block JMESPath syntax
        if (resolver === "json_path_extract") {
          const path = String(cfg["path"] ?? "");
          if (JMESPATH_CHARS.test(path)) {
            return { shape: "structuredError", body: {
              resolver: "activity_create_variant", failure_mode: "validation_rejected",
              detail: `Task '${task["id"]}' json_path_extract uses JMESPath chars in path '${path}'. Use simple dot notation only.`,
            }};
          }
        }

        // fs_read: block non-workspace absolute paths
        if (resolver === "fs_read") {
          const path = String(cfg["path"] ?? "");
          if (path.startsWith("/") && !path.startsWith(WORKSPACE_PREFIX)) {
            return { shape: "structuredError", body: {
              resolver: "activity_create_variant", failure_mode: "validation_rejected",
              detail: `Task '${task["id"]}' fs_read path '${path}' is outside /workspace/. Only workspace paths are allowed.`,
            }};
          }
        }

        // http_fetch: block invented URLs — only allow known substrate endpoints
        if (resolver === "http_fetch") {
          const url = String(cfg["url"] ?? "");
          if (url && !VALID_HTTP_HOSTS.some(h => url.includes(h))) {
            return { shape: "structuredError", body: {
              resolver: "activity_create_variant", failure_mode: "validation_rejected",
              detail: `Task '${task["id"]}' http_fetch URL '${url.slice(0,80)}' uses unknown host. Valid hosts: ${VALID_HTTP_HOSTS.join(",")}`,
            }};
          }
        }
      }
    }
  }

  // Mark substrate-authored templates as proposed=true so auto-promote can
  // see them and graduate them after sufficient empirical evidence accumulates.
  // WITHOUT this flag, auto-promote's candidate scan returns 0 and the
  // substrate never promotes its own authored templates.
  //
  // EXCEPTION: if the template already has proposed=false (operator-seeded
  // templates pass through cli.ts → resolveActivityCreateVariant), respect
  // that. Only apply proposed=true when proposed is absent or already true.
  // This prevents seed-templates (ExecStartPost on every dev-vessel restart)
  // from resetting all seed templates to proposed=true via this resolver.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    if (t["proposed"] !== false) {
      t["proposed"] = true;
    }
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
    // Stratify failure_mode so callers (CLI seed-templates, observers) can branch on category.
    const failure_mode =
      res.status === 401 || res.status === 403 ? "auth_rejected"
      : res.status === 409 ? "already_exists"
      : res.status >= 400 && res.status < 500 ? "validation_rejected"
      : "upstream_error";
    return {
      shape: "structuredError",
      body: { resolver: "activity_create_variant", failure_mode, status: res.status, detail: text.slice(0, 200), adminNote },
    };
  }
  const result = await res.json() as { id?: string; template_id?: string };
  const variantId = result.id ?? result.template_id ?? "";

  // Return activityRegistryChange so that minibob includes it in the activity's
  // output_shapes when emitting lifecycle:execution:succeeded. The development-vessel's
  // registry-change observer watches for that shape and fires the topology chain.
  return {
    shape: "activityRegistryChange",
    body: { variantId, parentTemplateId: pointer.parentTemplateId, accepted: true },
  };
}
