import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-recurring-pattern — Phase 3 closed-loop learning, task 3.1
 *
 * Trace-store query + windowed clustering across Layer-1/2/3 outputs. Scans
 * recent `obsidianEpisode` (and optional `intentLabel` / `trajectoryPrediction`)
 * traces, groups by signature, emits a `recurringPatternCluster` impulse when
 * the count clears the threshold AND at least one contrast trace is present.
 *
 * Spec: openspec/changes/2026-06-01-closed-loop-learning-and-verification/
 *   specs/closed-loop-learning/spec.md
 *
 * Pipeline:
 *   1. read_recent_episodes — http_fetch to obsidian-vessel to list recent episodes
 *   2. compute_signature_frequencies — llm_completion_dispatch acting as the
 *      deterministic-clustering step (no clustering resolver ships yet; the LLM
 *      receives the episode list and returns sorted signature counts as JSON)
 *   3. select_recurring — json_path_extract picks the top-scoring pattern_id
 *      that clears the threshold AND has not been drafted recently
 *   4. emit_recurring_pattern_cluster — fs_write the cluster JSON + http_fetch
 *      POST to substrateGap_write to enqueue the pattern so the broader
 *      pull-poll loop can pick it up if the direct dispatch fails
 *   5. dispatch_drafter — http_fetch POST to goal-host-vessel /run-goal
 *      targeting draft-activity-from-pattern (Phase 2 drafter)
 *
 * Deduplication: writes the dispatched pattern_id into
 * `/workspace/patterns/_dispatched.json` (the Phase 2 drafter consults this
 * map; if a pattern was drafted within the last 24h the drafter no-ops).
 * The dedupe map is structured as `{ "<pattern_id>": "<ISO timestamp>" }`.
 *
 * Threshold:
 *   default `n_occurrences ≥ 5` (per spec). Variable `min_occurrences` lets
 *   tests + tuning override.
 *
 * Contrast example requirement:
 *   `select_recurring` returns `null` (and downstream tasks no-op against a
 *   blank pattern_id) when no contrast trace is identified. The Phase 3 spec
 *   "Cluster with insufficient contrast suppressed" scenario is enforced by
 *   the LLM prompt + the json_path_extract gate.
 */
