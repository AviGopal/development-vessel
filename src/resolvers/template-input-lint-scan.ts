import type { ResolverResult } from "./types.js";

/**
 * template_input_lint_scan — deterministic detector for templates that declare
 * inputShapes / variables NO task consumes.
 *
 * Meta-detector for the bug class that left draft-activity-from-pattern dead:
 * the template declared inputShapes:["recurringPatternCluster"] + a
 * pattern_cluster_id variable, but no task ever loaded the cluster — so the
 * authoring ran blind. That mis-wire is invisible to execution (the template
 * "succeeds") yet structurally broken. This resolver makes it substrate-
 * detectable: fetch the registry, and for each template flag any declared
 * inputShape with no task inputShape consumer, or any declared variable whose
 * {{name}} (or {{name_suffix}}) never appears in a task's config/prompt. One
 * substrateGap_write per offending template routes the fix into the
 * gap → bridge → drafter loop.
 *
 * Why one resolver (mirrors stale_pointer_emit / phantom_trace_scan): the
 * filter is trivially deterministic and conditional-emit-per-finding; iteration
 * adds no value and would emit a gap for clean templates.
 */

export interface TemplateInputLintScanPointer {
  type: "template_input_lint_scan";
  /** Override activity-api templates URL. Default: .../v2/activities/templates?limit=300 */
  templatesUrl?: string;
  /** Override dev-vessel impulses URL (self-POST). Default: http://127.0.0.1:8090/v2/impulses/resolve */
  devVesselImpulsesUrl?: string;
  /** Only lint templates whose id matches this regex. Default: substrate-authored + dev-vessel. */
  idPattern?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 25. */
  maxEmits?: number;
}

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates?limit=300";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_ID_PATTERN = "gap-closing|proposed_pattern_authored|^development-vessel:|^activity:.development-vessel";
const DEFAULT_MAX_EMITS = 25;

interface TaskLike {
  inputShapes?: unknown;
  input_shapes?: unknown;
  config?: unknown;
  prompt?: unknown;
}
interface TemplateLike {
  id?: unknown;
  inputShapes?: unknown;
  input_shapes?: unknown;
  variables?: unknown;
  tasks?: unknown;
}
interface LintFinding {
  template_id: string;
  unused_input_shapes: string[];
  unused_variables: string[];
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** All text a task could reference a variable/shape through: its config + prompt, stringified. */
function taskReferenceBlob(task: TaskLike): string {
  let blob = "";
  try { blob += JSON.stringify(task.config ?? ""); } catch { /* ignore */ }
  try { blob += JSON.stringify(task.prompt ?? ""); } catch { /* ignore */ }
  return blob;
}

export async function resolveTemplateInputLintScan(
  pointer: TemplateInputLintScanPointer,
): Promise<ResolverResult> {
  const templatesUrl = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  let idRe: RegExp;
  try { idRe = new RegExp(pointer.idPattern ?? DEFAULT_ID_PATTERN); }
  catch { idRe = new RegExp(DEFAULT_ID_PATTERN); }

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  // 1. Fetch the template registry.
  let templates: TemplateLike[] = [];
  try {
    const resp = await fetch(templatesUrl, { method: "GET", headers: { ...authHeader }, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      return { shape: "structuredError", body: { resolver: "template_input_lint_scan", detail: `templates fetch returned ${resp.status}` } };
    }
    const json = (await resp.json()) as { templates?: unknown; data?: unknown; items?: unknown };
    const arr = json.templates ?? json.data ?? json.items;
    if (Array.isArray(arr)) templates = arr as TemplateLike[];
  } catch (err) {
    return { shape: "structuredError", body: { resolver: "template_input_lint_scan", detail: `templates fetch failed: ${(err as Error).message}` } };
  }

  // 2. Lint each in-scope template for unused declared inputs/variables.
  const findings: LintFinding[] = [];
  let scanned = 0;
  let inScope = 0;
  for (const t of templates) {
    scanned += 1;
    const id = typeof t.id === "string" ? t.id : "";
    if (!id || !idRe.test(id)) continue;
    inScope += 1;

    const declaredInputs = [...asStringArray(t.inputShapes), ...asStringArray(t.input_shapes)];
    const declaredVars = Array.isArray(t.variables)
      ? (t.variables as Array<{ name?: unknown }>).map((v) => (typeof v?.name === "string" ? v.name : "")).filter(Boolean)
      : [];
    if (declaredInputs.length === 0 && declaredVars.length === 0) continue;

    const tasks = Array.isArray(t.tasks) ? (t.tasks as TaskLike[]) : [];
    const consumedShapes = new Set<string>();
    let allRefs = "";
    for (const task of tasks) {
      for (const s of [...asStringArray(task.inputShapes), ...asStringArray(task.input_shapes)]) consumedShapes.add(s);
      allRefs += taskReferenceBlob(task);
    }

    // An inputShape is unused if no task declares it as a task inputShape AND it
    // never appears as a {{shape}} reference anywhere in a task's config/prompt.
    const unusedInputs = declaredInputs.filter(
      (s) => !consumedShapes.has(s) && !allRefs.includes(`{{${s}`),
    );
    // A variable is unused if neither {{name}} nor {{name_<suffix>}} appears.
    const unusedVars = declaredVars.filter((name) => !allRefs.includes(`{{${name}`));

    if (unusedInputs.length === 0 && unusedVars.length === 0) continue;
    findings.push({
      template_id: id,
      unused_input_shapes: unusedInputs,
      unused_variables: unusedVars,
      gap_id: `template-input-lint-${id.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      posted: false,
    });
    if (findings.length >= maxEmits) break;
  }

  // 3. Emit one substrateGap per offending template (unless dry_run).
  if (!dryRun) {
    for (const f of findings) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: f.gap_id,
              category: "activity_lifecycle",
              source: "substrate_detected",
              summary:
                `Template ${f.template_id} declares input(s)/variable(s) no task consumes ` +
                `[shapes: ${f.unused_input_shapes.join(", ") || "none"}; vars: ${f.unused_variables.join(", ") || "none"}] ` +
                `— a silent mis-wire (the bug class that left draft-activity-from-pattern dead).`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "template_declares_unused_input",
                template_id: f.template_id,
                unused_input_shapes: f.unused_input_shapes,
                unused_variables: f.unused_variables,
                remediation_hint:
                  "Add a task that consumes the declared input (e.g. an fs_read/http_fetch that loads it), " +
                  "OR drop the unused declaration. Mirrors the draft-activity-from-pattern load_cluster fix.",
              },
            },
          },
        },
      };
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        f.post_status = resp.status;
        f.posted = resp.ok;
      } catch {
        f.post_status = "error";
      }
    }
  }

  return {
    shape: "templateInputLintReport",
    body: {
      scanned,
      in_scope: inScope,
      finding_count: findings.length,
      findings,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
