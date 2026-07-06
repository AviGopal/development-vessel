import type { ResolverResult } from "./types.js";

interface TierEntry {
  tier: string;
  total_cost: number;
  count: number;
}

interface CostSummaryBody {
  tiers: TierEntry[];
  window_hours: number;
  generated_at: string;
}

export async function resolveResolverTierCostSummary(
  _pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const metabobEndpoint = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const windowHours = 24;
  const windowMs = windowHours * 60 * 60 * 1000;
  const nowMs = new Date().getTime();
  const sinceMs = nowMs - windowMs;
  const since = new Date(sinceMs).toISOString();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  // Fetch recent execution traces from the substrate
  const tracesUrl = `${metabobEndpoint}/v2/traces?since=${encodeURIComponent(since)}&limit=1000`;
  let tracesResp: Response;
  try {
    tracesResp = await fetch(tracesUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shape: "resolver_tier_cost_summary",
      body: {
        tiers: [],
        window_hours: windowHours,
        generated_at: new Date().toISOString(),
        error: `Failed to fetch traces: ${msg}`,
      },
    };
  }

  let tracesData: any;
  if (tracesResp.ok) {
    try {
      tracesData = await tracesResp.json();
    } catch {
      tracesData = null;
    }
  }

  // Aggregate cost by resolver_tier from traces
  const tierMap: Record<string, { total_cost: number; count: number }> = {};

  const traces: any[] = Array.isArray(tracesData)
    ? tracesData
    : Array.isArray(tracesData?.traces)
    ? (tracesData.traces as any[])
    : [];

  for (const trace of traces) {
    const tier: string =
      (typeof trace?.resolver_tier === "string" && trace.resolver_tier.length > 0
        ? trace.resolver_tier
        : typeof trace?.tier === "string" && trace.tier.length > 0
        ? trace.tier
        : null) ?? "unknown";

    const cost: number =
      typeof trace?.cost === "number"
        ? trace.cost
        : typeof trace?.total_cost === "number"
        ? trace.total_cost
        : typeof trace?.llm_cost_usd === "number"
        ? trace.llm_cost_usd
        : 0;

    const existing = tierMap[tier];
    if (existing !== undefined) {
      existing.total_cost += cost;
      existing.count += 1;
    } else {
      tierMap[tier] = { total_cost: cost, count: 1 };
    }
  }

  // If traces gave us nothing, try the impulses/resolutions endpoint
  if (traces.length === 0) {
    const resolutionsUrl = `${metabobEndpoint}/v2/resolutions?since=${encodeURIComponent(since)}&limit=1000`;
    try {
      const resResp = await fetch(resolutionsUrl, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (resResp.ok) {
        let resData: any;
        try {
          resData = await resResp.json();
        } catch {
          resData = null;
        }
        const resolutions: any[] = Array.isArray(resData)
          ? resData
          : Array.isArray(resData?.resolutions)
          ? (resData.resolutions as any[])
          : Array.isArray(resData?.items)
          ? (resData.items as any[])
          : [];

        for (const res of resolutions) {
          const tier: string =
            (typeof res?.resolver_tier === "string" && res.resolver_tier.length > 0
              ? res.resolver_tier
              : typeof res?.tier === "string" && res.tier.length > 0
              ? res.tier
              : null) ?? "unknown";

          const cost: number =
            typeof res?.cost === "number"
              ? res.cost
              : typeof res?.total_cost === "number"
              ? res.total_cost
              : typeof res?.llm_cost_usd === "number"
              ? res.llm_cost_usd
              : 0;

          const existing = tierMap[tier];
          if (existing !== undefined) {
            existing.total_cost += cost;
            existing.count += 1;
          } else {
            tierMap[tier] = { total_cost: cost, count: 1 };
          }
        }
      }
    } catch {
      // best-effort second fetch; ignore errors
    }
  }

  // Build sorted tier list (highest total_cost first)
  const tiers: TierEntry[] = Object.entries(tierMap)
    .map(([tier, data]) => ({
      tier,
      total_cost: data?.total_cost ?? 0,
      count: data?.count ?? 0,
    }))
    .sort((a, b) => (b?.total_cost ?? 0) - (a?.total_cost ?? 0));

  const body: CostSummaryBody = {
    tiers,
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
  };

  return {
    shape: "resolver_tier_cost_summary",
    body,
  };
}
