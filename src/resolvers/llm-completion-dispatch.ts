import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { federatedLlmEgressUrls, transportHopHeaders } from "./federated-llm-egress.js";

// Optional override: set LLM_COMPLETION_ENDPOINT to bypass discovery (e.g. for local dev with port-forward).
// Read at CALL time, not at import: an import-time read froze the override for the whole process, so whichever module
// imported this first decided it for every later caller (measured: the landing gate's one-process run ignored a test's
// own endpoint; the class gap an-import-time-env-read-makes-replication-tests-depend-on-file-order).
const llmCompletionEndpointOverride = (): string => process.env["LLM_COMPLETION_ENDPOINT"] ?? "";
// Federation-transport egress (dev-vessel has no libp2p deps; peer resolves route through
// the local transport sidecar). Mirrors feature-compose / goal-host FED_TRANSPORT_EGRESS —
// the by-name egress path proven to serve llm_completion from a funded hub arm.
const FED_TRANSPORT_EGRESS = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401";
import type { ResolverResult } from "./types.js";
import { outboundSignal } from "../lib/request-signal.js";

export interface LlmCompletionDispatchPointer {
  type: "llm_completion_dispatch";
  prompt: string;
  system_prompt?: string;
  model?: string;
  max_tokens?: number;
  tools?: unknown[];
  /** a deadline for each model request (ms); absent → bounded only by the caller's own request signal. */
  timeout_ms?: number;
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
        signal: AbortSignal.timeout(5_000),
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

/** The completion's text and caller-run tool_calls, from any of the three `content` envelopes (see the tail). */
function extractCompletion(rawBody: { content?: unknown }): { rawText: any; toolCalls: any[] | undefined } {
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
  return { rawText, toolCalls };
}

/** No text (null, "" or whitespace) and no caller-run tool_calls: an answer that carries nothing. */
function isEmptyCompletion(candidate: { content?: unknown }): boolean {
  const { rawText, toolCalls } = extractCompletion(candidate);
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
  return rawText == null || (typeof rawText === "string" && rawText.trim() === "");
}

/** This resolver's tier, declared where it is defined: it runs a model call, so it is an `llm` resolver. Registration
 *  (discovery-registration.ts declaredResolverTiers) sends it as `resolvers[]`, discovery echoes it on the capability
 *  row, and a dispatcher stamps the trace task with it (the learning loop's M4 tier-restricted skip reads that stamp). */
export const LLM_COMPLETION_DISPATCH_DECLARED_TIERS = { llm_completion_dispatch: "llm" } as const;

export async function resolveLlmCompletionDispatch(
  pointer: LlmCompletionDispatchPointer,
): Promise<ResolverResult> {
  if (typeof pointer.prompt !== "string" || !pointer.prompt.trim()) {
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        failure_mode: "malformed_request",
        field: "prompt",
        detail: "The 'prompt' field is required and must be a non-empty string.",
      },
    };
  }

  // Each model request is aborted when the caller gives up (the resolve's request signal) or at the
  // pointer's own deadline, so an abandoned dispatch stops sending paid requests.
  const callSignal = () => outboundSignal(pointer.timeout_ms);
  const override = llmCompletionEndpointOverride();
  const endpoints = override
    ? [override]
    : await findLlmCompletionEndpoints();
  // Hub-egress fallback (law 11 data-locality + failover): when NO llm arm is discoverable
  // locally — the local resolver de-advertises llm_completion on quota/credit exhaustion, and
  // a spoke does not mirror the hub's arms into its own discovery — a funded arm still lives on
  // a peer substrate. Route to it BY NAME through the federation egress; the egress picks a LIVE
  // hub circuit and lands on the owning vessel over libp2p. Mirrors feature_compose's proven
  // fallback; the per-endpoint failover loop below posts the same unwrapped body this endpoint
  // accepts and the response-unwrap already handles the {content:{value}} envelope. Costs nothing
  // when a local arm exists (branch skipped); no hardcoded peer/endpoint.
  // FEDERATED ARMS ARE A LAZY FALLBACK — RESOLVED ONLY AFTER LOCAL ONES FAIL.
  //
  // They used to be appended only `if (endpoints.length === 0)`. The local resolver
  // re-advertises llm_completion the moment a model cooldown lapses — deliberately, so a
  // returning key recovers without traffic it can never receive while de-advertised — and then
  // refuses the next call. In that window `endpoints` is non-empty, so the federated arms were
  // never added and the cascade had nothing to fall through to: every call ended on "no llm arm
  // is currently servable" while working arms sat on the hub, unlisted.
  //
  // Appending them UP FRONT fixed that and broke two things the tests rightly pin: it spent a
  // discovery round-trip on every call including the ones local answers, and it turned the
  // terminal failure_mode of a purely-local failure from verifier_negative into cascading.
  // Resolving them lazily — after the local loop has exhausted itself — keeps the local-only
  // path byte-identical and pays for discovery only when there is nothing else left to try.
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
    ...(typeof (pointer as { execution_id?: unknown }).execution_id === "string" ? { execution_id: (pointer as { execution_id?: string }).execution_id } : {}),
    // CALLER DEFAULT (value-per-cost-selection 1.5d). Activity-template tasks reach this
    // resolver through ias-executor's vessel-resolver with no caller, so on 2026-09-27 most of
    // the ledger's `caller: unknown` spend was untraceable. A caller that names itself wins;
    // otherwise name this dispatcher plus a slug of the (static, per-template) system prompt,
    // which tells templates apart without touching the executor.
    caller: typeof (pointer as { caller?: unknown }).caller === "string" && (pointer as { caller?: string }).caller
      ? (pointer as { caller?: string }).caller
      : "development-vessel:llm_completion_dispatch" + (typeof pointer.system_prompt === "string" && pointer.system_prompt.trim()
        ? ":" + pointer.system_prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "")
        : ""),
    ...(typeof (pointer as { task_type?: unknown }).task_type === "string" ? { task_type: (pointer as { task_type?: string }).task_type } : {}),
    ...(typeof (pointer as { dispatch_id?: unknown }).dispatch_id === "string" ? { dispatch_id: (pointer as { dispatch_id?: string }).dispatch_id } : {}),
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
    // Why the provider stopped (max_tokens, stop, tool loop exhausted). Read only to explain an
    // empty completion; absent on today's resolver, which does not report it.
    stop_reason?: string;
    iterations?: number;
    // Tools the llm-resolver EXECUTED server-side in its own tool loop
    // ({iteration, tool_name, tool_input, tool_output | {error}, duration_ms}).
    // Distinct from content-level tool_calls, which are calls the CALLER must run.
    tool_calls?: unknown[];
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
  let primaryRefusal: { detail: string } | null = null;
  type FailureEntry = { endpoint: string; status?: number; detail: string; failure_mode: string; model?: string; requested_model?: string; attempt?: number; kind?: string; duration_ms?: number };
  const failures: FailureEntry[] = [];
  // Hoisted to function scope: both the local loop and the lazy federated loop
  // below need it, and a failure envelope looks the same wherever it comes from.
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
  // A DISPATCH-BUDGET REFUSAL IS TERMINAL. llm-resolver refuses once THIS dispatch has sent its
  // llmModelPolicy.max_input_tokens_per_dispatch allowance. Every other endpoint, and every
  // federated peer, keeps its own ledger and would serve the same dispatch past the allowance, so
  // cascading would turn the refusal into a bypass. Stop and pass the refusal through (top-level on
  // a local answer, under content.body when it crossed the federation transport).
  // A PROMPT-CEILING REFUSAL IS TERMINAL TOO. llm-resolver refuses a prompt over llmModelPolicy.max_input_tokens before
  // any provider call, and a prompt too large for one arm is too large for every arm (it stops its own fallback walk on
  // it). Measured: cascading past it re-sent a ~280k-token prompt to the remaining local endpoints and two federated
  // arms, about 138 s per call before the same refusal came back. Passed through at once, like the budget refusal.
  const budgetRefusalOf = (c: unknown): ResolverResult | null => {
    if (!c || typeof c !== "object") return null;
    const top = c as Record<string, unknown>;
    const inner = top["content"] && typeof top["content"] === "object" ? (top["content"] as Record<string, unknown>)["body"] : undefined;
    const ceiling = top["prompt_ceiling"] === true ? top
      : inner && typeof inner === "object" && (inner as Record<string, unknown>)["prompt_ceiling"] === true ? inner as Record<string, unknown>
      : null;
    if (ceiling) {
      return {
        shape: "structuredError",
        body: {
          resolver: "llm_completion_dispatch",
          detail: typeof ceiling["error"] === "string" ? ceiling["error"] : "prompt too large for the input-token ceiling",
          failure_mode: "prompt_ceiling",
        },
      };
    }
    const r = top["dispatch_budget_exhausted"] === true ? top
      : inner && typeof inner === "object" && (inner as Record<string, unknown>)["dispatch_budget_exhausted"] === true ? inner as Record<string, unknown>
      : null;
    if (!r) return null;
    return {
      shape: "structuredError",
      body: {
        resolver: "llm_completion_dispatch",
        detail: typeof r["error"] === "string" ? r["error"] : "dispatch input-token budget spent",
        failure_mode: "dispatch_budget_exhausted",
        dispatch_budget: r["dispatch_budget"] ?? null,
      },
    };
  };

  // AN EMPTY ANSWER IS NOT A WINNER. llm-resolver answers `resolved:true, content:""` when a
  // model spends its budget on hidden reasoning, runs its tool loop out, or returns an empty
  // turn. The guard above checks only error/resolved/success, so that body won, the loop broke,
  // and the tail threw "did not return text or tool_calls" — an HTTP 500 for the caller, while
  // every other endpoint and federated arm went untried. It was about half of one node's
  // failures. An answer with no text (null, "" or whitespace) and no tool_calls is a
  // verifier_negative for that arm, and the cascade moves on. The coming resolver form,
  // `resolved:false, error:"empty_completion"`, is the same class and is tagged the same way.
  type EmptyArm = { endpoint: string; model?: string; requested_model?: string; stop_reason?: string; iterations?: number };
  const emptyArms: EmptyArm[] = [];
  // The model that ANSWERED empty is `served_model` when the resolver names it: on its refusals
  // `model` is the drawn arm and `requested_model` what the caller asked for, neither of which is
  // the one to blame. Older bodies carry only `model`.
  const emptyEvidence = (c: unknown, endpoint: string): EmptyArm => {
    const top = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const content = top["content"] && typeof top["content"] === "object" ? top["content"] as Record<string, unknown> : {};
    const inner = content["body"] && typeof content["body"] === "object" ? content["body"] as Record<string, unknown> : {};
    const pick = (k: string): unknown => top[k] ?? content[k] ?? inner[k];
    const served = pick("served_model");
    const m = typeof served === "string" && served ? served : pick("model");
    const rq = pick("requested_model"), sr = pick("stop_reason") ?? pick("finish_reason"), it = pick("iterations");
    return {
      endpoint,
      ...(typeof m === "string" ? { model: m } : {}),
      ...(typeof rq === "string" && rq ? { requested_model: rq } : {}),
      ...(typeof sr === "string" ? { stop_reason: sr } : {}),
      ...(typeof it === "number" ? { iterations: it } : {}),
    };
  };
  const isEmptyCompletionError = (e: unknown): boolean => typeof e === "string" && e.startsWith("empty_completion");
  const recordEmpty = (c: unknown, endpoint: string): void => {
    const ev = emptyEvidence(c, endpoint);
    emptyArms.push(ev);
    const d = `empty_completion${ev.model ? ` model=${ev.model}` : ""}${ev.requested_model ? ` requested=${ev.requested_model}` : ""}${ev.stop_reason ? ` stop_reason=${ev.stop_reason}` : ""}: the arm answered with no text and no tool_calls`;
    failures.push({
      endpoint, detail: d, failure_mode: "verifier_negative",
      ...(ev.model ? { model: ev.model } : {}),
      ...(ev.requested_model ? { requested_model: ev.requested_model } : {}),
    });
    // An empty answer never displaces a specific refusal another arm gave: that refusal is the
    // cause a caller can act on.
    if (!primaryRefusal) {
      primaryRefusal = { detail: d };
      lastFailure = { detail: d, failure_mode: "verifier_negative" };
    }
  };
  // Fields that explain an empty completion go FIRST, in the body and in `detail`: the route copies
  // `detail` into `error`, and upstream dispatchers keep only the first ~200 characters.
  const emptyCompletionError = (): ResolverResult => {
    const models = [...new Set(emptyArms.map((a) => a.model).filter((m): m is string => !!m))];
    const stopReasons = [...new Set(emptyArms.map((a) => a.stop_reason).filter((r): r is string => !!r))];
    const iterations = emptyArms.map((a) => a.iterations).find((n) => typeof n === "number");
    // What the arms say was requested, when they say; otherwise what this dispatch asked for.
    const armRequested = [...new Set(emptyArms.map((a) => a.requested_model).filter((r): r is string => !!r))];
    const requested = armRequested.length > 0 ? armRequested.join(",") : model;
    return {
      shape: "structuredError",
      body: {
        failure_mode: "empty_completion",
        models,
        requested_model: model,
        ...(stopReasons.length > 0 ? { stop_reason: stopReasons.join(",") } : {}),
        ...(typeof iterations === "number" ? { iterations } : {}),
        resolver: "llm_completion_dispatch",
        detail: `empty_completion models=${models.join(",") || "unknown"} requested=${requested}${stopReasons.length > 0 ? ` stop_reason=${stopReasons.join(",")}` : ""}: every arm that answered returned no text and no tool_calls`,
        failures,
      },
    };
  };

  // ONE LINE PER ENDPOINT ATTEMPT (routing locality, step 1: measure before reordering). Measured once by inference
  // only: a prompt-ceiling cascade spent ~138 s in the remaining local endpoints before the federated arms answered in
  // under 1 s, and nothing said which endpoint took the time. Every attempt, local or federated, logs its index, phase,
  // kind (local_http: a loopback resolver; libp2p: the local federation transport; direct_host: any other host;
  // federated: the lazy egress fallback), the endpoint, its wall time and its outcome. The same duration, index and
  // kind are stamped on the attempt's entry in `failures`, the per-endpoint record a failed dispatch already returns.
  // Measurement only: the order, the timeouts and the result are unchanged.
  let attemptSeq = 0;
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const endpointKind = (u: string, phase: "local" | "federated"): string => {
    if (phase === "federated") return "federated";
    try {
      const url = new URL(u);
      if (url.origin === new URL(FED_TRANSPORT_EGRESS).origin) return "libp2p";
      return loopbackHosts.has(url.hostname) ? "local_http" : "direct_host";
    } catch { return "unparsed"; }
  };
  const noteAttempt = (endpoint: string, phase: "local" | "federated", started: number, failuresBefore: number, won: boolean, terminal?: string): void => {
    const attempt = attemptSeq++;
    const duration_ms = Math.round(performance.now() - started);
    const kind = endpointKind(endpoint, phase);
    const f = failures.length > failuresBefore ? failures[failures.length - 1] : undefined;
    const outcome = won ? "ok"
      : terminal ? terminal
      : !f ? "unclassified"
      : f.detail.startsWith("empty_completion") ? "empty_completion"
      : f.detail.startsWith("routing integrity") ? "routing_integrity"
      : typeof f.status === "number" ? `http_${f.status}`
      : f.failure_mode === "cascading" ? "transport_error"
      : "refused";
    for (let i = failuresBefore; i < failures.length; i++) Object.assign(failures[i]!, { attempt, kind, duration_ms });
    console.log(`[llm-completion-dispatch] endpoint attempt=${attempt} phase=${phase} kind=${kind} duration_ms=${duration_ms} outcome=${outcome} endpoint=${endpoint}`);
  };

  for (const endpoint of endpoints) {
    const attemptStart = performance.now();
    const failuresBefore = failures.length;
    let terminal: string | undefined;
    try {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          // An endpoint may be the local federation transport (a hub arm mirrored into local
          // discovery): it then carries this vessel's key as a header, never in requestBody.
          headers: transportHopHeaders(endpoint, FED_TRANSPORT_EGRESS, METABOB_API_KEY),
          body: JSON.stringify(requestBody),
          signal: callSignal(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ endpoint, detail: msg, failure_mode: "cascading" });
        if (!primaryRefusal) lastFailure = { detail: msg, failure_mode: "cascading" };
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        failures.push({ endpoint, status: res.status, detail: text.slice(0, 200), failure_mode: "cascading" });
        if (!primaryRefusal) lastFailure = { status: res.status, detail: text.slice(0, 200), failure_mode: "cascading" };
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
        failures.push({ endpoint, detail: `routing integrity: asked for @${requestedSubstrate}, answered by ${producedBy}`, failure_mode: "verifier_negative" });
        if (!primaryRefusal) primaryRefusal = { detail: `routing integrity: asked for @${requestedSubstrate}, answered by ${producedBy}` };
        lastFailure = {
          detail: `routing integrity: asked for @${requestedSubstrate}, answered by ${producedBy}`,
          failure_mode: "verifier_negative",
        };
        continue;
      }
      const refusedLocal = budgetRefusalOf(candidate);
      if (refusedLocal) { terminal = String((refusedLocal.body as { failure_mode?: unknown }).failure_mode); return refusedLocal; }
      const nested = federatedError(candidate);
      if (candidate && (isEmptyCompletionError(candidate.error) || (!candidate.error && isEmptyCompletionError(nested)))) {
        recordEmpty(candidate, endpoint);
        continue;
      }
      if (!candidate || candidate.error || candidate.resolved === false || candidate.success === false || nested) {
        {
          const d = candidate?.error ?? nested ?? "LLM vessel returned error or resolved=false";
          failures.push({ endpoint, detail: d, failure_mode: "verifier_negative" });
          if (!primaryRefusal) primaryRefusal = { detail: d };
          lastFailure = { detail: d, failure_mode: "verifier_negative" };
        }
        continue;
      }
      if (isEmptyCompletion(candidate)) {
        recordEmpty(candidate, endpoint);
        continue;
      }

      result = candidate;
      break;
    } finally {
      noteAttempt(endpoint, "local", attemptStart, failuresBefore, result !== null, terminal);
    }
  }

  // LAZY FEDERATED FALLBACK: every local arm has failed. Only now is a discovery round-trip
  // worth paying for, and only now can trying a peer change the outcome.
  if (!result) {
    const fed = (await federatedLlmEgressUrls(DISCOVERY_ENDPOINT, METABOB_API_KEY, FED_TRANSPORT_EGRESS))
      .filter((u) => !endpoints.includes(u));
    if (fed.length > 0) {
      console.error(`[llm-completion-dispatch] local arms exhausted — trying ${fed.length} target-pinned federated arm(s); reason: ${String(lastFailure.detail ?? "")}`);
      for (const endpoint of fed) {
        const attemptStart = performance.now();
        const failuresBefore = failures.length;
        let terminal: string | undefined;
        try {
          let res: Response;
          try {
            res = await fetch(endpoint, {
              method: "POST",
              headers: transportHopHeaders(endpoint, FED_TRANSPORT_EGRESS, METABOB_API_KEY),
              body: JSON.stringify(requestBody),
              signal: callSignal(),
            });
          } catch (err) {
            failures.push({ endpoint, detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" });
            if (!primaryRefusal) lastFailure = { detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" };
            continue;
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            failures.push({ endpoint, status: res.status, detail: text.slice(0, 200), failure_mode: "cascading" });
            if (!primaryRefusal) lastFailure = { status: res.status, detail: text.slice(0, 200), failure_mode: "cascading" };
            continue;
          }
          const candidate = await res.json().catch(() => null) as LlmResolverResult | null;
          const refusedFed = budgetRefusalOf(candidate);
          if (refusedFed) { terminal = String((refusedFed.body as { failure_mode?: unknown }).failure_mode); return refusedFed; }
          const nested = federatedError(candidate);
          if (candidate && (isEmptyCompletionError(candidate.error) || (!candidate.error && isEmptyCompletionError(nested)))) {
            recordEmpty(candidate, endpoint);
            continue;
          }
          if (!candidate || candidate.error || candidate.resolved === false || candidate.success === false || nested) {
            {
              const d = candidate?.error ?? nested ?? "federated arm returned error";
              failures.push({ endpoint, detail: d, failure_mode: "verifier_negative" });
              if (!primaryRefusal) primaryRefusal = { detail: d };
              lastFailure = { detail: d, failure_mode: "verifier_negative" };
            }
            continue;
          }
          if (isEmptyCompletion(candidate)) {
            recordEmpty(candidate, endpoint);
            continue;
          }
          result = candidate;
          break;
        } finally {
          noteAttempt(endpoint, "federated", attemptStart, failuresBefore, result !== null, terminal);
        }
      }
    }
  }

  // Every arm that ANSWERED answered empty (arms that could not be reached do not change that).
  if (!result && emptyArms.length > 0 && failures.every((f) => f.failure_mode !== "verifier_negative" || f.detail.startsWith("empty_completion"))) {
    return emptyCompletionError();
  }
  if (!result) {
    return {
      shape: "structuredError",
      body: { resolver: "llm_completion_dispatch", ...lastFailure, failures },
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
  const { rawText, toolCalls } = extractCompletion(rawBody);
  if (!rawText && !toolCalls) {
    // The loops reject an empty answer with the same extractor, so only a falsy non-string
    // `content` reaches here; it is returned as an error, never thrown (a throw becomes an
    // HTTP 500 that hides the cause).
    recordEmpty(rawBody, "(winner)");
    return emptyCompletionError();
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
      // Pass the resolver's server-side tool executions through: without them a
      // caller (the goal-host ReAct floor) sees a grounded, tool-using answer as
      // a zero-tool completion. Omitted when the resolver sends no tool_calls array.
      ...(Array.isArray(result.tool_calls) ? { executed_tool_calls: result.tool_calls } : {}),
    },
  };

}
