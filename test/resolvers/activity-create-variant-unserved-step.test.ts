// EVERY STEP RESOLVER OF A REGISTERED TEMPLATE MUST BE SERVED (src/resolvers/activity-create-variant.ts), for every id
// prefix. Measured: a template-mitosis variant of development-vessel:own-check-baseline added a task whose resolver an
// LLM invented (own_check_baseline_validate); activity_create_variant registered it, and every later run failed
// "Resolver 'own_check_baseline_validate' is not registered".
//   - MUST-FAIL: that exact variant (the parent's classify task plus the invented validate task) is refused by name;
//   - CONTROL: a variant reusing only served resolvers still mints;
//   - a registry that cannot be read refuses (named), never registers unverified;
//   - the cold-start bulk seed (bootstrapSeed, an in-process option) is not judged: it runs before the fleet registers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

const originalFetch = globalThis.fetch;
const prior = { METABOB_ENDPOINT: process.env["METABOB_ENDPOINT"], METABOB_API_KEY: process.env["METABOB_API_KEY"] };
const { resolveActivityCreateVariant, unservedStepResolver, EXECUTOR_LOCAL_RESOLVERS } = await import("../../src/resolvers/activity-create-variant.js");

let posts: Array<Record<string, unknown>> = [];
beforeAll(() => { process.env["METABOB_ENDPOINT"] = "https://activity.test"; process.env["METABOB_API_KEY"] = "test-key"; });
beforeEach(() => {
  posts = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    // Only the template registration is recorded (the reuse-before-mint probe also POSTs, to discover-by-shapes).
    if ((init?.method ?? "GET") === "POST") { const b = JSON.parse(String(init!.body)); if (Array.isArray(b?.tasks)) posts.push(b); return new Response(JSON.stringify({ id: "activity:minted" }), { status: 200 }); }
    return new Response(JSON.stringify({ error: "Template not found" }), { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const SERVED = new Set(["own_check_baseline_classify", "test_suite", "json_path_extract"]);
const served = async (r: string) => (SERVED.has(r) ? "served" as const : "absent" as const);
const classify = { id: "classify", description: "Execute the gap's own check at the specified base_ref and classify the results based on established criteria.", resolver: "own_check_baseline_classify", config: { type: "own_check_baseline_classify", gap_id: "{{gap_id}}", base_ref: "{{base_ref}}" }, outputShapes: ["ownCheckBaseline"] };
const validate = { id: "validate", description: "Validate the results of the own check classifications by cross-referencing with previous outcomes.", resolver: "own_check_baseline_validate", config: { type: "own_check_baseline_validate" }, outputShapes: [] };
const variant = (tasks: unknown[]) => ({
  id: "development-vessel:own-check-baseline:1697520000", name: "own-check-baseline",
  description: "Systematically evaluates the gap's own check quality by running tests on a stable base reference.",
  input_shapes: [], output_shapes: ["ownCheckBaseline"], tags: ["lift.autonomous.loop"], tasks,
});

describe("activity_create_variant refuses a step resolver nothing serves", () => {
  it("MUST-FAIL the own-check-baseline variant with the invented own_check_baseline_validate step is refused, by name, and nothing is posted", async () => {
    const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: variant([classify, validate]), parentTemplateId: "development-vessel:own-check-baseline", strip_id: true }, { stepResolverServed: served });
    expect(r.shape).toBe("structuredError");
    const b = r.body as Record<string, unknown>;
    expect(b["failure_mode"]).toBe("unregistered_step_resolver");
    expect(b["step_resolver"]).toBe("own_check_baseline_validate");
    expect(b["task_id"]).toBe("validate");
    expect(posts).toEqual([]);
  });

  it("CONTROL a variant reusing only served resolvers still mints", async () => {
    const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: variant([classify]), parentTemplateId: "development-vessel:own-check-baseline", strip_id: true }, { stepResolverServed: served });
    expect(r.shape).toBe("activityRegistryChange");
    expect(posts).toHaveLength(1);
  });

  it("MUST-FAIL a registry that cannot be read refuses the mint, named, rather than registering it unverified", async () => {
    const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: variant([classify]) }, { stepResolverServed: async () => "unreadable" });
    expect(r.shape).toBe("structuredError");
    expect((r.body as Record<string, unknown>)["failure_mode"]).toBe("resolver_registry_unreadable");
    expect(posts).toEqual([]);
  });

  it("CONTROL the cold-start bulk seed is not judged (bootstrap tier), and a task with no resolver is not judged", async () => {
    const r = await resolveActivityCreateVariant({ type: "activity_create_variant", template: variant([classify, validate]) }, { bootstrapSeed: true, stepResolverServed: served });
    expect(r.shape).toBe("activityRegistryChange");
    expect(await unservedStepResolver({ tasks: [{ id: "x" }] }, served)).toBeNull();
  });

  it("the executor's in-process resolvers count as served without a registry read", async () => {
    for (const r of ["compose", "compose_parallel", "llm-prompt", "impulse-resolve", "activity"]) expect(EXECUTOR_LOCAL_RESOLVERS.has(r)).toBe(true);
  });
});
