import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveActivityFetch } from "./activity-fetch.js";
import { resolveActivityCreateVariant } from "./activity-create-variant.js";
import type { ResolverResult } from "./types.js";

/**
 * template_repair — the ACTIVITY analogue of code repair (2026-07-02).
 *
 * Vessels are maintained by editing bytes (feature_compose). ACTIVITIES are
 * maintained by minting VARIANTS — the idiomatic loop the Thompson/ribosome
 * machinery was built for. This resolver is `specFromGap` + `feature_compose`
 * for a template: given a flaky/weak activity id, it grounds a repair spec from
 * the template JSON + its recent FAILURE traces and mints a corrected variant
 * candidate (variant-first repair). Because a whole template fits verbatim in
 * the spec, the byte-exact-`old_string` ceiling that blocks code repair does
 * NOT apply here.
 *
 * It only MINTS the candidate. Promotion is the EXISTING Thompson evidence gate
 * (`variant_promote`, ≥0.15 posterior dominance over ≥10 samples), substrate-
 * operated — this resolver never calls it. It does not probe-execute in v1.
 */
export interface TemplateRepairPointer {
  type: "template_repair";
  /** Target activity template id. Accepts `activity:⟨…⟩` wrapped or bare form. */
  activity_id?: string;
  /** Alias for activity_id. */
  template_id?: string;
  /** How many recent FAILURE traces to ground on. Default: 5. */
  failure_window?: number;
  /** When true, ground + return the spec + failure summary but DO NOT mint. */
  dry_run?: boolean;
}

interface FailureSummary {
  execution_id: string;
  failed_task_id: string | null;
  failure_mode_type: string | null;
  resolver_tier: string | null;
  reason: string | null;
}

interface TraceTask {
  task_id?: string;
  id?: string;
  success?: boolean;
  resolver_tier?: string;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  tasks?: TraceTask[];
  failure_mode?: { type?: string; reason?: string } | null;
}

/**
 * Normalise an activity id by stripping the `activity:⟨…⟩` record-id wrapper to
 * its bare form. Mirrors goal-host's `normActivityId` (index.ts:1029-1033) and
 * trace-failure-pattern-report's `stripActivityWrap` — do NOT invent a new
 * scheme. Handles both the `activity:⟨…⟩` and bare-`activity:` prefixes.
 */
export function normalizeActivityId(raw: string): string {
  return raw.replace(/^activity:/, "").replace(/[⟨⟩]/g, "").trim();
}

/**
 * Summarise a failure trace into the compact block the grounded spec carries.
 * The first non-successful task is treated as the failing task.
 */
function summarizeTrace(tr: ExecutionTrace): FailureSummary {
  const tasks = tr.tasks ?? [];
  const failed = tasks.find((t) => t.success !== true);
  return {
    execution_id: String(tr.id ?? ""),
    failed_task_id: failed ? String(failed.task_id ?? failed.id ?? "") || null : null,
    failure_mode_type: tr.failure_mode?.type ?? null,
    resolver_tier: failed?.resolver_tier ?? null,
    reason: tr.failure_mode?.reason ?? null,
  };
}

/**
 * Build the repair spec string (the activity analogue of specFromGap). Kept
 * TIGHT — a short instruction + the template JSON verbatim + a compact failure
 * block + the closing correction instruction. The composer-input-tightness
 * lesson applies: the whole template fits verbatim, so ground on it directly.
 */
export function buildRepairSpec(
  templateJson: unknown,
  failures: FailureSummary[],
): string {
  const templatePretty = JSON.stringify(templateJson, null, 2);
  const failureBlock =
    failures.length === 0
      ? "No FAILURE traces in the window — repair on template-audit grounds (the template may be weak by audit, not by trace)."
      : failures
          .map(
            (f) =>
              `- execution ${f.execution_id}: task ${f.failed_task_id ?? "(unknown)"} failed` +
              ` (mode: ${f.failure_mode_type ?? "unknown"}, tier: ${f.resolver_tier ?? "unknown"})` +
              (f.reason ? `: ${f.reason}` : ""),
          )
          .join("\n");
  return (
    "Repair the flaky/weak activity template below.\n\n" +
    "TEMPLATE (verbatim JSON):\n" +
    templatePretty +
    "\n\nRECENT FAILURES (grounding evidence):\n" +
    failureBlock +
    "\n\nMint a corrected variant that fixes the failure pattern above while " +
    "preserving the template's input/output shape contract."
  );
}

/**
 * Fetch the last `window` FAILURE traces for a template via the execution-traces
 * endpoint this repo already uses (see trace-failure-pattern-report.ts). Filters
 * to `success=false` and keeps only traces whose `failure_mode` is populated.
 * Returns [] (never throws) on transport error — the caller proceeds on the
 * template alone.
 */
