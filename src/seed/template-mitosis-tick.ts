import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * template-mitosis-tick — autonomous template improvement loop.
 *
 * Audits weak templates via template_audit_report, picks the weakest
 * family, fetches its source, drafts an improved variant via
 * llm_completion_dispatch, and registers the variant through
 * activity_create_variant (write-scope).
 *
 * Variant-first repair discipline (per development-vessel/CLAUDE.md
 * "Variant-first repair (RBAC consequence)"): the substrate vessel
 * holds write-scope, NOT admin-scope. It CAN mint variants. It CANNOT
 * call activityTemplate_update or activityTemplate_deprecate (those
 * 403). Promotion happens implicitly: Thompson Sampling selects the
 * better variant over time, and the weaker parent's posterior decays
 * as samples accumulate on its successor.
 *
 * This loop's job: keep MINTING better variants when weakness is
 * detected. Admin-side promotion/deprecation is operator-gated by
 * design; the substrate's contribution is the supply of candidates.
 *
 * Parallel in shape to mitosis-tick (which evaluates vessel source
 * mitoses) but operating on template source.
 *
 * Chain:
 *   1. audit            templateAuditReport (weakest families)
 *   2. pick_weak        weak_templates[0].template_id
 *   3. fetch_source     full template JSON from activity-api
 *   4. author_variant   LLM drafts improved variant JSON
 *   5. create_variant   activity_create_variant POST (write-scope)
 *
 * Immunity-pattern: deterministic resolvers around one LLM call. The
 * activity_create_variant resolver applies its own permissive-scope
 * invariants (I1..I6) so bad LLM output gets rejected at registration
 * rather than running.
 */

export const TEMPLATE_MITOSIS_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:template-mitosis-tick",
  name: "template-mitosis-tick",
  description:
    "Autonomous template improvement: audits weak families via template_audit_report (Thompson " +
    "posterior mean < threshold AND samples >= minimum), picks the weakest, fetches the parent " +
    "template, LLM-drafts an improved variant, registers via activity_create_variant (write-scope). " +
    "Thompson sampling promotes the better variant naturally; this loop's contribution is the " +
    "supply of candidates. Variant-first repair — never calls activityTemplate_update/_deprecate.",
  inputShapes: [],
  outputShapes: ["activityRegistryChange", "templateAuditReport", "structuredError"],
  tags: [
    "intent:template_improvement",
    "phase:author",
    "lift.autonomous.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "audit",
      description:
        "Scan activity-api templates and rank by Thompson posterior mean α/(α+β). Emit a " +
        "templateAuditReport with weak_templates sorted ascending. Threshold 0.3, minimum 10 " +
        "executed samples. Skips proposed and deprecated rows.",
      resolver: "template_audit_report",
      config: {
        type: "template_audit_report",
        limit: 500,
        weakThreshold: 0.3,
        minSamples: 10,
        emitCap: 20,
      },
      outputShapes: ["templateAuditReport"],
    },
    {
      id: "pick_weak",
      description:
        "Extract weak_templates[0].template_id — the template family with the lowest posterior " +
        "mean that still has enough samples to be statistically meaningful. When the audit " +
        "report is empty (no weak families), this task returns the missing-value sentinel and " +
        "the downstream LLM/create steps fail loudly via the create_variant invariants.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{audit_content}}",
        path: "weak_templates.0.template_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "fetch_source",
      description:
        "Fetch the chosen template's full JSON so the LLM has the exact prior to mutate. " +
        "Reads activity-api /v2/activities/templates with a query filter; the single-row " +
        "response feeds the author_variant task as the parent context.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8080/v2/activities/templates?limit=1&id={{pick_weak_content}}",
        method: "GET",
      },
      outputShapes: ["httpResponse"],
    },
    {
      id: "author_variant",
      description:
        "LLM authors an improved variant. Receives the parent template JSON; outputs a single " +
        "JSON object representing the new variant — same input_shapes/output_shapes contract, " +
        "with a refined task graph that addresses likely failure modes (timeouts, brittle " +
        "interpolation, missing guards, redundant LLM calls). Stripped to first {...} by " +
        "activity_create_variant before registration.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Parent template (currently underperforming per Thompson posterior):\n" +
          "{{fetch_source_content}}\n\n" +
          "This template's success rate is below 0.3 across 10+ executions. Author an IMPROVED " +
          "variant template JSON. HARD requirements (activity-api rejects otherwise):\n" +
          "- Top-level fields: id, name, description, input_shapes, output_shapes, tasks, tags.\n" +
          "- tags MUST be a non-empty array of dot-separated strings (e.g. " +
          "[\"substrate.variant\", \"variant.authored.template-mitosis\"]). Without tags or " +
          "category, registration fails with 400.\n" +
          "- description MUST be >= 40 chars.\n" +
          "- Preserve input_shapes and output_shapes exactly.\n" +
          "- Preserve the template name; the id will be auto-suffixed with a timestamp.\n" +
          "- Address probable failure modes: missing input guards, brittle interpolation, " +
          "redundant LLM calls, untimed http_fetch, unbounded retries.\n" +
          "- Prefer deterministic resolvers (fs_read, http_fetch, json_path_extract) over LLM " +
          "where the transformation is mechanical.\n" +
          "- Every task description must be >=40 chars and non-trivial.\n" +
          "- Each declared output_shape must be produced by at least one task " +
          "(task.outputShapes must include it).\n" +
          "Output ONLY the new template JSON object (no narration, no code fences, no commentary).",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 4000,
      },
      outputShapes: ["llm_completion_result"],
    },
    {
      id: "create_variant",
      description:
        "Register the LLM-authored variant via activity_create_variant. The resolver enforces " +
        "permissive-scope invariants (I1..I6) before POSTing so malformed templates are rejected " +
        "at registration, not at execution. parent_template_id links the variant to its source " +
        "for genealogy; strip_id forces a fresh timestamp-suffixed id to prevent silent no-ops.",
      resolver: "activity_create_variant",
      config: {
        type: "activity_create_variant",
        template: "{{author_variant_text}}",
        parentTemplateId: "{{pick_weak_content}}",
        strip_id: true,
      },
      outputShapes: ["activityRegistryChange", "structuredError"],
    },
  ],
};
