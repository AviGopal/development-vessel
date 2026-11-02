import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/llm-completion-dispatch";

// This check exercises the exported resolver and inspects its outbound request
// behavior. It fails today because llm calls sent by this resolver lack an
// execution id header, so their spend cannot be joined to an execution.

describe("llm-completion-dispatch — execution id propagation", () => {
  const ORIGINALS: { fetch?: typeof fetch; LLM_COMPLETION_ENDPOINT?: string; FED_TRANSPORT_EGRESS?: string } = {};

  beforeEach(() => {
    ORIGINALS.fetch = globalThis.fetch;
    ORIGINALS.LLM_COMPLETION_ENDPOINT = process.env["LLM_COMPLETION_ENDPOINT"];
    ORIGINALS.FED_TRANSPORT_EGRESS = process.env["FED_TRANSPORT_EGRESS"];
  });

  afterEach(() => {
    globalThis.fetch = ORIGINALS.fetch!;
    if (ORIGINALS.LLM_COMPLETION_ENDPOINT === undefined) delete process.env["LLM_COMPLETION_ENDPOINT"]; else process.env["LLM_COMPLETION_ENDPOINT"] = ORIGINALS.LLM_COMPLETION_ENDPOINT;
    if (ORIGINALS.FED_TRANSPORT_EGRESS === undefined) delete process.env["FED_TRANSPORT_EGRESS"]; else process.env["FED_TRANSPORT_EGRESS"] = ORIGINALS.FED_TRANSPORT_EGRESS;
  });

  test("propagates an execution id to egress so spend can be joined to its execution", async () => {
    // Force the resolver to bypass discovery and call our mocked endpoint.
    const overrideUrl = "http://dev.local/resolve";
    process.env["LLM_COMPLETION_ENDPOINT"] = overrideUrl;

    type Captured = { url: string; headers: Record<string, string>; body: string };
    const seen: Captured[] = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const headersObj: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers as HeadersInit);
        h.forEach((v, k) => {
          headersObj[k.toLowerCase()] = v;
        });
      }
      const bodyStr = typeof init?.body === "string" ? (init!.body as string) : "";
      seen.push({ url, headers: headersObj, body: bodyStr });
      // We only need the outbound request to be attempted; no network.
      return Promise.reject(new Error("halt-llm-call"));
    }) as typeof fetch;

    const uniquePrompt = "prompt-for-exec-id-check-" + Math.random().toString(36).slice(2);

    try {
      // Call through the exported function with only declared parameters.
      await mod.resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: uniquePrompt });
    } catch {
      // The mock rejects to avoid any real network; continue to assertions on captured behavior.
    }

    // Identify the outbound LLM call(s) by the presence of our unique prompt in the request body.
    const llmCalls = seen.filter((r) => r.body.includes(uniquePrompt));
    expect(llmCalls.length).toBeGreaterThan(0); // the resolver attempted an outbound LLM call

    // EXPECTED AFTER FIX: an execution id header is present on the LLM call so spend can be joined.
    const headerNames = Object.keys(llmCalls[0]!.headers);
    const hasExecutionIdHeader = headerNames.some((k) => k.includes("execution") && k.includes("id"));

    // This assertion is RED today due to the defect (header missing), and GREEN after the fix.
    expect(hasExecutionIdHeader).toBe(true);
  });

  test("CONTROL — honors the override endpoint (bypasses discovery)", async () => {
    const overrideUrl = "http://dev.local/resolve";
    process.env["LLM_COMPLETION_ENDPOINT"] = overrideUrl;

    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return Promise.reject(new Error("halt-override-check"));
    }) as typeof fetch;

    try {
      await mod.resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "control-prompt" });
    } catch {
      // ignore; we're checking that the RESOLVER attempted to call the override URL.
    }

    expect(urls.some((u) => u.startsWith(overrideUrl))).toBe(true);
    // Also sanity-check the other export is present; unaffected by the fix.
    expect(typeof mod.LLM_COMPLETION_DISPATCH_DECLARED_TIERS).not.toBe("undefined");
  });
});
