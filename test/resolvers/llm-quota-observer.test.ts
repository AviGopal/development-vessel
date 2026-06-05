import { describe, it, expect } from "bun:test";
import { resolveLlmQuotaObserver } from "../../src/resolvers/llm-quota-observer.js";

describe("llm_quota_observer", () => {
  it("returns missing_api_key when none supplied and none in env", async () => {
    const result = await resolveLlmQuotaObserver({
      type: "llm_quota_observer",
      apiEndpoint: "http://127.0.0.1:1",
      apiKey: "",
      timeoutMs: 500,
    });
    expect(result.shape).toBe("llmQuotaState");
    const body = result.body as {
      reachable: boolean;
      error: string;
      recent_429_count: number;
      recent_llm_total: number;
    };
    expect(body.reachable).toBe(false);
    expect(body.error).toBe("missing_api_key");
    expect(body.recent_429_count).toBe(0);
    expect(body.recent_llm_total).toBe(0);
  });

  it("degrades to reachable=false on unreachable endpoint", async () => {
    const result = await resolveLlmQuotaObserver({
      type: "llm_quota_observer",
      apiEndpoint: "http://127.0.0.1:1",
      apiKey: "fake-key",
      timeoutMs: 500,
    });
    const body = result.body as { reachable: boolean; error: string | null };
    expect(body.reachable).toBe(false);
    expect(body.error).not.toBeNull();
  });

  it("emits a well-formed impulse on timeout to non-routable host", async () => {
    const result = await resolveLlmQuotaObserver({
      type: "llm_quota_observer",
      apiEndpoint: "http://192.0.2.1",
      apiKey: "fake-key",
      timeoutMs: 250,
    });
    const body = result.body as {
      reachable: boolean;
      generated_at: string;
      window_ms: number;
      estimated_quota_remaining_pct: number | null;
    };
    expect(body.reachable).toBe(false);
    expect(typeof body.generated_at).toBe("string");
    expect(body.window_ms).toBe(60 * 60 * 1000);
    expect(body.estimated_quota_remaining_pct).toBeNull();
  });
});
