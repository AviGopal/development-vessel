import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * template-promote-tick — autonomous template promotion / retirement.
 *
 * Companion to template-mitosis-tick (which mints new variants). This
 * loop's job is the back-half of the substrate-managed lifecycle:
 * when a family has accumulated enough Thompson data to declare a
 * dominant variant, promote the winner and deprecate the losers via
 * variant_promote. activity-api's evidence gate (validateEvidenceGate)
 * admits the write-scope calls when:
 *   - loser_samples >= MIN_SAMPLES (default 10)
 *   - winner_mean - loser_mean >= MIN_DELTA (default 0.15)
 *
 * Architectural shape parallel to vessel-mitosis-cutover: a substrate
 * decision gated on evidence the substrate itself produced. The operator's
 * prior admin-scope gate is replaced by the substrate's own posteriors.
 *
 * Chain:
 *   1. audit             templateAuditReport (full family rankings)
 *   2. extract_winner    json_path_extract → strongest_families[0].winner_id
 *   3. extract_loser     json_path_extract → strongest_families[0].loser_id
 *   4. extract_evidence  json_path_extract → posterior_evidence object
 *   5. promote           variant_promote (gated by evidence)
 *
 * Tasks 2-4 may return missing-sentinel when audit emits no promotion
 * candidates; variant_promote rejects fast with structuredError in that
 * case, and the boredom loop moves on to other goals.
 */

export const TEMPLATE_PROMOTE_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:template-promote-tick",
  name: "template-promote-tick",
  description:
    "Autonomous template promotion: scans the activity catalogue for families with a " +
    "dominant variant (loser_samples >= 10, posterior delta >= 0.15) and issues " +
    "variant_promote — activityTemplate_update on the winner + activityTemplate_deprecate " +
    "on each loser, both with Thompson evidence so activity-api's evidence gate admits " +
    "the write-scope call. Substrate-managed template lifecycle (no operator gate).",
  inputShapes: [],
  outputShapes: ["variantPromoteResult", "templateAuditReport", "structuredError"],
  tags: [
    "intent:template_promotion",
    "phase:author",
    "lift.autonomous.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "audit",
      description:
        "Scan templates and rank by Thompson posterior; the audit report includes " +
        "strongest_families when promotion candidates exist (winner_alpha+winner_beta-2 >= 10 " +
        "samples for losers, posterior-mean delta >= threshold).",
      resolver: "template_audit_report",
      config: {
        type: "template_audit_report",
        limit: 500,
        weakThreshold: 0.3,
        minSamples: 10,
        emitCap: 20,
        includePromotionCandidates: true,
      },
      outputShapes: ["templateAuditReport"],
    },
    {
      id: "extract_winner",
      description:
        "Pull strongest_families[0].winner_id from the audit. When no promotion candidate " +
        "exists, returns the missing-value sentinel which propagates into variant_promote " +
        "as a validation_rejected outcome (no-op for the cycle).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{audit_content}}",
        path: "strongest_families.0.winner_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_loser",
      description:
        "Pull strongest_families[0].loser_id from the audit. Single-loser path; multi-loser " +
        "promotion will compose at a later phase.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{audit_content}}",
        path: "strongest_families.0.loser_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_evidence",
      description:
        "Pull strongest_families[0].evidence (winner/loser alpha+beta+samples). The " +
        "downstream variant_promote forwards this verbatim to activity-api so the " +
        "evidence gate has the raw posteriors to verify.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{audit_content}}",
        path: "strongest_families.0.evidence",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "promote",
      description:
        "Issue variant_promote: activityTemplate_update (winner) + activityTemplate_deprecate " +
        "(loser). Both calls carry the Thompson evidence so activity-api's evidence gate " +
        "(validateEvidenceGate) admits them under write-scope. Returns variantPromoteResult " +
        "with the substrate's lifecycle decision recorded for audit.",
      resolver: "variant_promote",
      config: {
        type: "variant_promote",
        family_id: "{{audit_content.strongest_families.0.family_id}}",
        winner_variant_id: "{{extract_winner_content}}",
        loser_variant_ids: ["{{extract_loser_content}}"],
        evidence: "{{extract_evidence_content}}",
      },
      outputShapes: ["variantPromoteResult", "structuredError"],
    },
  ],
};
