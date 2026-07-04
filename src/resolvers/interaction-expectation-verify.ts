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
  let episodes: Array<{ solicitation_ids?: string[]; window_start?: string }> | null = null;
  try {
    const res = await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "obsidian:interaction_episode" } } }), signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as { content?: string };
    const parsed = json.content ? (JSON.parse(json.content) as { episodes?: Array<{ solicitation_ids?: string[]; window_start?: string }> }) : {};
    if (Array.isArray(parsed.episodes)) episodes = parsed.episodes;
  } catch { }
  const cutoff = Date.now() - horizon;
  const verdicts = ids.map((id) => ({ solicitation_id: id, verdict: episodes === null ? "unscored_absent" : (episodes.some((e) => Array.isArray(e.solicitation_ids) && e.solicitation_ids.includes(id) && (!e.window_start || Date.parse(e.window_start) >= cutoff)) ? "met" : "unmet") }));
  return { shape: "interactionExpectationVerdict", body: { verdicts, horizon_ms: horizon, episode_count: episodes === null ? 0 : episodes.length } };
}
