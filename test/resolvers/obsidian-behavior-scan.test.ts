import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianBehaviorScan } from "../../src/resolvers/obsidian-behavior-scan.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock: obsidian event_observed returns `events`; concept writes + gap emits are recorded. */
function mockFetch(events: Array<{ kind: string; timestamp: string }>) {
  const persisted: any[] = [];
  const gaps: string[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/resolve") && body?.impulse?.pointer?.type === "obsidian:event_observed") {
      return new Response(JSON.stringify({ success: true, content: JSON.stringify({ events }) }), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve")) {
      const t = body?.impulse?.pointer?.type;
      if (t === "concept_create_write") {
        persisted.push(JSON.parse(body.impulse.pointer.conceptData.content));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (t === "substrateGap_write") {
        gaps.push(body.impulse.pointer.gap.classification_metadata.current_kind);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { persisted, gaps };
}

describe("obsidian_behavior_scan — operator forward model", () => {
  it("builds P(next|current) modal expectation from observed events", async () => {
    // file-open is always followed by file-modify (consistent) ≥3 times.
    const evs = [
      { kind: "file-open", timestamp: "2026-06-15T01:00:00Z" },
      { kind: "file-modify", timestamp: "2026-06-15T01:00:01Z" },
      { kind: "file-open", timestamp: "2026-06-15T01:00:02Z" },
      { kind: "file-modify", timestamp: "2026-06-15T01:00:03Z" },
      { kind: "file-open", timestamp: "2026-06-15T01:00:04Z" },
      { kind: "file-modify", timestamp: "2026-06-15T01:00:05Z" },
      { kind: "file-open", timestamp: "2026-06-15T01:00:06Z" },
    ];
    const { persisted, gaps } = mockFetch(evs);
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "k" });
    const body = r.body as { modeled: number; persisted: number; models: Array<{ current_kind: string; expected_next_kind: string }> };
    // file-open→file-modify (×3) and file-modify→file-open (×3) are both modeled.
    expect(body.modeled).toBe(2);
    const openModel = body.models.find((x) => x.current_kind === "file-open")!;
    expect(openModel.expected_next_kind).toBe("file-modify");
    const openPersist = persisted.find((p) => p.current_kind === "file-open");
    expect(openPersist.consistency).toBe(1); // perfectly consistent
    expect(gaps).toEqual([]); // no high-deviation kind → no gap
  });

  it("emits a gap when the operator is unpredictable after an action", async () => {
    // file-open followed by 3 distinct, evenly-split actions → high deviation.
    const evs = [
      { kind: "file-open", timestamp: "t01" }, { kind: "search", timestamp: "t02" },
      { kind: "file-open", timestamp: "t03" }, { kind: "graph-open", timestamp: "t04" },
      { kind: "file-open", timestamp: "t05" }, { kind: "file-modify", timestamp: "t06" },
      { kind: "file-open", timestamp: "t07" }, { kind: "search", timestamp: "t08" },
      { kind: "file-open", timestamp: "t09" }, { kind: "graph-open", timestamp: "t10" },
      { kind: "file-open", timestamp: "t11" }, { kind: "file-modify", timestamp: "t12" },
    ];
    const { gaps } = mockFetch(evs);
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "k" });
    const body = r.body as { gaps_emitted: number };
    expect(body.gaps_emitted).toBe(1);
    expect(gaps).toContain("file-open");
  });

  it("self-detects a polluted observation channel (monotonic stream) and emits a gap", async () => {
    // 25 substrate-write file-creates swamp the channel → human signal absent.
    const evs = Array.from({ length: 25 }, (_, i) => ({ kind: "file-create", timestamp: `t${String(i).padStart(2, "0")}` }));
    let polluted = "";
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      const body = JSON.parse(init?.body ?? "{}");
      if (u.endsWith("/resolve") && body?.impulse?.pointer?.type === "obsidian:event_observed") {
        return new Response(JSON.stringify({ success: true, content: JSON.stringify({ events: evs }) }), { status: 200 });
      }
      if (u.includes("/v2/impulses/resolve") && body?.impulse?.pointer?.type === "substrateGap_write") {
        polluted = body.impulse.pointer.gap.category;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "k" });
    const body = r.body as { channel_polluted: boolean; dominant_kind: string; gaps_emitted: number };
    expect(body.channel_polluted).toBe(true);
    expect(body.dominant_kind).toBe("file-create");
    expect(body.gaps_emitted).toBe(1);
    expect(polluted).toBe("obsidian_observation_channel_polluted");
  });

  it("filters substrate-write file events (concept-sync) so the model sees operator signal", async () => {
    // 10 substrate concept-sync file-creates (under concept-db/) + a clean
    // operator open→modify pattern. The substrate writes must be filtered out.
    const evs = [
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "file-create", timestamp: `s${i}`, sync_root_relative_path: `concept-db/extracted/c${i}.md` })),
      { kind: "active-leaf-change", timestamp: "u1" },
      { kind: "editor-change", timestamp: "u2" },
      { kind: "active-leaf-change", timestamp: "u3" },
      { kind: "editor-change", timestamp: "u4" },
      { kind: "active-leaf-change", timestamp: "u5" },
      { kind: "editor-change", timestamp: "u6" },
    ];
    mockFetch(evs as any);
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "k" });
    const body = r.body as { total_events_pulled: number; substrate_writes_filtered: number; events_observed: number; channel_polluted: boolean; models: Array<{ current_kind: string; expected_next_kind: string }> };
    expect(body.total_events_pulled).toBe(16);
    expect(body.substrate_writes_filtered).toBe(10); // the concept-db/ creates dropped
    expect(body.events_observed).toBe(6); // operator events remain
    expect(body.channel_polluted).toBe(false); // not monotonic after filtering
    const m = body.models.find((x) => x.current_kind === "active-leaf-change")!;
    expect(m.expected_next_kind).toBe("editor-change");
  });

  it("unreachable obsidian is a graceful idle", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "k" });
    const body = r.body as { unreachable: boolean; modeled: number };
    expect(body.unreachable).toBe(true);
    expect(body.modeled).toBe(0);
  });

  it("missing api key degrades cleanly", async () => {
    const r = await resolveObsidianBehaviorScan({ type: "obsidian_behavior_scan", apiKey: "" });
    expect((r.body as { error: string }).error).toBe("missing_api_key");
  });
});
