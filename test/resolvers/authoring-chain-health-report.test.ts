import { describe, it, expect, afterEach } from "bun:test";
import { resolveAuthoringChainHealthReport } from "../../src/resolvers/authoring-chain-health-report.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(executions: Array<Record<string, unknown>>): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify({ executions }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("authoring_chain_health_report", () => {
  it("classifies preflight_rejection (dur<500, task_count=0, status=failure)", async () => {
    globalThis.fetch = makeFetch([
      {
        execution_id: "exec_preflight_a",
        status: "failure",
        duration_ms: 2,
        task_count: 0,
        activity_id: "draft-gap-closing-activity",
      },
    ]);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    expect(r.shape).toBe("authoringChainHealthReport");
    const body = r.body as any;
    expect(body.categories.preflight_rejection.count).toBe(1);
    expect(body.categories.preflight_rejection.sample_exec_ids).toContain("exec_preflight_a");
    expect(body.categories.success.count).toBe(0);
    expect(body.health_verdict).toBe("BLOCKED");
  });

  it("classifies chain_truncation (failure + all tasks success + no failure_mode)", async () => {
    globalThis.fetch = makeFetch([
      {
        execution_id: "exec_truncation_b",
        status: "failure",
        duration_ms: 4500,
        tasks: [
          { id: "t1", success: true },
          { id: "t2", success: true },
          { id: "t3", success: true },
          { id: "t4", success: true },
        ],
        failure_mode: null,
        activity_id: "observe-and-author-from-gaps",
      },
    ]);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    const body = r.body as any;
    expect(body.categories.chain_truncation.count).toBe(1);
    expect(body.categories.preflight_rejection.count).toBe(0);
    expect(body.health_verdict).toBe("BLOCKED");
  });

  it("classifies authoring_completed when git_push or gh_pr_create in output shapes", async () => {
    globalThis.fetch = makeFetch([
      {
        execution_id: "exec_completed_c",
        status: "success",
        duration_ms: 8000,
        output_impulse_shapes: ["fs_write", "git_commit", "git_push", "gh_pr_create"],
        activity_id: "publish-substrate-authored-artifact",
      },
    ]);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    const body = r.body as any;
    expect(body.categories.authoring_completed.count).toBe(1);
    expect(body.health_verdict).toBe("HEALTHY");
  });

  it("returns DEGRADED when both completions and failures present", async () => {
    globalThis.fetch = makeFetch([
      {
        execution_id: "exec_completed_d",
        status: "success",
        duration_ms: 7000,
        output_impulse_shapes: ["git_push"],
        activity_id: "publish-substrate-authored-artifact",
      },
      {
        execution_id: "exec_preflight_e",
        status: "failure",
        duration_ms: 4,
        task_count: 0,
        activity_id: "draft-gap-closing-activity",
      },
    ]);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    const body = r.body as any;
    expect(body.categories.authoring_completed.count).toBe(1);
    expect(body.categories.preflight_rejection.count).toBe(1);
    expect(body.health_verdict).toBe("DEGRADED");
  });

  it("per-template blocked list orders by failure count desc", async () => {
    const traces = [
      ...Array.from({ length: 3 }, (_, i) => ({
        execution_id: `exec_pref_${i}`,
        status: "failure",
        duration_ms: 3,
        task_count: 0,
        activity_id: "template_alpha",
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        execution_id: `exec_truncate_${i}`,
        status: "failure",
        duration_ms: 5000,
        tasks: [{ id: "t1", success: true }, { id: "t2", success: true }],
        failure_mode: null,
        activity_id: "template_beta",
      })),
    ];
    globalThis.fetch = makeFetch(traces);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    const body = r.body as any;
    expect(body.blocked_template_count).toBe(2);
    expect(body.blocked_templates_top10[0].template_id).toBe("template_beta");
    expect(body.blocked_templates_top10[0].chain_truncation).toBe(7);
    expect(body.blocked_templates_top10[1].template_id).toBe("template_alpha");
    expect(body.blocked_templates_top10[1].preflight_rejection).toBe(3);
    expect(body.health_verdict).toBe("BLOCKED");
  });

  it("returns HEALTHY when there are no traces in window", async () => {
    globalThis.fetch = makeFetch([]);
    const r = await resolveAuthoringChainHealthReport({ type: "authoring_chain_health_report" });
    const body = r.body as any;
    expect(body.scanned).toBe(0);
    expect(body.health_verdict).toBe("HEALTHY");
  });
});
