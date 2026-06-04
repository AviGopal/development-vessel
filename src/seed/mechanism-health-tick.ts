import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * mechanism-health-tick — aggregator composing the 3 generic detectors
 * against the M1-M6 observable surface.
 *
 * Substrate anchor: concept_q2n0_XaSvphV (mechanism_health_tick,
 * impulse_activity_pattern). Parent: concept_TbN0eSf7U_hM
 * (learning_rate_improvement_mechanisms). Discipline: concept_7mzv7SQN_7JB
 * (no new shapes, no new resolver kinds, no new tiers, no new vocabulary).
 *
 * Per-mechanism observable configuration (from concept_q2n0_XaSvphV's body):
 *   M1 (concept_vugylIHzIMvk) — feature-flag-zero-exercise of
 *     EMBEDDING_PRIOR_ENABLED against context_thompson_scores.
 *   M2 (concept_uTVZPoaxMmo2) — filter-saturation between
 *     prior_seed_source='concept_neighbors' (positive) and 'fallback_uniform'
 *     (negative) rows in context_thompson_scores. Approximated via journalctl
 *     on activity-api.service since the table-level positive/negative split
 *     surfaces in the api's log lines.
 *   M3 (concept_YinkepAheImS) — filter-saturation between
 *     '[replay-observer] Replay completed with replays' (positive) and
 *     '[replay-observer] Replay no matches' (negative) on the replay-observer
 *     unit. NOTE: the replay-observer unit may not exist on the local
 *     substrate yet; failure is non-fatal (per-mechanism dispatches are
 *     independent and the aggregator surfaces any failed dispatch as
 *     'unknown' in the rollup).
 *   M4 (concept_SDerP4GcuhGm) — classifier-distribution-skew on
 *     /v2/activities/recommend's selection_metadata.tier_class field.
 *   M6 (concept_iae171XpW50_) — classifier-distribution-skew on the
 *     composition_chain depth distribution recorded in activity_execution_traces.
 *
 * Mirrors coverage-tick + substrate-health-tick: a measure-phase aggregator
 * that boredom-vessel dispatches via the goal rotation. The rollup
 * substrateHealthReport-shape memo captures per-mechanism status (healthy /
 * wiring_gap / saturated / skewed / unknown) and cites all 5 anchor concept_ids
 * so the drafter's concept-priming surface sees the synthesis on next tick.
 */

const RUN_GOAL_URL = "http://127.0.0.1:8210/run-goal";

export const MECHANISM_HEALTH_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:mechanism-health-tick",
  name: "mechanism-health-tick",
  description:
    "Aggregator cited from substrate concept concept_q2n0_XaSvphV " +
    "(mechanism_health_tick). Composes the 3 generic detectors " +
    "(detect-classifier-distribution-skew, detect-feature-flag-zero-exercise, " +
    "detect-filter-saturation) against the per-mechanism observables for " +
    "M1 (concept_vugylIHzIMvk), M2 (concept_uTVZPoaxMmo2), M3 " +
    "(concept_YinkepAheImS), M4 (concept_SDerP4GcuhGm), and M6 " +
    "(concept_iae171XpW50_). Mirrors coverage-tick + substrate-health-tick: " +
    "boredom-vessel dispatches on cadence; the resulting per-mechanism " +
    "findings stream into concept-db and the rollup substrateHealthReport-" +
    "shape memo names each mechanism's status (healthy / wiring_gap / " +
    "saturated / skewed / unknown).",
  inputShapes: [],
  outputShapes: ["mechanismHealthFinding", "substrateHealthReport"],
  tags: [
    "mechanism.health.tick",
    "substrate.self.detection",
    "lift.autonomous.loop",
    "topology.discovery.loop",
  ],
  variables: [],
  composition_rationales: [
    {
      task_id: "dispatch_m1_feature_flag",
      rationale_class: "essential",
      rationale_text:
        "M1 (EMBEDDING_PRIOR_ENABLED → context_thompson_scores) is the canonical " +
        "feature-flag-zero-exercise case — the detector and the mechanism are paired " +
        "by concept_q2n0_XaSvphV's body. No substitute detector applies.",
    },
    {
      task_id: "dispatch_m2_filter_saturation",
      rationale_class: "replaceable",
      rationale_text:
        "M2 (concept_neighbors vs fallback_uniform) is filter-saturation in shape — " +
        "any observable that yields positive/negative event counts over a window " +
        "would work; the journalctl approximation here keeps the substrate dep " +
        "narrow until a table-level probe lands.",
    },
    {
      task_id: "dispatch_m3_filter_saturation",
      rationale_class: "essential",
      rationale_text:
        "M3 replay-observer is the canonical filter-saturation case — the detector " +
        "was authored for exactly this no-match-rate shape and is named in " +
        "concept_q2n0_XaSvphV's body.",
    },
    {
      task_id: "dispatch_m4_classifier_skew",
      rationale_class: "essential",
      rationale_text:
        "M4 tier-classifier is the canonical classifier-distribution-skew case — " +
        "the detector was authored from the 49/50 manual probe that caught the " +
        "all_stochastic vocabulary too narrow. Direct binding from concept_9L8PB5tQzc7l.",
    },
    {
      task_id: "dispatch_m6_classifier_skew",
      rationale_class: "replaceable",
      rationale_text:
        "M6 composition-depth distribution reuses the classifier-skew shape because " +
        "depth bins behave like classes; any distribution-anomaly detector with the " +
        "same JSONPath contract would substitute.",
    },
    {
      task_id: "dispatch_self_gate_placeholder",
      rationale_class: "essential",
      rationale_text:
        "Self-gate row 6: filter-saturation on concept-db emissions where literal " +
        "'{{...}}' placeholder strings survive into the content field — exactly the " +
        "bug surfaced by concept_4eNd7BFuAJK0. Reuses detect-filter-saturation; no " +
        "new shape/resolver. Operator-audit-becomes-tick (concept_Orn4yVaJYD24).",
    },
    {
      task_id: "dispatch_self_gate_surrealdb_conflicts",
      rationale_class: "replaceable",
      rationale_text:
        "Self-gate row 7: filter-saturation between concept_create_write successes " +
        "and SurrealDB transaction-conflict log lines on concept-db.service. Any " +
        "log-line positive/negative pair over the same window substitutes; this " +
        "binding catches the conflict-rate degradation surfaced by concept_D9GHCGYCt9T1.",
    },
    {
      task_id: "dispatch_self_gate_self_emission_rate",
      rationale_class: "essential",
      rationale_text:
        "Self-gate row 8: feature-flag-zero-exercise binding where the 'flag' is " +
        "container-presence (HOSTNAME, always set) and the observable is the count of " +
        "mechanismHealthFinding concepts emitted in the last hour. Zero emissions " +
        "across the hour means the detection layer itself is silent — the ultimate " +
        "watchdog. Recursive-self-detection (concept_Orn4yVaJYD24).",
    },
    {
      task_id: "emit_rollup_report",
      rationale_class: "essential",
      rationale_text:
        "The rollup memo cites all 5 mechanism concept_ids in one body so the drafter's " +
        "next concept-priming tick sees the synthesis, not just the individual " +
        "findings. This is the load-bearing concept-handover.",
    },
  ],
  authored_from_pattern: {
    pattern_id: "mechanism_health_tick_meta_pattern",
    observation_window: "2026-06-04",
    contrast_examples: 0,
  },
  cited_concept_ids: [
    "concept_q2n0_XaSvphV",
    "concept_9L8PB5tQzc7l",
    "concept_7_yVEeVfMKQV",
    "concept_-rQijiezhmMZ",
    "concept_7mzv7SQN_7JB",
    "concept_TbN0eSf7U_hM",
    "concept_vugylIHzIMvk",
    "concept_uTVZPoaxMmo2",
    "concept_YinkepAheImS",
    "concept_SDerP4GcuhGm",
    "concept_iae171XpW50_",
    // Self-gate rows (6/7/8) — empirical-evidence + meta-principle anchors
    "concept_4eNd7BFuAJK0",
    "concept_D9GHCGYCt9T1",
    "concept_Orn4yVaJYD24",
  ],
  tasks: [
    {
      id: "dispatch_m1_feature_flag",
      description:
        "Dispatch detect-feature-flag-zero-exercise for M1 (concept_vugylIHzIMvk). " +
        "Probes EMBEDDING_PRIOR_ENABLED against the context_thompson_scores table " +
        "row count where prior_seed_source='embedding_model'. Best-effort: failure " +
        "is non-fatal so other mechanisms still get sampled this tick.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick child: detect-feature-flag-zero-exercise for M1",
          targetTemplateId: "development-vessel:detect-feature-flag-zero-exercise",
          variables: {
            flag_env_var: "EMBEDDING_PRIOR_ENABLED",
            observable_sql:
              "SELECT count() FROM context_thompson_scores WHERE prior_seed_source='embedding_model' GROUP ALL",
            expected_nonzero_threshold: "0",
            mechanism_concept_id: "concept_vugylIHzIMvk",
            source: "mechanism-health-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_m2_filter_saturation",
      description:
        "Dispatch detect-filter-saturation for M2 (concept_uTVZPoaxMmo2). " +
        "Counts activity-api log lines where prior_seed_source='concept_neighbors' " +
        "(positive) vs 'fallback_uniform' (negative) over a 60-min window. The " +
        "ratio approximates the table-level signal until a dedicated table probe " +
        "lands. Best-effort dispatch.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick child: detect-filter-saturation for M2 concept-neighbors",
          targetTemplateId: "development-vessel:detect-filter-saturation",
          variables: {
            positive_event_pattern: "prior_seed_source.*concept_neighbors",
            negative_event_pattern: "prior_seed_source.*fallback_uniform",
            log_unit_name: "activity-api.service",
            time_window_minutes: "60",
            saturation_threshold: "0.9",
            min_volume: "10",
            mechanism_concept_id: "concept_uTVZPoaxMmo2",
            source: "mechanism-health-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_m3_filter_saturation",
      description:
        "Dispatch detect-filter-saturation for M3 (concept_YinkepAheImS). " +
        "Counts replay-observer 'Replay completed with replays' (positive) vs " +
        "'Replay no matches' (negative) over a 60-min window. The 100% no-match " +
        "case observed on 2026-06-03 is exactly what this detector surfaces. " +
        "Best-effort: if replay-observer.service is absent the dispatch fails " +
        "and the rollup tags M3 as 'unknown'.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick child: detect-filter-saturation for M3 replay-observer",
          targetTemplateId: "development-vessel:detect-filter-saturation",
          variables: {
            positive_event_pattern: "Replay completed with replays",
            negative_event_pattern: "Replay no matches",
            log_unit_name: "replay-observer.service",
            time_window_minutes: "60",
            saturation_threshold: "0.95",
            min_volume: "10",
            mechanism_concept_id: "concept_YinkepAheImS",
            source: "mechanism-health-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_m4_classifier_skew",
      description:
        "Dispatch detect-classifier-distribution-skew for M4 (concept_SDerP4GcuhGm). " +
        "Probes /v2/activities/recommend with task_description='any' limit=50 and " +
        "histograms selection_metadata.tier_class. The 49/50 all_stochastic case " +
        "observed on 2026-06-03 is exactly the breach this detector surfaces.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick child: detect-classifier-distribution-skew for M4 tier-classifier",
          targetTemplateId:
            "development-vessel:detect-classifier-distribution-skew",
          variables: {
            endpoint_path: "http://127.0.0.1:8080/v2/activities/recommend",
            payload_json_template:
              '{"task_description":"any","limit":50}',
            jsonpath_to_class_field:
              "$.recommendations[*].selection_metadata.tier_class",
            threshold_fraction: "0.8",
            mechanism_concept_id: "concept_SDerP4GcuhGm",
            source: "mechanism-health-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_m6_classifier_skew",
      description:
        "Dispatch detect-classifier-distribution-skew for M6 (concept_iae171XpW50_). " +
        "Histograms composition_chain length across recent activity_execution_traces. " +
        "Single-depth dominance (e.g. all chains length=1) signals that the credit-" +
        "propagation feedback loop is collapsing — the breach this detector " +
        "surfaces. M6's endpoint is the activity-api search endpoint; the JSONPath " +
        "walks the chain-length field in the response.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick child: detect-classifier-distribution-skew for M6 composition-depth",
          targetTemplateId:
            "development-vessel:detect-classifier-distribution-skew",
          variables: {
            endpoint_path:
              "http://127.0.0.1:8080/v2/activities/execution-traces?limit=200",
            payload_json_template: "{}",
            jsonpath_to_class_field: "$.traces[*].composition_chain_length",
            threshold_fraction: "0.9",
            mechanism_concept_id: "concept_iae171XpW50_",
            source: "mechanism-health-tick",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_self_gate_placeholder",
      description:
        "Self-gate row 6: dispatch detect-filter-saturation against concept-db.service " +
        "logs to surface literal '{{name_stdout}}' placeholder strings that survive " +
        "into emitted concept content (the bug concept_4eNd7BFuAJK0 documents). " +
        "Positive = 'Created concept' success log; negative = the literal " +
        "placeholder pattern. Mechanism = concept_q2n0_XaSvphV (self-gate frame).",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick self-gate: detect placeholder-interpolation leakage in concept-db emissions",
          targetTemplateId: "development-vessel:detect-filter-saturation",
          variables: {
            positive_event_pattern: "Created concept",
            negative_event_pattern: "\\{\\{[a-zA-Z_]+_stdout\\}\\}",
            log_unit_name: "concept-db.service",
            time_window_minutes: "60",
            saturation_threshold: "0.5",
            min_volume: "1",
            mechanism_concept_id: "concept_q2n0_XaSvphV",
            source: "mechanism-health-tick-self-gate",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_self_gate_surrealdb_conflicts",
      description:
        "Self-gate row 7: dispatch detect-filter-saturation against concept-db.service " +
        "logs to surface SurrealDB transaction-conflict rate. Positive = successful " +
        "concept_create_write or 'Created concept'; negative = 'failed transaction' / " +
        "'read or write conflict'. Threshold 10% conflicts is concerning. " +
        "Mechanism = concept_q2n0_XaSvphV.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick self-gate: detect SurrealDB transaction-conflict saturation",
          targetTemplateId: "development-vessel:detect-filter-saturation",
          variables: {
            positive_event_pattern: "concept_create_write|Created concept",
            negative_event_pattern: "failed transaction|read or write conflict",
            log_unit_name: "concept-db.service",
            time_window_minutes: "60",
            saturation_threshold: "0.1",
            min_volume: "10",
            mechanism_concept_id: "concept_q2n0_XaSvphV",
            source: "mechanism-health-tick-self-gate",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "dispatch_self_gate_self_emission_rate",
      description:
        "Self-gate row 8: dispatch detect-feature-flag-zero-exercise where the 'flag' " +
        "is HOSTNAME (always set inside the substrate container — no dedicated " +
        "MECHANISM_HEALTH_TICK_ENABLED env exists, so we use container-presence as " +
        "the always-true equivalent). Observable = mechanismHealthFinding emissions " +
        "in the last hour. Zero in 1h means the detection layer itself is silent — " +
        "the ultimate watchdog. Mechanism = concept_q2n0_XaSvphV.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: RUN_GOAL_URL,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:
            "mechanism-health-tick self-gate: detect zero mechanismHealthFinding emission rate",
          targetTemplateId: "development-vessel:detect-feature-flag-zero-exercise",
          variables: {
            flag_env_var: "HOSTNAME",
            observable_sql:
              "SELECT count() FROM concept WHERE shape = \"mechanismHealthFinding\" AND created_at > time::now() - 1h GROUP ALL",
            expected_nonzero_threshold: "0",
            mechanism_concept_id: "concept_q2n0_XaSvphV",
            source: "mechanism-health-tick-self-gate",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["mechanismHealthFinding"],
    },
    {
      id: "emit_rollup_report",
      description:
        "Emit a single substrateHealthReport-shape memo via concept_create_write " +
        "summarizing per-mechanism status. Cites all 5 mechanism concept_ids + " +
        "the 3 detector concept_ids + the discipline concept so the drafter's " +
        "next concept-priming tick sees the synthesis. Discipline " +
        "(concept_7mzv7SQN_7JB) — no new shape: substrateHealthReport is the " +
        "existing aggregator-emission shape reused, not a schema addition.",
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
              shape: "substrateHealthReport",
              source_type: "memo",
              summary:
                "mechanism-health-tick rollup across M1/M2/M3/M4/M6; see content " +
                "for per-mechanism dispatch results and citations.",
              content:
                "Aggregator: mechanism-health-tick (concept_q2n0_XaSvphV). " +
                "Cited mechanism concepts: M1=concept_vugylIHzIMvk, " +
                "M2=concept_uTVZPoaxMmo2, M3=concept_YinkepAheImS, " +
                "M4=concept_SDerP4GcuhGm, M6=concept_iae171XpW50_. " +
                "Cited detectors: concept_9L8PB5tQzc7l (skew), " +
                "concept_7_yVEeVfMKQV (flag-zero), concept_-rQijiezhmMZ (saturation). " +
                "Discipline: concept_7mzv7SQN_7JB. " +
                "Self-gate empirical anchors: concept_4eNd7BFuAJK0 (placeholder " +
                "leakage finding), concept_D9GHCGYCt9T1 (second-run evidence), " +
                "concept_Orn4yVaJYD24 (operator-audit-becomes-tick meta-principle). " +
                "M1 dispatch: {{dispatch_m1_feature_flag_content}}. " +
                "M2 dispatch: {{dispatch_m2_filter_saturation_content}}. " +
                "M3 dispatch: {{dispatch_m3_filter_saturation_content}}. " +
                "M4 dispatch: {{dispatch_m4_classifier_skew_content}}. " +
                "M6 dispatch: {{dispatch_m6_classifier_skew_content}}. " +
                "Self-gate row 6 (placeholder leakage): " +
                "{{dispatch_self_gate_placeholder_content}}. " +
                "Self-gate row 7 (SurrealDB conflicts): " +
                "{{dispatch_self_gate_surrealdb_conflicts_content}}. " +
                "Self-gate row 8 (self-emission rate): " +
                "{{dispatch_self_gate_self_emission_rate_content}}.",
              priority: 0.6,
              budget: 2000,
              pointer: {
                type: "memo",
                path: "/workspace/mechanism-health/findings/rollup.json",
                section: "mechanism_health_tick_rollup",
              },
            },
          },
        }),
        timeoutMs: 5000,
      },
      outputShapes: ["substrateHealthReport"],
    },
  ],
};
