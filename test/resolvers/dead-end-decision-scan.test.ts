import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { resolveDeadEndDecisionScan } from "../../src/resolvers/dead-end-decision-scan.js";

const originalFetch = globalThis.fetch;
const originalPass = process.env["SURREALDB_PASSWORD"];

beforeEach(() => {
  // The resolver no-ops (returns [] rows) without a SurrealDB password; set one
  // so the scripted /sql fetch below is actually exercised. No real network —
  // globalThis.fetch is replaced per-test.
  process.env["SURREALDB_PASSWORD"] = "test-pass";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPass === undefined) delete process.env["SURREALDB_PASSWORD"];
  else process.env["SURREALDB_PASSWORD"] = originalPass;
});

interface Calls {
  sql: number;
  emits: Array<Record<string, unknown>>;
}

type TaskFixture = {
  task_id: string;
  resolver_id: string;
  input_impulse_ids: string[];
  output_impulse_ids: string[];
};
type RowFixture = { execution_id: string; activity_id: string | null; tasks: TaskFixture[] };

/** Fake fetch: /sql returns the scripted content rows; the dev-vessel resolve
 *  endpoint records emitted substrateGap bodies. */
function makeFetch(rows: RowFixture[], calls: Calls): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (url.endsWith("/sql")) {
      calls.sql += 1;
      // SurrealDB /sql shape: array of statement results, last one carries rows.
      return new Response(JSON.stringify([{ status: "OK", result: rows }]), { status: 200 });
    }
    if (url.includes("/v2/impulses/resolve") && init?.method === "POST") {
      const body = init.body ? JSON.parse(init.body as string) : {};
      calls.emits.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** Build N copies of a single-task-class trace so we can cross the
 *  min_occurrences threshold deterministically. */
function repeatRows(n: number, build: (i: number) => RowFixture): RowFixture[] {
  return Array.from({ length: n }, (_, i) => build(i));
}

describe("dead_end_decision_scan", () => {
  it("(a) emits one gap when a decision task's output is consumed by no later task (fraction 1.0)", async () => {
    // select_or_produce (resolver iteration) produces an id; a LATER non-actionable
    // task exists but does NOT consume it → entire output dead, non-terminal.
    const rows = repeatRows(12, (i) => ({
      execution_id: `exec_dead_${i}`,
      activity_id: null,
      tasks: [
        { task_id: "prepare_pool", resolver_id: "impulse_preparation", input_impulse_ids: ["seed"], output_impulse_ids: [] },
        { task_id: "select_or_produce", resolver_id: "iteration", input_impulse_ids: ["seed"], output_impulse_ids: [`iter_${i}`] },
        { task_id: "agent_fill_fallback", resolver_id: "impulse_preparation", input_impulse_ids: ["seed"], output_impulse_ids: [] },
      ],
    }));
    const calls: Calls = { sql: 0, emits: [] };
    globalThis.fetch = makeFetch(rows, calls);

    const res = await resolveDeadEndDecisionScan({
      type: "dead_end_decision_scan",
      window_hours: 24,
      min_occurrences: 10,
      dead_end_threshold: 0.9,
      emit_gap: true,
    });

    expect(res.shape).toBe("deadEndDecisionReport");
    const body = res.body as any;
    expect(body.dead_end_task_classes).toBe(1);
    expect(body.gaps_emitted).toBe(1);
    const top = body.top_dead_ends.find((t: any) => t.task_id === "select_or_produce");
    expect(top).toBeDefined();
    expect(top.dead_end_fraction).toBe(1);
    expect(top.total_occurrences).toBe(12);
    // Gap shape check.
    expect(calls.emits.length).toBe(1);
    const gap = (calls.emits[0] as any).impulse.pointer.gap;
    expect(gap.category).toBe("decision_without_action");
    expect(gap.id).toBe("decision-without-action-unknown-select_or_produce");
    expect(gap.classification_metadata.detector).toBe("dead_end_decision_scan");
    expect(gap.classification_metadata.decision_task_id).toBe("select_or_produce");
  });

  it("(b) negative: a later task consumes the decision output → no gap", async () => {
    const rows = repeatRows(12, (i) => ({
      execution_id: `exec_ok_${i}`,
      activity_id: null,
      tasks: [
        { task_id: "select_or_produce", resolver_id: "iteration", input_impulse_ids: ["seed"], output_impulse_ids: [`iter_${i}`] },
        // downstream task DOES consume the decision → acted on.
        { task_id: "dispatch_producer", resolver_id: "activity", input_impulse_ids: [`iter_${i}`], output_impulse_ids: ["done"] },
      ],
    }));
    const calls: Calls = { sql: 0, emits: [] };
    globalThis.fetch = makeFetch(rows, calls);

    const res = await resolveDeadEndDecisionScan({
      type: "dead_end_decision_scan", min_occurrences: 10, dead_end_threshold: 0.9, emit_gap: true,
    });
    const body = res.body as any;
    expect(body.dead_end_task_classes).toBe(0);
    expect(body.gaps_emitted).toBe(0);
    expect(calls.emits.length).toBe(0);
    // It was examined (actionable) but not dead.
    const top = body.top_dead_ends.find((t: any) => t.task_id === "select_or_produce");
    expect(top.dead_end_fraction).toBe(0);
  });

  it("(c) terminal: last task is actionable+unconsumed → not a dead end", async () => {
    const rows = repeatRows(12, (i) => ({
      execution_id: `exec_term_${i}`,
      activity_id: null,
      tasks: [
        { task_id: "prepare", resolver_id: "impulse_preparation", input_impulse_ids: ["seed"], output_impulse_ids: ["p"] },
        // actionable decision but it's the LAST task → its output legitimately sinks.
        { task_id: "select_candidate", resolver_id: "iteration", input_impulse_ids: ["p"], output_impulse_ids: [`iter_${i}`] },
      ],
    }));
    const calls: Calls = { sql: 0, emits: [] };
    globalThis.fetch = makeFetch(rows, calls);

    const res = await resolveDeadEndDecisionScan({
      type: "dead_end_decision_scan", min_occurrences: 10, dead_end_threshold: 0.9, emit_gap: true,
    });
    const body = res.body as any;
    // The terminal actionable task is skipped entirely (not even examined).
    expect(body.dead_end_task_classes).toBe(0);
    expect(body.gaps_emitted).toBe(0);
    expect(body.decision_tasks_examined).toBe(0);
  });

  it("(d) below min_occurrences → no gap even at fraction 1.0", async () => {
    const rows = repeatRows(5, (i) => ({
      execution_id: `exec_few_${i}`,
      activity_id: null,
      tasks: [
        { task_id: "select_or_produce", resolver_id: "iteration", input_impulse_ids: ["seed"], output_impulse_ids: [`iter_${i}`] },
        { task_id: "agent_fill_fallback", resolver_id: "impulse_preparation", input_impulse_ids: ["seed"], output_impulse_ids: [] },
      ],
    }));
    const calls: Calls = { sql: 0, emits: [] };
    globalThis.fetch = makeFetch(rows, calls);

    const res = await resolveDeadEndDecisionScan({
      type: "dead_end_decision_scan", min_occurrences: 10, dead_end_threshold: 0.9, emit_gap: true,
    });
    const body = res.body as any;
    expect(body.dead_end_task_classes).toBe(0);
    expect(body.gaps_emitted).toBe(0);
    // Still surfaced in top_dead_ends (visibility) at fraction 1.0 but below threshold.
    const top = body.top_dead_ends.find((t: any) => t.task_id === "select_or_produce");
    expect(top.total_occurrences).toBe(5);
    expect(top.dead_end_fraction).toBe(1);
  });

  it("(e) terminal-by-role: a report/observer task is excluded even when non-terminal-by-position", async () => {
    const rows = repeatRows(12, (i) => ({
      execution_id: `exec_obs_${i}`,
      activity_id: null,
      tasks: [
        // matches actionable (/rank/) but also matches terminal (/report/) → excluded.
        { task_id: "rank_health_report", resolver_id: "iteration", input_impulse_ids: ["seed"], output_impulse_ids: [`r_${i}`] },
        { task_id: "noop_tail", resolver_id: "noop", input_impulse_ids: ["seed"], output_impulse_ids: [] },
      ],
    }));
    const calls: Calls = { sql: 0, emits: [] };
    globalThis.fetch = makeFetch(rows, calls);

    const res = await resolveDeadEndDecisionScan({
      type: "dead_end_decision_scan", min_occurrences: 10, dead_end_threshold: 0.9, emit_gap: true,
    });
    const body = res.body as any;
    expect(body.decision_tasks_examined).toBe(0);
    expect(body.gaps_emitted).toBe(0);
  });
});
