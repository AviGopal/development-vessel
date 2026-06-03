import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * backend-snapshot-to-git — dump SurrealDB tables to /workspace/snapshots/<TS>/
 * (JSONL files survive container destruction via the bind mount), write a
 * lightweight manifest summarising the dump, then publish the manifest to
 * the super-repo via the substrate-as-git-author safety chain.
 *
 * The snapshot BODIES stay in /workspace (large, persistent across container
 * lifecycles). The MANIFEST gets committed to Git as a durable index — so
 * even if /workspace is wiped, the operator has a record of when snapshots
 * were taken, what they contained, and (with surrealdb_import) how to replay
 * one. Two independent durability layers.
 *
 * Composition:
 *   1. surrealdb_export — write JSONL per table to /workspace/snapshots/<TS>/
 *   2. fs_write manifest.json (small index of the dump)
 *   3. git_status / git_branch_create / git_add / git_commit / git_push /
 *      gh_pr_create — publish the manifest path only (not the JSONL bodies)
 *
 * Variables are caller-chosen — no destination canonized.
 */
export const BACKEND_SNAPSHOT_TO_GIT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:backend-snapshot-to-git",
  name: "backend-snapshot-to-git",
  description:
    "Dump SurrealDB tables to JSONL under /workspace/snapshots/<TS>/, write a " +
    "summary manifest, and publish the manifest to the super-repo via the " +
    "substrate-as-git-author chain. Closes the data-durability gap: SurrealDB " +
    "lives inside substrate-live; /workspace is bind-mounted; the manifest in " +
    "git is the durable index even if /workspace is wiped.",
  inputShapes: [],
  outputShapes: ["surrealdbExportResult", "branchCreateResult", "gitPushResult", "prCreateResult"],
  tags: [
    "substrate.durability",
    "snapshot",
    "substrate.authored.publication",
    "composition",
  ],
  variables: [
    { name: "cwd", description: "Writable super-repo clone path (e.g. /workspace/git/super-repo)" },
    { name: "snapshot_ts", description: "Compact ISO timestamp for the snapshot dir name" },
    { name: "snapshot_dir", description: "Absolute output dir, e.g. /workspace/snapshots/<snapshot_ts>" },
    { name: "manifest_relpath", description: "Path within super-repo for the manifest, e.g. validation/snapshots/<snapshot_ts>/manifest.md" },
    { name: "manifest_body", description: "Markdown manifest content (caller composes)" },
    { name: "target_branch", description: "Branch name; must match SUBSTRATE_ALLOWED_BRANCH_PATTERNS" },
    { name: "base_branch", description: "Base branch (default: dev)" },
    { name: "commit_message", description: "Commit message" },
    { name: "owner", description: "GitHub repo owner" },
    { name: "repo", description: "GitHub repo name" },
    { name: "pr_title", description: "PR title" },
    { name: "pr_body", description: "PR body; MUST contain 'Substrate-Authored-By:' line" },
  ],
  tasks: [
    {
      id: "export_surrealdb",
      description:
        "Dump the default load-bearing tables (activity_template, " +
        "activity_execution_traces, activity_metrics, concept, substrate_gap) " +
        "to JSONL files under {{snapshot_dir}}. Survives container destruction " +
        "because /workspace is host-bind-mounted.",
      resolver: "surrealdb_export",
      config: { type: "surrealdb_export", output_dir: "{{snapshot_dir}}" },
      outputShapes: ["surrealdbExportResult"],
    },
    {
      id: "preflight_clean",
      description:
        "Verify super-repo clone has no uncommitted changes before staging the manifest.",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_manifest",
      description:
        "Write the (small) manifest describing the snapshot to {{manifest_relpath}} in the super-repo clone. " +
        "The manifest is the only file committed to git — the JSONL bodies stay in /workspace.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{cwd}}/{{manifest_relpath}}",
        content: "{{manifest_body}}",
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "create_branch",
      description: "Create substrate-authored branch from base_branch.",
      resolver: "git_branch_create",
      config: {
        type: "git_branch_create",
        branch_name: "{{target_branch}}",
        base: "{{base_branch}}",
        cwd: "{{cwd}}",
      },
      outputShapes: ["branchCreateResult"],
    },
    {
      id: "stage_manifest",
      description: "Stage the manifest path only.",
      resolver: "git_add",
      config: { type: "git_add", paths: ["{{manifest_relpath}}"], cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "commit_manifest",
      description: "Commit the manifest with provenance.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{commit_message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "push_branch",
      description: "Push branch (refuses protected refs via git_push).",
      resolver: "git_push",
      config: { type: "git_push", branch: "{{target_branch}}", cwd: "{{cwd}}" },
      outputShapes: ["gitPushResult"],
    },
    {
      id: "open_pr",
      description: "Open PR with Substrate-Authored-By trailer (gh_pr_create enforces).",
      resolver: "gh_pr_create",
      config: {
        type: "gh_pr_create",
        owner: "{{owner}}",
        repo: "{{repo}}",
        source_branch: "{{target_branch}}",
        target_branch: "{{base_branch}}",
        title: "{{pr_title}}",
        body: "{{pr_body}}",
      },
      outputShapes: ["prCreateResult"],
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
        "Without the dump, container destruction loses every Thompson posterior, every concept, every trace. /workspace is the only host-persistent surface.",
    },
    {
      task_id: "write_manifest",
      rationale_class: "essential",
      rationale_text:
        "Committing the manifest (not the JSONL bodies) gives a small, audit-able git record of when/what was snapshotted. Two-layer durability: /workspace for bodies, git for index.",
    },
    {
      task_id: "push_branch",
      rationale_class: "essential",
      rationale_text:
        "git_push encodes the protected-branch refusal client-side; substrate cannot accidentally publish snapshots directly to dev.",
    },
  ],
};
