import { describe, it, expect, afterEach } from "bun:test";
import { resolveImplicitVesselScan } from "../../src/resolvers/implicit-vessel-scan.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock: obsidian event_observed returns `events`; substrateGap emits are recorded. */
function mockFetch(events: Array<{ kind: string; timestamp: string; sync_root_relative_path?: string }>) {
  const gaps: any[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/resolve") && body?.impulse?.pointer?.type === "obsidian:event_observed") {
      return new Response(JSON.stringify({ success: true, content: JSON.stringify({ events }) }), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve") && body?.impulse?.pointer?.type === "substrateGap_write") {
      gaps.push(body.impulse.pointer.gap);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { gaps };
}

describe("implicit_vessel_scan — generic implicit-vessel (human via obsidian) classifier", () => {
  it("reports a STRONG forward model with no gap when the actor is predictable", async () => {
    // file-open always → file-modify (consistent, ≥3): strength high, no unpredictable transition.
    const evs = [
      { kind: "file-open", timestamp: "t01" }, { kind: "file-modify", timestamp: "t02" },
      { kind: "file-open", timestamp: "t03" }, { kind: "file-modify", timestamp: "t04" },
      { kind: "file-open", timestamp: "t05" }, { kind: "file-modify", timestamp: "t06" },
      { kind: "file-open", timestamp: "t07" }, { kind: "file-modify", timestamp: "t08" },
    ];
    const { gaps } = mockFetch(evs);
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", apiKey: "k" });
    const body = r.body as {
      vessel: string;
      forward_model_strength: number;
      model_is_weak: boolean;
      observed_shapes: string[];
      unpredictable_transitions: unknown[];
      gap_emitted: boolean;
    };
    expect(body.vessel).toBe("obsidian");
    expect(body.forward_model_strength).toBe(1); // perfectly consistent
    expect(body.model_is_weak).toBe(false);
    expect(body.unpredictable_transitions).toEqual([]);
    expect(body.observed_shapes).toContain("file-open");
    expect(body.gap_emitted).toBe(false);
    expect(gaps).toEqual([]);
  });

  it("emits an implicit_vessel_gap (obsidian_unpredictable_behavior) when the model is weak", async () => {
    // file-open followed by 3 distinct evenly-split actions → high deviation, weak model.
    const evs = [
      { kind: "file-open", timestamp: "t01" }, { kind: "search", timestamp: "t02" },
      { kind: "file-open", timestamp: "t03" }, { kind: "graph-open", timestamp: "t04" },
      { kind: "file-open", timestamp: "t05" }, { kind: "file-modify", timestamp: "t06" },
      { kind: "file-open", timestamp: "t07" }, { kind: "search", timestamp: "t08" },
      { kind: "file-open", timestamp: "t09" }, { kind: "graph-open", timestamp: "t10" },
      { kind: "file-open", timestamp: "t11" }, { kind: "file-modify", timestamp: "t12" },
    ];
    const { gaps } = mockFetch(evs);
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", apiKey: "k" });
    const body = r.body as {
      model_is_weak: boolean;
      gap_emitted: boolean;
      gap_category: string;
      unpredictable_transitions: Array<{ current_kind: string }>;
    };
    expect(body.model_is_weak).toBe(true);
    expect(body.gap_emitted).toBe(true);
    expect(body.gap_category).toBe("obsidian_unpredictable_behavior");
    expect(body.unpredictable_transitions.some((t) => t.current_kind === "file-open")).toBe(true);
    expect(gaps[0].id).toBe("implicit_vessel_gap-obsidian");
    expect(gaps[0].classification_metadata.detector).toBe("implicit_vessel_scan");
  });

  it("filters substrate-write file events so the model reflects the operator, not the substrate", async () => {
    const evs = [
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "file-create", timestamp: `s${i}`, sync_root_relative_path: `Substrate/board/c${i}.md` })),
      { kind: "active-leaf-change", timestamp: "u1" }, { kind: "editor-change", timestamp: "u2" },
      { kind: "active-leaf-change", timestamp: "u3" }, { kind: "editor-change", timestamp: "u4" },
      { kind: "active-leaf-change", timestamp: "u5" }, { kind: "editor-change", timestamp: "u6" },
    ];
    mockFetch(evs as any);
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", apiKey: "k" });
    const body = r.body as {
      total_events_pulled: number;
      substrate_writes_filtered: number;
      events_observed: number;
    };
    expect(body.total_events_pulled).toBe(16);
    expect(body.substrate_writes_filtered).toBe(10);
    expect(body.events_observed).toBe(6);
  });

  it("unreachable obsidian is a graceful idle (strength 0, no throw)", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", apiKey: "k" });
    const body = r.body as { unreachable: boolean; forward_model_strength: number };
    expect(body.unreachable).toBe(true);
    expect(body.forward_model_strength).toBe(0);
  });

  it("an unsupported implicit vessel degrades cleanly", async () => {
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", vessel: "some-actor", apiKey: "k" });
    const body = r.body as { vessel: string; unsupported: boolean };
    expect(body.vessel).toBe("some-actor");
    expect(body.unsupported).toBe(true);
  });

  it("missing api key degrades cleanly", async () => {
    const r = await resolveImplicitVesselScan({ type: "implicit_vessel_scan", apiKey: "" });
    expect((r.body as { error: string }).error).toBe("missing_api_key");
  });
});
