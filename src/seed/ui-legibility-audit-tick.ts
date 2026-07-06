import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * ui-legibility-audit-tick — periodic detector that audits the
 * obsidian-vessel goal-dispatch panel's CURRENT effective design tokens and
 * component density against computable legibility rules (px floor >= 12,
 * color overrides via theme vars not hex, chips-per-row <= threshold),
 * filing uiFeedback-keyed substrateGaps (`ui-feedback-<region>-<kind>`)
 * when violated.
 *
 * Same funnel as human complaints: the plugin's right-click affordances and
 * ui_feedback frontmatter key file gaps with the identical keying, so
 * substrate-detected and human-reported legibility problems converge on one
 * drain. Deterministic (no LLM).
 */

export const UI_LEGIBILITY_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ui-legibility-audit-tick",
  name: "ui-legibility-audit-tick",
  description:
    "Reads the obsidian-vessel panel's effective --sub-* design tokens and " +
    "component counts (obsidian:ui_view) plus the Substrate/theme-tokens.md " +
    "override note, checks computable legibility rules — font px floor >= 12 " +
    "(hard_to_see), color overrides must use theme vars not raw hex " +
    "(hard_to_see), chips-per-row <= 12 (cramped) — and files " +
    "uiFeedback-keyed substrateGaps for violations. Deterministic, no LLM. " +
    "No-ops gracefully when the panel is closed or the vessel is unreachable.",
  inputShapes: [],
  outputShapes: ["uiLegibilityReport", "substrateGap"],
  tags: [
    "obsidian-vessel",
    "detection",
    "ui-legibility",
    "substrate.self.detection",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_ui_legibility",
      description:
        "Run ui_legibility_scan: fetch effective tokens + component counts from " +
        "the obsidian-vessel panel, evaluate the px-floor / theme-var / " +
        "chip-density rules, and emit a uiFeedback-keyed substrateGap per violation.",
      resolver: "ui_legibility_scan",
      config: {
        type: "ui_legibility_scan",
        px_floor: 12,
        max_chips_per_row: 12,
        emit_gap: true,
      },
      outputShapes: ["uiLegibilityReport"],
    },
  ],
};
