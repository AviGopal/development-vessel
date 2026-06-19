import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { METABOB_API_KEY } from "../config.js";

/**
 * push_health_observer (2026-06-19) — promotes substrate self-PUSH health into
 * impulse form. The substrate authors commits autonomously (vessel-mitosis
 * cutover); those commits are only durable once they reach origin/dev. Two push
 * paths exist:
 *
 *   - in-container HTTPS push (uses SUBSTRATE_GIT_PAT via a credential helper).
 *     When the PAT is invalid / lacks `Contents: write`, EVERY push fails with
 *     "Invalid username or token." and the cutover degrades to local_only.
 *   - host-sync poller (host SSH key) — the DURABLE path. The cutover emits an
 *     intent to mitosis-applied-host-sync.jsonl; the host poller commits+pushes
 *     and writes mitosis-applied-host-sync-results.jsonl with push_status.
 *
 * If BOTH degrade silently, the substrate keeps "authoring" while nothing lands
 * on origin — a silent learning loss (the work is burned). This observer scans
 * recent push outcomes and emits a substrateGap when a SUSTAINED push-failure
 * condition holds, distinguishing operator-territory causes (invalid PAT — needs
 * a refreshed credential) from substrate-fixable ones (poller wedged / intents
 * piling up unprocessed).
 *
 * Signals scanned:
 *   1. host-sync results: recent entries with push_status != "pushed".
 *   2. host-sync intents with NO matching result line (stuck unpushed).
 *   3. cutoverApplied log: recent push_status == "local_only" (in-container push
 *      failed AND the host-sync fallback did not flip it to host_sync_pending).
 *   4. live in-container PAT git-auth probe (operator-territory classifier).
 *
 * Follows the systemd-unit-health-observer contract: emit one substrateGap into
 * the dev-vessel impulse resolver so it flows to drain-pending-substrate-gaps ->
 * the drafter, and return a structured health body for observation.
 */

const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const DEFAULT_WORKSPACE = process.env["WORKSPACE_ROOT"] ?? "/workspace";

export interface PushHealthObserverPointer {
  type: "push_health_observer";
  /** Override workspace root holding the mitosis jsonl files. */
  workspaceRoot?: string;
  /** How many most-recent results/intents to consider. Default 25. */
  window?: number;
  /** Min failing outcomes in-window to call it SUSTAINED. Default 3. */
  failThreshold?: number;
  /** Probe the in-container PAT git-auth path to classify cause. Default true. */
  probePat?: boolean;
  /** Repo to probe the PAT against (AviGopal/<repo>). Default development-vessel. */
  patProbeRepo?: string;
  /** Emit a substrateGap when SUSTAINED failure detected. Default true. */
  emitGap?: boolean;
  devVesselImpulsesUrl?: string;
  /** Test hook: override the jsonl file paths directly. */
  resultsPath?: string;
  intentPath?: string;
  appliedLogPath?: string;
}

interface JsonlEntry {
  [k: string]: unknown;
}

async function readJsonl(path: string): Promise<JsonlEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const out: JsonlEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as JsonlEntry);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Probe whether the in-container PAT can authenticate git operations against
 * the push endpoint. Returns "valid" | "invalid" | "no_pat".
 * Uses the SAME credential-helper form the cutover push uses, so the result
 * matches real push behavior (the GitHub REST API is NOT a valid proxy -- a
 * fine-grained PAT can pass /user yet be rejected for git ops).
 */
