import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * service_oom_cascade_scan — deterministic detector + emitter for the
 * service-level OOM cascade class (concept_RYl73llSCGfc /
 * concept_6RwK5H5F28hT / concept_s9ye5GKLw2L8 / concept_T-CTTOEl97IM).
 *
 * The pattern: a vessel (typically goal-host-vessel) accumulates in-flight
 * promise / bus-forward work without backpressure, the cgroup OOM-killer
 * fires, systemd restarts the unit, and the cycle repeats. The bug class
 * has consumed 7 hunt iterations without resolution because the substrate
 * had no first-class detector for it — restarts and memory growth were
 * only ever visible via ad-hoc `journalctl` / `systemctl show` from the
 * operator side.
 *
 * Detection signature (any one of three thresholds):
 *   - NRestarts grew by > 3 since the previous scan within the last hour
 *     (rapid-restart loop — the cgroup is sawtoothing)
 *   - MemoryCurrent > 4 GB (single-process memory pressure beyond any
 *     reasonable per-vessel budget for this stack)
 *   - MemoryCurrent grew by > 500 MB since the previous scan (acute leak
 *     in the inter-scan window — caught even when absolute is still low)
 *
 * Why one resolver does the whole flow (immunity pattern):
 *   1. Single-task seed template + single server-side resolver = the
 *      detector cannot itself fall into the F25 multi-task abort pattern.
 *   2. `inputShapes: []` and `variables: []` on the seed template — no
 *      pool dependencies, so the engine pre-flight cannot reject it
 *      (`concept_pFSLV6s5s3lQ`, `concept_Y2zGpFNBrcgb`).
 *   3. No `iteration` resolver chain, no `llm_completion_dispatch`. The
 *      Bun.spawn shell-out + parse + post happen inside this function.
 *
 * Runs inside substrate-live as part of development-vessel. systemctl is
 * directly accessible because the vessel runs in the container; no docker
 * exec needed.
 *
 * State: keeps a small cache at `${WORKSPACE_ROOT}/.oom-detector/state.json`
 * mapping service → previous-scan (NRestarts, MemoryCurrent, scannedAt).
 * Delta thresholds require a prior baseline; first run only emits on
 * absolute thresholds (memory > 4 GB, but never on delta — there is no
 * delta yet — and never on restartsLastHour since the prior NRestarts is
 * unknown).
 *
 * Constitutional principle: every observed bug class becomes a detection
 * template, not just a patched instance (concept_9ldsmRgqSTd5).
 *
 * Follow-ups deliberately deferred:
 *   - Per-vessel /debug/mem endpoint exposing process.memoryUsage() so
 *     this detector can compute the cgroup-vs-RSS divergence per
 *     concept_T-CTTOEl97IM. Without it we fall back to systemctl-only
 *     thresholds, which is still the dominant signal for the cascade
 *     class but misses Bun-native leaks where the JS heap is small but
 *     external buffers grow.
 *   - Boredom-vessel goal rotation: add at a 30-minute slot. Operator
 *     action when substrate recovers.
 */

export interface ServiceOomCascadeScanPointer {
  type: "service_oom_cascade_scan";
  /** Override service list. Default: DEFAULT_SERVICES. */
  services?: string[];
  /** Override dev-vessel impulses URL. */
  devVesselImpulsesUrl?: string;
  /** Override cache state file path. */
  statePath?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
  /** Cap on emitted gaps per invocation. Default 20. */
  maxEmits?: number;
  /** Restart-count delta threshold within last hour. Default 3. */
  restartThreshold?: number;
  /** Absolute memory threshold (bytes). Default 4 GB. */
  memoryAbsoluteThresholdBytes?: number;
  /** Memory delta threshold since last scan (bytes). Default 500 MB. */
  memoryDeltaThresholdBytes?: number;
}

export const DEFAULT_SERVICES = [
  "goal-host-vessel",
  "development-vessel",
  "activity-api",
  "concept-db",
  "analysis-vessel",
  "llm-resolver-vessel",
  "discovery-vessel",
  "ribosome-vessel",
  "boredom-vessel",
  "identity-vessel",
] as const;

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_STATE_PATH = "/workspace/.oom-detector/state.json";
const DEFAULT_MAX_EMITS = 20;
const DEFAULT_RESTART_THRESHOLD = 3;
const DEFAULT_MEMORY_ABS_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MEMORY_DELTA_BYTES = 500 * 1024 * 1024;

interface ServiceState {
  NRestarts: number;
  MemoryCurrent: number;
  /** ISO timestamp of when this scan recorded it. */
  scannedAt: string;
}

