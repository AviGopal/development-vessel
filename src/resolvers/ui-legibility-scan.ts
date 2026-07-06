/**
 * ui_legibility_scan — periodic legibility audit of the obsidian-vessel
 * goal-dispatch panel (Phase 2 of the UI workstream).
 *
 * The obsidian-vessel panel is token-first (0.4.0): every surface consumes
 * --sub-* design tokens, runtime-overridable via the vault note
 * Substrate/theme-tokens.md. This detector reads the panel's CURRENT
 * effective state through the vessel's own read shapes and checks
 * computable legibility rules, filing uiFeedback-keyed substrateGaps when
 * violated — the same gap keying (`ui-feedback-<region>-<kind>`) the human
 * complaint affordances use, so substrate-detected and human-reported
 * legibility problems drain through one funnel.
 *
 * Reads (both via obsidian-vessel POST {obsidianEndpoint}/resolve):
 *   1. obsidian:ui_view → goal_dispatch.effective_tokens (computed --sub-*
 *      values incl. any theme-token overrides) + component_counts
 *      {cards, chips, feed_lines, max_chips_per_row}.
 *   2. obsidian:note path=Substrate/theme-tokens.md → override note text
 *      (raw values as authored, before the browser computes them).
 *
 * Rules (computable, no LLM):
 *   R1 px floor — every effective --sub-font-* value must be >= px_floor
 *      (default 12). Violation kind: hard_to_see.
 *   R2 theme-var colors — color-token overrides in theme-tokens.md must
 *      reference theme variables (var(--…)), not raw hex, so light/dark
 *      themes keep contrast. Violation kind: hard_to_see.
 *   R3 chip density — component_counts.max_chips_per_row must be <=
 *      max_chips_per_row (default 12). Violation kind: cramped.
 *
 * Gap contract: POST {devVesselImpulsesUrl} substrateGap_write with
 * id `ui-feedback-<token-or-region-slug>-<kind>`, category ui_legibility,
 * source substrate_detected, status open.
 */

import type { ResolverResult } from "./types.js";

const DEFAULT_OBSIDIAN_ENDPOINT = "http://127.0.0.1:27182";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface UiLegibilityScanPointer {
  type: "ui_legibility_scan";
  /** obsidian-vessel plugin HTTP server base. Default :27182. */
  obsidianEndpoint?: string;
  /** dev-vessel impulses url for substrateGap_write. Default :8090. */
  devVesselImpulsesUrl?: string;
  /** Minimum effective font-size in px for --sub-font-* tokens. Default 12. */
  px_floor?: number;
  /** Maximum chips per row before the panel counts as cramped. Default 12. */
  max_chips_per_row?: number;
  /** Emit substrateGap_write for violations. Default true. */
  emit_gap?: boolean;
}

export interface UiLegibilityViolation {
  rule: "px_floor" | "hex_color_override" | "chip_density";
  region: string;
  kind: "hard_to_see" | "cramped";
  detail: string;
}

/**
 * STUB — scan logic is authored by the substrate (feature_compose).
 * Contract: fetch ui_view + theme-tokens note, evaluate R1–R3, emit gaps
 * for violations when emit_gap, and return shape "uiLegibilityReport" with
 * body { available, panel_open, rules_checked, violations, gaps_emitted,
 * information_yield, completed_at }.
 */
export async function resolveUiLegibilityScan(
  p: UiLegibilityScanPointer,
): Promise<ResolverResult> {
  const obsidianEndpoint = p.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT;
  const devVesselImpulsesUrl = p.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  void obsidianEndpoint;
  void devVesselImpulsesUrl;
  return {
    shape: "uiLegibilityReport",
    body: {
      available: false,
      reason: "not_implemented",
      completed_at: new Date().toISOString(),
    },
  };
}
