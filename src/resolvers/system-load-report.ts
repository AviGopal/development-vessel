import { readFile } from "fs/promises";
import type { ResolverResult } from "./types.js";

export interface SystemLoadReportPointer {
  type: "system_load_report";
  /**
   * Number of CPU cores allocated to this container/system. The load anomaly
   * threshold is `cores * load_anomaly_factor`. Default: read from
   * /proc/cpuinfo (fallback 4).
   */
  cpu_cores?: number;
  /**
   * Load-average / cpu-cores ratio above which `load_anomaly=true` is set.
   * Default 2.0 (load > 2x cores). Sustained load above 1.0 means CPU
   * saturation; 2.0 means severe contention.
   */
  load_anomaly_factor?: number;
  /**
   * Memory-used percentage above which `memory_anomaly=true` is set.
   * Default 85% (matches OOM-killer warning threshold).
   */
  memory_anomaly_pct?: number;
}

interface CpuStat {
  usage_usec: number | null;
  user_usec: number | null;
  system_usec: number | null;
}

async function readFirstLine(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path, "utf-8");
    return buf.split("\n", 1)[0] ?? null;
  } catch {
    return null;
  }
}

async function readKeyedFile(
  path: string,
  keys: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const buf = await readFile(path, "utf-8");
    for (const line of buf.split("\n")) {
      for (const k of keys) {
        if (line.startsWith(`${k} `)) {
          const parts = line.trim().split(/\s+/);
          const val = parts[1] !== undefined ? parseFloat(parts[1]) : NaN;
          if (!Number.isNaN(val)) out[k] = val;
        }
      }
    }
  } catch {
    // ignore — caller checks presence
  }
  return out;
}

async function readCpuCores(): Promise<number> {
  try {
    const buf = await readFile("/proc/cpuinfo", "utf-8");
    return buf.split("\n").filter((l) => l.startsWith("processor")).length || 4;
  } catch {
    return 4;
  }
}

/**
 * Substrate self-observation of resource state. Reads /proc/loadavg,
 * /proc/meminfo, and cgroup cpu.stat to surface CPU/memory load.
 *
 * Why this exists: the substrate-self-detection family (phantom_trace_scan,
 * trace_failure_pattern_report, precondition_rejection_scan, ...) cannot
 * detect resource pathologies in its own composition because all of those
 * resolvers query activity-api / SurrealDB — exactly the layer that gets
 * pegged when amplification cascades occur. iter-086 hit 1315% CPU and
 * 93% memory before the operator noticed via docker stats; the substrate
 * had no internal observation surface for its own load.
 *
 * Output: systemLoadReport with raw metrics + boolean anomaly flags. Activities
 * compose with this resolver and emit substrateGap when anomalies persist
 * across multiple readings, completing the substrate-self-detection loop for
 * the resource-exhaustion class of bugs.
 */
export async function resolveSystemLoadReport(
  pointer: SystemLoadReportPointer,
): Promise<ResolverResult> {
  const loadFactor = pointer.load_anomaly_factor ?? 2.0;
  const memPctThreshold = pointer.memory_anomaly_pct ?? 85;

  // 1. Load averages.
  const loadLine = await readFirstLine("/proc/loadavg");
  let load1m: number | null = null;
  let load5m: number | null = null;
  let load15m: number | null = null;
  if (loadLine) {
    const parts = loadLine.split(/\s+/);
    load1m = parts[0] !== undefined ? parseFloat(parts[0]) : null;
    load5m = parts[1] !== undefined ? parseFloat(parts[1]) : null;
    load15m = parts[2] !== undefined ? parseFloat(parts[2]) : null;
  }

  // 2. Memory.
  const mem = await readKeyedFile("/proc/meminfo", [
    "MemTotal:",
    "MemAvailable:",
    "Cached:",
    "Buffers:",
  ]);
  const memTotal = mem["MemTotal:"] ?? null;
  const memAvailable = mem["MemAvailable:"] ?? null;
  const memUsedPct =
    memTotal !== null && memAvailable !== null
      ? ((memTotal - memAvailable) / memTotal) * 100
      : null;

  // 3. cgroup CPU stat (cumulative microseconds since process/container start).
  // Caller can take two readings spaced N seconds apart and compute rate.
  const cpuStat: CpuStat = { usage_usec: null, user_usec: null, system_usec: null };
  try {
    const buf = await readFile("/sys/fs/cgroup/cpu.stat", "utf-8");
    for (const line of buf.split("\n")) {
      const [k, v] = line.trim().split(/\s+/, 2);
      const val = v !== undefined ? parseInt(v, 10) : NaN;
      if (Number.isNaN(val)) continue;
      if (k === "usage_usec") cpuStat.usage_usec = val;
      else if (k === "user_usec") cpuStat.user_usec = val;
      else if (k === "system_usec") cpuStat.system_usec = val;
    }
  } catch {
    // pre-cgroup-v2 systems or missing — return nulls
  }

  // 4. cgroup memory current/max.
  const memCgroupCurrent = await readFirstLine("/sys/fs/cgroup/memory.current");
  const memCgroupMax = await readFirstLine("/sys/fs/cgroup/memory.max");
  const memCgroupCurrentBytes = memCgroupCurrent ? parseInt(memCgroupCurrent, 10) : null;
  // memory.max returns "max" when unlimited at cgroup level (container limit
  // comes from docker host). In that case we trust /proc/meminfo MemTotal.
  const memCgroupMaxBytes =
    memCgroupMax && memCgroupMax !== "max" ? parseInt(memCgroupMax, 10) : null;

  // 5. Anomaly detection.
  const cores = pointer.cpu_cores ?? (await readCpuCores());
  const loadThreshold = cores * loadFactor;
  const load_anomaly =
    load5m !== null && load5m > loadThreshold;
  const load_anomaly_severe =
    load15m !== null && load15m > loadThreshold * 2;
  const memory_anomaly =
    memUsedPct !== null && memUsedPct > memPctThreshold;

  return {
    shape: "systemLoadReport",
    body: {
      load_avg_1m: load1m,
      load_avg_5m: load5m,
      load_avg_15m: load15m,
      cpu_cores: cores,
      load_threshold: loadThreshold,
      mem_total_kb: memTotal,
      mem_available_kb: memAvailable,
      mem_used_pct: memUsedPct !== null ? Math.round(memUsedPct * 10) / 10 : null,
      mem_cgroup_current_bytes: memCgroupCurrentBytes,
      mem_cgroup_max_bytes: memCgroupMaxBytes,
      cpu_stat_cumulative: cpuStat,
      // Anomaly flags — activities consume these to decide whether to emit substrateGap.
      load_anomaly,
      load_anomaly_severe,
      memory_anomaly,
      anomaly_count: [load_anomaly, load_anomaly_severe, memory_anomaly].filter(Boolean).length,
      generated_at: new Date().toISOString(),
    },
  };
}
