import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  resolveTemplateRepair,
  normalizeActivityId,
  buildRepairSpec,
} from "../../src/resolvers/template-repair.js";

const originalFetch = globalThis.fetch;

const TEMPLATE = {
  id: "detect-stale-pointer",
  name: "detect-stale-pointer",
  description: "Detect stale impulse pointers",
  input_shapes: ["directoryListing"],
  output_shapes: ["stalePointerReport"],
  tasks: [
    { id: "scan", description: "scan for stale pointers", resolver: "fs_grep" },
  ],
};

const FAILURE_TRACES = {
  executions: [
    {
      id: "exec-1",
      activity_id: "detect-stale-pointer",
      status: "failure",
      failure_mode: { type: "verifier_negative", reason: "no output produced" },
      tasks: [{ task_id: "scan", success: false, resolver_tier: "deterministic" }],
    },
    {
      id: "exec-2",
      activity_id: "detect-stale-pointer",
      status: "failure",
      failure_mode: { type: "budget_exhausted", reason: "cost cap hit" },
      tasks: [{ task_id: "scan", success: false, resolver_tier: "llm" }],
    },
  ],
};

/** Scripted fetch: route by URL so no real network is used. */
function scriptFetch(opts: {
  templateStatus?: number;
  onCreateVariant?: (body: unknown) => void;
  createVariantResponse?: unknown;
}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v2/activities/templates/")) {
      // activity_fetch — GET single template
      if (opts.templateStatus && opts.templateStatus >= 400) {
        return new Response("not found", { status: opts.templateStatus });
      }
      return new Response(JSON.stringify(TEMPLATE), { status: 200 });
    }
    if (url.includes("/v2/activities/execution-traces")) {
      return new Response(JSON.stringify(FAILURE_TRACES), { status: 200 });
    }
    if (url.includes("/v2/activities/discover-by-shapes")) {
      // reuse-before-mint probe — variant-first repair is exempt, but answer safe
      return new Response(JSON.stringify({ activities: [] }), { status: 200 });
    }
    if (url.endsWith("/v2/activities/templates")) {
      // activity_create_variant POST
      opts.onCreateVariant?.(init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(
        JSON.stringify(opts.createVariantResponse ?? { id: "detect-stale-pointer-1751000000000" }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("template-repair resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes wrapped and bare activity ids", () => {
    expect(normalizeActivityId("activity:⟨detect-stale-pointer⟩")).toBe("detect-stale-pointer");
    expect(normalizeActivityId("detect-stale-pointer")).toBe("detect-stale-pointer");
  });

  it("grounds a spec containing the template JSON + a failure summary", () => {
    const spec = buildRepairSpec(TEMPLATE, [
      {
        execution_id: "exec-1",
        failed_task_id: "scan",
        failure_mode_type: "verifier_negative",
        resolver_tier: "deterministic",
        reason: "no output produced",
      },
    ]);
    expect(spec).toContain('"tasks"');
    expect(spec).toContain("detect-stale-pointer");
    expect(spec).toContain("verifier_negative");
    expect(spec).toContain("exec-1");
  });

  it("dry_run grounds without minting (no create_variant POST)", async () => {
    let createCalls = 0;
    globalThis.fetch = scriptFetch({ onCreateVariant: () => { createCalls += 1; } });

    const result = await resolveTemplateRepair({
      type: "template_repair",
      activity_id: "detect-stale-pointer",
      dry_run: true,
      failure_window: 5,
    });
    const body = result.body as Record<string, unknown>;
    expect(result.shape).toBe("templateRepairReport");
    expect(body["verdict"]).toBe("FAVORABLE");
    expect((body["based_on_failures"] as unknown[]).length).toBe(2);
    expect(String(body["grounded_spec"])).toContain('"tasks"');
    expect(createCalls).toBe(0);
  });

  it("non-dry_run mints a variant via create_variant and returns the id", async () => {
    let createBody: unknown;
    globalThis.fetch = scriptFetch({ onCreateVariant: (b) => { createBody = b; } });

    const result = await resolveTemplateRepair({
      type: "template_repair",
      // exercise the alias + wrapped-id path
      template_id: "activity:⟨detect-stale-pointer⟩",
    });
    const body = result.body as Record<string, unknown>;
    expect(result.shape).toBe("templateRepairReport");
    expect(body["verdict"]).toBe("FAVORABLE");
    expect(String(body["variant_id"])).toContain("detect-stale-pointer");
    // create_variant received a parent_template_id (variant-first) + the repair guidance
    expect(createBody).toBeDefined();
    expect((createBody as Record<string, unknown>)["parent_template_id"]).toBe("detect-stale-pointer");
    expect(String((createBody as Record<string, unknown>)["repair_guidance"])).toContain('"tasks"');
  });

  it("returns UNFAVORABLE when the template cannot be fetched", async () => {
    globalThis.fetch = scriptFetch({ templateStatus: 404 });
    const result = await resolveTemplateRepair({
      type: "template_repair",
      activity_id: "no-such-template",
    });
    const body = result.body as Record<string, unknown>;
    expect(body["verdict"]).toBe("UNFAVORABLE");
    expect(String(body["error"])).toContain("template not found");
  });
});
