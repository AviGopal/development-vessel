import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * group-interaction-episodes — Phase 1, Layer 1.
 *
 * Spec: openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *   specs/obsidian-observation-layer/spec.md §"group-interaction-episodes activity contract"
 *
 * Windowing resolver. Consumes Layer-0 `obsidianEvent`s and groups them
 * into `obsidianEpisode` impulses by inactivity-gap close (default 30s) or
 * workspace boundary. The emitted episode carries `event_ids` ordered
 * chronologically and a `sorted_unique_class_signature` (sorted + deduped
 * tokens of the form `<kind>` or `<kind>:<command_id>`).
 *
 * The runtime windowing implementation lives in
 * `obsidian-vessel/src/resolvers/group-interaction-episodes.ts`. This
 * template invokes the resolver via the obsidian-vessel HTTP shim.
 *
 * No LLM tasks. Phase 1 is deterministic.
 */
export const GROUP_INTERACTION_EPISODES_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:group-interaction-episodes",
  name: "group-interaction-episodes",
  description:
    "Phase 1 Layer-1: windows the obsidianEvent stream into obsidianEpisodes. " +
    "Idle-gap close (default 30s) or workspace boundary triggers an episode. " +
    "Output: `event_ids` ordered chronologically + `sorted_unique_class_signature` " +
    "(sorted, deduplicated). bridge_eligibility=allow (signature is content-free). " +
    "Phase 3 detect-recurring-pattern consumes the output.",
  inputShapes: ["obsidianEvent"],
  outputShapes: ["obsidianEpisode"],
  tags: [
    "phase:1",
    "obsidian.meta.skill.prototype",
    "layer.1",
    "windowing",
    "infrastructure",
  ],
  variables: [
    {
      name: "obsidian_vessel_endpoint",
      description: "Base URL for obsidian-vessel resolver bridge. Default http://127.0.0.1:8290.",
    },
    {
      name: "window_ms",
      description:
        "Idle-gap threshold in milliseconds. When no event arrives for this long, the " +
        "current window closes and an obsidianEpisode is emitted. Default 30000.",
    },
    {
      name: "sync_root_scope",
      description:
        "Optional vault-relative scope filter restricting which events feed the windowing pass.",
    },
  ],
  tasks: [
    {
      id: "window_events",
      description:
        "Invoke obsidian-vessel's windowing endpoint to close idle-gap windows on the " +
        "obsidianEvent stream and emit one obsidianEpisode per window with ordered " +
        "event_ids and a sorted-unique class signature.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{obsidian_vessel_endpoint}}/v1/episodes/window",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body:
          '{"window_ms":{{window_ms}},"sync_root_scope":"{{sync_root_scope}}"}',
      },
      outputShapes: ["obsidianEpisode"],
    },
  ],
};
