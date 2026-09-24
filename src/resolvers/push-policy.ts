import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { readRecords } from "./attempt-ledger.js";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";

// pushPolicy — the shaped impulse that scopes where a landing may go (law 1).
//
// Push is a CAPABILITY (a git credential), and its SCOPE is SUBSTRATE_REPO_OWNER:
// a landing into another owner's repositories, or onto a target this policy
// declares shared (a branch other substrates converge their running code to),
// needs a PROMOTION recorded here. A promotion is accepted only when every piece
// of evidence it cites resolves at write time: each attempt id to a landing the
// attempt ledger settled as `held`, each trace id to an execution the trace store
// graded `reached`. The landing route reads this at landing time, so granting or
// withdrawing a promotion takes effect on the next landing without a restart.
//
// REGIME IS A VOLUME FACT. The policy file lives on the workspace volume. A volume
// with no policy file keeps landing exactly where its push clone points, as it
// always has (grandfathered): nothing in this vessel creates the file on its own.
// A volume with a policy file is in the scoped regime, whatever the file says,
// and stays there across every restart of that volume. A new install enters it
// only when the bootstrap writes an initial policy (no promotion) the first time
// the volume is created; until the bootstrap does, a new volume is grandfathered
// like an old one. No environment variable decides the regime.
//
// MITOSIS_DIRECT_PUSH=0 is the emergency stop. It is the only push behaviour an
// environment variable controls, and gateLanding applies it before this policy is
// consulted, for every push path in this vessel.

// Read at use time (not module load) so a test or an operator pointing the
// path elsewhere is honoured without a restart.
function policyPath(): string {
  return process.env["PUSH_POLICY_PATH"] ?? "/workspace/push-policy.json";
}

/** What pushPolicy_write confirmed when it accepted a promotion. */
export interface VerifiedEvidence {
  attempt_ids: string[];
  trace_ids: string[];
  verified_at: string;
}

export interface PushPolicyEvidence {
  /** Attempt-ledger ids of landings settled as held. */
  attempt_ids?: string[];
  /** Traces of the activity that verified those landings (graded reached). */
  trace_ids?: string[];
  note?: string;
  /** Set only by pushPolicy_write after every cited id resolved. */
  verified?: VerifiedEvidence;
}

export interface PushPolicyPromotion {
  granted: boolean;
  /**
   * Targets the promotion covers, as `owner`, `owner/repo` or
   * `owner/repo@branch` (`*` matches any segment). Absent = every shared target.
   */
  targets?: string[];
  evidence?: PushPolicyEvidence;
}

export interface PushPolicyBody {
  /** False when no pushPolicy has ever been recorded (the grandfathered state). */
  exists: boolean;
  promotion: PushPolicyPromotion;
  /**
   * Targets of the substrate's OWN owner that other substrates converge to and
   * so also require a promotion, in the same pattern form as promotion.targets.
   * Another owner's target is always shared; this only adds own-owner targets.
   */
  shared_targets?: string[];
  set_by?: string;
  set_at?: string;
  reason?: string;
}

interface PushPolicyPointer {
  type: "pushPolicy";
}

interface PushPolicyWritePointer {
  type: "pushPolicy_write";
  promotion?: PushPolicyPromotion;
  shared_targets?: string[];
  set_by?: string;
  reason?: string;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out;
}

function coerceVerified(v: unknown): VerifiedEvidence | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const attempt_ids = stringArray(r["attempt_ids"]) ?? [];
  const trace_ids = stringArray(r["trace_ids"]) ?? [];
  const verified_at = typeof r["verified_at"] === "string" ? r["verified_at"] : "";
  if (!verified_at) return undefined;
  return { attempt_ids, trace_ids, verified_at };
}

function coerceEvidence(v: unknown): PushPolicyEvidence | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  const attempt_ids = stringArray(e["attempt_ids"]);
  const trace_ids = stringArray(e["trace_ids"]);
  const note = typeof e["note"] === "string" ? e["note"] : undefined;
  const verified = coerceVerified(e["verified"]);
  return {
    ...(attempt_ids ? { attempt_ids } : {}),
    ...(trace_ids ? { trace_ids } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(verified ? { verified } : {}),
  };
}

/**
 * A promotion counts only when it is granted AND its evidence was verified on
 * write: at least one settled-held landing and at least one reached verifying
 * trace, with every cited id among them. A bare `granted:true`, or ids that were
 * never resolved (a hand-edited file), is not earned.
 */
export function promotionIsCited(p: PushPolicyPromotion | undefined): boolean {
  if (!p || p.granted !== true) return false;
  const ev = p.evidence;
  const v = ev?.verified;
  if (!v) return false;
  const cited = [...(ev?.attempt_ids ?? []), ...(ev?.trace_ids ?? [])];
  const verified = new Set([...v.attempt_ids, ...v.trace_ids]);
  return v.attempt_ids.length > 0 && v.trace_ids.length > 0 && cited.every((id) => verified.has(id));
}

