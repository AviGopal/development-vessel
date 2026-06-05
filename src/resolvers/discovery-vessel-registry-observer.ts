import type { ResolverResult } from "./types.js";

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

export async function resolveDiscoveryVesselRegistryObserver(
  pointer: DiscoveryVesselRegistryObserverPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const staleMs = pointer.staleThresholdMs ?? 5 * 60 * 1000;
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

  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`,
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
    },
  };
}
