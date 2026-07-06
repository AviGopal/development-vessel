import type { ResolverResult } from "./types.js";

const DEFAULT_DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const DEFAULT_ACTIVITY_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface VesselExerciseScanPointer {
  type: "vessel_exercise_scan";
  window_ms?: number;
  trace_limit?: number;
  resolution_limit?: number;
  emit_gap?: boolean;
  max_probes?: number;
  discoveryEndpoint?: string;
  activityEndpoint?: string;
  goalHostEndpoint?: string;
  devVesselImpulsesUrl?: string;
}

interface VesselRegistryEntry {
  vessel_id?: string;
  last_heartbeat?: string;
  advertised_shapes?: string[];
}

interface ExecutionTrace {
  execution_id?: string;
  vessel_id?: string;
  status?: string;
  started_at?: string;
}

interface ImpulseResolution {
  id?: string;
  vessel_id?: string;
  status?: string;
  created_at?: string;
}

interface VesselExerciseCell {
  vessel_id: string;
  last_heartbeat: string;
  last_exercised_at: string | null;
  age_ms: number | null;
  stale: boolean;
  probe_dispatched: boolean;
  probe_status: "success" | "failure" | "no_probe" | "missing_canonical_probe";
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  vessel_id: string,
  last_heartbeat: string,
  window_ms: number
): Promise<{ ok: boolean; status: number | "error" }> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `vessel-exercise-zero-coverage-${vessel_id}-${Date.now()}`,
          category: "vessel_exercise_zero_coverage",
          source: "substrate_detected",
          summary: `Connected vessel ${vessel_id} has zero successful exercise inside ${window_ms}ms window. Last heartbeat: ${last_heartbeat}. This is the obsidian_request_scan dormancy class — connected+heartbeating vessel, dead channel, undetected for extended period.`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "vessel_exercise_scan",
            vessel_id,
            last_heartbeat,
            window_ms,
            cite_principle: "outcomes_must_reflect_substantive_work",
            suggested_remediation: "Dispatch canonical health/self-test probe template via goal-host; if none exists, file author_producer need.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, status: "error" };
  }
}

