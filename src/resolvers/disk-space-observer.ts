import type { ResolverResult } from "./types.js";

/**
 * disk_space_observer (round 2, 2026-06-05) — promotes disk-pressure into
 * impulse form. Substrate vessels write traces, mitosis stages, and patches to
 * /workspace and /vessels constantly; a filled disk wedges everything but the
 * cause shows up as cryptic ENOSPC errors in downstream traces, not as a
 * substrate-observable signal.
 *
 * Runs `df -k` against the configured mounts and emits diskSpaceState with
 * available/used and a green/yellow/red pressure level per mount.
 */

const DEFAULT_MOUNTS = ["/workspace", "/vessels", "/"];

export interface DiskSpaceObserverPointer {
  type: "disk_space_observer";
  mounts?: string[];
  yellowThresholdPct?: number;
  redThresholdPct?: number;
}

interface MountState {
  mount: string;
  total_kb: number | null;
  used_kb: number | null;
  available_kb: number | null;
  used_pct: number | null;
  pressure_level: "green" | "yellow" | "red" | "unknown";
  error: string | null;
}

function classify(usedPct: number, yellow: number, red: number): "green" | "yellow" | "red" {
  if (usedPct >= red) return "red";
  if (usedPct >= yellow) return "yellow";
  return "green";
}

async function probeMount(
  mount: string,
  yellow: number,
  red: number,
): Promise<MountState> {
  try {
    const proc = Bun.spawn(["df", "-k", "-P", mount], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.trim().split("\n");
    // Expect: header + one data row.
    if (lines.length < 2) {
      return {
        mount,
        total_kb: null,
        used_kb: null,
        available_kb: null,
        used_pct: null,
        pressure_level: "unknown",
        error: "no_data_row",
      };
    }
    const cols = lines[1]!.trim().split(/\s+/);
    // Filesystem 1024-blocks Used Available Capacity Mounted-on
    const total = parseInt(cols[1] ?? "", 10);
    const used = parseInt(cols[2] ?? "", 10);
    const avail = parseInt(cols[3] ?? "", 10);
    const pctRaw = cols[4] ?? "";
    const pct = parseInt(pctRaw.replace("%", ""), 10);
    if (!Number.isFinite(total) || !Number.isFinite(pct)) {
      return {
        mount,
        total_kb: null,
        used_kb: null,
        available_kb: null,
        used_pct: null,
        pressure_level: "unknown",
        error: "parse_error",
      };
    }
    return {
      mount,
      total_kb: total,
      used_kb: Number.isFinite(used) ? used : null,
      available_kb: Number.isFinite(avail) ? avail : null,
      used_pct: pct,
      pressure_level: classify(pct, yellow, red),
      error: null,
    };
  } catch (err) {
    return {
      mount,
      total_kb: null,
      used_kb: null,
      available_kb: null,
      used_pct: null,
      pressure_level: "unknown",
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

export async function resolveDiskSpaceObserver(
  pointer: DiskSpaceObserverPointer,
): Promise<ResolverResult> {
  const mounts = pointer.mounts ?? DEFAULT_MOUNTS;
  const yellow = pointer.yellowThresholdPct ?? 75;
  const red = pointer.redThresholdPct ?? 90;
  const states = await Promise.all(mounts.map((m) => probeMount(m, yellow, red)));
  const worst = states.reduce<"green" | "yellow" | "red" | "unknown">((acc, s) => {
    const order = { green: 0, yellow: 1, red: 2, unknown: -1 } as const;
    return order[s.pressure_level] > order[acc] ? s.pressure_level : acc;
  }, "green");
  return {
    shape: "diskSpaceState",
    body: {
      mounts: states,
      worst_pressure_level: worst,
      any_red: states.some((s) => s.pressure_level === "red"),
      any_yellow: states.some((s) => s.pressure_level === "yellow"),
      yellow_threshold_pct: yellow,
      red_threshold_pct: red,
      generated_at: new Date().toISOString(),
    },
  };
}
