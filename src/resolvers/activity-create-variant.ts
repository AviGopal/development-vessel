import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * Operator-curated set of input shapes that are allowed to have no producer
 * registered in activity-api (they are seeded by external boundary events:
 * file watchers, harness runs, operator goals, lifecycle hooks). When the
 * permissive-scope I2 invariant runs, an inputShape is acceptable iff it is
 * either in this set OR is produced by at least one registered template.
 *
 * Keep this set small and explicit; growth here is operator-policy, not
 * substrate-policy. Phase 3's pattern miner emits new shapes that should be
 * authored as outputShapes of new templates, not added to this list.
 */
export const KNOWN_SEEDABLE_SHAPES: ReadonlySet<string> = new Set([
  // Operator / boundary inputs
  "memo",
  "goal",
  "userInput",
  "gapScenario",
  "failureModeReport",
  "recurringPatternCluster",
  // Filesystem / process surfaces produced by adapters
  "fileContent",
  "directoryListing",
  "gitDiff",
  "gitStatus",
  // Lifecycle / framework signals
  "activityExecutionTrace",
  "executionTraceList",
  // Action-effect catalogue (Phase 1 of obsidian)
  "actionEffectModel",
  // Vocabularies pulled from activity-api
  "resolverVocabulary",
  "activityVocabulary",
]);

/** Maximum depth allowed for `max_composition_depth`. Mirrors the existing
 *  parent_execution_id read-walk cap (16) at engine.ts. */
export const MAX_COMPOSITION_DEPTH = 16;

/** Description discipline (I4): minimum length and forbidden values. */
const MIN_DESCRIPTION_LENGTH = 40;
const FORBIDDEN_DESCRIPTIONS = new Set(["", "todo", "tbd", "fixme", "xxx"]);

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
  /** Test hook for the I2/I3 invariants: provide a lookup that returns the existing
   *  template registry. Production path queries activity-api directly. */
  _registryLookupFn?: () => Promise<RegisteredTemplate[]>;
}

/** Minimal projection of an activity template used by the registration invariants. */
export interface RegisteredTemplate {
  id: string;
  output_shapes?: string[];
  outputShapes?: string[];
  tasks?: Array<{ id?: string; resolver?: string; subActivityId?: string; sub_activity_id?: string }>;
}

/**
 * Permissive-scope registration-time invariants (Phase 2, 2026-06-01).
 * Returns null if the template passes; a structuredError body on the first
 * violation. Order matches the spec (I1..I6).
 */
