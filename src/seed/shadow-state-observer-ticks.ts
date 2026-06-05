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

// ─── Round 2 (2026-06-05) ─────────────────────────────────────────────────
// Six additional shadow-state observers closing the remaining round-1
// impulse-coverage gaps. host-container-source-drift is the headline: makes
// the dominant host-sync rejection cause (rejected_base_sha) substrate-
// observable. The rest cover disk, concept-db, discovery-registry staleness,
// substrate-heartbeat liveness, and LLM-quota signals from recent traces.

export const HOST_CONTAINER_SOURCE_DRIFT_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:host-container-source-drift-observer-tick",
  name: "host-container-source-drift-observer-tick",
  description:
    "Deterministic single-resolver wrapper around host_container_source_drift_observer. " +
    "Walks each substrate vessel's src/ tree in both container (/vessels/) and host " +
    "(repos/) and emits hostContainerSourceDriftState with per-vessel drift counts. " +
    "Makes the dominant host-sync rejection cause (rejected_base_sha) observable.",
  inputShapes: [],
  outputShapes: ["hostContainerSourceDriftState"],
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
      id: "observe_host_container_source_drift",
      description: "Invoke host_container_source_drift_observer.",
      resolver: "host_container_source_drift_observer",
      config: { type: "host_container_source_drift_observer" },
      outputShapes: ["hostContainerSourceDriftState"],
    },
  ],
};

export const DISK_SPACE_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:disk-space-observer-tick",
  name: "disk-space-observer-tick",
  description:
    "Deterministic single-resolver wrapper around disk_space_observer. " +
    "Runs df -k on /workspace, /vessels, / and emits diskSpaceState with per-mount " +
    "used_pct and a green/yellow/red pressure level. Surfaces disk-pressure that " +
    "would otherwise appear only as ENOSPC noise in downstream failure traces.",
  inputShapes: [],
  outputShapes: ["diskSpaceState"],
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
      id: "observe_disk_space",
      description: "Invoke disk_space_observer.",
      resolver: "disk_space_observer",
      config: { type: "disk_space_observer" },
      outputShapes: ["diskSpaceState"],
    },
  ],
};

export const CONCEPT_DB_HEALTH_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:concept-db-health-observer-tick",
  name: "concept-db-health-observer-tick",
  description:
    "Deterministic single-resolver wrapper around concept_db_health_observer. " +
    "Probes concept-db /health (control plane) and /concepts/search?q=&limit=1 " +
    "(data plane) and emits conceptDbHealth with reachability + roundtrip per plane. " +
    "Distinguishes control-plane outage from data-plane wedge.",
  inputShapes: [],
  outputShapes: ["conceptDbHealth"],
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
      id: "observe_concept_db_health",
      description: "Invoke concept_db_health_observer.",
      resolver: "concept_db_health_observer",
      config: { type: "concept_db_health_observer" },
      outputShapes: ["conceptDbHealth"],
    },
  ],
};

export const DISCOVERY_VESSEL_REGISTRY_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:discovery-vessel-registry-observer-tick",
  name: "discovery-vessel-registry-observer-tick",
  description:
    "Deterministic single-resolver wrapper around discovery_vessel_registry_observer. " +
    "Queries discovery-vessel for the vesselRegistry impulse and emits " +
    "discoveryRegistryState with per-vessel last-heartbeat age and a stale-count " +
    "threshold. Detects silently-degraded vessels still listed as registered.",
  inputShapes: [],
  outputShapes: ["discoveryRegistryState"],
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
      id: "observe_discovery_vessel_registry",
      description: "Invoke discovery_vessel_registry_observer.",
      resolver: "discovery_vessel_registry_observer",
      config: { type: "discovery_vessel_registry_observer" },
      outputShapes: ["discoveryRegistryState"],
    },
  ],
};

export const SUBSTRATE_HEARTBEAT_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:substrate-heartbeat-observer-tick",
  name: "substrate-heartbeat-observer-tick",
  description:
    "Deterministic single-resolver wrapper around substrate_heartbeat_observer. " +
    "Reads /workspace/substrate-heartbeat.json mtime + contents and emits " +
    "substrateHeartbeatState with age_seconds + stale flag. Coarse liveness " +
    "signal: when the heartbeat goes stale, boredom is not running.",
  inputShapes: [],
  outputShapes: ["substrateHeartbeatState"],
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
      id: "observe_substrate_heartbeat",
      description: "Invoke substrate_heartbeat_observer.",
      resolver: "substrate_heartbeat_observer",
      config: { type: "substrate_heartbeat_observer" },
      outputShapes: ["substrateHeartbeatState"],
    },
  ],
};

export const LLM_QUOTA_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:llm-quota-observer-tick",
  name: "llm-quota-observer-tick",
  description:
    "Deterministic single-resolver wrapper around llm_quota_observer. " +
    "Scans recent execution traces for llm_completion tasks with 429 / rate-limit " +
    "/ overloaded_error signatures and emits llmQuotaState with recent-window " +
    "counts + estimated remaining quota percentage. Lets the substrate throttle " +
    "expensive goals before they hit a wall.",
  inputShapes: [],
  outputShapes: ["llmQuotaState"],
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
      id: "observe_llm_quota",
      description: "Invoke llm_quota_observer.",
      resolver: "llm_quota_observer",
      config: { type: "llm_quota_observer" },
      outputShapes: ["llmQuotaState"],
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
