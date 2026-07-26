// interaction_expectation_verify v0 skeleton: scores solicitations against interaction episodes (scoring wired next).
import type { ResolverResult } from "./types.js";
import { resolveObsidianEndpointViaDiscovery } from "./obsidian-request-scan.js";

export interface InteractionExpectationVerifyPointer {
  type: "interaction_expectation_verify";
  solicitation_ids?: string[];
  horizon_ms?: number;
}

export async function resolveInteractionExpectationVerify(pointer: InteractionExpectationVerifyPointer): Promise<ResolverResult> {
  const ids = Array.isArray(pointer.solicitation_ids) ? pointer.solicitation_ids : [];
  const horizon = typeof pointer.horizon_ms === "number" ? pointer.horizon_ms : 14400000;
  if (ids.length === 0) return { shape: "interactionExpectationVerdict", body: { error: "solicitation_ids required" } };
  const endpoint = (await resolveObsidianEndpointViaDiscovery()) ?? process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? "http://127.0.0.1:27182";
  let episodes: Array<{ solicitation_ids?: string[]; window_start?: string; sorted_unique_class_signature?: string[] }> | null = null;
  try {
    const res = await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "obsidian:interaction_episode" } } }), signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as { content?: string };
    const parsed = json.content ? (JSON.parse(json.content) as { episodes?: Array<{ solicitation_ids?: string[]; window_start?: string }> }) : {};
    if (Array.isArray(parsed.episodes)) episodes = parsed.episodes;
  } catch { }
  const cutoff = Date.now() - horizon;
  const verdicts = ids.map((id) => {
    if (episodes === null) {
      return { solicitation_id: id, verdict: "unscored_absent" };
    }
    const matched = episodes.find((e) => Array.isArray(e.solicitation_ids) && e.solicitation_ids.includes(id) && (!e.window_start || Date.parse(e.window_start) >= cutoff));
    if (!matched) {
      return { solicitation_id: id, verdict: "unmet" };
    }
    const sig = matched.sorted_unique_class_signature;
    if (Array.isArray(sig) && sig.length > 0) {
      return { solicitation_id: id, verdict: "met_novel", sorted_unique_class_signature: sig };
    }
    return { solicitation_id: id, verdict: "met_saturated" };
  });
  const unmet = verdicts.filter((v) => v.verdict === "unmet");
  const operatorPresent = ids.some(id => pointer.solicitation_ids?.includes(id) ?? false);
  if (unmet.length > 0 && operatorPresent) {
    await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "verifier_negative" }, reason: "interaction expectation unmet with operator present" } }), signal: AbortSignal.timeout(10000) });
  }
  if (unmet.length > 0) {
    await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "interaction_surface_gap" }, expectation_id: ids.join(",") } }), signal: AbortSignal.timeout(10000) });
  }
  const ledger = await (async () => {
    try {
      const r = await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "verdict_ledger" } } }), signal: AbortSignal.timeout(10000) });
      const j = await r.json() as { content?: string };
      return j.content ? (JSON.parse(j.content) as Array<{ solicitation_id: string; verdict: string; timestamp: number }>) : [];
    } catch {
      return [] as Array<{ solicitation_id: string; verdict: string; timestamp: number }>;
    }
  })();
  const now = Date.now();
  for (const v of verdicts) {
    ledger.push({ solicitation_id: v.solicitation_id, verdict: v.verdict, timestamp: now });
  }
  await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "verdict_ledger" }, content: JSON.stringify(ledger) } }), signal: AbortSignal.timeout(10000) });
  return { shape: "interactionExpectationVerdict", body: { verdicts, horizon_ms: horizon, episode_count: episodes === null ? 0 : episodes.length } };
}