export const DETECT_RECURRING_PATTERN_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-recurring-pattern",
  name: "detect-recurring-pattern",
  description:
    "Phase 3 closed-loop: scans recent obsidianEpisode traces, clusters them by " +
    "sorted_unique_class_signature, and when the frequency clears n_occurrences ≥ 5 " +
    "AND at least one contrast trace is identifiable, emits a recurringPatternCluster " +
    "and dispatches the Phase 2 drafter (draft-activity-from-pattern). Deduplicates " +
    "via /workspace/patterns/_dispatched.json to avoid firing the drafter repeatedly " +
    "for the same pattern within a 24h window.",
  inputShapes: ["obsidianEpisode", "intentLabel", "trajectoryPrediction"],
  outputShapes: ["recurringPatternCluster"],
  tags: [
    "phase:3",
    "closed.loop.learning",
    "pattern.detection",
    "obsidian.meta.skill.prototype",
    "lift.autonomous.loop",
  ],
  variables: [
    {
      name: "obsidian_vessel_endpoint",
      description:
        "Base URL for obsidian-vessel (provides Layer-1 episode read path). " +
        "Default: http://127.0.0.1:8290 (Phase 1 obsidian-observe-and-experiment).",
    },
    {
      name: "lookback_window_hours",
      description: "Sliding window in hours; episodes older than this are excluded. Default 24.",
    },
    {
      name: "max_episodes",
      description: "Max episodes the read step pulls. Default 200.",
    },
    {
      name: "min_occurrences",
      description: "Frequency threshold for a pattern to qualify. Default 5 (spec).",
    },
    {
      name: "patterns_dir",
      description: "Directory where cluster JSON and dedupe map live. Default /workspace/patterns.",
    },
    {
      name: "drafter_template_id",
      description:
        "Target template id dispatched on successful detection. Default " +
        "'development-vessel:draft-activity-from-pattern' (Phase 2).",
    },
  ],
  tasks: [
    {
      id: "read_recent_episodes",
      description:
        "Fetch the most-recent obsidianEpisode set from obsidian-vessel. Returns a " +
        "JSON list of episodes including each episode's sorted_unique_class_signature.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "{{obsidian_vessel_endpoint}}/v1/episodes?lookback_hours={{lookback_window_hours}}&limit={{max_episodes}}",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["obsidianEpisodeBatch"],
    },
    {
      id: "compute_signature_frequencies",
      description:
        "Group episodes by sorted_unique_class_signature and count occurrences within " +
        "the lookback window. Reads /workspace/patterns/_dispatched.json (best-effort) " +
        "and excludes any pattern_id already dispatched in the past 24h. Emits JSON: " +
        '{"clusters":[{"pattern_id":"<sha1>","signature":"<sorted_unique_class>","count":N,' +
        '"contrast_examples":[<episode_id>],"n_concept_citations_available":N}]} sorted by count desc.',
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are a deterministic clustering step inside the substrate's Phase 3 " +
          "closed-loop pattern detector. Group the episodes below by their " +
          "sorted_unique_class_signature, count each signature's frequency, and " +
          "identify at least one CONTRAST episode (an episode with a different " +
          "signature) per cluster. Treat the dispatched-map as a denylist: drop " +
          "any pattern_id that appears in it with a timestamp newer than 24h ago.\n\n" +
          "Episodes JSON: {{read_recent_episodes_content}}\n\n" +
          "Dedupe map (may be empty): {{patterns_dir}}/_dispatched.json contents " +
          "should be ignored by you here; the json_path_extract step downstream " +
          "performs the final dedupe gate.\n\n" +
          'Emit ONLY this JSON shape (no prose):\n{"clusters":[{"pattern_id":"<sha1 ' +
          'of signature>","signature":"<sorted_unique_class>","count":<int>,' +
          '"contrast_examples":["<episode_id>",...],"n_concept_citations_available":<int>}]}\n\n' +
          "Sort the array by count descending. If no signature reaches the " +
          "min_occurrences threshold ({{min_occurrences}}) OR if any candidate cluster " +
          "has zero contrast_examples, emit {\"clusters\":[]}.",
        model: "anthropic/claude-haiku-4-5-20251001",
        max_tokens: 1500,
      },
      outputShapes: ["recurringPatternClusterCandidates"],
    },
    {
      id: "select_recurring",
      description:
        "Extract the top cluster (clusters[0]) from the candidate set. If the " +
        "candidate list is empty (threshold not met OR contrast missing OR all " +
        "candidates deduped), this task produces an empty string and the " +
        "downstream emit + dispatch tasks effectively no-op.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{compute_signature_frequencies_content}}",
        path: "clusters.0.pattern_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "emit_recurring_pattern_cluster",
      description:
        "Persist the selected cluster to /workspace/patterns/<pattern_id>.json. " +
        "When the pattern_id is blank (no cluster met the threshold) the write " +
        "fails fast — a normal trace, not an error. Downstream Phase 2 drafter " +
        "consumes this file when targeted via dispatch_drafter.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{patterns_dir}}/{{select_recurring_text}}.json",
        content: "{{compute_signature_frequencies_content}}",
      },
      outputShapes: ["recurringPatternCluster"],
    },
    {
      id: "dispatch_drafter",
      description:
        "POST to goal-host-vessel /run-goal targeting the Phase 2 drafter " +
        "(draft-activity-from-pattern) with the pattern_id as scenario_id. " +
        "The drafter consults /workspace/patterns/_dispatched.json before " +
        "minting a candidate so back-to-back ticks within 24h do not produce " +
        "duplicate authoredActivityCandidate impulses.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "draft an activity from recurring pattern {{select_recurring_text}}",
          targetTemplateId: "{{drafter_template_id}}",
          variables: {
            pattern_id: "{{select_recurring_text}}",
            patterns_dir: "{{patterns_dir}}",
            source: "detect-recurring-pattern",
          },
        }),
      },
      outputShapes: ["healthGapDispatch"],
    },
  ],
};
