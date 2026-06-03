import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * vessel-repo-promote — promote a substrate-authored vessel from a sub-
 * directory in the super-repo to its own GitHub repo. Closes Gap B from iter
 * 2026-06-03: scaffold-and-publish-vessel produces repos/<vessel>/ in the
 * super-repo only. This activity creates the standalone GitHub repo via
 * gh_repo_create and commits a finding-style manifest in the super-repo
 * recording the promotion event.
 *
 * Submodule conversion is intentionally deferred to a follow-up: doing
 * `git submodule add` cleanly requires removing the existing tree from the
 * super-repo + adding the submodule pointer atomically, which is a delicate
 * git operation. Shipping the gh_repo_create primitive + finding-style
 * record now gives the substrate the capability to author its own remotes;
 * the submodule cutover can be a later mitosis or operator-assisted step.
 *
 * Composition:
 *   1. preflight_clean — verify super-repo clone is clean
 *   2. fs_list — enumerate files in the existing repos/<vessel>/ tree
 *      (for the manifest's record of what got promoted)
 *   3. create_repo — gh_repo_create with optional allow_canonical_prefix
 *   4. write_manifest — fs_write a markdown finding under
 *      validation/findings/vessel-repo-promoted-<vessel>.md
 *   5. publish chain (branch / add / commit / push / pr) — record the
 *      promotion event in dev via the standard substrate-as-git-author chain
 */
export const VESSEL_REPO_PROMOTE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vessel-repo-promote",
  name: "vessel-repo-promote",
  description:
    "Promote a substrate-authored vessel from a super-repo subdirectory to " +
    "a standalone GitHub repo. Creates the remote via gh_repo_create and " +
    "commits a finding-style manifest. Submodule pointer conversion is " +
    "deferred to a follow-up step (operator-assisted or later substrate iter).",
  inputShapes: [],
  outputShapes: ["ghRepoCreateResult", "branchCreateResult", "gitPushResult", "prCreateResult"],
  tags: [
    "substrate.authored.publication",
    "vessel",
    "promotion",
    "composition",
    "intent:scaffold",
  ],
  variables: [
    { name: "cwd", description: "Writable super-repo clone path" },
    { name: "vessel_name", description: "Vessel name (e.g. metric-collector-vessel)" },
    { name: "vessel_dir_rel", description: "Vessel dir relative to cwd, e.g. repos/<vessel_name>" },
    { name: "owner", description: "GitHub owner for the new repo (default: AviGopal)" },
    { name: "description", description: "One-line repo description" },
    { name: "finding_relpath", description: "Where to write the finding markdown (e.g. validation/findings/vessel-repo-promoted-<vessel>.md)" },
    { name: "finding_body", description: "Markdown content (caller composes; includes file listing, rationale, next steps)" },
    { name: "target_branch", description: "Branch (must match SUBSTRATE_ALLOWED_BRANCH_PATTERNS)" },
    { name: "base_branch", description: "Base branch (default dev)" },
    { name: "commit_message", description: "Commit message" },
    { name: "pr_title", description: "PR title" },
    { name: "pr_body", description: "PR body; MUST contain 'Substrate-Authored-By:' line" },
  ],
  tasks: [
    {
      id: "preflight_clean",
      description: "Verify super-repo clone is clean before staging.",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "list_vessel_files",
      description:
        "Enumerate the existing repos/<vessel_name>/ tree so the finding can record what's being promoted.",
      resolver: "fs_list",
      config: { type: "fs_list", path: "{{cwd}}/{{vessel_dir_rel}}", recursive: true },
      outputShapes: ["fsListResult"],
    },
    {
      id: "create_repo",
      description:
        "Create the standalone GitHub repo. Refuses metabob-* prefix (operator-canonical) " +
        "unless allow_canonical_prefix is set, and refuses if a repo with that name " +
        "already exists.",
      resolver: "gh_repo_create",
      config: {
        type: "gh_repo_create",
        name: "{{vessel_name}}",
        owner: "{{owner}}",
        description: "{{description}}",
      },
      outputShapes: ["ghRepoCreateResult"],
    },
    {
      id: "write_finding",
      description:
        "Write the promotion finding (records the new remote URL, what files would migrate, " +
        "deferred submodule-add step).",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{cwd}}/{{finding_relpath}}",
        content: "{{finding_body}}",
      },
      outputShapes: ["commandResult"],
    },
    {
      id: "create_branch",
      description: "Create substrate-authored branch.",
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
      id: "stage_finding",
      description: "Stage the finding markdown only.",
      resolver: "git_add",
      config: { type: "git_add", paths: ["{{finding_relpath}}"], cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "commit_finding",
      description: "Commit the finding.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{commit_message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "push_branch",
      description: "Push branch (protected-branch refusal enforced).",
      resolver: "git_push",
      config: { type: "git_push", branch: "{{target_branch}}", cwd: "{{cwd}}" },
      outputShapes: ["gitPushResult"],
    },
    {
      id: "open_pr",
      description: "Open PR; Substrate-Authored-By trailer enforced by gh_pr_create.",
      resolver: "gh_pr_create",
      config: {
        type: "gh_pr_create",
        owner: "AviGopal",
        repo: "metabob-devbob",
        source_branch: "{{target_branch}}",
        target_branch: "{{base_branch}}",
        title: "{{pr_title}}",
        body: "{{pr_body}}",
      },
      outputShapes: ["prCreateResult"],
    },
  ],
  authored_from_pattern: {
    pattern_id: "vessel_repo_promote_2026_06_03",
    observation_window: "2026-06-03/2026-06-03",
    contrast_examples: 1,
  },
  composition_rationales: [
    {
      task_id: "create_repo",
      rationale_class: "essential",
      rationale_text:
        "Without this, substrate-authored vessels can only ever exist as super-repo subdirectories. gh_repo_create lets the substrate own its own remotes.",
    },
    {
      task_id: "write_finding",
      rationale_class: "essential",
      rationale_text:
        "Finding-style manifest preserves provenance: which vessel was promoted, what its file listing looked like at promotion time, why submodule-add is deferred.",
    },
  ],
};
