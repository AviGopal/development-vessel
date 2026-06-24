import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianAssistFeedbackScan } from "../../src/resolvers/obsidian-assist-feedback-scan.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(opts: { events: any[]; assistExists: boolean }) {
  const relevance: any[] = [];
  const calls: { gap?: any } = {};
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/resolve") && body?.type === "obsidian:event_observed") {
      return new Response(JSON.stringify({ content: JSON.stringify({ events: opts.events }) }), { status: 200 });
    }
    if (u.endsWith("/resolve") && body?.type === "obsidian:note") {
      return new Response(JSON.stringify({ success: opts.assistExists, content: opts.assistExists ? "# assist" : undefined }), { status: 200 });
    }
    if (u.includes("/v2/activities/impulse-relevance")) {
      relevance.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve") && body?.impulse?.pointer?.type === "substrateGap_write") {
      calls.gap = body.impulse.pointer.gap;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { relevance, calls };
}

describe("obsidian_assist_feedback_scan — per-class reaction learning", () => {
  it("rewards each class by its OWN engagement (differentiated)", async () => {
    const { relevance, calls } = mockFetch({
      events: [
        { kind: "active-leaf-change", sync_root_relative_path: "Substrate/Assists/active-note.md" },
        { kind: "active-leaf-change", sync_root_relative_path: "Substrate/Assists/active-note.md" },
      ],
      assistExists: true,
    });
    const r = await resolveObsidianAssistFeedbackScan({ type: "obsidian_assist_feedback_scan", apiKey: "k" });
    const b = r.body as { engaged: boolean; gap_emitted: boolean; per_class: Array<{ cls: string; views: number }> };
    expect(b.engaged).toBe(true);
    expect(b.gap_emitted).toBe(false);
    // active-note engaged (2 views) → reward succeeded; next-actions not viewed → reward failed
    const an = relevance.find((x) => x.impulse_id === "obsidian:assist:active-note");
    const na = relevance.find((x) => x.impulse_id === "obsidian:assist:next-actions");
    expect(an.execution_succeeded).toBe(true);
    expect(na.execution_succeeded).toBe(false);
    expect(b.per_class.find((c) => c.cls === "active-note")!.views).toBe(2);
  });

  it("delivered but no class engaged → ignored gap", async () => {
    const { calls } = mockFetch({ events: [{ kind: "active-leaf-change", sync_root_relative_path: "MyNotes/y.md" }], assistExists: true });
    const r = await resolveObsidianAssistFeedbackScan({ type: "obsidian_assist_feedback_scan", apiKey: "k" });
    const b = r.body as { engaged: boolean; gap_emitted: boolean };
    expect(b.engaged).toBe(false);
    expect(b.gap_emitted).toBe(true);
    expect(calls.gap.category).toBe("obsidian_assists_ignored");
  });

  it("no assist delivered → no gap", async () => {
    mockFetch({ events: [], assistExists: false });
    const r = await resolveObsidianAssistFeedbackScan({ type: "obsidian_assist_feedback_scan", apiKey: "k" });
    const b = r.body as { assist_delivered: boolean; gap_emitted: boolean };
    expect(b.assist_delivered).toBe(false);
    expect(b.gap_emitted).toBe(false);
  });
});
