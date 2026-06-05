import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostContainerSourceDriftObserver } from "../../src/resolvers/host-container-source-drift-observer.js";

const root = join(tmpdir(), `dev-vessel-host-container-drift-${Date.now()}`);
const containerRoot = join(root, "vessels");
const hostRoot = join(root, "host");

beforeAll(() => {
  // Vessel A: identical
  mkdirSync(join(containerRoot, "vessel-a/src"), { recursive: true });
  mkdirSync(join(hostRoot, "repos/vessel-a/src"), { recursive: true });
  writeFileSync(join(containerRoot, "vessel-a/src/index.ts"), "export const x = 1;\n");
  writeFileSync(join(hostRoot, "repos/vessel-a/src/index.ts"), "export const x = 1;\n");

  // Vessel B: drift
  mkdirSync(join(containerRoot, "vessel-b/src"), { recursive: true });
  mkdirSync(join(hostRoot, "repos/vessel-b/src"), { recursive: true });
  writeFileSync(join(containerRoot, "vessel-b/src/a.ts"), "export const a = 'container';\n");
  writeFileSync(join(hostRoot, "repos/vessel-b/src/a.ts"), "export const a = 'host';\n");
  writeFileSync(join(containerRoot, "vessel-b/src/b.ts"), "// same\n");
  writeFileSync(join(hostRoot, "repos/vessel-b/src/b.ts"), "// same\n");

  // Vessel C: host missing — should degrade gracefully
  mkdirSync(join(containerRoot, "vessel-c/src"), { recursive: true });
  writeFileSync(join(containerRoot, "vessel-c/src/x.ts"), "// only-container\n");
});

describe("host_container_source_drift_observer", () => {
  it("detects drift between container and host sources", async () => {
    const result = await resolveHostContainerSourceDriftObserver({
      type: "host_container_source_drift_observer",
      containerVesselsRoot: containerRoot,
      hostRepoRoot: hostRoot,
      vesselPairs: [
        { container: "vessel-a", host: "vessel-a" },
        { container: "vessel-b", host: "vessel-b" },
      ],
    });
    expect(result.shape).toBe("hostContainerSourceDriftState");
    const body = result.body as {
      total_drifted: number;
      drift_present: boolean;
      sample_drifted_files: string[];
      per_vessel: Array<{ vessel: string; drifted_files: number; scanned_files: number }>;
    };
    expect(body.drift_present).toBe(true);
    expect(body.total_drifted).toBe(1);
    expect(body.sample_drifted_files.some((s) => s.includes("vessel-b/src/a.ts"))).toBe(true);
    const vesselA = body.per_vessel.find((v) => v.vessel === "vessel-a");
    expect(vesselA?.drifted_files).toBe(0);
    expect(vesselA?.scanned_files).toBe(1);
    const vesselB = body.per_vessel.find((v) => v.vessel === "vessel-b");
    expect(vesselB?.drifted_files).toBe(1);
    expect(vesselB?.scanned_files).toBe(2);
  });

  it("degrades to host_missing flag without throwing", async () => {
    const result = await resolveHostContainerSourceDriftObserver({
      type: "host_container_source_drift_observer",
      containerVesselsRoot: containerRoot,
      hostRepoRoot: hostRoot,
      vesselPairs: [{ container: "vessel-c", host: "vessel-c" }],
    });
    const body = result.body as {
      drift_present: boolean;
      per_vessel: Array<{ vessel: string; host_missing: boolean; container_missing: boolean }>;
    };
    expect(body.drift_present).toBe(false);
    expect(body.per_vessel[0]?.host_missing).toBe(true);
    expect(body.per_vessel[0]?.container_missing).toBe(false);
  });

  it("emits a well-formed impulse when both roots are absent", async () => {
    const result = await resolveHostContainerSourceDriftObserver({
      type: "host_container_source_drift_observer",
      containerVesselsRoot: join(root, "nope-c"),
      hostRepoRoot: join(root, "nope-h"),
      vesselPairs: [{ container: "ghost", host: "ghost" }],
    });
    const body = result.body as {
      total_drifted: number;
      per_vessel: Array<{ container_missing: boolean; host_missing: boolean }>;
    };
    expect(body.total_drifted).toBe(0);
    expect(body.per_vessel[0]?.container_missing).toBe(true);
    expect(body.per_vessel[0]?.host_missing).toBe(true);
  });
});
