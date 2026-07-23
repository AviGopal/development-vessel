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
  tools?: unknown[];
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

async function findLlmCompletionEndpoints(): Promise<string[]> {
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
    if (vessels.length === 0) return [];
    // Skip stale localhost registrations; prefer cluster-internal endpoints.
    const reachable = vessels.filter((v) => !v.endpoint.includes("localhost"));
    const pool = reachable.length > 0 ? reachable : vessels;
    // Order best-first by health/confidence; the caller tries each in turn and
    // fails over to the next whenever an endpoint's arm is credit-dead or
    // otherwise unavailable. A single credit-dead local arm must not sink the
    // whole dispatch when a funded producer (e.g. an @<hub> arm egress-rewritten
    // through the federation transport) is also advertised.
    const ordered = [...pool].sort(
      (a, b) => (b.health_score ?? b.confidence ?? 0) - (a.health_score ?? a.confidence ?? 0),
    );
    const endpoints: string[] = [];
    for (const v of ordered) {
      // resolve_endpoint may be either a full URL (e.g. "http://localhost:8220/resolve")
      // or a relative path (e.g. "/resolve"). Concatenating endpoint + full-URL gives
      // "http://127.0.0.1:8220http://localhost:8220/resolve" → invalid. Detect.
      const resolveEp = v.resolve_endpoint ?? "/resolve";
      const url = resolveEp.startsWith("http://") || resolveEp.startsWith("https://")
        ? resolveEp
        : `${v.endpoint.replace(/\/$/, "")}${resolveEp.startsWith("/") ? resolveEp : `/${resolveEp}`}`;
      if (!endpoints.includes(url)) endpoints.push(url);
    }
    return endpoints;
  } catch {
    return [];
  }
}

interface LlmToolInputSchema {
  type: string;
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

interface LlmTool {
  name: string;
  description: string;
  input_schema: LlmToolInputSchema;
}

const DEFAULT_LLM_TOOLS: LlmTool[] = [
  {
    name: "source_code",
    description: "Read a repo file's full source code. Use this tool directly to fetch file contents by repo-relative path (e.g. repos/concept-db/src/models/schemas.ts) — do not ask the user for the content.",
    input_schema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Repo-relative path to the file, e.g. repos/concept-db/src/models/schemas.ts",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "fs_read",
    description: "Read a file's contents by absolute or relative path. Use this tool directly to fetch file contents — do not ask the user for the content.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "codeSearchResult",
    description: "Grep a single file for a regex pattern. Use this tool directly to search file contents — do not ask the user to perform the search.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to search",
        },
        pattern: {
          type: "string",
          description: "Regex pattern to search for in the file",
        },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "shellResult",
    description: "Run a shell command to inspect the repo or system. Use this tool directly to execute commands — do not ask the user to run them.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute",
        },
        cwd: {
          type: "string",
          description: "Optional working directory for the command",
        },
      },
      required: ["command"],
    },
  },
];

