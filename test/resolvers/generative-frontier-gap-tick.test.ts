import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { resolveGenerativeFrontierGapTick } from "../../src/resolvers/generative-frontier-gap-tick.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Route fetch by URL prefix. Tracks POST calls to the emit endpoint.
function routedFetch(
  map: Record<string, (init?: RequestInit) => Response>,
  onPost?: (url: string, init?: RequestInit) => void,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method === "POST" && onPost) onPost(url, init);
    for (const prefix of Object.keys(map)) {
      if (url.includes(prefix)) return map[prefix]!(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// Templates + traces stub: shape "frontierShape" is PRODUCED in 5 traces and
// NOT consumed anywhere → it is the produced-but-uncomposed frontier candidate.
// "consumedShape" is produced AND consumed → not on the frontier.
function topologyFetch(onPost?: (url: string, init?: RequestInit) => void): typeof fetch {
  const templates = {
    templates: [
      { id: "producer", output_shapes: ["frontierShape", "consumedShape"], input_shapes: [] },
      { id: "consumer", output_shapes: [], input_shapes: ["consumedShape"] },
    ],
  };
  const traces = {
    traces: [
      { output_impulse_shapes: ["frontierShape"], input_impulse_shapes: [] },
      { output_impulse_shapes: ["frontierShape"], input_impulse_shapes: [] },
      { output_impulse_shapes: ["frontierShape"], input_impulse_shapes: [] },
      { output_impulse_shapes: ["frontierShape"], input_impulse_shapes: [] },
      { output_impulse_shapes: ["frontierShape"], input_impulse_shapes: [] },
      { output_impulse_shapes: ["consumedShape"], input_impulse_shapes: ["consumedShape"] },
    ],
  };
  return routedFetch(
    {
      "/v2/activities/templates": () => new Response(JSON.stringify(templates), { status: 200 }),
      "/v2/activities/execution-traces": () => new Response(JSON.stringify(traces), { status: 200 }),
      "/v2/impulses/resolve": () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    },
    onPost,
  );
}

let tmp: string;
let passSpectral: string; // headroom passes the gate
let blockSpectral: string; // λ2=0.9, star=0.97 → headroom ~0.027 < 0.35

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "genfront-"));
  passSpectral = join(tmp, "pass.jsonl");
  blockSpectral = join(tmp, "block.jsonl");
  await writeFile(
    passSpectral,
    JSON.stringify({ fiedler_lambda2: 0.9, star_ratio: 0.2, components: 1, nodes: 20 }) + "\n",
  );
  await writeFile(
    blockSpectral,
    JSON.stringify({ fiedler_lambda2: 0.9, star_ratio: 0.97, components: 1, nodes: 20 }) + "\n",
  );
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("generative_frontier_gap_tick", () => {
  it("(1) identifies the produced-but-uncomposed candidate and emits with source substrate_generative + stable id when headroom passes", async () => {
    let posted: { url: string; body: any } | null = null;
    globalThis.fetch = topologyFetch((url, init) => {
      if (url.includes("/v2/impulses/resolve")) {
        posted = { url, body: JSON.parse(String(init?.body)) };
      }
    });

    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: passSpectral,
      gaps_path: join(tmp, "no-gaps.json"),
    });
    const body = r.body as any;
    expect(r.shape).toBe("generativeFrontierGapReport");
    expect(body.emitted).toBe(true);
    expect(body.candidate_shape).toBe("frontierShape");
    expect(body.gap_id).toBe("generative-frontier-frontierShape");
    expect(posted).not.toBeNull();
    expect(posted!.body.impulse.pointer.type).toBe("substrateGap_write");
    expect(posted!.body.impulse.pointer.gap.source).toBe("substrate_generative");
    expect(posted!.body.impulse.pointer.gap.id).toBe("generative-frontier-frontierShape");
    expect(posted!.body.impulse.pointer.gap.category).toBe("missing_capability");
  });

  it("(2) headroom gate blocks (λ2 0.9, star 0.97 → ~0.027 < 0.35): emitted false, no POST", async () => {
    let postCalls = 0;
    globalThis.fetch = topologyFetch((url) => {
      if (url.includes("/v2/impulses/resolve")) postCalls++;
    });

    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: blockSpectral,
      gaps_path: join(tmp, "no-gaps.json"),
    });
    const body = r.body as any;
    expect(body.emitted).toBe(false);
    expect(body.reason).toBe("headroom_gate_blocked");
    expect(body.headroom).toBeLessThan(0.35);
    expect(postCalls).toBe(0);
  });

  it("(3) fails closed when the spectral file is missing", async () => {
    let postCalls = 0;
    globalThis.fetch = topologyFetch(() => {
      postCalls++;
    });
    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: join(tmp, "does-not-exist.jsonl"),
      gaps_path: join(tmp, "no-gaps.json"),
    });
    const body = r.body as any;
    expect(body.emitted).toBe(false);
    expect(body.reason).toBe("spectral_signal_unavailable");
    expect(postCalls).toBe(0);
  });

  it("(4) rate-limited when a recent substrate_generative gap exists", async () => {
    let postCalls = 0;
    globalThis.fetch = topologyFetch((url) => {
      if (url.includes("/v2/impulses/resolve")) postCalls++;
    });
    const gapsPath = join(tmp, "gaps.json");
    await writeFile(
      gapsPath,
      JSON.stringify([
        {
          id: "generative-frontier-otherShape",
          source: "substrate_generative",
          status: "open",
          created_at: new Date().toISOString(),
        },
      ]),
    );
    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: passSpectral,
      gaps_path: gapsPath,
      min_rate_limit_hours: 6,
    });
    const body = r.body as any;
    expect(body.emitted).toBe(false);
    expect(body.reason).toBe("rate_limited");
    expect(postCalls).toBe(0);
  });

  it("(5) already_open dedup when an open generative gap for the same shape exists", async () => {
    let postCalls = 0;
    globalThis.fetch = topologyFetch((url) => {
      if (url.includes("/v2/impulses/resolve")) postCalls++;
    });
    const gapsPath = join(tmp, "gaps.json");
    // Same shape id, but timestamped long ago so it is NOT rate-limited —
    // already_open must take precedence (it is checked first).
    await writeFile(
      gapsPath,
      JSON.stringify([
        {
          id: "generative-frontier-frontierShape",
          source: "substrate_generative",
          status: "open",
          created_at: new Date(Date.now() - 1000 * 3600 * 24).toISOString(),
        },
      ]),
    );
    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: passSpectral,
      gaps_path: gapsPath,
    });
    const body = r.body as any;
    expect(body.emitted).toBe(false);
    expect(body.reason).toBe("already_open");
    expect(body.candidate_shape).toBe("frontierShape");
    expect(postCalls).toBe(0);
  });

  it("(6) dry_run computes the candidate but does not POST", async () => {
    let postCalls = 0;
    globalThis.fetch = topologyFetch((url) => {
      if (url.includes("/v2/impulses/resolve")) postCalls++;
    });
    const r = await resolveGenerativeFrontierGapTick({
      type: "generative_frontier_gap_tick",
      spectral_metrics_path: passSpectral,
      gaps_path: join(tmp, "no-gaps.json"),
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.emitted).toBe(false);
    expect(body.reason).toBe("dry_run");
    expect(body.candidate_shape).toBe("frontierShape");
    expect(body.gap_id).toBe("generative-frontier-frontierShape");
    expect(postCalls).toBe(0);
  });
});
