import type { ResolverResult } from "./types.js";

interface DiscoveryVesselEntry {
  vesselId?: string;
  vesselName?: string;
  shapes?: string[];
  status?: string;
  endpoint?: string;
  lastSeen?: number;
}

/**
 * obsidian:vessel_count
 *
 * Queries the discovery-vessel registry and counts how many obsidian-vessels
 * (vessels whose vesselId or vesselName contains "obsidian") are currently
 * connected / registered.
 */
export async function resolveObsidianVesselCount(
  _pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const discoveryEndpoint =
    process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";

  let allVessels: DiscoveryVesselEntry[] = [];
  let fetchError: string | null = null;

  try {
    const resp = await fetch(`${discoveryEndpoint}/vessels`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      fetchError = `discovery /vessels returned HTTP ${resp.status}`;
    } else {
      const raw: any = await resp.json();
      // Discovery may return { vessels: [...] } or a bare array
      if (Array.isArray(raw)) {
        allVessels = raw as DiscoveryVesselEntry[];
      } else if (raw !== null && typeof raw === "object") {
        const vessels = (raw as Record<string, unknown>)["vessels"];
        if (Array.isArray(vessels)) {
          allVessels = vessels as DiscoveryVesselEntry[];
        }
      }
    }
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Filter to obsidian-vessels: vesselId or vesselName contains "obsidian"
  const obsidianVessels = allVessels.filter((v) => {
    const id = v?.vesselId ?? "";
    const name = v?.vesselName ?? "";
    return id.toLowerCase().includes("obsidian") || name.toLowerCase().includes("obsidian");
  });

  const total = allVessels.length;
  const obsidianCount = obsidianVessels.length;

  // Collect per-vessel summary rows
  const vessels = obsidianVessels.map((v) => ({
    vesselId: v?.vesselId ?? "unknown",
    vesselName: v?.vesselName ?? "unknown",
    status: v?.status ?? "unknown",
    endpoint: v?.endpoint ?? "",
    shapeCount: Array.isArray(v?.shapes) ? v.shapes.length : 0,
  }));

  return {
    shape: "obsidian:vessel_count",
    body: {
      obsidian_vessel_count: obsidianCount,
      total_registered_vessels: total,
      vessels,
      fetch_error: fetchError,
      discovery_endpoint: discoveryEndpoint,
    },
  };
}
