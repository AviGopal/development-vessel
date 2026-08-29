import type { ResolverResult } from "./types.js";

/**
 * llm_quota_observer (round 2, 2026-06-05) — promotes LLM-provider quota state
 * into impulse form by observing recent llm_completion traces in activity-api.
 * Rate-limit responses are silent killers: traces fail but the failure mode
 * looks like a generic LLM error. This observer aggregates recent 429 / rate-
 * limit signatures so the substrate can throttle expensive goals before they
 * waste budget.
 *
 * Best-effort: degrades to "unknown" on activity-api unreachable or auth
 * failure rather than throwing.
 */

const DEFAULT_API_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8090";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface LlmQuotaObserverPointer {
  type: "llm_quota_observer";
  apiEndpoint?: string;
  apiKey?: string;
  limit?: number;
  windowMs?: number;
  timeoutMs?: number;
}

interface TraceTask {
  resolver_id?: string;
  resolver?: string;
  success?: boolean;
  error?: string;
  stderr?: string;
  output_impulse_ids?: string[];
}

interface ExecutionTrace {
  id?: string;
  status?: string;
  executed_at?: string;
  tasks?: TraceTask[];
  failure_mode?: { type?: string; reason?: string; context?: Record<string, unknown> } | null;
}

const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /too[\s_-]?many[\s_-]?requests/i,
  /quota.*exceed/i,
  /\boverloaded[_-]?error\b/i,
];

function looksLikeRateLimit(s: string | undefined): boolean {
  if (!s) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(s));
}

function isLlmTask(t: TraceTask): boolean {
  const r = t.resolver_id ?? t.resolver ?? "";
  return r === "llm_completion" || r === "llm" || r === "llm-prompt" || r.includes("llm");
}

export async function resolveLlmQuotaObserver(
  pointer: LlmQuotaObserverPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.apiEndpoint ?? DEFAULT_API_ENDPOINT).replace(/\/+$/, "");
  const apiKey = pointer.apiKey ?? API_KEY;
  const limit = pointer.limit ?? 200;
  const windowMs = pointer.windowMs ?? 60 * 60 * 1000;
  const timeoutMs = pointer.timeoutMs ?? 8_000;

  if (!apiKey) {
    return {
      shape: "llmQuotaState",
      body: {
        api_endpoint: endpoint,
        reachable: false,
        error: "missing_api_key",
        recent_429_count: 0,
        recent_llm_success_count: 0,
        recent_llm_total: 0,
        estimated_quota_remaining_pct: null,
        last_429_at: null,
        sample_signatures: [],
        window_ms: windowMs,
        generated_at: new Date().toISOString(),
      },
    };
  }

  const url = `${endpoint}/v2/activities/execution-traces?limit=${limit}`;
  let resp: Response;
  const start = Date.now();
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `ApiKey ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      shape: "llmQuotaState",
      body: {
        api_endpoint: endpoint,
        reachable: false,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        roundtrip_ms: Date.now() - start,
        recent_429_count: 0,
        recent_llm_success_count: 0,
        recent_llm_total: 0,
        estimated_quota_remaining_pct: null,
        last_429_at: null,
        sample_signatures: [],
        window_ms: windowMs,
        generated_at: new Date().toISOString(),
      },
    };
  }
  const roundtrip = Date.now() - start;
  if (!resp.ok) {
    return {
      shape: "llmQuotaState",
      body: {
        api_endpoint: endpoint,
        reachable: false,
        error: `http_${resp.status}`,
        roundtrip_ms: roundtrip,
        recent_429_count: 0,
        recent_llm_success_count: 0,
        recent_llm_total: 0,
        estimated_quota_remaining_pct: null,
        last_429_at: null,
        sample_signatures: [],
        window_ms: windowMs,
        generated_at: new Date().toISOString(),
      },
    };
  }

  // The type declared only `traces`, which is why the wrong read key never surfaced as an
  // error: the contract was mis-encoded at the type level, so the compiler agreed with it.
  let parsed: { executions?: ExecutionTrace[]; traces?: ExecutionTrace[] } | ExecutionTrace[];
  try {
    parsed = (await resp.json()) as typeof parsed;
  } catch (err) {
    return {
      shape: "llmQuotaState",
      body: {
        api_endpoint: endpoint,
        reachable: true,
        error: `parse_error: ${err instanceof Error ? err.message.slice(0, 100) : ""}`,
        roundtrip_ms: roundtrip,
        recent_429_count: 0,
        recent_llm_success_count: 0,
        recent_llm_total: 0,
        estimated_quota_remaining_pct: null,
        last_429_at: null,
        sample_signatures: [],
        window_ms: windowMs,
        generated_at: new Date().toISOString(),
      },
    };
  }
  // `executions` is the key /v2/activities/execution-traces actually returns
  // (ListExecutionTracesResponse: {executions,total,limit,offset}). Reading only `traces` gave
  // undefined -> [], so this observer saw an EMPTY trace stream against the real API and
  // reported no rate limiting and no LLM activity — the reassuring answer, always. Same defect
  // and same fix as vessel-health-report, resolver-tier-cost-summary and failure-count-report.
  const traces: ExecutionTrace[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.executions)
    ? (parsed.executions as ExecutionTrace[])
    : Array.isArray(parsed.traces)
    ? parsed.traces
    : [];

  const cutoff = Date.now() - windowMs;
  let rateLimitCount = 0;
  let llmSuccess = 0;
  let llmTotal = 0;
  let lastRateLimit: string | null = null;
  const samples: string[] = [];

  for (const trace of traces) {
    const tsRaw = trace.executed_at ? Date.parse(trace.executed_at) : NaN;
    if (Number.isFinite(tsRaw) && tsRaw < cutoff) continue;
    const tasks = trace.tasks ?? [];
    for (const t of tasks) {
      if (!isLlmTask(t)) continue;
      llmTotal += 1;
      if (t.success) {
        llmSuccess += 1;
        continue;
      }
      const errStr = `${t.error ?? ""} ${t.stderr ?? ""}`;
      if (looksLikeRateLimit(errStr)) {
        rateLimitCount += 1;
        if (trace.executed_at) {
          if (!lastRateLimit || trace.executed_at > lastRateLimit) {
            lastRateLimit = trace.executed_at;
          }
        }
        if (samples.length < 5) samples.push(errStr.trim().slice(0, 150));
      }
    }
    const fmReason = `${trace.failure_mode?.reason ?? ""}`;
    if (looksLikeRateLimit(fmReason)) {
      if (samples.length < 5) samples.push(fmReason.slice(0, 150));
    }
  }

  const estimatedRemaining =
    llmTotal === 0 ? null : Math.max(0, Math.round((1 - rateLimitCount / llmTotal) * 100));

  return {
    shape: "llmQuotaState",
    body: {
      api_endpoint: endpoint,
      reachable: true,
      roundtrip_ms: roundtrip,
      window_ms: windowMs,
      traces_scanned: traces.length,
      recent_llm_total: llmTotal,
      recent_llm_success_count: llmSuccess,
      recent_429_count: rateLimitCount,
      estimated_quota_remaining_pct: estimatedRemaining,
      last_429_at: lastRateLimit,
      sample_signatures: samples,
      generated_at: new Date().toISOString(),
    },
  };
}
