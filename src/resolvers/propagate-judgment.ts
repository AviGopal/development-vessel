import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface PropagateJudgmentPointer {
  type: "propagate_judgment";
  activity_variant_id: string;
  impulse_id: string;
  relevance_score: number;
  source_tier: "human" | "verifier" | "automatic";
  context?: string;
}

export async function resolvePropagateJudgment(pointer: PropagateJudgmentPointer): Promise<ResolverResult> {
  const weight = pointer.source_tier === "human" ? 1.0 : pointer.source_tier === "verifier" ? 0.7 : 0.4;
  const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/impulse-relevance`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      activity_variant_id: pointer.activity_variant_id,
      impulse_id: pointer.impulse_id,
      relevance_score: pointer.relevance_score,
      source: `${pointer.source_tier}:development-vessel`,
      weight,
      context: pointer.context,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "judgmentPropagated",
      body: { impulse_relevance_call_succeeded: false, status: res.status, detail: text.slice(0, 200) },
    };
  }
  const result = await res.json();
  return { shape: "judgmentPropagated", body: { impulse_relevance_call_succeeded: true, accepted: true, detail: result } };
}
