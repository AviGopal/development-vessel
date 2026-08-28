/**
 * solicitation_outcome_scan — substrate-authored resolver (Seam ③).
 * Input shapes (closure linkage): obsidian:interaction_episode
 * Output shape: solicitationOutcomeReport
 *
 * The OPERATOR-VERDICT-CORPUS read-back (§12.6 step 1b, filled in 2026-08-14). Given the ids of
 * outstanding solicitations (e.g. the close-oracle's re-land escalations, id
 * "reland-needs-human-<gapId>"), it reads obsidian interaction episodes and reports which were
 * ANSWERED by a human. An answered re-land escalation is an operator verdict corroborating the
 * oracle's abstain, so it is folded into the close-oracle's operator-engagement tally
 * (recordOperatorEngagement) — the oracle calibrating against the operator corpus, not only against
 * reality's re-detection. Mirrors the proven interaction-expectation-verify read path
 * (discovery-resolved endpoint, fetch obsidian:interaction_episode, match by solicitation_id,
 * fail-open on transport error). Was a stub returning empty; now a real read-back.
 */

import type { ResolverResult } from "./types.js";
import { resolveObsidianEndpointViaDiscovery } from "./obsidian-request-scan.js";
import { recordOperatorEngagement } from "./gap-to-feature.js";

export interface SolicitationOutcomeScanPointer {
  type: "solicitation_outcome_scan";
  solicitation_ids?: string[];
  horizon_ms?: number;
  [key: string]: unknown;
}

export async function resolveSolicitationOutcomeScan(pointer: SolicitationOutcomeScanPointer): Promise<ResolverResult> {
  const ids = Array.isArray(pointer.solicitation_ids) ? pointer.solicitation_ids : [];
  const horizon = typeof pointer.horizon_ms === "number" ? pointer.horizon_ms : 14400000;
  if (ids.length === 0) {
    return { shape: "solicitationOutcomeReport", body: { authored: true, outcomes: [], answered: 0, pending: 0, episode_count: 0, horizon_ms: horizon } };
  }
  const endpoint = (await resolveObsidianEndpointViaDiscovery()) ?? process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? "http://127.0.0.1:27182";
  let episodes: Array<{ solicitation_ids?: string[]; window_start?: string }> | null = null;
  try {
    const res = await fetch(endpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "obsidian:interaction_episode" } } }), signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as { content?: string };
    const parsed = json.content ? (JSON.parse(json.content) as { episodes?: Array<{ solicitation_ids?: string[]; window_start?: string }> }) : {};
    if (Array.isArray(parsed.episodes)) episodes = parsed.episodes;
  } catch { /* transport failure -> fail open (episodes stays null -> unscored) */ }
  const cutoff = Date.now() - horizon;
  let answered = 0;
  const outcomes = ids.map((id) => {
    if (episodes === null) return { solicitation_id: id, outcome: "unscored_absent" as const };
    const matched = episodes.find((e) => Array.isArray(e.solicitation_ids) && e.solicitation_ids.includes(id) && (!e.window_start || Date.parse(e.window_start) >= cutoff));
    if (!matched) return { solicitation_id: id, outcome: "pending" as const };
    answered += 1;
    // A HUMAN answered this solicitation. If it is a close-oracle re-land escalation, fold the
    // operator's engagement into the oracle's operator-verdict calibration.
    if (id.startsWith("reland-needs-human-")) recordOperatorEngagement("landed_commit");
    return { solicitation_id: id, outcome: "answered" as const };
  });
  return { shape: "solicitationOutcomeReport", body: { authored: true, outcomes, answered, pending: outcomes.filter((o) => o.outcome === "pending").length, episode_count: episodes === null ? 0 : episodes.length, horizon_ms: horizon } };
}
