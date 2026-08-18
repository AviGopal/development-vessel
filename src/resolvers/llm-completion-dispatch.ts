import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { federatedLlmEgressUrls } from "./federated-llm-egress.js";

// Optional override: set LLM_COMPLETION_ENDPOINT to bypass discovery (e.g. for local dev with port-forward).
const LLM_COMPLETION_ENDPOINT_OVERRIDE = process.env["LLM_COMPLETION_ENDPOINT"] ?? "";
// Federation-transport egress (dev-vessel has no libp2p deps; peer resolves route through
// the local transport sidecar). Mirrors feature-compose / goal-host FED_TRANSPORT_EGRESS —
// the by-name egress path proven to serve llm_completion from a funded hub arm.
const FED_TRANSPORT_EGRESS = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401";
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
  // Hub-egress fallback (law 11 data-locality + failover): when NO llm arm is discoverable
  // locally — the local resolver de-advertises llm_completion on quota/credit exhaustion, and
  // a spoke does not mirror the hub's arms into its own discovery — a funded arm still lives on
  // a peer substrate. Route to it BY NAME through the federation egress; the egress picks a LIVE
  // hub circuit and lands on the owning vessel over libp2p. Mirrors feature_compose's proven
  // fallback; the per-endpoint failover loop below posts the same unwrapped body this endpoint
  // accepts and the response-unwrap already handles the {content:{value}} envelope. Costs nothing
  // when a local arm exists (branch skipped); no hardcoded peer/endpoint.
  if (endpoints.length === 0) {
  // TARGET-PINNED, NOT BY-NAME. Measured 2026-08-18: ?vessel=<name> alone resolves to the LOCAL
  // substrate every time — even for a name that exists on both — so this "hub fallback" looped
  // straight back to the credit-dead local arm it exists to escape. And the hardcoded literal
  // "llm-resolver-vessel" names no vessel on the hub at all (it advertises llm-resolver-google /
  // -haiku / -opus), so it could not have matched even if by-name crossed substrates. Two
  // independent defects, each alone sufficient. Discovery now supplies both the circuit target
  // and the owning substrate's own name for the arm.
    const fed = await federatedLlmEgressUrls(DISCOVERY_ENDPOINT, METABOB_API_KEY, FED_TRANSPORT_EGRESS);
    endpoints.push(...fed);
    console.error(`[llm-completion-dispatch] no local llm arm discoverable — falling back to ${fed.length} target-pinned federated arm(s)`);
  }
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
    // A FEDERATED FAILURE NESTS ITS ERROR, AND THE TOP-LEVEL CHECK COULD NOT SEE IT.
    //
    // The guard below used to read only candidate.error / .resolved / .success. Every one of
    // those is TOP-LEVEL, and a failure that crossed the federation transport carries its error
    // one or two levels down. Both envelopes observed live on 2026-08-18:
    //
    //   {"content":{"error":"ingress proxy failed: ... NO_RESERVATION"}}
    //   {"content":{"body":{"resolved":false,"error":"no llm arm is currently servable ..."}}}
    //
    // Neither sets a top-level error/resolved/success, so the guard PASSED, the loop treated a
    // failed call as the winner and BROKE — never trying the remaining endpoints. The cascade
    // existed and could not fire, which is worse than having no cascade: the code reads as
    // fault-tolerant while stopping at the first broken arm.
    //
    // MEASURED COST. A third substrate (spoke-739b76f1, on neither this host nor the hub) had
    // joined the federation advertising llm_completion arms it could not serve. Its rows sorted
    // ahead of the hub's, so EVERY llm call stopped there: the ReAct floor logged
    // "dispatch FAILED http=500" on all 8 iterations and four ordinary human goals — chemical
    // symbol for gold, violin strings, marathon distance, The Starry Night — failed while three
    // working arms sat on the hub one endpoint later in the list.
    const federatedError = (c: unknown): string | null => {
      if (!c || typeof c !== "object") return null;
      const top = c as Record<string, unknown>;
      const inner = top["content"];
      if (!inner || typeof inner !== "object") return null;
      const i = inner as Record<string, unknown>;
      if (typeof i["error"] === "string") return i["error"];
      const body = i["body"];
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (typeof b["error"] === "string") return b["error"];
        if (b["resolved"] === false) return "federated arm returned resolved=false";
      }
      return null;
    };
    // ROUTING INTEGRITY: THE ANSWER MUST COME FROM THE VESSEL WE ASKED FOR.
    //
    // Measured 2026-08-18: a request target-pinned to the HUB's circuit, naming
    // `llm-resolver-google@syzygy-hub`, was answered by
    // `llm-resolver-google@federation-transport-vessel@spoke-739b76f1` — a substrate on neither
    // this host nor the hub, which had joined through the public relay and registered vessels
    // whose names COLLIDE with the hub's own. By-name lookup then resolved to it, and the
    // egress's live-circuit "repair" path substituted its circuit for the one we asked for.
    //
    // A wrong-but-plausible answer from an unrequested vessel is the dangerous case, not the
    // error we happened to get: the same substitution would have silently served content from
    // an unknown peer under the identity of a fleet vessel. Treat a substrate mismatch as a
    // failure and cascade, so provenance is enforced rather than assumed.
    const requestedSubstrate = (() => {
      const e = /[?&]expect_substrate=([^&]+)/.exec(endpoint);
      if (e?.[1]) return decodeURIComponent(e[1]);
      const m = /[?&]vessel=([^&]+)/.exec(endpoint);
      const v = m?.[1] ? decodeURIComponent(m[1]) : "";
      return v.includes("@") ? v.split("@").pop() ?? "" : "";
    })();
    const producedBy = (() => {
      const c = (candidate as unknown as Record<string, unknown> | null)?.["content"];
      const p = c && typeof c === "object" ? (c as Record<string, unknown>)["produced_by"] : undefined;
      return typeof p === "string" ? p : "";
    })();
    if (requestedSubstrate && producedBy && !producedBy.endsWith(`@${requestedSubstrate}`)) {
      lastFailure = {
        detail: `routing integrity: asked for @${requestedSubstrate}, answered by ${producedBy}`,
        failure_mode: "verifier_negative",
      };
      continue;
    }
    const nested = federatedError(candidate);
    if (!candidate || candidate.error || candidate.resolved === false || candidate.success === false || nested) {
      lastFailure = {
        detail: candidate?.error ?? nested ?? "LLM vessel returned error or resolved=false",
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
        ? (_c.value ?? _c.text ?? _c.body?.value ?? _c.body?.content)
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