interface ParsedSystemctlShow {
  NRestarts: number | null;
  MemoryCurrent: number | null;
  ActiveEnterTimestamp: string | null;
}

interface Finding {
  service: string;
  reasons: string[];
  restartsSinceLast: number | null;
  memoryBytes: number | null;
  memoryMB: number | null;
  deltaBytes: number | null;
  deltaMB: number | null;
  activeEnterTimestamp: string | null;
  gap_id: string;
  posted: boolean;
  post_status?: number | "error";
  post_error?: string;
}

interface ScanPorts {
  /** Run `systemctl show <unit> -p ...` and return stdout (or null on failure). */
  systemctlShow: (unit: string) => Promise<string | null>;
  /** Read the cache JSON; return {} when missing. */
  readCache: (path: string) => Promise<Record<string, ServiceState>>;
  /** Write the cache JSON atomically. */
  writeCache: (path: string, data: Record<string, ServiceState>) => Promise<void>;
  /** POST a substrateGap_write body to dev-vessel; return status code. */
  postGap: (
    url: string,
    body: unknown,
  ) => Promise<{ ok: boolean; status: number | "error"; error?: string }>;
}

const realPorts: ScanPorts = {
  systemctlShow: async (unit) => {
    try {
      const proc = Bun.spawn(
        [
          "systemctl",
          "show",
          unit.endsWith(".service") ? unit : `${unit}.service`,
          "-p",
          "ActiveEnterTimestamp",
          "-p",
          "MemoryCurrent",
          "-p",
          "NRestarts",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) return null;
      return stdout;
    } catch {
      return null;
    }
  },
  readCache: async (path) => {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, ServiceState>;
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch {
      return {};
    }
  },
  writeCache: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    // Best-effort atomic rename. Node fs.promises rename is atomic on POSIX.
    const { rename } = await import("node:fs/promises");
    await rename(tmp, path);
  },
  postGap: async (url, body) => {
    const apiKey = process.env["METABOB_API_KEY"];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, status: resp.status, error: text.slice(0, 200) };
      }
      return { ok: true, status: resp.status };
    } catch (err) {
      return { ok: false, status: "error", error: (err as Error).message };
    }
  },
};

export function parseSystemctlShow(stdout: string): ParsedSystemctlShow {
  const out: ParsedSystemctlShow = {
    NRestarts: null,
    MemoryCurrent: null,
    ActiveEnterTimestamp: null,
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "NRestarts") {
      const n = parseInt(value, 10);
      out.NRestarts = Number.isFinite(n) ? n : null;
    } else if (key === "MemoryCurrent") {
      // systemd uses "[not set]" for unbounded; numeric otherwise.
      if (value === "[not set]" || value === "" || value === "18446744073709551615") {
        out.MemoryCurrent = null;
      } else {
        const n = parseInt(value, 10);
        out.MemoryCurrent = Number.isFinite(n) ? n : null;
      }
    } else if (key === "ActiveEnterTimestamp") {
      out.ActiveEnterTimestamp = value || null;
    }
  }
  return out;
}

