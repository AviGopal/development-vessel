import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveTraceRecurringPatternScan } from "../../src/resolvers/trace-recurring-pattern-scan.js";

const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "trps-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(tmp, { recursive: true, force: true });
});

interface FakeTrace {
  execution_id: string;
  activity_id: string;
  status: string;
  output_impulse_shapes?: string[] | null;
}

function mockApi(traces: FakeTrace[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    if (u.includes("/run-goal")) {
      return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const PTR = (extra: Record<string, unknown> = {}) => ({
  type: "trace_recurring_pattern_scan" as const,
  apiKey: "test-key",
  metabobEndpoint: "http://api.test",
  goalHostEndpoint: "http://goalhost.test",
  patternsDir: tmp,
  ...extra,
});

describe("trace_recurring_pattern_scan", () => {
  it("picks the top recurrent output-shape signature, excludes meta/wrappers, writes + dispatches", async () => {
    const traces: FakeTrace[] = [
      // winner: alpha+beta recurs 4x via a genuine composer
      { execution_id: "e1", activity_id: "real-composer", status: "success", output_impulse_shapes: ["beta", "alpha"] },
      { execution_id: "e2", activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha", "beta"] },
      { execution_id: "e3", activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha", "beta"] },
      { execution_id: "e4", activity_id: "another-composer", status: "success", output_impulse_shapes: ["alpha", "beta"] },
      // below threshold
      { execution_id: "e5", activity_id: "real-composer", status: "success", output_impulse_shapes: ["gamma"] },
      // excluded: meta-activity (slot-binding) recurs 5x but must NOT win
      { execution_id: "m1", activity_id: "slot-binding", status: "success", output_impulse_shapes: ["x"] },
      { execution_id: "m2", activity_id: "slot-binding", status: "success", output_impulse_shapes: ["x"] },
      { execution_id: "m3", activity_id: "slot-binding", status: "success", output_impulse_shapes: ["x"] },
      { execution_id: "m4", activity_id: "slot-binding", status: "success", output_impulse_shapes: ["x"] },
      { execution_id: "m5", activity_id: "slot-binding", status: "success", output_impulse_shapes: ["x"] },
      // excluded: deterministic tick wrapper
      { execution_id: "t1", activity_id: "development-vessel:coverage-tick", status: "success", output_impulse_shapes: ["cov"] },
      { execution_id: "t2", activity_id: "development-vessel:coverage-tick", status: "success", output_impulse_shapes: ["cov"] },
      { execution_id: "t3", activity_id: "development-vessel:coverage-tick", status: "success", output_impulse_shapes: ["cov"] },
      // excluded: gap-closing clone
      { execution_id: "g1", activity_id: "gap-closing:auto-1", status: "success", output_impulse_shapes: ["patch_proposal"] },
      { execution_id: "g2", activity_id: "gap-closing:auto-1", status: "success", output_impulse_shapes: ["patch_proposal"] },
      { execution_id: "g3", activity_id: "gap-closing:auto-1", status: "success", output_impulse_shapes: ["patch_proposal"] },
      // contrast: a failure of the winning activity
      { execution_id: "f1", activity_id: "real-composer", status: "failure", output_impulse_shapes: ["alpha", "beta"] },
    ];
    const calls = mockApi(traces);
    const r = await resolveTraceRecurringPatternScan(PTR({ dispatch: true }));
    expect(r.shape).toBe("recurringPatternCluster");
    const b = r.body as Record<string, unknown>;
    expect(b.has_pattern).toBe(true);
    expect(b.signature).toEqual(["alpha", "beta"]); // sorted
    expect(b.recurrence).toBe(4);
    expect(b.n_contrast_examples).toBe(1);
    expect(b.dispatched_to_author).toBe(true);

    // cluster file written with anti-scaffold guidance + real topology hint
    const written = JSON.parse(await fs.readFile(String(b.cluster_path), "utf8"));
    expect(written.expected_outputs).toEqual(["alpha", "beta"]);
    expect(written.deny_list).toContain("patch_proposal");
    expect(written.topology_hint).toContain("real resolver calls");

    // dispatch targeted the real-chain author by pattern_id
    const dispatch = calls.find((c) => c.url.includes("/run-goal"));
    expect((dispatch?.body as Record<string, unknown>)?.targetTemplateId).toBe("development-vessel:draft-activity-from-pattern");
  });

  it("excludes the substrate's own machinery (development-vessel:*) — no self-reference loop", async () => {
    // The feeder's own output recurring 6x must NOT be picked — including when
    // the activity_id is record-ref WRAPPED (activity:⟨…⟩), as it is in the store.
    const traces: FakeTrace[] = [1, 2, 3].map((n) => ({
      execution_id: `s${n}`,
      activity_id: "development-vessel:detect-recurring-trace-pattern",
      status: "success",
      output_impulse_shapes: ["recurringPatternCluster"],
    }));
    traces.push(
      ...[4, 5, 6].map((n) => ({
        execution_id: `s${n}`,
        activity_id: "activity:⟨development-vessel:draft-activity-from-pattern⟩",
        status: "success",
        output_impulse_shapes: ["recurringPatternCluster"],
      })),
    );
    // ...while a genuine non-machinery topology recurs only 3x
    traces.push(
      ...[1, 2, 3].map((n) => ({
        execution_id: `r${n}`,
        activity_id: "composed-goal-run",
        status: "success",
        output_impulse_shapes: ["fileContent", "httpResponse"],
      })),
    );
    mockApi(traces);
    const r = await resolveTraceRecurringPatternScan(PTR());
    const b = r.body as Record<string, unknown>;
    expect(b.has_pattern).toBe(true);
    expect(b.signature).toEqual(["fileContent", "httpResponse"]); // the genuine topology, not the feeder's own output
    expect((b.producing_activities as string[])).not.toContain("development-vessel:detect-recurring-trace-pattern");
  });

  it("returns has_pattern=false when nothing meets minRecurrence", async () => {
    mockApi([
      { execution_id: "e1", activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha"] },
      { execution_id: "e2", activity_id: "real-composer", status: "success", output_impulse_shapes: ["beta"] },
    ]);
    const r = await resolveTraceRecurringPatternScan(PTR());
    expect((r.body as Record<string, unknown>).has_pattern).toBe(false);
  });

  it("derives a STABLE pattern_id from the signature (dedupe across ticks)", async () => {
    const traces: FakeTrace[] = [1, 2, 3].map((n) => ({
      execution_id: `e${n}`,
      activity_id: "real-composer",
      status: "success",
      output_impulse_shapes: ["alpha", "beta"],
    }));
    mockApi(traces);
    const r1 = await resolveTraceRecurringPatternScan(PTR());
    mockApi(traces);
    const r2 = await resolveTraceRecurringPatternScan(PTR());
    expect((r1.body as Record<string, unknown>).pattern_id).toBe((r2.body as Record<string, unknown>).pattern_id);
  });
});
