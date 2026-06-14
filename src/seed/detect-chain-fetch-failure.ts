import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-chain-fetch-failure — deterministic detector for authored chains whose
 * http_fetch tasks fail (non-2xx), via their observable EFFECT: degenerate mints.
 *
 * Meta-detector authored 2026-06-13 after the operator watched authored
 * orphan-remediation chains GET activity-api over raw http_fetch, hit 401, and —
 * handed empty/error data — mint concepts whose content was "I cannot access …
 * 401 authentication error" / "please provide the list". The chain completed
 * (http_fetch swallows non-2xx) and the write succeeded, so nothing failed —
 * only the failure-marker language in the minted content betrayed it. This makes
 * the class substrate-detectable: scan recently-minted concepts for fetch-failure
 * markers and emit one aggregated substrateGap when the count crosses a
 * threshold, routing the fix into the gap → bridge → drafter loop. The aligned
 * remediation is re-authoring over typed resolvers / correct endpoints.
 *
 * Single-task template (mirrors detect-stale-pointer); the resolver does the
 * whole search → match → emit flow; no LLM.
 */
export const DETECT_CHAIN_FETCH_FAILURE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-chain-fetch-failure",
  name: "detect-chain-fetch-failure",
  description:
    "Scans recently-minted concept-db concepts for fetch/data-flow failure " +
    "markers in their content ('401', 'cannot access', 'please provide the " +
    "data', 'Invalid JSON', …) — the observable effect of authored chains whose " +
    "http_fetch tasks returned non-2xx yet 'completed', minting garbage. Emits " +
    "one aggregated substrateGap when the degenerate count crosses the threshold, " +
    "with classification_metadata.gap_subtype='chain_fetch_failure_degenerate_output'. " +
    "Catches the class where authored orphan chains GET an auth-gated endpoint and " +
    "the downstream LLM records the failure instead of real data.",
  inputShapes: [],
  outputShapes: ["substrateGap", "chainFetchFailureReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "trace.quality",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the degenerate-mint scan + aggregated gap-emission in one server-side " +
        "step. Returns a chainFetchFailureReport with scanned/degenerate_count/" +
        "triggered and the matched hits (concept_id, shape, snippet).",
      resolver: "chain_fetch_failure_scan",
      config: {
        type: "chain_fetch_failure_scan",
        threshold: 2,
        dry_run: false,
      },
      outputShapes: ["chainFetchFailureReport"],
    },
  ],
};
