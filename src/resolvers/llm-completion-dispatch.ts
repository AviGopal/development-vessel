import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";

// Optional override: set LLM_COMPLETION_ENDPOINT to bypass discovery (e.g. for local dev with port-forward).
const LLM_COMPLETION_ENDPOINT_OVERRIDE = process.env["LLM_COMPLETION_ENDPOINT"] ?? "";
import type { ResolverResult } from "./types.js";

export interface LlmCompletionDispatchPointer {
  type: "llm_completion_dispatch";
  prompt: string;
  system_prompt?: string;
  model?: string;
  max_tokens?: number;
}

interface DiscoveryVessel {
  vesselId: string;
  endpoint: string;
  resolve_endpoint: string;
  confidence?: number;
  health_score?: number;
}

interface DiscoveryResolveResponse {
  content?: {
    vessels?: DiscoveryVessel[];
    found?: boolean;
  };
}

async function findLlmCompletionEndpoint(): Promise<string | null> {
  try {
    // llm-resolver-vessel advertises shape "llmCompletion" (camelCase per its
    // index.ts config). Previously this resolver queried snake_case
    // "llm_completion" and never found it — silent failure across every
    // llm_completion_dispatch task in every activity. The 53 traces with 0/0
    // tokens during goal[7]'s exec_x19p0558 confirm: zero LLM calls were
    // happening. Try canonical camelCase first; keep snake_case as fallback
    // for any future vessel that registers under the alternate spelling.
    let vessels: DiscoveryVessel[] = [];
    for (const shapeName of ["llmCompletion", "llm_completion"]) {
      const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${METABOB_API_KEY}`,
        },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape: shapeName } }),
      });
      if (!res.ok) continue;
      const data = await res.json() as DiscoveryResolveResponse;
      vessels = data.content?.vessels ?? [];
      if (vessels.length > 0) break;
    }
    if (vessels.length === 0) return null;
    // Skip stale localhost registrations; prefer cluster-internal endpoints.
    const reachable = vessels.filter((v) => !v.endpoint.includes("localhost"));
    const pool = reachable.length > 0 ? reachable : vessels;
    const best = pool.sort((a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0))[0]!;
    // resolve_endpoint may be either a full URL (e.g. "http://localhost:8220/resolve")
    // or a relative path (e.g. "/resolve"). Concatenating endpoint + full-URL gives
    // "http://127.0.0.1:8220http://localhost:8220/resolve" → invalid. Detect.
    const resolveEp = best.resolve_endpoint ?? "/resolve";
    if (resolveEp.startsWith("http://") || resolveEp.startsWith("https://")) {
      return resolveEp;
    }
    return `${best.endpoint.replace(/\/$/, "")}${resolveEp.startsWith("/") ? resolveEp : `/${resolveEp}`}`;
  } catch {
    return null;
  }
}

export async function resolveLlmCompletionDispatch(
  pointer: LlmCompletionDispatchPointer,
): Promise<ResolverResult> {
  const endpoint = LLM_COMPLETION_ENDPOINT_OVERRIDE || await findLlmCompletionEndpoint();
  if (!endpoint) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        detail: "No vessel advertising llm_completion found in discovery",
        failure_mode: "cascading",
      },
    };
  }

  const model = pointer.model ?? "anthropic/claude-haiku-4-5-20251001";
  // llm-resolver-vessel's handler expects the impulse-style envelope OR flat
  // body with type+prompt. Both forms work; using flat for clarity. The
  // resolver's body schema: { type: "llm_completion", prompt, model, max_tokens, system }
  const requestBody = {
    type: "llm_completion" as const,
    prompt: pointer.prompt,
    model,
    max_tokens: pointer.max_tokens ?? 4096,
    ...(pointer.system_prompt ? { system: pointer.system_prompt } : {}),
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shape: "structuredError",
      body: { resolver: "llm_completion_dispatch", detail: msg, failure_mode: "cascading" },
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        status: res.status,
        detail: text.slice(0, 200),
        failure_mode: "cascading",
      },
    };
  }

  // llm-resolver-vessel returns { resolved: true, shape: "llmCompletion", content, usage }
  const result = await res.json() as {
    resolved?: boolean;
    content?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: string;
    // Legacy / alternate field names from older vessels
    success?: boolean;
    data?: string;
  };

  if (result.error || result.resolved === false || result.success === false) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        detail: result.error ?? "LLM vessel returned error or resolved=false",
        failure_mode: "verifier_negative",
      },
    };
  }

  const text = result.content ?? result.data ?? "";
  return {
    shape: "llm_completion_result",
    body: { text, model, usage: result.usage },
  };
}
