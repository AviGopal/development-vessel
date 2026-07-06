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
  const obsidianEndpoint = (p.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
  const devVesselImpulsesUrl = p.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const pxFloor = p.px_floor ?? 12;
  const maxChips = p.max_chips_per_row ?? 12;
  const emitGap = p.emit_gap !== false;

  const resolveObsidian = async (pointer: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      const resp = await fetch(`${obsidianEndpoint}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return null;
      return (await resp.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const uiViewResp = await resolveObsidian({ type: "obsidian:ui_view" });
  const uiViewContent = typeof uiViewResp?.content === "string" ? uiViewResp.content : null;
  if (!uiViewContent) {
    return {
      shape: "uiLegibilityReport",
      body: { available: false, reason: "obsidian-vessel unreachable or ui_view empty", completed_at: new Date().toISOString() },
    };
  }
  let uiView: Record<string, unknown> = {};
  try { uiView = JSON.parse(uiViewContent) as Record<string, unknown>; } catch { /* keep empty */ }
  const gd = (uiView.goal_dispatch ?? {}) as Record<string, unknown>;
  if (gd.open !== true) {
    return {
      shape: "uiLegibilityReport",
      body: { available: true, panel_open: false, rules_checked: 0, violations: [], gaps_emitted: 0, information_yield: "idle", completed_at: new Date().toISOString() },
    };
  }

  const violations: UiLegibilityViolation[] = [];

  // R1 px floor over effective --sub-font-* tokens
  const tokens = (gd.effective_tokens ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith("--sub-font-")) continue;
    const m = /^([\d.]+)px$/.exec(value.trim());
    if (m && parseFloat(m[1]!) < pxFloor) {
      violations.push({ rule: "px_floor", region: key, kind: "hard_to_see", detail: `${key} is ${value}, below the ${pxFloor}px floor` });
    }
  }

  // R2 color overrides in Substrate/theme-tokens.md must use theme vars, not raw hex
  const noteResp = await resolveObsidian({ type: "obsidian:note", path: "Substrate/theme-tokens.md" });
  const noteText = typeof noteResp?.content === "string" ? noteResp.content : "";
  const overrideRe = /^\s*(--sub-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;?\s*$/gm;
  let om: RegExpExecArray | null;
  while ((om = overrideRe.exec(noteText)) !== null) {
    const key = om[1]!;
    if (key.startsWith("--sub-font-") || key.startsWith("--sub-space-") || key.startsWith("--sub-radius-")) continue;
    violations.push({ rule: "hex_color_override", region: key, kind: "hard_to_see", detail: `${key} overridden with raw hex ${om[2]!} — use var(--…) theme variables so light/dark themes keep contrast` });
  }

  // R3 chip density
  const counts = (gd.component_counts ?? {}) as Record<string, number>;
  const maxRow = typeof counts.max_chips_per_row === "number" ? counts.max_chips_per_row : 0;
  if (maxRow > maxChips) {
    violations.push({ rule: "chip_density", region: "sub-fleet-chips", kind: "cramped", detail: `${maxRow} chips in one row exceeds the ${maxChips}-chip threshold` });
  }

  // File uiFeedback-keyed gaps — same funnel as human right-click complaints.
  let gapsEmitted = 0;
  if (emitGap) {
    for (const v of violations) {
      const slug = v.region.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      try {
        const resp = await fetch(devVesselImpulsesUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            impulse: {
              pointer: {
                type: "substrateGap_write",
                gap: {
                  id: `ui-feedback-${slug}-${v.kind}`,
                  category: "ui_legibility",
                  source: "substrate_detected",
                  summary: `UI legibility violation (${v.rule}) on ${v.region}: ${v.detail}`,
                  detected_at: new Date().toISOString(),
                  status: "open",
                  classification_metadata: { surface: "panel", region: v.region, kind: v.kind, rule: v.rule, detail: v.detail },
                },
              },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) gapsEmitted++;
      } catch { /* fail-soft per gap */ }
    }
  }

  return {
    shape: "uiLegibilityReport",
    body: {
      available: true,
      panel_open: true,
      rules_checked: 3,
      violations,
      gaps_emitted: gapsEmitted,
      information_yield: violations.length > 0 ? "productive" : "idle",
      completed_at: new Date().toISOString(),
    },
  };
}
