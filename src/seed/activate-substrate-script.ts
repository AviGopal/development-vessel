import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * activate-substrate-script — dispatchable activity wrapping the
 * `activate_substrate_script` resolver so substrate self-activation runs as a
 * TRACED goal through goal-host.
 *
 * Self-activation primitive (2026-06-26): a self-dev authoring flow that has
 * COMMITTED a new version of a timer script (scripts/substrate/<name>.ts) calls
 * this to copy that committed blob over the live run-dir copy at
 * /workspace/active-scripts/<name>.ts. It never carries source content.
 * The repointed unit ExecStart runs from the run-dir, so the new content is live
 * on the next timer firing WITHOUT an operator container restart.
 *
 * Path safety lives in the resolver (basename-only, *.ts, must already exist in
 * the run-dir, optional base_sha guard). This template is the orchestration +
 * trace surface only.
 */
export const ACTIVATE_SUBSTRATE_SCRIPT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:activate-substrate-script",
  name: "activate-substrate-script",
  description:
    "Make the COMMITTED version of a timer script (HEAD:scripts/substrate/<script> " +
    "in the super-repo) live in the run-dir (/workspace/active-scripts) on the next " +
    "timer firing without a container restart. Takes a script name only — never " +
    "source content, because the run-dir executes with the fleet secrets. Replaces " +
    "an existing seeded script only; path-safe (basename-only, *.ts, optional base_sha guard).",
  inputShapes: ["script"],
  outputShapes: ["substrateScriptActivation"],
  tags: ["substrate", "self-activation", "timer", "self-dev"],
  // Raise whenever this body changes: the seeder re-uploads a seed only when its seed_version
  // exceeds the registered row's (upsertVersionBumpedSeeds in cli.ts). 2 = content input removed;
  // until the live row is replaced, its {{content}} dispatches are refused by the resolver.
  metadata: { seed_version: 2 },
  variables: [
    { name: "script", description: "Basename of the timer script, e.g. compose-teacher.ts" },
    { name: "base_sha", description: "Optional sha256 of current run-dir content; overwrite only if it matches" },
  ],
  tasks: [
    {
      id: "activate",
      description:
        "Overwrite the run-dir copy of the named timer script with its committed " +
        "HEAD blob. The resolver validates the basename, the .ts suffix, that the " +
        "script already exists in the run-dir, and that it is tracked at HEAD.",
      resolver: "activate_substrate_script",
      config: {
        type: "activate_substrate_script",
        script: "{{script}}",
        base_sha: "{{base_sha}}",
      },
      outputShapes: ["substrateScriptActivation"],
    },
  ],
};
