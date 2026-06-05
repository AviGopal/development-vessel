import type { ResolverResult } from "./types.js";

/**
 * systemd_unit_health_observer — shadow-poll resolver promoting systemd unit
 * state into impulse form. Without this, vessel up/down state lives only in
 * `systemctl is-active` output the substrate cannot observe — failure traces
 * downstream of a wedged vessel carry symptoms but no root cause.
 *
 * Reads `systemctl is-active <unit>` for each substrate vessel and emits one
 * systemdUnitHealth impulse listing all vessels + their state. Boredom
 * dispatches on cadence so the orthogonality / validation audits see it.
 */

const DEFAULT_UNITS = [
  "discovery-vessel",
  "activity-api",
  "identity-vessel",
  "goal-host-vessel",
  "boredom-vessel",
  "development-vessel",
  "concept-db",
  "llm-resolver-vessel",
  "ribosome-vessel",
  "analysis-vessel",
  "light-dispatch-vessel",
];

export interface SystemdUnitHealthObserverPointer {
  type: "systemd_unit_health_observer";
  units?: string[];
}

interface UnitState {
  unit: string;
  active_state: string;
  active_enter_iso: string | null;
}

async function probeUnit(unit: string): Promise<UnitState> {
  const full = unit.endsWith(".service") ? unit : `${unit}.service`;
  try {
    const proc = Bun.spawn(
      ["systemctl", "show", full, "-p", "ActiveState", "-p", "ActiveEnterTimestamp"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    let activeState = "unknown";
    let activeEnter: string | null = null;
    for (const line of stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === "ActiveState") activeState = v || "unknown";
      else if (k === "ActiveEnterTimestamp") activeEnter = v || null;
    }
    return { unit, active_state: activeState, active_enter_iso: activeEnter };
  } catch {
    return { unit, active_state: "probe_error", active_enter_iso: null };
  }
}

export async function resolveSystemdUnitHealthObserver(
  pointer: SystemdUnitHealthObserverPointer,
): Promise<ResolverResult> {
  const units = pointer.units && pointer.units.length > 0 ? pointer.units : DEFAULT_UNITS;
  const states = await Promise.all(units.map(probeUnit));
  const active = states.filter((s) => s.active_state === "active").length;
  const failed = states.filter((s) => s.active_state === "failed").length;
  const inactive = states.filter(
    (s) => s.active_state === "inactive" || s.active_state === "dead",
  ).length;
  return {
    shape: "systemdUnitHealth",
    body: {
      units: states,
      total: states.length,
      active_count: active,
      failed_count: failed,
      inactive_count: inactive,
      all_active: failed === 0 && inactive === 0 && active === states.length,
      generated_at: new Date().toISOString(),
    },
  };
}
