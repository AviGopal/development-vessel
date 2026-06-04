import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-feature-flag-zero-exercise — generic provenance-gap detector.
 *
 * Substrate anchor: concept_7_yVEeVfMKQV (detect_feature_flag_zero_exercise,
 * impulse_activity_pattern). Parent: concept_TbN0eSf7U_hM
 * (learning_rate_improvement_mechanisms). Discipline: concept_7mzv7SQN_7JB
 * (no new shapes, no new resolver kinds, no new tiers, no new vocabulary).
 *
 * Operator-side analog: the manual `SELECT count() WHERE
 * prior_seed_source='embedding_model'` query that would reveal M1 dormant
 * despite EMBEDDING_PRIOR_ENABLED=true. Today M1's flag default is false
 * so it doesn't fire spuriously; this detector becomes load-bearing once
 * M1 is enabled to verify the call-site embedding lookup actually reached
 * the hook.
 *
 * Generic — takes flag_env_var, observable_sql, expected_nonzero_threshold,
 * and mechanism_concept_id as variables. Activates only when the flag is
 * true; if the observable then shows count <= expected_nonzero_threshold,
 * emits a wiring-gap mechanismHealthFinding memo via concept_create_write.
 * Catches the "shipped but not wired" failure class.
 */

export const DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-feature-flag-zero-exercise",
  name: "detect-feature-flag-zero-exercise",
  description:
    "Generic provenance-gap detector cited from substrate concept " +
    "concept_7_yVEeVfMKQV (detect_feature_flag_zero_exercise). Reads a feature " +
    "flag from the substrate process environment; when the flag is truthy, " +
    "runs observable_sql against SurrealDB and counts the rows. If the count " +
    "stays at or below expected_nonzero_threshold over the tick window, emits " +
    "a mechanismHealthFinding wiring-gap memo via concept_create_write citing " +
    "mechanism_concept_id. Reusable across M1 EMBEDDING_PRIOR_ENABLED " +
    "(concept_vugylIHzIMvk) and any future feature toggle. Catches the " +
    "shipped-but-not-wired failure class.",
  inputShapes: [],
  outputShapes: ["mechanismHealthFinding"],
  tags: [
    "mechanism.health.tick",
    "substrate.self.detection",
    "lift.autonomous.loop",
  ],
  variables: [
    {
      name: "flag_env_var",
      description:
        "Name of the environment variable holding the feature flag " +
        "(e.g. EMBEDDING_PRIOR_ENABLED).",
    },
    {
      name: "observable_sql",
      description:
        "SurrealQL query whose row count is the wiring observable " +
        "(e.g. SELECT count() FROM context_thompson_scores WHERE " +
        "prior_seed_source='embedding_model' GROUP ALL).",
    },
    {
      name: "expected_nonzero_threshold",
      description:
        "Integer threshold; count <= threshold counts as 'zero exercise' " +
        "and triggers a wiring-gap finding (default 0).",
    },
    {
      name: "mechanism_concept_id",
      description:
        "Concept id of the mechanism this probe monitors (e.g. concept_vugylIHzIMvk " +
        "for M1). Cited in the emitted finding for provenance.",
    },
  ],
  tasks: [
    {
      id: "read_flag",
      description:
        "Read the feature flag from the substrate process environment via printenv. " +
        "All units run inside substrate-live so the env is the canonical source. " +
        "Outputs a single line: the flag's raw string value (empty if unset).",
      resolver: "bash",
      config: {
        type: "bash",
        command: "printenv {{flag_env_var}} || true",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "query_observable",
      description:
        "Run observable_sql against the in-container SurrealDB SQL endpoint " +
        "(http://localhost:8000/sql). Credentials are pulled from the substrate " +
        "env (SURREALDB_USER / SURREALDB_PASS); namespace/database headers are " +
        "the standard activity-system / learning_loop pair. Outputs the raw JSON " +
        "array SurrealDB returns; downstream tasks extract the count.",
      resolver: "bash",
      config: {
        type: "bash",
        command:
          "curl -sS -X POST http://localhost:8000/sql " +
          "-H 'surreal-ns: activity-system' -H 'surreal-db: learning_loop' " +
          "-H 'Accept: application/json' -H 'Content-Type: text/plain' " +
          "-u \"$SURREALDB_USER:$SURREALDB_PASS\" " +
          "--data-raw {{observable_sql}}",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "extract_count",
      description:
        "Pull the count number out of SurrealDB's [{result:[{count:N}]}] response shape. " +
        "JSONPath into result[0].result[0].count is the standard SurrealQL count-shape; " +
        "missing rows yield 0 which the conditional emission step interprets as " +
        "zero-exercise.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{query_observable_stdout}}",
        path: "[0].result[0].count",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "evaluate_wiring_gap",
      description:
        "Compute wiring_gap = (flag truthy AND count <= expected_nonzero_threshold). " +
        "Truthy values mirror posix-shell semantics: 'true', '1', 'yes', 'on' " +
        "(case-insensitive). Emits the verdict + cited_evidence as JSON for the " +
        "downstream concept_create_write step. python3 stdlib — no extra deps.",
      resolver: "bash",
      config: {
        type: "bash",
        command:
          "python3 -c \"import json,sys; " +
          "flag=(sys.argv[1] or '').strip().lower() in ('1','true','yes','on'); " +
          "try:\\n c=int(sys.argv[2] or '0')\\nexcept Exception:\\n c=0\\n" +
          "thr=int(sys.argv[3] or '0'); " +
          "print(json.dumps({'flag': flag, 'count': c, 'threshold': thr, " +
          "'wiring_gap': flag and c<=thr}))\" " +
          "'{{read_flag_stdout}}' '{{extract_count_valueJson}}' '{{expected_nonzero_threshold}}'",
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "emit_finding_if_wiring_gap",
      description:
        "Emit a mechanismHealthFinding memo via concept_create_write. The body " +
        "carries the wiring_gap boolean so consumers can filter no-op runs. " +
        "Discipline (concept_7mzv7SQN_7JB) — no new shape: mechanismHealthFinding " +
        "is source_type=memo with a specific summary pattern, not a schema shape. " +
        "Cites both the mechanism's concept_id and the parent concept_7_yVEeVfMKQV.",
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
                "feature_flag_zero_exercise probe for mechanism " +
                "{{mechanism_concept_id}}; see content for flag value and count.",
              content:
                "Detector: detect-feature-flag-zero-exercise " +
                "(concept_7_yVEeVfMKQV). Mechanism: {{mechanism_concept_id}}. " +
                "Flag env var: {{flag_env_var}}. Observable SQL: {{observable_sql}}. " +
                "Threshold: {{expected_nonzero_threshold}}. Evaluation: {{evaluate_wiring_gap_stdout}}.",
              priority: 0.5,
              budget: 2000,
              pointer: {
                type: "memo",
                path: "/workspace/mechanism-health/findings/feature-flag-zero-exercise.json",
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
