// vessel-mitosis-cutover: applies a staged mitosis dir over the live vessel root via atomic rename.
// Refuses with a freshness-gate failure when the staged base_sha no longer matches the current
// live source, preventing accidental overwrites of concurrent edits.

import { resolve, join, dirname, relative, isAbsolute, basename } from "path";
import fs from "node:fs/promises";
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
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";
import { resolveTestSuite } from "./test-suite.js";
import { runBehavioralVerification } from "./behavioral-verification.js";
import { resolveActivateSubstrateScript } from "./activate-substrate-script.js";
import { resolveMaintenanceLeaseWrite } from "./maintenance-lease";

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
    /**
     * Names of static checks (lint, tests) that passed on the
     * static-evaluation FAVORABLE path. Accepted as cited evidence in lieu
     * of runtime traces when present (2026-06-04 cutover policy fix).
     */
    cited_check_names?: string[];
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
  adhoc?: boolean;
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

/**
 * Soft-refuse with optional host-sync intent fallback (Part A, 2026-06-04).
 *
 * When the cutover refuses for a class of reason where the cutover-side
 * verification is structurally weaker than the host-side poller (e.g.
 * INSUFFICIENT_DATA verdict because the container's activity-api view is
 * sparse; live_source_unreadable / base_sha_mismatch because the container's
 * bind mount lags the host tree), AND a non-empty mitosis dir with a real
 * diff vs the host exists, AND `MITOSIS_HOST_SYNC_MODE=1`, we still emit
 * the host-sync intent. The host-sync poller runs its own freshness check
 * against the real host source — moving the safety verdict from cutover-side
 * (wrong baseRoot) to host-sync-side (real host paths).
 *
 * UNFAVORABLE is never emitted: a static-eval FAIL means the patch broke
 * lint/tests and the substrate must not push it regardless of where the
 * freshness check lives. `missing_base_sha` is never emitted either — without
 * a recorded baseline the host-side poller has nothing to verify against.
 */
async function maybeEmitIntentForRefuse(args: {
  pointer: VesselMitosisCutoverPointer;
  vessel_name: string;
  base_version_id: string;
  mitosis_version_id: string;
  evaluation_evidence: VesselMitosisCutoverPointer["evaluation_evidence"];
  staged_base_sha?: string;
  refuse_class: "insufficient_data_verdict" | "live_source_unreadable" | "base_sha_mismatch";
}): Promise<ResolverResult | null> {
  if (process.env["MITOSIS_HOST_SYNC_MODE"] !== "1") return null;
  const { pointer } = args;
  // Require an explicit mitosis_root + staged_files: host-sync intent is
  // pointer-driven; without these the poller cannot identify what to apply.
  if (!pointer.mitosis_root) return null;
  if (!Array.isArray(pointer.staged_files) || pointer.staged_files.length === 0) {
    return null;
  }
  const mitosisRoot = resolve(pointer.mitosis_root);
  if (!(await pathExists(mitosisRoot))) return null;
  // Verify at least one staged file is present in the mitosis dir AND differs
  // from its baseRoot counterpart (or has no counterpart). A mitosis with no
  // real diff is a no-op; don't churn the poller queue with no-op intents.
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
  const baseRoot = pointer.base_root
    ? resolve(pointer.base_root)
    : join(reposRoot, args.vessel_name);
  let hasRealDiff = false;
  for (const rel of pointer.staged_files) {
    if (isAbsolute(rel) || rel.includes("..")) continue;
    const mPath = join(mitosisRoot, rel);
    if (!(await pathExists(mPath))) continue;
    try {
      const mContent = await readFile(mPath);
      const bPath = join(baseRoot, rel);
      if (!(await pathExists(bPath))) {
        hasRealDiff = true;
        break;
      }
      const bContent = await readFile(bPath);
      if (!mContent.equals(bContent)) {
        hasRealDiff = true;
        break;
      }
    } catch {
      // unreadable on this side; let the host-sync poller decide
      hasRealDiff = true;
      break;
    }
  }
  if (!hasRealDiff) return null;
  const intent = await emitHostSyncIntent({
    pointer,
    vessel_name: args.vessel_name,
    base_version_id: args.base_version_id,
    mitosis_version_id: args.mitosis_version_id,
    mitosisRoot,
    stagedFiles: pointer.staged_files,
    evaluationEvidence: args.evaluation_evidence,
    stagedBaseSha: args.staged_base_sha,
  });
  // Annotate the body so observers can distinguish "FAVORABLE → emit" from
  // "soft-refuse → host-sync defers verification".
  if (intent.shape === "cutoverApplied" && intent.body && typeof intent.body === "object") {
    (intent.body as Record<string, unknown>)["emitted_via_refuse_fallback"] = true;
    (intent.body as Record<string, unknown>)["refuse_class"] = args.refuse_class;
  }
  return intent;
}

/**
 * Soft-refuse: returned when the audited NO is a normal outcome of the
 * evaluate→cutover chain (verdict ≠ FAVORABLE, insufficient cited traces,
 * stale base SHA, etc). Emits `vesselMitosisCutoverResult` with applied:false
 * so light-dispatch / activity-api treat the trace as success — the refuse
 * itself IS the substrate's audited NO, not a chain failure. Distinct from
 * `structuredError`, which is reserved for genuine misconfiguration
 * (missing required field, vessel-not-found, etc).
 */
