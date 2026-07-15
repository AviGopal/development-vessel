import { readdir } from "node:fs/promises";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * V31 (2026-06-09) — File-inventory cache for the V25 canonical analyze prompt.
 *
 * The LLM running TASK 3 of substrate-authored variants was hallucinating
 * file paths at ~80% rate (5 rejections in V29 archives within 30min of V29
 * activation). Without the actual vessel-source inventory in the prompt, the
 * LLM invents plausible-but-nonexistent names like
 * `activity-lifecycle.ts` (real: `activity-lifecycle-audit.ts`) or
 * `dispatch/target-template-resolver.ts` (real: no dispatch/ directory).
 *
 * V31 walks the canonical /vessels/<v>/src trees once per 5 min, builds a
 * flat repos/<v>/src/... path list, and bakes that list into the canonical
 * prompt at registration time. The LLM is then constrained to pick a real
 * path from the inventory instead of inventing one.
 *
 * Mitosis vessel clones (/vessels/<v>-mitosis-<TS>/) are explicitly excluded
 * — they're staging artefacts, not edit targets. node_modules and dist are
 * also excluded.
 */
const CANONICAL_VESSELS = [
  // 2026-06-18: activity-api (142 files), cpg-inference-ts, metric-collector-vessel,
  // and obsidian-vessel were MISSING — all are self-editable per the drafter prompt,
  // so variants targeting them could not see their real files and hallucinated paths
  // (the dominant file_path_hallucination cause; e.g. a TS2459 fix that belonged in
  // activity-api was mis-targeted to development-vessel). Adding them lets the variant
  // LLM pick a real path, so proposals targeting these vessels can actually land.
  "activity-api",
  "cpg-inference-ts",
  "metric-collector-vessel",
  "obsidian-vessel",
  "development-vessel",
  "goal-host-vessel",
  "llm-resolver-vessel",
  "ribosome-vessel",
  "analysis-vessel",
  "local-tools-vessel",
  "light-dispatch-vessel",
  "stateful-ui-vessel",
  "discovery-vessel",
  "identity-vessel",
  "boredom-vessel",
  "ias-executor-ts",
  "concept-db",
];
const INVENTORY_TTL_MS = 5 * 60 * 1000;
let cachedInventory: string | null = null;
let cachedInventoryAt = 0;

async function walkTsFiles(dir: string, into: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await walkTsFiles(p, into);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      into.push(p.replace(/^\/vessels\//, "repos/"));
    }
  }
}

async function getFileInventory(): Promise<string> {
  const now = isFinite(cachedInventoryAt) ? Date.now() : 0;
  if (cachedInventory && now - cachedInventoryAt < INVENTORY_TTL_MS) return cachedInventory;
  const paths: string[] = [];
  for (const v of CANONICAL_VESSELS) {
    await walkTsFiles(`/vessels/${v}/src`, paths);
  }
  cachedInventory = paths.sort().join("\n");
  cachedInventoryAt = Date.now();
  return cachedInventory;
}

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

/** Canonical substrate LLM model. Foreign model ids the drafter LLM emits in
 *  llm_completion_dispatch task configs (gpt-4, gpt-4-turbo, …) are rewritten to
 *  this at registration so authored chains are executable against the
 *  Anthropic-backed llm-resolver-vessel. */
const CANONICAL_LLM_MODEL = "anthropic/claude-haiku-4-5-20251001";

/** Description discipline (I4): minimum length and forbidden values. */
const MIN_DESCRIPTION_LENGTH = 40;
const FORBIDDEN_DESCRIPTIONS = new Set(["", "todo", "tbd", "fixme", "xxx"]);

/**
 * V25 (2026-06-09) — Canonical analyze prompt for gap-closing variants.
 * LLM-A (drafter) re-summarises TASK 3's prompt freely, producing variants
 * whose LLM-B (executor) emits gap_analysis/recommendation/autoDraftedOutput_*
 * wrapper schemas that apply_proposal_as_patch cannot consume. This constant
 * is injected at registration time, overwriting whatever LLM-A wrote, so
 * every gap-closing: variant has a TASK 3 prompt that enforces the
 * { kind: "patch_proposal", required_code_modifications: [{ file, description }] }
 * schema directly. Interpolation tokens {{read_scenario_content}} and
 * {{fetch_traces_content}} are honoured by both goal-host and light-dispatch.
 */
