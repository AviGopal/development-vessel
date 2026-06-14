import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveVesselGapToCluster } from "../../src/resolvers/vessel-gap-to-cluster.js";

const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vgc-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tmp, { recursive: true, force: true });
});

function mockApi(opts: { vessels?: Array<{ vesselId: string; shapes?: string[]; endpoint?: string }>; dispatchOk?: boolean } = {}) {
  const vessels = opts.vessels ?? [];
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ url: u, body });
    if (u.endsWith("/resolve") && body?.pointer?.type === "vesselRegistry") {
      return new Response(JSON.stringify({ content: { vessels } }), { status: 200 });
    }
    if (u.includes("concept_search_by_source") || (body?.impulse?.pointer?.type === "concept_search_by_source")) {
      return new Response(JSON.stringify({ content: { concepts: [{ id: "concept_abc" }] } }), { status: 200 });
    }
    if (u.includes("/run-goal")) {
      return new Response(JSON.stringify({ status: opts.dispatchOk ? "success" : "queued" }), { status: opts.dispatchOk === false ? 500 : 202 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

describe("vessel_gap_to_cluster", () => {
  it("writes a cluster targeting concept_create_write with a fetch→classify→persist topology", async () => {
    mockApi({ vessels: [{ vesselId: "obsidian-vessel-devbob", shapes: ["obsidian:event_observed"], endpoint: "http://host.docker.internal:27183" }] });
    const r = await resolveVesselGapToCluster({
      type: "vessel_gap_to_cluster",
      shape: "obsidian:event_observed",
      apiKey: "k",
      patternsDir: tmp,
    });
    const body = r.body as { pattern_id: string; cluster_path: string; vessel_id: string; expected_outputs: string[]; owner_found: boolean };
    expect(body.pattern_id).toBe("vessel-bridge-obsidian-event_observed");
    expect(body.vessel_id).toBe("obsidian-vessel-devbob");
    expect(body.owner_found).toBe(true);
    expect(body.expected_outputs).toEqual(["concept_create_write"]);
    const cluster = JSON.parse(await fs.readFile(body.cluster_path, "utf8")) as {
      expected_inputs: string[];
      expected_outputs: string[];
      topology_hint: string;
      deny_list: string[];
    };
    expect(cluster.expected_inputs).toEqual(["obsidian:event_observed"]);
    expect(cluster.expected_outputs).toEqual(["concept_create_write"]);
    // topology must steer toward a genuine chain, not a scaffold
    expect(cluster.topology_hint).toContain("concept_create_write");
    expect(cluster.topology_hint).toContain("http://host.docker.internal:27183");
    expect(cluster.deny_list).toContain("activityTemplateProposal");
  });

  it("dispatches the real author when dispatch=true", async () => {
    const calls = mockApi({ vessels: [{ vesselId: "v", shapes: ["x:shape"], endpoint: "http://v" }], dispatchOk: true });
    const r = await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "x:shape", apiKey: "k", patternsDir: tmp, dispatch: true });
    const body = r.body as { dispatched_to_author: boolean };
    expect(body.dispatched_to_author).toBe(true);
    const runGoal = calls.find((c) => c.url.includes("/run-goal"));
    expect(runGoal).toBeDefined();
    expect((runGoal!.body as { targetTemplateId: string }).targetTemplateId).toBe("development-vessel:draft-activity-from-pattern");
    expect((runGoal!.body as { variables: { pattern_id: string } }).variables.pattern_id).toBe("vessel-bridge-x-shape");
  });

  it("still writes a usable cluster when the owning vessel is not in discovery", async () => {
    mockApi({ vessels: [] });
    const r = await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "y:orphan", apiKey: "k", patternsDir: tmp, vesselId: "given-vessel" });
    const body = r.body as { owner_found: boolean; vessel_id: string; cluster_path: string };
    expect(body.owner_found).toBe(false);
    expect(body.vessel_id).toBe("given-vessel"); // falls back to supplied id
    expect(await fs.exists(body.cluster_path)).toBe(true);
  });

  it("degrades cleanly with no shape / no key", async () => {
    const noShape = await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "", apiKey: "k", patternsDir: tmp });
    expect((noShape.body as { error: string }).error).toBe("no_shape_specified");
    const noKey = await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "x", apiKey: "", patternsDir: tmp });
    expect((noKey.body as { error: string }).error).toBe("missing_api_key");
  });
});