function softRefuse(
  refusal_reason: string,
  extra?: Record<string, unknown>,
): ResolverResult {
  // V38 (2026-06-12): log the audited-NO reason. soft-refuse returns
  // applied:false as a "success" shape, so without this the cutover-apply
  // boundary is as silent as patch_with_tools was — mitosis-tick shows
  // "completed" while nothing landed and no reason surfaces in the trace.
  console.error(`[mitosis-cutover] REFUSE: ${refusal_reason}${extra ? ` ${JSON.stringify(extra).slice(0, 200)}` : ""}`);
  return {
    shape: "vesselMitosisCutoverResult",
    body: {
      resolver: "vessel_mitosis_cutover",
      applied: false,
      refused: true,
      refusal_reason,
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

/**
 * Best-effort clear of the /workspace/mitosis-pending.json queue lock on a
 * TERMINAL reject/refuse (2026-06-30, gap cutover-stale-pending-lock-on-reject).
 *
 * The no-op "already-applied" path (~line 668) and the success path (step 12)
 * both unlink the pending pointer, but the terminal REJECT (stale_mitosis,
 * unfavorable_verdict) and REFUSE (missing_base_sha / freshness violation)
 * paths did NOT — so a failed staging left mitosis-pending.json in place and
 * apply-proposal-as-patch then refused every new proposal with "pending mitosis
 * in flight" until the ~30min lock TTL expired, livelocking the funnel.
 *
 * These are terminal decision points (evaluate has already decided NO), so
 * clearing the queue lock is safe — nothing further will consume the pending
 * pointer on this path. Mirrors the unlink at the already-applied no-op path.
 */
async function clearPendingOnReject(
  pointer: VesselMitosisCutoverPointer,
  workspaceRoot: string,
): Promise<void> {
  const pendingPath =
    pointer.pending_pointer_path ?? join(workspaceRoot, "mitosis-pending.json");
  try {
    if (await pathExists(pendingPath)) {
      await unlink(pendingPath);
      console.error("[mitosis-cutover] cleared pending on reject");
    }
  } catch {
    /* best-effort: a failed clear must not mask the refusal itself */
  }
}

/**
 * Clear the queue lock ONLY when it belongs to THIS mitosis (exact
 * mitosis_version_id match), so a concurrently-staged NEXT cutover's pending
 * pointer is never clobbered. Called from the runGitAwareCutover finally so any
 * freshnessOK-path terminal exit (host-sync handoff return, structuredError /
 * softRefuse reject, or an uncaught throw) can no longer orphan
 * mitosis-pending.json and freeze ALL pull-sync for the lock's TTL.
 */
async function clearPendingIfOwned(
  pointer: VesselMitosisCutoverPointer,
  workspaceRoot: string,
  mitosisVersionId: string | undefined,
): Promise<boolean> {
  if (!mitosisVersionId) return false;
  const pendingPath =
    pointer.pending_pointer_path ?? join(workspaceRoot, "mitosis-pending.json");
  try {
    if (!(await pathExists(pendingPath))) return false;
    const cur = JSON.parse(await readFile(pendingPath, "utf-8")) as { mitosis_version_id?: string };
    if (cur.mitosis_version_id !== mitosisVersionId) return false;
    await unlink(pendingPath);
    console.error(`[mitosis-cutover] cleared owned pending lock (${mitosisVersionId}) on cutover exit`);
    return true;
  } catch {
    /* best-effort: a failed clear must not mask the cutover result; a foreign or
       unparseable lock is left for pull-sync's TTL backstop */
    return false;
  }
}

/**
 * SELF-ACTIVATION wiring (2026-06-26). Substrate timer scripts
 * (scripts/substrate/*.ts) run from a writable run-dir
 * (SUBSTRATE_RUN_DIR=/workspace/active-scripts) seeded fresh at boot; the unit
 * ExecStarts reference ${SUBSTRATE_RUN_DIR}/<name>.ts. The read-only host bind
 * is stale-after-mount, so a substrate-AUTHORED new version of a timer script
 * mirrored/committed by the cutover does NOT take effect until a full container
 * restart — the autonomy loop's authored output never goes live.
 *
 * Bridge: when a cutover/authoring step stages a scripts/substrate/*.ts file, we
 * ALSO call the activate_substrate_script resolver in-process with the new
 * content, overwriting the run-dir copy so the change is live on the NEXT timer
 * firing — in addition to (never replacing) the git/host-sync durability path.
 *
 * Strictly scoped to scripts/substrate/*.ts staged files (never vessel source),
 * and strictly non-fatal: any failure here is recorded as a warn op and never
 * blocks the cutover. The activate resolver itself is replace-only + path-safe
 * (basename, must already exist in the run-dir), so the blast radius is bounded
 * to already-seeded timer scripts.
 */
async function maybeActivateSubstrateScripts(args: {
  mitosisRoot: string;
  stagedFiles: string[];
}): Promise<Array<{ op: string; status: "ok" | "warn"; detail?: string }>> {
  const ops: Array<{ op: string; status: "ok" | "warn"; detail?: string }> = [];
  const runDir = process.env["SUBSTRATE_RUN_DIR"] || "/workspace/active-scripts";
  // Match scripts/substrate/<name>.ts anywhere in the staged relative path.
  const SUBSTRATE_SCRIPT_RE = /(?:^|\/)scripts\/substrate\/([A-Za-z0-9._-]+\.ts)$/;
  for (const rel of args.stagedFiles) {
    if (typeof rel !== "string") continue;
    if (isAbsolute(rel) || rel.includes("..")) continue;
    const m = rel.match(SUBSTRATE_SCRIPT_RE);
    if (!m) continue;
    const scriptName = basename(m[1]!);
    const srcPath = join(args.mitosisRoot, rel);
    let content: string;
    try {
      content = await readFile(srcPath, "utf-8");
    } catch (err) {
      ops.push({
        op: `activate_substrate_script ${scriptName}`,
        status: "warn",
        detail: `read staged content failed: ${(err as Error).message.slice(0, 160)}`,
      });
      continue;
    }
    try {
      const res = await resolveActivateSubstrateScript({
        type: "activate_substrate_script",
        script: scriptName,
        content,
        runDir,
      });
      const body = (res.body ?? {}) as Record<string, unknown>;
      const activated = body["activated"] === true;
      ops.push({
        op: `activate_substrate_script ${scriptName}`,
        status: activated ? "ok" : "warn",
        detail: activated
          ? `run-dir live (changed=${String(body["changed"])}, ${String(body["bytes"])}B)`
          : `not activated: ${String(body["error"] ?? "unknown")}`.slice(0, 200),
      });
    } catch (err) {
      // Non-fatal by contract: a failed activation never blocks the cutover.
      ops.push({
        op: `activate_substrate_script ${scriptName}`,
        status: "warn",
        detail: `activation threw (non-fatal): ${(err as Error).message.slice(0, 160)}`,
      });
    }
  }
  return ops;
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
  } = pointer;

  // Defensive parse: when dispatched via goal-host, the engine's accumulated-
  // variable interpolation JSON.stringifies non-scalar values (its
  // interpolateProxyValue lacks the exact-match whole-object substitution
  // light-dispatch added in 0596e7bd). So `{{evaluate_pair_content}}` arrives
  // here as a JSON string, not an object, and the typeof-object check below
  // would throw structuredError → silent task drop in the engine top-level
  // catch (engine.ts ~line 578) → trace lands as status=failure with the
  // conditional_cutover task missing from .tasks entirely. Restore object
  // form here so both dispatcher paths converge on the same downstream
  // shape contract.
  //
  // Fix anchors:
  //   concept_K-NGhlSQ3grT — mitosis cutover chain post-fix state 2026_06_04
  //   concept_jhOVI4a8DfMD — substrate durable gap closure verified 2026_06_04
  //   concept_Orn4yVaJYD24 — operator audit becomes tick template
  // Coerce evaluation_evidence from JSON string → object when the engine's
  // interpolateProxyValue emits a stringified value instead of the live object.
  // Without this guard, typeof-object checks below throw structuredError and the
  // conditional_cutover task silently drops from the trace (engine.ts ~line 578).
  if (typeof pointer.evaluation_evidence === "string") {
    try {
      pointer = { ...pointer, evaluation_evidence: JSON.parse(pointer.evaluation_evidence) };
    } catch {
      // Leave as-is; downstream validation will surface the malformed value.
    }
  }
  let evaluation_evidence: VesselMitosisCutoverPointer["evaluation_evidence"] =
    pointer.evaluation_evidence;
  if (typeof (evaluation_evidence as unknown) === "string") {
    const raw = (evaluation_evidence as unknown as string).trim();
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        evaluation_evidence = JSON.parse(raw) as typeof evaluation_evidence;
      } catch {
        // leave as string — the typeof guard below will reject it
      }
    }
  }

  // V38 (2026-06-12): same defensive parse for staged_files. The engine
  // JSON.stringifies the array, so {{extract_staged_files_content}} arrives as
  // the literal string '["src/...ts"]'. Every Array.isArray(pointer.staged_files)
  // check below (host-sync intent gate ~line 225, apply path ~502) would then
  // fail silently, so the cutover could neither apply nor emit a host-sync
  // intent — the staged patch sat forever. Same root cause fixed in
  // vessel-mitosis-evaluate (the evaluate fell through to the trace path).
  if (typeof (pointer.staged_files as unknown) === "string") {
    try {
      const p = JSON.parse(pointer.staged_files as unknown as string);
      if (Array.isArray(p)) (pointer as { staged_files?: string[] }).staged_files = p as string[];
    } catch { /* leave as-is — downstream array checks will treat it as absent */ }
  }

  // V9 (2026-06-05): field validation precedes protected-vessel guard.
  // Previously a pointer with no `vessel_name` produced the misleading error
  // `refusing cutover on protected vessel: undefined`. Required-field validation
  // should fire first so the operator/substrate gets a typed
  // missing-field error before the safety guard runs.
  if (!vessel_name && !base_version_id && !mitosis_version_id) {
    return {
      shape: "vesselMitosisCutoverResult",
      body: {
        skipped: true,
        skip_reason: "no_pending_mitosis",
        cutover_applied: false,
      },
    };
  }
  if (!vessel_name) {
    return structuredError("missing required field: vessel_name");
  }
  if (!base_version_id) {
    return structuredError("missing required field: base_version_id");
  }
  if (!mitosis_version_id) {
    return structuredError("missing required field: mitosis_version_id");
  }
  if (PROTECTED_VESSELS.has(vessel_name)) {
    return structuredError(
      `refusing cutover on protected vessel: ${vessel_name}`,
      { protected_vessels: Array.from(PROTECTED_VESSELS) },
    );
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
    // Missing evaluation_evidence is a misconfiguration (template forgot to
    // pass {{evaluate_pair}}); keep this as a hard error so the bug is loud.
    return structuredError("evaluation_evidence is required");
  }
  console.error(`[mitosis-cutover] verdict=${evaluation_evidence.verdict} cited_checks=${JSON.stringify(evaluation_evidence.cited_check_names ?? null)} cited_traces=${Array.isArray(evaluation_evidence.cited_trace_ids) ? evaluation_evidence.cited_trace_ids.length : 0} base_sha=${pointer.staged_base_sha} host_sync=${process.env["MITOSIS_HOST_SYNC_MODE"] ?? "unset"} host_repo_root=${pointer.host_repo_root ?? process.env["MITOSIS_HOST_REPO_ROOT"] ?? "unset"}`);
  // Freshness gate: surface staleness/push-readiness rejections explicitly so
  // mitoses don't get stuck silently in EVALUATE_OR_CUTOVER. The staged_base_sha
  // freshness is re-checked against the live source below (assertFreshness), but
  // we log the inputs up front so an unfavorable verdict / stale base / not-ready
  // push surface a clear reason in the tick log.
  {
    const stagedAgeMs = typeof (pointer as any).staged_at_ms === "number"
      ? Date.now() - (pointer as any).staged_at_ms
      : null;
    const freshnessMaxAgeMs = Number(process.env["MITOSIS_STAGED_MAX_AGE_MS"] ?? "") || null;
    const stale = stagedAgeMs != null && freshnessMaxAgeMs != null && stagedAgeMs > freshnessMaxAgeMs;
    console.error(`[mitosis-cutover] gate verdict=${evaluation_evidence.verdict} staged_age_ms=${stagedAgeMs ?? "unknown"} max_age_ms=${freshnessMaxAgeMs ?? "unset"} stale=${stale} push_ready=${process.env["MITOSIS_DIRECT_PUSH"] === "1" ? "direct" : (process.env["MITOSIS_HOST_SYNC_MODE"] ?? "unset")}`);
    if (stale) {
      console.error(`[mitosis-cutover] REJECT reason=stale_mitosis staged_age_ms=${stagedAgeMs} max_age_ms=${freshnessMaxAgeMs}`);
      await clearPendingOnReject(pointer, process.env["WORKSPACE_ROOT"] ?? process.cwd());
      return softRefuse(
        `staged mitosis is stale (age ${stagedAgeMs}ms exceeds MITOSIS_STAGED_MAX_AGE_MS=${freshnessMaxAgeMs}ms)`,
        { staged_age_ms: stagedAgeMs, max_age_ms: freshnessMaxAgeMs, refuse_class: "stale_mitosis" },
      );
    }
  }
  if (evaluation_evidence.verdict !== "FAVORABLE") {
    console.error(`[mitosis-cutover] REJECT reason=unfavorable_verdict verdict=${evaluation_evidence.verdict}`);
    // Audited NO — normal outcome when verdict is INSUFFICIENT_DATA / NEUTRAL /
    // UNFAVORABLE. Soft-refuse so mitosis-tick doesn't show as failure on every
    // tick when there's nothing to cut over.
    //
    // Part A (2026-06-04): for INSUFFICIENT_DATA / NEUTRAL — verdicts where the
    // cutover-side evaluation is structurally weaker than the host-side poller
    // can verify — still emit a host-sync intent if we have a real diff. The
    // poller re-verifies against the host source. UNFAVORABLE is a static-eval
    // FAIL and must never emit.
    const v = evaluation_evidence.verdict;
    if (v === "INSUFFICIENT_DATA" || v === "NEUTRAL" || v == null) {
      const intent = await maybeEmitIntentForRefuse({
        pointer,
        vessel_name,
        base_version_id,
        mitosis_version_id,
        evaluation_evidence,
        staged_base_sha: pointer.staged_base_sha,
        refuse_class: "insufficient_data_verdict",
      });
      if (intent) return intent;
    }
    await clearPendingOnReject(pointer, process.env["WORKSPACE_ROOT"] ?? process.cwd());
    return softRefuse(
      `verdict not FAVORABLE (got ${evaluation_evidence.verdict})`,
      { verdict: evaluation_evidence.verdict, evaluation_evidence },
    );
  }
  const traceCount = Array.isArray(evaluation_evidence.cited_trace_ids)
    ? evaluation_evidence.cited_trace_ids.length
    : 0;
  const checkCount = Array.isArray(evaluation_evidence.cited_check_names)
    ? evaluation_evidence.cited_check_names.length
    : 0;
  if (traceCount === 0 && checkCount === 0) {
    return softRefuse(
      "no cited evidence in evaluation_evidence — neither runtime traces " +
        "(cited_trace_ids) nor static checks (cited_check_names) were " +
        "provided for the mitosis pair",
      { verdict: evaluation_evidence.verdict },
    );
  }

  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  const reposRoot = join(workspaceRoot, "git", "super-repo", "repos");
  // Direct-push mode (MITOSIS_DIRECT_PUSH=1): the cutover commits+pushes to a
  // writable in-container clone (MITOSIS_PUSH_CLONE_DIR/<vessel>) and mirrors
  // into the LIVE runtime, instead of emitting a host-sync intent. In that mode
  // baseRoot — the mirror target AND the freshness-check root — must be the live
  // runtime (/vessels/<v> via MITOSIS_RUNTIME_DIR) so (a) the freshness gate
  // compares against the same file apply-proposal-as-patch hashed (killing the
  // base_sha path-mismatch livelock), and (b) the mirror+restart makes the
  // committed change live. host_repo_root (the commit/push clone) is resolved at
  // the runGitAwareCutover call below.
  const directPush = process.env["MITOSIS_DIRECT_PUSH"] === "1";
  const runtimeDir = process.env["MITOSIS_RUNTIME_DIR"];
  const cloneDir = process.env["MITOSIS_PUSH_CLONE_DIR"];
  const baseRoot = pointer.base_root
    ? resolve(pointer.base_root)
    : directPush && runtimeDir
      ? join(runtimeDir, vessel_name)
      : join(reposRoot, vessel_name);
  const mitosisRoot = pointer.mitosis_root
    ? resolve(pointer.mitosis_root)
    : null;

  // Missing-path conditions are audited "no" decisions, not bugs — the
  // substrate's correct response is to soft-refuse with a clean trace
  // (vesselMitosisCutoverResult{applied:false}) so the refuse becomes a
  // durable Thompson observation, NOT a structuredError (which the engine's
  // top-level catch drops, leaving status=failure with no audit signal).
  // Same pattern as 74542cc applied for non-FAVORABLE + this commit's
  // siblings for empty cited evidence.
  if (!mitosisRoot) {
    return softRefuse(
      "mitosis_root not supplied — cutover cannot identify the staged tree",
      { verdict: evaluation_evidence.verdict, pointer_keys: Object.keys(pointer) },
    );
  }

  if (!(await pathExists(baseRoot))) {
    return softRefuse(
      `base_root not found on disk: ${baseRoot}`,
      { verdict: evaluation_evidence.verdict, base_root: baseRoot },
    );
  }
  if (!(await pathExists(mitosisRoot))) {
    return softRefuse(
      `mitosis_root not found on disk: ${mitosisRoot}`,
      { verdict: evaluation_evidence.verdict, mitosis_root: mitosisRoot },
    );
  }

  // ---- Mitosis freshness gate (Stage B.2 2026-06-03) ----
  // Refuse cutover if the live source has drifted since the mitosis was
  // staged. Emits a substrateGap citing
  // `resilient_against_unintended_changes` and returns structuredError.
  // The gap is the substrate's idiomatic expression of the refusal —
  // cite-evidence + 3-way base check + emit-trace rather than silent
  // cutover or git-style merge tooling.
  // Default freshness sentinel to the first staged file. apply-proposal-as-patch
  // computes staged_base_sha by hashing the file it patches, not src/index.ts —
  // so comparing against src/index.ts produces base_sha_mismatch on every
  // mitosis whose target isn't src/index.ts. Hashing the same file apply
  // hashed makes the freshness invariant ("the file we're about to overwrite
  // hasn't drifted since staging") actually testable.
  const stagedSentinel =
    Array.isArray(pointer.staged_files) && pointer.staged_files.length > 0
      ? pointer.staged_files[0]
      : null;
  const freshnessCheckPath = pointer.freshness_check_path
    ? resolve(pointer.freshness_check_path)
    : stagedSentinel
      ? join(baseRoot, stagedSentinel)
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
  // A staged base sha equal to the empty-content sha combined with an ABSENT
  // live file is exactly the net-new-file assertion the staging leg made
  // (patch_with_tools is_new_file / feature_compose create) - absence is
  // freshness, not unreadability.
  const EMPTY_CONTENT_SHA = createHash("sha256").update("").digest("hex").slice(0, 12);
  const netNewFreshnessOK = stagedBaseSha === EMPTY_CONTENT_SHA && currentLiveSha === null;
  const freshnessOK =
    netNewFreshnessOK ||
    (!!stagedBaseSha &&
    !!currentLiveSha &&
    !currentLiveSha.startsWith("<") &&
    stagedBaseSha === currentLiveSha);
  console.error(`[mitosis-cutover] freshness vessel=${vessel_name} mitosis=${mitosis_version_id} staged_base_sha=${stagedBaseSha ?? "<missing>"} current_live_sha=${currentLiveSha ?? "<absent>"} freshnessOK=${freshnessOK} net_new=${netNewFreshnessOK} freshness_check_path=${freshnessCheckPath}`);
  if (!freshnessOK) {
    // Already-applied no-op: if the live source already matches the STAGED
    // MITOSIS content (not the pre-staging base_sha), this change has already
    // landed — a re-proposed duplicate, or a post-success retry whose pending
    // pointer was never cleared. Refusing here on base_sha_mismatch and leaving
    // mitosis-pending.json in place LIVELOCKS the funnel: apply-proposal-as-patch
    // then refuses every new proposal with "pending mitosis in flight". Detect
    // this case and clear the pending pointer as a no-op success instead of
    // churning freshness gaps forever. (Genuine drift — live != staged content —
    // still falls through to the refusal below.)
    if (currentLiveSha && !currentLiveSha.startsWith("<") && stagedSentinel) {
      try {
        const stagedMitosisContent = await readFile(join(mitosisRoot, stagedSentinel));
        const stagedMitosisSha = createHash("sha256").update(stagedMitosisContent).digest("hex").slice(0, 12);
        if (stagedMitosisSha === currentLiveSha) {
          const pendingPath = pointer.pending_pointer_path ?? join(workspaceRoot, "mitosis-pending.json");
          let pendingCleared = false;
          try {
            if (await pathExists(pendingPath)) { await unlink(pendingPath); pendingCleared = true; }
          } catch { /* best-effort */ }
          console.error(`[mitosis-cutover] already-applied no-op: live matches staged mitosis content (${currentLiveSha}) for ${mitosis_version_id}; cleared pending=${pendingCleared} — not refusing, change already landed`);
          return {
            shape: "cutoverApplied",
            body: {
              applied: false,
              noop: true,
              reason: "already_applied",
              vessel_name,
              mitosis_version_id,
              base_version_id,
              current_live_sha: currentLiveSha,
              pending_cleared: pendingCleared,
            },
          };
        }
      } catch { /* unreadable staged file -> fall through to normal refusal */ }
    }
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
    // Audited NO (same pattern as non-FAVORABLE verdict / missing-path / empty
    // evidence soft-refuses above): emit vesselMitosisCutoverResult{applied:false,
    // refused:true} so light-dispatch / activity-api treat the trace as a
    // success-with-refusal rather than a chain failure. structuredError gets
    // dropped by the engine's top-level catch (engine.ts ~578) which leaves
    // the conditional_cutover task entirely absent from the trace — silent
    // failure mode. The freshness violation IS the substrate's audited NO.
    // The substrateGap_write above carries the cited evidence; this return
    // carries the verdict-acknowledged structure downstream observers expect.
    //
    // Part A (2026-06-04): for `live_source_unreadable` / `base_sha_mismatch`
    // — failures the host-side poller is structurally better placed to verify
    // (real host paths vs container bind mount) — still emit a host-sync
    // intent if we have a real diff. The poller re-runs the freshness check
    // against the host source. `missing_base_sha` is not emitted: without a
    // recorded baseline the poller has nothing to verify against.
    if (reason === "live_source_unreadable" || reason === "base_sha_mismatch") {
      const intent = await maybeEmitIntentForRefuse({
        pointer,
        vessel_name,
        base_version_id,
        mitosis_version_id,
        evaluation_evidence,
        staged_base_sha: stagedBaseSha,
        refuse_class: reason,
      });
      if (intent) return intent;
    }
    await clearPendingOnReject(pointer, workspaceRoot);
    return softRefuse(
      `mitosis_freshness_violation (${reason})`,
      {
        kind: "mitosis_freshness_violation",
        detail: `refusing cutover: mitosis_freshness_violation (${reason})`,
        vessel_name,
        mitosis_version_id,
        staged_base_sha: stagedBaseSha ?? null,
        current_live_sha: currentLiveSha,
        freshness_check_path: freshnessCheckPath,
        cite_principle: "resilient_against_unintended_changes",
        gap_id: gapId,
        verdict: evaluation_evidence.verdict,
      },
    );
  }

  // ---- Drafter-corruption gate (2026-08-02) ----
  // The drafter edits its own source, so a malformed draft can destroy the very
  // mechanism that would repair it. Observed live: two cutovers minutes apart
  // against the same gap wrote `{{source_code.content}}{{source_code.content}}/**`
  // into byte 0 of feature-compose.ts. development-vessel then failed to parse
  // its own drafter and crash-looped on both the hub and the spoke, and because
  // the drafter IS the edit mechanism the substrate could not author its own
  // fix — an operator had to hand-revert it. This gate exists so that class of
  // draft cannot reach /vessels again.
  //
  // Two signatures, both cheap and both fail-closed:
  //
  //  a) LINE 1 begins with an unrendered {{...}} placeholder. The rule is
  //     restricted to the first line, not "any line", because this vessel
  //     legitimately BUILDS prompt templates: 21 lines across src/seed/*.ts sit
  //     alone inside backtick literals as ordinary template data, and an
  //     any-line rule flags every one of them. A scan of all 1114 .ts files in
  //     the fleet finds ZERO whose first line matches — so line 1 separates the
  //     corruption from the data with no false positives, while still catching
  //     the signature that actually occurred.
  //
  //  b) A staged file that no longer opens the way the live file does. Real
  //     edits essentially never prepend above a file's header, so a staged
  //     first line that is non-empty and not a comment/import/shebang, where
  //     the live first line was one, is a byte-0 injection.
  //
  // Emitted as an audited NO (substrateGap + softRefuse), matching the
  // freshness gate's idiom directly above rather than introducing a new
  // refusal mechanism.
  if (Array.isArray(pointer.staged_files) && pointer.staged_files.length > 0) {
    const HEADER_OPENING = /^\s*(\/\*|\/\/|import\b|export\b|#!|["'`]use )/;
    const corruptions: Array<{ file: string; kind: string; detail: string }> = [];
    for (const rel of pointer.staged_files) {
      let stagedContent: string;
      try {
        stagedContent = await readFile(join(mitosisRoot, rel), "utf8");
      } catch {
        // An unreadable staged file is the freshness gate's concern, not this one.
        continue;
      }
      const stagedLines = stagedContent.split("\n");
      const stagedFirstLine = stagedLines[0] ?? "";
      //  d) The staged file DOES NOT PARSE. (2026-08-11.) Signatures (a) and (b)
      //     match a corruption's SHAPE; this one asks the only question that
      //     actually decides whether the vessel will boot, and so it catches the
      //     class independent of how the corruption happens to look.
      //     Observed live: a compose prepended 20 lines of an entirely different,
      //     hallucinated implementation onto activity-api's 1,237-line
      //     routes/goal-paths.ts — an Express router in a Hono vessel, importing a
      //     service that does not exist, with the GAP SUMMARY pasted at line 3 as
      //     bare unquoted prose. activity-api crash-looped for 5 minutes
      //     (NRestarts 107 -> 123, respawning every ~6s) and an operator had to
      //     hand-restore it, because self-recovery.timer was simultaneously in a
      //     dead state and could not fire.
      //     NEITHER existing signature could see it, verified against the captured
      //     artifact: (b) byte_zero_injection did not fire because the injected
      //     text BEGINS WITH AN IMPORT, which HEADER_OPENING accepts as a
      //     legitimate file opening; and catastrophic_truncation did not fire
      //     because the file GREW (51,036B against a live 51,011B). A prepend that
      //     opens with imports is exactly the blind spot between the two.
      //     Bun's transpiler is in-process and synchronous — no subprocess, no
      //     typecheck — so this costs a parse per staged file. It is a strictly
      //     weaker check than `tsc`: it rejects only source that cannot be parsed
      //     AT ALL, never a type error, so it cannot refuse a merely-imperfect
      //     edit. Control over all 835 .ts/.tsx files under /vessels/*/src: ZERO
      //     parse failures, while the captured corrupt file throws. No false
      //     positives, and it fails OPEN on transpiler-unavailability so a broken
      //     check can never block a good cutover.
      if (/\.(ts|tsx)$/.test(rel)) {
        let transpiler: { transformSync: (code: string) => unknown } | undefined;
        try {
          transpiler = new Bun.Transpiler({ loader: rel.endsWith(".tsx") ? "tsx" : "ts" });
        } catch {
          transpiler = undefined; // fail open — never block a cutover on our own tooling
        }
        if (transpiler) {
          try {
            transpiler.transformSync(stagedContent);
          } catch (e) {
            corruptions.push({
              file: rel,
              kind: "unparseable_typescript",
              detail:
                `staged file does not parse, so landing it would crash-loop the vessel: ` +
                `${(String(e instanceof Error ? e.message : e).split("\n")[0] ?? "").slice(0, 160)}`,
            });
          }
        }
      }
      if (/^\s*\{\{\s*[\w$.[\]-]+\s*\}\}/.test(stagedFirstLine)) {
        corruptions.push({
          file: rel,
          kind: "unrendered_template_placeholder",
          detail: `line 1 begins with an unrendered placeholder: ${stagedFirstLine.slice(0, 120)}`,
        });
      }
      //  c) An `llmCall(` handed an endpoint constant that provably cannot answer
      //     a completion. A degenerate self-modification loop rewrites this one
      //     argument over and over, cycling between DISCOVERY_ENDPOINT (:8100,
      //     the registry), CONCEPT_DB_ENDPOINT (:8260, the prose vessel) and
      //     DEV_VESSEL_ENDPOINT (:8090, this vessel's OWN resolve route). Each
      //     landing silently disables every compose anchor-repair and
      //     lint-repair path, so the drafter loses the machinery that would fix
      //     it. Neither existing gate can see this class: `bun run typecheck`
      //     passes because any of them is a valid string, and the semantic gate
      //     reasons about symbols and behaviour delta, not about what a resolved
      //     endpoint SERVES. Two of the affected sites even carry a comment
      //     forbidding the substitution, which the drafter left intact while
      //     changing the line beneath it — in-file comments are not read at
      //     decision time, so only a check can hold this invariant.
      //     Corpus over all 862 .ts files under /vessels/*/src: 207 llmCall
      //     sites pass `endpoint`/`llmEndpoint`/`LLM_ENDPOINT`/`producer`/
      //     `activeEndpoint`; every one of the 266 hits on these three constants
      //     is a corrupted draft (263 in stale mitosis staging roots, 3 the live
      //     regression this gate is being added to stop). ZERO false positives.
      //     The comment-skip in the pattern is required: one recurring site
      //     places a comment between `llmCall(` and its argument.
      for (const m of stagedContent.matchAll(
        /llmCall\(\s*(?:\/\/[^\n]*\n\s*)*(CONCEPT_DB_ENDPOINT|DEV_VESSEL_ENDPOINT|DISCOVERY_ENDPOINT)\b/g,
      )) {
        corruptions.push({
          file: rel,
          kind: "llmcall_non_llm_endpoint",
          detail: `llmCall() is passed ${m[1]}, which does not serve completions — this disables the compose recovery path`,
        });
      }
      try {
        const livePath = join(baseRoot, rel);
        if (await pathExists(livePath)) {
          const liveText = await readFile(livePath, "utf8");
          const liveFirst = liveText.split("\n", 1)[0] ?? "";
          if (liveText.length > 400 && stagedContent.length < liveText.length * 0.5) {
            corruptions.push({
              file: rel,
              kind: "catastrophic_truncation",
              detail: `staged file is ${stagedContent.length}B against a live ${liveText.length}B — a shrink past half is capability loss, not an edit`,
            });
          }
          const stagedFirst = stagedFirstLine;
          if (
            HEADER_OPENING.test(liveFirst) &&
            stagedFirst.trim() !== "" &&
            !HEADER_OPENING.test(stagedFirst)
          ) {
            corruptions.push({
              file: rel,
              kind: "byte_zero_injection",
              detail:
                `staged first line does not open the file the way the live one does — ` +
                `live: ${liveFirst.slice(0, 80)} | staged: ${stagedFirst.slice(0, 80)}`,
            });
          }
        }
      } catch {
        // Best-effort: inability to read the live file must not mask signature (a).
      }
    }
    if (corruptions.length > 0) {
      const gapId = `mitosis_drafter_corruption:${vessel_name}:${mitosis_version_id}`;
      const summary =
        `Mitosis ${mitosis_version_id} for ${vessel_name} refused cutover: the staged draft carries ` +
        `drafter-corruption signatures (${corruptions.map((c) => `${c.file}:${c.kind}`).join(", ")}). ` +
        `Landing it risks writing unparseable source into /vessels; when the target is the drafter ` +
        `itself the failure is self-sealing and cannot be repaired by the substrate.`;
      console.error(`[mitosis-cutover] DRAFTER CORRUPTION REFUSED ${JSON.stringify(corruptions).slice(0, 500)}`);
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
              kind: "mitosis_drafter_corruption",
              vessel_name,
              mitosis_version_id,
              base_version_id,
              corruptions,
              cite_principle: "resilient_against_unintended_changes",
              suggested_remediation:
                "Re-derive the draft against current source. If the same signature recurs for the " +
                "same target file, the drafter's prompt-rendering path is emitting its template " +
                "verbatim and that, not the individual draft, is the defect to close.",
            },
          },
        });
      } catch (err) {
        // Best-effort: a gap-write failure must not mask the refusal itself.
        console.warn(
          `[vessel_mitosis_cutover] substrateGap_write failed during corruption refusal: ${(err as Error).message}`,
        );
      }
      await clearPendingOnReject(pointer, workspaceRoot);
      return softRefuse("mitosis_drafter_corruption", {
        kind: "mitosis_drafter_corruption",
        detail: `refusing cutover: ${corruptions.length} corruption signature(s) in staged draft`,
        vessel_name,
        mitosis_version_id,
        corruptions,
        cite_principle: "resilient_against_unintended_changes",
        gap_id: gapId,
      });
    }
  }

  // ---- Git-aware cutover path (2026-06-04) ----
  // When staged_files is supplied, we apply only those files (scope-creep
  // gate) into a host-side git repo, commit, push, then mirror into the
  // /vessels/<v>/ runtime path and restart the systemd unit. Emits a
  // cutoverApplied impulse with new_git_sha + push_status.
  if (pointer.staged_files && pointer.staged_files.length > 0) {
    // Acquire change-window maintenance lease before mutating /vessels
    // (gap cutover-acquires-change-window-2026-07-09).
    const acquireResult = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: `cutover:${String(pointer.vessel_name ?? "unknown")}`,
      ttl_ms: 600000,
    });
    let acquireBody = (acquireResult as { body?: { acquired?: boolean; held_by?: string; token?: string } }).body ?? {};
