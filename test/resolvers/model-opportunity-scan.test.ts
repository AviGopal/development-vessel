import { describe, it, expect, afterAll } from "bun:test";
import { resolveModelOpportunityScan } from "../../src/resolvers/model-opportunity-scan.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const stateDir = join(tmpdir(), `dev-vessel-modelopp-${Date.now()}`);
const reset = () => { rmSync(stateDir, { recursive: true, force: true }); mkdirSync(stateDir, { recursive: true }); };
const call = () => resolveModelOpportunityScan({ type: "model_opportunity_scan", stateDir, dry_run: true }) as Promise<{ body: any }>;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe("model_opportunity_scan resolver", () => {
  it("flags unmodeled quantities as opportunities (forward + backward)", async () => {
    reset();
    const r = await call();
    expect(r.body.opportunity_count).toBeGreaterThanOrEqual(4);
    const kinds = new Set(r.body.findings.map((f: any) => f.kind));
    expect(kinds.has("forward")).toBe(true);
    expect(kinds.has("backward")).toBe(true);
    expect(r.body.findings.some((f: any) => f.quantity === "patch_convergence_probability")).toBe(true);
  });

  it("treats a quantity as MODELED once its state file + key exist (negative control)", async () => {
    reset();
    writeFileSync(join(stateDir, "boredom-selector-state.json"), JSON.stringify({ pool_median_cost_ms: 4000, pool_median_cost_tokens: 0 }));
    const r = await call();
    expect(r.body.modeled_quantities).toContain("dispatch_wallclock_cost");
    expect(r.body.findings.some((f: any) => f.quantity === "dispatch_wallclock_cost")).toBe(false);
  });
});
