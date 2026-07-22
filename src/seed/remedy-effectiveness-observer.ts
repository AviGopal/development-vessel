import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * remedy-effectiveness-observer — single-task tick template wrapping the
 * `remedy_effectiveness_observer` resolver (law-6 class-detector, 2026-07-22).
 *
 * Reads the gap-drain-observer's drain log
 * (`WORKSPACE_ROOT/pool/drain-log.jsonl`), groups `action:"dispatched"` lines
 * by gap_id inside a lookback window, and emits a `substrateGap`
 * (category `remedy_livelock`, route `dispatchable`) for any gap re-dispatched
 * >= min_dispatches whose target metric did not provably move — closing the
 * blind spot where a remedy dispatches green (goal-host 202 ACK) but its
 * downstream execution aborts and the loop silently re-dispatches it forever
 * (the trace-store-reconcile 7-day livelock).
 *
 * Model: trace-store-health-observer.ts (single deterministic resolver task,
 * no LLM).
 */
export const REMEDY_EFFECTIVENESS_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:remedy-effectiveness-observer",
  name: "remedy-effectiveness-observer",
  description:
    "Reads the gap-drain drain log, groups dispatched gaps by gap_id, and emits a " +
    "substrateGap(category=remedy_livelock) when a remedy has been re-dispatched " +
    "min_dispatches+ times without moving its target metric — detecting remedies " +
    "that dispatch green but whose downstream execution aborts. Deduped by an " +
    "hour/day-bucketed id; escalates instead of silently re-dispatching.",
  inputShapes: [],
  outputShapes: ["substrateGap", "remedyEffectivenessReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self-management",
    "law6.class-detector",
    "gap.remedy-livelock",
  ],
  variables: [],
  tasks: [
    {
      id: "observe",
      description:
        "Scan the drain log for gaps re-dispatched without target-metric movement " +
        "and emit a remedy_livelock substrateGap on each livelock. Returns a " +
        "remedyEffectivenessReport.",
      resolver: "remedy_effectiveness_observer",
      config: {
        type: "remedy_effectiveness_observer",
      },
      outputShapes: ["remedyEffectivenessReport"],
    },
  ],
};