// BOUNDED WAIT before giving up. Deferring instantly discards work that has
// already applied, typechecked, passed its suite and cleared the semantic gate
// — and the `retry_after_ms` hint emitted below has ONE producer and ZERO
// consumers, so nothing ever comes back for it. The common collision is another
// cutover finishing within seconds, so wait for it rather than throwing the
// result away. Bounded at 90s against a 600s lease TTL: long enough to absorb a
// normal cutover, far short of the TTL so a genuinely long holder still yields a
// prompt, honest deferral through the untouched branch below.
const leaseWaitMs = Number(process.env["CUTOVER_LEASE_WAIT_MS"] ?? 90000);
for (let waited = 0; acquireBody.acquired === false && waited < leaseWaitMs; waited += 5000) {
  await new Promise((r) => setTimeout(r, 5000));
  const retryAcquire = await resolveMaintenanceLeaseWrite({
    type: "maintenanceLease_write",
    op: "acquire",
    holder: `cutover:${String(pointer.vessel_name ?? "unknown")}`,
    ttl_ms: 600000,
  });
  acquireBody = (retryAcquire as { body?: { acquired?: boolean; held_by?: string; token?: string } }).body ?? {};
  if (acquireBody.acquired !== false) console.log(`[mitosis-cutover] change_window lease acquired after waiting ${waited + 5000}ms`);
}
    if (acquireBody.acquired === false) {
      // SAY SO. Every sibling exit in this resolver logs before returning; this
      // branch did not, and it is the one that fires when the fleet cannot edit
      // itself. Measured 2026-08-09: four consecutive self-edit dispatches were
      // deferred here after passing the semantic gate, typecheck, the test suite
      // and the freshness gate — and because this return is silent, each one was
      // attributed downstream to `semantic_gate` (goal-host's failDetail cascade
      // falls through to semantic_gate.reason when no applied[] or verify[] entry
      // failed). The operator-visible verdict therefore quoted a gate that had
      // PASSED, on all four attempts, while the real cause never appeared in any
      // log. An unlogged deferral is indistinguishable from a hang.
      console.error(
        `[mitosis-cutover] DEFERRED: change_window lease held by ${acquireBody.held_by ?? "<unknown>"} ` +
        `after waiting ${leaseWaitMs}ms — vessel=${String(pointer.vessel_name ?? "unknown")} ` +
        `mitosis=${mitosis_version_id}; no edit will land this run`,
      );
      // Introduce a brief wait before returning cutoverDeferred
      await new Promise(resolve => setTimeout(resolve, 10000));
      return {
        shape: "cutoverDeferred",
        body: {
          deferred: true,
          reason: "change_window lease held",
          held_by: acquireBody.held_by,
          retry_after_ms: 60000,
        },
      };
    }
    const token = acquireBody.token;
    try {
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
          (directPush && cloneDir
            ? join(cloneDir, vessel_name)
            : join(workspaceRoot, "repos", vessel_name)),
        evaluationEvidence: evaluation_evidence,
        stagedBaseSha,
      });
    } finally {
      await resolveMaintenanceLeaseWrite({
        type: "maintenanceLease_write",
        op: "release",
        token,
      });
    }
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
        cited_trace_ids: (evaluation_evidence.cited_trace_ids ?? []).slice(0, 10),
        cited_check_names: (evaluation_evidence.cited_check_names ?? []).slice(0, 10),
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
  // CHANGE-WINDOW LEASE (Seam 2A, 2026-07-09): the cutover is the substrate's
  // only self-mutation chokepoint — commit + push + restart. Without a lease,
  // concurrent cutovers and substrate-pull-sync race it (stale-runtime pushes
  // clobbering fresh commits; restarts killing in-flight work). Acquire the
  // maintenanceLease for the whole cutover; a held lease is an ENVIRONMENT
  // condition (env_change_window_held), not a draft defect — refuse softly so
  // the drain loop retries next tick without burning gap credit.
  const { resolveMaintenanceLeaseWrite } = await import("./maintenance-lease.js");
  const leaseHolder = `cutover:${args.vessel_name}`;
  let leaseToken: string | undefined;
  try {
    const acq = await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", holder: leaseHolder, ttl_ms: 600_000 });
    const acqBody = acq.body as { acquired?: boolean; token?: string; held_by?: string; expires_at?: string };
    if (acqBody.acquired === false) {
      return softRefuse(
        `change window held by ${acqBody.held_by ?? "unknown"} until ${acqBody.expires_at ?? "?"} — deferring cutover to next tick`,
        { kind: "env_change_window_held", vessel_name: args.vessel_name, held_by: acqBody.held_by },
      );
    }
    leaseToken = acqBody.token;
  } catch {
    // Lease machinery unavailable — fail open (a dead lease file must not
    // wedge all self-development), but proceed unleased.
  }

  // SELF-DEADLOCK GUARD. maintenanceLease is a SINGLE GLOBAL mutex — see
  // maintenance-lease.ts: "a single JSON object { holder, token, acquired_at,
  // expires_at }". It is NOT keyed per holder. So acquiring it a second time
  // under a different holder name ALWAYS fails, and the failure reports
  // held_by = our OWN change-window holder ("cutover:<vessel>"). Every cutover
  // carrying a proposal_id therefore refused itself with proposal_lease_held
  // immediately after passing its FAVORABLE gate, freshness check and typecheck
  // — observed live: gate verdict=FAVORABLE at 05:14:05 followed by
  // "REFUSE: proposal cutover lease held by cutover:goal-host-vessel until
  // 05:24:05" in the same millisecond. Nothing could land.
  //
  // The change-window lease we already hold provides the mutual exclusion the
  // proposal lease was reaching for; same-proposal redundancy is separately
  // caught by the freshness check (staged_base_sha vs current_live_sha) below.
  // So only take the proposal lease when the change-window acquire FAILED OPEN
  // (lease machinery unavailable ⇒ leaseToken undefined) — there it is the only
  // exclusion available and cannot contend with itself.
  let proposalLeaseToken: string | undefined;
  if (args.pointer.proposal_id && !leaseToken) {
    const pLeaseHolder = `proposal:${args.pointer.proposal_id}`;
    try {
      const pAcq = await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", holder: pLeaseHolder, ttl_ms: 600_000 });
      const pAcqBody = pAcq.body as { acquired?: boolean; token?: string; held_by?: string; expires_at?: string };
      if (pAcqBody.acquired === false) {
        if (leaseToken) try { await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "release", token: leaseToken }); } catch {}
        return softRefuse(`proposal cutover lease held by ${pAcqBody.held_by ?? "unknown"} until ${pAcqBody.expires_at ?? "?"} — skipping redundant cutover`, { kind: "proposal_lease_held", proposal_id: args.pointer.proposal_id, held_by: pAcqBody.held_by });
      }
      proposalLeaseToken = pAcqBody.token;
    } catch {}
  }

  try {
    return await runGitAwareCutoverInner(args);
  } finally {
    if (proposalLeaseToken) {
      try { await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "release", token: proposalLeaseToken }); } catch { }
    }
    if (leaseToken) {
      try { await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "release", token: leaseToken }); } catch { }
    }
    // Exit-guaranteed queue-lock clear (root fix for the orphaned mitosis-pending
    // wedge): the inner cutover has many terminal exits (host-sync handoff return,
    // structuredError/softRefuse rejects, uncaught throw) that never reach the
    // finalize clears, so an orphaned lock froze ALL pull-sync for its 30-min TTL.
    // Ownership-scoped so a next-staged cutover lock is never clobbered. The
    // retryable env_change_window_held deferral returns BEFORE this try, so its
    // lock is correctly retained.
    try { await clearPendingIfOwned(args.pointer, process.env["WORKSPACE_ROOT"] ?? process.cwd(), args.mitosis_version_id); } catch { }
  }
}

