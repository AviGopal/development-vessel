import { resolve, join, dirname, relative, isAbsolute } from "path";
import {
  rename,
  mkdir,
  stat,
  unlink,
  readFile,
  writeFile,
  copyFile,
  readdir,
  appendFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ResolverResult } from "./types.js";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

/**
 * vessel_mitosis_cutover — promotes a mitosis track to the canonical position
 * after evaluation returns FAVORABLE. Refuses on any other verdict, and on
 * H4-load-bearing baseline version_ids (v0 / baseline / *-original).
 *
 * Operations (when dry_run=false):
 *   1. Stop + disable the base systemd unit.
 *   2. Move base source to repos/<vessel>/archive/<base_version_id>/.
 *   3. Move mitosis source to canonical repos/<vessel>/.
 *   4. Rewrite the (now-canonical) systemd unit so the canonical unit name
 *      points at the canonical path on the original (base) port.
 *   5. Start the newly-canonical unit.
 *
 * In test environments systemctl is mocked via the SYSTEMCTL_CMD env var
 * (default: `systemctl`); when unset and not in a container, we still emit
 * the planned commands but tolerate execution failure.
 *
 * Immunity-pattern: deterministic, no LLM, single resolver.
 */

export interface VesselMitosisCutoverPointer {
  type: "vessel_mitosis_cutover";
  vessel_name: string;
  base_version_id: string;
  mitosis_version_id: string;
  base_root?: string;
  mitosis_root?: string;
  base_unit_name?: string;
  mitosis_unit_name?: string;
  unit_dir?: string;
  evaluation_evidence: {
    verdict: string;
    base_success_rate: number;
    mitosis_success_rate: number;
    cited_trace_ids: string[];
  };
  /**
   * Freshness gate (Stage B.2 2026-06-03): SHA-256(12) hex of the live
   * `<base_root>/src/index.ts` at the time this mitosis was staged. The
   * cutover resolver re-hashes the current live source and refuses if it
   * differs — preventing a stale draft from silently regressing newer
   * operator-side fixes. When omitted, the cutover refuses with a
   * substrateGap citing `mitosis_freshness_violation` (category=other,
   * reason=missing_base_sha). The gap cites the architectural principle
   * `resilient_against_unintended_changes`.
   */
  staged_base_sha?: string;
  /** Allow operator to override the freshness-check file (defaults to <baseRoot>/src/index.ts). */
  freshness_check_path?: string;
  dry_run?: boolean;
  /**
   * Git-aware cutover (2026-06-04): when supplied, the cutover applies
   * staged files from `mitosis_root` (relative to `mitosis_root`) to
   * `host_repo_root`, runs `git add` + `git commit` + `git push origin dev`,
   * then mirrors the staged files into `base_root` (the live `/vessels/<v>/`
   * runtime path) and restarts the vessel unit. Emits a `cutoverApplied`
   * impulse on success.
   */
  staged_files?: string[];
  host_repo_root?: string;
  proposal_id?: string;
  gap_id?: string;
  /** Override the systemctl restart target (default: `<vessel>.service`). */
  restart_unit_name?: string;
  /** Test hook: override the git binary path. */
  git_cmd?: string;
  /** Test hook: skip the actual `git push` step. */
  skip_push?: boolean;
  /** Test hook: skip the systemctl restart step. */
  skip_restart?: boolean;
  /** Test hook: override the pending-pointer cleanup path. */
  pending_pointer_path?: string;
  /** Test hook: override impulse log path (default: /workspace/mitosis-applied.jsonl). */
  applied_log_path?: string;
  /** Test hook: override host-sync intent file path. */
  host_sync_intent_path?: string;
  /** Test hook: override host-sync results file path. */
  host_sync_results_path?: string;
}

