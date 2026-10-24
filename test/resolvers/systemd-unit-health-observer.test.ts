import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { resolveSystemdUnitHealthObserver } from "../../src/resolvers/systemd-unit-health-observer.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

// The observer's systemctl and journalctl reads are answered by exec-guard routes, never the real tools: the node gate
// runs this file inside the live container, where the live units' state would decide every assertion. A fixed fleet:
// every long-running vessel active, plus two timer-activated oneshots, one of whose last run exited 1.
const TIMERS = [
  "Sat 2026-10-24 10:00:00 UTC 5min left Sat 2026-10-24 09:00:00 UTC 55min ago edge-reconcile.timer edge-reconcile.service",
  "Sat 2026-10-24 11:00:00 UTC 1h left   Sat 2026-10-24 10:00:00 UTC 5min ago  lifecycle-audit.timer lifecycle-audit.service",
].join("\n");
const SHOW: Record<string, string> = {
  "edge-reconcile.service": "ActiveState=inactive\nActiveEnterTimestamp=\nResult=exit-code\nExecMainStatus=1\nType=oneshot",
  "lifecycle-audit.service": "ActiveState=inactive\nActiveEnterTimestamp=\nResult=success\nExecMainStatus=0\nType=oneshot",
};
const ACTIVE = "ActiveState=active\nActiveEnterTimestamp=Sat 2026-10-24 08:00:00 UTC\nResult=success\nExecMainStatus=0\nType=simple";
const NOT_FOUND = "ActiveState=inactive\nActiveEnterTimestamp=\nResult=success\nExecMainStatus=0\nType=";

let guard: ExecGuard;
beforeEach(() => {
  guard = installCutoverExecGuard();
  guard.route({ name: "list-timers", match: (c) => /systemctl list-timers/.test(c), respond: () => ({ exitCode: 0, stdout: TIMERS }) });
  guard.route({
    name: "show",
    match: (c) => /systemctl show /.test(c),
    respond: (c) => {
      const unit = c.split(/\s+/)[2] ?? "";
      if (unit in SHOW) return { exitCode: 0, stdout: SHOW[unit]! };
      return { exitCode: 0, stdout: /nonexistent|not-a-real/.test(unit) ? NOT_FOUND : ACTIVE };
    },
  });
  guard.route({ name: "journalctl", match: (c) => /journalctl /.test(c), respond: () => ({ exitCode: 0, stdout: "edge-reconcile: UPSERT failed: status=1\n" }) });
});
afterEach(() => { expect(guard.restore()).toEqual([]); });
afterAll(() => restoreCutoverExecModules());

describe("systemd_unit_health_observer", () => {
  it("returns systemdUnitHealth shape with all expected fields (explicit units = exactly those)", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      units: ["nonexistent-unit-zzz-abc"],
      emit_gap: false, // don't attempt a network emit in unit tests
    });
    expect(result.shape).toBe("systemdUnitHealth");
    const body = result.body as {
      units: Array<{ unit: string; active_state: string; result: string; is_oneshot: boolean }>;
      total: number;
      failing_count: number;
      gaps_emitted: number;
      generated_at: string;
    };
    // explicit units override → exactly the one requested, no timer-fleet union
    expect(body.units).toHaveLength(1);
    expect(body.units[0]!.unit).toBe("nonexistent-unit-zzz-abc");
    expect(body.units[0]!.active_state).toBe("inactive");
    expect(body.units[0]!.result).toBe("success"); // last-run outcome field
    expect(body.total).toBe(1);
    expect(body.failing_count).toBe(0);
    expect(typeof body.generated_at).toBe("string");
    expect(guard.hits).toEqual(["show"]); // explicit units: no list-timers read
  });

  it("defaults to vessels UNION the timer-service fleet when no units provided", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      emit_gap: false,
    });
    const body = result.body as { units: Array<{ unit: string }>; total: number; timer_services_watched: number };
    // 11 long-running vessels + the 2 timer services
    expect(body.total).toBe(13);
    expect(body.units.length).toBe(body.total);
    expect(body.units.map((u) => u.unit)).toEqual(expect.arrayContaining(["development-vessel", "edge-reconcile", "lifecycle-audit"]));
    // timer_services_watched is surfaced so coverage of the oneshot fleet is auditable
    expect(body.timer_services_watched).toBe(2);
  });

  it("degrades gracefully when systemctl cannot probe a unit", async () => {
    guard.route({ name: "show-fails", match: (c) => /systemctl show definitely-not-a-real-unit/.test(c), respond: () => { throw new Error("probe failed"); } });
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      units: ["definitely-not-a-real-unit-xyz123"],
      emit_gap: false,
    });
    const body = result.body as { units: Array<{ active_state: string }>; all_healthy: boolean };
    expect(body.units[0]!.active_state).toBe("probe_error");
  });

  it("a oneshot unit whose last run exited non-zero counts as failing (not hidden by inactive ActiveState)", async () => {
    const result = await resolveSystemdUnitHealthObserver({ type: "systemd_unit_health_observer", emit_gap: false });
    const body = result.body as { failing_count: number; failed_units: unknown[]; all_healthy: boolean };
    expect(body.failed_units).toEqual([{ unit: "edge-reconcile", active_state: "inactive", result: "exit-code", exec_main_status: 1 }]);
    expect(body.failing_count).toBe(1);
    expect(body.all_healthy).toBe(false);
  });
});
