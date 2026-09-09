import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const GATE_SELF_PROBE_TICK_TEMPLATE: ActivityTemplate = {
  id: 'development-vessel:gate-self-probe-tick',
  name: 'gate-self-probe-tick',
  description:
    "Deterministic single-resolver wrapper around gate_self_probe. Runs the known-answer gate probe corpus (hostile fixtures must be refused with citations, benign controls must pass) and emits gateSelfProbe so gate regressions are detected on the autonomous rotation.",
  inputShapes: [],
  outputShapes: ["gateSelfProbe"],
  tags: [
    "intent:horizon_detection",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
  ],
  variables: [],
  tasks: [
    {
      id: "run_gate_self_probe",
      description:
        "Invoke gate_self_probe: run every probe case through the real exported gate functions and report pass/fail per rule.",
      resolver: "gate_self_probe",
      config: { type: "gate_self_probe" },
      outputShapes: ["gateSelfProbe"],
    },
  ],
};