export function resolvePushPolicy(
  _pointer: PushPolicyPointer,
): { shape: "pushPolicy"; body: PushPolicyBody } {
  let body: PushPolicyBody = { exists: false, promotion: { granted: false } };
  let raw: string;
  try {
    raw = readFileSync(policyPath(), "utf8");
  } catch {
    // absent — the grandfathered state
    return { shape: "pushPolicy", body };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const p = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const promoRaw = (p["promotion"] !== null && typeof p["promotion"] === "object" ? p["promotion"] : {}) as Record<string, unknown>;
    const targets = stringArray(promoRaw["targets"]);
    const evidence = coerceEvidence(promoRaw["evidence"]);
    const shared = stringArray(p["shared_targets"]);
    body = {
      exists: true,
      promotion: {
        granted: promoRaw["granted"] === true,
        ...(targets ? { targets } : {}),
        ...(evidence ? { evidence } : {}),
      },
      ...(shared ? { shared_targets: shared } : {}),
      ...(typeof p["set_by"] === "string" ? { set_by: p["set_by"] } : {}),
      ...(typeof p["set_at"] === "string" ? { set_at: p["set_at"] } : {}),
      ...(typeof p["reason"] === "string" ? { reason: p["reason"] } : {}),
    };
  } catch {
    // A file that exists but cannot be parsed is a recorded policy we cannot
    // read. Treat it as present with no promotion — failing closed — rather
    // than as absent, which would silently re-open the grandfathered path.
    console.error(`[push-policy] ${policyPath()} is unparseable; treating as a policy with no promotion`);
    body = { exists: true, promotion: { granted: false }, reason: "unparseable policy file" };
  }
  return { shape: "pushPolicy", body };
}

// ---- evidence verification (pushPolicy_write) ----

/** How a cited id is checked. Injected in tests; the defaults read the attempt ledger and the trace store. */
export interface EvidenceResolvers {
  /** The latest settlement verdict for an attempt id, or null when it has none. */
  settlementVerdict(attemptId: string): string | null;
  /** The trace's reach grade: true/false when graded, null when ungraded, "missing" when absent. Throws when the store cannot be asked. */
  traceReached(traceId: string): Promise<boolean | null | "missing">;
}

function latestSettlementVerdict(attemptId: string): string | null {
  // Settlements are keyed `<attempt_id>#<seq>`; a later settlement supersedes an earlier one.
  const rows = readRecords("attemptSettlement").filter((r) =>
    r.key.startsWith(`${attemptId}#`) || (r.record as { attempt_id?: unknown })["attempt_id"] === attemptId);
  if (rows.length === 0) return null;
  const seq = (r: (typeof rows)[number]) => Number((r.record as { settlement_seq?: unknown })["settlement_seq"] ?? 0) || 0;
  rows.sort((a, b) => seq(a) - seq(b) || a.at.localeCompare(b.at));
  const v = (rows[rows.length - 1]!.record as { verdict?: unknown })["verdict"];
  return typeof v === "string" ? v : null;
}

