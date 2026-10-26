/**
 * A drafted substrate write is a resolver task named by its *_write shape, not an http_fetch POST.
 *
 * draft-activity-from-pattern told the drafter to POST a write's pointer to a vessel's /resolve
 * route through http_fetch, with a hardcoded loopback port per store. The write then lived inside a
 * body string, where the write doors (which read a task's resolver and declared shapes) cannot see
 * it. goal-host registers a discovery-proxy resolver per advertised shape, so the write is routed by
 * name instead. These pins hold both halves without calling a model:
 *   (a) the drafting prompt offers a vessel *_write as a resolver task and makes it the LAST task,
 *       declared in the task's and the template's outputShapes;
 *   (b) registration (activity_create_variant, permissive scope) rewrites the http_fetch form a
 *       fixed draft still carries into that resolver task, attributed to the run and the template.
 * Controls: a read-only draft, an external http_fetch POST, and a gap-closing draft are unchanged.
 * The write shape is a generic fixture (widget_write); fetch is stubbed, nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveActivityCreateVariant } from "../../src/resolvers/activity-create-variant.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE as TPL } from "../../src/seed/draft-activity-from-pattern.js";

const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });

type Task = { id: string; description: string; resolver: string; config: Record<string, unknown>; outputShapes?: string[] };
type Posted = { id: string; tasks: Task[]; outputShapes?: string[]; output_shapes?: string[] };

let posted: Posted | null = null;
/** Shapes the stubbed registry already has a producer for (discover-by-shapes answers CONTAINSANY). */
let producedElsewhere = new Set<string>();
beforeAll(() => {
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/discover-by-shapes")) {
      const req = (JSON.parse(String(init?.body ?? "{}")) as { required_shapes?: string[] }).required_shapes ?? [];
      const hit = req.some((s) => producedElsewhere.has(s));
      return new Response(JSON.stringify({ activities: hit ? [{ id: "proposed_pattern_authored_other_writer" }] : [] }), { status: 200 });
    }
    if (u.endsWith("/v2/activities/templates")) {
      posted = JSON.parse(String(init?.body ?? "{}")) as Posted;
      return new Response(JSON.stringify({ id: posted.id }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

const DESC = "A task description long enough to satisfy the registration-time discipline floor.";
const read: Task = { id: "read_state", description: DESC, resolver: "http_fetch", config: { type: "http_fetch", url: "http://127.0.0.1:8080/v2/activities/templates?limit=200", method: "GET" }, outputShapes: ["activityVocabulary"] };
const classify: Task = { id: "classify", description: DESC, resolver: "llm_completion_dispatch", config: { type: "llm_completion_dispatch", prompt: "Summarise {{read_state_text}}", model: "auto", max_tokens: 500 }, outputShapes: ["widgetSummary"] };

function draft(id: string, tasks: Task[], outputShapes: string[]): Record<string, unknown> {
  return {
    id, name: "widget_from_pattern", description: "Fixture draft for the vessel-write routing pins.", tags: ["substrate.authored"],
    inputShapes: [], outputShapes, authored_from_pattern: { pattern_id: "fixture_cluster", observation_window: "2026-10-01/2026-10-02", contrast_examples: 1 },
    cited_concept_ids: [], tasks,
  };
}

async function attempt(tpl: Record<string, unknown>, extra: Record<string, unknown> = { validate_permissive_scope: true }) {
  posted = null;
  return resolveActivityCreateVariant({ type: "activity_create_variant", template: JSON.stringify(tpl), _registryLookupFn: async () => [], ...extra } as never);
}

async function register(tpl: Record<string, unknown>, extra?: Record<string, unknown>): Promise<Posted> {
  const r = await attempt(tpl, extra);
  expect({ shape: r.shape, body: r.shape === "structuredError" ? r.body : "ok" }).toEqual({ shape: "activityRegistryChange", body: "ok" });
  return posted!;
}

const draftPrompt = () => String((TPL.tasks.find((t) => t.id === "draft_via_llm")!.config as { prompt: string }).prompt);

describe("draft-activity-from-pattern: vessel writes are resolver tasks", () => {
  test("MUST-FAIL: the drafting prompt offers a *_write as a resolver task and makes it the last task", () => {
    const p = draftPrompt();
    expect(p).toContain(`"resolver": "<shape>_write"`);
    expect(p).toContain(`When the cluster's output shape, or the consumer it feeds, is a vessel-served *_write shape, the LAST task IS that resolver task`);
    expect(p).toContain("BOTH that task's outputShapes and the template's top-level outputShapes");
    // The http_fetch write steering is gone: no write-by-POST advice, no hardcoded write port.
    expect(p).not.toContain("Substrate write endpoints (use http_fetch POST");
    expect(p).not.toMatch(/Reserve http_fetch for genuinely external endpoints or writes/);
    expect(p).not.toMatch(/_write → http:\/\/127\.0\.0\.1:\d+\/v2\/impulses\/resolve/);
  });

  test("CONTROL: the read contracts the prompt carried are unchanged", () => {
    const p = draftPrompt();
    expect(p).toContain("GET http://127.0.0.1:8080/v2/activities/templates?limit=200");
    expect(p).toContain("GET http://127.0.0.1:8080/v2/activities/execution-traces?limit=50");
    expect(p).toContain(`- http_fetch GET:  { "type": "http_fetch", "url": "http://127.0.0.1:<port>/...", "method": "GET" }`);
  });

  test("MUST-FAIL: a drafted http_fetch POST of a *_write pointer registers as that resolver task, declared and attributed", async () => {
    const id = "proposed_pattern_authored_widget_write_fixture";
    const write: Task = {
      id: "persist_widget", description: DESC, resolver: "http_fetch",
      config: { type: "http_fetch", url: "http://127.0.0.1:8999/v2/impulses/resolve", method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pointer: { type: "widget_write", widget: { name: "w1", content: "{{classify_text}}" } } }) },
      outputShapes: ["httpResponse"],
    };
    const out = await register(draft(id, [read, classify, write], ["widgetSummary"]));
    const last = out.tasks[out.tasks.length - 1]!;
    expect(last.resolver).toBe("widget_write");
    expect(last.config).toEqual({ widget: { name: "w1", content: "{{classify_text}}" }, execution_id: "{{execution_id}}", template_id: id });
    expect(last.outputShapes).toContain("widget_write");
    expect(out.outputShapes).toContain("widget_write");
    expect(out.output_shapes).toContain("widget_write");
  });

  test("a draft already in resolver form gets its declarations and attribution, keeping its own fields", async () => {
    const id = "proposed_pattern_authored_widget_resolver_form";
    const write: Task = { id: "persist_widget", description: DESC, resolver: "widget_write", config: { widget: { name: "w2" }, execution_id: "exec-own" } };
    const out = await register(draft(id, [read, classify, write], ["widgetSummary"]));
    const last = out.tasks[out.tasks.length - 1]!;
    expect(last.config).toEqual({ widget: { name: "w2" }, execution_id: "exec-own", template_id: id });
    expect(last.outputShapes).toEqual(["widget_write"]);
    expect(out.output_shapes).toEqual(["widgetSummary", "widget_write"]);
  });

  test("CONTROL: a read-only draft registers unchanged", async () => {
    const tpl = draft("proposed_pattern_authored_read_only_fixture", [read, classify], ["widgetSummary"]);
    const out = await register(tpl);
    expect(out.tasks.map((t) => [t.resolver, t.config, t.outputShapes])).toEqual([read, classify].map((t) => [t.resolver, t.config, t.outputShapes]));
    expect(out.output_shapes).toEqual(["widgetSummary"]);
  });

  test("CONTROL: an external http_fetch POST stays http_fetch", async () => {
    const ext: Task = { id: "notify_external", description: DESC, resolver: "http_fetch",
      config: { type: "http_fetch", url: "https://hooks.example.test/notify", method: "POST", body: JSON.stringify({ text: "done" }) }, outputShapes: ["httpResponse"] };
    const out = await register(draft("proposed_pattern_authored_external_fixture", [read, classify, ext], ["widgetSummary"]));
    const last = out.tasks[out.tasks.length - 1]!;
    expect([last.resolver, last.config, last.outputShapes]).toEqual([ext.resolver, ext.config, ext.outputShapes]);
    expect(out.output_shapes).toEqual(["widgetSummary"]);
  });

  test("CONTROL: a gap-closing draft is not rewritten (its allow-list takes http_fetch, not a *_write resolver)", async () => {
    const write: Task = { id: "file_gap", description: DESC, resolver: "http_fetch",
      config: { type: "http_fetch", url: "http://127.0.0.1:8270/v2/impulses/resolve", method: "POST", body: JSON.stringify({ pointer: { type: "widget_write", widget: {} } }) }, outputShapes: ["httpResponse"] };
    const out = await register(draft("gap-closing:widget_fixture", [write], ["httpResponse"]), {});
    expect(out.tasks[0]!.resolver).toBe("http_fetch");
    expect(out.tasks[0]!.config).toEqual(write.config);
  });
});

describe("reuse-before-mint does not treat a store write as the template's capability", () => {
  const writer = (id: string): Record<string, unknown> =>
    draft(id, [read, classify, { id: "persist_widget", description: DESC, resolver: "widget_write", config: { widget: { name: "w" } } }], ["widgetSummary"]);
  afterAll(() => { producedElsewhere = new Set(); });

  test("MUST-FAIL: a second drafted writer of the same store is not refused as a duplicate of the first", async () => {
    producedElsewhere = new Set(["widget_write"]);
    const out = await register(writer("proposed_pattern_authored_second_widget_writer"));
    expect(out.output_shapes).toEqual(["widgetSummary", "widget_write"]);
  });

  test("CONTROL: an existing producer of the template's own capability shape still refuses the mint", async () => {
    producedElsewhere = new Set(["widgetSummary"]);
    const r = await attempt(writer("proposed_pattern_authored_duplicate_summary"));
    expect(r.shape).toBe("structuredError");
    expect((r.body as { failure_mode?: string }).failure_mode).toBe("reuse_existing_producer");
    expect(posted).toBeNull();
  });
});