export async function resolveServiceOomCascadeScan(
  pointer: ServiceOomCascadeScanPointer,
  ports: ScanPorts = realPorts,
): Promise<ResolverResult> {
  const services =
    pointer.services && pointer.services.length > 0
      ? pointer.services
      : [...DEFAULT_SERVICES];
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const statePath = pointer.statePath ?? DEFAULT_STATE_PATH;
  const dryRun = pointer.dry_run === true;
  const maxEmits = pointer.maxEmits ?? DEFAULT_MAX_EMITS;
  const restartThreshold = pointer.restartThreshold ?? DEFAULT_RESTART_THRESHOLD;
  const memoryAbsBytes =
    pointer.memoryAbsoluteThresholdBytes ?? DEFAULT_MEMORY_ABS_BYTES;
  const memoryDeltaBytes =
    pointer.memoryDeltaThresholdBytes ?? DEFAULT_MEMORY_DELTA_BYTES;

  const cache = await ports.readCache(statePath);
  const nextCache: Record<string, ServiceState> = { ...cache };
  const findings: Finding[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  let scanned = 0;
  let probeFailures = 0;

  for (const svc of services) {
    const stdout = await ports.systemctlShow(svc);
    if (stdout == null) {
      probeFailures += 1;
      continue;
    }
    scanned += 1;
    const parsed = parseSystemctlShow(stdout);
    if (parsed.NRestarts == null && parsed.MemoryCurrent == null) {
      // Unit existed but returned no usable fields — skip without false-positive.
      continue;
    }

    const prior = cache[svc];
    const reasons: string[] = [];

    // Memory absolute threshold (no prior required).
    if (parsed.MemoryCurrent != null && parsed.MemoryCurrent > memoryAbsBytes) {
      reasons.push(
        `memory_absolute=${(parsed.MemoryCurrent / 1e6).toFixed(1)}MB > ${(memoryAbsBytes / 1e6).toFixed(0)}MB`,
      );
    }

    let restartsSinceLast: number | null = null;
    let deltaBytes: number | null = null;

    if (prior) {
      // Restart delta — proxy for "last hour" when scanned at hourly cadence.
      // We don't gate on a literal hour window because that would require
      // sub-scan timestamping per restart; the substrate's scan interval is
      // the natural window.
      if (parsed.NRestarts != null && typeof prior.NRestarts === "number") {
        restartsSinceLast = parsed.NRestarts - prior.NRestarts;
        if (restartsSinceLast > restartThreshold) {
          reasons.push(
            `restarts_since_last=${restartsSinceLast} > ${restartThreshold}`,
          );
        }
      }
      // Memory delta — only meaningful with a prior baseline.
      if (
        parsed.MemoryCurrent != null &&
        typeof prior.MemoryCurrent === "number"
      ) {
        deltaBytes = parsed.MemoryCurrent - prior.MemoryCurrent;
        if (deltaBytes > memoryDeltaBytes) {
          reasons.push(
            `memory_delta=${(deltaBytes / 1e6).toFixed(1)}MB > ${(memoryDeltaBytes / 1e6).toFixed(0)}MB`,
          );
        }
      }
    }

    // Update next cache regardless of finding.
    if (parsed.NRestarts != null && parsed.MemoryCurrent != null) {
      nextCache[svc] = {
        NRestarts: parsed.NRestarts,
        MemoryCurrent: parsed.MemoryCurrent,
        scannedAt: nowIso,
      };
    }

    if (reasons.length === 0) continue;

    findings.push({
      service: svc,
      reasons,
      restartsSinceLast,
      memoryBytes: parsed.MemoryCurrent,
      memoryMB:
        parsed.MemoryCurrent == null ? null : parsed.MemoryCurrent / 1e6,
      deltaBytes,
      deltaMB: deltaBytes == null ? null : deltaBytes / 1e6,
      activeEnterTimestamp: parsed.ActiveEnterTimestamp,
      gap_id: `service-oom-cascade-${svc}-${today}`,
      posted: false,
    });
  }

  // Sort by severity proxy: number of reasons desc, then memory desc.
  findings.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) {
      return b.reasons.length - a.reasons.length;
    }
    return (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0);
  });

  const toEmit = findings.slice(0, maxEmits);

  if (!dryRun) {
    for (const entry of toEmit) {
      const body = {
        impulse: {
          pointer: {
            type: "substrateGap_write",
            gap: {
              id: entry.gap_id,
              category: "missing_concept",
              source: "substrate_detected",
              summary:
                `Service ${entry.service} tripped OOM-cascade thresholds: ` +
                entry.reasons.join("; ") +
                ". Likely root: bus-forward backpressure absence (concept_RYl73llSCGfc, " +
                "concept_6RwK5H5F28hT, concept_T-CTTOEl97IM).",
              detected_at: nowIso,
              status: "open",
              classification_metadata: {
                gap_subtype: "service_oom_cascade",
                service: entry.service,
                reasons: entry.reasons,
                restarts_since_last: entry.restartsSinceLast,
                memory_mb: entry.memoryMB,
                delta_mb: entry.deltaMB,
                active_enter_timestamp: entry.activeEnterTimestamp,
                fix_priors: [
                  "concept_RYl73llSCGfc",
                  "concept_6RwK5H5F28hT",
                  "concept_s9ye5GKLw2L8",
                  "concept_T-CTTOEl97IM",
                ],
              },
            },
          },
        },
      };
      const resp = await ports.postGap(emitUrl, body);
      entry.posted = resp.ok;
      entry.post_status = resp.status;
      if (!resp.ok && resp.error) entry.post_error = resp.error;
    }
  }

  // Persist cache for next scan. Errors are non-fatal — better to lose one
  // scan's baseline than to abort the detector.
  try {
    await ports.writeCache(statePath, nextCache);
  } catch {
    // swallow
  }

  return {
    shape: "serviceOomReport",
    body: {
      scanned,
      probe_failures: probeFailures,
      services_with_findings: findings.length,
      emitted: toEmit.filter((f) => f.posted).length,
      findings: toEmit,
      dry_run: dryRun,
      thresholds: {
        restart: restartThreshold,
        memory_absolute_bytes: memoryAbsBytes,
        memory_delta_bytes: memoryDeltaBytes,
      },
      completed_at: nowIso,
    },
  };
}