const CANONICAL_ANALYZE_PROMPT =
  "Scenario: {{read_scenario_content}}\n\n" +
  "Recent traces: {{fetch_traces_content}}\n\n" +
  "Analyze the failure mode described in the scenario against the recent traces, " +
  "then produce a JSON proposal report with this EXACT schema (no other top-level keys, no wrapper objects):\n" +
  "{\n" +
  '  "kind": "patch_proposal",\n' +
  '  "summary": "<one-line analysis summary>",\n' +
  '  "required_code_modifications": [\n' +
  "    {\n" +
  '      "file": "repos/<vessel>/src/<file>.ts",\n' +
  '      "description": "<what changes and why>"\n' +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "CRITICAL CONSTRAINTS:\n" +
  '- TOP-LEVEL "kind" MUST be exactly the string "patch_proposal". apply_proposal_as_patch uses it as the discriminator.\n' +
  '- "required_code_modifications" MUST be a non-empty array. Each entry MUST have a "file" string starting with "repos/" followed by a real vessel name (e.g. repos/development-vessel/src/resolvers/foo.ts).\n' +
  '- DO NOT wrap the response in any object like {"autoDraftedOutput_<id>": {...}} or {"<shape>": {...}}. The three keys above are the ONLY top-level keys allowed.\n' +
  "- DO NOT emit gap_analysis, recommendation, evidence_from_traces, implementation_sketch, or next_action. They will be rejected.\n" +
  "- Available vessels: development-vessel, goal-host-vessel, llm-resolver-vessel, ribosome-vessel, analysis-vessel, local-tools-vessel, light-dispatch-vessel, stateful-ui-vessel, discovery-vessel, identity-vessel, boredom-vessel, ias-executor-ts, concept-db. If unsure, default to development-vessel.\n" +
  "- List exactly ONE file unless the gap genuinely spans multiple.\n\n" +
  "Output ONLY the JSON object. No prose, no markdown fences.";

/**
 * V25 — Enforce canonical analyze prompt on every gap-closing: variant.
 * V31 (2026-06-09) — async + injects fresh vessel-source inventory so the LLM
 * picks a real file path rather than hallucinating one.
 */
async function enforceCanonicalAnalyzePrompt(template: Record<string, unknown>): Promise<void> {
  const tasks = Array.isArray(template["tasks"]) ? (template["tasks"] as Record<string, unknown>[]) : [];
  let inventory: string | null = null;
  for (const task of tasks) {
    if (String(task["resolver"]) !== "llm_completion_dispatch") continue;
    const cfg = (task["config"] ?? {}) as Record<string, unknown>;
    const prompt = String(cfg["prompt"] ?? "");
    const looksLikeAnalyze =
      prompt.includes("{{read_scenario_content}}")
      || prompt.includes("{{fetch_traces_content}}")
      || prompt.toLowerCase().includes("scenario")
      && prompt.toLowerCase().includes("trace");
    if (!looksLikeAnalyze) continue;
    if (inventory === null) inventory = await getFileInventory();
    const promptWithInventory =
      CANONICAL_ANALYZE_PROMPT +
      "\n\nAVAILABLE FILES (you MUST pick one of these EXACT paths for `file` — do NOT invent a path that is not in this list):\n" +
      inventory;
    cfg["prompt"] = promptWithInventory;
    cfg["max_tokens"] = 1500;
    task["config"] = cfg;
    task["outputShapes"] = ["patch_proposal"];
  }
}

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
 * Collect the set of shapes produced by at least one task in the template.
 * A task is treated as producing its declared `outputShapes` (the camelCase
 * convention in this codebase) or `output_shapes`. Shared by the
 * output_shapes_override reachability check and the general reachability gate
 * so both judge "produced" identically — and identically to invariant I5.
 */
export function collectTaskProducedShapes(template: Record<string, unknown>): Set<string> {
  const tasks = Array.isArray(template["tasks"]) ? (template["tasks"] as Record<string, unknown>[]) : [];
  const produced = new Set<string>();
  for (const task of tasks) {
    const os = Array.isArray(task["outputShapes"])
      ? (task["outputShapes"] as string[])
      : Array.isArray(task["output_shapes"]) ? (task["output_shapes"] as string[]) : [];
    for (const s of os) produced.add(s);
  }
  return produced;
}

/**
 * Reachability check: returns the declared template output shapes that are
 * NOT produced by any task. An empty array means every declared output is
 * task-reachable. Used to reject registrations whose declared output_shapes
 * are aspirational labels — e.g. an output_shapes_override that stamps a
 * scenario's expected shape while the tasks only emit `patch_proposal`.
 */