async function fetchTraceReached(traceId: string): Promise<boolean | null | "missing"> {
  const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/execution-traces/${encodeURIComponent(traceId)}`, {
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return "missing";
  if (!res.ok) throw new Error(`trace store answered ${res.status}`);
  const body = (await res.json()) as { reached?: unknown };
  return typeof body.reached === "boolean" ? body.reached : null;
}

const DEFAULT_RESOLVERS: EvidenceResolvers = {
  settlementVerdict: latestSettlementVerdict,
  traceReached: fetchTraceReached,
};

export async function verifyPromotionEvidence(
  evidence: PushPolicyEvidence | undefined,
  resolvers: EvidenceResolvers = DEFAULT_RESOLVERS,
): Promise<{ ok: true; verified: VerifiedEvidence } | { ok: false; problems: string[] }> {
  const attempts = evidence?.attempt_ids ?? [];
  const traces = evidence?.trace_ids ?? [];
  const problems: string[] = [];
  if (attempts.length === 0) problems.push("no attempt_ids cited (landings settled as held)");
  if (traces.length === 0) problems.push("no trace_ids cited (the verifying activity's reached traces)");
  for (const id of attempts) {
    let verdict: string | null;
    try {
      verdict = resolvers.settlementVerdict(id);
    } catch (e) {
      problems.push(`attempt ${id}: the attempt ledger could not be read (${(e as Error).message})`);
      continue;
    }
    if (verdict === null) problems.push(`attempt ${id}: no settlement in the attempt ledger`);
    else if (verdict !== "held") problems.push(`attempt ${id}: settled as ${verdict}, not held`);
  }
  for (const id of traces) {
    let reached: boolean | null | "missing";
    try {
      reached = await resolvers.traceReached(id);
    } catch (e) {
      // Fail closed: a citation that cannot be checked is not evidence.
      problems.push(`trace ${id}: the trace store could not be asked (${(e as Error).message})`);
      continue;
    }
    if (reached === "missing") problems.push(`trace ${id}: not found in the trace store`);
    else if (reached !== true) problems.push(`trace ${id}: ${reached === false ? "graded not reached" : "not graded"}`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, verified: { attempt_ids: [...attempts], trace_ids: [...traces], verified_at: new Date().toISOString() } };
}

export async function resolvePushPolicyWrite(
  pointer: PushPolicyWritePointer,
  resolvers: EvidenceResolvers = DEFAULT_RESOLVERS,
): Promise<
  | { shape: "pushPolicyWriteResult"; body: { ok: true; granted: boolean; shared_targets: string[]; verified?: VerifiedEvidence } }
  | { shape: "structuredError"; body: Record<string, unknown> }
> {
  const promoIn = (pointer.promotion ?? { granted: false }) as PushPolicyPromotion;
  const targets = stringArray(promoIn.targets);
  // A caller never supplies `verified`: it is what this write establishes.
  const { verified: _callerVerified, ...cited } = coerceEvidence(promoIn.evidence) ?? {};
  const granted = promoIn.granted === true;
  let evidence: PushPolicyEvidence | undefined = Object.keys(cited).length > 0 ? cited : undefined;
  if (granted) {
    const check = await verifyPromotionEvidence(evidence, resolvers);
    if (!check.ok) {
      return {
        shape: "structuredError",
        body: {
          resolver: "pushPolicy_write",
          error: "promotion_evidence_unverified",
          problems: check.problems,
          message:
            "A promotion must cite evidence that resolves: promotion.evidence.attempt_ids naming landings the attempt " +
            "ledger settled as held, and promotion.evidence.trace_ids naming the verifying activity's traces graded " +
            "reached. Nothing was written. To withdraw a promotion, write promotion.granted=false.",
        },
      };
    }
    evidence = { ...cited, verified: check.verified };
  }
  const promotion: PushPolicyPromotion = {
    granted,
    ...(targets ? { targets } : {}),
    ...(evidence ? { evidence } : {}),
  };
  const shared_targets = stringArray(pointer.shared_targets) ?? [];
  const data = {
    promotion,
    shared_targets,
    set_by: pointer.set_by ?? "unattributed",
    set_at: new Date().toISOString(),
    reason: pointer.reason ?? "",
  };
  const path = policyPath();
  const tmp = `${path}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
  return {
    shape: "pushPolicyWriteResult",
    body: { ok: true, granted, shared_targets, ...(evidence?.verified ? { verified: evidence.verified } : {}) },
  };
}

// ---- landing scope evaluation (pure; read by every push path) ----

export interface LandingTarget {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Owner and repository of a git remote URL. Handles plain https, https with
 * embedded credentials (`https://x-access-token:<t>@github.com/Owner/repo.git`),
 * scp-form ssh (`git@github.com:Owner/repo.git`) and `ssh://` URLs. Returns null
 * for anything else, including a local path.
 */
export function parseRemoteTarget(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const u = url.trim();
  let path: string | null = null;
  const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/:]+(?::\d+)?\/(.+)$/i);
  if (scheme) path = scheme[1] ?? null;
  else {
    const scp = u.match(/^(?:[^@/]+@)?[^/:]+:(?!\/)(.+)$/);
    if (scp) path = scp[1] ?? null;
  }
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2]!;
  const repo = parts[parts.length - 1]!;
  return { owner, repo };
}

