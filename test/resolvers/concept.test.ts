import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolveConcept } from "../../src/resolvers/concept.js";

describe("resolveConcept", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns shape=concept with a body report", async () => {
    const traces = [
      {
        id: "trace:1",
        activity_id: "activity:a",
        status: "success",
        tasks: [
          { task_id: "t1", resolver_id: "fs-read", output_shape: "fs_read", status: "success" },
          { task_id: "t2", resolver_id: "llm-completion", output_shape: "llm_completion_dispatch", status: "success" },
        ],
      },
      {
        id: "trace:2",
        activity_id: "activity:b",
        status: "success",
        tasks: [
          { task_id: "t1", resolver_id: "fs-read", output_shape: "fs_read", status: "success" },
          { task_id: "t2", resolver_id: "llm-completion", output_shape: "llm_completion_dispatch", status: "success" },
        ],
      },
      {
        id: "trace:3",
        activity_id: "activity:c",
        status: "success",
        tasks: [
          { task_id: "t1", resolver_id: "fs-read", output_shape: "fs_read", status: "success" },
          { task_id: "t2", resolver_id: "llm-completion", output_shape: "llm_completion_dispatch", status: "success" },
        ],
      },
    ];

    let callCount = 0;
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      callCount++;
      if (url.includes("/v2/execution-traces")) {
        return new Response(JSON.stringify({ traces }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/concepts/search")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await resolveConcept({ type: "concept" });

    expect(result.shape).toBe("concept");
    expect(result.body).toBeDefined();
    const body = result.body as Record<string, unknown>;
    expect(body["trace_count_analyzed"]).toBe(3);
    expect(body["occurrence_count"]).toBe(3);
    expect(typeof body["concept_name"]).toBe("string");
    expect(typeof body["description"]).toBe("string");
    expect(Array.isArray(body["resolver_steps"])).toBe(true);
  });

  it("returns concept shape even when trace fetch fails", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("network error");
    };

    const result = await resolveConcept({ type: "concept" });

    expect(result.shape).toBe("concept");
    const body = result.body as Record<string, unknown>;
    expect(body["trace_count_analyzed"]).toBe(0);
    expect(body["occurrence_count"]).toBe(0);
  });

  it("handles array-format trace response", async () => {
    const traces = [
      {
        id: "trace:x",
        activity_id: "activity:x",
        status: "success",
        tasks: [
          { task_id: "t1", resolver_id: "git-log", output_shape: "git_log", status: "success" },
          { task_id: "t2", resolver_id: "concept-write", output_shape: "concept_write", status: "success" },
        ],
      },
    ];

    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("/v2/execution-traces")) {
        return new Response(JSON.stringify(traces), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const result = await resolveConcept({ type: "concept" });
    expect(result.shape).toBe("concept");
    const body = result.body as Record<string, unknown>;
    expect(body["trace_count_analyzed"]).toBe(1);
  });
});
