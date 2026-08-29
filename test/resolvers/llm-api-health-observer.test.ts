// These three cases assert the SINGLE-ENDPOINT liveness contract — `endpoint`,
// `reachable`, `http_status`. The resolver's default path is no longer that: it now
// probes the whole arm fleet for completion and returns `probe_kind: "completion"`
// with arms_probed / fleet_can_complete / arms[], so the fields these tests read came
// back undefined and they were asserting against a contract that had moved.
//
// The single-endpoint path still exists and is deliberately maintained — it is gated on
// `pointer.probePath` and labelled "LEGACY PATH, kept explicit" in the resolver — and it
// returns exactly the fields these cases were written for. Passing probePath routes them
// back to the contract they actually test instead of inventing new assertions for them.
//
// NOTE: this leaves the newer fleet-completion path (the resolver's headline behaviour,
// added after a 43-hour outage that liveness alone reported as healthy) with no coverage
// in this file. Filed as substrate work rather than silently absorbed here.
import { describe, it, expect } from "bun:test";
import { resolveLlmApiHealthObserver } from "../../src/resolvers/llm-api-health-observer.js";

describe("llm_api_health_observer", () => {
  it("returns reachable=false with a structured error when endpoint is unreachable", async () => {
    // Port 1 is reserved; nothing listens. Probe will fail/timeout fast.
    const result = await resolveLlmApiHealthObserver({
      type: "llm_api_health_observer",
      probePath: "/health",
      endpoint: "http://127.0.0.1:1",
      timeoutMs: 500,
    });
    expect(result.shape).toBe("llmApiHealth");
    const body = result.body as {
      endpoint: string;
      reachable: boolean;
      http_status: number | null;
      roundtrip_ms: number | null;
      error: string | null;
    };
    expect(body.endpoint).toBe("http://127.0.0.1:1");
    expect(body.reachable).toBe(false);
    expect(typeof body.roundtrip_ms).toBe("number");
    expect(body.error).not.toBeNull();
  });

  it("emits a well-formed impulse even when the timeout fires", async () => {
    // Use a non-routable test-net address (RFC 5737) so the request hangs and
    // AbortSignal.timeout fires deterministically.
    const result = await resolveLlmApiHealthObserver({
      type: "llm_api_health_observer",
      probePath: "/health",
      endpoint: "http://192.0.2.1",
      timeoutMs: 250,
    });
    const body = result.body as {
      reachable: boolean;
      error: string | null;
      generated_at: string;
    };
    expect(body.reachable).toBe(false);
    expect(typeof body.generated_at).toBe("string");
    expect(body.error).not.toBeNull();
  });

  it("uses the default LLM_VESSEL_ENDPOINT when no endpoint is supplied", async () => {
    const result = await resolveLlmApiHealthObserver({
      type: "llm_api_health_observer",
      probePath: "/health",
      timeoutMs: 500,
    });
    const body = result.body as { endpoint: string };
    expect(body.endpoint).toMatch(/^https?:\/\//);
  });
});
