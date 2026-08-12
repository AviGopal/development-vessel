import type { ResolverResult } from "./types.js";

/**
 * llm_api_health_observer — can the fleet's LLM arms actually COMPLETE?
 *
 * This observer used to GET `/health` on one hardcoded endpoint and report
 * `reachable: resp.ok`. Measured 2026-08-12, it answered:
 *
 *     { reachable: true, http_status: 200, error: null }
 *
 * while EVERY completion in the fleet had been returning
 * `401 "API key is invalid."` continuously for 43 hours — 566 in a single day,
 * zero successful completions, across all seven discovered arms. The vessel was
 * up. It simply could not do the one thing it exists to do, and the detector
 * built to notice that reported perfect health throughout.
 *
 * `/health` is the wrong question. A vessel answers it from its process, not
 * from its provider, so it cannot distinguish "running" from "able to work" —
 * this is the standing rule that an unconditional /health disables every
 * watchdog above it, arriving inside the watchdog itself.
 *
 * So: probe a real, minimal COMPLETION, and probe EVERY arm discovery knows
 * about rather than one env-pinned endpoint. Location is not the question —
 * routing already reaches local, hub and peer arms correctly. The question is
 * whether any of them can answer, and that has to be asked by asking.
 */

const DEFAULT_ENDPOINT = process.env["LLM_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8220";
const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const FED_TRANSPORT_EGRESS = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401";

export interface LlmApiHealthObserverPointer {
  type: "llm_api_health_observer";
  endpoint?: string;
  timeoutMs?: number;
  /** Legacy: probe `/health` instead of a completion. Reports the weaker signal and says so. */
  probePath?: string;
  /** Probe only the default endpoint rather than every discovered arm. */
  localOnly?: boolean;
}

interface ArmResult {
  arm: string;
  endpoint: string;
  /** liveness — the old signal, kept because "process down" and "provider dead" need different repairs */
  reachable: boolean;
  /** the signal that matters: did a real completion come back */
  can_complete: boolean;
  failure_class: string | null;
  http_status: number | null;
  roundtrip_ms: number | null;
  detail: string | null;
}

/**
 * Classify WHY an arm cannot complete. The repairs are entirely different and a
 * single boolean would send the operator to the wrong one: an expired credential
 * is an operator action, an unconfigured peer is a deployment gap, and a
 * transport timeout is a federation problem.
 */
function classify(status: number | null, text: string): string {
  const t = text.toLowerCase();
  if (t.includes("authentication_error") || t.includes("api key is invalid") || status === 401) return "unauthenticated";
  if (t.includes("no llm provider configured")) return "no_provider_configured";
  if (t.includes("no_reservation") || t.includes("ingress proxy failed") || t.includes("timed out")) return "transport_unreachable";
  if (t.includes("quota") || t.includes("credit") || status === 429) return "quota_exhausted";
  if (status !== null && status >= 500) return "provider_error";
  return "unknown";
}

/** Ask discovery for every arm serving llm_completion, direct and federated. */
async function discoverArms(timeoutMs: number): Promise<Array<{ arm: string; endpoint: string }>> {
  const out: Array<{ arm: string; endpoint: string }> = [];
  for (const shape of ["llm_completion", "llmCompletion"]) {
    try {
      const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { content?: { vessels?: Array<Record<string, unknown>> } };
      for (const v of j.content?.vessels ?? []) {
        const id = String(v["vesselId"] ?? v["id"] ?? "unknown");
        const ma = Array.isArray(v["libp2p_multiaddr"]) ? (v["libp2p_multiaddr"] as string[])[0] : undefined;
        // A libp2p row is reached through the local federation egress, exactly as
        // feature-compose and goal-host route it — probing its raw endpoint would
        // measure a hub-localhost address that is meaningless from here.
        const endpoint = v["protocol"] === "libp2p" && ma
          ? `${FED_TRANSPORT_EGRESS}/egress/resolve?target=${encodeURIComponent(ma)}&vessel=${encodeURIComponent(id.split("@")[0] ?? id)}`
          : `${String(v["endpoint"] ?? "").replace(/\/+$/, "")}/resolve`;
        if (endpoint && !out.some((o) => o.endpoint === endpoint)) out.push({ arm: id, endpoint });
      }
    } catch { /* a discovery miss is not an arm failure — leave the list short and say so */ }
  }
  return out;
}

/** One minimal completion. Cheap on purpose: this runs on a tick, not on demand. */
async function probeCompletion(endpoint: string, timeoutMs: number): Promise<{
  ok: boolean; status: number | null; ms: number; text: string;
}> {
  const start = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      // 1 token. The question is whether the provider answers at all, not what it says.
      body: JSON.stringify({ type: "llm_completion", prompt: "Reply with the single word: ok", max_tokens: 5 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await resp.text()).slice(0, 600);
    const ms = Date.now() - start;
    if (!resp.ok) return { ok: false, status: resp.status, ms, text };
    // A 200 CARRYING AN ERROR IS NOT A SUCCESS. The resolver answers 200 with
    // `{"resolved":false,"error":"401 ..."}` — reading resp.ok alone is precisely
    // how this went unnoticed for 43 hours.
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON handled below */ }
    const inner = (body["body"] ?? body) as Record<string, unknown>;
    const errored = inner["resolved"] === false || typeof inner["error"] === "string" || typeof body["error"] === "string";
    return { ok: !errored, status: resp.status, ms, text };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - start, text: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveLlmApiHealthObserver(
  pointer: LlmApiHealthObserverPointer,
): Promise<ResolverResult> {
  const timeoutMs = pointer.timeoutMs ?? 20_000;

  // LEGACY PATH, kept explicit. `probePath` asked for a liveness GET; honour it,
  // but label the answer so a caller cannot mistake it for the stronger signal.
  if (pointer.probePath) {
    const endpoint = pointer.endpoint ?? DEFAULT_ENDPOINT;
    const start = Date.now();
    try {
      const resp = await fetch(`${endpoint.replace(/\/+$/, "")}${pointer.probePath}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      return { shape: "llmApiHealth", body: {
        endpoint, probe_path: pointer.probePath, probe_kind: "liveness_only",
        reachable: resp.ok, http_status: resp.status, roundtrip_ms: Date.now() - start,
        can_complete: null,
        caveat: "LIVENESS ONLY — this says the process answers, not that it can complete. It reported healthy through 43 hours of 401s.",
        generated_at: new Date().toISOString(),
      } };
    } catch (err) {
      return { shape: "llmApiHealth", body: {
        endpoint, probe_path: pointer.probePath, probe_kind: "liveness_only",
        reachable: false, http_status: null, roundtrip_ms: Date.now() - start,
        can_complete: null, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        generated_at: new Date().toISOString(),
      } };
    }
  }

  const arms = pointer.localOnly
    ? [{ arm: "llm-resolver-vessel", endpoint: `${(pointer.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "")}/resolve` }]
    : await discoverArms(Math.min(timeoutMs, 10_000));
  // Discovery empty is NOT "no arms are healthy" — it is no reading. Fall back to
  // the known local endpoint so the observer still reports something measured.
  const targets = arms.length > 0
    ? arms
    : [{ arm: "llm-resolver-vessel(discovery-empty-fallback)", endpoint: `${DEFAULT_ENDPOINT.replace(/\/+$/, "")}/resolve` }];

  const results: ArmResult[] = await Promise.all(targets.map(async (t) => {
    const p = await probeCompletion(t.endpoint, timeoutMs);
    return {
      arm: t.arm,
      endpoint: t.endpoint.split("?")[0] ?? t.endpoint,   // never echo a multiaddr query back into the impulse
      reachable: p.status !== null,
      can_complete: p.ok,
      failure_class: p.ok ? null : classify(p.status, p.text),
      http_status: p.status,
      roundtrip_ms: p.ms,
      detail: p.ok ? null : p.text.slice(0, 240),
    };
  }));

  const healthy = results.filter((r) => r.can_complete);
  const classes = [...new Set(results.filter((r) => r.failure_class).map((r) => r.failure_class as string))];

  return {
    shape: "llmApiHealth",
    body: {
      probe_kind: "completion",
      arms_probed: results.length,
      arms_that_can_complete: healthy.length,
      // THE HEADLINE. Zero arms able to complete is a fleet-wide outage no
      // amount of routing repairs, and it is the state that went unseen for 43h.
      fleet_can_complete: healthy.length > 0,
      failure_classes: classes,
      // Liveness kept alongside, because "process down" and "provider dead" have
      // different repairs and collapsing them sends the operator to the wrong one.
      arms_reachable: results.filter((r) => r.reachable).length,
      arms: results,
      generated_at: new Date().toISOString(),
    },
  };
}