/** Normalise an owner value from the environment (systemd strips quotes; other loaders may not). */
export function normaliseOwner(v: string | undefined | null): string {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

function targetMatches(pattern: string, t: LandingTarget): boolean {
  const m = pattern.trim().toLowerCase().match(/^([^/@]+)(?:\/([^@]+))?(?:@(.+))?$/);
  if (!m) return false;
  const [, po, pr, pb] = m;
  const seg = (p: string | undefined, v: string) => p === undefined || p === "*" || p === v.toLowerCase();
  return seg(po, t.owner) && seg(pr, t.repo) && seg(pb, t.branch);
}

export interface LandingScopeVerdict {
  allowed: boolean;
  /** grandfathered: no policy file on this volume; policy: a recorded pushPolicy. */
  regime: "grandfathered" | "policy";
  target: LandingTarget | null;
  scope_owner: string;
  shared: boolean;
  promoted: boolean;
  /**
   * The scope owner's copy of a target in another owner's repositories: the same
   * repository and branch under SUBSTRATE_REPO_OWNER. Null when the target is
   * already the owner's own, or no owner is set. A refusal names it; a refused
   * landing is not redirected to it.
   */
  scoped_target: { owner: string; repo: string | null; branch: string } | null;
  reason: string;
}

export function evaluateLandingScope(args: {
  remoteUrl: string | null;
  branch: string;
  scopeOwner: string | undefined;
  policy: PushPolicyBody;
}): LandingScopeVerdict {
  const scopeOwner = normaliseOwner(args.scopeOwner);
  const parsed = parseRemoteTarget(args.remoteUrl);
  const target: LandingTarget | null = parsed ? { ...parsed, branch: args.branch } : null;
  const otherOwner = !!target && !!scopeOwner && target.owner.toLowerCase() !== scopeOwner.toLowerCase();
  const scoped_target = otherOwner ? { owner: scopeOwner, repo: parsed?.repo ?? null, branch: args.branch } : null;
  const base = { target, scope_owner: scopeOwner, scoped_target };

  if (!args.policy.exists) {
    return {
      ...base,
      allowed: true,
      regime: "grandfathered",
      shared: false,
      promoted: false,
      reason: "no pushPolicy recorded on this volume; landing where the push clone points, unchanged",
    };
  }
  const regime = "policy" as const;
  if (!scopeOwner) {
    return {
      ...base, allowed: false, regime, shared: false, promoted: false,
      reason: "SUBSTRATE_REPO_OWNER is not set; a landing has no owner to be scoped to",
    };
  }
  if (!target) {
    return {
      ...base, allowed: false, regime, shared: false, promoted: false,
      reason: `landing target unknown: push remote ${args.remoteUrl ? `"${args.remoteUrl.replace(/\/\/[^@/]*@/, "//***@")}" is not an owner/repo URL` : "is not configured"}`,
    };
  }
  const declaredShared = (args.policy.shared_targets ?? []).some((p) => targetMatches(p, target));
  const shared = otherOwner || declaredShared;
  if (!shared) {
    return { ...base, allowed: true, regime, shared: false, promoted: false, reason: `target ${target.owner}/${target.repo}@${target.branch} is within scope ${scopeOwner}` };
  }
  const promo = args.policy.promotion;
  const covers = !promo.targets || promo.targets.length === 0 || promo.targets.some((p) => targetMatches(p, target));
  const promoted = promotionIsCited(promo) && covers;
  if (promoted) {
    return { ...base, allowed: true, regime, shared: true, promoted: true, reason: `shared target ${target.owner}/${target.repo}@${target.branch} promoted with verified evidence` };
  }
  const why = !promo.granted
    ? "no promotion recorded"
    : !promotionIsCited(promo)
      ? "the promotion's evidence was never verified"
      : "the promotion does not cover this target";
  const where = scoped_target
    ? `; this substrate's own scope is ${scoped_target.owner}/${target.repo}@${args.branch}`
    : "; the target is declared shared in pushPolicy.shared_targets";
  return {
    ...base,
    allowed: false,
    regime,
    shared: true,
    promoted: false,
    reason:
      `landing on shared target ${target.owner}/${target.repo}@${target.branch} requires a pushPolicy promotion ` +
      `(${why})${where}`,
  };
}

// ---- the one gate every push path calls ----

export type LandingGate =
  | { allowed: true; kind: "allowed"; scope: LandingScopeVerdict }
  | { allowed: false; kind: "push_kill_switch"; reason: string; scope: null }
  | { allowed: false; kind: "push_scope_refused"; reason: string; scope: LandingScopeVerdict };

/** True when MITOSIS_DIRECT_PUSH=0, the emergency stop for every landing. */
export function landingsStopped(): boolean {
  return process.env["MITOSIS_DIRECT_PUSH"] === "0";
}

export const KILL_SWITCH_REASON =
  "landings stopped: MITOSIS_DIRECT_PUSH=0 is the emergency stop; unset it (or set 1) and recreate to resume";

/**
 * The emergency stop, then the push scope, for a push of `branch` to the remote
 * whose push URL is `remoteUrl`. Reads the environment and the policy file at
 * call time, so a changed policy governs the very next push.
 */
export function gateLanding(args: { remoteUrl: string | null; branch: string }): LandingGate {
  if (landingsStopped()) return { allowed: false, kind: "push_kill_switch", reason: KILL_SWITCH_REASON, scope: null };
  const scope = evaluateLandingScope({
    remoteUrl: args.remoteUrl,
    branch: args.branch,
    scopeOwner: process.env["SUBSTRATE_REPO_OWNER"],
    policy: resolvePushPolicy({ type: "pushPolicy" }).body,
  });
  if (!scope.allowed) return { allowed: false, kind: "push_scope_refused", reason: scope.reason, scope };
  return { allowed: true, kind: "allowed", scope };
}
