import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * publish-substrate-authored-artifact — substrate-composed publication of an
 * authored artifact to a substrate-authored/* branch with PR opened against dev.
 *
 * No destination paths are canonized. The activity carries every destination
 * decision as a variable:
 *   - target_path: where the artifact lands inside the writable super-repo clone
 *   - target_branch: substrate-authored/<date>-<seq> or similar (validated by
 *     git_branch_create against SUBSTRATE_ALLOWED_BRANCH_PATTERNS env var)
 *   - commit_message, pr_title, pr_body: substrate-authored content with
 *     the Substrate-Authored-By trailer required by gh_pr_create
 *
 * When a new vessel is created in the future, the calling activity sets
 * target_path under repos/<new-vessel>/ — no edit to this template needed.
 *
 * Resolver-level safety enforced by the primitives:
 *   - git_branch_create refuses names outside the allowed-branch-pattern
 *   - git_push refuses --force, refuses main/dev/master/trunk/release
 *   - gh_pr_create requires Substrate-Authored-By trailer; refuses auto-merge
 *
 * Composition order:
 *   1. git_status — verify the writable clone is clean before staging
 *   2. fs_write — write the artifact body to target_path
 *   3. git_branch_create — create the substrate-authored branch
 *   4. git_add — stage the new artifact
 *   5. git_commit — commit with the provided message
 *   6. git_push — push to origin (refuses protected branches)
 *   7. gh_pr_create — open PR against dev (refuses auto-merge)
 *
 * Pre-H2: the writable clone identity is the operator's git config. The
 * gh_pr_create call uses GITHUB_TOKEN/GH_TOKEN. Substrate-Authored-By trailer
 * is the only provenance signal until H2 ed25519 commit-signing ships. See
 * openspec/changes/2026-06-01-substrate-as-git-author/.
 */
export const PUBLISH_SUBSTRATE_AUTHORED_ARTIFACT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:publish-substrate-authored-artifact",
  name: "publish-substrate-authored-artifact",
  description:
    "Compose substrate-side publication of an authored artifact: write it to " +
    "the writable super-repo clone, branch + commit + push, open PR against dev. " +
    "No destination canonized; the caller chooses target_path and target_branch. " +
    "Resolver-level gates refuse protected branches, --force pushes, and PRs " +
    "without the Substrate-Authored-By trailer.",
  inputShapes: ["authoredArtifactCandidate"],
  outputShapes: ["branchCreateResult", "gitPushResult", "prCreateResult"],
  tags: [
    "substrate.authored.publication",
    "substrate.as.git.author",
    "composition",
    "no.canonical.paths",
  ],
  variables: [
    { name: "cwd", description: "Writable super-repo clone path (e.g. /workspace/git/super-repo)" },
    { name: "target_path", description: "Destination path relative to cwd (caller-chosen; no canonization)" },
    { name: "artifact_body", description: "Content to write at target_path" },
    { name: "target_branch", description: "Branch name; must match SUBSTRATE_ALLOWED_BRANCH_PATTERNS" },
    { name: "base_branch", description: "Branch to fork target_branch from (default: dev)" },
    { name: "commit_message", description: "Git commit message; should cite trace_id / vessel_id" },
    { name: "owner", description: "GitHub repo owner" },
    { name: "repo", description: "GitHub repo name" },
    { name: "pr_title", description: "PR title (under 72 chars recommended)" },
    {
      name: "pr_body",
      description:
        "PR body; MUST contain a 'Substrate-Authored-By: <identity>' line or " +
        "gh_pr_create refuses with safety_breach",
    },
  ],
  tasks: [
    {
      id: "preflight_clean",
      description:
        "Verify the writable super-repo clone has no uncommitted changes before " +
        "the substrate stages new content. A dirty baseline means a previous " +
        "publication aborted partway — the operator must resolve it manually.",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "write_artifact",
      description:
        "Write the artifact body to target_path inside the writable clone. The " +
        "destination is caller-chosen; no path canonization in the template or " +
        "the resolver.",
      resolver: "fs_write",
      config: { type: "fs_write", path: "{{target_path}}", content: "{{artifact_body}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "create_branch",
      description:
        "Create the substrate-authored branch from base_branch. The git_branch_create " +
        "resolver refuses names that do not match SUBSTRATE_ALLOWED_BRANCH_PATTERNS " +
        "(default ^(substrate-authored|substrate)/.+$).",
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
      id: "stage_artifact",
      description: "Stage the newly-written artifact for commit.",
      resolver: "git_add",
      config: { type: "git_add", paths: ["{{target_path}}"], cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "commit_artifact",
      description:
        "Commit the staged artifact. The commit message should cite the " +
        "trace_id, vessel_id, and any concept_ids that informed authorship.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{commit_message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "push_branch",
      description:
        "Push the branch to origin. The git_push resolver refuses --force and " +
        "refuses pushes to main/dev/master/trunk/release regardless of caller " +
        "intent.",
      resolver: "git_push",
      config: { type: "git_push", branch: "{{target_branch}}", cwd: "{{cwd}}" },
      outputShapes: ["gitPushResult"],
    },
    {
      id: "open_pr",
      description:
        "Open a PR against the base branch via GitHub REST. The gh_pr_create " +
        "resolver requires a Substrate-Authored-By trailer in the body and " +
        "refuses auto-merge.",
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
    pattern_id: "substrate_as_git_author_phase1_composition",
    observation_window: "2026-06-01/2026-06-01",
    contrast_examples: 0,
  },
  cited_concept_ids: [
    "concept_uXRPTRZPCKFS",
    "concept_Q3lwHwujiwkj",
    "concept__W9s8nA3YbDO",
    "concept_U1GbuEbgtcM7",
  ],
  composition_rationales: [
    {
      task_id: "preflight_clean",
      rationale_class: "essential",
      rationale_text:
        "A dirty baseline indicates a half-completed previous publication; the substrate cannot reason about which earlier files survived. Refusing here forces operator triage.",
    },
    {
      task_id: "create_branch",
      rationale_class: "essential",
      rationale_text:
        "git_branch_create encodes the substrate-allowed-prefix gate; bypassing it would let the substrate stage commits on operator branches.",
    },
    {
      task_id: "push_branch",
      rationale_class: "essential",
      rationale_text:
        "git_push encodes the protected-branch refusal client-side until server-side branch protection lands. Replacing it with a generic git command would lose that safety.",
    },
    {
      task_id: "open_pr",
      rationale_class: "essential",
      rationale_text:
        "gh_pr_create enforces the Substrate-Authored-By provenance trailer. A generic HTTP POST would not.",
    },
  ],
};
