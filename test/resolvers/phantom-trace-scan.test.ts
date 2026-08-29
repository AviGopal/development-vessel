import { describe, it, expect, afterEach } from "bun:test";
import { resolvePhantomTraceScan } from "../../src/resolvers/phantom-trace-scan.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FetchCalls {
  list: number;
  singleGets: string[];
  emits: unknown[];
}

function makeFetch(
  listTraces: Array<Record<string, unknown>>,
  singleTaskCountByExecId: Record<string, number>,
  calls: FetchCalls,
): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    // LIST: /execution-traces[?...]
    if (url.includes("/execution-traces") && !url.match(/\/execution-traces\/[^?]+$/)) {
      calls.list += 1;
      return new Response(JSON.stringify({ traces: listTraces }), { status: 200 });
    }
    // Single GET: /execution-traces/<id>
    const m = url.match(/\/execution-traces\/([^/?]+)/);
    if (m && m[1]) {
      const id: string = m[1];
      calls.singleGets.push(id);
      const taskCount = singleTaskCountByExecId[id] ?? 0;
      // Return a `tasks` array with that many entries.
      const tasks = Array.from({ length: taskCount }, (_, i) => ({ id: `task_${i}` }));
      return new Response(JSON.stringify({ execution_id: id, tasks }), { status: 200 });
    }
    // Emit endpoint
    if (init && init.method === "POST") {
      const body = init.body ? JSON.parse(init.body as string) : {};
      calls.emits.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// Fixtures must NOT use a META-TEMPLATE id. `validator-dispatch` (along with
// `slot-binding` and `create-shape-provider-goal`) is in META_TEMPLATE_IDS
// (src/lib/meta-templates.ts) — framework wrappers that legitimately have
// task_count=0 and are deliberately excluded from phantom detection, both as an
// early short-circuit (phantom-trace-scan.ts:251) and post-confirmation. These
// fixtures had picked `validator-dispatch` as a filler activity_id before that
// exclusion existed, so every candidate was correctly skipped
// (`list_candidates_skipped_meta: 2`) and phantoms_detected was 0 — the resolver
// was right and the fixtures were self-defeating. A non-meta id restores what
// these cases actually test: confirmation of a phantom via the single-trace GET.
describe("phantom_trace_scan", () => {
  it("confirms candidates via single-trace GET; rejects list false-positives", async () => {
    const listTraces = [
      // List reports task_count=0 (post-migration-118 artefact) but the
      // content table holds 5 tasks → must NOT emit.
      { execution_id: "exec_real_a", status: "success", task_count: 0, activity_id: "some-real-template", duration_ms: 5000 },
      // True phantom: zero tasks in content too → must emit.
      { execution_id: "exec_phantom_b", status: "success", task_count: 0, activity_id: "some-real-template", duration_ms: 9 },
      // Non-success — ignored.
      { execution_id: "exec_failed_c", status: "failure", task_count: 0, activity_id: "some-real-template", duration_ms: 12 },
    ];
    const calls: FetchCalls = { list: 0, singleGets: [], emits: [] };
    globalThis.fetch = makeFetch(
      listTraces,
      { exec_real_a: 5, exec_phantom_b: 0 },
      calls,
    );

    const result = await resolvePhantomTraceScan({
      type: "phantom_trace_scan",
      tracesUrl: "http://t/v2/activities/execution-traces?limit=10",
      devVesselImpulsesUrl: "http://t/v2/impulses/resolve",
      maxEmits: 50,
    });

    expect(result.shape).toBe("phantomTraceReport");
    const body = result.body as Record<string, unknown>;
    expect(body.phantoms_detected).toBe(1);
    expect(body.list_candidates_rejected_after_confirm).toBe(1);
    expect((body.phantom_entries as Array<{ exec_id: string }>).map((p) => p.exec_id)).toEqual(["exec_phantom_b"]);
    expect(calls.singleGets).toContain("exec_real_a");
    expect(calls.singleGets).toContain("exec_phantom_b");
    expect(calls.emits.length).toBe(1);
  });

  it("dry_run skips emits", async () => {
    const listTraces = [
      { execution_id: "exec_p", status: "success", task_count: 0, activity_id: "some-real-template", duration_ms: 5 },
    ];
    const calls: FetchCalls = { list: 0, singleGets: [], emits: [] };
    globalThis.fetch = makeFetch(listTraces, { exec_p: 0 }, calls);

    const result = await resolvePhantomTraceScan({
      type: "phantom_trace_scan",
      tracesUrl: "http://t/v2/activities/execution-traces?limit=10",
      devVesselImpulsesUrl: "http://t/v2/impulses/resolve",
      dry_run: true,
    });

    const body = result.body as Record<string, unknown>;
    expect(body.phantoms_detected).toBe(1);
    expect(body.phantoms_posted).toBe(0);
    expect(calls.emits.length).toBe(0);
  });
});
