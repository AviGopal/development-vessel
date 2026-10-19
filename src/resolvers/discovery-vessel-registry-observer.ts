import type { ResolverResult } from "./types.js";
import { selfAuthHeaders } from "../lib/self-auth.js";

/**
 * discovery_vessel_registry_observer (round 2, 2026-06-05) — promotes the
 * discovery-vessel registry state into impulse form. When a vessel
 * silently stops heartbeating but its systemd unit reports active, downstream
 * routing degrades but the substrate cannot see the gap. systemdUnitHealth
 * covers the unit side; this observer covers the registry side. Together they
 * detect "active-but-not-registered" and "registered-but-stale" drift.
 *
 * Queries discovery-vessel's POST /resolve with a vesselRegistry pointer
 * (authenticated). Emits discoveryRegistryState with per-vessel last-seen ages
 * and a stale-count threshold check.
 */

const DEFAULT_ENDPOINT = process.env["DISCOVERY_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8100";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface DiscoveryVesselRegistryObserverPointer {
  type: "discovery_vessel_registry_observer";
  endpoint?: string;
  apiKey?: string;
  staleThresholdMs?: number;
  timeoutMs?: number;
  /**
   * A LOCAL-REGISTRATION CHECK. Only when given, the answer also carries top-level `missing_count` and
   * `missing_vessels`: the named vessels with no LOCAL row in the live registry (see registryRowMatch). Absent, the
   * response is exactly what it was. It is re-measured on every read, so a gap armed with it has no TTL to race.
   */
  vessel_ids?: string[];
}

/**
 * Whether a registry row is the record of the vessel named `name`. Registry ids are not unit names (concept-db
 * registers as concept-db-local, identity as identity-vessel-<host>), so a row matches when its id, before any
 * "@<peer>" suffix, equals the name or extends it with "-". A row with an "@" suffix is a federated copy from a peer,
 * which can stand in for a record this node lacks: it is "remote", never "local". Pure.
 */
export function registryRowMatch(name: string, rowId: string): "local" | "remote" | null {
  const base = rowId.split("@")[0] ?? "";
  if (!(base === name || base.startsWith(`${name}-`))) return null;
  return rowId.includes("@") ? "remote" : "local";
}

/** The named vessels with no local row among `rowIds` (an "@peer"-only match is missing for a local check). Pure. */
export function missingLocalVessels(names: readonly string[], rowIds: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))]
    .filter((n) => !rowIds.some((id) => registryRowMatch(n, id) === "local"))
    .sort();
}

interface VesselEntry {
  vesselId: string;
  vesselName?: string;
  lastSeen?: string;
  status?: string;
  shapes?: string[];
}

interface PerVessel {
  vessel_id: string;
  vessel_name: string | null;
  status: string | null;
  last_seen_iso: string | null;
  age_seconds: number | null;
  stale: boolean;
  shape_count: number;
}

/** Default stale threshold: under discovery's 5-min prune TTL, above its advised 2-min heartbeat interval. */
export const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;

