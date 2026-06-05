import { describe, it, expect } from "bun:test";
import { resolveSystemdUnitHealthObserver } from "../../src/resolvers/systemd-unit-health-observer.js";

describe("systemd_unit_health_observer", () => {
  it("returns systemdUnitHealth shape with all expected fields", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      units: ["nonexistent-unit-zzz-abc"],
    });
    expect(result.shape).toBe("systemdUnitHealth");
    const body = result.body as {
      units: Array<{ unit: string; active_state: string; active_enter_iso: string | null }>;
      total: number;
      active_count: number;
      failed_count: number;
      inactive_count: number;
      all_active: boolean;
      generated_at: string;
    };
    expect(body.units).toHaveLength(1);
    expect(body.units[0]!.unit).toBe("nonexistent-unit-zzz-abc");
    expect(typeof body.units[0]!.active_state).toBe("string");
    expect(body.total).toBe(1);
    expect(typeof body.generated_at).toBe("string");
  });

  it("defaults to the substrate unit list when none provided", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
    });
    const body = result.body as { units: unknown[]; total: number };
    expect(body.total).toBeGreaterThan(5);
    expect(body.units.length).toBe(body.total);
  });

  it("degrades gracefully when systemctl cannot probe a unit", async () => {
    const result = await resolveSystemdUnitHealthObserver({
      type: "systemd_unit_health_observer",
      units: ["definitely-not-a-real-unit-xyz123"],
    });
    const body = result.body as {
      units: Array<{ active_state: string }>;
      all_active: boolean;
    };
    // Either "inactive" (unit not found) or "probe_error" — both acceptable; never throws.
    expect(["inactive", "probe_error", "unknown", "failed"]).toContain(body.units[0]!.active_state);
    expect(body.all_active).toBe(false);
  });
});
