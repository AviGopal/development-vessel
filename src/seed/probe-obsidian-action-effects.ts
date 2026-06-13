import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * probe-obsidian-action-effects — Phase 1 experimentation activity.
 *
 * Spec: openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *   specs/obsidian-observation-layer/spec.md §"probe-obsidian-action-effects activity contract"
 *
 * Iterates the Obsidian command catalog against a **probe vault** distinct
 * from the operator's working vault, captures `(pre_signature, command_id,
 * post_signature)` triples, and accumulates per-command `actionEffectModel`
 * distributions. Each emitted model carries:
 *
 *   - `observation_count` — total triples observed for the command
 *   - `post_signature_distribution[]` — probabilities summing to 1.0 (±1e-6)
 *   - `reversibility_class` — one of:
 *       text-edit         → reversible
 *       file-delete       → soft_irreversible
 *       plugin-disable    → hard_irreversible
 *       (default)         → unknown
 *
 * SAFETY: the runtime resolver in obsidian-vessel refuses to dispatch
 * `executeCommandById` when the active vault path equals
 * `probe_vault_path`. The check is a hard guard, not advisory; misalignment
 * emits a `verifier_negative.safety_breach` impulse instead of issuing
 * commands against the operator's vault.
 *
 * No LLM tasks. Phase 1 is deterministic.
 */
export const PROBE_OBSIDIAN_ACTION_EFFECTS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-obsidian-action-effects",
  name: "probe-obsidian-action-effects",
  description:
    "Phase 1 experimentation: iterates the Obsidian command catalog against a probe vault " +
    "distinct from the operator's vault, captures (pre, command, post) signature triples, " +
    "and emits actionEffectModel impulses with per-command probability distributions and a " +
    "four-value reversibility class (reversible | soft_irreversible | hard_irreversible | " +
    "unknown). Refuses to dispatch when active vault equals operator vault.",
  inputShapes: ["obsidianEpisode"],
  outputShapes: ["actionEffectModel"],
  tags: [
    "phase:1",
    "obsidian.meta.skill.prototype",
    "experimentation",
    "probe",
    "infrastructure",
    "safety.gated",
  ],
  variables: [
    {
      name: "obsidian_vessel_endpoint",
      description: "Base URL for obsidian-vessel resolver bridge. Default http://127.0.0.1:8290.",
    },
    {
      name: "probe_vault_path",
      description:
        "Absolute filesystem path of the PROBE vault. MUST differ from the operator's " +
        "active vault. The runtime resolver enforces this as a hard guard before any " +
        "executeCommandById dispatch.",
    },
    {
      name: "max_commands",
      description: "Max commands to probe in a single invocation. Default 10.",
    },
    {
      name: "per_command_timeout_ms",
      description:
        "Per-command timeout in milliseconds. Default 30000; capped at 30000 by the " +
        "resolver to bound probe blast radius.",
    },
    {
      name: "extra_deny_globs",
      description:
        "Extra command-id glob patterns to exclude beyond the built-in safety list " +
        "(app:*, editor:focus, daily-notes:*, workspace:close-window, workspace:quit, " +
        "app:open-vault, app:reload). JSON array.",
    },
  ],
  tasks: [
    {
      id: "probe_commands",
      description:
        "Dispatch the action-effect probe against obsidian-vessel. The resolver verifies " +
        "probe_vault_path ≠ operator vault, iterates the command catalog (skipping built-in " +
        "+ caller-supplied deny globs), accumulates per-command (pre, command, post) " +
        "triples into actionEffectModel impulses with reversibility classifications, and " +
        "returns the accumulated catalog.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "{{obsidian_vessel_endpoint}}/v1/action-effects/probe",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body:
          '{"probe_vault_path":"{{probe_vault_path}}",' +
          '"max_commands":{{max_commands}},' +
          '"per_command_timeout_ms":{{per_command_timeout_ms}},' +
          '"extra_deny_globs":{{extra_deny_globs}}}',
      },
      outputShapes: ["actionEffectModel"],
    },
  ],
};
