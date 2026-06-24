import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

// author_producer reuses two resolvers that both go through globalThis.fetch:
//   1. llm_completion_dispatch — discovery lookup + LLM vessel POST
//   2. activity_create_variant — POST /v2/activities/templates (+ optional
//      reuse-before-mint discover probe; disabled here via REUSE_BEFORE_MINT=off)
// We script a fetch queue keyed by URL so the order is robust.

const originalFetch = globalThis.fetch;

interface ScriptedResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

let discoveryResp: ScriptedResponse;
let llmResp: ScriptedResponse;
let mintResp: ScriptedResponse;
// Validation-invocation responses, consumed in order (one per attempt).
let validationResps: ScriptedResponse[];
let validationCallCount = 0;
const postedTemplates: Record<string, unknown>[] = [];

function makeResponse(r: ScriptedResponse): Response {
  return {
    ok: r.ok,
    status: r.status,
    json: async () => r.data,
    text: async () => (typeof r.data === "string" ? r.data : JSON.stringify(r.data)),
  } as Response;
}

function installFetch(): void {
  // @ts-expect-error — replace global fetch for tests
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.includes("/resolve") && u.includes("8100")) {
      // discovery-vessel /resolve serves TWO callers, distinguished by body:
      //   - LLM discovery sends { pointer: { type: "vesselCapability", shape } }
      //   - author_producer's validation discovery sends { shape }
      if (body["pointer"]) return makeResponse(discoveryResp);
      // validation discovery: point at the validation invocation endpoint.
      return makeResponse({
        ok: true,
        status: 200,
        data: {
          content: {
            found: true,
            vessels: [{ endpoint: "http://validation-vessel:8250", resolve_endpoint: "/resolve", health_score: 1.0 }],
          },
        },
      });
    }
    if (u.includes("llm-vessel")) {
      // LLM vessel completion call
      return makeResponse(llmResp);
    }
    if (u.includes("validation-vessel")) {
      // resolver-X validation invocation; one scripted response per attempt.
      const resp = validationResps[validationCallCount] ?? validationResps[validationResps.length - 1]!;
      validationCallCount++;
      return makeResponse(resp);
    }
    if (u.includes("/v2/activities/templates")) {
      // mint POST
      if (init?.body) postedTemplates.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return makeResponse(mintResp);
    }
    if (u.includes("/v2/activities/discover-by-shapes")) {
      // reuse-before-mint probe (disabled via env, but answer empty just in case)
      return makeResponse({ ok: true, status: 200, data: { activities: [] } });
    }
    return makeResponse({ ok: false, status: 503, data: {} });
  };
}

const goodDiscovery: ScriptedResponse = {
  ok: true,
  status: 200,
  data: {
    content: {
      found: true,
      vessels: [{ vesselId: "llm-1", endpoint: "http://llm-vessel:8220", resolve_endpoint: "/resolve", health_score: 1.0 }],
    },
  },
};

const cannedAuthoringJson = JSON.stringify({
  input_shapes: ["source_code"],
  task_config: { type: "problem_detection", filePaths: "{{source_code.path}}" },
  binds_from: { filePaths: "source_code" },
});

