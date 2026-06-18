import type { ResolverResult } from "./types.js";
import { METABOB_API_KEY } from "../config.js";

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

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
  /** Emit a substrateGap per failing unit (default true) so detection feeds the
   *  funnel, not just an observation impulse. */
  emit_gap?: boolean;
  devVesselImpulsesUrl?: string;
}

interface UnitState {
  unit: string;
  active_state: string;
  active_enter_iso: string | null;
  // last-run outcome — the load-bearing signal for ONESHOT timer services, which
  // are legitimately "inactive/dead" between runs but "failed" / Result!=success
  // when their last run errored. ActiveState alone hides a oneshot that fails
  // every fire (e.g. composition-edge-reconcile aborting on a bad UPSERT for
  // weeks while reading "inactive").
  result: string;
  exec_main_status: number | null;
  is_oneshot: boolean;
}

async function probeUnit(unit: string): Promise<UnitState> {
  const full = unit.endsWith(".service") ? unit : `${unit}.service`;
  try {
    const proc = Bun.spawn(
      ["systemctl", "show", full, "-p", "ActiveState", "-p", "ActiveEnterTimestamp",
       "-p", "Result", "-p", "ExecMainStatus", "-p", "Type"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    let activeState = "unknown";
    let activeEnter: string | null = null;
    let result = "unknown";
    let execMainStatus: number | null = null;
    let unitType = "";
    for (const line of stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === "ActiveState") activeState = v || "unknown";
      else if (k === "ActiveEnterTimestamp") activeEnter = v || null;
      else if (k === "Result") result = v || "unknown";
      else if (k === "ExecMainStatus") execMainStatus = v === "" ? null : Number(v);
      else if (k === "Type") unitType = v || "";
    }
    return { unit, active_state: activeState, active_enter_iso: activeEnter, result, exec_main_status: execMainStatus, is_oneshot: unitType === "oneshot" };
  } catch {
    return { unit, active_state: "probe_error", active_enter_iso: null, result: "probe_error", exec_main_status: null, is_oneshot: false };
  }
}

// Discover every .service activated by a .timer so the observer covers the
// substrate's oneshot maintenance fleet (reconcilers, audits, generators),
// not just the long-running vessels. Returns bare service names (no .service).
async function discoverTimerServices(): Promise<string[]> {
  try {
    const proc = Bun.spawn(["systemctl", "list-timers", "--all", "--no-legend", "--no-pager"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const svcs = new Set<string>();
    for (const line of out.split("\n")) {
      const m = line.match(/([A-Za-z0-9@._-]+)\.service\b/);
      if (m) svcs.add(m[1]!);
    }
    return [...svcs];
  } catch {
    return [];
  }
}

// Last error/failure line from the unit's journal — makes the emitted gap
// actionable (exit 127 = command-not-found, 203 = exec/permission, etc.).
async function journalError(unit: string): Promise<string> {
  const full = unit.endsWith(".service") ? unit : `${unit}.service`;
  try {
    const proc = Bun.spawn(["journalctl", "-u", full, "-n", "15", "--no-pager", "-o", "cat"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.trim());
    const errLine = [...lines].reverse().find((l) => /error|fail|not found|cannot|no such|exception|denied|status=\d/i.test(l));
    return (errLine ?? lines[lines.length - 1] ?? "").slice(0, 300);
  } catch {
    return "";
  }
}

// Emit one substrateGap per failing unit so the substrate self-RESOLVES (or at
// least records) the failure instead of it staying silent. Same contract as
// capability-gap-audit's emitGap.
async function emitServiceGap(
  emitUrl: string,
  apiKey: string,
  info: { unit: string; result: string; exec_main_status: number | null; error: string },
): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: `service-failure-${info.unit}`,
          category: "service_failure",
          source: "substrate_detected",
          status: "open",
          summary: `systemd unit ${info.unit}.service failed (Result=${info.result}, exit=${info.exec_main_status}). Last log: ${info.error.slice(0, 160)}`,
          detected_at: new Date().toISOString(),
          classification_metadata: {
            detector: "systemd_unit_health_observer",
            cite_principle: "a_maintenance_unit_that_fails_every_run_is_a_silent_learning_loss",
            unit: info.unit,
            result: info.result,
            exit_code: info.exec_main_status,
            last_log: info.error,
            // harm: a broken reconciler/generator/audit silently starves the loop
            success_rate: 0,
            samples: 5,
            suggested_remediation: "Inspect the unit's ExecStart + journal; exit 127=command/path missing, 203=exec/permission, non-zero=runtime error. Fix the script/unit or the env it depends on.",
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolveSystemdUnitHealthObserver(
  pointer: SystemdUnitHealthObserverPointer,
): Promise<ResolverResult> {
  // Explicit `units` = watch EXACTLY those (caller override, e.g. tests/probes).
  // Default cadence path = the long-running vessel list UNION every timer-
  // activated service, so the oneshot maintenance fleet is covered (the gap that
  // hid composition-edge-reconcile failing every run).
  const explicitUnits = pointer.units && pointer.units.length > 0;
  const timerSvcs = explicitUnits ? [] : await discoverTimerServices();
  const watch = explicitUnits
    ? pointer.units!
    : [...new Set([...DEFAULT_UNITS, ...timerSvcs])];
  const states = await Promise.all(watch.map(probeUnit));
  const active = states.filter((s) => s.active_state === "active").length;
  const failed = states.filter((s) => s.active_state === "failed").length;
  const inactive = states.filter(
    (s) => s.active_state === "inactive" || s.active_state === "dead",
  ).length;
  // failing = ActiveState failed (any unit) OR a oneshot whose LAST RUN errored
  // (Result not success / non-zero exit) even though it now reads inactive/dead.
  const failingStates = states.filter(
    (s) =>
      s.active_state === "failed" ||
      (s.is_oneshot && s.result !== "success" && s.result !== "unknown" && s.result !== "" ) ||
      (s.is_oneshot && typeof s.exec_main_status === "number" && s.exec_main_status !== 0),
  );
  const failed_units = failingStates.map((s) => ({
    unit: s.unit,
    active_state: s.active_state,
    result: s.result,
    exec_main_status: s.exec_main_status,
  }));
  // Vessels (non-oneshot) must be active; oneshot maintenance units must not be
  // in a failed last-run. Healthy when neither condition is violated.
  const vesselDown = states.filter((s) => !s.is_oneshot && s.active_state !== "active" && timerSvcs.indexOf(s.unit) < 0);
  // Emit one substrateGap per failing unit so detection feeds the funnel.
  let gaps_emitted = 0;
  const emit = pointer.emit_gap !== false;
  if (emit && failingStates.length > 0) {
    const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
    const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;
    for (const f of failingStates) {
      const error = await journalError(f.unit);
      const ok = await emitServiceGap(emitUrl, apiKey, { unit: f.unit, result: f.result, exec_main_status: f.exec_main_status, error });
      if (ok) gaps_emitted++;
    }
  }
  return {
    shape: "systemdUnitHealth",
    body: {
      units: states,
      total: states.length,
      active_count: active,
      failed_count: failed,
      inactive_count: inactive,
      // The actionable signal — units whose last run failed (incl. oneshot
      // timers). Emitted as substrateGaps so the substrate self-detects + acts
      // instead of the failure staying silent (the class that hid
      // composition-edge-reconcile aborting every run for weeks).
      failing_count: failed_units.length,
      failed_units,
      gaps_emitted,
      timer_services_watched: timerSvcs.length,
      all_healthy: failed_units.length === 0 && vesselDown.length === 0,
      all_active: failed === 0 && inactive === 0 && active === states.length,
      generated_at: new Date().toISOString(),
    },
  };
}
