// A LIST FETCH BOUND INTO AN LLM PROMPT IS PROJECTED (activity-create-variant.ts projectTraceListFetches).
// Measured: gap-closing variants fetched `execution-traces?limit=20` and bound the raw list into the analyze prompt
// ({{fetch_traces_content}}), about 265-279k input tokens against the 200k ceiling, so llm-resolver refused every run.
// The composer now rewrites that fetch into a task of the read-only trace_failure_pattern_report's own shape, which the
// executor routes through discovery.
// The MF registers a gap-closing template, then runs its fetch task the way it would run (the raw list for a GET of the
// list, the real report resolver for the rewritten task) and measures the analyze prompt it binds.
//
// Scenario ids come from a 5-word draw (EFF large list, research-watch/draw-words.sh):
//   seed=1793079386674392530 words=mayday badly prance banister driller
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { resolveActivityCreateVariant } from "../../src/resolvers/activity-create-variant.js";
import { resolveTraceFailurePatternReport } from "../../src/resolvers/trace-failure-pattern-report.js";

const originalFetch = globalThis.fetch;
const SCENARIO = "mayday-badly-prance-banister-driller";
/** llm-resolver's default per-call input ceiling (llmModelPolicy.max_input_tokens), estimated as chars / 4. */
const CEILING_TOKENS = 200_000;
/** The tuning row and its recorded default (named here, not imported, so the controls also run against the parent). */
const GAP_CLOSING_TRACE_PROJECTION_LIMIT_ROW = "gap_closing.trace_projection_limit";
const GAP_CLOSING_TRACE_PROJECTION_LIMIT_DEFAULT = 20;

/** 20 failed traces with heavy task bodies, the shape of the list the route returns. */
const heavyTraces = (n: number) => ({
  executions: Array.from({ length: n }, (_, i) => ({
    id: `exec_${SCENARIO}_${i}`,
    activity_id: `gap-closing:${SCENARIO}-${i % 4}`,
    status: "failure",
    failure_mode: { type: "execution_error", reason: "prompt too large" },
    executed_at: new Date(1_790_000_000_000 + i * 1000).toISOString(),
    tasks: [
      { task_id: "read_scenario", success: true, output: "s".repeat(20_000) },
      { task_id: "fetch_traces", success: true, output: "t".repeat(30_000) },
      { task_id: "analyze", success: false, output: "a".repeat(10_000) },
    ],
  })),
});

const draftedTemplate = (fetchUrl: string, prompt = "Scenario: {{read_scenario_content}}\n\nRecent traces: {{fetch_traces_content}}") => ({
  id: `gap-closing:${SCENARIO}`,
  name: SCENARIO,
  description: "Drafted gap-closing template that reads its scenario, the recent traces, and proposes one patch.",
  tags: ["gap-closing"],
  outputShapes: ["patch_proposal"],
  tasks: [
    { id: "read_scenario", description: "read the scenario", resolver: "fs_read", config: { type: "fs_read", path: `/workspace/validation/failure-modes/scenarios/${SCENARIO}.json` } },
    { id: "fetch_traces", description: "fetch recent traces", resolver: "http_fetch", config: { type: "http_fetch", url: fetchUrl, method: "GET" } },
    { id: "analyze", description: "analyze into a patch proposal", resolver: "llm_completion_dispatch", config: { type: "llm_completion_dispatch", prompt, model: "auto", max_tokens: 1000 }, outputShapes: ["patch_proposal"] },
  ],
});

type Task = { id: string; resolver: string; config: Record<string, unknown> };

/** Register through the composer; return the template it POSTed to activity-api. */
async function register(template: unknown, tuning: number | null = null): Promise<{ tasks: Task[] } & Record<string, unknown>> {
  let posted: Record<string, unknown> | null = null;
  globalThis.fetch = (async (url: string | URL, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v2/tuning-params/")) {
      return tuning === null || !u.includes(encodeURIComponent(GAP_CLOSING_TRACE_PROJECTION_LIMIT_ROW))
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ value: tuning }), { status: 200 });
    }
    if (u.includes("/v2/activities/templates?limit=")) return new Response(JSON.stringify({ templates: [] }), { status: 200 });
    if (u.includes("discover-by-shapes")) return new Response(JSON.stringify({ activities: [] }), { status: 200 });
    if ((opts?.method ?? "GET") === "POST") {
      posted = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "v:registered" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: structuredClone(template) });
  expect(r.shape).toBe("activityRegistryChange");
  expect(posted).not.toBeNull();
  return posted as unknown as { tasks: Task[] } & Record<string, unknown>;
}

