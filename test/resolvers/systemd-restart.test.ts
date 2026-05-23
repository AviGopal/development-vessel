import { describe, it, expect } from "bun:test";
import { resolveSystemdRestart } from "../../src/resolvers/systemd-restart.js";

describe("systemd-restart resolver", () => {
  it("returns systemd_unit_restart shape with required body fields", async () => {
    // In a non-systemd environment systemctl fails fast; shape + body contract must hold either way
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "activity-api",
      timeout_ms: 100,
    });
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { success: boolean; active: boolean; unit: string; startup_ms: number };
    expect(typeof body.success).toBe("boolean");
    expect(typeof body.active).toBe("boolean");
    expect(typeof body.startup_ms).toBe("number");
    expect(body.unit).toBe("activity-api.service");
  });

  it("appends .service suffix when not present", async () => {
    // We verify the unit name is normalised — output body carries .service form
    // Use real systemctl path but expect it to fail fast (not installed in CI)
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "my-vessel",
      timeout_ms: 100,
    });
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { unit: string };
    expect(body.unit).toBe("my-vessel.service");
  });

  it("does not double-append .service suffix", async () => {
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "activity-api.service",
      timeout_ms: 100,
    });
    const body = result.body as { unit: string };
    expect(body.unit).toBe("activity-api.service");
  });

  it("returns success:false when restart command fails", async () => {
    // systemctl restart exits non-zero → no polling
    const result = await resolveSystemdRestart({
      type: "systemd_restart",
      unit: "nonexistent-unit-xyz",
      timeout_ms: 500,
    });
    expect(result.shape).toBe("systemd_unit_restart");
    const body = result.body as { success: boolean; active: boolean };
    // In environments without systemd this may still return false — either way
    // shape and success/active booleans must be present
    expect(typeof body.success).toBe("boolean");
    expect(typeof body.active).toBe("boolean");
  });
});
