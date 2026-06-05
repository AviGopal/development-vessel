import { describe, it, expect } from "bun:test";
import { resolveDiskSpaceObserver } from "../../src/resolvers/disk-space-observer.js";

describe("disk_space_observer", () => {
  it("returns a structured impulse for an existing mount", async () => {
    const result = await resolveDiskSpaceObserver({
      type: "disk_space_observer",
      mounts: ["/"],
    });
    expect(result.shape).toBe("diskSpaceState");
    const body = result.body as {
      mounts: Array<{
        mount: string;
        used_pct: number | null;
        pressure_level: string;
        error: string | null;
      }>;
      worst_pressure_level: string;
    };
    expect(body.mounts).toHaveLength(1);
    const m = body.mounts[0]!;
    expect(m.mount).toBe("/");
    if (m.used_pct !== null) {
      expect(typeof m.used_pct).toBe("number");
      expect(["green", "yellow", "red"].includes(m.pressure_level)).toBe(true);
    } else {
      expect(["unknown"].includes(m.pressure_level)).toBe(true);
    }
  });

  it("degrades to unknown for a non-existent mount", async () => {
    const result = await resolveDiskSpaceObserver({
      type: "disk_space_observer",
      mounts: ["/this/path/does/not/exist/xyz123"],
    });
    const body = result.body as { mounts: Array<{ pressure_level: string; error: string | null }> };
    const m = body.mounts[0]!;
    expect(m.pressure_level).toBe("unknown");
    // df returns nonzero on missing mount; error may be parse_error or no_data_row.
    expect(m.error).not.toBeNull();
  });

  it("classifies pressure level using configurable thresholds", async () => {
    const result = await resolveDiskSpaceObserver({
      type: "disk_space_observer",
      mounts: ["/"],
      yellowThresholdPct: 0,
      redThresholdPct: 1,
    });
    const body = result.body as {
      mounts: Array<{ pressure_level: string; used_pct: number | null }>;
      any_red: boolean;
    };
    // With yellow=0 and red=1 any non-empty mount should be red.
    if (body.mounts[0]?.used_pct !== null) {
      expect(body.mounts[0]?.pressure_level).toBe("red");
      expect(body.any_red).toBe(true);
    }
  });
});
