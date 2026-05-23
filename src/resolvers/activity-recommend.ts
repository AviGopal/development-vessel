import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityRecommendPointer {
  type: "activity_recommend";
  task_description: string;
  expected_output_shapes?: string[];
  impulse_shapes?: string[];
  limit?: number;
}

export async function resolveActivityRecommend(pointer: ActivityRecommendPointer): Promise<ResolverResult> {
  const url = `${METABOB_ENDPOINT}/v2/activities/recommend`;
  const body = {
    task_description: pointer.task_description,
    expected_output_shapes: pointer.expected_output_shapes ?? [],
    impulse_shapes: pointer.impulse_shapes ?? [],
    limit: pointer.limit ?? 10,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "structuredError",
      body: { resolver: "activity_recommend", status: res.status, detail: text.slice(0, 200) },
    };
  }
  const json = await res.json() as Record<string, unknown>;
  const recommendations = (json["recommendations"] ?? json["activities"] ?? json["templates"] ?? []) as unknown[];
  return {
    shape: "activity_recommendations",
    body: {
      recommendations,
      count: recommendations.length,
      tier: (json["fallback_tier"] as string | undefined) ?? null,
    },
  };
}
