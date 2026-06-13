import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * observe-obsidian-events — Phase 1, Layer 0.
 *
 * Spec: openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *   specs/obsidian-observation-layer/spec.md §"observe-obsidian-events activity contract"
 *
 * Infrastructure activity. The runtime resolver lives in `obsidian-vessel`
 * (`src/resolvers/observe-obsidian-events.ts`) and is bootstrapped from the
 * Obsidian plugin's `main.ts`. This seed template makes that resolver
 * discoverable + dispatchable from activity-api so Phase 2/3 templates can
 * compose it.
 *
 * The activity itself is "drain the in-memory event log": it issues an
 * `http_fetch` against obsidian-vessel's events endpoint and returns the
 * recent obsidianEvent set as JSON. Per spec, every emitted impulse carries
 * `bridge_eligibility: "deny"` and `payload_hash` only — NO raw editor
 * text, NO absolute filesystem paths.
 *
 * No LLM tasks. Phase 1 is deterministic.
 */
export const OBSERVE_OBSIDIAN_EVENTS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:observe-obsidian-events",
  name: "observe-obsidian-events",
  description:
    "Phase 1 Layer-0 observation: drains the obsidian-vessel in-memory event log " +
    "and emits `obsidianEvent` impulses (bridge_eligibility=deny, payload_hash only). " +
    "The runtime resolver lives in obsidian-vessel and subscribes to workspace + vault " +
    "+ command-palette hooks. Deterministic; no LLM tasks. Phase 2 (drafter) and " +
    "Phase 3 (predict-and-verify) consume the output via group-interaction-episodes.",
  inputShapes: [],
  outputShapes: ["obsidianEvent"],
  tags: [
    "phase:1",
    "obsidian.meta.skill.prototype",
    "layer.0",
    "observation",
    "infrastructure",
  ],
  variables: [
    {
      name: "obsidian_vessel_endpoint",
      description:
        "Base URL for obsidian-vessel's resolver bridge (Obsidian plugin's HTTP shim). " +
        "Default: http://127.0.0.1:8290.",
    },
    {
      name: "sync_root_scope",
      description:
        "Optional vault-relative scope filter (e.g. 'notes/'). When omitted, all events " +
        "in the buffer are returned. NEVER an absolute path.",
    },
    {
      name: "limit",
      description: "Max events to return per drain. Default 1000.",
    },
    {
      name: "auth_token",
      description:
        "JWT/Bearer token used to authenticate against the activity-api and " +
        "obsidian-vessel HTTP endpoints. Required to satisfy MISSING_AUTH precondition.",
    },
  ],
  tasks: [
    {
      id: "drain_event_log",
      description:
        "Drain the obsidian-vessel in-memory event log via HTTP. Each returned event " +
        "carries `bridge_eligibility: \"deny\"`, `payload_hash` only (sha256 over the " +
        "serialized raw payload), and an optional vault-relative `sync_root_relative_path`. " +
        "No raw text, no absolute paths.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url:
          "{{obsidian_vessel_endpoint}}/v1/events" +
          "?sync_root_scope={{sync_root_scope}}&limit={{limit}}",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer {{auth_token}}",
        },
      },
      outputShapes: ["obsidianEvent"],
    },
  ],
};