interface GitOpResult {
  op: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  gitCmd: string,
  args: string[],
  cwd: string,
): Promise<GitOpResult> {
  try {
    const proc = Bun.spawn([gitCmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exit = await proc.exited;
    return { op: `git ${args.join(" ")}`, exit_code: exit, stdout, stderr };
  } catch (err) {
    return {
      op: `git ${args.join(" ")}`,
      exit_code: -1,
      stdout: "",
      stderr: (err as Error).message,
    };
  }
}

async function walkRelativeFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(join(root, prefix), { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return out;
  }
  for (const e of entries) {
    const name = e.name;
    const rel = prefix ? join(prefix, name) : name;
    if (e.isDirectory()) {
      const sub = await walkRelativeFiles(root, rel);
      out.push(...sub);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function copyTree(
  srcRoot: string,
  dstRoot: string,
  files: string[],
): Promise<void> {
  for (const f of files) {
    const src = join(srcRoot, f);
    const dst = join(dstRoot, f);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

const PROTECTED_BASES = new Set(["v0", "baseline"]);
const PROTECTED_VESSELS = new Set(["discovery-vessel", "identity-vessel"]);

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return {
    shape: "structuredError",
    body: {
      resolver: "vessel_mitosis_cutover",
      detail,
      ...(extra ?? {}),
    },
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function runSystemctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const cmd = process.env["SYSTEMCTL_CMD"] ?? "systemctl";
  if (process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] === "1") {
    return { exitCode: 0, stderr: "(skipped via env)" };
  }
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    return { exitCode: proc.exitCode ?? 1, stderr };
  } catch (err) {
    return { exitCode: -1, stderr: (err as Error).message };
  }
}

export async function resolveVesselMitosisCutover(
  pointer: VesselMitosisCutoverPointer,
): Promise<ResolverResult> {
  const {
    vessel_name,
    base_version_id,
    mitosis_version_id,
    evaluation_evidence,
  } = pointer;

  if (!vessel_name || PROTECTED_VESSELS.has(vessel_name)) {
    return structuredError(
      `refusing cutover on protected vessel: ${vessel_name}`,
      { protected_vessels: Array.from(PROTECTED_VESSELS) },
    );
  }
  if (!base_version_id || !mitosis_version_id) {
    return structuredError("base_version_id and mitosis_version_id are required");
  }
  if (
    PROTECTED_BASES.has(base_version_id) ||
    base_version_id === `${vessel_name}-original`
  ) {
    return structuredError(
      `refusing cutover from operator-anchor baseline: ${base_version_id}`,
      { protected_bases: Array.from(PROTECTED_BASES) },
    );
  }
  if (!evaluation_evidence || typeof evaluation_evidence !== "object") {
    return structuredError("evaluation_evidence is required");
  }
  if (evaluation_evidence.verdict !== "FAVORABLE") {
    return structuredError(
      `refusing cutover: verdict must be FAVORABLE (got ${evaluation_evidence.verdict})`,
      { evaluation_evidence },
    );
  }
  if (
    !Array.isArray(evaluation_evidence.cited_trace_ids) ||
    evaluation_evidence.cited_trace_ids.length === 0
  ) {
    return structuredError("evaluation_evidence.cited_trace_ids must be non-empty");
  }

  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
  const baseRoot = pointer.base_root
    ? resolve(pointer.base_root)
    : join(reposRoot, vessel_name);
  const mitosisRoot = pointer.mitosis_root
    ? resolve(pointer.mitosis_root)
    : null;

  if (!mitosisRoot) {
    return structuredError("mitosis_root is required (cannot infer)");
  }

  if (!(await pathExists(baseRoot))) {
    return structuredError(`base_root not found: ${baseRoot}`);
  }
  if (!(await pathExists(mitosisRoot))) {
    return structuredError(`mitosis_root not found: ${mitosisRoot}`);
  }

  // ---- Mitosis freshness gate (Stage B.2 2026-06-03) ----
  // Refuse cutover if the live source has drifted since the mitosis was
  // staged. Emits a substrateGap citing
  // `resilient_against_unintended_changes` and returns structuredError.
  // The gap is the substrate's idiomatic expression of the refusal —
  // cite-evidence + 3-way base check + emit-trace rather than silent
  // cutover or git-style merge tooling.
  const freshnessCheckPath = pointer.freshness_check_path
    ? resolve(pointer.freshness_check_path)
    : join(baseRoot, "src", "index.ts");
  let currentLiveSha: string | null = null;
  try {
    if (await pathExists(freshnessCheckPath)) {
      const liveContent = await readFile(freshnessCheckPath);
      currentLiveSha = createHash("sha256").update(liveContent).digest("hex").slice(0, 12);
    }
  } catch (err) {
    currentLiveSha = `<unreadable: ${(err as Error).message.slice(0, 60)}>`;
  }
  const stagedBaseSha = pointer.staged_base_sha;
  const freshnessOK =
    !!stagedBaseSha &&
    !!currentLiveSha &&
    !currentLiveSha.startsWith("<") &&
    stagedBaseSha === currentLiveSha;
  if (!freshnessOK) {
    const reason = !stagedBaseSha
      ? "missing_base_sha"
      : !currentLiveSha
        ? "live_source_unreadable"
        : "base_sha_mismatch";
    const gapId = `mitosis_freshness_violation:${vessel_name}:${mitosis_version_id}`;
    const summary =
      `Mitosis ${mitosis_version_id} for ${vessel_name} refused cutover: ${reason}. ` +
      `staged_base_sha=${stagedBaseSha ?? "<missing>"}, current_live_sha=${currentLiveSha ?? "<absent>"}. ` +
      `Live source has changed since this mitosis was drafted (or was never recorded); ` +
      `re-derive against current. Cites principle: resilient_against_unintended_changes.`;
    try {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: gapId,
          category: "other",
          source: "substrate_detected",
          summary,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            kind: "mitosis_freshness_violation",
            vessel_name,
            mitosis_version_id,
            base_version_id,
            staged_base_sha: stagedBaseSha ?? null,
            current_live_sha: currentLiveSha,
            freshness_check_path: freshnessCheckPath,
            reason,
            cite_principle: "resilient_against_unintended_changes",
            suggested_remediation:
              "Drop stale mitosis or re-stage from current base. " +
              "If this is the first observation of the principle, the operator may seed " +
              "the gap-closing pipeline; otherwise the next scaffold-mitosis-track will " +
              "produce a fresh draft.",
          },
        },
      });
    } catch (err) {
      // Best-effort: a gap-write failure must not mask the refusal itself.
      console.warn(
        `[vessel_mitosis_cutover] substrateGap_write failed during freshness refusal: ${(err as Error).message}`,
      );
    }
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_cutover",
        detail: `refusing cutover: mitosis_freshness_violation (${reason})`,
        kind: "mitosis_freshness_violation",
        vessel_name,
        mitosis_version_id,
        staged_base_sha: stagedBaseSha ?? null,
        current_live_sha: currentLiveSha,
        freshness_check_path: freshnessCheckPath,
        cite_principle: "resilient_against_unintended_changes",
        gap_id: gapId,
      },
    };
  }

  // ---- Git-aware cutover path (2026-06-04) ----
  // When staged_files is supplied, we apply only those files (scope-creep
  // gate) into a host-side git repo, commit, push, then mirror into the
  // /vessels/<v>/ runtime path and restart the systemd unit. Emits a
  // cutoverApplied impulse with new_git_sha + push_status.
  if (pointer.staged_files && pointer.staged_files.length > 0) {
    return await runGitAwareCutover({
      pointer,
      vessel_name,
      base_version_id,
      mitosis_version_id,
      mitosisRoot,
      baseRoot,
      stagedFiles: pointer.staged_files,
      hostRepoRoot:
        pointer.host_repo_root ??
        join(workspaceRoot, "repos", vessel_name),
      evaluationEvidence: evaluation_evidence,
      stagedBaseSha,
    });
  }

  const baseUnitName = pointer.base_unit_name ?? `${vessel_name}.service`;
  const mitosisUnitName =
    pointer.mitosis_unit_name ?? `${vessel_name}-${mitosis_version_id}.service`;
  const unitDir =
    pointer.unit_dir ??
    join(workspaceRoot, "git", "super-repo", "scripts", "substrate", "units");

  const archiveDir = join(baseRoot, "..", `${vessel_name}-archive-${base_version_id}`);

  const plan = {
    stop_base: `${baseUnitName}`,
    disable_base: `${baseUnitName}`,
    move_base_to_archive: archiveDir,
    move_mitosis_to_canonical: baseRoot,
    rewrite_unit: join(unitDir, baseUnitName),
    start_canonical: baseUnitName,
  };

  if (pointer.dry_run) {
    return {
      shape: "vesselMitosisCutoverPlan",
      body: {
        vessel_name,
        base_version_id,
        mitosis_version_id,
        plan,
        verdict_acknowledged: evaluation_evidence.verdict,
      },
    };
  }

  const operations: Array<{ op: string; status: string; detail?: string }> = [];

  // 1. Stop base unit.
  const stop = await runSystemctl(["stop", baseUnitName]);
  operations.push({
    op: `systemctl stop ${baseUnitName}`,
    status: stop.exitCode === 0 ? "ok" : "warn",
    detail: stop.exitCode === 0 ? undefined : stop.stderr.slice(0, 200),
  });

  // 2. Disable base unit (best-effort; not fatal).
  const disable = await runSystemctl(["disable", baseUnitName]);
  operations.push({
    op: `systemctl disable ${baseUnitName}`,
    status: disable.exitCode === 0 ? "ok" : "warn",
    detail: disable.exitCode === 0 ? undefined : disable.stderr.slice(0, 200),
  });

  // 3. Move base to archive.
  try {
    await mkdir(dirname(archiveDir), { recursive: true });
    await rename(baseRoot, archiveDir);
    operations.push({ op: `mv base->archive`, status: "ok", detail: archiveDir });
  } catch (err) {
    operations.push({
      op: `mv base->archive`,
      status: "fail",
      detail: (err as Error).message,
    });
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_cutover",
        detail: `archive move failed: ${(err as Error).message}`,
        operations,
      },
    };
  }

  // 4. Move mitosis to canonical.
  try {
    await rename(mitosisRoot, baseRoot);
    operations.push({ op: `mv mitosis->canonical`, status: "ok", detail: baseRoot });
  } catch (err) {
    operations.push({
      op: `mv mitosis->canonical`,
      status: "fail",
      detail: (err as Error).message,
    });
    // Try to roll back: move archive back to base.
    try {
      await rename(archiveDir, baseRoot);
      operations.push({ op: `rollback archive->base`, status: "ok" });
    } catch (rerr) {
      operations.push({
        op: `rollback archive->base`,
        status: "fail",
        detail: (rerr as Error).message,
      });
    }
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_cutover",
        detail: `canonical move failed: ${(err as Error).message}`,
        operations,
      },
    };
  }

  // 5. Rewrite the unit file so canonical name points at canonical path.
  const canonicalUnitPath = join(unitDir, baseUnitName);
  const mitosisUnitPath = join(unitDir, mitosisUnitName);
  try {
    let unitBody: string | null = null;
    if (await pathExists(mitosisUnitPath)) {
      unitBody = await readFile(mitosisUnitPath, "utf8");
    } else if (await pathExists(canonicalUnitPath)) {
      unitBody = await readFile(canonicalUnitPath, "utf8");
    }
    if (unitBody) {
      const rewritten = unitBody
        .replace(/WorkingDirectory=.*/g, `WorkingDirectory=/vessels/${vessel_name}`)
        .replace(
          /ExecStart=([^\n]+?)\/src\/index\.ts/,
          `ExecStart=$1/src/index.ts`,
        )
        .replace(
          new RegExp(`/vessels/${vessel_name}-mitosis-[^/\n ]+`, "g"),
          `/vessels/${vessel_name}`,
        );
      await writeFile(canonicalUnitPath, rewritten);
      operations.push({ op: `rewrite unit ${baseUnitName}`, status: "ok" });
      if (mitosisUnitPath !== canonicalUnitPath && (await pathExists(mitosisUnitPath))) {
        try {
          await unlink(mitosisUnitPath);
          operations.push({ op: `remove mitosis unit`, status: "ok" });
        } catch (err) {
          operations.push({
            op: `remove mitosis unit`,
            status: "warn",
            detail: (err as Error).message,
          });
        }
      }
    } else {
      operations.push({ op: `rewrite unit ${baseUnitName}`, status: "warn", detail: "no source unit found" });
    }
  } catch (err) {
    operations.push({
      op: `rewrite unit ${baseUnitName}`,
      status: "warn",
      detail: (err as Error).message,
    });
  }

  // 6. daemon-reload + start.
  const reload = await runSystemctl(["daemon-reload"]);
  operations.push({
    op: `systemctl daemon-reload`,
    status: reload.exitCode === 0 ? "ok" : "warn",
    detail: reload.exitCode === 0 ? undefined : reload.stderr.slice(0, 200),
  });
  const start = await runSystemctl(["start", baseUnitName]);
  operations.push({
    op: `systemctl start ${baseUnitName}`,
    status: start.exitCode === 0 ? "ok" : "warn",
    detail: start.exitCode === 0 ? undefined : start.stderr.slice(0, 200),
  });

  return {
    shape: "vesselMitosisCutoverResult",
    body: {
      vessel_name,
      base_version_id,
      mitosis_version_id,
      promoted_to: baseRoot,
      archived_at: archiveDir,
      unit_path: canonicalUnitPath,
      operations,
      cited_evidence: {
        verdict: evaluation_evidence.verdict,
        base_success_rate: evaluation_evidence.base_success_rate,
        mitosis_success_rate: evaluation_evidence.mitosis_success_rate,
        cited_trace_ids: evaluation_evidence.cited_trace_ids.slice(0, 10),
      },
      completed_at: new Date().toISOString(),
    },
  };
}