describe("author_producer resolver", () => {
  let resolveAuthorProducer: typeof import("../../src/resolvers/author-producer.js").resolveAuthorProducer;

  beforeAll(async () => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
    process.env["REUSE_BEFORE_MINT"] = "off";
    ({ resolveAuthorProducer } = await import("../../src/resolvers/author-producer.js"));
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    postedTemplates.length = 0;
    validationCallCount = 0;
    discoveryResp = goodDiscovery;
    llmResp = { ok: true, status: 200, data: { resolved: true, content: cannedAuthoringJson, usage: {} } };
    mintResp = { ok: true, status: 200, data: { id: "activity:auto-bridge-problem_detection" } };
    // Default: validation succeeds on the first attempt (resolver produces X).
    validationResps = [{ ok: true, status: 200, data: { shape: "problem_detection", body: { problems: [] } } }];
    installFetch();
  });

  it("returns structuredError when pointer.shape is missing", async () => {
    const result = await resolveAuthorProducer({ type: "author_producer" } as never);
    expect(result.shape).toBe("structuredError");
    const body = result.body as { error: string };
    expect(body.error).toContain("author_producer requires pointer.shape");
  });

  it("builds and mints a bridge activity from the LLM authoring spec", async () => {
    const result = await resolveAuthorProducer({
      type: "author_producer",
      shape: "problem_detection",
      goal: "detect code problems in a file",
      available_shapes: ["source_code"],
      // No vessels/source on disk in tests → empty source, LLM still authors.
    });

    expect(result.shape).toBe("author_producer");
    const body = result.body as {
      minted_activity_id: string;
      output_shape: string;
      input_shapes: string[];
      task_config: Record<string, unknown>;
      validated: boolean;
      attempts: number;
    };
    expect(body.minted_activity_id).toBe("activity:auto-bridge-problem_detection");
    expect(body.output_shape).toBe("problem_detection");
    expect(body.input_shapes).toEqual(["source_code"]);
    expect(body.validated).toBe(true);
    expect(body.attempts).toBe(1);
    // task_config carries the LLM's pointer fields AND the enforced resolver type.
    expect(body.task_config["type"]).toBe("problem_detection");
    expect(body.task_config["filePaths"]).toBe("{{source_code.path}}");

    // The minted template must invoke shape X as its task resolver, declare the
    // LLM's input shapes, and produce only X.
    expect(postedTemplates.length).toBe(1);
    const tpl = postedTemplates[0]!;
    const tasks = tpl["tasks"] as Array<Record<string, unknown>>;
    expect(tasks[0]!["resolver"]).toBe("problem_detection");
    expect(tpl["output_shapes"]).toEqual(["problem_detection"]);
    expect(tpl["input_shapes"]).toEqual(["source_code"]);
  });

  it("forces task_config.type to the target shape even if the LLM emits a wrong one", async () => {
    llmResp = {
      ok: true,
      status: 200,
      data: {
        resolved: true,
        content: JSON.stringify({ input_shapes: [], task_config: { type: "WRONG" }, binds_from: {} }),
        usage: {},
      },
    };
    // Validation must produce shape "concept" for this minting to proceed.
    validationResps = [{ ok: true, status: 200, data: { shape: "concept", body: {} } }];
    const result = await resolveAuthorProducer({ type: "author_producer", shape: "concept" });
    expect(result.shape).toBe("author_producer");
    const body = result.body as { task_config: Record<string, unknown> };
    expect(body.task_config["type"]).toBe("concept");
  });

  it("retries with refined config and mints only the validated config", async () => {
    // Attempt 1 validation fails (resolver reports a missing field); attempt 2
    // succeeds. The resolver must refine via the error and mint only the
    // validated config, reporting attempts:2.
    validationResps = [
      { ok: true, status: 200, data: { error: "filePaths is required" } },
      { ok: true, status: 200, data: { shape: "problem_detection", body: { problems: [] } } },
    ];
    const result = await resolveAuthorProducer({
      type: "author_producer",
      shape: "problem_detection",
      goal: "detect code problems in a file",
      available_shapes: ["source_code"],
    });
    expect(result.shape).toBe("author_producer");
    const body = result.body as { validated: boolean; attempts: number };
    expect(body.validated).toBe(true);
    expect(body.attempts).toBe(2);
    // Two validation invocations happened (one failed, one succeeded).
    expect(validationCallCount).toBe(2);
    // Exactly one mint — the validated config.
    expect(postedTemplates.length).toBe(1);
  });

  it("returns structuredError (no mint) when all attempts fail validation", async () => {
    // Every validation attempt reports an error → exhaustion, no mint.
    validationResps = [{ ok: true, status: 200, data: { error: "filePaths is required" } }];
    const result = await resolveAuthorProducer({
      type: "author_producer",
      shape: "problem_detection",
      max_attempts: 2,
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { error: string; attempts: number; last_error: string };
    expect(body.error).toContain("could not author a genuinely-producing invocation");
    expect(body.attempts).toBe(2);
    expect(body.last_error).toContain("filePaths is required");
    // Never minted a non-working config.
    expect(postedTemplates.length).toBe(0);
  });

  it("returns structuredError when the LLM call fails on every attempt (discovery finds no vessel)", async () => {
    discoveryResp = { ok: true, status: 200, data: { content: { vessels: [], found: false } } };
    const result = await resolveAuthorProducer({ type: "author_producer", shape: "problem_detection", max_attempts: 2 });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { error: string; last_error: string };
    expect(body.error).toContain("could not author a genuinely-producing invocation");
    expect(body.last_error).toContain("LLM authoring failed");
    expect(postedTemplates.length).toBe(0);
  });

  it("returns structuredError when the LLM returns unparseable JSON on every attempt", async () => {
    llmResp = { ok: true, status: 200, data: { resolved: true, content: "sorry, I cannot do that", usage: {} } };
    const result = await resolveAuthorProducer({ type: "author_producer", shape: "problem_detection", max_attempts: 2 });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { last_error: string };
    expect(body.last_error).toContain("parseable JSON");
  });

  it("returns structuredError when minting is rejected by activity-api", async () => {
    mintResp = { ok: false, status: 400, data: "bad request" };
    const result = await resolveAuthorProducer({ type: "author_producer", shape: "problem_detection" });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { error: string };
    expect(body.error).toContain("mint failed");
  });
});
