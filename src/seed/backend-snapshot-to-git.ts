import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * backend-snapshot-to-git — dump SurrealDB tables to /workspace/snapshots/<TS>/
 * (JSONL files survive container destruction via the workspace volume) and write a
 * lightweight manifest INTO the same snapshot dir as a self-contained index.
 *
 * CONVERGED (2026-07-01): this activity previously ALSO created a
 * `substrate-authored/backend-snapshot-<TS>` git branch, committed the manifest, pushed
 * the branch, and opened a PR to dev. That publication half never merged — it accreted
 * dead-end branches on the canonical repo (branch divergence / fragmentation), and the
 * git "index" it produced was illusory (the branch was never merged, and the super-repo
 * clone is periodically reset --hard to origin/dev, discarding any uncommitted manifest).
 * The DURABLE backup is the SurrealDB dump on the workspace volume; the git-branch half
 * added fragmentation with no real durability. Per the operator's "converge on dev, don't
 * fragment" directive, the branch/commit/push/PR tasks are removed. Same activity id +
 * durability purpose (reuse, not a re-mint); the manifest now lives beside the dump on the
 * volume. If a git-tracked snapshot index is wanted later, land it on dev via the
 * host-sync→dev path (the proven convergence path pointer-bumps already use) — not a branch.
 *
 * Composition:
 *   1. surrealdb_export — write JSONL per table to /workspace/snapshots/<TS>/
 *   2. fs_write manifest.md into the SAME snapshot dir (self-contained index; no git)
 */
export const BACKEND_SNAPSHOT_TO_GIT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:backend-snapshot-to-git",
  name: "backend-snapshot-to-git",
  description:
    "Dump SurrealDB tables to JSONL under /workspace/snapshots/<TS>/ and write a summary " +
    "manifest.md beside the dump. Closes the data-durability gap: SurrealDB lives inside " +
    "substrate-live; the workspace volume persists the dump across container destruction. " +
    "No git publication — the branch+PR half was removed (2026-07-01) because it accreted " +
    "dead-end substrate-authored/* branches (fragmentation) without real durability.",
  inputShapes: [],
  outputShapes: ["surrealdbExportResult", "commandResult"],
  tags: [
    "substrate.durability",
    "snapshot",
  ],
  variables: [
    { name: "snapshot_ts", description: "Compact ISO timestamp for the snapshot dir name" },
    { name: "snapshot_dir", description: "Absolute output dir, e.g. /workspace/snapshots/<snapshot_ts>" },
    { name: "manifest_body", description: "Markdown manifest content (caller composes)" },
  ],
  tasks: [
    {
      id: "export_surrealdb",
      description:
        "Dump the default load-bearing tables (activity_template, " +
        "activity_execution_traces, activity_metrics, concept, substrate_gap) " +
        "to JSONL files under {{snapshot_dir}}. Survives container destruction " +
        "because /workspace is on the persistent substrate-workspace volume.",
      resolver: "surrealdb_export",
      config: { type: "surrealdb_export", output_dir: "{{snapshot_dir}}" },
      outputShapes: ["surrealdbExportResult"],
    },
    {
      id: "write_manifest",
      description:
        "Write the manifest describing the snapshot to {{snapshot_dir}}/manifest.md — beside " +
        "the JSONL bodies, so the index travels with the dump on the volume. No git commit " +
        "(the former branch-publication fragmented dev with dead-end branches).",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{snapshot_dir}}/manifest.md",
        content: "{{manifest_body}}",
      },
      outputShapes: ["commandResult"],
    },
  ],
  authored_from_pattern: {
    pattern_id: "backend_snapshot_to_git_durability_2026_06_03",
    observation_window: "2026-06-03/2026-06-03",
    contrast_examples: 0,
  },
  composition_rationales: [
    {
      task_id: "export_surrealdb",
      rationale_class: "essential",
      rationale_text:
        "Without the dump, container destruction loses every Thompson posterior, every concept, every trace. The workspace volume is the persistent surface.",
    },
    {
      task_id: "write_manifest",
      rationale_class: "essential",
      rationale_text:
        "A small manifest.md beside the JSONL bodies gives a self-contained, replayable index of what was snapshotted, on the same durable surface as the dump — no git branch, no fragmentation.",
    },
  ],
};
