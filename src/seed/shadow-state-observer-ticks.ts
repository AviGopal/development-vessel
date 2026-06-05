import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * Shadow-state observer ticks (Part B, 2026-06-05). Each is an immunity-
 * pattern single-resolver wrapper around one of the 6 shadow-poll resolvers
 * shipped as Part A. Together they promote out-of-band substrate state
 * (systemd unit health, mitosis intent queue, applied-proposal sentinel,
 * mitosis pending pointer, BoundedBusSink drop log, LLM-resolver
 * reachability) into shape-typed impulses so the orthogonality / validation
 * audits observe the same surface the operator does.
 *
 * Boredom dispatches each on rotation (goals[30]..[35]); cheap tier — no LLM,
 * bounded I/O (small file reads + 1 HTTP probe). `precondition_always_true`
 * is enforced by empty inputShapes + empty variables; the engine pre-flight
 * cannot reject the goal so the observer always fires when picked.
 */

export const SYSTEMD_UNIT_HEALTH_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:systemd-unit-health-observer-tick",
  name: "systemd-unit-health-observer-tick",
  description:
    "Deterministic single-resolver wrapper around systemd_unit_health_observer. " +
    "Probes each substrate vessel's systemd unit via systemctl show and emits one " +
    "systemdUnitHealth impulse listing active/inactive/failed counts. Promotes " +
    "vessel up/down state into impulse form so detectors can observe it.",
  inputShapes: [],
  outputShapes: ["systemdUnitHealth"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_systemd_unit_health",
      description: "Invoke systemd_unit_health_observer.",
      resolver: "systemd_unit_health_observer",
      config: { type: "systemd_unit_health_observer" },
      outputShapes: ["systemdUnitHealth"],
    },
  ],
};

export const MITOSIS_INTENT_QUEUE_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:mitosis-intent-queue-observer-tick",
  name: "mitosis-intent-queue-observer-tick",
  description:
    "Deterministic single-resolver wrapper around mitosis_intent_queue_observer. " +
    "Reads the host-sync JSONL queue + results and emits mitosisIntentQueueState " +
    "with pending/pushed/rejected counts and oldest-pending age.",
  inputShapes: [],
  outputShapes: ["mitosisIntentQueueState"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_mitosis_intent_queue",
      description: "Invoke mitosis_intent_queue_observer.",
      resolver: "mitosis_intent_queue_observer",
      config: { type: "mitosis_intent_queue_observer" },
      outputShapes: ["mitosisIntentQueueState"],
    },
  ],
};

export const APPLIED_PROPOSAL_SENTINEL_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:applied-proposal-sentinel-observer-tick",
  name: "applied-proposal-sentinel-observer-tick",
  description:
    "Deterministic single-resolver wrapper around applied_proposal_sentinel_observer. " +
    "Lists proposals/.applied/ and emits appliedProposalSentinelState with " +
    "applied_count, recent_applied entries, and last_applied timestamp.",
  inputShapes: [],
  outputShapes: ["appliedProposalSentinelState"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_applied_proposal_sentinel",
      description: "Invoke applied_proposal_sentinel_observer.",
      resolver: "applied_proposal_sentinel_observer",
      config: { type: "applied_proposal_sentinel_observer" },
      outputShapes: ["appliedProposalSentinelState"],
    },
  ],
};

export const MITOSIS_PENDING_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:mitosis-pending-observer-tick",
  name: "mitosis-pending-observer-tick",
  description:
    "Deterministic single-resolver wrapper around mitosis_pending_observer. " +
    "Reads WORKSPACE_ROOT/mitosis-pending.json and emits mitosisPendingState " +
    "indicating whether a staged mitosis is awaiting host-sync push.",
  inputShapes: [],
  outputShapes: ["mitosisPendingState"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_mitosis_pending",
      description: "Invoke mitosis_pending_observer.",
      resolver: "mitosis_pending_observer",
      config: { type: "mitosis_pending_observer" },
      outputShapes: ["mitosisPendingState"],
    },
  ],
};

export const DISPATCH_DROPPED_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:dispatch-dropped-observer-tick",
  name: "dispatch-dropped-observer-tick",
  description:
    "Deterministic single-resolver wrapper around dispatch_dropped_observer. " +
    "Reads the BoundedBusSink drop log and emits dispatchDroppedHistory with " +
    "recent-window drop counts and dominant reason.",
  inputShapes: [],
  outputShapes: ["dispatchDroppedHistory"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_dispatch_dropped",
      description: "Invoke dispatch_dropped_observer.",
      resolver: "dispatch_dropped_observer",
      config: { type: "dispatch_dropped_observer" },
      outputShapes: ["dispatchDroppedHistory"],
    },
  ],
};

export const LLM_API_HEALTH_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:llm-api-health-observer-tick",
  name: "llm-api-health-observer-tick",
  description:
    "Deterministic single-resolver wrapper around llm_api_health_observer. " +
    "Probes llm-resolver-vessel /health and emits llmApiHealth with reachability, " +
    "HTTP status, and roundtrip latency. Best-effort; emits a well-formed impulse " +
    "even on connection failure or timeout.",
  inputShapes: [],
  outputShapes: ["llmApiHealth"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "observe_llm_api_health",
      description: "Invoke llm_api_health_observer.",
      resolver: "llm_api_health_observer",
      config: { type: "llm_api_health_observer" },
      outputShapes: ["llmApiHealth"],
    },
  ],
};
