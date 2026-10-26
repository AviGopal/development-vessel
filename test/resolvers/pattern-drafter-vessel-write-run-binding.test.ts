/**
 * The attribution a drafted vessel write carries binds to the run that executes it.
 *
 * Registration (activity_create_variant, permissive scope) stamps a drafted *_write task with
 * execution_id "{{execution_id}}" and the template's own id. The token is only worth stamping if
 * the engine binds it: ias-executor seeds accumulatedVariables.execution_id with the run's
 * executionId and binds plain {{name}} config tokens from the run's variables, recording a name it
 * cannot bind as the task's unboundTemplateVariables. These pins take a template through the real
 * registration normaliser and then the real engine (ActivityExecutor.execute), with a stub
 * resolver for the write shape that captures the config it is handed:
 *   - the stamped execution_id arrives as the run's executionId, with nothing recorded unbound;
 *   - a {{dispatch_id}} token in the same config binds when the run is given variables.dispatch_id
 *     (registration does not stamp it; this only shows it is bindable);
 *   - MUST-FAIL: a misspelled token ({{executionid}}) does not bind and is recorded unbound, which
 *     is what makes the binding assertion a real check. CONTROL: the correct token binds.
 * The write shape is a generic fixture (widget_write); fetch is stubbed, nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActivityExecutor, ExecutionRuntime, type ActivityTemplate, type Resolver } from "@avigopal/ias-executor-ts";
import { resolveActivityCreateVariant } from "../../src/resolvers/activity-create-variant.js";

const realFetch = globalThis.fetch;
let posted: Record<string, unknown> | null = null;
beforeAll(() => {
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/discover-by-shapes")) return new Response(JSON.stringify({ activities: [] }), { status: 200 });
    if (u.endsWith("/v2/activities/templates")) {
      posted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: posted["id"] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

const DESC = "A task description long enough to satisfy the registration-time discipline floor.";

/** A one-task draft whose write is still the http_fetch POST form, through the real normaliser. */
async function registeredWriter(id: string, pointerFields: Record<string, unknown>): Promise<ActivityTemplate> {
  posted = null;
  const draft = {
    id, name: "widget_writer", description: "Fixture draft for the run-binding pins.", tags: ["substrate.authored"],
    inputShapes: [], outputShapes: [], authored_from_pattern: { pattern_id: "fixture_cluster", observation_window: "2026-10-01/2026-10-02", contrast_examples: 1 },
    cited_concept_ids: [],
    tasks: [{ id: "persist_widget", description: DESC, resolver: "http_fetch",
      config: { type: "http_fetch", url: "http://127.0.0.1:8999/v2/impulses/resolve", method: "POST", body: JSON.stringify({ pointer: { type: "widget_write", ...pointerFields } }) },
      outputShapes: ["httpResponse"] }],
  };
  const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: JSON.stringify(draft), validate_permissive_scope: true, _registryLookupFn: async () => [] } as never);
  expect(r.shape).toBe("activityRegistryChange");
  return posted as unknown as ActivityTemplate;
}

/** Execute a template on the real engine with a widget_write stub; returns the trace and the config the stub saw. */
async function run(template: ActivityTemplate, variables: Record<string, unknown> = {}) {
  const seen: Record<string, unknown>[] = [];
  const runtime = new ExecutionRuntime();
  const widgetWrite: Resolver = {
    id: "widget_write",
    tier: "external",
    async resolve(ctx) {
      seen.push({ ...(ctx.task.config as Record<string, unknown>) });
      return [{ id: ctx.random.id("out"), pointer: { type: "widget_write" }, metadata: { shape: "widget_write" }, loaded: true, content: "written" }];
    },
  };
  runtime.resolvers.register(widgetWrite);
  const trace = await new ActivityExecutor(runtime).execute(template, { variables });
  const rec = trace.tasks.find((t) => t.taskId === "persist_widget");
  return { trace, rec, seen };
}

describe("a drafted vessel write's attribution binds to the executing run", () => {
  test("the stamped execution_id arrives as the run's executionId, nothing unbound", async () => {
    const tpl = await registeredWriter("proposed_pattern_authored_run_binding_fixture", { widget: { name: "w" } });
    const task = tpl.tasks[0]!;
    expect([task.resolver, (task.config as Record<string, unknown>)["execution_id"]]).toEqual(["widget_write", "{{execution_id}}"]);
    const { trace, rec, seen } = await run(tpl);
    expect(trace.status).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]!["execution_id"]).toBe(trace.id);
    expect(seen[0]!["execution_id"]).not.toBe("{{execution_id}}");
    expect(seen[0]!["template_id"]).toBe("proposed_pattern_authored_run_binding_fixture");
    expect(rec?.unboundTemplateVariables ?? []).toEqual([]);
  });

  test("a {{dispatch_id}} token in the same config binds to the run's variables.dispatch_id", async () => {
    const tpl = await registeredWriter("proposed_pattern_authored_dispatch_binding_fixture", { widget: { name: "w" }, dispatch_id: "{{dispatch_id}}" });
    const { trace, rec, seen } = await run(tpl, { dispatch_id: "dispatch-fixture-1" });
    expect(trace.status).toBe("completed");
    expect(seen[0]!["dispatch_id"]).toBe("dispatch-fixture-1");
    expect(seen[0]!["execution_id"]).toBe(trace.id);
    expect(rec?.unboundTemplateVariables ?? []).toEqual([]);
  });

  test("MUST-FAIL: a misspelled token ({{executionid}}) stays literal and is recorded unbound", async () => {
    const tpl = await registeredWriter("proposed_pattern_authored_misspelled_fixture", { widget: { name: "w" }, execution_id: "{{executionid}}" });
    const { trace, rec, seen } = await run(tpl);
    expect(seen[0]!["execution_id"]).toBe("{{executionid}}");
    expect(seen[0]!["execution_id"]).not.toBe(trace.id);
    expect(rec?.unboundTemplateVariables).toEqual(["executionid"]);
  });

  test("CONTROL: the correctly spelled token, written by the draft itself, binds", async () => {
    const tpl = await registeredWriter("proposed_pattern_authored_spelled_fixture", { widget: { name: "w" }, execution_id: "{{execution_id}}" });
    const { trace, rec, seen } = await run(tpl);
    expect(seen[0]!["execution_id"]).toBe(trace.id);
    expect(rec?.unboundTemplateVariables ?? []).toEqual([]);
  });
});
