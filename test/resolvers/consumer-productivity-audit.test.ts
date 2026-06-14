import { describe, it, expect, afterEach } from "bun:test";
import { resolveConsumerProductivityAudit } from "../../src/resolvers/consumer-productivity-audit.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface FakeTemplate {
  id: string;
  input_shapes?: string[];
  output_shapes?: string[];
  tasks?: Array<{ id?: string; resolver?: string; input_shapes?: string[]; output_shapes?: string[]; config?: Record<string, unknown> }>;
}

/**
 * Fake activity-api. `consumers[shape]` = template ids returned by
 * discover-by-shapes backward. `templates[id]` = full template. `tracesOk` =
 * set of ids that have a productive success trace.
 */
function mockApi(opts: {
  consumers?: Record<string, string[]>;
  templates?: Record<string, FakeTemplate>;
  tracesOk?: Set<string>;
}) {
  const consumers = opts.consumers ?? {};
  const templates = opts.templates ?? {};
  const tracesOk = opts.tracesOk ?? new Set<string>();
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/discover-by-shapes")) {
      const body = JSON.parse(init?.body ?? "{}");
      const shape = body.required_shapes?.[0];
      const ids = consumers[shape] ?? [];
      return new Response(JSON.stringify({ activities: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (u.includes("/v2/activities/templates/")) {
      const id = decodeURIComponent(u.split("/v2/activities/templates/")[1]!.split("?")[0]!);
      const tpl = templates[id];
      if (!tpl) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(tpl), { status: 200 });
    }
    if (u.includes("/execution-traces")) {
      const m = u.match(/activity_(?:template_)?id=([^&]+)/);
      const id = m ? decodeURIComponent(m[1]!) : "";
      const ok = tracesOk.has(id);
      return new Response(
        JSON.stringify({ executions: ok ? [{ status: "success", output_impulse_shapes: ["concept_create_write"] }] : [] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("consumer_productivity_audit", () => {
  it("flags a scaffold-clone (declares input, emits only a *Proposal) as falsely_covered", async () => {
    mockApi({
      consumers: { "obsidian:note": ["gap-closing:diagnose-note"] },
      templates: {
        "gap-closing:diagnose-note": {
          id: "gap-closing:diagnose-note",
          input_shapes: ["obsidian:note", "obsidian:graph_query"],
          output_shapes: ["noteComprehensibilityReport", "activityTemplateProposal"],
          tasks: [
            { id: "read_scenario", resolver: "fs_read", config: { path: "/workspace/scenarios/fm-54.json" } },
            { id: "analyze", resolver: "llm_completion_dispatch", config: { prompt: "analyze" } },
            { id: "write_activity_template_proposal", resolver: "fs_write", config: { path: "/workspace/proposals/x.json" }, output_shapes: ["activityTemplateProposal"] },
          ],
        },
      },
    });
    const r = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "obsidian:note", apiKey: "k" });
    const body = r.body as {
      honest_frontier: { claimed_covered: number; truly_covered: number; coverage_overstated_by: number };
      shapes: Array<{ verdict: string; scaffold_clones: string[]; productive: string[] }>;
    };
    expect(body.shapes[0]!.verdict).toBe("falsely_covered");
    expect(body.shapes[0]!.scaffold_clones).toContain("gap-closing:diagnose-note");
    expect(body.shapes[0]!.productive).toEqual([]);
    // claimed coverage (discover match) overstates the truth by 1
    expect(body.honest_frontier.claimed_covered).toBe(1);
    expect(body.honest_frontier.truly_covered).toBe(0);
    expect(body.honest_frontier.coverage_overstated_by).toBe(1);
  });

  it("recognises a productive consumer with trace evidence", async () => {
    mockApi({
      consumers: { "obsidian:note": ["bridge:note-to-concept"] },
      templates: {
        "bridge:note-to-concept": {
          id: "bridge:note-to-concept",
          input_shapes: ["obsidian:note"],
          output_shapes: ["concept_create_write"],
          tasks: [
            { id: "fetch_note", resolver: "http_fetch", input_shapes: ["obsidian:note"], config: { url: "http://obsidian/resolve", body: "obsidian:note" } },
            { id: "classify", resolver: "llm_completion_dispatch", config: { prompt: "extract concept" } },
            { id: "persist", resolver: "http_fetch", config: { url: "http://127.0.0.1:8260/v2/impulses/resolve" }, output_shapes: ["concept_create_write"] },
          ],
        },
      },
      tracesOk: new Set(["bridge:note-to-concept"]),
    });
    const r = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "obsidian:note", apiKey: "k" });
    const body = r.body as { shapes: Array<{ verdict: string; productive: string[] }>; honest_frontier: { truly_covered: number } };
    expect(body.shapes[0]!.verdict).toBe("productively_consumed");
    expect(body.shapes[0]!.productive).toContain("bridge:note-to-concept");
    expect(body.honest_frontier.truly_covered).toBe(1);
  });

  it("a genuine-but-never-run consumer is declared_unproven, NOT productive (no lying)", async () => {
    mockApi({
      consumers: { "obsidian:note": ["bridge:note-to-concept"] },
      templates: {
        "bridge:note-to-concept": {
          id: "bridge:note-to-concept",
          input_shapes: ["obsidian:note"],
          output_shapes: ["concept_create_write"],
          tasks: [
            { id: "fetch_note", resolver: "http_fetch", input_shapes: ["obsidian:note"], config: { url: "http://obsidian", body: "obsidian:note" } },
            { id: "persist", resolver: "http_fetch", config: { url: "http://127.0.0.1:8260" }, output_shapes: ["concept_create_write"] },
          ],
        },
      },
      tracesOk: new Set(), // never ran
    });
    const r = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "obsidian:note", apiKey: "k" });
    const body = r.body as { shapes: Array<{ verdict: string; declared_unproven: string[]; productive: string[] }> };
    expect(body.shapes[0]!.verdict).toBe("falsely_covered"); // unproven ≠ covered
    expect(body.shapes[0]!.declared_unproven).toContain("bridge:note-to-concept");
    expect(body.shapes[0]!.productive).toEqual([]);
  });

  it("requireTraceEvidence:false accepts a statically-genuine consumer", async () => {
    mockApi({
      consumers: { "obsidian:note": ["bridge:note-to-concept"] },
      templates: {
        "bridge:note-to-concept": {
          id: "bridge:note-to-concept",
          input_shapes: ["obsidian:note"],
          output_shapes: ["concept_create_write"],
          tasks: [{ id: "fetch_note", resolver: "http_fetch", input_shapes: ["obsidian:note"], config: { body: "obsidian:note" }, output_shapes: ["concept_create_write"] }],
        },
      },
    });
    const r = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "obsidian:note", apiKey: "k", requireTraceEvidence: false });
    const body = r.body as { shapes: Array<{ verdict: string; productive: string[] }> };
    expect(body.shapes[0]!.verdict).toBe("productively_consumed");
  });

  it("no candidate consumers → uncovered", async () => {
    mockApi({ consumers: {} });
    const r = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "obsidian:event_observed", apiKey: "k" });
    const body = r.body as { shapes: Array<{ verdict: string; candidate_count: number }>; honest_frontier: { claimed_covered: number } };
    expect(body.shapes[0]!.verdict).toBe("uncovered");
    expect(body.shapes[0]!.candidate_count).toBe(0);
    expect(body.honest_frontier.claimed_covered).toBe(0);
  });

  it("missing api key / no shape degrade cleanly", async () => {
    const noShape = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", apiKey: "k" });
    expect((noShape.body as { error: string }).error).toBe("no_shape_specified");
    const noKey = await resolveConsumerProductivityAudit({ type: "consumer_productivity_audit", shape: "x", apiKey: "" });
    expect((noKey.body as { error: string }).error).toBe("missing_api_key");
  });
});
