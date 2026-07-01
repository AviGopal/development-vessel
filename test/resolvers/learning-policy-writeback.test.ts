import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveLearningPolicyWriteback } from "../../src/resolvers/learning-policy-writeback.js";

/**
 * learning_policy_writeback per-resolver contract test (R8.1).
 *
 * We drive the whole seam through a scripted fetch: the learning_policy producer
 * reads templates (first GET), the writeback reads current tuning values
 * (GET /v2/tuning-params/:name), then POSTs writes. We assert:
 *   - values are CLAMPED to the operating envelope before writing,
 *   - a recommendation within min_delta of the current value is SKIPPED,
 *   - only TD_LAMBDA and YIELD_FLOOR ever actuate.
 */

const origFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

describe("learning_policy_writeback resolver", () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    process.env["TUNING_PARAM_ENDPOINT"] = "http://test-api:8080";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["TUNING_PARAM_ENDPOINT"];
  });

  function install(opts: {
    templates: unknown;
    current: Record<string, number | null>;
  }): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });

      // learning_policy producer fetches the template corpus
      if (url.includes("/v2/activities/templates")) {
        return new Response(JSON.stringify({ templates: opts.templates }), { status: 200 });
      }
      // writeback reads current tuning value
      if (method === "GET" && url.includes("/v2/tuning-params/")) {
        const name = decodeURIComponent(url.split("/v2/tuning-params/")[1]!);
        return new Response(JSON.stringify({ name, value: opts.current[name] ?? null }), { status: 200 });
      }
      // writeback POSTs a write
      if (method === "POST" && url.endsWith("/v2/tuning-params")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }

  it("clamps recommended hyperparameters and writes only the two learner-consumed ones", async () => {
    // Two templates with wildly separated posteriors => high kappa-spread =>
    // TD_LAMBDA recommendation pushed toward its upper bound (will clamp at 0.95).
    install({
      templates: [
        { id: "a", metrics: { thompson_alpha: 100, thompson_beta: 1, success_rate: 0.99 } },
        { id: "b", metrics: { thompson_alpha: 1, thompson_beta: 100, success_rate: 0.0 } },
      ],
      current: { TD_LAMBDA: null, YIELD_FLOOR: null },
    });

    const res = await resolveLearningPolicyWriteback({ type: "learning_policy_writeback" });
    const body = res.body as { results: Array<{ name: string; clamped: number; action: string }> };

    expect(res.shape).toBe("learningPolicyWriteback");
    const names = body.results.map((r) => r.name).sort();
    expect(names).toEqual(["TD_LAMBDA", "YIELD_FLOOR"]);

    for (const r of body.results) {
      if (r.name === "TD_LAMBDA") {
        expect(r.clamped).toBeGreaterThanOrEqual(0.3);
        expect(r.clamped).toBeLessThanOrEqual(0.95);
      }
      if (r.name === "YIELD_FLOOR") {
        expect(r.clamped).toBeGreaterThanOrEqual(0);
        expect(r.clamped).toBeLessThanOrEqual(1);
      }
    }

    // Both were unset => both written.
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/tuning-params"));
    expect(posts.length).toBe(2);
  });

  it("skips a write when the recommendation is within min_delta of the current value", async () => {
    install({
      templates: [{ id: "a", metrics: { thompson_alpha: 5, thompson_beta: 5, success_rate: 0.5 } }],
      current: { TD_LAMBDA: 0.6, YIELD_FLOOR: 0.1 },
    });

    // Huge min_delta => every recommendation is within threshold => no POST.
    const res = await resolveLearningPolicyWriteback({ type: "learning_policy_writeback", min_delta: 5 });
    const body = res.body as { results: Array<{ action: string }>; written: string[] };

    expect(body.written).toEqual([]);
    for (const r of body.results) {
      expect(r.action).toBe("skipped_within_threshold");
    }
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/tuning-params"));
    expect(posts.length).toBe(0);
  });
});