export function unreachableOutputShapes(template: Record<string, unknown>): string[] {
  const declared = Array.isArray(template["output_shapes"])
    ? (template["output_shapes"] as string[])
    : Array.isArray(template["outputShapes"]) ? (template["outputShapes"] as string[]) : [];
  if (declared.length === 0) return [];
  const produced = collectTaskProducedShapes(template);
  return declared.filter((s) => !produced.has(s));
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
    // V20 (2026-06-07): use a brace-depth-aware walker to extract the FIRST
    // balanced JSON object — the same primitive apply-proposal-as-patch uses
    // (commit d6ec0aa). The previous lastIndexOf approach failed when the LLM
    // emitted multi-block JSON or trailing commentary, leaving an unbalanced
    // slice that JSON.parse rejected → activity-api validator received the
    // raw string and 400'd with "Expected object, received string". The
    // walker handles markdown fences, leading prose, and multi-object tails.
    const raw = templateObj.replace(/^```(?:json)?\n?/i, "").trimStart();
    const startIdx = raw.indexOf("{");
    if (startIdx >= 0) {
      let depth = 0;
      let inStr = false;
      let escape = false;
      let endIdx = -1;
      for (let i = startIdx; i < raw.length; i++) {
        const ch = raw[i]!;
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (ch === "\\") { escape = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx > startIdx) {
        const candidate = raw.slice(startIdx, endIdx + 1);
        try { templateObj = JSON.parse(candidate); } catch { /* leave as string; API will 400 with clear error */ }
      }
    }
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
  // Compose-task normalization (2026-06-22): activities-as-resolvers. The pattern
  // drafter naturally emits a composing task as resolver:"activity" (or "compose")
  // with the target activity id in config.activity_id / subActivityId — but the
  // ias-executor engine reads task.resolver ITSELF as the activity to dispatch
  // (getTemplate(task.resolver) → dispatchCompose). Rewrite that form so resolver
  // holds the activity id, otherwise the composition fails to resolve "activity"
  // and NO genuine composition edge forms. This is the wire that turns a drafted
  // composition into real credit-carrying topology (producer→consumer edges).
  if (templateObj && typeof templateObj === "object") {
    const tasks = (templateObj as Record<string, unknown>)["tasks"];
    if (Array.isArray(tasks)) {
      for (const task of tasks as Record<string, unknown>[]) {
        const res = String(task["resolver"] ?? "");
        if (res === "activity" || res === "compose") {
          const cfg = (task["config"] ?? {}) as Record<string, unknown>;
          const id =
            task["subActivityId"] ?? task["sub_activity_id"] ??
            cfg["activity_id"] ?? cfg["activityId"] ?? cfg["sub_activity_id"] ?? cfg["template_id"];
          if (typeof id === "string" && id.length > 0) {
            task["resolver"] = id; // engine reads task.resolver as the activity id
          }
        }
      }
    }
  }
  // Default tags + category for substrate-authored variants when LLM omits them.
  // Activity-API requires AT LEAST ONE of tags (non-empty) or category, else 400.
  // Substrate-authored variants frequently miss tags; injecting a sentinel tag
  // keeps the variant-first repair loop unblocked without weakening the gate.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const hasTags = Array.isArray(t["tags"]) && (t["tags"] as unknown[]).length > 0;
    const hasCategory = typeof t["category"] === "string" && (t["category"] as string).length > 0;
    if (!hasTags && !hasCategory) {
      t["tags"] = ["substrate.variant.authored"];
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
        // Deterministically pin foreign LLM model ids to the canonical substrate
        // model. The drafter LLM (haiku) routinely emits non-substrate ids like
        // "gpt-4" / "gpt-4-turbo" in llm_completion_dispatch tasks despite prompt
        // instructions; the substrate's llm-resolver-vessel is Anthropic-backed,
        // so a foreign id makes the authored chain unexecutable. This mirrors the
        // gap drafter's enforceCanonicalAnalyzePrompt: enforce in code what the LLM
        // cannot be trusted to get right. Anything not already an anthropic/* id is
        // rewritten to the canonical default.
        if (String(tt["resolver"]) === "llm_completion_dispatch" && tt["config"] && typeof tt["config"] === "object") {
          const cfg = tt["config"] as Record<string, unknown>;
          const model = typeof cfg["model"] === "string" ? cfg["model"] : "";
          if (!model.startsWith("anthropic/")) {
            cfg["model"] = CANONICAL_LLM_MODEL;
          }
        }
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

  // NOTE: output_shapes_override is applied LATER (just before the POST), after
  // enforceCanonicalAnalyzePrompt has finalized each task's true outputShapes.
  // Stamping here — before the canonical analyze task is forced to emit
  // `patch_proposal` — let an override declare a shape no task produces (the
  // "aspirational label" mislabel). The relocated block is reachability-checked.

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
      // V25 (2026-06-09): enforce canonical analyze prompt on the analyze task BEFORE
      // resolver-allow-list validation. The LLM-A drafter regenerates TASK 3's prompt
      // freely (regardless of how tight the PROMPT_TEMPLATE schema-enforcement is),
      // producing variants whose LLM-B emits gap_analysis/recommendation/wrapper
      // schemas. This override forces TASK 3 back to the canonical patch_proposal
      // prompt so apply_proposal_as_patch can consume the output.
      await enforceCanonicalAnalyzePrompt(t);
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

  // ── output_shapes_override (relocated, reachability-checked) ──────────────
  // Forcibly override output shapes when the caller provides a valid array.
  // activity-api's CreateTemplateRequestSchema reads snake_case `output_shapes`
  // (Zod strips unknown keys, so camelCase alone is ignored). Runs HERE — after
  // enforceCanonicalAnalyzePrompt has set the canonical analyze task's true
  // output to `patch_proposal` — so the reachability check below sees final task
  // shapes. An override that names a shape no task produces is REJECTED rather
  // than silently stamped: this is the fix for the mislabel where a gap-closing
  // variant claimed to produce the scenario's expected shape while its tasks
  // only emit patch_proposal.
  if (pointer.output_shapes_override !== undefined && templateObj && typeof templateObj === "object") {
    let shapes: unknown = pointer.output_shapes_override;
    if (typeof shapes === "string") {
      try { shapes = JSON.parse(shapes); } catch { shapes = undefined; }
    }
    // Only apply if it's a non-empty array of strings (not an error object from a
    // failed upstream task) — otherwise the LLM-generated outputShapes stand.
    if (Array.isArray(shapes) && shapes.length > 0 && shapes.every((s) => typeof s === "string")) {
      const t = templateObj as Record<string, unknown>;
      const produced = collectTaskProducedShapes(t);
      const unreachable = (shapes as string[]).filter((s) => !produced.has(s));
      if (unreachable.length > 0) {
        return {
          shape: "structuredError",
          body: {
            resolver: "activity_create_variant",
            failure_mode: "output_shape_unreachable",
            detail:
              `output_shapes_override [${(shapes as string[]).join(", ")}] includes shape(s) ` +
              `not produced by any task: [${unreachable.join(", ")}]. A variant must declare ` +
              `only output shapes its tasks actually emit (produced: [${[...produced].join(", ") || "none"}]). ` +
              `If this activity proposes a code change, declare 'patch_proposal'; if it renders a ` +
              `surface, add a task whose outputShapes include the declared shape.`,
          },
        };
      }
      t["output_shapes"] = shapes;   // snake_case: read by Zod schema
      t["outputShapes"] = shapes;    // camelCase: kept for any non-Zod readers
    }
  }

  // ── Shape-reachability gate (general) ─────────────────────────────────────
  // Reject any substrate-authored variant whose declared output_shapes are not
  // all produced by some task — covers LLM-declared mislabels even when no
  // override is supplied. This generalizes permissive invariant I5 (which is
  // scoped to proposed_pattern_authored_* ids) to the gap-closing: path and any
  // proposed variant, closing the exemption that let mislabeled gap-closing
  // variants register. Operator seeds (proposed === false) are exempt — they may
  // legitimately declare shapes produced by a composed child template.
  if (templateObj && typeof templateObj === "object") {
    const t = templateObj as Record<string, unknown>;
    const tid = String(t["id"] ?? "");
    const isSubstrateAuthored =
      t["proposed"] !== false
      && (tid.startsWith("gap-closing:")
        || tid.startsWith("proposed_pattern_authored_")
        || pointer.output_shapes_override !== undefined
        || (pointer as unknown as Record<string, unknown>)["validate_gap_closing"] === true);
    if (isSubstrateAuthored) {
      const unreachable = unreachableOutputShapes(t);
      if (unreachable.length > 0) {
        return {
          shape: "structuredError",
          body: {
            resolver: "activity_create_variant",
            failure_mode: "output_shape_unreachable",
            detail:
              `declared output_shape(s) [${unreachable.join(", ")}] not produced by any task. ` +
              `Every declared output_shape must appear in at least one task's outputShapes list.`,
          },
        };
      }
    }
  }

  // ── Reuse-before-mint bias (ρ_grow↓, λ₁↑) ─────────────────────────────────
  // Before minting a fresh Beta(1,1) cell, ask discover-by-shapes whether an
  // existing activity already PRODUCES the declared output_shapes. If one does,
  // this mint is a near-duplicate: it raises ρ_grow (a new uninformed cell) and
  // splits selection traffic instead of concentrating it on — and forming a
  // composition edge to — the existing producer (which is what raises λ₁). The
  // master inequality λ₁(L) ≳ ρ_grow is helped on BOTH sides by reusing.
  //
  // EXEMPTION: variant-first repair (parentTemplateId set) legitimately mints a
  // variant to IMPROVE a weak family — never blocked here.
  // MODE gate — REUSE_BEFORE_MINT = off | shadow | enforce (DEFAULT enforce):
  //   off     → skip the probe entirely (always mint).
  //   shadow  → record the would-reuse decision, then mint as usual (observe only).
  //   enforce → refuse the duplicate mint and return the existing producer so the
  //             loop routes to it (a genuine composition edge) instead.
  // DEFAULT is `enforce` (2026-06-26): the foundational "Reuse Before Minting"
  // principle is ENFORCED at the mint chokepoint, not merely observed. The enforce
  // branch refuses ONLY when discover-by-shapes finds a CONFIDENT existing producer
  // of the declared output_shapes (producers.length > 0 after self-exclusion) — i.e.
  // a true near-duplicate. It is structurally incapable of starving legitimate
  // authoring because:
  //   (a) variant-first repair is exempt up front (pointer.parentTemplateId set →
  //       the whole block is skipped — a weak-family repair always mints);
  //   (b) a genuine GAP (no existing producer of the output shape) yields
  //       producers.length === 0, so the refuse branch never fires and the mint
  //       proceeds — minting stays the justified exception for true gaps;
  //   (c) the discover-by-shapes probe FAILS OPEN — any transport/parse hiccup
  //       proceeds to mint (never block capability creation on a flaky probe);
  //   (d) `off`/`shadow` remain explicit overrides for an operator who wants to
  //       observe or disable enforcement during an authoring burst.
  {
    const reuseMode = (process.env["REUSE_BEFORE_MINT"] ?? "enforce").toLowerCase();
    const declaredOut =
      templateObj && typeof templateObj === "object"
        ? (Array.isArray((templateObj as Record<string, unknown>)["output_shapes"])
            ? ((templateObj as Record<string, unknown>)["output_shapes"] as string[])
            : Array.isArray((templateObj as Record<string, unknown>)["outputShapes"])
              ? ((templateObj as Record<string, unknown>)["outputShapes"] as string[])
              : [])
        : [];
    const selfId =
      templateObj && typeof templateObj === "object"
        ? String((templateObj as Record<string, unknown>)["id"] ?? "")
        : "";
    // Detect whether the proposed template is a signature-parameterized detector:
    // any task whose resolver type is "signature_cluster_scan" binds a distinct
    // target_signature, making output_shapes an insufficient dedup key.
    const templateTasks: Array<Record<string, unknown>> =
      templateObj && typeof templateObj === "object" &&
      Array.isArray((templateObj as Record<string, unknown>)["tasks"])
        ? ((templateObj as Record<string, unknown>)["tasks"] as Array<Record<string, unknown>>)
        : [];
    const sigScanTask = templateTasks.find(
      (t) => String(t["type"] ?? t["resolver"] ?? "") === "signature_cluster_scan",
    );
    const boundTargetSignature: string | null = sigScanTask
      ? String(sigScanTask["target_signature"] ?? sigScanTask["targetSignature"] ?? "")
      : null;
    const isSignatureParameterized = boundTargetSignature !== null && boundTargetSignature !== "";
    // V32 (2026-06-27): producer reuse should only be enforced if there are
    // capability-identifying declared output shapes, filtering out generic I/O
    // and verification results (like "patch_proposal", "fs_write_result"). If
    // a template only declares generic shapes, it's not a *new capability* to
    // be de-duplicated.
    const GENERIC_IO_SHAPES = new Set<string>([
      "patch_proposal",
      "fileContent",
      "fs_read_result",
      "fileWriteResult",
      "fileEditResult",
      "codeTypecheckResult",
      "http_fetch_response",
      "taskOutputExtraction",
      "llm_completion_output",
      "noop_result",
      // Verification results from analysis-vessel tasks
      "gapAnalysis",
      "testRunResult",
      "pattern_metadata",
    ]);
    const capabilityIdentifyingDeclaredOut = declaredOut.filter(shapeName => !GENERIC_IO_SHAPES.has(shapeName));

    if (
      reuseMode !== "off" &&
      !pointer.parentTemplateId &&
      // Only require capability-identifying shapes when *not* a signature-parameterized detector.
      // Signature-parameterized detectors are themselves distinct capabilities.
      (isSignatureParameterized
        ? declaredOut.length > 0
        : capabilityIdentifyingDeclaredOut.length > 0) &&
      !isSignatureParameterized
    ) {
      try {
        // To find PRODUCERS of an output shape, discover-by-shapes wants the
        // shapes in `required_shapes` with mode `candidates_with_scores` (which
        // it treats as FORWARD: `output_shapes CONTAINSANY $required_shapes`).
        // Passing `output_shapes` instead returns nothing — that field is only a
        // secondary filter in backward mode (the latent bug in producer-selection.ts).
        // The result list is under the `activities` key.
        const dres = await fetch(`${METABOB_ENDPOINT}/v2/activities/discover-by-shapes`, {
          method: "POST",
          headers: { Authorization: `ApiKey ${METABOB_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "candidates_with_scores", required_shapes: declaredOut }),
          signal: AbortSignal.timeout(8000),
        });
        if (dres.ok) {
          const dj = (await dres.json()) as {
            activities?: Array<Record<string, unknown>>;
            producers?: Array<Record<string, unknown>>;
            candidates?: Array<Record<string, unknown>>;
          };
          const idOf = (c: Record<string, unknown>) =>
            String(c["activity_id"] ?? c["template_id"] ?? c["id"] ?? "");
      // Signature-parameterized detector exemption: when the proposed template
    // binds signature_cluster_scan with a distinct target_signature, the
    // output_shapes-only dedup key is insufficient — each target_signature
    // constitutes a justified variant-first mint. Log as shadow (never refuse).
    if (isSignatureParameterized && reuseMode !== "off") {
      console.log(
        `[activity-create-variant] shadow: signature-parameterized detector exempted from REUSE_BEFORE_MINT ` +
        `(target_signature=${boundTargetSignature}, output_shapes=${JSON.stringify(declaredOut)})`,
      );
    }
        // Normalize for self-comparison: strip the `activity:⟨…⟩` record-id
          // wrapper AND the strip_id `-<timestamp>` suffix, so an idempotent
          // self-re-registration (proposed id == producer id, just wrapped) and
          // the proposal's own timestamped twin are both recognized as SELF and
          // excluded — only GENUINELY distinct producers count as near-dups.
          const norm = (x: string) =>
            x.replace(/^activity:⟨/, "").replace(/⟩$/, "").replace(/-\d{10,}$/, "");
          const selfNorm = norm(selfId);
          const producers = (dj.activities ?? dj.producers ?? dj.candidates ?? []).filter((c) => {
            const id = idOf(c);
            if (!id || c["deprecated"] === true) return false;
            return selfNorm === "" || norm(id) !== selfNorm;
          });
          if (producers.length > 0) {
            const candidateIds = producers.slice(0, 5).map(idOf);
            // eslint-disable-next-line no-console
            console.log(
              `[reuse-before-mint] mode=${reuseMode} existing producer(s) for output_shapes=[${declaredOut.join(",")}] ` +
                `→ ${candidateIds.join(", ")} (n=${producers.length}); proposed=${selfId}`,
            );
            if (reuseMode === "enforce") {
              return {
                shape: "structuredError",
                body: {
                  resolver: "activity_create_variant",
                  failure_mode: "reuse_existing_producer",
                  emergence_class: "reuse",
                  reused: true,
                  minted: false,
                  existing_producer_id: candidateIds[0],
                  candidate_producers: candidateIds,
                  output_shapes: declaredOut,
                  detail:
                    `refused duplicate mint: ${producers.length} existing producer(s) of [${declaredOut.join(", ")}] ` +
                    `already in the registry — route to ${candidateIds[0]} (composition edge) instead of minting a new Beta(1,1) cell.`,
                },
              };
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[reuse-before-mint] discover-by-shapes probe failed; proceeding to mint: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
