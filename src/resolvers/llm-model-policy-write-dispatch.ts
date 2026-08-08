import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const FED_TRANSPORT_EGRESS = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401";

interface DiscoveryVessel {
  vesselId: string;
  endpoint: string;
  resolve_endpoint: string;
  confidence?: number;
  health_score?: number;
  libp2p_multiaddr?: string[];
}

interface DiscoveryResolveResponse {
  content?: {
    vessels?: DiscoveryVessel[];
    found?: boolean;
  };
}

async function findLlmModelPolicyEndpoints(): Promise<Array<{ url: string; target?: string }>> {
  try {
    // llm-resolver-vessel advertises shape "llmModelPolicy_write" for the write operation
    let vessels: DiscoveryVessel[] = [];
    for (const shapeName of ["llmModelPolicy_write", "llm_model_policy_write"]) {
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
    // Also try the read shape as fallback - same vessel serves both
    if (vessels.length === 0) {
      for (const shapeName of ["llmModelPolicy", "llm_model_policy"]) {
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
    }
    if (vessels.length === 0) return [];

    const reachable = vessels.filter((v) => !v.endpoint.includes("localhost"));
    const pool = reachable.length > 0 ? reachable : vessels;
    const ordered = [...pool].sort(
      (a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0),
    );
    const endpoints: Array<{ url: string; target?: string }> = [];
    for (const v of ordered) {
      const resolveEp = v.resolve_endpoint ?? "/resolve";
      const url = resolveEp.startsWith("http://") || resolveEp.startsWith("https://")
        ? resolveEp
        : `${v.endpoint.replace(/\/$/, "")}${resolveEp.startsWith("/") ? resolveEp : "/" + resolveEp}`;
      const ma = Array.isArray(v.libp2p_multiaddr) ? v.libp2p_multiaddr[0] : undefined;
      if (ma) {
        const base = (v.vesselId ?? "").split("@")[0] ?? "";
        const root = v.endpoint.replace(/\/$/, "");
        endpoints.push({ url: `${root}/egress/resolve?vessel=${encodeURIComponent(base)}`, target: ma });
      } else {
        if (!endpoints.some(e => e.url === url)) endpoints.push({ url });
      }
    }
    return endpoints;
  } catch {
    return [];
  }
}

export interface LlmModelPolicyWritePointer {
  type: "llmModelPolicy_write";
  arms?: Array<{
    model: string;
    cost_per_mtok: number;
    alpha: number;
    beta: number;
    note?: string;
    task_alpha?: Record<string, number>;
    task_beta?: Record<string, number>;
    last_updated_at?: string;
  }>;
  cost_weight?: number;
  merge?: boolean;
}

export async function resolveLlmModelPolicyWriteDispatch(
  pointer: LlmModelPolicyWritePointer,
): Promise<ResolverResult> {
  const endpoints = await findLlmModelPolicyEndpoints();
  
  // Hub-egress fallback: when NO llm arm is discoverable locally
  if (endpoints.length === 0) {
    endpoints.push({ url: `${FED_TRANSPORT_EGRESS}/egress/resolve?vessel=llm-resolver-vessel` });
    console.error("[llm-model-policy-write-dispatch] no local llmModelPolicy_write arm discoverable — falling back to hub egress");
  }
  if (endpoints.length === 0) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_model_policy_write_dispatch",
        detail: "No vessel advertising llmModelPolicy_write found in discovery",
        failure_mode: "cascading",
      },
    };
  }

  // Build request body for llm-resolver-vessel's llmModelPolicyWriteHandler
  const requestBody = {
    type: "llmModelPolicy_write",
    ...(pointer.arms ? { arms: pointer.arms } : {}),
    ...(typeof pointer.cost_weight === "number" ? { cost_weight: pointer.cost_weight } : {}),
    ...(typeof pointer.merge === "boolean" ? { merge: pointer.merge } : {}),
  };

  type LlmResolverResult = {
    resolved?: boolean;
    shape?: string;
    body?: unknown;
    error?: string;
    success?: boolean;
  };

  let result: LlmResolverResult | null = null;
  let lastFailure: { status?: number; detail: string; failure_mode: string } = {
    detail: "No llmModelPolicy_write endpoint produced a result",
    failure_mode: "cascading",
  };

  for (const endpoint of endpoints) {
    let res: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (endpoint.target) headers["X-Libp2p-Target"] = endpoint.target;
      res = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastFailure = { detail: msg, failure_mode: "cascading" };
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastFailure = { status: res.status, detail: text.slice(0, 200), failure_mode: "cascading" };
      continue;
    }

    const candidate = await res.json().catch(() => null) as LlmResolverResult | null;
    if (!candidate || candidate.error || candidate.resolved === false || candidate.success === false) {
      lastFailure = {
        detail: candidate?.error ?? "LLM vessel returned error or resolved=false",
        failure_mode: "verifier_negative",
      };
      continue;
    }

    result = candidate;
    break;
  }

  if (!result) {
    return {
      shape: "structuredError",
      body: { resolver: "llm_model_policy_write_dispatch", ...lastFailure },
    };
  }

  // The llm-resolver-vessel returns { resolved: true, shape: "llmModelPolicyWriteResult", body: { rev, arm_count } }
  // Pass through the shape and body as-is
  return {
    shape: result.shape ?? "llmModelPolicyWriteResult",
    body: result.body ?? { success: true },
  };
}
