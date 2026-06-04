import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-filter-saturation — generic filter-saturation detector.
 *
 * Substrate anchor: concept_-rQijiezhmMZ (detect_filter_saturation,
 * impulse_activity_pattern). Parent: concept_TbN0eSf7U_hM
 * (learning_rate_improvement_mechanisms). Discipline: concept_7mzv7SQN_7JB
 * (no new shapes, no new resolver kinds, no new tiers, no new vocabulary).
 *
 * Operator-side analog: the manual journalctl scan that showed M3's replay
 * observer at 100% no-matches (106 jobs, 0 matched). The observer is firing
 * correctly; the input_shapes filter is too restrictive vs. the historical
 * trace corpus. The detection would identify this without the operator
 * needing to read logs by hand.
 *
 * Generic — takes positive_event_pattern, negative_event_pattern,
 * log_unit_name, time_window_minutes, saturation_threshold, min_volume, and
 * mechanism_concept_id as variables. Emits a mechanismHealthFinding memo via
 * concept_create_write when negative / (positive + negative) exceeds the
 * threshold AND total >= min_volume (so noise floors don't trigger).
 */

export const DETECT_FILTER_SATURATION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-filter-saturation",
  name: "detect-filter-saturation",
  description:
    "Generic filter-saturation detector cited from substrate concept " +
    "concept_-rQijiezhmMZ (detect_filter_saturation). Greps a systemd journal " +
    "unit over time_window_minutes for positive_event_pattern and " +
    "negative_event_pattern, computes the no-match ratio, and emits a " +
    "mechanismHealthFinding memo via concept_create_write when the ratio " +
    "exceeds saturation_threshold AND total >= min_volume. Reusable for M3 " +
    "replay observer (concept_YinkepAheImS), future filter-based observers, " +
    "and retrieval failures.",
  inputShapes: [],
  outputShapes: ["mechanismHealthFinding"],
  tags: [
    "mechanism.health.tick",
    "substrate.self.detection",
    "lift.autonomous.loop",
  ],
  variables: [
    {
      name: "positive_event_pattern",
      description:
        "grep pattern (extended regex) matching the positive (match) event line " +
        "in the journal (e.g. 'Replay completed with replays').",
    },
    {
      name: "negative_event_pattern",
      description:
        "grep pattern matching the negative (no-match) event line " +
        "(e.g. 'Replay no matches').",
    },
    {
      name: "log_unit_name",
      description:
        "systemd unit name to read via journalctl -u (e.g. replay-observer.service).",
    },
    {
      name: "time_window_minutes",
      description:
        "Lookback window for journalctl --since in minutes (integer; default 60).",
    },
    {
      name: "saturation_threshold",
      description:
        "Saturation threshold in [0,1]; finding emits when negative / (positive + " +
        "negative) > threshold (default 0.95).",
    },
    {
      name: "min_volume",
      description:
        "Minimum total events (positive + negative) required before a finding emits. " +
        "Suppresses noise-floor false positives (default 10).",
    },
    {
      name: "mechanism_concept_id",
      description:
        "Concept id of the mechanism this probe monitors (cited in the emitted finding " +
        "for provenance, e.g. concept_YinkepAheImS for M3).",
    },
  ],
  tasks: [
    {
      id: "count_positive_events",
      description:
        "journalctl -u <unit> --since=<window>m | grep -cE <positive_event_pattern>. " +
        "Bounded to the configured window; outputs the count on stdout. The unit runs " +
        "inside substrate-live so journalctl reads the substrate's own journal.",
      resolver: "bash",
      config: {
        type: "bash",
        command:
          "journalctl --no-pager -u {{log_unit_name}} " +
          "--since '{{time_window_minutes}} minutes ago' | " +
          "grep -cE -- '{{positive_event_pattern}}' || true",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "count_negative_events",
      description:
        "Same as count_positive_events but for the negative event pattern. " +
        "Together the two counts give the saturation ratio.",
      resolver: "bash",
      config: {
        type: "bash",
        command:
          "journalctl --no-pager -u {{log_unit_name}} " +
          "--since '{{time_window_minutes}} minutes ago' | " +
          "grep -cE -- '{{negative_event_pattern}}' || true",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "evaluate_saturation",
      description:
        "Compute ratio = neg / (pos + neg), then saturated = (ratio > threshold AND " +
        "total >= min_volume). Outputs JSON { positive, negative, total, ratio, " +
        "threshold, min_volume, saturated } the downstream emission step embeds in " +
        "the finding body. python3 stdlib — no extra deps.",
      resolver: "bash",
      config: {
        type: "bash",
        command:
          "python3 -c \"import json,sys; " +
          "try:\\n p=int((sys.argv[1] or '0').strip())\\nexcept Exception:\\n p=0\\n" +
          "try:\\n n=int((sys.argv[2] or '0').strip())\\nexcept Exception:\\n n=0\\n" +
          "thr=float(sys.argv[3] or '0.95'); " +
          "mv=int(sys.argv[4] or '10'); " +
          "t=p+n; r=(n/t) if t else 0.0; " +
          "print(json.dumps({'positive':p,'negative':n,'total':t,'ratio':r," +
          "'threshold':thr,'min_volume':mv,'saturated': r>thr and t>=mv}))\" " +
          "'{{count_positive_events_stdout}}' '{{count_negative_events_stdout}}' " +
          "'{{saturation_threshold}}' '{{min_volume}}'",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "emit_finding_if_saturated",
      description:
        "POST a concept_create_write to concept-db with the mechanismHealthFinding " +
        "carrying the saturation verdict + counts. The body carries the saturated " +
        "boolean so consumers can filter no-op runs. Discipline (concept_7mzv7SQN_7JB) — " +
        "no new shape: mechanismHealthFinding is source_type=memo with a specific " +
        "summary pattern, not a schema shape. Cites both the mechanism's concept_id " +
        "and the parent concept_-rQijiezhmMZ.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8260/v2/impulses/resolve",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pointer: {
            type: "concept_create_write",
            conceptData: {
              shape: "mechanismHealthFinding",
              source_type: "memo",
              summary:
                "filter_saturation probe for mechanism {{mechanism_concept_id}}; " +
                "see content for positive/negative counts and saturation ratio.",
              content:
                "Detector: detect-filter-saturation (concept_-rQijiezhmMZ). " +
                "Mechanism: {{mechanism_concept_id}}. " +
                "Log unit: {{log_unit_name}}. " +
                "Positive pattern: {{positive_event_pattern}}. " +
                "Negative pattern: {{negative_event_pattern}}. " +
                "Window minutes: {{time_window_minutes}}. " +
                "Evaluation: {{evaluate_saturation_stdout}}.",
              priority: 0.5,
              budget: 2000,
              pointer: {
                type: "memo",
                path: "/workspace/mechanism-health/findings/filter-saturation.json",
                section: "{{mechanism_concept_id}}",
              },
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
  ],
};