async function probePatGitAuth(
  repo: string,
): Promise<"valid" | "invalid" | "no_pat"> {
  const pat = process.env["SUBSTRATE_GIT_PAT"] ?? "";
  if (!pat) return "no_pat";
  // Advisory only. The fine-grained PAT in use authenticates git ops MOST of the
  // time but intermittently fails ("Invalid username or token.") — GitHub
  // fine-grained-PAT flakiness / rate-limiting. There is no cheap read-only probe
  // that perfectly predicts a future push (push --dry-run short-circuits to
  // "Everything up-to-date" when nothing is ahead, never touching auth). So we
  // use a retry-tolerant ls-remote through ONLY our helper (inherited helpers
  // cleared) and report "invalid" only if it fails repeatedly. The AUTHORITATIVE
  // push-health signal is the observed outcome history (host-sync results +
  // local_only cutovers), not this probe — the probe just helps classify cause.
  const helper = `!f() { echo username=x-access-token; echo "password=${pat}"; }; f`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "git",
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helper}`,
          "ls-remote",
          "--heads",
          `https://github.com/AviGopal/${repo}.git`,
          "dev",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      const code = await proc.exited;
      if (code === 0) return "valid";
    } catch {
      /* retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
  }
  return "invalid";
}

async function emitPushGap(
  emitUrl: string,
  apiKey: string,
  args: {
    summary: string;
    cause: "operator_invalid_pat" | "poller_wedged" | "push_failing";
    operatorTerritory: boolean;
    remediation: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          // Stable id per cause so repeated detections upsert rather than flood.
          id: `substrate-self-push-${args.cause}`,
          category: "service_failure",
          source: "substrate_detected",
          status: "open",
          summary: args.summary,
          detected_at: new Date().toISOString(),
          classification_metadata: {
            detector: "push_health_observer",
            cite_principle:
              "an_authored_commit_that_never_reaches_origin_is_a_silent_learning_loss",
            cause: args.cause,
            operator_territory: args.operatorTerritory,
            // harm: authored fixes are burned -- the loop keeps drafting work
            // that never lands.
            success_rate: 0,
            samples: 5,
            suggested_remediation: args.remediation,
            ...args.metadata,
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function resolvePushHealthObserver(
  pointer: PushHealthObserverPointer,
): Promise<ResolverResult> {
  const ws = pointer.workspaceRoot ?? DEFAULT_WORKSPACE;
  const window = pointer.window ?? 25;
  const failThreshold = pointer.failThreshold ?? 3;
  const resultsPath =
    pointer.resultsPath ?? join(ws, "mitosis-applied-host-sync-results.jsonl");
  const intentPath =
    pointer.intentPath ?? join(ws, "mitosis-applied-host-sync.jsonl");
  const appliedLogPath =
    pointer.appliedLogPath ?? join(ws, "mitosis-applied.jsonl");

  const [results, intents, applied] = await Promise.all([
    readJsonl(resultsPath),
    readJsonl(intentPath),
    readJsonl(appliedLogPath),
  ]);

  // 1. host-sync results in-window. Distinguish a genuine PUSH failure (commit
  // created but `git push` rejected — push_status "local_only" / detail cites
  // auth) from an upstream GATE rejection (rejected_base_sha / scope_creep /
  // commit_failed): the latter are the cutover staging stale or out-of-scope
  // files, NOT a push-credential problem, and are surfaced by other detectors.
  // Only genuine push failures should drive the push-credential classification.
  const recentResults = results.slice(-window);
  const isGenuinePushFail = (r: JsonlEntry): boolean => {
    const st = (r["push_status"] as string) ?? "";
    const detail = ((r["detail"] as string) ?? "").toLowerCase();
    if (st === "local_only") return true; // poller committed but push failed
    return /push failed|authentication|invalid username or token|password authentication/.test(detail);
  };
  const pushFailures = recentResults.filter(isGenuinePushFail);
  const gateRejections = recentResults.filter(
    (r) => {
      const st = (r["push_status"] as string) ?? "";
      return st !== "pushed" && !isGenuinePushFail(r);
    },
  );
  // Back-compat alias used by the decision/return below.
  const resultFailures = pushFailures;

  // 2. Stuck intents: pending intents with no matching result line at all.
  const resultIds = new Set(results.map((r) => r["intent_id"] as string));
  const recentIntents = intents.slice(-window);
  const stuckIntents = recentIntents.filter(
    (i) =>
      (i["status"] as string) === "pending" &&
      !resultIds.has(i["intent_id"] as string),
  );

  // 3. cutoverApplied log: recent local_only (in-container push failed AND the
  // host-sync fallback did not flip it to host_sync_pending/pushed).
  const recentApplied = applied.slice(-window);
  const localOnly = recentApplied.filter((a) => {
    const b = (a["body"] ?? a) as JsonlEntry;
    return (b["push_status"] as string) === "local_only";
  });

  // 4. PAT git-auth probe (operator-territory classifier).
  let patStatus: "valid" | "invalid" | "no_pat" | "not_probed" = "not_probed";
  if (pointer.probePat !== false) {
    patStatus = await probePatGitAuth(pointer.patProbeRepo ?? "development-vessel");
  }

  // SUSTAINED push failure decision:
  //  - N+ host-sync results NOT pushed in-window, OR
  //  - N+ intents stuck with no result (poller not draining), OR
  //  - N+ local_only cutovers (push path dead end), OR
  //  - PAT cannot auth git (in-container fast path broken) AND there is recent
  //    cutover activity at all (so we only warn when it actually matters).
  const recentCutoverActivity =
    recentResults.length + recentIntents.length + recentApplied.length > 0;
  const sustainedResultFail = resultFailures.length >= failThreshold;
  const sustainedStuck = stuckIntents.length >= failThreshold;
  const sustainedLocalOnly = localOnly.length >= failThreshold;
  const patBroken = patStatus === "invalid" || patStatus === "no_pat";

  let cause:
    | "operator_invalid_pat"
    | "poller_wedged"
    | "push_failing"
    | null = null;
  let operatorTerritory = false;
  let summary = "";
  let remediation = "";

  if (sustainedStuck) {
    // Intents are emitted but the host poller is NOT writing results -> the
    // durable path itself is down. Substrate-adjacent (host unit), but surfaced
    // so the operator restarts/repairs the poller.
    cause = "poller_wedged";
    operatorTerritory = true; // host-side unit; substrate cannot restart it
    summary =
      `substrate self-push failing: ${stuckIntents.length} host-sync intent(s) pending with NO poller result in the last ${window}. ` +
      `The host-sync-poller (durable SSH push path) appears wedged or not running -- authored commits are queued but not landing on origin/dev.`;
    remediation =
      "On the host: `systemctl --user status host-sync-poller.timer host-sync-poller.service` and `journalctl --user -u host-sync-poller.service`. Restart with `systemctl --user restart host-sync-poller.timer`. Confirm `repos/<vessel>` host clones have a reachable SSH origin.";
  } else if (sustainedResultFail) {
    cause = "push_failing";
    operatorTerritory = false;
    const detailSample = (resultFailures[resultFailures.length - 1]?.["detail"] as string) ?? "";
    summary =
      `substrate self-push failing: ${resultFailures.length}/${recentResults.length} recent host-sync results were not pushed (push_status != "pushed"). ` +
      `Last detail: ${detailSample.slice(0, 160)}`;
    remediation =
      "Inspect mitosis-applied-host-sync-results.jsonl detail fields. If 'push failed' cites auth, refresh the host SSH key / origin; if scope_creep / base_sha, the cutover is staging stale or out-of-scope files.";
  } else if (patBroken && (sustainedLocalOnly || (recentCutoverActivity && localOnly.length > 0))) {
    cause = "operator_invalid_pat";
    operatorTerritory = true;
    summary =
      `substrate self-push degraded: in-container SUBSTRATE_GIT_PAT ${patStatus === "no_pat" ? "is absent" : "cannot authenticate git operations"} ` +
      `(${localOnly.length} recent cutover(s) reported local_only). The in-container HTTPS fast-path push is dead; commits should still land via the host-sync poller (SSH). ` +
      `OPERATOR ACTION: refresh SUBSTRATE_GIT_PAT (needs 'Contents: write') to restore the in-container fast path.`;
    remediation =
      "Refresh SUBSTRATE_GIT_PAT in /workspace/.substrate-secrets (fine-grained PAT with Contents: Read+Write on the AviGopal vessel repos), restart git-push-setup.service. Verify the host-sync poller is landing commits in the meantime so authoring is not blocked.";
  }

  const sustained = cause !== null;
  let gapEmitted = false;
  if (sustained && pointer.emitGap !== false && cause) {
    const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
    const apiKey = process.env["METABOB_API_KEY"] ?? METABOB_API_KEY;
    gapEmitted = await emitPushGap(emitUrl, apiKey, {
      summary,
      cause,
      operatorTerritory,
      remediation,
      metadata: {
        window,
        fail_threshold: failThreshold,
        result_failures: resultFailures.length,
        stuck_intents: stuckIntents.length,
        local_only_cutovers: localOnly.length,
        pat_git_auth: patStatus,
        recent_results: recentResults.length,
        recent_intents: recentIntents.length,
      },
    });
  }

  return {
    shape: "pushHealth",
    body: {
      sustained_push_failure: sustained,
      cause,
      operator_territory: operatorTerritory,
      summary: sustained ? summary : "push path healthy (no sustained failure detected)",
      pat_git_auth: patStatus,
      signals: {
        window,
        fail_threshold: failThreshold,
        recent_results: recentResults.length,
        // genuine push failures (push attempted + rejected)
        push_failures: pushFailures.length,
        // upstream gate rejections (stale base / scope creep) — NOT a push-credential issue
        gate_rejections: gateRejections.length,
        recent_intents: recentIntents.length,
        stuck_intents: stuckIntents.length,
        recent_cutovers: recentApplied.length,
        local_only_cutovers: localOnly.length,
      },
      gap_emitted: gapEmitted,
      generated_at: new Date().toISOString(),
    },
  };
}