export async function checkPermissiveInvariants(
  template: Record<string, unknown>,
  registryLookupFn: () => Promise<RegisteredTemplate[]>,
): Promise<{ failed: true; detail: string; invariant: string } | null> {
  const tasks = Array.isArray(template["tasks"]) ? (template["tasks"] as Record<string, unknown>[]) : [];
  const proposed = template["proposed"] === true;
  const templateId = String(template["id"] ?? "");
  const inputShapes = Array.isArray(template["inputShapes"])
    ? (template["inputShapes"] as string[])
    : Array.isArray(template["input_shapes"]) ? (template["input_shapes"] as string[]) : [];
  const outputShapes = Array.isArray(template["outputShapes"])
    ? (template["outputShapes"] as string[])
    : Array.isArray(template["output_shapes"]) ? (template["output_shapes"] as string[]) : [];

  // I1 — max_composition_depth check.
  // The template field is `max_composition_depth`. If absent, default to 1
  // (single-level dispatch). Refuse if > MAX_COMPOSITION_DEPTH or if any
  // compose task target's own depth + this template's depth would exceed
  // the cap. The transitive check is bounded to the registry snapshot.
  const declaredDepth = typeof template["max_composition_depth"] === "number"
    ? Number(template["max_composition_depth"])
    : 1;
  if (declaredDepth > MAX_COMPOSITION_DEPTH) {
    return {
      failed: true,
      invariant: "I1",
      detail: `max_composition_depth ${declaredDepth} exceeds the substrate cap of ${MAX_COMPOSITION_DEPTH}`,
    };
  }

  // Fetch the registry once for the remaining I2/I3 invariants. If the
  // lookup fails (network etc), the invariant cannot be enforced and we
  // log + skip the producer/circularity checks rather than rejecting on a
  // transient error. The behaviour is deliberate: the comprehensibility
  // check and the operator policy provide independent safety nets.
  let registry: RegisteredTemplate[] = [];
  let registryReachable = false;
  try {
    registry = await registryLookupFn();
    registryReachable = true;
  } catch {
    // soft-fail
  }

  // I2 — every inputShape has a producer or is in KNOWN_SEEDABLE_SHAPES.
  if (registryReachable && inputShapes.length > 0) {
    const allProduced = new Set<string>();
    for (const t of registry) {
      const os = t.output_shapes ?? t.outputShapes ?? [];
      for (const s of os) allProduced.add(s);
    }
    // The template's own output shapes also count (a single template can be
    // self-producing via internal compose chains).
    for (const s of outputShapes) allProduced.add(s);
    for (const shape of inputShapes) {
      if (!KNOWN_SEEDABLE_SHAPES.has(shape) && !allProduced.has(shape)) {
        return {
          failed: true,
          invariant: "I2",
          detail:
            `inputShape '${shape}' has no producer in the activity registry and is not in ` +
            `KNOWN_SEEDABLE_SHAPES. Either declare a producer template or mark the shape ` +
            `seedable via the operator-curated set.`,
        };
      }
    }
  }

  // I3 — no circular compose. DFS over compose targets transitively; refuse
  // if any reachable target id === this template id.
  if (registryReachable && templateId) {
    const byId = new Map(registry.map((t) => [t.id, t]));
    const composeTargets = (t: RegisteredTemplate | undefined): string[] => {
      if (!t || !Array.isArray(t.tasks)) return [];
      return t.tasks
        .filter((task) => task.resolver === "compose")
        .map((task) => String(task.subActivityId ?? task.sub_activity_id ?? ""))
        .filter((s) => s.length > 0);
    };
    // Seed the DFS with this template's own compose targets.
    const initialTargets = tasks
      .filter((task) => String(task["resolver"]) === "compose")
      .map((task) => String(task["subActivityId"] ?? task["sub_activity_id"] ?? ""))
      .filter((s) => s.length > 0);
    const stack = [...initialTargets];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === templateId) {
        return {
          failed: true,
          invariant: "I3",
          detail: `compose chain contains a cycle back to this template id '${templateId}'`,
        };
      }
      if (seen.has(next)) continue;
      seen.add(next);
      for (const child of composeTargets(byId.get(next))) stack.push(child);
    }
  }

  // I4 — every task has a non-trivial, non-duplicate-of-id description.
  for (const task of tasks) {
    const desc = String(task["description"] ?? "").trim();
    const id = String(task["id"] ?? "").trim();
    const lower = desc.toLowerCase();
    if (
      desc.length < MIN_DESCRIPTION_LENGTH
      || FORBIDDEN_DESCRIPTIONS.has(lower)
      || lower === id.toLowerCase()
    ) {
      return {
        failed: true,
        invariant: "I4",
        detail:
          `task '${id || "<unnamed>"}' description must be ≥${MIN_DESCRIPTION_LENGTH} chars, ` +
          `not "TODO"/"TBD"/empty, and not just the task id. Got: "${desc.slice(0, 80)}"`,
      };
    }
  }

  // I5 — every declared output_shape is produced by at least one task.
  // A task is treated as producing its declared `outputShapes` (camelCase
  // form on the task is the convention in this codebase).
  if (outputShapes.length > 0) {
    const taskProducedShapes = new Set<string>();
    for (const task of tasks) {
      const os = Array.isArray(task["outputShapes"])
        ? (task["outputShapes"] as string[])
        : Array.isArray(task["output_shapes"]) ? (task["output_shapes"] as string[]) : [];
      for (const s of os) taskProducedShapes.add(s);
    }
    for (const shape of outputShapes) {
      if (!taskProducedShapes.has(shape)) {
        return {
          failed: true,
          invariant: "I5",
          detail:
            `declared output_shape '${shape}' is not produced by any task. ` +
            `Every output_shape must appear in at least one task's outputShapes list.`,
        };
      }
    }
  }

  // I6 — authored_from_pattern is required when proposed=true (substrate-authored).
  // Operator-seeded templates can omit it.
  if (proposed) {
    const afp = template["authored_from_pattern"];
    if (!afp || typeof afp !== "object") {
      return {
        failed: true,
        invariant: "I6",
        detail:
          `proposed=true templates require an authored_from_pattern metadata field ` +
          `with at least one of { pattern_id, observation_window, contrast_examples }`,
      };
    }
    const obj = afp as Record<string, unknown>;
    if (!obj["pattern_id"] && !obj["observation_window"] && !obj["contrast_examples"]) {
      return {
        failed: true,
        invariant: "I6",
        detail:
          `authored_from_pattern must include at least one of { pattern_id, observation_window, contrast_examples }`,
      };
    }
  }

  return null;
}

