// interaction_expectation_verify v0 skeleton: scores solicitations against interaction episodes (scoring wired next).
import type { ResolverResult } from "./types.js";

export interface InteractionExpectationVerifyPointer {
  type: "interaction_expectation_verify";
  solicitation_ids?: string[];
  horizon_ms?: number;
}

export async function resolveInteractionExpectationVerify(pointer: InteractionExpectationVerifyPointer): Promise<ResolverResult> {
  const ids = Array.isArray(pointer.solicitation_ids) ? pointer.solicitation_ids : [];
  const horizon = typeof pointer.horizon_ms === "number" ? pointer.horizon_ms : 14400000;
  if (ids.length === 0) return { shape: "interactionExpectationVerdict", body: { error: "solicitation_ids required" } };
  const verdicts = ids.map((id) => ({ solicitation_id: id, verdict: "unscored_absent", note: "episode source not yet wired (skeleton)" }));
  return { shape: "interactionExpectationVerdict", body: { verdicts, horizon_ms: horizon, episode_count: 0 } };
}
