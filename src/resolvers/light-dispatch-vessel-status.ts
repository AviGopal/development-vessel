import type { ResolverResult } from "./types.js";

const LIGHT_DISPATCH_VESSEL_ENDPOINT =
  process.env["LIGHT_DISPATCH_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8320";
const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";

interface HealthBody {
  status?: string;
  vessel?: string;
  version?: string;
  discovery?: unknown;
  [key: string]: unknown;
}

interface DiscoveryEntry {
  vesselId?: string;
  vesselName?: string;
  endpoint?: string;
  shapes?: string[];
  last_heartbeat?: string | number;
  [key: string]: unknown;
}

interface TraceRow {
  id?: string;
  status?: string;
  activity_id?: string;
  duration_ms?: number;
  created_at?: string;
  [key: string]: unknown;
}

async function safeFetch(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err instanceof Error ? err.message : err) };
  }
}

export async function resolveLightDispatchVesselStatus(
  pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  const vesselId = (pointer["vesselId"] as string | undefined) ?? "light-dispatch-vessel";

  // 1. Health check against the vessel's own /health endpoint
  const healthResult = await safeFetch(
    `${LIGHT_DISPATCH_VESSEL_ENDPOINT}/health`,
    { method: "GET" },
    8_000,
  );
  const healthBody = (healthResult.body ?? {}) as HealthBody;

  // 2. Discovery registry lookup
  const discoveryResult = await safeFetch(
    `${DISCOVERY_ENDPOINT}/vessels`,
    {
      method: "GET",
      headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {},
    },
    8_000,
  );
  const discoveryBody = (discoveryResult.body ?? {}) as { vessels?: DiscoveryEntry[] };
  const vessels: DiscoveryEntry[] = Array.isArray(discoveryBody.vessels)
    ? discoveryBody.vessels
    : [];
  const registryEntry: DiscoveryEntry | undefined = vessels.find(
    (v) => (v.vesselId ?? v.vesselName ?? "").includes("light-dispatch"),
  );
  const isRegistered = registryEntry !== undefined;
  const advertisedShapes: string[] = Array.isArray(registryEntry?.shapes)
    ? (registryEntry?.shapes ?? [])
    : [];

  // 3. Recent trace summary from metabob/activity-api
  const tracesResult = await safeFetch(
    `${METABOB_ENDPOINT}/v2/traces?vessel_id=${encodeURIComponent(vesselId)}&limit=20&sort=created_at:desc`,
    {
      method: "GET",
      headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {},
    },
    8_000,
  );
  const tracesBody = (tracesResult.body ?? {}) as { traces?: TraceRow[]; total?: number };
  const traces: TraceRow[] = Array.isArray(tracesBody.traces) ? tracesBody.traces : [];

  const totalTraces = typeof tracesBody.total === "number" ? tracesBody.total : traces.length;
  let successCount = 0;
  let failureCount = 0;
  let totalDurationMs = 0;
  let durationSamples = 0;

  for (const trace of traces) {
    if ((trace.status ?? "") === "success") {
      successCount += 1;
    } else if ((trace.status ?? "") === "failure" || (trace.status ?? "") === "error") {
      failureCount += 1;
    }
    if (typeof trace.duration_ms === "number") {
      totalDurationMs += trace.duration_ms;
      durationSamples += 1;
    }
  }

  const avgDurationMs =
    durationSamples > 0 ? Math.round(totalDurationMs / durationSamples) : null;

  const successRate =
    successCount + failureCount > 0
      ? Math.round((successCount / (successCount + failureCount)) * 100)
      : null;

  const mostRecentTrace: TraceRow | undefined = traces[0];

  // 4. Aggregate health verdict
  const vesselReachable = healthResult.ok;
  const healthStatus = (healthBody.status as string | undefined) ?? (vesselReachable ? "ok" : "unreachable");

  const overallHealth: string =
    !vesselReachable
      ? "degraded"
      : !isRegistered
      ? "unregistered"
      : healthStatus === "ok"
      ? "healthy"
      : "degraded";

  return {
    shape: "light-dispatch-vessel_status",
    body: {
      vesselId,
      overallHealth,
      reachable: vesselReachable,
      httpStatus: healthResult.status,
      healthStatus,
      discoveryRegistered: isRegistered,
      advertisedShapes,
      registryEndpoint: registryEntry?.endpoint ?? null,
      lastHeartbeat: registryEntry?.last_heartbeat ?? null,
      traces: {
        total: totalTraces,
        recentSample: traces.length,
        successCount,
        failureCount,
        successRatePct: successRate,
        avgDurationMs,
        mostRecentId: mostRecentTrace?.id ?? null,
        mostRecentStatus: mostRecentTrace?.status ?? null,
        mostRecentAt: mostRecentTrace?.created_at ?? null,
      },
      checkedAt: new globalThis.String(new globalThis.Date().toISOString()),
    },
  };
}
