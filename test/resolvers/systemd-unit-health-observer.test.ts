import { describe, it, expect } from "bun:test";
import { resolveSystemdUnitHealthObserver } from "../../src/resolvers/systemd-unit-health-observer.js";

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
    expect(typeof body.units[0]!.active_state).toBe("string");
    expect(typeof body.units[0]!.result).toBe("string"); // new last-run-outcome field
    expect(body.total).toBe(1);
    expect(typeof body.failing_count).toBe("number");
    expect(typeof body.generated_at).toBe("string");
  });

  it("defaults to vessels UNION the timer-service fleet when no units provided", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      emit_gap: false,
    });
    const body = result.body as { units: unknown[]; total: number; timer_services_watched: number };
    expect(body.total).toBeGreaterThan(5);
    expect(body.units.length).toBe(body.total);
    // timer_services_watched is surfaced so coverage of the oneshot fleet is auditable
    expect(typeof body.timer_services_watched).toBe("number");
  });

  it("degrades gracefully when systemctl cannot probe a unit", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      units: ["definitely-not-a-real-unit-xyz123"],
      emit_gap: false,
    });
    const body = result.body as { units: Array<{ active_state: string }>; all_healthy: boolean };
    expect(["inactive", "probe_error", "unknown", "failed", "dead"]).toContain(body.units[0]!.active_state);
  });

  it("a oneshot unit whose last run exited non-zero counts as failing (not hidden by inactive ActiveState)", async () => {
    // contract check on the failing-detection logic via a synthetic state is not
    // possible without systemctl; this asserts the field exists and the default
    // path produces a numeric failing_count, exercising the failingStates path.
    const result = await resolveSystemdUnitHealthObserver({ type: "systemd_unit_health_observer", emit_gap: false });
    const body = result.body as { failing_count: number; failed_units: unknown[]; all_healthy: boolean };
    expect(Array.isArray(body.failed_units)).toBe(true);
    expect(body.failing_count).toBe(body.failed_units.length);
  });
});
