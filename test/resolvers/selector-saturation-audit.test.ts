import { describe, it, expect, afterEach } from "bun:test";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSelectorSaturationAudit } from "../../src/resolvers/selector-saturation-audit.js";

async function snapshotFile(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "selsat-"));
  const path = join(dir, "boredom-selector-state.json");
  await writeFile(path, JSON.stringify(body));
  return path;
}

describe("selector_saturation_audit", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("returns verdict=unknown when no snapshot exists", async () => {
    const result = await resolveSelectorSaturationAudit({
      type: "selector_saturation_audit",
      snapshotPath: "/no/such/snapshot/xyz123.json",
    });
    expect(result.shape).toBe("selectorRewardHealth");
    expect((result.body as { verdict: string }).verdict).toBe("unknown");
  });

  it("returns verdict=cold_start when too few templates are sampled", async () => {
    const path = await snapshotFile({ sampled_templates: 3, saturated_fraction: 1, variance_of_means: 0 });
    const result = await resolveSelectorSaturationAudit({
      type: "selector_saturation_audit",
      snapshotPath: path,
      minSampledTemplates: 8,
    });
    expect((result.body as { verdict: string }).verdict).toBe("cold_start");
    await rm(path, { force: true });
  });

  it("returns verdict=healthy with no gap emission when reward is discriminating", async () => {
    const path = await snapshotFile({
      sampled_templates: 40, saturated_fraction: 0.1, variance_of_means: 0.07, mean_of_means: 0.25,
    });
    const result = await resolveSelectorSaturationAudit({ type: "selector_saturation_audit", snapshotPath: path });
    const body = result.body as { verdict: string; gap_emission: string };
    expect(body.verdict).toBe("healthy");
    expect(body.gap_emission).toBe("not_needed");
    await rm(path, { force: true });
  });

  it("returns verdict=saturated and emits a gap when reward is degenerate", async () => {
    // Mock fetch so the gap-emit path is exercised without real network.
    let posted: { url: string; type?: string } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      posted = { url: String(url), type: parsed?.impulse?.pointer?.type };
      return { ok: true } as Response;
    }) as typeof fetch;

    const path = await snapshotFile({
      sampled_templates: 40, saturated_fraction: 0.9, variance_of_means: 0.001, mean_of_means: 0.98,
    });
    const result = await resolveSelectorSaturationAudit({ type: "selector_saturation_audit", snapshotPath: path });
    const body = result.body as { verdict: string; gap_emission: string };
    expect(body.verdict).toBe("saturated");
    expect(body.gap_emission).toBe("emitted");
    expect(posted!.type).toBe("substrateGap_write");
    await rm(path, { force: true });
  });
});
