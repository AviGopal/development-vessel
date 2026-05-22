import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface LlmCompletionDispatchPointer {
  type: "llm_completion_dispatch";
  prompt: string;
  system_prompt?: string;
  model?: string;
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
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${METABOB_API_KEY}`,
      },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
    });
    if (!res.ok) return null;
    const data = await res.json() as DiscoveryResolveResponse;
    const vessels = data.content?.vessels ?? [];
    if (vessels.length === 0) return null;
    // Skip stale localhost registrations; prefer cluster-internal endpoints.
    const reachable = vessels.filter((v) => !v.endpoint.includes("localhost"));
    const pool = reachable.length > 0 ? reachable : vessels;
    const best = pool.sort((a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0))[0]!;
    return `${best.endpoint}${best.resolve_endpoint}`;
  } catch {
    return null;
  }
}

export async function resolveLlmCompletionDispatch(
  pointer: LlmCompletionDispatchPointer,
): Promise<ResolverResult> {
  const endpoint = await findLlmCompletionEndpoint();
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
  const requestBody = {
    model,
    messages: [{ role: "user", content: pointer.prompt }],
    ...(pointer.system_prompt ? { systemPrompt: pointer.system_prompt } : {}),
    stream: false,
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

  const result = await res.json() as { success: boolean; data?: string; error?: string };
  if (!result.success) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        detail: result.error ?? "LLM vessel returned success=false",
        failure_mode: "verifier_negative",
      },
    };
  }

  return {
    shape: "llm_completion_result",
    body: { text: result.data ?? "", model },
  };
}
