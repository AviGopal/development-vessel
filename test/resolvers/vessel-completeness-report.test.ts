import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVesselCompletenessReport } from "../../src/resolvers/vessel-completeness-report.js";

async function makeVesselTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vessel-completeness-"));
  // Healthy vessel — all canonical files present.
  await mkdir(join(root, "repos", "healthy-vessel", "src", "routes"), { recursive: true });
  await writeFile(join(root, "repos", "healthy-vessel", "package.json"), "{}");
  await writeFile(join(root, "repos", "healthy-vessel", "tsconfig.json"), "{}");
  await writeFile(join(root, "repos", "healthy-vessel", "src", "config.ts"), "");
  await writeFile(join(root, "repos", "healthy-vessel", "src", "index.ts"), "");
  await writeFile(join(root, "repos", "healthy-vessel", "src", "routes", "impulses.ts"), "");
  await writeFile(join(root, "repos", "healthy-vessel", "src", "discovery-registration.ts"), "");
  // Incomplete vessel — missing index.ts + discovery-registration.ts (clock-vessel pattern).
  await mkdir(join(root, "repos", "clock-vessel", "src", "routes"), { recursive: true });
  await writeFile(join(root, "repos", "clock-vessel", "package.json"), "{}");
  await writeFile(join(root, "repos", "clock-vessel", "tsconfig.json"), "{}");
  await writeFile(join(root, "repos", "clock-vessel", "src", "config.ts"), "");
  await writeFile(join(root, "repos", "clock-vessel", "src", "routes", "impulses.ts"), "");
  return root;
}

describe("vessel_completeness_report", () => {
  it("flags clock-vessel as incomplete relative to healthy reference", async () => {
    const root = await makeVesselTree();
    const r = await resolveVesselCompletenessReport({
      type: "vessel_completeness_report",
      reposRoot: join(root, "repos"),
      healthyVessels: ["healthy-vessel"],
    });
    expect(r.shape).toBe("vesselCompletenessReport");
    const body = r.body as any;
    expect(body.scanned).toBe(2);
    expect(body.canonical_source).toBe("healthy_vessel_intersection");
    const names = body.incomplete_vessels.map((v: any) => v.vessel_name);
    expect(names).toContain("clock-vessel");
    expect(names).not.toContain("healthy-vessel");
    const clock = body.incomplete_vessels.find((v: any) => v.vessel_name === "clock-vessel");
    expect(clock.missing_files).toContain("src/index.ts");
    expect(clock.missing_files).toContain("src/discovery-registration.ts");
  });

  it("returns HEALTHY when there are no incomplete vessels", async () => {
    const root = await makeVesselTree();
    const r = await resolveVesselCompletenessReport({
      type: "vessel_completeness_report",
      reposRoot: join(root, "repos"),
      // exclude the broken vessel — only healthy remains.
      excludeVessels: ["clock-vessel"],
    });
    const body = r.body as any;
    expect(body.health_verdict).toBe("HEALTHY");
    expect(body.scanned).toBe(1);
    expect(body.incomplete_count).toBe(0);
  });

  it("returns 0 scanned when repos root missing (graceful)", async () => {
    const r = await resolveVesselCompletenessReport({
      type: "vessel_completeness_report",
      reposRoot: "/nonexistent/path/never/exists",
    });
    const body = r.body as any;
    expect(body.scanned).toBe(0);
    expect(body.incomplete_count).toBe(0);
  });
});
