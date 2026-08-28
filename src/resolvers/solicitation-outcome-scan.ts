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
  let ids = Array.isArray(pointer.solicitation_ids) ? pointer.solicitation_ids : [];
  const horizon = typeof pointer.horizon_ms === "number" ? pointer.horizon_ms : 14400000;
  // SELF-SUPPLY (2026-08-28): the only caller is boredom-vessel's "human-interacting" family list
  // (repos/boredom-vessel/src/index.ts), which dispatches this shape BARE. ids was therefore always
  // empty and this resolver returned "no solicitation_ids supplied" every time — a guaranteed no-op,
  // verified live against the running vessel. Meanwhile gap-to-feature.ts escalated 1755 times in
  // 48h. When no ids are supplied, read the outstanding escalation panels from stateful-ui.
  if (ids.length === 0) {
    try {
      const uiEndpoint = process.env["STATEFUL_UI_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8270";
      const uiRes = await fetch(uiEndpoint + "/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "uiQuestion" } } }), signal: AbortSignal.timeout(10000) });
      const uiJson = (await uiRes.json()) as { body?: { questions?: Array<{ id?: string }> } };
      ids = (uiJson.body?.questions ?? []).map((q) => String(q.id ?? "")).filter((qid) => qid.startsWith("needs-human-") || qid.startsWith("reland-needs-human-"));
    } catch { /* transport failure -> fail open, ids stays empty */ }
  }
  if (ids.length === 0) {
    return { shape: "solicitationOutcomeReport", body: { authored: true, outcomes: [], answered: 0, episode_count: 0, note: "no outstanding solicitations" } };
  }
  // ANSWER SURFACE (2026-08-28): a human answering an escalation panel hits stateful-ui-vessel's
  // POST /api/feedback, which emits uiFeedback_write keyed by panel_id; dev-vessel's interactor
  // passthrough appends that to WORKSPACE_ROOT/interactor-log/uiFeedback_write.jsonl. That file is
  // the durable answer record — this is the "gap-consumer learns to read the log files" step the
  // interactor-passthrough module comment describes. The obsidian:interaction_episode read below
  // matches a DIFFERENT surface keyed on solicitation_ids, and NOTHING in repos/obsidian-vessel/src
  // produces solicitation_ids on an episode; it is retained only for episode-based solicitations
  // that genuinely carry them. Panel escalations never appear there, so without this the answer
  // could never be observed.
  const answeredPanels = new Set<string>();
  try {
    const root = process.env["WORKSPACE_ROOT"] ?? "/workspace";
    const logFile = Bun.file(root + "/interactor-log/uiFeedback_write.jsonl");
    if (await logFile.exists()) {
      for (const line of (await logFile.text()).split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { pointer?: { panel_id?: string; kind?: string } };
          const pid = rec.pointer?.panel_id;
          if (typeof pid === "string" && pid && rec.pointer?.kind !== "dismiss") answeredPanels.add(pid);
        } catch { /* skip malformed line */ }
      }
    }
  } catch { /* fail open -> answeredPanels stays empty */ }
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
    // Panel answers are checked FIRST and independently of `episodes`. The obsidian read fails open
    // to episodes === null (measured: that endpoint returns an empty body, so this is the normal
    // case, not the exceptional one), and the unscored_absent short-circuit below would otherwise
    // discard a real, recorded human answer.
    if (answeredPanels.has(id)) { answered += 1; return { solicitation_id: id, outcome: "answered" as const }; }
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
