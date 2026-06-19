import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * generative-frontier-gap-tick — single-task wrapper around the Seam ①
 * generative_frontier_gap_tick resolver.
 *
 * This is the substrate's only GENERATIVE intent source: it proposes a consumer
 * for the highest-traffic produced-but-uncomposed shape (closure frontier) and
 * emits a substrate_generative substrateGap — but ONLY if spectral-gap headroom
 * (λ₁·(1-star_ratio)) clears the threshold. The gate fails CLOSED, the emit is
 * rate-limited, and the gap id is stable (no timestamp) so re-proposals upsert
 * one row — the resolver is structurally incapable of flooding.
 *
 * Immunity-pattern compliant — empty inputShapes, empty variables, single
 * server-side resolver task. The tick itself cannot pre-flight-reject.
 */

export const GENERATIVE_FRONTIER_GAP_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:generative-frontier-gap-tick",
  name: "generative-frontier-gap-tick",
  description:
    "Deterministic single-resolver wrapper around generative_frontier_gap_tick (Seam ①). " +
    "Finds the highest-traffic produced-but-uncomposed shape from the topology frontier and, " +
    "ONLY if spectral headroom (fiedler_lambda2 * (1 - star_ratio)) exceeds threshold AND the " +
    "graph is a single connected component with enough nodes, emits ONE substrate_generative " +
    "substrateGap proposing a consumer capability (closure-frontier extension). Fails closed when " +
    "the spectral signal is unavailable. Rate-limited and stable-id deduped so it cannot flood. " +
    "Returns generativeFrontierGapReport. Tagged intent:generative, phase:trigger.",
  inputShapes: [],
  outputShapes: ["generativeFrontierGapReport"],
  tags: ["intent:generative", "phase:trigger", "topology.discovery.loop", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "tick_generative_frontier_gap",
      description:
        "Invoke generative_frontier_gap_tick. Reads the spectral-gap JSONL (headroom gate, " +
        "fail-closed), then activity-api templates + recent traces to derive the produced-but-" +
        "uncomposed frontier. If headroom clears the threshold and rate-limit/dedup allow, POSTs a " +
        "substrateGap_write with source=substrate_generative proposing a consumer for the top shape.",
      resolver: "generative_frontier_gap_tick",
      config: {
        type: "generative_frontier_gap_tick",
      },
      outputShapes: ["generativeFrontierGapReport"],
    },
  ],
};
