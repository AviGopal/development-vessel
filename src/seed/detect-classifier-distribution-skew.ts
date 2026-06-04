import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-classifier-distribution-skew — generic distribution-anomaly detector.
 *
 * Substrate anchor: concept_9L8PB5tQzc7l (detect_classifier_distribution_skew,
 * impulse_activity_pattern). Parent: concept_TbN0eSf7U_hM
 * (learning_rate_improvement_mechanisms). Discipline: concept_7mzv7SQN_7JB
 * (no new shapes, no new resolver kinds, no new tiers, no new vocabulary).
 *
 * Operator-side analog: the manual /v2/activities/recommend top-50 query that
 * caught M4's tier-classifier vocabulary being too narrow (49/50 misclassified
 * as all_stochastic). Without per-mechanism telemetry the bug was invisible;
 * the distribution query made it obvious. Encoding the query as a substrate
 * activity makes that detection autonomous.
 *
 * Generic — takes endpoint_path, payload_json_template, jsonpath_to_class_field,
 * threshold_fraction, and mechanism_concept_id as variables. Emits a
 * mechanismHealthFinding memo via concept_create_write when any single class
 * in the response exceeds the threshold fraction of the total. Reusable
 * across M4 tier-classifier (concept_SDerP4GcuhGm), M6 composition depth
 * (concept_iae171XpW50_), and any future selector/router.
 */

export const DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-classifier-distribution-skew",
  name: "detect-classifier-distribution-skew",
  description:
    "Generic distribution-anomaly detector cited from substrate concept " +
    "concept_9L8PB5tQzc7l (detect_classifier_distribution_skew). Queries a " +
    "classifier/selector/router endpoint, extracts the class field from each " +
    "result, computes the histogram, and emits a mechanismHealthFinding memo " +
    "via concept_create_write when any single class exceeds threshold_fraction " +
    "of the total. Reusable across M4 tier-classifier (concept_SDerP4GcuhGm), " +
    "M6 composition depth (concept_iae171XpW50_), and any future selector. " +
    "Meta-pattern catches the bug class operators caught by hand on 2026-06-03.",
  inputShapes: [],
  outputShapes: ["mechanismHealthFinding"],
  tags: [
    "mechanism.health.tick",
    "substrate.self.detection",
    "lift.autonomous.loop",
  ],
  variables: [
    {
      name: "endpoint_path",
      description:
        "Full URL of the classifier/selector endpoint to probe " +
        "(e.g. http://127.0.0.1:8080/v2/activities/recommend).",
    },
    {
      name: "payload_json_template",
      description:
        "JSON request body to POST to endpoint_path. Pass an empty object {} for " +
        "endpoints that accept GET-style probes via POST.",
    },
    {
      name: "jsonpath_to_class_field",
      description:
        "JSONPath into the response that yields the array of class values to " +
        "histogram (e.g. $.recommendations[*].selection_metadata.tier_class).",
    },
    {
      name: "threshold_fraction",
      description:
        "Single-class dominance threshold in [0,1]; finding emits when max " +
        "fraction > threshold (default 0.8).",
    },
    {
      name: "mechanism_concept_id",
      description:
        "Concept id of the mechanism this probe monitors (cited in the emitted " +
        "finding for provenance, e.g. concept_SDerP4GcuhGm for M4).",
    },
  ],
  tasks: [
    {
      id: "probe_endpoint",
      description:
        "POST payload_json_template to endpoint_path and capture the JSON response. " +
        "Bounded timeout (10s) protects the boredom tick from hanging on a stuck endpoint.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{endpoint_path}}",
        headers: { "Content-Type": "application/json" },
        body: "{{payload_json_template}}",
        timeoutMs: 10000,
      },
      outputShapes: ["classifierProbeResponse"],
    },
    {
      id: "extract_class_array",
      description:
        "Pull the class-field array out of the response via the operator-provided " +
        "JSONPath. Deterministic — no LLM involvement. Feeds the histogram step.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{probe_endpoint_content}}",
        path: "{{jsonpath_to_class_field}}",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "compute_histogram",
      description:
        "Compute the per-class histogram and the dominant-class fraction using " +
        "python3 stdlib (collections.Counter). Emits JSON { total, counts, " +
        "max_class, max_count, max_fraction } onto stdout for the next stages. " +
        "Goal-host's bash resolver requires command as string[] — the [\"bash\",\"-c\",<script>] " +
        "form mirrors forge-vessel-for-shape.json (the canonical working idiom in " +
        "ias-executor-ts shared templates).",
      resolver: "bash",
      config: {
        type: "bash",
        command: [
          "bash",
          "-c",
          "python3 -c \"import json,sys,collections; " +
            "v=json.loads(sys.argv[1] or '[]'); " +
            "v=[str(x) for x in (v if isinstance(v,list) else [v])]; " +
            "c=collections.Counter(v); " +
            "t=sum(c.values()) or 1; " +
            "mc,mn=(c.most_common(1)[0] if c else ('',0)); " +
            "print(json.dumps({'total':t,'counts':dict(c),'max_class':mc,'max_count':mn," +
            "'max_fraction':mn/t}))\" '{{extract_class_array_valueJson}}'",
        ],
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "evaluate_skew",
      description:
        "Compute skew_breach = (max_fraction > threshold_fraction) as a boolean string " +
        "the downstream conditional emission step keys on. Stays in python3 stdlib so the " +
        "tick has no extra dependencies. Same [\"bash\",\"-c\",<script>] form as " +
        "compute_histogram — goal-host's bash resolver rejects string commands.",
      resolver: "bash",
      config: {
        type: "bash",
        command: [
          "bash",
          "-c",
          "python3 -c \"import json,sys; " +
            "h=json.loads(sys.argv[1] or '{}'); " +
            "thr=float(sys.argv[2] or '0.8'); " +
            "frac=float(h.get('max_fraction',0)); " +
            "print(json.dumps({'skew_breach': frac>thr, 'max_fraction':frac, 'max_class':h.get('max_class',''), 'counts':h.get('counts',{}), 'total':h.get('total',0), 'threshold':thr}))\" " +
            "'{{compute_histogram_stdout}}' '{{threshold_fraction}}'",
        ],
      },
      outputShapes: ["shellResult"],
    },
    {
      id: "emit_finding_if_skewed",
      description:
        "POST a concept_create_write to concept-db with the mechanismHealthFinding when " +
        "skew_breach=true. The emitted memo cites mechanism_concept_id and the parent " +
        "concept_9L8PB5tQzc7l so the drafter's concept-priming surface sees both the " +
        "instance and the generic pattern on next tick. NOTE: this fires unconditionally " +
        "at the resolver level; the body carries the skew_breach flag so downstream " +
        "consumers can filter no-op runs. Discipline (concept_7mzv7SQN_7JB) — no new " +
        "shape: mechanismHealthFinding is just source_type=memo with a specific summary " +
        "pattern, not a schema-level shape.",
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
                "classifier_distribution_skew probe for mechanism " +
                "{{mechanism_concept_id}}; see content for histogram and breach status.",
              content:
                "Detector: detect-classifier-distribution-skew " +
                "(concept_9L8PB5tQzc7l). Mechanism: {{mechanism_concept_id}}. " +
                "Endpoint: {{endpoint_path}}. JSONPath: {{jsonpath_to_class_field}}. " +
                "Threshold: {{threshold_fraction}}. Evaluation: {{evaluate_skew_stdout}}.",
              priority: 0.5,
              budget: 2000,
              pointer: {
                type: "memo",
                path: "/workspace/mechanism-health/findings/classifier-skew.json",
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
