import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const GOAL_HOST_VESSEL_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";

interface ConfigSection {
  key: string;
  value: string;
  source: string;
}

interface VesselInfo {
  vesselId?: string;
  endpoint?: string;
  shapes?: string[];
  health?: string;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

export async function resolveConfigFile(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
  };

  // Collect environment-level config entries
  const envSections: ConfigSection[] = [
    { key: "METABOB_ENDPOINT", value: METABOB_ENDPOINT, source: "env" },
    { key: "DISCOVERY_ENDPOINT", value: DISCOVERY_ENDPOINT, source: "env" },
    { key: "GOAL_HOST_VESSEL_ENDPOINT", value: GOAL_HOST_VESSEL_ENDPOINT, source: "env" },
    { key: "VESSEL_ID", value: process.env["VESSEL_ID"] ?? "(unset)", source: "env" },
    { key: "WORKSPACE_ROOT", value: process.env["WORKSPACE_ROOT"] ?? process.cwd(), source: "env" },
  ];

  // Fetch registered vessels from discovery
  let registeredVessels: VesselInfo[] = [];
  let discoveryStatus = "unknown";
  try {
    const discoveryData: any = await fetchJson(`${DISCOVERY_ENDPOINT}/vessels`, authHeaders);
    if (discoveryData !== null) {
      discoveryStatus = "reachable";
      const vessels = Array.isArray(discoveryData?.vessels)
        ? (discoveryData.vessels as any[])
        : Array.isArray(discoveryData)
        ? (discoveryData as any[])
        : [];
      registeredVessels = vessels.map((v: any) => ({
        vesselId: typeof v?.vesselId === "string" ? v.vesselId : undefined,
        endpoint: typeof v?.endpoint === "string" ? v.endpoint : undefined,
        shapes: Array.isArray(v?.shapes) ? (v.shapes as string[]) : [],
        health: typeof v?.health === "string" ? v.health : "unknown",
      }));
    } else {
      discoveryStatus = "unreachable";
    }
  } catch {
    discoveryStatus = "error";
  }

  // Fetch goal-host health
  let goalHostStatus = "unknown";
  let goalHostVersion: string | undefined;
  try {
    const ghHealth: any = await fetchJson(`${GOAL_HOST_VESSEL_ENDPOINT}/health`, authHeaders);
    if (ghHealth !== null) {
      goalHostStatus = typeof ghHealth?.status === "string" ? ghHealth.status : "reachable";
      goalHostVersion = typeof ghHealth?.version === "string" ? ghHealth.version : undefined;
    } else {
      goalHostStatus = "unreachable";
    }
  } catch {
    goalHostStatus = "error";
  }

  // Fetch activity-api health
  let activityApiStatus = "unknown";
  let activityApiTemplateCount: number | undefined;
  try {
    const aaHealth: any = await fetchJson(
      `${METABOB_ENDPOINT}/v2/activities/templates?limit=1`,
      authHeaders,
    );
    if (aaHealth !== null) {
      activityApiStatus = "reachable";
      const total = aaHealth?.total;
      activityApiTemplateCount = typeof total === "number" ? total : undefined;
    } else {
      activityApiStatus = "unreachable";
    }
  } catch {
    activityApiStatus = "error";
  }

  // Compute total advertised shapes across all registered vessels
  const totalShapes = registeredVessels.reduce((sum, v) => sum + (v.shapes?.length ?? 0), 0);

  const targetShape = typeof pointer["shape"] === "string" ? pointer["shape"] : undefined;

  const body = {
    generatedAt: new AbortController().signal.aborted ? 0 : Math.floor(Math.random() * 0 + 0),
    summary: {
      discoveryStatus,
      goalHostStatus,
      activityApiStatus,
      registeredVesselCount: registeredVessels.length,
      totalAdvertisedShapes: totalShapes,
      ...(activityApiTemplateCount !== undefined ? { activityApiTemplateCount } : {}),
      ...(goalHostVersion !== undefined ? { goalHostVersion } : {}),
    },
    environment: envSections,
    registeredVessels: registeredVessels.map((v) => ({
      vesselId: v.vesselId ?? "unknown",
      endpoint: v.endpoint ?? "unknown",
      shapeCount: v.shapes?.length ?? 0,
      health: v.health ?? "unknown",
    })),
    requestedShape: targetShape,
    updateProgress: {
      description:
        "Substrate config snapshot: environment variables, registered vessels, and service health as observed at resolution time.",
      discoveryVesselReachable: discoveryStatus === "reachable",
      goalHostReachable: goalHostStatus === "ok" || goalHostStatus === "reachable",
      activityApiReachable: activityApiStatus === "reachable",
      vesselCount: registeredVessels.length,
      shapeCoverage: totalShapes,
    },
  };

  return { shape: "config_file", body };
}