export async function resolveLlmCompletionDispatch(
  pointer: LlmCompletionDispatchPointer,
): Promise<ResolverResult> {
  const endpoints = LLM_COMPLETION_ENDPOINT_OVERRIDE
    ? [LLM_COMPLETION_ENDPOINT_OVERRIDE]
    : await findLlmCompletionEndpoints();
  if (endpoints.length === 0) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        detail: "No vessel advertising llm_completion found in discovery",
        failure_mode: "cascading",
      },
    };
  }

  const model = pointer.model ?? "auto";
  // llm-resolver-vessel's handler expects the impulse-style envelope OR flat
  // body with type+prompt. Both forms work; using flat for clarity. The
  // resolver's body schema: { type: "llm_completion", prompt, model, max_tokens, system }
  const requestBody = {
    type: "llm_completion" as const,
    prompt: pointer.prompt,
    model,
    max_tokens: pointer.max_tokens ?? 8192,
    // Tools cost real tokens (~500/request of schema) and force the
    // multi-request tool-loop path. Absent field keeps the investigation
    // defaults (walk satisfier fallbacks rely on them); an EXPLICIT empty
    // array is a caller opting out — plain completions skip the schemas and
    // take the cheaper single-shot path.
    ...(Array.isArray(pointer.tools)
      ? (pointer.tools.length > 0 ? { tools: pointer.tools } : {})
      : { tools: DEFAULT_LLM_TOOLS }),
    ...(pointer.system_prompt ? { system: pointer.system_prompt } : {}),
  };

  // llm-resolver-vessel returns { resolved: true, shape: "llmCompletion", content, usage }
  type LlmResolverResult = {
    resolved?: boolean;
    content?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    error?: string;
    // Resolved-model attribution: the llm-resolver reports which model
    // actually served the completion (exhaustion fallback may differ from
    // the requested model). Passing it through is what lets traces attribute
    // cost and the learning loop grade wire models instead of the requested
    // name (llm-model-selection observability seam).
    model?: string;
    fallback_from?: string;
    // Legacy / alternate field names from older vessels
    success?: boolean;
    data?: string;
  };

  // Try each advertised producer in turn; fail over to the next whenever an
  // endpoint throws, returns non-ok, or reports resolved:false / an error
  // (e.g. a credit-dead arm). Return the first successful completion; only
  // surface a structuredError if every endpoint is unavailable.
  let result: LlmResolverResult | null = null;
  let lastFailure: { status?: number; detail: string; failure_mode: string } = {
    detail: "No llm_completion endpoint produced a completion",
    failure_mode: "cascading",
  };
  for (const endpoint of endpoints) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      body: { resolver: "llm_completion_dispatch", ...lastFailure },
    };
  }

  const rawBody = result;

  // `content` arrives in three shapes: a plain string (local direct resolve),
  // an Anthropic-style block array (`content[0].text` — local Anthropic arm),
  // or — on a federation SPOKE — the proxied envelope object
  // `{shape:"llm_completion", value:<text>, ...}` returned when the hub's
  // llm-resolver-vessel answers over libp2p. The last case previously fell
  // through `content?.[0]` (undefined) and discarded a correctly-computed
  // answer, starving every LLM-tier walk step (the ReAct floor). Unwrap all three.
  const _c = rawBody.content as any;
  const rawText = typeof _c === "string"
    ? _c
    : Array.isArray(_c)
      ? (_c[0] as { text?: string } | undefined)?.text
      : (_c && typeof _c === "object")
        ? (_c.value ?? _c.text)
        : undefined;
  const toolCalls = typeof _c === "string"
    ? undefined
    : Array.isArray(_c)
      ? (_c[0] as { tool_calls?: any[] } | undefined)?.tool_calls
      : (_c && typeof _c === "object")
        ? _c.tool_calls
        : undefined;
  if (!rawText && !toolCalls) {
    throw new Error(`LLM completion did not return text or tool_calls: ${JSON.stringify(rawBody)}`);
  }
  if (toolCalls && toolCalls.length > 0) {
    return { shape: "llmToolCalls" as const, body: { tool_calls: toolCalls } };
  }

  if (typeof rawText !== "string") {
    throw new Error(`LLM completion did not return text: ${JSON.stringify(rawBody)}`);
  }
  // If no tool_calls, return the raw text completion directly. This covers
  // cases where the LLM responds with only text, or when force_tool_use was
  // not active resulting in no tool_calls. Note: in this latter case, a good
  // prompt will synthesize a tool call into the text field (e.g. "call
  // make_hike_reservation(trail='Bright Angel')").
  return {
    shape: "llmTextCompletion" as const,
    body: {
      text: rawText!,
      model: result.model ?? model,
      requested_model: model,
      ...(result.fallback_from ? { fallback_from: result.fallback_from } : {  }),
      usage: result.usage,
    },
  };

}