async function dispatchProbe(
  goalHostEndpoint: string,
  apiKey: string,
  vessel_id: string
): Promise<{ ok: boolean; status: number | "error" }> {
  const body = {
    goal: `health check for vessel ${vessel_id}`,
    context: {
      vessel_id,
      probe_type: "canonical_health_check",
      dispatcher: "vessel_exercise_scan",
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(`${goalHostEndpoint}/run-goal`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, status: "error" };
  }
}

export async function resolveVesselExerciseScan(
  pointer: VesselExerciseScanPointer
): Promise<ResolverResult> {
  const discoveryEndpoint = pointer.discoveryEndpoint ?? DEFAULT_DISCOVERY_ENDPOINT;
  const activityEndpoint = pointer.activityEndpoint ?? DEFAULT_ACTIVITY_ENDPOINT;
  const goalHostEndpoint = pointer.goalHostEndpoint ?? DEFAULT_GOAL_HOST_ENDPOINT;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const window_ms = pointer.window_ms ?? DEFAULT_WINDOW_MS;
  const trace_limit = pointer.trace_limit ?? 500;
  const resolution_limit = pointer.resolution_limit ?? 500;
  const emit = pointer.emit_gap !== false;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const now = Date.now();
  const cutoff = now - window_ms;

  let vessels: VesselRegistryEntry[] = [];
  try {
    const regResp = await fetch(`${discoveryEndpoint}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}),
      },
      body: JSON.stringify({ pointer: { type: "vesselRegistry" } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (regResp.ok) {
      const regJson = (await regResp.json()) as {
        content?: { vessels?: Array<{ vesselId?: string; lastSeen?: string; shapes?: string[] }> };
        vessels?: Array<{ vesselId?: string; lastSeen?: string; shapes?: string[] }>;
      };
      vessels = (regJson.content?.vessels ?? regJson.vessels ?? []).map((v) => ({
        vessel_id: v.vesselId,
        last_heartbeat: v.lastSeen,
        advertised_shapes: v.shapes,
      }));
    }
  } catch {
    /* registry unreachable -> empty connected set */
  }

  const connectedVessels = vessels.filter((v) => {
    if (!v.vessel_id || !v.last_heartbeat) return false;
    const hb = new Date(v.last_heartbeat).getTime();
    return !isNaN(hb) && hb >= cutoff;
  });

  const tracesJson = await fetchJson<{ executions?: ExecutionTrace[] }>(
    `${activityEndpoint}/v2/activities/execution-traces?limit=${trace_limit}`,
    apiKey
  );
  const traces = tracesJson?.executions ?? [];

  const resolutionsJson = await fetchJson<{ resolutions?: ImpulseResolution[] }>(
    `${activityEndpoint}/v2/impulses/resolutions?limit=${resolution_limit}`,
    apiKey
  );
  const resolutions = resolutionsJson?.resolutions ?? [];

  const lastExercised = new Map<string, number>();

  for (const t of traces) {
    if (!t.vessel_id || t.status !== "success" || !t.started_at) continue;
    const ts = new Date(t.started_at).getTime();
    if (isNaN(ts)) continue;
    const existing = lastExercised.get(t.vessel_id);
    if (!existing || ts > existing) {
      lastExercised.set(t.vessel_id, ts);
    }
  }

  for (const r of resolutions) {
    if (!r.vessel_id || r.status !== "success" || !r.created_at) continue;
    const ts = new Date(r.created_at).getTime();
    if (isNaN(ts)) continue;
    const existing = lastExercised.get(r.vessel_id);
    if (!existing || ts > existing) {
      lastExercised.set(r.vessel_id, ts);
    }
  }

  const cells: VesselExerciseCell[] = [];
  const staleVessels: string[] = [];

  for (const v of connectedVessels) {
    const vessel_id = v.vessel_id!;
    const last_exercised_ts = lastExercised.get(vessel_id);
    const age_ms = last_exercised_ts ? now - last_exercised_ts : null;
    const stale = !last_exercised_ts || age_ms! > window_ms;

    cells.push({
      vessel_id,
      last_heartbeat: v.last_heartbeat!,
      last_exercised_at: last_exercised_ts ? new Date(last_exercised_ts).toISOString() : null,
      age_ms,
      stale,
      probe_dispatched: false,
      probe_status: "no_probe",
    });

    if (stale) {
      staleVessels.push(vessel_id);
    }
  }

  let probes_dispatched = 0;
  let probes_succeeded = 0;
  let probes_failed = 0;
  let gaps_emitted = 0;

  const max_probes = Math.min(Math.max(pointer.max_probes ?? 3, 0), 20);
  const staleOldestFirst = [...staleVessels].sort((a, b) => {
    const ageA = cells.find((c) => c.vessel_id === a)?.age_ms ?? Number.MAX_SAFE_INTEGER;
    const ageB = cells.find((c) => c.vessel_id === b)?.age_ms ?? Number.MAX_SAFE_INTEGER;
    return ageB - ageA;
  });
  for (const vessel_id of staleOldestFirst.slice(0, max_probes)) {
    const cell = cells.find((c) => c.vessel_id === vessel_id);
    if (!cell) continue;

    const probeResult = await dispatchProbe(goalHostEndpoint, apiKey, vessel_id);
    cell.probe_dispatched = true;
    probes_dispatched++;

    if (probeResult.ok) {
      cell.probe_status = "success";
      probes_succeeded++;
    } else {
      cell.probe_status = "failure";
      probes_failed++;

      if (emit) {
        const gapResult = await emitGap(
          emitUrl,
          apiKey,
          vessel_id,
          cell.last_heartbeat,
          window_ms
        );
        if (gapResult.ok) gaps_emitted++;
      }
    }
  }

  return {
    shape: "vesselExerciseReport",
    body: {
      connected_vessels: connectedVessels.length,
      stale_vessels: staleVessels.length,
      window_ms,
      probes_dispatched,
      probes_succeeded,
      probes_failed,
      gaps_emitted,
      cells,
      completed_at: new Date().toISOString(),
    },
  };
}
