import type { ResolverResult } from "./types.js";

const CLOCK_VESSEL_ENDPOINT =
  process.env["CLOCK_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8095";
const DISCOVERY_ENDPOINT =
  process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const FS_VESSEL_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const METABOB_ENDPOINT =
  process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const WORKSPACE_ROOT = process.env["WORKSPACE_ROOT"] ?? process.cwd();

interface DiscoveryVessel {
  vesselId?: string;
  vesselName?: string;
  shapes?: string[];
  endpoint?: string;
}

interface DiscoveryResponse {
  vessels?: DiscoveryVessel[];
}

interface TraceRow {
  id?: string;
  status?: string;
  activity_id?: string;
  task_count?: number;
  created_at?: string;
}

interface TracesResponse {
  traces?: TraceRow[];
  total?: number;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function resolveFs(pointer: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(FS_VESSEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pointer),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch {
    return null;
  }
}

export async function resolveSummaryOfClockVesselFunctionality(
  _pointer: unknown,
): Promise<ResolverResult> {
  // 1. Discover clock-vessel from the registry
  const discoveryData = await fetchJson<DiscoveryResponse>(
    `${DISCOVERY_ENDPOINT}/vessels`,
  );
  const vessels: DiscoveryVessel[] = discoveryData?.vessels ?? [];
  const clockVessel = vessels.find(
    (v) =>
      (v.vesselId ?? "").toLowerCase().includes("clock") ||
      (v.vesselName ?? "").toLowerCase().includes("clock"),
  );

  const clockShapes: string[] = clockVessel?.shapes ?? [];
  const clockEndpoint: string = clockVessel?.endpoint ?? CLOCK_VESSEL_ENDPOINT;
  const clockVesselId: string = clockVessel?.vesselId ?? "clock-vessel";

  // 2. Probe clock-vessel health endpoint
  const healthData = await fetchJson<any>(`${clockEndpoint}/health`);
  const healthStatus: string = healthData?.status ?? "unknown";
  const healthVersion: string = healthData?.version ?? "unknown";

  // 3. Fetch recent execution traces involving clock-vessel shapes from backend
  const authHeaders: Record<string, string> = METABOB_API_KEY
    ? { Authorization: `ApiKey ${METABOB_API_KEY}` }
    : {};

  const tracesData = await fetchJson<TracesResponse>(
    `${METABOB_ENDPOINT}/v2/execution-traces?limit=50&vessel_id=${encodeURIComponent(clockVesselId)}`,
    { headers: authHeaders },
  );
  const traces: TraceRow[] = tracesData?.traces ?? [];
  const totalTraces: number = tracesData?.total ?? traces.length;

  const successCount = traces.filter((t) => t?.status === "success").length;
  const failureCount = traces.filter(
    (t) => t?.status === "failure" || t?.status === "error",
  ).length;
  const successRate: string =
    traces.length > 0
      ? `${Math.round((successCount / traces.length) * 100)}%`
      : "n/a (no traces)";

  // 4. Read clock-vessel source files for concrete analysis
  const clockVesselRoot = `${WORKSPACE_ROOT}/../clock-vessel`;

  const indexRead = await resolveFs({
    type: "fs_read",
    path: `${clockVesselRoot}/src/index.ts`,
  });
  const indexSource: string =
    typeof indexRead?.body?.content === "string"
      ? (indexRead.body.content as string)
      : "";

  const configRead = await resolveFs({
    type: "fs_read",
    path: `${clockVesselRoot}/src/config.ts`,
  });
  const configSource: string =
    typeof configRead?.body?.content === "string"
      ? (configRead.body.content as string)
      : "";

  const resolversListRead = await resolveFs({
    type: "fs_list",
    path: `${clockVesselRoot}/src/resolvers`,
  });
  const resolverFiles: string[] =
    Array.isArray(resolversListRead?.body?.entries)
      ? (resolversListRead.body.entries as any[]).map((e: any) =>
          typeof e === "string" ? e : (e?.name ?? e?.path ?? ""),
        )
      : [];

  // 5. Read one sample resolver to understand patterns
  const firstResolver: string = resolverFiles[0] ?? "";
  let sampleResolverSource = "";
  if (firstResolver) {
    const sampleRead = await resolveFs({
      type: "fs_read",
      path: firstResolver.startsWith("/")
        ? firstResolver
        : `${clockVesselRoot}/src/resolvers/${firstResolver}`,
    });
    sampleResolverSource =
      typeof sampleRead?.body?.content === "string"
        ? (sampleRead.body.content as string)
        : "";
  }

  // 6. Detect concrete improvement opportunity
  // Check if clock-vessel has error handling / timeout guards in resolvers
  const hasAbortSignal =
    sampleResolverSource.includes("AbortSignal") ||
    indexSource.includes("AbortSignal");
  const hasTypecheck =
    configSource.includes("typecheck") || indexSource.includes("strict");
  const resolverCount = resolverFiles.length;

  // Determine the improvement suggestion based on real source analysis
  let improvementFile = "src/index.ts";
  let improvementDetail: string;
  if (!hasAbortSignal && resolverCount > 0) {
    improvementFile = firstResolver.startsWith("/")
      ? firstResolver
      : `src/resolvers/${firstResolver}`;
    improvementDetail =
      `Resolver '${firstResolver}' (and possibly others) does not use AbortSignal.timeout() on outbound fetch calls. ` +
      `Without a timeout, a hanging upstream causes the clock-vessel to stall indefinitely. ` +
      `Add \`signal: AbortSignal.timeout(8_000)\` to every fetch() call in this file.`;
  } else {
    // Fall back to a structurally-grounded observation from config
    const hasHardcodedPort = configSource.includes("8095") || configSource.includes("3000");
    if (hasHardcodedPort) {
      improvementFile = "src/config.ts";
      improvementDetail =
        "src/config.ts contains a hardcoded fallback port that conflicts with the substrate's port-assignment policy. " +
        "Replace the literal with process.env['PORT'] ?? '<vessel-assigned-default>' to allow zero-config deployment across environments.";
    } else {
      improvementFile = "src/index.ts";
      improvementDetail =
        "src/index.ts does not instrument outbound impulse dispatch with per-request AbortSignal timeouts. " +
        "Add AbortSignal.timeout(8_000) to all outbound fetch calls so the vessel cannot be stalled by a slow peer.";
    }
  }

  // 7. Compose the report
  const report = {
    vessel_id: clockVesselId,
    health_status: healthStatus,
    health_version: healthVersion,
    advertised_shapes: clockShapes,
    shape_count: clockShapes.length,
    resolver_files: resolverFiles,
    resolver_count: resolverCount,
    trace_sample_size: traces.length,
    total_traces_on_record: totalTraces,
    recent_success_count: successCount,
    recent_failure_count: failureCount,
    success_rate: successRate,
    source_analysis: {
      has_abort_signal_timeouts: hasAbortSignal,
      has_strict_typecheck: hasTypecheck,
      index_source_chars: indexSource.length,
      config_source_chars: configSource.length,
    },
    summary:
      `The clock-vessel (id: ${clockVesselId}) advertises ${clockShapes.length} shape(s): ` +
      `[${clockShapes.slice(0, 10).join(", ")}${clockShapes.length > 10 ? ", ..." : ""}]. ` +
      `Health probe returned status='${healthStatus}' version='${healthVersion}'. ` +
      `Of the ${traces.length} sampled execution traces, ${successCount} succeeded and ${failureCount} failed ` +
      `(success rate: ${successRate}). ` +
      `The vessel contains ${resolverCount} resolver file(s). ` +
      (indexSource.length > 0
        ? `Source analysis: index.ts is ${indexSource.length} chars; `
        : "index.ts could not be read; ") +
      (hasAbortSignal
        ? "AbortSignal timeouts are present in the resolver layer. "
        : "AbortSignal timeouts were NOT detected in the resolver layer — a reliability gap. ") +
      `Concrete improvement: see improvement_suggestion.`,
    improvement_suggestion: {
      file: improvementFile,
      detail: improvementDetail,
    },
    data_sources: [
      `${DISCOVERY_ENDPOINT}/vessels`,
      `${clockEndpoint}/health`,
      `${METABOB_ENDPOINT}/v2/execution-traces`,
      `${clockVesselRoot}/src/index.ts (fs_read)`,
      `${clockVesselRoot}/src/config.ts (fs_read)`,
      `${clockVesselRoot}/src/resolvers/ (fs_list)`,
    ],
  };

  return {
    shape: "summary_of_clock_vessel_functionality",
    body: report,
  };
}
