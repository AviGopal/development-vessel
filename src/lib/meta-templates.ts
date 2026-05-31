/**
 * Shared meta-template identification — used by detection resolvers
 * (phantom_trace_scan, trace_failure_pattern_report) and observability
 * resolvers (coverage_tick, substrate_health_tick).
 *
 * "Meta-templates" are framework-level activity wrappers whose traces
 * legitimately have task_count=0 because they coordinate other executions
 * rather than running tasks themselves. Detection resolvers must exclude
 * them to avoid emitting false-positive substrateGap impulses; coverage
 * resolvers exclude them to keep the substrate's learned-shapes signal
 * substantive rather than gameable by routing-trace volume.
 *
 * Discovered duplication (2026-05-31): the same exclusion list lived in
 * three resolver files with slightly different shapes (Set vs array,
 * Pattern.includes vs Set.has, normalized-id vs raw-id). Centralized here
 * so the next detection resolver doesn't carry a fourth copy.
 *
 * Adding a new meta-template: add it to META_TEMPLATE_IDS below. All
 * consumers automatically inherit the addition.
 */

/**
 * Bare template ids (without `activity:⟨...⟩` wrapper) of framework-level
 * routing activities that legitimately have task_count=0.
 */
export const META_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "validator-dispatch",
  "slot-binding",
  "create-shape-provider-goal",
]);

/**
 * Strip the SurrealDB record-ref wrapper `activity:⟨X⟩` to recover bare id `X`.
 * Trace activity_ids appear in both forms in the wild — bare for some
 * meta-templates, wrapped for most user templates.
 */
export function normalizeTemplateId(rawId: string | undefined | null): string {
  if (!rawId) return "";
  return rawId.replace(/^activity:⟨(.+)⟩$/, "$1");
}

/**
 * True if the template id (raw or wrapped) is a meta-template that legitimately
 * has task_count=0. Detection resolvers should skip these to avoid emitting
 * false-positive gaps.
 */
export function isMetaTemplate(templateId: string | undefined | null): boolean {
  if (!templateId) return false;
  const clean = normalizeTemplateId(templateId);
  if (META_TEMPLATE_IDS.has(clean)) return true;
  // Also catch substring-style references (e.g. "activity:⟨validator-dispatch⟩"
  // forms that escape the normalizeTemplateId regex due to nested wrappers).
  for (const meta of META_TEMPLATE_IDS) {
    if (clean.includes(meta)) return true;
  }
  return false;
}
