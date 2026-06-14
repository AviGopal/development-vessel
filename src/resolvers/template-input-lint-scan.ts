import type { ResolverResult } from "./types.js";
import { SEED_TEMPLATES } from "../seed/index.js";

/**
 * template_input_lint_scan — deterministic detector for templates that declare
 * inputShapes / variables NO task consumes.
 *
 * Meta-detector for the bug class that left draft-activity-from-pattern dead:
 * it declared inputShapes:["recurringPatternCluster"] + a pattern_cluster_id
 * variable, but no task ever loaded the cluster — so the authoring ran blind
 * for weeks. That mis-wire is invisible to execution (the template "succeeds")
 * yet structurally broken. This resolver makes it substrate-detectable.
 *
 * Source = the dev-vessel's own in-process SEED_TEMPLATES registry, NOT the
 * activity-api list. The list is hard-capped at 100 and flooded by thousands of
 * transient gap-closing authored variants (which systematically mis-declare —
 * that is one bug in the gap drafter, not N), so linting it would drown the
 * real signal and spam the gap queue. SEED_TEMPLATES is the canonical,
 * load-bearing set — exactly where the cluster-load class lives. Each offending
 * template gets one substrateGap_write (gap_subtype=template_declares_unused_input)
 * routed into the gap → bridge → drafter loop so the next instance self-completes.
 *
 * Mirrors stale_pointer_emit / phantom_trace_scan: one server-side resolver,
 * deterministic filter, conditional emit-per-finding, no LLM.
 */

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

export interface TemplateInputLintScanPointer {
  type: "template_input_lint_scan";
  /** Override dev-vessel impulses URL (self-POST). Default: http://127.0.0.1:8090/v2/impulses/resolve */
  devVesselImpulsesUrl?: string;
  /** Optional further id filter (regex). Default: lint all SEED_TEMPLATES. */
  idPattern?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 25. */
  maxEmits?: number;
  /** Test hook: lint this template set instead of SEED_TEMPLATES. */
  _templates?: TemplateLike[];
}

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_MAX_EMITS = 25;

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

/** All text a task could reference a variable/shape through: config + prompt, stringified. */
function taskReferenceBlob(task: TaskLike): string {
  let blob = "";
  try { blob += JSON.stringify(task.config ?? ""); } catch { /* ignore */ }
  try { blob += JSON.stringify(task.prompt ?? ""); } catch { /* ignore */ }
  return blob;
}

export async function resolveTemplateInputLintScan(
  pointer: TemplateInputLintScanPointer,
): Promise<ResolverResult> {
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  let idRe: RegExp | null = null;
  if (pointer.idPattern) {
    try { idRe = new RegExp(pointer.idPattern); } catch { idRe = null; }
  }

  const apiKey = process.env["METABOB_API_KEY"];
  const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};

  const templates: TemplateLike[] = pointer._templates ?? (SEED_TEMPLATES as unknown as TemplateLike[]);

  // Lint each template for declared inputShapes/variables no task consumes.
  const findings: LintFinding[] = [];
  let scanned = 0;
  let inScope = 0;
  for (const t of templates) {
    scanned += 1;
    const id = typeof t.id === "string" ? t.id : "";
    if (idRe && !idRe.test(id)) continue;
    inScope += 1;

    const declaredInputs = [...asStringArray(t.inputShapes), ...asStringArray(t.input_shapes)];
    const declaredVars = Array.isArray(t.variables)
      ? (t.variables as Array<{ name?: unknown }>).map((v) => (typeof v?.name === "string" ? v.name : "")).filter(Boolean)
      : [];
    if (declaredInputs.length === 0 && declaredVars.length === 0) continue;

    const tasks = Array.isArray(t.tasks) ? (t.tasks as TaskLike[]) : [];
    const consumedShapes = new Set<string>();
    const consumedConfigKeys = new Set<string>();
    let allRefs = "";
    for (const task of tasks) {
      for (const s of [...asStringArray(task.inputShapes), ...asStringArray(task.input_shapes)]) consumedShapes.add(s);
      // goal-host builds the resolver pointer as {type, ...variables, ...config},
      // so a variable is also consumed when a task config carries a key of the
      // same name (the spread-into-pointer-field path) — not only via {{name}}.
      if (task.config && typeof task.config === "object") {
        for (const k of Object.keys(task.config as Record<string, unknown>)) consumedConfigKeys.add(k);
      }
      allRefs += taskReferenceBlob(task);
    }

    // An inputShape is flagged when no task declares it as a task inputShape AND
    // it never appears as a {{shape}} reference. NOTE: this is a HEURISTIC, not a
    // proof — an input can still be consumed via context.inputImpulses / slot-
    // binding (pool-seeding), which is invisible to a static scan. We deliberately
    // do NOT exclude KNOWN_SEEDABLE_SHAPES here: the cluster-load bug's input
    // (recurringPatternCluster) IS seedable yet was still never bound by the
    // autonomous path, so excluding seedable shapes would mask the exact class.
    // The gap is marked confidence=heuristic so a consumer verifies before acting;
    // the runtime-sound version (input declared but never bound across recent
    // executions) is the follow-up.
    const unusedInputs = declaredInputs.filter(
      (s) => !consumedShapes.has(s) && !allRefs.includes(`{{${s}`),
    );
    // A variable is unused if {{name}} never appears AND no task config carries a
    // key of that name (the goal-host variable-spread consumption path).
    const unusedVars = declaredVars.filter(
      (name) => !allRefs.includes(`{{${name}`) && !consumedConfigKeys.has(name),
    );

    if (unusedInputs.length === 0 && unusedVars.length === 0) continue;
    findings.push({
      template_id: id || `unknown-${findings.length}`,
      unused_input_shapes: unusedInputs,
      unused_variables: unusedVars,
      gap_id: `template-input-lint-${(id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      posted: false,
    });
    if (findings.length >= maxEmits) break;
  }

  // Emit one substrateGap per offending template (unless dry_run).
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
                `Seed template ${f.template_id} declares input(s)/variable(s) no task consumes ` +
                `[shapes: ${f.unused_input_shapes.join(", ") || "none"}; vars: ${f.unused_variables.join(", ") || "none"}] ` +
                `— a silent mis-wire (the class that left draft-activity-from-pattern dead).`,
              detected_at: new Date().toISOString(),
              status: "open",
              classification_metadata: {
                gap_subtype: "template_declares_unused_input",
                confidence: "heuristic",
                detection: "static_scan",
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