/** Run the fetch task as the template would: the raw list for the http_fetch, the real report for the summary task. */
async function runFetch(task: Task): Promise<string> {
  const list = heavyTraces(20);
  if (task.resolver === "http_fetch") return JSON.stringify(list);
  // A shape-named task: the executor resolves it through discovery with pointer { type: <shape>, ...config }.
  const pointer = { type: task.resolver, ...task.config };
  expect(pointer["type"]).toBe("trace_failure_pattern_report");
  globalThis.fetch = (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;
  return JSON.stringify(await resolveTraceFailurePatternReport(pointer as never));
}

function boundPromptTokens(registered: { tasks: Task[] }, fetched: string): number {
  const analyze = registered.tasks.find((t) => t.id === "analyze")!;
  const prompt = String(analyze.config["prompt"]).replace("{{fetch_traces_content}}", fetched);
  return Math.ceil(prompt.length / 4);
}

describe("gap-closing composer: a list fetch bound into an llm prompt is projected", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("[MUST-FAIL] a composed gap-closing template binding a 20-trace fetch binds an analyze prompt under the ceiling", async () => {
    const registered = await register(draftedTemplate("http://127.0.0.1:8080/v2/activities/execution-traces?limit=20"));
    const fetch = registered.tasks.find((t) => t.id === "fetch_traces")!;
    const tokens = boundPromptTokens(registered, await runFetch(fetch));
    expect(tokens).toBeLessThan(CEILING_TOKENS);
  });

  it("[MUST-FAIL] the fetch becomes a task of the read-only summary's own shape (routed by discovery), which writes nothing", async () => {
    const registered = await register(draftedTemplate("http://127.0.0.1:8080/v2/activities/execution-traces?limit=20"));
    const task = registered.tasks.find((t) => t.id === "fetch_traces")!;
    expect(task.resolver).toBe("trace_failure_pattern_report");
    expect(task.config).toEqual({ type: "trace_failure_pattern_report", limit: GAP_CLOSING_TRACE_PROJECTION_LIMIT_DEFAULT, min_occurrences: 1, emit_gap: false });
    expect(JSON.stringify(task.config)).not.toContain("127.0.0.1");
  });

  it("[MUST-FAIL] how many traces the summary scans is the shaped tuning row, read at registration", async () => {
    const registered = await register(draftedTemplate("http://127.0.0.1:8080/v2/activities/execution-traces?limit=20"), 7);
    expect(registered.tasks.find((t) => t.id === "fetch_traces")!.config["limit"]).toBe(7);
  });

  it("CONTROL: a drafted task of the summary shape that files gaps (emit_gap not false) is still refused at registration", async () => {
    const t = draftedTemplate("http://127.0.0.1:8080/v2/activities/discover-by-shapes");
    (t.tasks as unknown[]).push({ id: "extra", description: "extra summary", resolver: "trace_failure_pattern_report", config: { type: "trace_failure_pattern_report", emit_gap: true } });
    globalThis.fetch = (async () => new Response(JSON.stringify({ templates: [] }), { status: 200 })) as unknown as typeof fetch;
    const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: t });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { failure_mode: string }).failure_mode).toBe("validation_rejected");
  });

  it("CONTROL: a list fetch no llm task binds is left as it is", async () => {
    const url = "http://127.0.0.1:8080/v2/activities/execution-traces?limit=20";
    const t = draftedTemplate(url, "Write a one-line note for the operator.");
    const registered = await register(t);
    const fetch = registered.tasks.find((x) => x.id === "fetch_traces")!;
    expect(fetch.config).toEqual({ type: "http_fetch", url, method: "GET" });
  });

  it("CONTROL: a non-list input (another URL, a POST, an fs_read) is untouched", async () => {
    const url = "http://127.0.0.1:8080/v2/activities/execution-traces/exec_one";
    const registered = await register(draftedTemplate(url));
    expect(registered.tasks.find((x) => x.id === "fetch_traces")!.config).toEqual({ type: "http_fetch", url, method: "GET" });
    expect(registered.tasks.find((x) => x.id === "read_scenario")!.config).toEqual({ type: "fs_read", path: `/workspace/validation/failure-modes/scenarios/${SCENARIO}.json` });
  });

  it("[MUST-FAIL] what the analyze prompt binds is the summary the resolver returns over the 20 traces", async () => {
    const registered = await register(draftedTemplate("http://127.0.0.1:8080/v2/activities/execution-traces?limit=20"));
    const fetched = await runFetch(registered.tasks.find((t) => t.id === "fetch_traces")!);
    const report = JSON.parse(fetched) as { shape: string; body: { traces_examined: number; patterns: unknown[] } };
    expect(report.shape).toBe("failurePatternReport");
    expect(report.body.traces_examined).toBe(20);
    expect(report.body.patterns.length).toBeGreaterThan(0);
  });
});
