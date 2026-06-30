/**
 * trace_completeness_report — producer for traceCompletenessReport (capability-gap autoclosure).
 * Output shape: traceCompletenessReport
 */

import type { ResolverResult } from "./types.js";

export interface TraceCompletenessReportPointer {
  type: "trace_completeness_report";
  [key: string]: unknown;
}

export async function resolveTraceCompletenessReport(pointer: TraceCompletenessReportPointer): Promise<ResolverResult> {
const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  "Authorization": `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};
const signal = AbortSignal.timeout(20000);

try {
  // Fetch traces
  let tracesData: unknown = null;
  let activitiesData: unknown = null;
  let goalsData: unknown = null;

  try {
    const tracesRes = await fetch(`${endpoint}/traces`, { headers, signal });
    if (tracesRes.ok) {
      tracesData = await tracesRes.json();
    }
  } catch (_e) {
    tracesData = null;
  }

  try {
    const activitiesRes = await fetch(`${endpoint}/activities`, { headers, signal });
    if (activitiesRes.ok) {
      activitiesData = await activitiesRes.json();
    }
  } catch (_e) {
    activitiesData = null;
  }

  try {
    const goalsRes = await fetch(`${endpoint}/goals`, { headers, signal });
    if (goalsRes.ok) {
      goalsData = await goalsRes.json();
    }
  } catch (_e) {
    goalsData = null;
  }

  // Normalize arrays safely
  const traces: Record<string, unknown>[] = Array.isArray(tracesData)
    ? (tracesData as Record<string, unknown>[])
    : Array.isArray((tracesData as Record<string, unknown> | null)?.["items"])
    ? ((tracesData as Record<string, unknown>)["items"] as Record<string, unknown>[])
    : [];

  const activities: Record<string, unknown>[] = Array.isArray(activitiesData)
    ? (activitiesData as Record<string, unknown>[])
    : Array.isArray((activitiesData as Record<string, unknown> | null)?.["items"])
    ? ((activitiesData as Record<string, unknown>)["items"] as Record<string, unknown>[])
    : [];

  const goals: Record<string, unknown>[] = Array.isArray(goalsData)
    ? (goalsData as Record<string, unknown>[])
    : Array.isArray((goalsData as Record<string, unknown> | null)?.["items"])
    ? ((goalsData as Record<string, unknown>)["items"] as Record<string, unknown>[])
    : [];

  // Build a set of trace IDs referenced by activities
  const tracedActivityIds = new Set<string>();
  for (const activity of activities) {
    const traceId = activity["traceId"] ?? activity["trace_id"];
    if (typeof traceId === "string" && traceId.length > 0) {
      tracedActivityIds.add(traceId);
    }
  }

  // Build a set of trace IDs referenced by goals
  const tracedGoalIds = new Set<string>();
  for (const goal of goals) {
    const traceId = goal["traceId"] ?? goal["trace_id"];
    if (typeof traceId === "string" && traceId.length > 0) {
      tracedGoalIds.add(traceId);
    }
  }

  // Compute per-trace completeness
  const traceReports: Record<string, unknown>[] = [];
  for (const trace of traces) {
    const id =
      typeof trace["id"] === "string"
        ? trace["id"]
        : typeof trace["traceId"] === "string"
        ? trace["traceId"]
        : String(trace["id"] ?? "unknown");

    const hasActivity = tracedActivityIds.has(id);
    const hasGoal = tracedGoalIds.has(id);

    // Count steps/spans if present
    const steps = Array.isArray(trace["steps"])
      ? (trace["steps"] as unknown[]).length
      : Array.isArray(trace["spans"])
      ? (trace["spans"] as unknown[]).length
      : null;

    // Determine status field
    const status =
      typeof trace["status"] === "string" ? trace["status"] : "unknown";

    const complete = hasActivity && hasGoal;
    const missingFields: string[] = [];
    if (!hasActivity) missingFields.push("activity");
    if (!hasGoal) missingFields.push("goal");

    traceReports.push({
      traceId: id,
      status,
      hasLinkedActivity: hasActivity,
      hasLinkedGoal: hasGoal,
      stepCount: steps,
      complete,
      missingLinks: missingFields,
    });
  }

  const totalTraces = traceReports.length;
  const completeCount = traceReports.filter(
    (r) => (r as { complete: boolean }).complete
  ).length;
  const incompleteCount = totalTraces - completeCount;
  const completenessRatio =
    totalTraces > 0
      ? Math.round((completeCount / totalTraces) * 10000) / 100
      : null;

  // Gather traces missing each link type
  const missingActivityTraceIds = traceReports
    .filter((r) => !(r as { hasLinkedActivity: boolean }).hasLinkedActivity)
    .map((r) => (r as { traceId: string }).traceId);

  const missingGoalTraceIds = traceReports
    .filter((r) => !(r as { hasLinkedGoal: boolean }).hasLinkedGoal)
    .map((r) => (r as { traceId: string }).traceId);

  // Status breakdown
  const statusBreakdown: Record<string, number> = {};
  for (const r of traceReports) {
    const s = (r as { status: string }).status;
    statusBreakdown[s] = (statusBreakdown[s] ?? 0) + 1;
  }

  const report = {
    summary: {
      totalTraces,
      completeTraces: completeCount,
      incompleteTraces: incompleteCount,
      completenessPercent: completenessRatio,
      totalActivities: activities.length,
      totalGoals: goals.length,
    },
    statusBreakdown,
    missingLinks: {
      missingActivityCount: missingActivityTraceIds.length,
      missingGoalCount: missingGoalTraceIds.length,
      missingActivityTraceIds,
      missingGoalTraceIds,
    },
    traces: traceReports,
    dataAvailability: {
      tracesAvailable: tracesData !== null,
      activitiesAvailable: activitiesData !== null,
      goalsAvailable: goalsData !== null,
    },
  };

  return { shape: "traceCompletenessReport", body: report };
} catch (e) {
  return { shape: "traceCompletenessReport", body: { error: String(e) } };
}
}
