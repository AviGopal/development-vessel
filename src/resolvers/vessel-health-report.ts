import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

interface Pointer {
  type: string;
  vessel_id?: string;
  [key: string]: unknown;
}

export async function resolveVesselHealthReport(pointer: Pointer): Promise<ResolverResult> {
  // DO NOT INVENT A SUBJECT (2026-08-16).
  //
  // This defaulted to the literal "analysis-vessel-local" whenever the caller failed to bind
  // vessel_id, and said nothing about having done so. That is a false-reach generator, and it was
  // caught producing one: a goal naming discovery-vessel and development-vessel walked, produced a
  // perfectly well-formed healthy report for analysis-vessel-local, persisted it as a memory note,
  // and the reach judge — reading a valid report — asserted the note "successfully summarizes the
  // health of both the discovery vessel and the development vessel". Neither appeared in it.
  //
  // The failure was never visible to any gate, because a defaulted subject is indistinguishable
  // from a requested one once the report is built. An unbound argument must surface as an
  // unresolved impulse so the walk can retry or fail honestly — the same discipline
  // bodyHonestyPolicy follows by serving NOTHING rather than an empty policy. A wrong answer that
  // looks right is worse than no answer, because only one of the two can be detected.
  const vesselId = typeof pointer.vessel_id === "string" ? pointer.vessel_id.trim() : "";
  if (!vesselId) {
    return {
      shape: "vessel_health_report",
      body: {
        error: "vessel_id is required — refusing to report on an assumed vessel",
        detail:
          "No vessel_id was bound on this pointer. This resolver previously defaulted to a hardcoded vessel, which produced valid-looking reports about a subject nobody asked for and passed the reach judge. Bind vessel_id (one report per vessel; dispatch once per vessel for a multi-vessel goal).",
        resolved: false,
      },
    };
  }

  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
  };

  // 1. Fetch vessel registration info from discovery
  let discoveryInfo: any = null;
  let discoveryError: string | null = null;
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/vessels/${encodeURIComponent(vesselId)}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      discoveryInfo = await res.json() as any;
    } else {
      discoveryError = `discovery HTTP ${res.status}`;
    }
  } catch (e) {
    discoveryError = e instanceof Error ? e.message : String(e);
  }

  // 2. Fetch recent execution traces for the vessel
  let recentTraces: any[] = [];
  let tracesError: string | null = null;
  try {
    const res = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?vessel_id=${encodeURIComponent(vesselId)}&limit=50`,
      { headers: authHeaders, signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const body = await res.json() as any;
      // `executions` is the key activity-api actually returns
      // (ListExecutionTracesResponse: {executions,total,limit,offset}). Accepting only
      // `traces` read undefined -> [] , so fixing the URL alone would have left this
      // silently empty — the same write-key/read-key mismatch one layer out.
      recentTraces = Array.isArray(body?.executions) ? (body.executions as any[])
        : Array.isArray(body?.traces) ? (body.traces as any[]) : [];
    } else {
      tracesError = `traces HTTP ${res.status}`;
    }
  } catch (e) {
    tracesError = e instanceof Error ? e.message : String(e);
  }

  // 3. Fetch recent goals associated with this vessel
  let recentGoals: any[] = [];
  let goalsError: string | null = null;
  try {
    const res = await fetch(
      `${METABOB_ENDPOINT}/v2/goals?vessel_id=${encodeURIComponent(vesselId)}&limit=20`,
      { headers: authHeaders, signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const body = await res.json() as any;
      recentGoals = Array.isArray(body?.goals) ? (body.goals as any[]) : [];
    } else {
      goalsError = `goals HTTP ${res.status}`;
    }
  } catch (e) {
    goalsError = e instanceof Error ? e.message : String(e);
  }

  // 4. Probe the vessel's own /health endpoint if an endpoint is known
  let vesselEndpoint: string | null = null;
  if (typeof discoveryInfo?.endpoint === "string") {
    vesselEndpoint = discoveryInfo.endpoint as string;
  }
  let healthProbeStatus: string = "skipped";
  let healthProbeBody: any = null;
  if (vesselEndpoint !== null) {
    try {
      const res = await fetch(`${vesselEndpoint}/health`, {
        signal: AbortSignal.timeout(6_000),
      });
      healthProbeStatus = `HTTP ${res.status}`;
      if (res.ok) {
        healthProbeBody = await res.json() as any;
      }
    } catch (e) {
      healthProbeStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Aggregate trace metrics
  const totalTraces = recentTraces.length;
  let successCount = 0;
  let failureCount = 0;
  const resolverCounts: Record<string, number> = {};

  for (const trace of recentTraces) {
    if (trace?.success === true) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
    const rid = typeof trace?.resolver_id === "string" ? trace.resolver_id : "unknown";
    resolverCounts[rid] = (resolverCounts[rid] ?? 0) + 1;
  }

  const successRate = totalTraces > 0
    ? Math.round((successCount / totalTraces) * 1000) / 10
    : null;

  // Top resolvers by call count
  const topResolvers = Object.entries(resolverCounts)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 5)
    .map(([resolver_id, count]) => ({ resolver_id, count: count ?? 0 }));

  // Goal metrics
  const totalGoals = recentGoals.length;
  let goalsSucceeded = 0;
  let goalsFailed = 0;
  for (const goal of recentGoals) {
    if (goal?.status === "completed" || goal?.status === "success") {
      goalsSucceeded += 1;
    } else if (goal?.status === "failed" || goal?.status === "error") {
      goalsFailed += 1;
    }
  }

  // Determine overall health signal
  const isDiscoveryOk = discoveryError === null;
  const isHealthProbeOk = healthProbeBody !== null || vesselEndpoint === null;
  const goodSuccessRate = successRate === null || successRate >= 50;

  let overallHealth: "healthy" | "degraded" | "unknown";
  if (!isDiscoveryOk) {
    overallHealth = "unknown";
  } else if (!isHealthProbeOk || !goodSuccessRate) {
    overallHealth = "degraded";
  } else {
    overallHealth = "healthy";
  }

  const report = {
    vessel_id: vesselId,
    overall_health: overallHealth,
    discovery: {
      registered: isDiscoveryOk,
      endpoint: vesselEndpoint,
      advertised_shapes: Array.isArray(discoveryInfo?.shapes) ? (discoveryInfo.shapes as string[]) : [],
      error: discoveryError,
    },
    health_probe: {
      status: healthProbeStatus,
      response: healthProbeBody,
    },
    traces: {
      total_recent: totalTraces,
      success_count: successCount,
      failure_count: failureCount,
      success_rate_pct: successRate,
      top_resolvers: topResolvers,
      fetch_error: tracesError,
    },
    goals: {
      total_recent: totalGoals,
      succeeded: goalsSucceeded,
      failed: goalsFailed,
      fetch_error: goalsError,
    },
  };

  return { shape: "vessel_health_report", body: report };
}
