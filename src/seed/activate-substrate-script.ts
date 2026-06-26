import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * activate-substrate-script — dispatchable activity wrapping the
 * `activate_substrate_script` resolver so substrate self-activation runs as a
 * TRACED goal through goal-host.
 *
 * Self-activation primitive (2026-06-26): a self-dev authoring flow that
 * produces a new version of a timer script (scripts/substrate/<name>.ts) calls
 * this to overwrite the live run-dir copy at /workspace/active-scripts/<name>.ts.
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
    "Write a substrate-authored new version of a timer script into the writable " +
    "run-dir (/workspace/active-scripts) so it goes live on the next timer firing " +
    "without a container restart. Replaces an existing seeded script only; " +
    "path-safe (basename-only, *.ts, optional base_sha guard).",
  inputShapes: ["script", "content"],
  outputShapes: ["substrateScriptActivation"],
  tags: ["substrate", "self-activation", "timer", "self-dev"],
  variables: [
    { name: "script", description: "Basename of the timer script, e.g. compose-teacher.ts" },
    { name: "content", description: "Full TypeScript source to make live" },
    { name: "base_sha", description: "Optional sha256 of current run-dir content; overwrite only if it matches" },
  ],
  tasks: [
    {
      id: "activate",
      description:
        "Overwrite the run-dir copy of the named timer script with the supplied " +
        "content. The resolver validates the basename, the .ts suffix, and that " +
        "the script already exists in the run-dir before writing.",
      resolver: "activate_substrate_script",
      config: {
        type: "activate_substrate_script",
        script: "{{script}}",
        content: "{{content}}",
        base_sha: "{{base_sha}}",
      },
      outputShapes: ["substrateScriptActivation"],
    },
  ],
};