async function runGitAwareCutoverInner(args: GitCutoverArgs): Promise<ResolverResult> {
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

  // 0. Atomicity guard (2026-06-29): never commit with no staged files. An empty
  // stagedFiles set means there is nothing to apply — committing here would
  // either be an empty commit or (with a broad `add`) sweep the clone's
  // pre-existing dirty state. Refuse cleanly.
  if (!stagedFiles || stagedFiles.length === 0) {
    return softRefuse(
      "no staged files — cutover has nothing atomic to commit",
      { kind: "no_staged_files", vessel_name },
    );
  }

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

  const gitCmd = pointer.git_cmd ?? "git";

  // 2b. CLEAN-SLATE the push clone to origin/dev BEFORE applying staged files
  // (ATOMICITY FIX, 2026-06-29). Root cause of non-atomic / sweepy autonomous
  // commits: the push clone (hostRepoRoot, /workspace/git/vessels/<v>) carries
  // PRE-EXISTING uncommitted/divergent state — untracked files, prior in-clone
  // edits, or a clone whose tracked content has drifted from origin/dev (e.g. a
  // mitosis tree whose src/index.ts lagged origin/dev caused commit af61dee to
  // DELETE 655 legit lines while "only" touching one staged file). The
  // freshness gate only compares mitosis↔runtime, so clone↔origin/dev drift is
  // invisible. By hard-resetting the clone to the true remote tip first, the
  // subsequent staged-file copy + scoped commit produces a diff that is EXACTLY
  // the staged fix and nothing else.
  //
  // SAFETY: the clone is a disposable push-staging area ONLY — the live runtime
  // is /vessels/<v> (baseRoot), mirrored independently in step 9, and the
  // authored change lives in mitosisRoot. Resetting the clone to origin/dev
  // loses nothing load-bearing (any committed-but-unpushed work here is either
  // already on origin/dev or was an earlier sweep we WANT to drop). Set
  // MITOSIS_SKIP_CLONE_RESET=1 to bypass (escape hatch).
  if (process.env["MITOSIS_SKIP_CLONE_RESET"] !== "1") {
    // Best-effort fetch to refresh the local origin/dev ref. In-container this
    // OFTEN FAILS (the HTTPS PAT is invalid/missing — that is exactly why the
    // durable push path is the host-sync poller over SSH). A failed fetch must
    // NOT abort the cutover: we still reset to the LOCAL origin/dev ref, which
    // is a clean tracked baseline far better than a dirty/divergent clone, and
    // the host-sync poller (where fetch works) does the authoritative atomic
    // commit against the true remote tip. So fetch is warn-only.
    const cleanFetch = await runGit(gitCmd, ["fetch", "origin", "dev"], hostRepoRoot);
    operations.push({
      op: cleanFetch.op,
      status: cleanFetch.exit_code === 0 ? "ok" : "warn",
      detail: cleanFetch.exit_code === 0 ? "clean-slate fetch" : `fetch unavailable (host-sync is durable path): ${cleanFetch.stderr.slice(0, 160)}`,
    });
    // Hard-reset to the authored base (stagedBaseSha) or origin/dev if unknown.
    // By resetting to the base the vessel authored against, the committed tree
    // reflects only the intended delta. The subsequent `git push origin dev`
    // will detect if origin/dev has advanced and trigger a `git rebase origin/dev`,
    // performing a proper 3-way merge rather than clobbering concurrent landings.
    const resetTarget = args.stagedBaseSha ? args.stagedBaseSha : "origin/dev";
    let reset = await runGit(gitCmd, ["reset", "--hard", resetTarget], hostRepoRoot);
    if (reset.exit_code !== 0 && args.stagedBaseSha) {
       // Fallback to origin/dev if the staged base sha is not found locally.
       reset = await runGit(gitCmd, ["reset", "--hard", "origin/dev"], hostRepoRoot);
    }
    operations.push({
      op: reset.op,
      status: reset.exit_code === 0 ? "ok" : "fail",
      detail: reset.exit_code === 0 ? reset.stdout.slice(0, 120) : reset.stderr.slice(0, 200),
    });
    if (reset.exit_code !== 0) {
      // No usable origin/dev ref at all — refuse rather than commit against a
      // dirty clone (the very bug this step prevents). Soft-refuse → audit obs.
      return softRefuse(
        `clean-slate reset --hard origin/dev failed; refusing to commit against a dirty clone: ${reset.stderr.slice(0, 200)}`,
        { kind: "clone_reset_failed", host_repo_root: hostRepoRoot, operations },
      );
    }
    // Drop untracked + ignored cruft so the clone matches origin/dev exactly and
    // no stray file can be swept by a later add. Best-effort (warn-only): the
    // commit is scoped to stagedFiles anyway; this is belt-and-suspenders for
    // the diff-scope check.
    const clean = await runGit(gitCmd, ["clean", "-fd"], hostRepoRoot);
    operations.push({
      op: clean.op,
      status: clean.exit_code === 0 ? "ok" : "warn",
      detail: clean.exit_code === 0 ? "untracked dropped" : clean.stderr.slice(0, 160),
    });
  }

  // 3. Copy staged files into the (now clean) host repo clone.
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

  // 5. git add — SCOPED to stagedFiles via `--` pathspec separator so nothing
  // outside the staged set is ever staged (atomicity, 2026-06-29).
  const add = await runGit(gitCmd, ["add", "--", ...stagedFiles], hostRepoRoot);
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

  // LEAVE NO DIRTY INDEX (2026-08-02). Every failure path below returns AFTER the
  // `git add` above, and used to return with those paths still staged. A staged
  // path the commit hook rejects — e.g. a drafted path missing its `repos/` prefix,
  // which the super-repo pre-commit hook refuses as a root-level addition — is
  // therefore staged FOREVER. That is not cosmetic: `git merge --ff-only` calls
  // require_clean_work_tree, so a dirty index permanently blocks pull-sync from
  // converging the glue layer, silently (observed: 37 consecutive failed ticks over
  // 11 hours, zero signal, repaired only by hand).
  const unstage = async (why: string) => {
    const r = await runGit(gitCmd, ["reset", "-q", "HEAD", "--", ...stagedFiles], hostRepoRoot);
    operations.push({ op: r.op, status: r.exit_code === 0 ? "ok" : "warn", detail: `unstaged after ${why}` });
  };

  // 5b. Empty-diff guard: staged content byte-identical to HEAD after the clone
  // reset means there is nothing to land — honest skip, not an empty commit.
  const cachedDiff = await runGit(gitCmd, ["diff", "--cached", "--name-only"], hostRepoRoot);
  if (cachedDiff.stdout.trim().length === 0) {
    await unstage("no_diff");
    return softRefuse("no_diff: staged files are byte-identical to HEAD - nothing to cut over", { kind: "no_diff", skip_reason: "no_diff", vessel_name, staged_files: stagedFiles, operations });
  }
  // 6. git commit.
  const proposalId = pointer.proposal_id || "unknown-proposal";
  const gapId = pointer.gap_id || "unknown-gap";
  if ((gapId === "unknown-gap" || proposalId === "unknown-proposal") && pointer.adhoc !== true) {
    return structuredError("cutover_refused_missing_provenance", { gap_id: gapId, proposal_id: proposalId, hint: "every landing must carry gap_id and proposal_id; pass adhoc: true only for consciously unattributed operator work" });
  }
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
    await unstage("commit_failed");
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

  // 8. git push origin dev — ROBUST TO UPSTREAM DRIFT (2026-06-16).
  // origin/dev is a shared branch: the operator, concurrent sessions, AND other
  // substrate cutovers all push to it. A bare `git push` fails non-fast-forward
  // the moment anyone else has pushed since this clone last synced, and the old
  // code just degraded to local_only — so self-alteration silently stopped
  // landing whenever the branch moved (observed: a 4-commit fork). Instead, on a
  // non-fast-forward, fetch + rebase our single staged-files commit onto the new
  // origin/dev and retry. Our commit only touches one vessel's staged_files, so
  // a rebase over unrelated upstream edits applies cleanly; a genuine same-file
  // conflict aborts the rebase and degrades to local_only (the commit stays in
  // the clone for the next cutover to re-derive against the moved base).
  // Durability (2026-06-19): the in-container push uses an HTTPS PAT credential
  // helper (setup-git-push.sh). When that PAT is invalid/missing the push fails
  // EVERY time with "Invalid username or token. Password authentication is not
  // supported." — and the old code degraded to local_only, stranding the commit
  // in the in-container clone where it never reaches origin. The DURABLE push
  // path is the host-sync poller (host SSH key, always valid). So on a push
  // failure that is NOT a transient non-fast-forward (i.e. an auth/transport
  // failure the retry loop cannot fix), fall through to a host-sync intent so the
  // host poller lands the change via SSH. push_status then reflects reality
  // ("host_sync_pending") instead of a misleading local_only. The container's
  // direct push stays as a fast path for when the PAT IS valid; host-sync is the
  // graceful-degradation safety net independent of the operator-managed PAT.
  let pushStatus:
    | "pushed"
    | "local_only"
    | "host_sync_pending"
    | "skipped" = "skipped";
  let pushDetail = "";
  let pushRebases = 0;
  let pushAuthFailed = false;
  if (!pointer.skip_push) {
    const MAX_PUSH_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const push = await runGit(gitCmd, ["push", "origin", "dev"], hostRepoRoot);
      pushDetail = (push.stderr + push.stdout).slice(0, 400);
      if (push.exit_code === 0) {
        pushStatus = "pushed";
        operations.push({
          op: push.op,
          status: "ok",
          detail: `${pushDetail}${pushRebases > 0 ? ` (after ${pushRebases} rebase onto moved origin/dev)` : ""}`,
        });
        break;
      }
      const nonFastForward = /non-fast-forward|fetch first|\[rejected\]|tip of your current branch is behind/i.test(pushDetail);
      // Auth/transport failures (bad/missing in-container PAT) are NOT fixable by
      // rebase-retry. Flag them so the post-loop fallback emits a host-sync intent
      // — the host poller (SSH) is the durable path that does not depend on the PAT.
      const authFailed = /authentication failed|invalid username or token|password authentication is not supported|could not read username|terminal prompts disabled|403|401/i.test(pushDetail);
      if (!nonFastForward || attempt === MAX_PUSH_ATTEMPTS) {
        pushStatus = "local_only";
        pushAuthFailed = authFailed;
        operations.push({
          op: push.op,
          status: "warn",
          detail: `push failed (commit local${authFailed ? ", auth/transport — will defer to host-sync" : ""}): ${pushDetail}`,
        });
        break;
      }
      // Upstream moved — integrate and retry.
      const fetched = await runGit(gitCmd, ["fetch", "origin", "dev"], hostRepoRoot);
      operations.push({
        op: fetched.op,
        status: fetched.exit_code === 0 ? "ok" : "warn",
        detail: fetched.stderr.slice(0, 160),
      });
      const rebased = await runGit(gitCmd, ["rebase", "origin/dev"], hostRepoRoot);
      if (rebased.exit_code !== 0) {
        await runGit(gitCmd, ["rebase", "--abort"], hostRepoRoot);
        pushStatus = "local_only";
        operations.push({
          op: rebased.op,
          status: "warn",
          detail: `rebase onto moved origin/dev conflicted; aborted (commit local, re-derive next cutover): ${(rebased.stderr + rebased.stdout).slice(0, 200)}`,
        });
        break;
      }
      pushRebases++;
      operations.push({ op: `git rebase origin/dev (attempt ${attempt})`, status: "ok" });
      // loop and re-push the rebased commit
    }
  }

  // 8b. Durable-push fallback (2026-06-19): if the in-container push could not
  // land (local_only) — most commonly because the in-container HTTPS PAT is
  // invalid/missing — emit a host-sync intent so the host-side poller (SSH key,
  // operator-independent of the PAT) commits+pushes the same staged files from
  // the host clone. This makes substrate-authored commits land on origin/dev
  // durably regardless of PAT state. We only fall back on local_only (never on
  // "pushed"/"skipped"), and we tag the resulting status host_sync_pending so the
  // cutoverApplied trace reflects "handed to host poller" rather than a
  // misleading dead-end local_only. Best-effort: a failed intent emit leaves
  // pushStatus=local_only (the commit still exists in the clone for re-derive).
  if (pushStatus === "local_only") {
    try {
      await emitHostSyncIntent({
        pointer,
        vessel_name,
        base_version_id,
        mitosis_version_id,
        mitosisRoot,
        stagedFiles,
        evaluationEvidence,
        stagedBaseSha,
      });
      pushStatus = "host_sync_pending";
      operations.push({
        op: "emit host-sync intent (durable push fallback)",
        status: "ok",
        detail: pushAuthFailed
          ? "in-container PAT auth failed; host poller will push via SSH"
          : "in-container push failed; host poller will push via SSH",
      });
    } catch (err) {
      operations.push({
        op: "emit host-sync intent (durable push fallback)",
        status: "warn",
        detail: `host-sync fallback emit failed: ${(err as Error).message.slice(0, 160)}`,
      });
    }
  }

  // 9. Mirror staged files into /vessels/<v>/ runtime path — ONLY when the push
  // actually landed on origin. Mirroring on a degraded push (local_only /
  // host_sync_pending) drifts /vessels AHEAD of origin, poisoning the freshness
  // sentinel (current_live_sha is hashed from /vessels) so every future FAVORABLE
  // cutover short-circuits (no_diff / base_sha_mismatch) before commit+push — the
  // self-sustaining P1(origin)!=P2(/vessels) livelock. Gate on pushStatus.
  let vesselRestarted = false;
  if (pushStatus !== "pushed") {
    operations.push({
      op: "copy mitosis → live vessel",
      status: "skipped",
      detail: `push not landed on origin (${pushStatus}); /vessels left at origin/dev to preserve the freshness base`,
    });
  } else if (await pathExists(baseRoot)) {
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

  // 9a. RUNTIME MANIFEST VERIFICATION (gap-cutover-container-tree-missing-new-files):
  // The step-9 mirror above can leave the running /vessels tree missing a staged
  // file (notably a NEWLY-CREATED file) if copyTree aborted partway on one file's
  // error, or if the file landed on origin/dev but was not mirrored. A single
  // missing file poisons EVERY later feature_compose verify on this vessel with a
  // pre-existing TS2307 in a file the operator never touched (witnessed 2026-07-07,
  // commit 8c8c41c). Verify each staged file is now present in baseRoot and re-copy
  // any that are missing (from mitosisRoot) so the running container tree matches
  // the landed commit. Best-effort per file; the aggregate verdict is recorded.
  if (await pathExists(baseRoot)) {
    const stillMissing: string[] = [];
    for (const rel of stagedFiles) {
      if (isAbsolute(rel) || rel.includes("..")) continue;
      const dst = join(baseRoot, rel);
      if (await pathExists(dst)) continue;
      try {
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(join(mitosisRoot, rel), dst);
        operations.push({ op: "manifest re-copy missing staged file", status: "ok", detail: rel });
      } catch (err) {
        stillMissing.push(rel);
        operations.push({ op: "manifest re-copy missing staged file", status: "warn", detail: `${rel}: ${(err as Error).message.slice(0, 120)}` });
      }
    }
    operations.push({
      op: "runtime manifest verify",
      status: stillMissing.length === 0 ? "ok" : "fail",
      detail: stillMissing.length === 0
        ? `all ${stagedFiles.length} staged file(s) present in runtime tree`
        : `MISSING in runtime after mirror: ${stillMissing.join(", ")}`,
    });
  }

  // 9b. SELF-ACTIVATION (2026-06-26): if any staged file is a substrate timer
  // script (scripts/substrate/*.ts), make the new version live in the writable
  // run-dir so it takes effect on the next timer firing WITHOUT a container
  // restart. Scoped strictly to scripts/substrate/*.ts + non-fatal (warn ops
  // only); the git/host-sync push above remains the durability path.
  try {
    const activateOps = await maybeActivateSubstrateScripts({ mitosisRoot, stagedFiles });
    for (const op of activateOps) operations.push(op);
  } catch (err) {
    operations.push({
      op: "activate_substrate_script (self-activation)",
      status: "warn",
      detail: `non-fatal: ${(err as Error).message.slice(0, 160)}`,
    });
  }

  // 9b. Vessel-owned deploy hook: run the clone's scripts["substrate:deploy"] with SUBSTRATE_BASE_ROOT so built-artifact vessels place their own runtime files.
  try {
    const pkg = JSON.parse(await Bun.file(join(hostRepoRoot, "package.json")).text()) as { scripts?: Record<string, string> };
    if (pkg.scripts && pkg.scripts["substrate:deploy"]) {
      const dep = Bun.spawnSync([process.execPath, "run", "substrate:deploy"], { cwd: hostRepoRoot, env: { ...process.env, SUBSTRATE_BASE_ROOT: baseRoot, PATH: (process.env.PATH ?? "") + ":/usr/bin:/usr/local/bin:/root/.bun/bin" }, stdout: "pipe", stderr: "pipe" });
      const depOk = (dep.exitCode ?? 1) === 0;
      operations.push({ op: "substrate:deploy hook", status: depOk ? "ok" : "warn", detail: depOk ? undefined : new TextDecoder().decode(dep.stderr).slice(0, 160) });
      try { const { appendFile } = await import("node:fs/promises"); await appendFile("/workspace/proposals/interface-deploys.jsonl", JSON.stringify({ at: new Date().toISOString(), vessel: vessel_name, ok: depOk }) + "\n"); } catch { operations.push({ op: "interface-deploy ledger", status: "warn" }); }
    }
  } catch (e) { operations.push({ op: "substrate:deploy hook", status: "warn", detail: String((e as Error).message ?? e).slice(0, 160) }); }
  // 10. Restart vessel unit (best-effort).
  if (!pointer.skip_restart) {
    let pkgUnit = "";
    try { const pj = JSON.parse(await Bun.file(join(hostRepoRoot, "package.json")).text()) as { substrate?: { restart_unit?: string } }; if (pj.substrate && typeof pj.substrate.restart_unit === "string") pkgUnit = pj.substrate.restart_unit; } catch { }
    const unit = pointer.restart_unit_name ?? (pkgUnit !== "" ? pkgUnit : vessel_name + ".service");
    // SELF-CUTOVER guard (commit-vs-deploy gap fix, 2026-06-23): when this vessel
    // (development-vessel, which hosts the cutover resolvers) cuts over ITSELF, an
    // inline `systemctl restart development-vessel.service` kills THIS running
    // resolver process mid-flight — before the mirror/emit reliably finish and
    // before the HTTP response returns. That is exactly why dev-vessel self-
    // cutovers committed to the clone but did NOT deploy to /vessels and NEVER
    // emitted a cutoverApplied record (every OTHER vessel does, because restarting
    // them doesn't kill the cutover process). Defer the restart to a transient
    // systemd timer: it is PID1-owned and runs OUTSIDE this vessel's cgroup, so the
    // restart can't kill the deferring process, and it fires only AFTER this
    // resolver has finished mirroring (step 9, already done above) + emitting +
    // returning. The change is already mirrored into baseRoot by step 9, so the
    // deferred restart simply makes the already-deployed file live.
    const selfVesselId = process.env["VESSEL_ID"] ?? "";
    const isSelfCutover = selfVesselId.length > 0 && selfVesselId.startsWith(vessel_name);
    if (isSelfCutover) {
      const delaySec = process.env["MITOSIS_SELF_RESTART_DELAY_S"] ?? "5";
      const tsUnit = `mitosis-self-restart-${mitosis_version_id}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 90);
      if (process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] === "1") {
        vesselRestarted = true;
        operations.push({ op: `deferred self-restart ${unit}`, status: "ok", detail: "(skipped via env)" });
      } else {
        try {
          const sysdRun = process.env["SYSTEMD_RUN_CMD"] ?? "systemd-run";
          // RELEASE-BEFORE-RESTART (2026-08-05). The change_window lease is released ONLY by
          // the in-process `finally` in runGitAwareCutover. This timer RESTARTS the vessel —
          // killing that very process — so on a SELF-cutover the release is unreachable BY
          // CONSTRUCTION and the lease leaks for its full 600s TTL. Measured: acquired
          // 08:22:55.815, unit Stopped 08:23:06, holder pid gone, lease file never rewritten.
          // substrate-pull-sync and self-recovery-tick both defer their ENTIRE run on this
          // lease, so each leak silently froze the deploy channel: the in-container super-repo
          // clone sat 4 commits behind for over two hours while every tick logged "Finished".
          // "The cleanup is in a finally" is not a proof of release when something can kill
          // the process. Raising MITOSIS_SELF_RESTART_DELAY_S only moves the race.
          //
          // The transient unit is owned by PID1, so it always runs — let it free the lease
          // itself. HOLDER-SCOPED, never unconditional: the acquire is wrapped in a fail-open
          // catch, so this code can run holding NO lease, and an unconditional rm would then
          // delete a FOREIGN holder's lease (db_admin's trace-store swap, or proposal:<id>)
          // and release pull-sync into a live mid-swap — the exact corruption this mutex
          // exists to prevent. leasePath() is IMPORTED rather than re-derived: its fallback is
          // config.ts's WORKSPACE_ROOT, not process.cwd(), and duplicating that formula is how
          // it would silently drift. writeLease uses JSON.stringify(lease, null, 2), so the
          // fixed-string match below — with the space after the colon — is exact.
          const { leasePath } = await import("./maintenance-lease.js");
          const leaseFile = leasePath();
          const leaseMark = `"holder": "cutover:${vessel_name}"`;
          // QUIESCE BEFORE RESTART (2026-08-05). Per-compose worktree isolation was added so
          // concurrent composes no longer stomp each other -- but this self-restart fired
          // unconditionally delaySec after the cutover, blind to whatever ELSE was in flight.
          // Measured: the timer armed by a compose that began 23:13:06 fired at 23:16:11 and
          // destroyed two UNRELATED composes mid-apply. The victim is never the compose that
          // armed the timer; that one has already returned. development-vessel's own SIGTERM
          // drain cannot save them either -- it reports "0 authoring runs in flight" because
          // the marker is not written until the apply stage. The goal-host branch below
          // already solves exactly this by draining before it schedules; this is the same
          // guard for the self-cutover path -- REUSE, not a new mechanism. Bounded and
          // fail-open: after the cap we restart anyway, so a stale marker can delay a deploy
          // but can never block it forever.
          //
          // The lease removal is now HOLDER-SCOPED, which the comment above has always
          // claimed and the code did NOT do: `leaseMark` was computed and never used, leaving
          // an unconditional `rm -f` that could delete a FOREIGN holder's lease (db_admin's
          // trace-store swap, or proposal:<id>) and release pull-sync into a live mid-swap --
          // exactly the corruption that comment warns against.
          const quiesceMaxS = Number(process.env["MITOSIS_SELF_RESTART_QUIESCE_MAX_S"] ?? "600");
          const quiesceIters = Math.max(0, Math.floor(quiesceMaxS / 5));
          const markerDir = `${process.env["WORKSPACE_ROOT"] ?? "/workspace"}/authoring-inflight`;
          const restartScript =
            `if grep -q '${leaseMark}' '${leaseFile}' 2>/dev/null; then rm -f '${leaseFile}'; fi; `
            + `i=0; while [ "$i" -lt ${quiesceIters} ] && [ -n "$(ls -A '${markerDir}' 2>/dev/null)" ]; do sleep 5; i=$((i+1)); done; `
            + `exec systemctl restart '${unit}'`;
          const proc = Bun.spawnSync(
            [sysdRun, `--on-active=${delaySec}s`, `--unit=${tsUnit}`, "--collect", "/bin/sh", "-c", restartScript],
            { stdout: "pipe", stderr: "pipe" },
          );
          const ok = (proc.exitCode ?? 1) === 0;
          // "restarted" here means the restart is durably SCHEDULED (it fires in a
          // few seconds, after this resolver returns), not that it already ran.
          vesselRestarted = ok;
          operations.push({
            op: `deferred self-restart via systemd-run (--on-active=${delaySec}s) ${unit}`,
            status: ok ? "ok" : "warn",
            detail: ok ? `transient unit ${tsUnit} (PID1-owned, survives this process)` : (proc.stderr ? new TextDecoder().decode(proc.stderr).slice(0, 200) : "systemd-run failed"),
          });
        } catch (err) {
          operations.push({ op: `deferred self-restart ${unit}`, status: "warn", detail: (err as Error).message.slice(0, 200) });
        }
      }
    } else {
      if (unit.startsWith("goal-host")) {
        // Drain to <=1, not <=0: when this cutover was initiated FROM a goal-host
        // dispatch (edit-intent compose), that parent dispatch is itself in flight
        // for the entire cutover — waiting for 0 deadlocks by construction, the
        // bounded wait always expired, and the inline restart killed the very
        // dispatch that landed the change (interrupted → resumed → re-applied,
        // the route-edit replay loop).
        const deadline = Date.now() + Number(process.env["MITOSIS_DRAIN_WAIT_MS"] ?? "90000");
        let inFlight = -1;
        for (;;) {
          try { const _ghEndpoint = (process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210").replace(/\/+$/, ""); const hj = await (await fetch(`${_ghEndpoint}/health`, { signal: AbortSignal.timeout(3000) })).json() as { in_flight?: number }; inFlight = typeof hj.in_flight === "number" ? hj.in_flight : -1; } catch { inFlight = -1; }
          if (inFlight <= 1 || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        operations.push({ op: "drain-before-restart goal-host (target <=1)", status: inFlight <= 1 ? "ok" : "warn", detail: inFlight > 1 ? "bounded wait expired - proceeding with " + inFlight + " in-flight dispatch(es)" : "drained to initiator or quiet (fail-open)" });
        // Deferred restart via PID1-owned transient timer (same mechanism as the
        // dev-vessel self-cutover path): the mirror into /vessels is already done,
        // so the delay only postpones when the new code goes live — long enough
        // for the initiating dispatch to finish its reach gate and respond.
        const ghDelay = process.env["MITOSIS_GOALHOST_RESTART_DELAY_S"] ?? "30";
        const ghTsUnit = `mitosis-goalhost-restart-${mitosis_version_id}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 90);
        try {
          const sysdRun = process.env["SYSTEMD_RUN_CMD"] ?? "systemd-run";
          const proc = Bun.spawnSync(
            [sysdRun, `--on-active=${ghDelay}s`, `--unit=${ghTsUnit}`, "--collect", "systemctl", "restart", unit],
            { stdout: "pipe", stderr: "pipe" },
          );
          vesselRestarted = (proc.exitCode ?? 1) === 0;
          operations.push({
            op: `deferred restart via systemd-run (--on-active=${ghDelay}s) ${unit}`,
            status: vesselRestarted ? "ok" : "warn",
            detail: vesselRestarted ? `transient unit ${ghTsUnit} (fires after initiating dispatch completes)` : (proc.stderr ? new TextDecoder().decode(proc.stderr).slice(0, 200) : "systemd-run failed"),
          });
        } catch (err) {
          operations.push({ op: `deferred restart ${unit}`, status: "warn", detail: (err as Error).message.slice(0, 200) });
        }
      } else {
        const restart = await runSystemctl(["restart", unit]);
        vesselRestarted = restart.exitCode === 0;
        operations.push({
          op: `systemctl restart ${unit}`,
          status: vesselRestarted ? "ok" : "warn",
          detail: vesselRestarted ? undefined : restart.stderr.slice(0, 200),
        });
      }
    }
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
  // Threaded to the pending-land stamp below: a behavioral verification that RAN and
  // FAILED must NOT earn landed_verified credit. Stays false when the check does not run
  // (no verification_spec) or passes, preserving the existing stamp behaviour there.
  let behavioralVerificationFailed = false;
  // Post-landing behavioral verification (gap cutover-gate-no-behavioral-verification):
  // execute the driving gap's structured verification_spec; a failure rewrites the
  // gap summary, which re-triggers gap-compose pickup.
  if (gapId !== "unknown-gap") {
    try {
      const gapRead = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 } as never);
      const gapRow = ((gapRead as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps ?? [])[0];
      const meta = (gapRow?.["classification_metadata"] ?? {}) as Record<string, unknown>;
      const spec = meta["verification_spec"];
      if (gapRow && spec) {
        const outcome = await runBehavioralVerification(spec);
        if (outcome.ran) {
          const priorSummary = String(gapRow["summary"] ?? "");
          const nextSummary = outcome.passed
            ? priorSummary
            : `BEHAVIORAL VERIFICATION FAILED after ${String(newSha)}: ${priorSummary}`;
          if (!outcome.passed) {
            behavioralVerificationFailed = true;
            console.log(`[mitosis-cutover] behavioral-verification FAILED gap=${gapId} commit=${String(newSha)}`);
          }
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              ...gapRow,
              summary: nextSummary,
              classification_metadata: {
                ...meta,
                verification_outcome: { passed: outcome.passed, at: appliedAt, commit: newSha, observed: outcome.observed ?? null, error: outcome.error ?? null },
              },
            },
          } as never);
        }
      }
    } catch (err) {
      console.warn("[mitosis-cutover] behavioral-verification errored (non-fatal):", err);
    }
  }

  // Post-landing SUITE verification, in-band (gap change-fitness-lane-is-out-of-band-github-ci).
  //
  // The behavioral verification above only runs when the driving gap carries a
  // verification_spec, and returns {ran:false} otherwise — which is the common case, so most
  // landings were verified by nothing that the substrate could observe. The lanes that DID
  // check a landed change both sat outside the system: GitHub Actions (runs in no vessel,
  // untraced, outcome arrives as an env-gated webhook) and host-pull-sync.sh (host-side,
  // detection-only, writes an operator log and emits no shape). External CI is an antipattern
  // here unless it runs on a compliant container vessel.
  //
  // Run the landed vessel's own suite through the test_suite resolver — in-container, via the
  // same shell primitive feature_compose already verifies with — and emit the outcome as a
  // SHAPE keyed to the landed sha. That is what makes the fitness of a change computable from
  // activity outcomes rather than inferable from an external badge. Best-effort throughout:
  // this observes the landing, it does not gate it, and a reporting failure must never fail a
  // cutover that already succeeded.
  try {
    const suite = await resolveTestSuite({
      vessel: vessel_name,
      landed_sha: newSha,
      gap_id: gapId,
      proposal_id: proposalId,
    });
    const sb = (suite as { body?: Record<string, unknown> }).body ?? {};
    // Carry it on the emitted cutoverApplied shape (and the applied log) so a landing and
    // its verification are ONE observable record. Two records that must be joined by hand
    // is how the outcome of a change stayed unattributable in the first place.
    (appliedBody as Record<string, unknown>).post_land_suite = {
      ran: sb.ran ?? false,
      pass: sb.pass ?? null,
      fail: sb.fail ?? null,
      skip: sb.skip ?? null,
    };
    console.log(
      `[mitosis-cutover] post-land suite vessel=${vessel_name} commit=${String(newSha).slice(0, 10)} ran=${String(sb.ran)} pass=${String(sb.pass)} fail=${String(sb.fail)}`,
    );
    // A red suite after landing is a regression signal the system should act on, not a log
    // line. Reuse the gap store (already advertised, already traced) rather than inventing a
    // second alarm channel.
    if (sb.ran === true && typeof sb.fail === "number" && sb.fail > 0) {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: `post-land-suite-red-${String(vessel_name).replace(/[^a-zA-Z0-9]+/g, "-")}`,
          category: "systematic_failure",
          source: "substrate_detected",
          summary:
            `Post-landing suite for ${vessel_name} reports ${String(sb.fail)} failing / ${String(sb.pass)} passing after ${String(newSha).slice(0, 10)} ` +
            `(gap ${gapId}, proposal ${proposalId}). Failing: ${Array.isArray(sb.failingTests) ? (sb.failingTests as string[]).slice(0, 5).join(" ; ").slice(0, 400) : "n/a"}`,
          detected_at: appliedAt,
          status: "open",
        },
      } as never);
    }
  } catch (err) {
    console.warn("[mitosis-cutover] post-land suite verification errored (non-fatal):", err);
  }
  // Land->close credit for the apply-proposal->cutover path (gap
  // apply-proposal-as-patch-success-earns-no-gap-triple-credit). The ONLY gap
  // closer was gap-to-feature's closeLandedGap, which never runs on the
  // route-edit->feature_compose->apply_proposal_as_patch->cutover landing -- so a
  // substrate-authored landing here scored zero on the gap triple. Reuse the
  // EXISTING pending-land verification sweep (gap-to-feature
  // sweepPendingLandVerifications) by stamping
  // classification_metadata.pending_outcome_verification = <pushed sha> on the
  // driving gap; that sweep closes it with closed_reason=landed_verified once the
  // sha is observable as an ancestor of a clone HEAD AND the gap condition is no
  // longer present (its verifyGapCondition is the hollow-land guard -- a stub land
  // is stamped but NOT closed). Do NOT close here: post-cutover verification must
  // run in a later tick against the synced clone, exactly like the self-cutover
  // deferral. Guarded: stamp only a DURABLE, still-open gap (an ephemeral
  // route-edit-<hash> proposal id has no gap row -> skip, never create a phantom
  // gap), only on a real origin push (pushStatus==="pushed" -> newSha is on
  // origin; host_sync_pending re-commits a different sha host-side), idempotent.
  if (gapId !== "unknown-gap" && pushStatus === "pushed" && /^[0-9a-f]{7,40}$/i.test(newSha) && !behavioralVerificationFailed) {
    try {
      const stampRead = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 } as never);
      const stampRow = ((stampRead as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps ?? [])[0];
      if (stampRow && String(stampRow["status"] ?? "") !== "closed") {
        const stampMeta = (stampRow["classification_metadata"] ?? {}) as Record<string, unknown>;
        if (stampMeta["pending_outcome_verification"] !== newSha) {
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              ...stampRow,
              status: "open",
              classification_metadata: {
                ...stampMeta,
                pending_outcome_verification: newSha,
                pending_set_at: appliedAt,
              },
            },
          } as never);
          console.log(`[mitosis-cutover] pending-land stamp gap=${gapId} sha=${newSha.slice(0, 12)} (sweep will close as landed_verified)`);
        }
      }
    } catch (err) {
      console.warn("[mitosis-cutover] pending-land stamp errored (non-fatal):", err);
    }
  }
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

  // Clear the pending slot so the next mitosis can be queued (before FAVORABLE success return).
  const _preClearPendingPath = pointer.pending_pointer_path ?? join(workspaceRoot, "mitosis-pending.json");
  try {
    if (await pathExists(_preClearPendingPath)) {
      await unlink(_preClearPendingPath);
      operations.push({ op: "pre-return clear mitosis-pending.json", status: "ok" });
    }
  } catch {
    // Non-fatal: file may already be absent
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
        cited_trace_ids: (evaluationEvidence.cited_trace_ids ?? []).slice(0, 10),
        cited_check_names: (evaluationEvidence.cited_check_names ?? []).slice(0, 10),
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

  // SELF-ACTIVATION (2026-06-26): the host-sync path defers git durability to the
  // host poller and does NOT mirror locally, so without this a substrate-authored
  // scripts/substrate/*.ts change would not go live until the poller commits AND a
  // container restart remounted the bind. Activate the run-dir copy now (non-fatal,
  // scoped to scripts/substrate/*.ts) so the change takes effect on the next timer
  // firing regardless of when the host poller lands the commit.
  try {
    await maybeActivateSubstrateScripts({
      mitosisRoot: args.mitosisRoot,
      stagedFiles: args.stagedFiles,
    });
  } catch {
    /* non-fatal: activation never blocks the host-sync intent path */
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
      cited_trace_ids: (args.evaluationEvidence.cited_trace_ids ?? []).slice(0, 10),
      cited_check_names: (args.evaluationEvidence.cited_check_names ?? []).slice(0, 10),
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
