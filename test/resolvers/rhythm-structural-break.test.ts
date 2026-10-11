// THE STRUCTURAL-BREAK GAP FIRES FOR AN EMPTY AND FOR AN UNMAPPABLE REGISTRY (check-first).
//
// rhythm_conductor_tick computed `structuralBreak` from the registry read alone
// (`regResp === null ? "registry_empty" : regResp === undefined ? … : undefined`), followed by a bare
// ternary statement over rhythms.length and mappable whose value was discarded. So the gap fired only
// when the registry READ failed: a registry that answered with zero rhythms, or with rhythms none of
// which maps to a goal, filed nothing, which is exactly the two silent states the check exists for.
//
// CONTRACT: 0 rhythms files rhythm-cadence-registry_empty; rhythms present but 0 mappable files
// rhythm-cadence-registry_unmappable. All traffic goes to a stubbed endpoint; no store is written.
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRhythmConductorTick } from "../../src/resolvers/rhythm-conductor-tick.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const originalFetch = globalThis.fetch;
beforeEach(() => { __resetPolicyReadsForTests(); });
afterEach(() => { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); });

/** The registry answers `rhythms` for timeShapedRhythm and nothing for any other pool shape; gap writes are captured. */
function registryFetch(rhythms: unknown[], gaps: Array<Record<string, unknown>>): typeof fetch {
  return (async (input: any, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    const imp = body?.impulse ?? {};
    if (imp.type === "poolImpulse" && imp.shape === "spendEnvelope") return openPolicyAnswer(imp.shape);
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (!url.startsWith("http://test/")) return new Response("not found", { status: 404 });
    if (imp.type === "poolImpulse") {
      const rows = imp.shape === "timeShapedRhythm" ? rhythms : [];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp.type === "substrateGap_write") { gaps.push(imp.gap as Record<string, unknown>); return Response.json({ body: { ok: true } }); }
    return Response.json({ body: { ok: true } });
  }) as unknown as typeof fetch;
}

async function tick(rhythms: unknown[]): Promise<Array<Record<string, unknown>>> {
  const gaps: Array<Record<string, unknown>> = [];
  globalThis.fetch = registryFetch(rhythms, gaps);
  const dir = mkdtempSync(join(tmpdir(), "rct-break-"));
  const queuePath = join(dir, "queue.json");
  writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));
  await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, registry_endpoint: "http://test/v2/impulses/resolve", queue_path: queuePath });
  return gaps;
}

describe("rhythm_conductor_tick structural-break gap", () => {
  it("[MUST-FAIL] a registry that answers with zero rhythms files registry_empty", async () => {
    const gaps = await tick([]);
    expect(gaps.map((g) => g["id"])).toContain("rhythm-cadence-registry_empty");
  });

  it("[MUST-FAIL] rhythms that no family goal maps file registry_unmappable", async () => {
    const gaps = await tick([
      { id: "rhythm-unmapped", shape: "timeShapedRhythm", body: { axis: "gap", family: "no-such-family-fixture", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 } },
    ]);
    expect(gaps.map((g) => g["id"])).toContain("rhythm-cadence-registry_unmappable");
  });

  it("[CONTROL] a mappable registry files no structural-break gap", async () => {
    const gaps = await tick([
      { id: "rhythm-gap-closing", shape: "timeShapedRhythm", body: { axis: "gap", family: "gap-closing", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 } },
    ]);
    expect(gaps.filter((g) => String(g["id"]).startsWith("rhythm-cadence-"))).toEqual([]);
  });
});
