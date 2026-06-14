import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-gate-saturation — deterministic detector for gate/filter resolvers
 * that return the same verdict for ~all inputs.
 *
 * Meta-detector authored 2026-06-13 after the operator had to hand-fix exactly
 * this class: comprehensibility_check scored 0.000 on EVERY authored chain (its
 * 0.6 Jaccard floor was unreachable + it indexed a raw string as an object),
 * silently rejecting 100% of inputs. A gate that never passes anything is
 * broken, not strict — yet nothing watched the gate's own pass-rate. This makes
 * the class substrate-detectable: consume resolver_pattern_report and emit a
 * substrateGap per gate-like resolver whose success_rate is at/below the floor
 * over enough samples, routing the fix into the gap → bridge → drafter loop.
 *
 * Single-task template (mirrors detect-stale-pointer): the resolver does the
 * whole report → filter → emit flow; no LLM.
 */
export const DETECT_GATE_SATURATION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-gate-saturation",
  name: "detect-gate-saturation",
  description:
    "Detects gate/filter resolvers saturated at a single verdict. Consumes " +
    "resolver_pattern_report (per-(resolver_id, output_shape) success_rate over " +
    "a window); flags any gate-like resolver (id matching check/gate/valid/verify/" +
    "comprehensib/filter/guard) whose success_rate ≤ min_pass_rate over ≥ " +
    "min_volume samples. Emits one substrateGap per saturated cell with " +
    "classification_metadata.gap_subtype='gate_saturation'. Catches the class " +
    "that made comprehensibility_check reject 100% of authored chains.",
  inputShapes: [],
  outputShapes: ["substrateGap", "gateSaturationReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "mechanism.health.tick",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the gate-saturation scan + gap-emission in one server-side step. " +
        "Returns a gateSaturationReport with gate_cells_evaluated/finding_count " +
        "and the per-cell findings (resolver_id, output_shape, success_rate, count).",
      resolver: "gate_saturation_scan",
      config: {
        type: "gate_saturation_scan",
        minPassRate: 0.05,
        minVolume: 8,
        dry_run: false,
        maxEmits: 25,
      },
      outputShapes: ["gateSaturationReport"],
    },
  ],
};