async function fetchFailureTraces(bareId: string, window: number): Promise<FailureSummary[]> {
  // activity-api may store activity_id in either the bare form or the
  // `activity:⟨…⟩` record-id wrapped form. Try the bare id first; if it yields
  // nothing, retry the wrapped form so grounding does not silently miss real
  // failures on account of the storage convention.
  const forms = [bareId, `activity:⟨${bareId}⟩`];
  for (const form of forms) {
    try {
      const url =
        `${METABOB_ENDPOINT}/v2/activities/execution-traces` +
        `?activity_id=${encodeURIComponent(form)}&success=false&limit=${window}`;
      const res = await fetch(url, { headers: { Authorization: `ApiKey ${METABOB_API_KEY}` } });
      if (!res.ok) continue;
      const data = (await res.json()) as { executions?: ExecutionTrace[] };
      const traces = (data.executions ?? []).filter((tr) => tr.failure_mode && tr.failure_mode.type);
      if (traces.length > 0) return traces.slice(0, window).map(summarizeTrace);
    } catch {
      // try next form
    }
  }
  return [];
}

export async function resolveTemplateRepair(pointer: TemplateRepairPointer): Promise<ResolverResult> {
  const rawId = pointer.activity_id ?? pointer.template_id ?? "";
  if (!rawId) {
    return {
      shape: "templateRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        based_on_failures: [],
        grounded_spec: "",
        summary: "no activity_id (or template_id) supplied",
        error: "activity_id required",
      },
    };
  }
  const bareId = normalizeActivityId(rawId);
  const window = typeof pointer.failure_window === "number" && pointer.failure_window > 0
    ? Math.floor(pointer.failure_window)
    : 5;
  const dryRun = pointer.dry_run === true;

  // Step 2 — fetch the template JSON (REUSE the activity_fetch helper).
  const fetched = await resolveActivityFetch({ type: "activity_fetch", templateId: bareId });
  if (fetched.shape !== "activity_template") {
    return {
      shape: "templateRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        based_on_failures: [],
        grounded_spec: "",
        summary: `could not fetch template for '${bareId}'`,
        error: `template not found: ${bareId}`,
      },
    };
  }
  const templateJson = fetched.body;

  // Step 3 — fetch recent FAILURE traces for this template.
  const failures = await fetchFailureTraces(bareId, window);

  // Step 4 — ground the repair spec (template verbatim + failure summary).
  const groundedSpec = buildRepairSpec(templateJson, failures);

  // Dry-run: ground only, do NOT mint.
  if (dryRun) {
    return {
      shape: "templateRepairReport",
      body: {
        verdict: "FAVORABLE",
        based_on_failures: failures,
        grounded_spec: groundedSpec,
        summary:
          `dry-run: grounded repair spec for '${bareId}' from ${failures.length} failure trace(s); ` +
          `no variant minted`,
      },
    };
  }

  // Step 5 — mint the corrected variant via the EXISTING create_variant resolver
  // (in-process). Variant-first repair: pass parentTemplateId so it is exempt
  // from the reuse-before-mint gate, and strip_id so activity-api assigns a
  // fresh id. The grounded repair spec rides along as guidance metadata + is
  // appended to the description so the candidate carries its repair intent.
  const baseTemplate =
    templateJson && typeof templateJson === "object"
      ? { ...(templateJson as Record<string, unknown>) }
      : { id: bareId };
  const baseDesc = String((baseTemplate as Record<string, unknown>)["description"] ?? "");
  (baseTemplate as Record<string, unknown>)["description"] =
    `${baseDesc}\n\n[template_repair candidate] ${groundedSpec}`.slice(0, 4000);
  (baseTemplate as Record<string, unknown>)["repair_guidance"] = groundedSpec;

  // activity-api LegacyCategorySchema rejects other values (invalid_enum_value 400, e.g. "lift"); create-variant defaults tags/category when absent.
  if (typeof (baseTemplate as Record<string, unknown>)["category"] === "string" && !["feature","bugfix","refactor","tool","infrastructure","meta","system","security"].includes((baseTemplate as Record<string, unknown>)["category"] as string)) {
    delete (baseTemplate as Record<string, unknown>)["category"];
  }
  // TODO: probe under reach-gate — a follow-up would execute the minted variant
  // through the goal-reach gate before returning FAVORABLE.
  const minted = await resolveActivityCreateVariant({
    type: "activity_create_variant",
    template: baseTemplate,
    parentTemplateId: bareId,
    strip_id: true,
  });

  if (minted.shape === "structuredError") {
    return {
      shape: "templateRepairReport",
      body: {
        verdict: "UNFAVORABLE",
        based_on_failures: failures,
        grounded_spec: groundedSpec,
        summary: `failed to mint variant for '${bareId}'`,
        error:
          (minted.body && typeof minted.body === "object"
            ? String((minted.body as Record<string, unknown>)["detail"] ?? JSON.stringify(minted.body))
            : String(minted.body)),
      },
    };
  }

  const variantId =
    minted.body && typeof minted.body === "object"
      ? String((minted.body as Record<string, unknown>)["variantId"] ?? "")
      : "";

  return {
    shape: "templateRepairReport",
    body: {
      verdict: "FAVORABLE",
      variant_id: variantId,
      based_on_failures: failures,
      grounded_spec: groundedSpec,
      summary:
        `minted corrected variant '${variantId}' for '${bareId}' grounded on ${failures.length} failure trace(s)`,
    },
  };
}