async function defaultRegistryLookup(): Promise<RegisteredTemplate[]> {
  const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=2000`, {
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
  });
  if (!res.ok) throw new Error(`registry lookup ${res.status}`);
  const data = (await res.json()) as { templates?: RegisteredTemplate[] } | RegisteredTemplate[];
  if (Array.isArray(data)) return data;
  return data.templates ?? [];
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

  // Phase 2 (2026-06-01) — permissive-scope registration-time invariants.
  // Scoped to substrate-authored templates with the `proposed_pattern_authored_`
  // id prefix. Operator-seeded templates and the legacy `gap-closing:` path
  // are exempt; the legacy gap-closing constraints stay below, gated to the
  // gap-closing: prefix exclusively. The 6 invariants are documented on
  // checkPermissiveInvariants above.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const tid = String(t["id"] ?? "");
    const isPermissiveScope =
      tid.startsWith("proposed_pattern_authored_")
      || (pointer as unknown as Record<string, unknown>)["validate_permissive_scope"] === true;
    // Apply the substrate-authored default BEFORE the invariants run so I6
    // sees the proposed=true flag the registration would actually carry.
    // Operator seeds keep opt-out via an explicit proposed=false.
    if (isPermissiveScope && t["proposed"] === undefined) {
      t["proposed"] = true;
    }
    if (isPermissiveScope) {
      const lookupFn = pointer._registryLookupFn ?? defaultRegistryLookup;
      const verdict = await checkPermissiveInvariants(t, lookupFn);
      if (verdict) {
        return {
          shape: "structuredError",
          body: {
            resolver: "activity_create_variant",
            failure_mode: "activity_registration_invariant",
            invariant: verdict.invariant,
            detail: verdict.detail,
          },
        };
      }
    }
  }

  // Validate gap-closing templates: mechanically enforce the constraints that LLM
  // prompt instructions alone cannot reliably enforce. Templates that fail validation
  // are rejected here (structuredError) rather than registered and failing at execution.
  // This makes LLM failures loud and early instead of silent-success + runtime-failure.
  // GATING (Phase 2, 2026-06-01): scoped to gap-closing: ids exclusively. The
  // permissive-scope authoring path (proposed_pattern_authored_*) does NOT inherit
  // the json_path_extract ban, the restricted resolver allow-list, or the
  // workspace-prefix fs_read constraint — those are gap-closing artefacts.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const templateId = String(t["id"] ?? "");
    if (templateId.startsWith("gap-closing:") || (pointer as unknown as Record<string,unknown>)["validate_gap_closing"]) {
      const tasks = Array.isArray(t["tasks"]) ? (t["tasks"] as Record<string, unknown>[]) : [];
      // json_path_extract removed from ALLOWED — too fragile and the prompt explicitly bans it.
      // LLM-drafted templates repeatedly use it for object navigation that breaks on schema variance;
      // observed in fp-12-1780147252079 (15 tasks, fails at task 2 task-extract-output-impulses).
      const ALLOWED_RESOLVERS = new Set(["fs_read","fs_write","llm_completion_dispatch","http_fetch","noop"]);
      const WORKSPACE_PREFIX = "/workspace/";
      const VALID_HTTP_HOSTS = ["127.0.0.1:8080","127.0.0.1:8090","127.0.0.1:8260","127.0.0.1:8270","127.0.0.1:8100","127.0.0.1:8210"];

      for (const task of tasks) {
        const resolver = String(task["resolver"] ?? "");
        const cfg = (task["config"] ?? {}) as Record<string, unknown>;

        if (!ALLOWED_RESOLVERS.has(resolver)) {
          return { shape: "structuredError", body: {
            resolver: "activity_create_variant", failure_mode: "validation_rejected",
            detail: `Task '${task["id"]}' uses disallowed resolver '${resolver}'. Allowed: ${[...ALLOWED_RESOLVERS].join(",")}. Use llm_completion_dispatch to process JSON.`,
          }};
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