export async function resolveDiscoveryVesselRegistryObserver(
  pointer: DiscoveryVesselRegistryObserverPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  // BELOW THE PRUNE TTL, OR THE DETECTOR CANNOT FIRE. Discovery deletes a row once its last heartbeat is older than
  // its 5-min registration TTL (discovery-vessel registry.ts DEFAULT_TTL_MS, pruned every 60 s), so with a 5-min
  // threshold here a stale row was already gone before it could be counted and stale_count read ~0 by construction.
  // 3 min is above discovery's advised 2-min heartbeat interval (HEARTBEAT_INTERVAL_MS) and the shared loop's 60 s, so a
  // healthy row never reads stale, and below the TTL, so a row that missed its heartbeats is counted for ~2 min before
  // it is pruned. A pointer may still set its own.
  const staleMs = pointer.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const timeoutMs = pointer.timeoutMs ?? 5_000;

  if (!apiKey) {
    return {
      shape: "discoveryRegistryState",
      body: {
        endpoint,
        reachable: false,
        error: "missing_api_key",
        total_vessels: 0,
        healthy_count: 0,
        stale_count: 0,
        stale_threshold_ms: staleMs,
        per_vessel: [],
        generated_at: new Date().toISOString(),
      },
    };
  }

  // A key goes only to the configured discovery endpoint (lib/self-auth.ts selfAuthHeaders): an endpoint
  // the pointer overrides gets none. There a key the caller supplied is used as before, the node key otherwise.
  const configured = DEFAULT_ENDPOINT.replace(/\/+$/, "");
  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...selfAuthHeaders(endpoint, configured, pointer.apiKey),
      },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      shape: "discoveryRegistryState",
      body: {
        endpoint,
        reachable: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        roundtrip_ms: Date.now() - start,
        total_vessels: 0,
        healthy_count: 0,
        stale_count: 0,
        stale_threshold_ms: staleMs,
        per_vessel: [],
        generated_at: new Date().toISOString(),
      },
    };
  }
  const roundtrip = Date.now() - start;
  if (!resp.ok) {
    return {
      shape: "discoveryRegistryState",
      body: {
        endpoint,
        reachable: false,
        error: `http_${resp.status}`,
        http_status: resp.status,
        roundtrip_ms: roundtrip,
        total_vessels: 0,
        healthy_count: 0,
        stale_count: 0,
        stale_threshold_ms: staleMs,
        per_vessel: [],
        generated_at: new Date().toISOString(),
      },
    };
  }

  let parsed: { content?: { vessels?: VesselEntry[] }; vessels?: VesselEntry[] } & Record<string, unknown>;
  try {
    parsed = (await resp.json()) as typeof parsed;
  } catch (err) {
    return {
      shape: "discoveryRegistryState",
      body: {
        endpoint,
        reachable: true,
        error: `parse_error: ${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}`,
        roundtrip_ms: roundtrip,
        total_vessels: 0,
        healthy_count: 0,
        stale_count: 0,
        stale_threshold_ms: staleMs,
        per_vessel: [],
        generated_at: new Date().toISOString(),
      },
    };
  }

  const vessels = Array.isArray(parsed.content?.vessels)
    ? parsed.content!.vessels!
    : Array.isArray(parsed.vessels)
    ? parsed.vessels
    : [];
  const now = Date.now();
  const perVessel: PerVessel[] = vessels.map((v) => {
    let ageS: number | null = null;
    if (v.lastSeen) {
      const ts = Date.parse(v.lastSeen);
      if (Number.isFinite(ts)) ageS = Math.round((now - ts) / 1000);
    }
    const ageMs = ageS === null ? Infinity : ageS * 1000;
    return {
      vessel_id: v.vesselId,
      vessel_name: v.vesselName ?? null,
      status: v.status ?? null,
      last_seen_iso: v.lastSeen ?? null,
      age_seconds: ageS,
      stale: ageMs > staleMs,
      shape_count: Array.isArray(v.shapes) ? v.shapes.length : 0,
    };
  });
  const staleCount = perVessel.filter((p) => p.stale).length;
  const healthyCount = perVessel.length - staleCount;
  // Only on a successful read: an unreachable or unparsed registry carries no missing_count, which a zero_field
  // check reads as unmeasured, never as "nothing missing".
  const missing = Array.isArray(pointer.vessel_ids)
    ? missingLocalVessels(pointer.vessel_ids.filter((v): v is string => typeof v === "string"), perVessel.map((p) => String(p.vessel_id ?? "")))
    : null;

  return {
    shape: "discoveryRegistryState",
    body: {
      endpoint,
      reachable: true,
      roundtrip_ms: roundtrip,
      total_vessels: perVessel.length,
      healthy_count: healthyCount,
      stale_count: staleCount,
      stale_threshold_ms: staleMs,
      per_vessel: perVessel,
      generated_at: new Date().toISOString(),
      ...(missing ? { missing_count: missing.length, missing_vessels: missing } : {}),
    },
  };
}
