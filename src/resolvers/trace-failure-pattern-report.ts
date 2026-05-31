import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { isMetaTemplate } from "../lib/meta-templates.js";
import type { ResolverResult } from "./types.js";

export interface TraceFailurePatternReportPointer {
  type: "trace_failure_pattern_report";
  /** How many recent traces to scan. Default: 200. */
  limit?: number;
  /** Minimum occurrence count for a pattern to be reported. Default: 3. */
  min_occurrences?: number;
  /**
   * If true, exclude meta-activity templates from the report
   * (validator-dispatch, slot-binding, create-shape-provider-goal,
   * substrate-health-tick, coverage-tick). Default: true.
   */
  exclude_meta?: boolean;
}

interface TraceTask {
  task_id?: string;
  success?: boolean;
}

interface ExecutionTrace {
  id?: string;
  activity_id?: string;
  status?: string;
  tasks?: TraceTask[];
  failure_mode?: { type?: string } | null;
  executed_at?: string;
}

interface FailurePattern {
  template_id: string;
  first_failed_task_id: string | null;
  successful_task_count: number;
  total_task_count: number;
  occurrence_count: number;
  example_trace_ids: string[];
  failure_mode_types: string[];
}

// Failure-pattern reporting excludes the framework wrappers (via isMetaTemplate
// from src/lib/meta-templates.ts) AND additionally excludes substrate diagnostic
// templates that fail in ways the health loop should handle separately.
const DIAGNOSTIC_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "development-vessel:substrate-health-tick",
  "development-vessel:coverage-tick",
]);

function stripActivityWrap(id: string): string {
  return id.replace(/^activity:⟨/, "").replace(/⟩$/, "");
}

/**
 * Substrate-citizen detection of fails-at-task-N systematic patterns.
 *
 * Operator-side audit catches one failure at a time. A substrate-resident
 * report aggregates recent failed traces and surfaces (template, failing-task)
 * groups whose occurrence count exceeds the operator's tolerance — these are
 * the patterns worth authoring closures for. Output feeds substrate-authored
 * activities that emit substrateGap impulses → drain pipeline → drafter.
 *
 * Output: failurePatternReport with patterns sorted by occurrence_count desc.
 */
export async function resolveTraceFailurePatternReport(
  pointer: TraceFailurePatternReportPointer,
): Promise<ResolverResult> {
  // Default 50 (was 200) to reduce activity-api / SurrealDB scan pressure.
  // Caller can opt into larger windows explicitly when ad-hoc auditing.
  const limit = pointer.limit ?? 50;
  const minOccurrences = pointer.min_occurrences ?? 3;
  const excludeMeta = pointer.exclude_meta ?? true;

  const res = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=${limit}`,
    { headers: { Authorization: `ApiKey ${METABOB_API_KEY}` } },
  );
  if (!res.ok) {
    return {
      shape: "structuredError",
      body: {
        resolver: "trace_failure_pattern_report",
        status: res.status,
        detail: (await res.text().catch(() => "")).slice(0, 200),
      },
    };
  }
  const data = await res.json() as { executions?: ExecutionTrace[] };
  const traces = data.executions ?? [];

  type PatternKey = string;
  const groups = new Map<PatternKey, FailurePattern>();
  let totalFailures = 0;
  let zeroTaskFailures = 0;

  for (const tr of traces) {
    if (tr.status !== "failure") continue;
    totalFailures++;
    const templateId = stripActivityWrap(tr.activity_id ?? "?");
    if (excludeMeta && (isMetaTemplate(templateId) || DIAGNOSTIC_TEMPLATE_IDS.has(templateId))) continue;

    const tasks = tr.tasks ?? [];
    const successCount = tasks.filter((t) => t.success === true).length;
    const totalCount = tasks.length;
    const firstFailed =
      tasks.find((t) => t.success !== true)?.task_id ?? null;
    if (totalCount === 0) zeroTaskFailures++;

    const key = `${templateId}|${firstFailed ?? "_zero_"}|${successCount}/${totalCount}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrence_count += 1;
      if (existing.example_trace_ids.length < 3 && tr.id) {
        existing.example_trace_ids.push(tr.id);
      }
      const fm = tr.failure_mode?.type;
      if (fm && !existing.failure_mode_types.includes(fm)) {
        existing.failure_mode_types.push(fm);
      }
    } else {
      groups.set(key, {
        template_id: templateId,
        first_failed_task_id: firstFailed,
        successful_task_count: successCount,
        total_task_count: totalCount,
        occurrence_count: 1,
        example_trace_ids: tr.id ? [tr.id] : [],
        failure_mode_types: tr.failure_mode?.type ? [tr.failure_mode.type] : [],
      });
    }
  }

  const patterns = Array.from(groups.values())
    .filter((p) => p.occurrence_count >= minOccurrences)
    .sort((a, b) => b.occurrence_count - a.occurrence_count);

  return {
    shape: "failurePatternReport",
    body: {
      traces_examined: traces.length,
      total_failures: totalFailures,
      zero_task_failures: zeroTaskFailures,
      min_occurrences_threshold: minOccurrences,
      patterns_found: patterns.length,
      patterns,
      generated_at: new Date().toISOString(),
    },
  };
}
