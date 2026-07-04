// advertised_shape_coverage_scan v0 skeleton: cross-checks discovery-registry advertised shapes against catalogue consumers, composition edges, and trace resolutions (behavior wired next).
import type { ResolverResult } from "./types.js";

export interface AdvertisedShapeCoverageScanPointer {
  type: "advertised_shape_coverage_scan";
  report_limit?: number;
  dry_run?: boolean;
}

export async function resolveAdvertisedShapeCoverageScan(
  pointer: AdvertisedShapeCoverageScanPointer,
): Promise<ResolverResult> {
  let registry_reachable = false;
  try {
    const endpoint = process.env["DISCOVERY_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8100";
    const res = await fetch(`${endpoint}/registry/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    registry_reachable = res.ok;
  } catch {
    registry_reachable = false;
  }
  return {
    shape: "advertisedShapeCoverageReport",
    body: {
      skeleton: true,
      registry_reachable,
      advertised_shape_count: 0,
      report_limit: pointer.report_limit ?? 25,
      dry_run: pointer.dry_run === true,
    },
  };
}
