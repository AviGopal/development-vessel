// advertised_shape_coverage_scan: cross-checks discovery-registry advertised shapes against catalogue consumers, composition edges, and trace resolutions.
import type { ResolverResult } from "./types.js";
import { env } from "../config.js";

export interface AdvertisedShapeCoverageScanPointer {
  type: "advertised_shape_coverage_scan";
  report_limit?: number;
  dry_run?: boolean;
}

function scanSurrealHeaders(): Record<string, string> {
  const user = process.env["SURREALDB_USERNAME"] ?? "root";
  const pass = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "";
  return {
    "Content-Type": "text/plain",
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    "surreal-ns": process.env["SURREALDB_NAMESPACE"] ?? "activity-system",
    "surreal-db": process.env["SURREALDB_DATABASE"] ?? "learning_loop",
  };
}

async function scanSql(query: string): Promise<Array<Record<string, unknown>>> {
  const url = (process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const res = await fetch(`${url}/sql`, { method: "POST", headers: scanSurrealHeaders(), body: query, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return [];
  const arr = (await res.json()) as Array<{ result?: unknown }>;
  const r = arr[arr.length - 1]?.result;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

function stringArrayOf(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === "string") : [];
}

export async function resolveAdvertisedShapeCoverageScan(
  pointer: AdvertisedShapeCoverageScanPointer,
): Promise<ResolverResult> {
  const limit = pointer.report_limit ?? 25;
  let registry_reachable = false;
  const advertised = new Map<string, Set<string>>();
  let vessel_count = 0;
  try {
    const endpoint = env("DISCOVERY_VESSEL_ENDPOINT", "http://127.0.0.1:8100");
    const apiKey = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { content?: { vessels?: Array<{ vesselId?: string; shapes?: unknown }> } };
      const vessels = Array.isArray(j?.content?.vessels) ? j.content!.vessels! : [];
      vessel_count = vessels.length;
      registry_reachable = true;
      for (const v of vessels) {
        for (const s of stringArrayOf(v.shapes)) {
          let set = advertised.get(s);
          if (!set) { set = new Set(); advertised.set(s, set); }
          if (typeof v.vesselId === "string") set.add(v.vesselId);
        }
      }
    }
  } catch { registry_reachable = false; }

  const consumedByCatalogue = new Set<string>();
  const producedByCatalogue = new Set<string>();
  let catalogue_size = 0;
  try {
    const rows = await scanSql("SELECT input_shapes, output_shapes FROM activity WHERE retired != true AND deprecated != true LIMIT 5000;");
    catalogue_size = rows.length;
    for (const row of rows) {
      for (const s of stringArrayOf(row["input_shapes"])) consumedByCatalogue.add(s);
      for (const s of stringArrayOf(row["output_shapes"])) producedByCatalogue.add(s);
    }
  } catch { /* report proceeds with empty sets */ }

  const recentlyProducedInTraces = new Set<string>();
  let trace_sample_size = 0;
  try {
    const rows = await scanSql("SELECT output_impulse_shapes, executed_at FROM execution ORDER BY executed_at DESC LIMIT 2000;");
    trace_sample_size = rows.length;
    for (const row of rows) {
      for (const s of stringArrayOf(row["output_impulse_shapes"])) recentlyProducedInTraces.add(s);
    }
  } catch { /* report proceeds with empty set */ }

  const advertisedShapes = Array.from(advertised.keys()).sort();
  const advertised_no_catalogue_consumer = advertisedShapes.filter((s) => !consumedByCatalogue.has(s));
  const advertised_never_recently_resolved = advertisedShapes.filter((s) => !recentlyProducedInTraces.has(s));
  const consumer_missing_live_producer = Array.from(consumedByCatalogue)
    .filter((s) => !advertised.has(s) && !producedByCatalogue.has(s))
    .sort();

  return {
    shape: "advertisedShapeCoverageReport",
    body: {
      skeleton: false,
      feature_compose_locations_missing_local_toolbelt: (() => {
          const LOCATION_STATEFUL = ["shellResult", "fs_read", "fs_write", "fs_edit", "patch_with_tools"];
          const llmReachable = (advertised.get("llm_completion")?.size ?? 0) > 0;
          const out: Array<{ vesselId: string; missing_local_stateful: string[]; llm_reachable: boolean }> = [];
          for (const vesselId of Array.from(advertised.get("feature_compose") ?? [])) {
            const missing_local_stateful = LOCATION_STATEFUL.filter((s) => !(advertised.get(s)?.has(vesselId)));
            if (missing_local_stateful.length > 0 || !llmReachable) out.push({ vesselId, missing_local_stateful, llm_reachable: llmReachable });
          }
          return out;
        })(),
      registry_reachable,
      advertised_shape_count: advertisedShapes.length,
      vessel_count,
      advertised_no_catalogue_consumer: advertised_no_catalogue_consumer.slice(0, limit),
      advertised_no_catalogue_consumer_total: advertised_no_catalogue_consumer.length,
      advertised_never_recently_resolved: advertised_never_recently_resolved.slice(0, limit),
      advertised_never_recently_resolved_total: advertised_never_recently_resolved.length,
      consumer_missing_live_producer: consumer_missing_live_producer.slice(0, limit),
      consumer_missing_live_producer_total: consumer_missing_live_producer.length,
      trace_sample_size,
      catalogue_size,
      report_limit: limit,
      dry_run: pointer.dry_run === true,
      completed_at: new Date().toISOString(),
    },
  };
}