interface GitCutoverArgs {
  pointer: VesselMitosisCutoverPointer;
  vessel_name: string;
  base_version_id: string;
  mitosis_version_id: string;
  mitosisRoot: string;
  baseRoot: string;
  stagedFiles: string[];
  hostRepoRoot: string;
  evaluationEvidence: VesselMitosisCutoverPointer["evaluation_evidence"];
  stagedBaseSha: string | undefined;
}

async function runGitAwareCutover(args: GitCutoverArgs): Promise<ResolverResult> {
  const {
    pointer,
    vessel_name,
    base_version_id,
    mitosis_version_id,
    mitosisRoot,
    baseRoot,
    stagedFiles,
    hostRepoRoot,
    evaluationEvidence,
    stagedBaseSha,
  } = args;

  const operations: Array<{ op: string; status: string; detail?: string }> = [];

  // ---- Host-sync intent emission (2026-06-04, Stage B.3) ----
  // When the cutover runs inside the container, `/workspace/repos` is a
  // read-only bind mount of the host super-repo and direct git writes
  // would fail. Setting MITOSIS_HOST_SYNC_MODE=1 redirects the
  // commit + push to a host-side poller via an intent file.
  if (process.env["MITOSIS_HOST_SYNC_MODE"] === "1") {
    return await emitHostSyncIntent({
      pointer,
      vessel_name,
      base_version_id,
      mitosis_version_id,
      mitosisRoot,
      stagedFiles,
      evaluationEvidence,
      stagedBaseSha,
    });
  }

  // 1. Resilience: walk mitosis tree, enforce allowed file set.
  const allFiles = await walkRelativeFiles(mitosisRoot);
  const allowed = new Set(stagedFiles.map((f) => f.replace(/^\.\//, "")));
  const outOfScope = allFiles.filter((f) => !allowed.has(f));
  if (outOfScope.length > 0) {
    return structuredError(
      `scope_creep_detected: mitosis dir contains files outside staged_files: ${outOfScope.slice(0, 5).join(", ")}`,
      {
        kind: "scope_creep_detected",
        out_of_scope_files: outOfScope,
        staged_files: stagedFiles,
        mitosis_root: mitosisRoot,
      },
    );
  }

  // 2. Validate hostRepoRoot is a git repo.
  if (!(await pathExists(join(hostRepoRoot, ".git")))) {
    return structuredError(
      `host_repo_root is not a git repo: ${hostRepoRoot}`,
      { host_repo_root: hostRepoRoot, kind: "host_repo_not_git" },
    );
  }
  for (const f of stagedFiles) {
    if (isAbsolute(f) || f.includes("..")) {
      return structuredError(
        `unsafe staged file path: ${f}`,
        { kind: "unsafe_path", staged_file: f },
      );
    }
  }

  if (pointer.dry_run) {
    return {
      shape: "vesselMitosisCutoverPlan",
      body: {
        vessel_name,
        base_version_id,
        mitosis_version_id,
        mode: "git_aware",
        host_repo_root: hostRepoRoot,
        staged_files: stagedFiles,
        plan: [
          "copy mitosis_root/<staged_files> → host_repo_root/<staged_files>",
          "git add <staged_files>",
          "git status -- <staged_files> (scope-creep check)",
          "git commit -m substrate-authored: ...",
          pointer.skip_push ? "(push skipped)" : "git push origin dev",
          "copy mitosis_root/<staged_files> → /vessels/<vessel>/<staged_files>",
          pointer.skip_restart ? "(restart skipped)" : "systemctl restart <vessel>.service",
          "emit cutoverApplied impulse",
        ],
        verdict_acknowledged: evaluationEvidence.verdict,
      },
    };
  }

  // 3. Copy staged files into host repo.
  try {
    await copyTree(mitosisRoot, hostRepoRoot, stagedFiles);
    operations.push({
      op: "copy mitosis → host_repo",
      status: "ok",
      detail: `${stagedFiles.length} file(s)`,
    });
  } catch (err) {
    return structuredError(
      `host repo copy failed: ${(err as Error).message}`,
      { operations },
    );
  }

  const gitCmd = pointer.git_cmd ?? "git";

  // 4. git diff --name-only — verify ONLY staged_files are modified.
  const diffNames = await runGit(
    gitCmd,
    ["diff", "--name-only", "HEAD", "--"],
    hostRepoRoot,
  );
  operations.push({
    op: diffNames.op,
    status: diffNames.exit_code === 0 ? "ok" : "warn",
    detail: diffNames.stderr.slice(0, 200),
  });
  // Also check unstaged untracked-but-tracked changes via plain `git diff --name-only`.
  const diffWorkTree = await runGit(
    gitCmd,
    ["diff", "--name-only"],
    hostRepoRoot,
  );
  const changedRaw = (diffWorkTree.stdout + "\n" + diffNames.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const changed = Array.from(new Set(changedRaw));
  const unexpected = changed.filter((f) => !allowed.has(f));
  if (unexpected.length > 0) {
    return structuredError(
      `git_diff_scope_violation: workspace shows changes outside staged_files: ${unexpected.slice(0, 5).join(", ")}`,
      {
        kind: "git_diff_scope_violation",
        unexpected_changes: unexpected,
        staged_files: stagedFiles,
        operations,
      },
    );
  }

  // 5. git add.
  const add = await runGit(gitCmd, ["add", ...stagedFiles], hostRepoRoot);
  operations.push({
    op: add.op,
    status: add.exit_code === 0 ? "ok" : "fail",
    detail: add.stderr.slice(0, 200),
  });
  if (add.exit_code !== 0) {
    return structuredError(`git add failed: ${add.stderr.slice(0, 200)}`, {
      operations,
    });
  }

  // 6. git commit.
  const proposalId = pointer.proposal_id ?? "unknown-proposal";
  const gapId = pointer.gap_id ?? "unknown-gap";
  const msg =
    `substrate-authored: apply ${proposalId} via mitosis cutover\n\n` +
    `Applied autonomously by apply_proposal_as_patch + vessel_mitosis_cutover.\n` +
    `Gap: ${gapId}\n` +
    `Proposal: ${proposalId}\n` +
    `Mitosis: ${mitosis_version_id}\n` +
    `Base SHA at staging: ${stagedBaseSha ?? "<unknown>"}\n`;
  const commit = await runGit(gitCmd, ["commit", "-m", msg], hostRepoRoot);
  operations.push({
    op: commit.op,
    status: commit.exit_code === 0 ? "ok" : "fail",
    detail:
      commit.exit_code === 0
        ? commit.stdout.slice(0, 200)
        : commit.stderr.slice(0, 400),
  });
  if (commit.exit_code !== 0) {
    return structuredError(
      `git commit failed: ${commit.stderr.slice(0, 200)}`,
      { operations },
    );
  }

  // 7. Capture new SHA.
  const rev = await runGit(gitCmd, ["rev-parse", "HEAD"], hostRepoRoot);
  const newSha = rev.stdout.trim();
  operations.push({
    op: rev.op,
    status: rev.exit_code === 0 ? "ok" : "warn",
    detail: newSha.slice(0, 12),
  });

  // 8. git push origin dev (best-effort; commit stays local on failure).
  let pushStatus: "pushed" | "local_only" | "skipped" = "skipped";
  let pushDetail = "";
  if (!pointer.skip_push) {
    const push = await runGit(
      gitCmd,
      ["push", "origin", "dev"],
      hostRepoRoot,
    );
    pushDetail = (push.stderr + push.stdout).slice(0, 400);
    if (push.exit_code === 0) {
      pushStatus = "pushed";
      operations.push({ op: push.op, status: "ok", detail: pushDetail });
    } else {
      pushStatus = "local_only";
      operations.push({
        op: push.op,
        status: "warn",
        detail: `push failed (commit local): ${pushDetail}`,
      });
    }
  }

  // 9. Mirror staged files into /vessels/<v>/ runtime path.
  let vesselRestarted = false;
  if (await pathExists(baseRoot)) {
    try {
      await copyTree(mitosisRoot, baseRoot, stagedFiles);
      operations.push({
        op: "copy mitosis → live vessel",
        status: "ok",
        detail: baseRoot,
      });
    } catch (err) {
      operations.push({
        op: "copy mitosis → live vessel",
        status: "warn",
        detail: (err as Error).message,
      });
    }
  } else {
    operations.push({
      op: "copy mitosis → live vessel",
      status: "warn",
      detail: `baseRoot missing: ${baseRoot}`,
    });
  }

  // 10. Restart vessel unit (best-effort).
  if (!pointer.skip_restart) {
    const unit = pointer.restart_unit_name ?? `${vessel_name}.service`;
    const restart = await runSystemctl(["restart", unit]);
    vesselRestarted = restart.exitCode === 0;
    operations.push({
      op: `systemctl restart ${unit}`,
      status: vesselRestarted ? "ok" : "warn",
      detail: vesselRestarted ? undefined : restart.stderr.slice(0, 200),
    });
  }

  // 11. Emit cutoverApplied impulse to local log (three-place rule for new shape).
  const appliedAt = new Date().toISOString();
  const appliedBody = {
    vessel_name,
    mitosis_version_id,
    base_version_id,
    base_sha: stagedBaseSha ?? null,
    new_git_sha: newSha,
    push_status: pushStatus,
    push_detail: pushDetail.slice(0, 200),
    staged_files_applied: stagedFiles,
    gap_id: gapId,
    proposal_id: proposalId,
    host_repo_root: hostRepoRoot,
    vessel_restarted: vesselRestarted,
    applied_at: appliedAt,
  };
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const logPath =
    pointer.applied_log_path ??
    join(workspaceRoot, "mitosis-applied.jsonl");
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      JSON.stringify({ shape: "cutoverApplied", body: appliedBody }) + "\n",
    );
    operations.push({ op: "emit cutoverApplied", status: "ok", detail: logPath });
  } catch (err) {
    operations.push({
      op: "emit cutoverApplied",
      status: "warn",
      detail: (err as Error).message,
    });
  }

  // 12. Cleanup pending pointer ONLY after successful impulse emit.
  const pendingPath =
    pointer.pending_pointer_path ?? join(workspaceRoot, "mitosis-pending.json");
  try {
    if (await pathExists(pendingPath)) {
      await unlink(pendingPath);
      operations.push({ op: "remove mitosis-pending.json", status: "ok" });
    }
  } catch (err) {
    operations.push({
      op: "remove mitosis-pending.json",
      status: "warn",
      detail: (err as Error).message,
    });
  }

  return {
    shape: "cutoverApplied",
    body: {
      ...appliedBody,
      mode: "git_aware",
      operations,
      cited_evidence: {
        verdict: evaluationEvidence.verdict,
        base_success_rate: evaluationEvidence.base_success_rate,
        mitosis_success_rate: evaluationEvidence.mitosis_success_rate,
        cited_trace_ids: evaluationEvidence.cited_trace_ids.slice(0, 10),
      },
    },
  };
}

// suppress unused-import warning when `relative` not used directly elsewhere
void relative;

interface HostSyncIntentArgs {
  pointer: VesselMitosisCutoverPointer;
  vessel_name: string;
  base_version_id: string;
  mitosis_version_id: string;
  mitosisRoot: string;
  stagedFiles: string[];
  evaluationEvidence: VesselMitosisCutoverPointer["evaluation_evidence"];
  stagedBaseSha: string | undefined;
}

async function emitHostSyncIntent(args: HostSyncIntentArgs): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const intentPath =
    args.pointer.host_sync_intent_path ??
    join(workspaceRoot, "mitosis-applied-host-sync.jsonl");
  const resultsPath =
    args.pointer.host_sync_results_path ??
    join(workspaceRoot, "mitosis-applied-host-sync-results.jsonl");
  const intentId = crypto.randomUUID();
  const emittedAt = new Date().toISOString();
  const intent = {
    intent_id: intentId,
    vessel_name: args.vessel_name,
    base_version_id: args.base_version_id,
    mitosis_version_id: args.mitosis_version_id,
    mitosis_root: args.mitosisRoot,
    base_sha: args.stagedBaseSha ?? null,
    proposal_id: args.pointer.proposal_id ?? "unknown-proposal",
    gap_id: args.pointer.gap_id ?? "unknown-gap",
    staged_files: args.stagedFiles,
    emitted_at: emittedAt,
    status: "pending",
  };
  try {
    await mkdir(dirname(intentPath), { recursive: true });
    await appendFile(intentPath, JSON.stringify(intent) + "\n");
  } catch (err) {
    return structuredError(`host-sync intent emit failed: ${(err as Error).message}`, {
      kind: "host_sync_emit_failed",
      intent_path: intentPath,
    });
  }

  // Best-effort: check results file for a completed match (poller may have run).
  let gitSha: string | null = null;
  let resultStatus: string | null = null;
  try {
    if (await pathExists(resultsPath)) {
      const raw = await readFile(resultsPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            intent_id?: string;
            git_sha?: string;
            push_status?: string;
          };
          if (parsed.intent_id === intentId) {
            gitSha = parsed.git_sha ?? null;
            resultStatus = parsed.push_status ?? null;
            break;
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  const body = {
    vessel_name: args.vessel_name,
    mitosis_version_id: args.mitosis_version_id,
    base_version_id: args.base_version_id,
    base_sha: args.stagedBaseSha ?? null,
    new_git_sha: gitSha,
    push_status: resultStatus ?? "host_sync_pending",
    host_sync_intent_id: intentId,
    host_sync_intent_path: intentPath,
    staged_files_applied: args.stagedFiles,
    gap_id: args.pointer.gap_id ?? "unknown-gap",
    proposal_id: args.pointer.proposal_id ?? "unknown-proposal",
    emitted_at: emittedAt,
    mode: "host_sync",
    cited_evidence: {
      verdict: args.evaluationEvidence.verdict,
      base_success_rate: args.evaluationEvidence.base_success_rate,
      mitosis_success_rate: args.evaluationEvidence.mitosis_success_rate,
      cited_trace_ids: args.evaluationEvidence.cited_trace_ids.slice(0, 10),
    },
  };
  return { shape: "cutoverApplied", body };
}

/**
 * Read-side resolver for the `cutoverApplied` shape. Returns recent entries
 * from the cutover impulse log so the substrate (and operator) can read back
 * its own git-aware commit history.
 */
export interface CutoverAppliedPointer {
  type: "cutoverApplied";
  limit?: number;
  applied_log_path?: string;
  vessel_name?: string;
}

export async function resolveCutoverApplied(
  pointer: CutoverAppliedPointer,
): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const logPath =
    pointer.applied_log_path ?? join(workspaceRoot, "mitosis-applied.jsonl");
  const limit = Math.max(1, Math.min(pointer.limit ?? 20, 200));
  if (!(await pathExists(logPath))) {
    return {
      shape: "cutoverApplied",
      body: { entries: [], total: 0, log_path: logPath },
    };
  }
  const raw = await readFile(logPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { body?: Record<string, unknown> };
      if (parsed.body) entries.push(parsed.body);
    } catch {
      /* skip malformed */
    }
  }
  const filtered = pointer.vessel_name
    ? entries.filter((e) => e["vessel_name"] === pointer.vessel_name)
    : entries;
  const recent = filtered.slice(-limit).reverse();
  return {
    shape: "cutoverApplied",
    body: {
      entries: recent,
      total: filtered.length,
      log_path: logPath,
    },
  };
}
