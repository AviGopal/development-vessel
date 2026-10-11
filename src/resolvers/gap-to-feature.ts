import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose, priorAttemptFeedbackBlock, readParkedLanding, isDissentChild, dissentChildCheckRefusal } from "./feature-compose.js";
import { attemptEvidenceBlock, explicitLineHint, testTitleInSource } from "./retry-evidence.js";

// TYPE AUGMENTATION — allow callers to pass an optional 'directed' flag through the
// FeatureCompose pointer. feature-compose reads it via a local cast
// `(pointer as { directed?: boolean }).directed`, but the declared type did not include it,
// so an inline object literal caused TS2353 (excess-property check). Making it optional on
// the declared interface preserves runtime behavior while silencing the type error at the
// call site that forwards operator-directed intent.
declare module "./feature-compose.js" {
  interface FeatureComposePointer {
    directed?: boolean;
  }
}

import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES, takeBirthVerdictWithReport, type MintedBirthVerdict } from "./substrate-gap.js";
import { resolveAuthorProducer } from "./author-producer.js";
import { resolveDocDriftFix } from "./doc-drift-fix.js";
import { resolveReachabilityGapRepair } from "./reachability-gap-repair.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";
import { resolveUiWritePassthrough } from "./ui-write-passthrough.js";
// The human-question channel the closed landing verdict asks through (qa 10.2: injected per call, never imported).
const askHuman: Ask = (p) => resolveUiWritePassthrough(p as never);

import { DISCOVERY_ENDPOINT, METABOB_API_KEY, METABOB_ENDPOINT, GOAL_HOST_VESSEL_ENDPOINT } from "../config.js";
import { peekComposeCapacity, hasFreeComposeCapacity } from "../compose-slots.js";
import { readFile } from "node:fs/promises";
import { evaluatorTreeRoot } from "../lib/evaluator-tree.js";
import { gapEditSite, composeEligibilitySkipReason, isNonAttemptComposeResult } from "../judge/gap-eligibility.js";
import { vesselDirExists, identifyVessel, vesselsCloneRoot, ownedVessels, type SpendEnvelopeVerdict, discoverResolveUrls, spendEnvelopeAllows, autonomyScope, autonomyScopeExcludes } from "../judge/gap-policy.js";
import { verifyGapCondition, type GapCheckVerdict, evaluateGapCheck } from "../judge/gap-check-judge.js";
import { landabilityScore, readGapFresh, refreshHeldCalibration, readCalibration, gapClassOf, readClassPosteriors, sampleClassTheta, persistGapMetaPatch, predictLand, isHighConfidenceMiss, recordApproachDecision, recordPickIntent, recordAttemptEnd } from "../judge/gap-attempt-credit.js";
import { solicitedHumanGaps, type Ask, markPendingVerification, kickAutoRevert, sweepIfCloneHeadsMoved, gradeCapabilityCompose, liveProducerProbeClose, gradeTraceStoreDispatch, gradeTraceStoreDispatchError, settleReachabilityRepair, settleAuthorProducerMint, gradeCapabilityRouteResult, gradeSliceSequence, gradeComposeOutcome } from "../judge/gap-landing-verdict.js";
import { inheritedPredicateHolds, repoPathExists, existingEditTargets, chooseFirstActionable, admitActionableGaps, targetedComposeExclusion, findComposeOwner } from "../judge/gap-admission.js";

// The evaluator's tree is ONE resolver (lib/evaluator-tree.ts), shared with the class-1 classifier in substrate-gap
// so the label and the measurement read the same file.
const runtimeRoot = evaluatorTreeRoot;

// COMPOSE-HORIZON DEDUP — the one selection primitive, applied at the compose horizon.
// Ports boredom-vessel's gapGoalLastDispatchAt + GAP_GOAL_COOLDOWN_MS (src/index.ts:3451-3485)
// and goal-host's /run-goal in-flight coalesce: a gap composed within the cooldown is
// guaranteed-redundant work (VoI~0 for the duplicate — same gap id, only a jittering residual
// float differs). Filter cooled gaps out of the AUTO-pick candidate set so the picker ADVANCES
// to the next-best gap instead of re-composing the same top gap every ~60-90s tick. This is the
// missing horizon that let cost-model-miscalibrated re-compose 17x/60min and starve self-authoring.
const GAP_COMPOSE_COOLDOWN_MS = parseInt(process.env.GAP_COMPOSE_COOLDOWN_MS ?? "300000", 10);
const gapComposeLastAttemptAt = new Map<string, number>();
// COMPOSES IN FLIGHT, by gap id (count of running resolveGapToFeature calls holding the gap). The cooldown above
// expires after GAP_COMPOSE_COOLDOWN_MS while a compose can run far longer, so the auto-pick re-picked a gap whose
// compose was still running: measured, one gap picked at 22:54 and again at 23:19 with the first compose live, and
// the two outcomes then joined each other's decisions. The auto-pick excludes a gap held here; the hold is taken at
// pick time and released when resolveGapToFeature returns or throws. In-process, like the cooldown map.
const gapComposeInFlight = new Map<string, number>();
export function beginComposeInFlight(id: string): void { if (id) gapComposeInFlight.set(id, (gapComposeInFlight.get(id) ?? 0) + 1); }
export function endComposeInFlight(id: string): void {
  const n = (gapComposeInFlight.get(id) ?? 0) - 1;
  if (n > 0) gapComposeInFlight.set(id, n); else gapComposeInFlight.delete(id);
}
export function composeInFlight(id: string): boolean { return (gapComposeInFlight.get(id) ?? 0) > 0; }
// Per-FILE cooldown across cycles. The per-gap cooldown keys on gap id, and a failing family
// re-appears under fresh ids (-narrowed, recommit-*, near-duplicate route-edits), so one
// edit_site took every auto-pick for hours (2026-09-26: 15 of 15 picks on proxy.ts, 0 landed).
const SITE_COMPOSE_COOLDOWN_MS = 3 * GAP_COMPOSE_COOLDOWN_MS;
const siteComposeLastAttemptAt = new Map<string, number>();

/**
 * PER-GAP EXPONENTIAL BACKOFF — the brake `hopeless()` cannot apply.
 *
 * `hopeless()` is the only existing per-gap check and it is CATEGORY-grain:
 *
 *     const r = calib[String(g.category ?? "unknown")];
 *     if (!r || r.attempts < 8 || r.lands !== 0) return false;
 *
 * `r.lands !== 0` means a category that has EVER landed can never seal, however many
 * attempts one member accumulates. `edit_intent_route` lands routinely, so its members
 * are structurally unsealable. Measured 2026-08-31 across 425 open gaps: 678 failed
 * attempts, median 0, p90 4, and a single `edit_intent_route` gap
 * (`route-edit-e32a5778`) at 58 — the top ten gaps holding 27% of all retry. That gap
 * landed a commit at 19:44, was never marked as landed, and was composing again by
 * 19:53.
 *
 * The flat 5-minute cooldown treats attempt 1 and attempt 58 identically. This does not:
 * each successive failure doubles the wait, so a gap that cannot be fixed decays toward
 * one attempt a day instead of one every 25 minutes, while a gap that fails once is
 * barely slowed.
 *
 *     fa   1     2      3      4      5      6      7      8      9+
 *     wait 0     10m    20m    40m    80m    2h40   5h20   10h40  24h (capped)
 *
 * NOT A SEAL. Every gap stays selectable forever — this changes the RATE, never the
 * eligibility. That matters because the alternative (a hard per-gap ceiling) is
 * irreversible without an operator, and a wrong ceiling silently abandons real work;
 * a wrong backoff only makes it slower, and detection at ~52 gaps/day re-surfaces
 * anything genuinely live.
 */
export const GAP_BACKOFF_BASE_MS = GAP_COMPOSE_COOLDOWN_MS;
export const GAP_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/**
 * How long a gap must wait after its Nth consecutive failure. 0 for a gap that has
 * never failed or failed once — the first retry is deliberately unpenalised, because a
 * single failure carries almost no evidence that the gap is unfixable.
 *
 * The exponent is clamped before the shift: `2 ** 58` is finite but astronomically
 * larger than the cap, and an unclamped `failed_attempts` read from a store this code
 * does not own is exactly where a NaN or a negative would turn a rate limit into an
 * accidental permanent seal.
 */
export function gapBackoffMs(failedAttempts: number): number {
  const fa = Number(failedAttempts);
  if (!Number.isFinite(fa) || fa <= 1) return 0;
  const doublings = Math.min(Math.floor(fa) - 1, 16);
  return Math.min(GAP_BACKOFF_MAX_MS, GAP_BACKOFF_BASE_MS * 2 ** doublings);
}

/**
 * Is this gap still serving its backoff?
 *
 * Reads the DURABLE `last_failed_at` that `bumpFailedAttempts` writes, not the
 * in-process `gapComposeLastAttemptAt` map. The map is cleared by every restart, and
 * mitosis cutovers restart this vessel several times a day — an in-process backoff
 * would reset to zero exactly when a runaway gap is at its worst.
 *
 * FAILS OPEN on anything it cannot read: a missing, malformed, or future-dated
 * `last_failed_at` returns false (eligible). Most gaps in the store carry no such
 * metadata at all, and a backoff that excluded them on absence would empty the
 * candidate pool and stop gap work altogether.
 */
export interface LineageBackoffState {
  /** Failed attempts summed over the whole lineage, not just this gap. */
  attempts: number;
  /** The most RECENT failure anywhere in the lineage, ms since epoch, or null. */
  lastFailedAtMs: number | null;
  /** How many ancestors were found, for logging. 0 = this gap is its own root. */
  depth: number;
}

/**
 * Total failure effort spent on the DEFECT, not on one gap id.
 *
 * MEASURED 2026-08-31, the first hour after per-gap backoff deployed: it did exactly what
 * it was built to do — `route-edit-e32a5778` (failed_attempts 80) stopped being picked —
 * and the lane immediately moved to `recommit-route-edit-630abe48-anchor_not_found` and
 * `recommit-recommit-route-edit-630abe48-anchor_not_found-syntax_break`. Three generations
 * of one defect, carrying failed_attempts of 4, 4 and 2: each individually below the
 * threshold that would slow it, together a lineage that has failed ten times.
 *
 * Across the open store: 29 recommit-* gaps, none above failed_attempts 4, and 15
 * *-narrowed gaps. A backoff keyed on a gap id is therefore routed around by minting a
 * new id for the same defect, which is what both recommit and narrowing do by design
 * (narrowing explicitly resets failed_attempts to 0 so the child re-enters at normal
 * priority).
 *
 * BOTH LINKS ARE STRUCTURAL, so this needs no id-string parsing: narrowing writes
 * `parent_gap_id` and recommit writes `source_gap_id`.
 *
 * The most recent failure is taken across the LINEAGE, which is the part that actually
 * closes the escape. A freshly minted child has failed_attempts 0 and no `last_failed_at`
 * of its own; keyed on itself it fails open and is instantly eligible — the exact hole
 * this function exists to close. It inherits its parent's clock instead.
 *
 * Walks up only as far as the candidate set it is given. An ancestor that is closed (and
 * so absent from the open-gap read) simply ends the walk, yielding a SMALLER sum and thus
 * LESS backoff — the safe direction when information is missing.
 */
/** The classification metadata of `gap` and each open ancestor (parent_gap_id, else source_gap_id), nearest first. */
function lineageMetas(
  gap: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  maxDepth: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> | undefined = gap;
  // A malformed store could in principle point a gap at its own ancestor; a seen-set makes
  // that a short walk rather than a hang inside the selection hot path.
  const seen = new Set<string>();
  while (cur && out.length <= maxDepth) {
    const id = String(cur.id ?? "");
    if (id && seen.has(id)) break;
    if (id) seen.add(id);
    const meta = (cur.classification_metadata ?? cur.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta !== "object" || meta === null) break;
    out.push(meta);
    const parentId = String(meta.parent_gap_id ?? meta.source_gap_id ?? "");
    cur = parentId ? byId.get(parentId) : undefined;
  }
  return out;
}

export function lineageBackoffState(
  gap: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  maxDepth = 8,
): LineageBackoffState {
  let attempts = 0;
  let lastFailedAtMs: number | null = null;
  const metas = lineageMetas(gap, byId, maxDepth);
  for (const meta of metas) {
    const fa = Number(meta.failed_attempts ?? 0);
    if (Number.isFinite(fa) && fa > 0) attempts += Math.floor(fa);
    const t = Date.parse(String(meta.last_failed_at ?? ""));
    if (Number.isFinite(t) && (lastFailedAtMs === null || t > lastFailedAtMs)) lastFailedAtMs = t;
  }
  return { attempts, lastFailedAtMs, depth: metas.length - 1 };
}

/**
 * LINEAGE FAIR SHARE OF THE SPEND ENVELOPE (value-per-cost-selection 4.5).
 *
 * MEASURED 2026-10-02 06:00-14:17Z: the $2/h envelope is shared by both nodes and was exhausted
 * 08:54-~11:30 and again at 14:17. Node 1 spent $1.09-$1.78 per hour on picks of gaps already at
 * 6-8 failed attempts and landed 1 in 18 (~$6.7 per landing), while node 2 lands at ~$0.85 per
 * landing; the global cap cannot tell them apart, so the low-yield lineage starved the productive one.
 *
 * Every compose's LLM spend is charged to the gap it ran for (`spend_ledger`, written by
 * recordLineageSpend from the report's `llm_usage`). A lineage (the same parent_gap_id / source_gap_id
 * walk as lineageBackoffState, so a recommit or a narrowing cannot mint its way out) whose OPEN rows
 * have spent `lineage_usd_cap_per_window` inside the last `lineage_window_s` is held from auto-pick until
 * the window rolls. A landing closes the gap, which takes its ledger out of the open read, so what is
 * summed is spend that has not landed. Rows with no ledger read as $0 (fail open, like gapIsBackedOff):
 * a hold on absence would empty the pool. Same upward-walk asymmetry as the backoff: a root sees only
 * its own ledger, a child sees itself and its ancestors.
 */
export const SPEND_LEDGER_MAX_ENTRIES = 20;
export function lineageWindowSpendUsd(
  gap: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  nowMs: number,
  windowMs: number,
  maxDepth = 8,
): number {
  let usd = 0;
  for (const meta of lineageMetas(gap, byId, maxDepth)) {
    const ledger = Array.isArray(meta.spend_ledger) ? (meta.spend_ledger as Array<Record<string, unknown>>) : [];
    for (const e of ledger) {
      const at = Date.parse(String(e?.at ?? ""));
      const v = Number(e?.usd);
      // A future stamp (clock skew) still counts: it is spend, and dropping it would fail open forever.
      if (Number.isFinite(at) && Number.isFinite(v) && v > 0 && nowMs - at < windowMs) usd += v;
    }
  }
  return usd;
}
export type LineageSpendPolicy = { lineage_usd_cap?: number; lineage_window_ms?: number };
/** True iff the policy sets a lineage ceiling and this gap's lineage has spent it inside the window. */
export function lineageSpendHeld(
  gap: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  nowMs: number,
  policy: LineageSpendPolicy | null | undefined,
): boolean {
  const cap = policy?.lineage_usd_cap;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return false;
  const windowMs = typeof policy?.lineage_window_ms === "number" && policy.lineage_window_ms > 0 ? policy.lineage_window_ms : 3_600_000;
  return lineageWindowSpendUsd(gap, byId, nowMs, windowMs) >= cap;
}
/** The ledger after charging `usd` at `atIso`: appended, oldest dropped past SPEND_LEDGER_MAX_ENTRIES. */
export function appendSpendLedger(meta: Record<string, unknown>, usd: number, atIso: string): Array<{ at: string; usd: number }> {
  const prior = Array.isArray(meta.spend_ledger) ? (meta.spend_ledger as Array<{ at: string; usd: number }>) : [];
  return [...prior, { at: atIso, usd }].slice(-SPEND_LEDGER_MAX_ENTRIES);
}
/**
 * Charge one compose's LLM spend (the report's `llm_usage.cost_usd`, attached by resolveFeatureCompose)
 * to the gap it ran for, so lineageSpendHeld can read it. Built on the STORED row, re-read here (the
 * compose may have written its failure lesson since the pick); a closed or unreadable row is not
 * written, so a gap that landed is never reopened. Dry runs and zero-cost composes write nothing.
 * Best effort: a failed write costs one ledger entry, never the compose result.
 */
export async function recordLineageSpend(gapId: string, composeBody: unknown, dryRun: boolean): Promise<void> {
  try {
    if (!gapId || dryRun) return;
    const usage = (composeBody as { llm_usage?: { cost_usd?: unknown } } | null | undefined)?.llm_usage;
    const usd = Number(usage?.cost_usd);
    if (!Number.isFinite(usd) || usd <= 0) return;
    const fresh = await readGapFresh(gapId);
    if (!fresh || String(fresh.status ?? "") !== "open") return;
    const m = fresh.classification_metadata ?? fresh.metadata;
    const meta = (m && typeof m === "object" && !Array.isArray(m) ? m : {}) as Record<string, unknown>;
    // A PATCH, not a row rewrite: only spend_ledger is sent, and the store carries every omitted
    // metadata key forward, so a key another writer changed since the read is not overwritten.
    // expect_status:"open" makes the write a no-op if the row was closed in between (never a reopen,
    // so never an event-driven compose pickup).
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      expect_status: "open",
      gap: {
        id: gapId,
        category: fresh.category,
        source: fresh.source,
        summary: fresh.summary,
        detected_at: fresh.detected_at,
        classification_metadata: { spend_ledger: appendSpendLedger(meta, usd, new Date().toISOString()) },
        status: "open",
      },
    } as never);
  } catch (err) {
    console.warn(`[gap-to-feature] lineage spend not recorded for ${gapId}: ${String(err)}`);
  }
}

/**
 * Is this gap still serving its backoff?
 *
 * Reads DURABLE metadata that `bumpFailedAttempts` writes, not the in-process
 * `gapComposeLastAttemptAt` map. The map is cleared by every restart, and mitosis cutovers
 * restart this vessel several times a day — an in-process backoff would reset to zero
 * exactly when a runaway gap is at its worst.
 *
 * Pass `state` to apply the backoff at LINEAGE grain (see lineageBackoffState); without it
 * the gap is judged on its own counters alone, which any recommit or narrowing escapes.
 *
 * FAILS OPEN on anything it cannot read: absent, malformed, or future-dated timestamps
 * return false (eligible). Most gaps in the store carry no such metadata at all, and a
 * backoff that excluded them on absence would empty the candidate pool and stop gap work
 * altogether — while looking like a perfectly calm system.
 */
export function gapIsBackedOff(
  gap: Record<string, unknown>,
  nowMs: number,
  state?: LineageBackoffState,
): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta !== "object" || meta === null) return false;
  const attempts = state ? state.attempts : Number(meta.failed_attempts ?? 0);
  const wait = gapBackoffMs(attempts);
  if (wait <= 0) return false;
  const last = state ? state.lastFailedAtMs : Date.parse(String(meta.last_failed_at ?? ""));
  if (last === null || !Number.isFinite(last)) return false;
  const elapsed = nowMs - last;
  // A negative elapsed means a clock skew or a future stamp — treat as eligible rather
  // than as an infinite wait.
  if (elapsed < 0) return false;
  return elapsed < wait;
}

// ───────────────────────────── LOCALIZATION (2026-06-28, intermediate task #5) ─────────────────────────────
// THE UNCLOG STEP. feature_compose LANDS FAVORABLE when handed a gap with a CONCRETE
// edit-site (a named existing file); it free-drafts un-verifiable code otherwise. But
// almost no gaps have a `/workspace/proposals/<id>-report.json` (existingEditTargets is
// usually empty), so the composer free-drafts and the autonomous loop never lands a real
// fix. localizeGap DERIVES a concrete edit-site from the gap's own text/metadata when no
// proposal file exists:
//   (a) identify the target vessel (gap.id like "responsibility-goal-host-vessel-…",
//       "performance-inefficiency-…", or metadata.vessel),
//   (b) SURFACE an edit-site already named in metadata (edit_site / file_path /
//       change_site / suspected_real_location) when the file actually exists — cheap, no
//       search; this is the high-confidence path,
//   (c) otherwise EXTRACT distinctive search terms (symbols, quoted strings, shape names)
//       from summary+metadata and grep the vessel's src/ for the best-matching file,
//   (d) return repos/<vessel>/<path> ONLY when a single confident file emerges (else NONE
//       — never fabricate; the composer free-drafts as before, behaviour unchanged).
// Optional: one llm-resolver call ranks among grep hits when several tie. Bounded
// (capped file walk, capped grep, timeouts, graceful on unreachable LLM). SAFE/ADDITIVE:
// only augments the empty-edit-target case.

const LOCALIZE_MAX_FILES = 1200;      // cap the src/ walk per vessel
const LOCALIZE_MAX_HITS = 12;         // cap candidate files scored
const LOCALIZE_LLM_TIMEOUT_MS = 12_000;

/** Extract distinctive search terms from a gap's summary + metadata. */
function localizeTerms(summary: string, meta: Record<string, unknown>): string[] {
  const terms = new Set<string>();
  // Quoted strings in the summary (the detectors quote symbol/endpoint/shape names).
  for (const m of summary.matchAll(/["'`]([^"'`]{3,60})["'`]/g)) {
    const t = (m[1] ?? "").trim();
    if (t) terms.add(t);
  }
  // High-signal metadata fields naming a symbol/shape/endpoint/pattern.
  for (const f of ["shape", "live_resolver", "probe", "matched_pattern", "matched_excerpt", "principle_name", "check", "detector"]) {
    const v = meta[f];
    if (typeof v === "string" && v.trim()) {
      // matched_excerpt/pattern can be a multi-token snippet — pull identifier-ish runs.
      for (const w of v.matchAll(/[A-Za-z_$][\w$]{4,}/g)) terms.add(w[0]!);
    }
  }
  // CamelCase / snake_case identifiers in the summary (≥5 chars, contains an upper or _).
  for (const w of summary.matchAll(/\b[A-Za-z_$][\w$]{4,}\b/g)) {
    const t = w[0]!;
    if (/[A-Z_]/.test(t) && !/^(should|which|every|never|always|cannot|substrate|activity|resolver|detector|capability|registered)$/i.test(t)) {
      terms.add(t);
    }
  }
  // Rank: prefer longer + symbol-shaped terms; cap.
  return [...terms]
    .filter((t) => t.length >= 4 && /[A-Za-z_]/.test(t))
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
}

/** Recursively list .ts/.tsx files under a dir, bounded. */
function walkSrcFiles(absDir: string, cap: number): string[] {
  const out: string[] = [];
  const stack = [absDir];
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push(p);
    }
  }
  return out;
}

/** Score a vessel's src files by how many distinctive terms each contains; return top hits. */
function grepScoreFiles(srcAbs: string, vessel: string, terms: string[]): Array<{ file: string; score: number; matched: string[] }> {
  if (!terms.length) return [];
  const files = walkSrcFiles(srcAbs, LOCALIZE_MAX_FILES);
  const scored: Array<{ file: string; score: number; matched: string[] }> = [];
  for (const abs of files) {
    let content: string;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    const matched: string[] = [];
    let score = 0;
    for (const t of terms) {
      // word-ish containment; exact-symbol matches weigh more than substring.
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(content)) { score += 2; matched.push(t); }
      else if (content.includes(t)) { score += 1; matched.push(t); }
    }
    if (score > 0) {
      const rel = `repos/${vessel}/${abs.slice(abs.indexOf(`/${vessel}/`) + vessel.length + 2)}`;
      scored.push({ file: rel, score, matched });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, LOCALIZE_MAX_HITS);
}

/**
 * Read a bounded source excerpt around the first matched terms (else the file head) so the
 * ranking LLM picks the change-site by READING code, not guessing from a filename. Bounded
 * (≤2 windows, ≤1200 chars) to stay within weak-model context budgets; "" on any error, so
 * the caller degrades gracefully to filename-only ranking. This adds INFORMATION at the
 * moment of use — it does not add localization heuristics.
 */
function siteExcerpt(repoRel: string, terms: string[]): string {
  try {
    const abs = join(runtimeRoot(), repoRel.replace(/^repos\//, ""));
    const lines = readFileSync(abs, "utf8").split("\n");
    const marks: number[] = [];
    for (const t of terms) {
      const i = lines.findIndex((l) => l.includes(t));
      if (i >= 0 && !marks.includes(i)) marks.push(i);
      if (marks.length >= 2) break;
    }
    const anchors = marks.length ? marks : [0];
    const windows = anchors.slice(0, 2).map((m) => {
      const a = Math.max(0, m - 4);
      const b = Math.min(lines.length, m + 10);
      return lines.slice(a, b).map((l, k) => `${a + k + 1}: ${l}`).join("\n");
    });
    return windows.join("\n  …\n").slice(0, 1200);
  } catch {
    return "";
  }
}

async function rankWithLlm(summary: string, hits: Array<{ file: string; score: number; matched: string[] }>): Promise<string | null> {
  if (hits.length < 2) return null;
  try {
    // Discover the llm endpoint via the same contract feature-compose uses.
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!dr.ok) return null;
    const dd = (await dr.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> } };
    const best = (dd.content?.vessels ?? [])[0];
    if (!best) return null;
    const ep0 = best.resolve_endpoint ?? "/resolve";
    const endpoint = ep0.startsWith("http") ? ep0 : `${best.endpoint.replace(/\/$/, "")}${ep0.startsWith("/") ? ep0 : `/${ep0}`}`;
    // Rank among the top candidates WITH source excerpts (bounded for weak-model budgets),
    // so the pick is made by reading code rather than guessing from a filename.
    const top = hits.slice(0, 5);
    const list = top.map((h, i) => `[${i}] ${h.file} (matched: ${h.matched.join(", ")})\n${siteExcerpt(h.file, h.matched)}`).join("\n\n");
    const prompt = `A substrate gap needs the SINGLE existing source file that is the change site. READ the code excerpts below and pick the file whose logic the gap describes.\n\nGAP: ${summary}\n\nCandidates:\n${list}\n\nReturn ONLY the integer index [0..${top.length - 1}] of the change-site file. If none fits, return -1. Respond with JUST the number.`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: 24 }),
      signal: AbortSignal.timeout(LOCALIZE_LLM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    const txt = String(j.content ?? j.data ?? "").trim();
    const m = txt.match(/-?\d+/);
    if (!m) return null;
    const idx = parseInt(m[0], 10);
    if (idx < 0 || idx >= top.length) return null;
    return top[idx]!.file;
  } catch {
    return null;
  }
}

// DECOMPOSITION CONTRACT (contained-self-development 6.3). The investigation step used to dispatch
// a free-text "investigate and decompose" walk whose output was another gap with no falsifier
// (384 runs, 4 closures). Every verifiable gap left on 2026-09-27 was design-sized: autonomous
// single-file drafts on them were refused as incomplete, wrong-file, DESTROY-TO-SATISFY or a
// hollow literal write. This gives the step a structured output: one bounded LLM call proposes
// 1-3 single-file steps, each validated deterministically before it is written as a child gap
// `<parent>-step-<k>` (category `decomposed_step`, so the parent's sealed category does not
// seal it): the file exists outside the autonomy scope; a shape falsifier names a shape that
// discovery advertises; a literal falsifier is absent from the file now and names an existing
// reader in it. Proposals that silence a detector are refused. Depth 1: a step is never
// decomposed again. Graded by child closure.
// The decomposer used to see only the first 7000 characters of the edit site, so in a large file it never
// saw the code a gap names and invented readers from whatever sat at the top (goal-host index.ts: sites at
// lines 7457-15128, excerpt ending near line 150). Show numbered windows around every file line the gap
// quotes verbatim instead; with no quoted line, the head of the file as before.
export function quotedSiteExcerpt(text: string, summary: string, cap = 7000): string {
  const lines = text.split("\n");
  const quoted = new Set(summary.split("\n").map((l) => l.replace(/^\s*\d+:\s*/, "").trim()).filter((l) => l.length >= 25));
  const hits: number[] = [];
  lines.forEach((l, i) => { if (quoted.has(l.trim())) hits.push(i); });
  if (hits.length === 0) return text.slice(0, cap);
  let out = "";
  let last = -1;
  for (const h of hits) {
    const from = Math.max(h - 3, last + 1);
    const to = Math.min(lines.length - 1, h + 3);
    if (from > to) continue;
    const chunk = lines.slice(from, to + 1).map((l, j) => `${from + j + 1}: ${l}`).join("\n") + "\n...\n";
    if (out.length + chunk.length > cap) break;
    out += chunk;
    last = to;
  }
  return out || text.slice(0, cap);
}

// gap_falsify v2: the decomposer was starved (law 8). 786 of 903 proposals in 7 days were refused as "no valid
// step", mostly invented repos/ paths and shapes: it was never shown the vocabulary it had to name. It now sees
// (a) the advertised READ shapes with their descriptions (discovery /registry/shape-descriptions, the reader
// author_composed_capability already uses) and (b) the edit-site vessel's test files and the test names that
// match the gap's own words, so a check can name something that exists.
const DECOMPOSE_STOPWORDS = new Set(["about", "after", "again", "because", "before", "being", "between", "cannot", "could", "every", "never", "other", "should", "their", "there", "these", "those", "under", "where", "which", "while", "would", "substrate", "change", "gap", "gaps", "check", "still", "today", "without", "within"]);
export function decomposeSummaryTerms(summary: string): string[] {
  const out = new Set<string>();
  for (const m of summary.matchAll(/[A-Za-z_][A-Za-z0-9_]{4,}/g)) {
    const w = m[0].toLowerCase();
    if (!DECOMPOSE_STOPWORDS.has(w)) out.add(w);
    if (out.size >= 40) break;
  }
  return [...out];
}
const TEST_SUITE_CHECK_HELP = "runs named tests of a vessel in-container; input {vessel:\"repos/<v>\", test_file:\"<path in that vessel>\", only_tests:[\"<exact test title>\"]}; answers requested_not_passing = how many of the named tests do not pass (a missing test counts as not passing)";
export function advertisedReadShapesBlock(descriptions: Record<string, string>, terms: string[], cap = 40): string {
  const rows = Object.entries(descriptions)
    .filter(([shape]) => shape !== "test_suite" && !/_write$|_delete$|_deprecate$|^vessel_register|^systemd_/.test(shape))
    .map(([shape, desc]) => {
      const hay = (shape + " " + desc).toLowerCase();
      return { shape, desc, score: terms.filter((t) => hay.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score || a.shape.localeCompare(b.shape))
    .slice(0, Math.max(0, cap - 1));
  return [`- test_suite: ${TEST_SUITE_CHECK_HELP}`, ...rows.map((r) => `- ${r.shape}: ${r.desc.slice(0, 200)}`)].join("\n");
}
export function vesselTestInventory(vessel: string, terms: string[]): { files: string[]; matches: Array<{ file: string; name: string }> } {
  const root = join(vesselsCloneRoot(), vessel);
  const files: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 6 || files.length >= 400) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(e.name)) files.push(r);
    }
  };
  walk("src", 0);
  walk("test", 0);
  walk("tests", 0);
  const matches: Array<{ file: string; name: string }> = [];
  for (const f of files) {
    if (matches.length >= 30) break;
    let text = "";
    try { text = readFileSync(join(root, f), "utf-8"); } catch { continue; }
    for (const m of text.matchAll(/\b(?:test|it)(?:\.(?:only|skip|todo|if\([^)]*\)))?\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const name = m[2] ?? "";
      const low = name.toLowerCase();
      if (name && terms.some((t) => low.includes(t))) matches.push({ file: f, name });
      if (matches.length >= 30) break;
    }
  }
  return { files: files.slice(0, 80), matches };
}

export interface DecomposeDeps {
  /** The one bounded LLM call. Default: the llm_completion producer discovery names. */
  llm?: (prompt: string) => Promise<string>;
  /** The one judge. Default: evaluateGapCheck. */
  judge?: (gap: Record<string, unknown>) => Promise<GapCheckVerdict>;
  /** Advertised shape → description. Default: author-composed-capability fetchShapeDescriptions. */
  shapeDescriptions?: () => Promise<Record<string, string>>;
}

async function defaultDecomposeLlm(prompt: string): Promise<string> {
  const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` }, body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }), signal: AbortSignal.timeout(6000) });
  const dd = (await dr.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> } };
  const best = (dd.content?.vessels ?? [])[0];
  if (!best) throw new Error("no llm_completion producer");
  const ep0 = best.resolve_endpoint ?? "/resolve";
  const endpoint = ep0.startsWith("http") ? ep0 : `${best.endpoint.replace(/\/$/, "")}${ep0.startsWith("/") ? ep0 : `/${ep0}`}`;
  const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` }, body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: 1200, caller: "development-vessel:gap_decompose" }), signal: AbortSignal.timeout(90_000) });
  const j = (await res.json()) as { content?: string; data?: string };
  return String(j.content ?? j.data ?? "");
}

/** The budget a proposed test_suite check may ask for: the pull-sync failing-test generator's. */
const PROPOSED_TEST_SUITE_TIMEOUT_MS = 180_000;

export async function decomposeGap(
  parent: Record<string, unknown>,
  opts: { directed?: boolean; parentCheck?: boolean; deps?: DecomposeDeps } = {},
): Promise<{ written: string[]; reason: string; parent_check?: string }> {
  const parentId = String(parent.id ?? "");
  const meta = (parent.classification_metadata ?? {}) as Record<string, unknown>;
  if (!parentId) return { written: [], reason: "no parent id" };
  // A child minted from a landing's semantic dissent is born with no check and needs one derived here.
  if ((meta.parent_gap_id && !isDissentChild(meta)) || /-step-\d+$/.test(parentId)) return { written: [], reason: "a decomposed step is not decomposed again" };
  const judge = opts.deps?.judge ?? ((g: Record<string, unknown>) => evaluateGapCheck(g));
  const site = String(meta.edit_site ?? "").replace(/:\d+.*$/, "");
  const siteMatch = /^repos\/([^/]+)\/(.+)$/.exec(site);
  const siteVessel = siteMatch?.[1] ?? "";
  let excerpt = "";
  if (siteMatch) { try { excerpt = quotedSiteExcerpt(readFileSync(join(vesselsCloneRoot(), siteMatch[1] ?? "", siteMatch[2] ?? ""), "utf-8"), String(parent.summary ?? "")); } catch { excerpt = ""; } }
  const predicate: Record<string, unknown> = {};
  for (const k of ["expected_literal", "hardcoded_url", "evidence_resolve", "verify_shape"]) if (meta[k] !== undefined && meta[k] !== null) predicate[k] = meta[k];
  const lessons = Array.isArray(meta.failure_lessons) ? (meta.failure_lessons as Array<Record<string, unknown>>).slice(-3).map((l) => "- " + String(l.class ?? "?") + ": " + String(l.reason ?? "").slice(0, 300)).join("\n") : "";
  // LAW-8 INPUTS: what exists to be named.
  const terms = decomposeSummaryTerms(String(parent.summary ?? ""));
  let descriptions: Record<string, string> = {};
  try {
    descriptions = opts.deps?.shapeDescriptions
      ? await opts.deps.shapeDescriptions()
      : await (await import("./author-composed-capability.js")).fetchShapeDescriptions();
  } catch { descriptions = {}; }
  const inventory = siteVessel ? vesselTestInventory(siteVessel, terms) : { files: [], matches: [] };
  const vocabularyBlock = `\n\nADVERTISED READ SHAPES (a shape check must name one of these; name: what it answers):\n${advertisedReadShapesBlock(descriptions, terms)}` +
    `\n\nTEST FILES IN repos/${siteVessel || "(none)"}:\n${inventory.files.join("\n") || "(none found)"}` +
    `\n\nEXISTING TESTS WHOSE NAMES MATCH THIS GAP (file :: exact title):\n${inventory.matches.map((m) => `${m.file} :: ${m.name}`).join("\n") || "(none)"}`;
  const parentCheckAsk = opts.parentCheck
    ? `\n\nFIRST, "parent_check": ONE machine check for THIS GAP ITSELF that FAILS on today's tree because of this defect and passes once the defect is fixed. Two forms only. (a) an EXISTING test that fails today because of this defect: {"evidence_resolve":{"shape":"test_suite","input":{"vessel":"repos/${siteVessel || "<vessel>"}","test_file":"<a path from TEST FILES>","only_tests":["<an exact title from EXISTING TESTS>"]},"zero_field":"requested_not_passing"}}. (b) an ADVERTISED READ SHAPE whose answer has a numeric field counting this defect (above 0 today, 0 after the fix): {"evidence_resolve":{"shape":"<shape>","input":{},"zero_field":"<field>"}}. Never a word or literal check, never a write shape, never a test or shape you would have to create. The check is run before it is kept and is discarded unless it fails today. If no such check exists, "parent_check": null.`
    : "";
  const prompt = `A substrate gap could not be closed by one single-file code change. Decompose it into 1 to 3 SMALL steps. Each step changes exactly ONE existing source file and has a machine-checkable falsifier.\n\nGAP ${parentId}:\n${String(parent.summary ?? "").slice(0, 1500)}\n\nITS FALSIFIER: ${JSON.stringify(predicate)}\n\nWHY ATTEMPTS FAILED (most recent last):\n${lessons || "(none recorded)"}\n${attemptEvidenceBlock(meta.failure_lessons)}\n\nEDIT SITE ${site || "(none)"} (excerpt):\n${excerpt}${vocabularyBlock}${parentCheckAsk}\n\nRespond with ONLY JSON: {${opts.parentCheck ? `"parent_check":{"evidence_resolve":{...}} or null,` : ""}"steps":[{"edit_site":"repos/<vessel>/src/<file>","change":"<one sentence>","falsifier":{"evidence_resolve":{"shape":"<shape>","input":{},"zero_field":"<numeric field in its answer that counts this defect: above 0 today, 0 after the change>"}} OR {"expected_literal":"<identifier the change introduces>","reader":"<existing function in that file that will read or call it>"}}],"cannot_falsify":"<only if no step can be given a machine check>"}\nRules: a shape falsifier must name a shape that ALREADY exists and answers today (it currently reports this defect and stops reporting it after the change); a shape the change itself would introduce cannot be a falsifier — for new behaviour use expected_literal with a reader; the reader must be an existing FUNCTION in that file that is called on a live path and will call or read the literal (not a type, interface or comment); never propose a logging-only, comment-only or observation-only step; never propose removing, weakening or silencing a detector or check; each step must change live behaviour ON ITS OWN when landed alone — never a step that only adds a helper, function or constant for a later step to call (a new function nothing calls is refused as hollow); when the same fix is needed at several sites, make each step fix ONE site completely, inline, the way any site that already does it correctly does; the steps together must close the gap.`;
  let raw = "";
  try {
    raw = opts.deps?.llm ? await opts.deps.llm(prompt) : await defaultDecomposeLlm(prompt);
  } catch (err) {
    if (String(err).includes("no llm_completion producer")) return { written: [], reason: "no llm_completion producer" };
    return { written: [], reason: "llm call failed: " + String(err) };
  }
  let parsed: { steps?: Array<Record<string, unknown>>; cannot_falsify?: unknown; parent_check?: unknown } = {};
  try { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); parsed = JSON.parse(raw.slice(a, b + 1)); } catch { return { written: [], reason: "unparseable decomposition" }; }
  const scope = await autonomyScope();
  const written: string[] = [];
  const refusals: string[] = [];

  // ONE VALIDATION CHAIN for every proposed check: the parent's own (k=0) and each step's. `siblings` are
  // checks a step may not restate (the parent's pre-existing one, and a parent check proposed in this call).
  const validateShapeCheck = async (label: string, f: Record<string, unknown>, siblings: Array<Record<string, unknown>>): Promise<{ ok: true; predicate: Record<string, unknown> } | { ok: false; why: string }> => {
    const shape = typeof f.verify_shape === "string" ? f.verify_shape : (f.evidence_resolve && typeof (f.evidence_resolve as { shape?: unknown }).shape === "string" ? String((f.evidence_resolve as { shape?: unknown }).shape) : "");
    if (!shape) return { ok: false, why: `${label}: no machine-checkable falsifier` };
    const producers = await discoverResolveUrls(shape);
    if (!producers.ok) return { ok: false, why: `${label}: could not check that shape ${shape} is advertised (${producers.why})` };
    if (producers.urls.length === 0) return { ok: false, why: `${label}: shape ${shape} is not advertised` };
    // A CHECK THAT WRITES IS NOT A CHECK (09-29): advertisement alone let 12 uiPanel_write/uiQuestion_write
    // checks through, and verifying them performed live writes. The verifier refuses them too (487a7e9).
    if (/_write$/.test(shape)) return { ok: false, why: `${label}: shape ${shape} is a write, not a read` };
    // A step whose predicate is the PARENT's own check cannot be verified alone: one step will not
    // flip it, so a generic step "satisfied" it in prose while the parent's check stayed failing
    // (the relevance-sink step landed a size check, 04b3e9c, with divergence still 1).
    const childEr = f.evidence_resolve as { shape?: unknown; input?: unknown } | undefined;
    for (const sib of siblings) {
      const sibEr = sib.evidence_resolve as { shape?: unknown; input?: unknown } | undefined;
      const same = (typeof f.verify_shape === "string" && f.verify_shape === sib.verify_shape)
        || (!!sibEr && !!childEr && sibEr.shape === childEr.shape && JSON.stringify(sibEr.input ?? {}) === JSON.stringify(childEr.input ?? {}));
      if (same) return { ok: false, why: `${label}: its falsifier is the parent's own check, which one step will not flip` };
    }
    // A shape check with no measured field reads 'unknown' in the closure sweep forever: the step can
    // be neither closed nor recorded as falsified. 15 live step/probe predicates were born that way.
    // The verifier reads inner[field] FLAT, so the field must be a plain identifier: a path such as
    // entries.length can only ever read unknown (route-edit-ec962628-step-1, 09-29).
    // A DEFECT_FIELD CHECK IS REFUSED (qa C4 ruling iv): the judge reads it 'present' only when the key is in the
    // answer, so a key the shape never returns reads 'absent', i.e. fixed, and closes the gap on silence.
    if (!!childEr && (childEr as Record<string, unknown>)["defect_field"] !== undefined) return { ok: false, why: `${label}: a defect_field check is refused: a missing key reads as fixed` };
    const measured = !!childEr && ["zero_field", "nonzero_field"].some((fk) => {
      const fv = (childEr as Record<string, unknown>)[fk];
      return typeof fv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(fv);
    });
    if (!measured) return { ok: false, why: `${label}: its shape check names no zero_field/nonzero_field, so it could never be judged` };
    // WHETHER THE SHAPE REPORTS THAT FIELD is not decided here (qa C4 ruling iv): descriptions are prose, and a
    // lexical match was vacuous (312 of 312 described shapes passed it). The proof is the judge on the real
    // answer (redNow, below): a zero_field/nonzero_field the shape does not return, or returns non-numeric,
    // reads 'unknown', so the check is not written.
    if (shape === "test_suite") {
      // A NAMED TEST THAT DOES NOT EXIST IS TRIVIALLY RED: requested_not_passing counts a missing test as not
      // passing, so an invented name reads 'present' forever (the test twin of an absent expected_literal).
      const er = childEr as Record<string, unknown>;
      const input = (er.input && typeof er.input === "object" ? er.input : {}) as Record<string, unknown>;
      const vessel = String(input.vessel ?? "").replace(/^repos\//, "");
      const testFile = typeof input.test_file === "string" ? input.test_file.trim() : "";
      const onlyTests = Array.isArray(input.only_tests) ? (input.only_tests as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
      if (er.zero_field !== "requested_not_passing") return { ok: false, why: `${label}: a test_suite check is judged by zero_field requested_not_passing` };
      if (!/^[A-Za-z0-9_-]+$/.test(vessel)) return { ok: false, why: `${label}: test_suite check names no vessel` };
      if (!testFile || !/^[A-Za-z0-9_./-]+$/.test(testFile) || testFile.includes("..")) return { ok: false, why: `${label}: test_suite check names no usable test_file` };
      if (onlyTests.length === 0) return { ok: false, why: `${label}: test_suite check names no test (only_tests), so it could never be judged` };
      let testText = "";
      try { testText = readFileSync(join(vesselsCloneRoot(), vessel, testFile), "utf-8"); } catch { return { ok: false, why: `${label}: test file repos/${vessel}/${testFile} does not exist` }; }
      // A title built from a template literal (`[${label}] …`) is matched with its placeholders as wildcards.
      const missing = onlyTests.find((t) => !testTitleInSource(testText, t));
      if (missing !== undefined) return { ok: false, why: `${label}: test "${missing.slice(0, 120)}" is not in repos/${vessel}/${testFile}` };
      const tm = typeof input.timeout_ms === "number" && input.timeout_ms > 0 ? Math.min(input.timeout_ms, PROPOSED_TEST_SUITE_TIMEOUT_MS) : PROPOSED_TEST_SUITE_TIMEOUT_MS;
      return { ok: true, predicate: { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${vessel}`, test_file: testFile, only_tests: onlyTests, timeout_ms: tm }, zero_field: "requested_not_passing" } } };
    }
    return { ok: true, predicate: typeof f.verify_shape === "string" ? { verify_shape: f.verify_shape } : { evidence_resolve: f.evidence_resolve } };
  };
  // RED BEFORE WRITE: a class-2 check is kept only if the one judge reads it 'present' on today's tree.
  // Where the gap store is held ELSEWHERE the judge abstains (it measures only where the store is held), so the
  // judgement is deferred to the holder: the write is forwarded without a verdict, and the holder's seam stamps
  // it pending and evaluates it there; anything but 'present' is then predicate_suspect (not admissible).
  const deferToHolder = !!process.env["GAP_STORE_ENDPOINT"];
  // The seam's own judge mints the verdict the write may hand over (MINTED BIRTH VERDICTS in substrate-gap); an
  // injected deps.judge gates only, and the seam then judges the written check itself.
  const redNow = async (label: string, id: string, pred: Record<string, unknown>): Promise<{ ok: true; stamp?: MintedBirthVerdict } | { ok: false; why: string }> => {
    if (deferToHolder) return { ok: true };
    let v: GapCheckVerdict = "unknown";
    let stamp: MintedBirthVerdict | undefined;
    try { if (opts.deps?.judge) v = await judge({ id, classification_metadata: { ...pred } }); else ({ verdict: v, stamp } = await takeBirthVerdictWithReport(id, { ...pred })); } catch { v = "unknown"; }
    return v === "present" ? { ok: true, stamp } : { ok: false, why: `${label}: its check reads ${v} on the current tree, not present` };
  };

  // k=0: THE PARENT'S OWN CHECK (parent-check mode).
  let parentCheck: Record<string, unknown> | null = null;
  let parentCheckNote = "";
  let parentVerdict: MintedBirthVerdict | null = null;
  if (opts.parentCheck) {
    const pc = parsed.parent_check;
    if (pc && typeof pc === "object") {
      const f = pc as Record<string, unknown>;
      const dissentedCheck = dissentChildCheckRefusal(meta, f);
      if (dissentedCheck) {
        parentCheckNote = dissentedCheck;
      } else if (typeof f.expected_literal === "string" || typeof f.hardcoded_url === "string") {
        parentCheckNote = "parent check: a literal is not a parent check (a word absent now is trivially red)";
      } else {
        const v = await validateShapeCheck("parent check", f, [predicate]);
        if (!v.ok) parentCheckNote = v.why;
        else {
          const red = await redNow("parent check", parentId, v.predicate);
          if (!red.ok) parentCheckNote = red.why;
          else { parentCheck = v.predicate; parentVerdict = red.stamp ?? null; }
        }
      }
    } else parentCheckNote = "parent check: none proposed";
    if (parentCheckNote) refusals.push(parentCheckNote);
  }

  let k = 0;
  for (const st of (parsed.steps ?? []).slice(0, 3)) {
    k++;
    const stepSite = String(st.edit_site ?? "").replace(/:\d+.*$/, "");
    const sm = /^repos\/([^/]+)\/(.+\.(?:ts|tsx|js|mjs))$/.exec(stepSite);
    const change = String(st.change ?? "").trim();
    const f = (st.falsifier ?? {}) as Record<string, unknown>;
    if (!sm || !change) { refusals.push(`step ${k}: no single source file or no change`); continue; }
    // Directed decomposition may target the lane core: the scope contains autonomous work, and the
    // compose floor already never checks directed work, so refusing its steps here only blocked it.
    if (!opts.directed && autonomyScopeExcludes(scope, stepSite)) { refusals.push(`step ${k}: ${stepSite} is inside the autonomy scope`); continue; }
    if (/\b(remove|delete|disable|silence|suppress|skip)\b[^.]{0,40}\b(detector|check|gate|falsifier|scan)\b/i.test(change)) { refusals.push(`step ${k}: would silence a detector or check`); continue; }
    // A helper-only step can never land: the compose semantic gate refuses a new function nothing calls.
    if (/\b(introduce|add|create|define|extract)\b[^.]{0,60}\b(helper|function|utility|method|wrapper)\b/i.test(change) && !/\b(call|calls|use|uses|using|replace|replaces|route|routes|wire|apply|applies)\b/i.test(change)) { refusals.push(`step ${k}: only adds a helper nothing calls, which the compose gate refuses as hollow`); continue; }
    // v1.1: an observation-only step is a hollow write (a logging step with a type named as its
    // "reader" passed v1 and was superseded before any draft).
    if (/\b(log|logs|logging|console|comment|comments|document|observe|observation)\b/i.test(change) && !/\b(fix|change|replace|route|read|call|return|compute|select|validate|guard|reject|refuse|apply|use)\b/i.test(change)) { refusals.push(`step ${k}: observation-only change`); continue; }
    let text = "";
    try { text = readFileSync(join(vesselsCloneRoot(), sm[1] ?? "", sm[2] ?? ""), "utf-8"); } catch { refusals.push(`step ${k}: ${stepSite} does not exist`); continue; }
    let childPredicate: Record<string, unknown> = {};
    let childVerdict: MintedBirthVerdict | null = null;
    const hasShape = typeof f.verify_shape === "string" || (!!f.evidence_resolve && typeof (f.evidence_resolve as { shape?: unknown }).shape === "string");
    if (hasShape) {
      const v = await validateShapeCheck(`step ${k}`, f, parentCheck ? [predicate, parentCheck] : [predicate]);
      if (!v.ok) { refusals.push(v.why); continue; }
      const red = await redNow(`step ${k}`, `${parentId}-step-${k}`, v.predicate);
      if (!red.ok) { refusals.push(red.why); continue; }
      childPredicate = v.predicate;
      childVerdict = red.stamp ?? null;
    } else if (typeof f.expected_literal === "string" && f.expected_literal.trim().length >= 4) {
      const lit = f.expected_literal.trim();
      const reader = String(f.reader ?? "").trim();
      if (text.includes(lit)) { refusals.push(`step ${k}: literal ${lit} already present`); continue; }
      // The verifier reads the RUNNING tree (runtimeRoot), not this clone: a literal present there is
      // already satisfied, so it could never credit a landing.
      let runningText = "";
      try { runningText = readFileSync(join(runtimeRoot(), sm[1] ?? "", sm[2] ?? ""), "utf-8"); } catch { /* not deployed here: the clone check above stands */ }
      if (runningText.includes(lit)) { refusals.push(`step ${k}: literal ${lit} already present in the running tree`); continue; }
      if (!reader || !text.includes(reader)) { refusals.push(`step ${k}: reader ${reader || "(none)"} not found in ${stepSite}`); continue; }
      // v1.1: the reader must be a FUNCTION in the file (defined or called), not a type or interface.
      const readerRe = reader.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
      const readerIsFunction = new RegExp("(function\\s+" + readerRe + "\\b|\\b" + readerRe + "\\s*(=\\s*(async\\s*)?\\(|\\())").test(text);
      if (!readerIsFunction) { refusals.push(`step ${k}: reader ${reader} is not a function in ${stepSite}`); continue; }
      childPredicate.expected_literal = lit;
      childPredicate.literal_reader = reader;
    } else { refusals.push(`step ${k}: no machine-checkable falsifier`); continue; }
    const childId = `${parentId}-step-${k}`;
    // NEVER OVERWRITE AN OPEN STEP (09-29): child ids are deterministic and three callers re-decompose,
    // so a re-decomposition silently replaced a step's check while its landing was pending.
    // Any existing step is protected, closed ones too (rewriting a settled step reopened it); only a
    // step closed as superseded or rejected may be replaced. An unanswerable check refuses: node 2's
    // forwarded store read returns 503 during node-1 restarts, exactly the window this guard is for.
    type StepRow = { status?: unknown; classification_metadata?: { closed_reason?: unknown } };
    let existingRows: StepRow[] | null = null;
    try {
      const existing = await resolveSubstrateGap({ type: "substrateGap", id: childId } as never);
      const body = existing?.body as { gaps?: unknown } | undefined;
      existingRows = Array.isArray(body?.gaps) ? (body!.gaps as StepRow[]) : null;
    } catch { existingRows = null; }
    if (existingRows === null) { refusals.push(`step ${k}: could not check whether ${childId} exists; not written`); continue; }
    const replaceable = (r: StepRow): boolean =>
      String(r.status ?? "") === "superseded" || /supersed|reject/i.test(String(r.classification_metadata?.closed_reason ?? ""));
    if (existingRows.some((r) => !replaceable(r))) { refusals.push(`step ${k}: ${childId} already exists; not overwritten`); continue; }
    // Blank the predicate and sentinel fields this child did not choose: the store carries omitted keys
    // forward, and a leftover removed-line hardcoded_url shadowed a new check and inverted it (09-29).
    const cleared: Record<string, unknown> = { hardcoded_url: "", predicate_derived_at: "", predicate_commit: "", pending_outcome_verification: "" };
    if (!("expected_literal" in childPredicate)) { cleared.expected_literal = ""; cleared.literal_reader = ""; }
    if (!("evidence_resolve" in childPredicate)) cleared.evidence_resolve = null;
    if (!("verify_shape" in childPredicate)) cleared.verify_shape = "";
    // A step carries its OWN check (the parent's is refused above: one step will not flip it), but the
    // operator's hand-off is the parent's: a step of a directed gap is directed too, or it is withheld.
    const childMeta: Record<string, unknown> = { edit_site: stepSite, parent_gap_id: parentId, predicate_source: "decompose", ...(meta.directed === true || opts.directed === true ? { directed: true } : {}), ...cleared, ...childPredicate };
    await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { id: childId, category: "decomposed_step", source: "substrate_detected", summary: `[step ${k} of ${parentId}] ${change}`, detected_at: new Date().toISOString(), status: "open", classification_metadata: childMeta } } as never,
      childVerdict ? { birthVerdict: childVerdict } : undefined,
    );
    written.push(childId);
  }
  const stepReason = written.length > 0 ? `wrote ${written.length} step(s)` + (refusals.length ? `; refused: ${refusals.join("; ")}` : "") : (typeof parsed.cannot_falsify === "string" && parsed.cannot_falsify ? "cannot_falsify: " + parsed.cannot_falsify.slice(0, 200) : "no valid step: " + (refusals.join("; ") || "none proposed"));
  const reason = (parentCheck ? "wrote the parent's own check; " : "") + stepReason;
  // ONE WRITE OF THE PARENT: the decomposition record, and in parent-check mode its new check. The verdict
  // the judge just took is handed to the seam in-process so it is not taken twice.
  try {
    const parentMeta: Record<string, unknown> = { ...meta, decomposed_at: new Date().toISOString(), decomposition: { children: written, reason: reason.slice(0, 600), ...(opts.parentCheck ? { parent_check: parentCheck ? "written" : parentCheckNote.slice(0, 300) } : {}) } };
    if (parentCheck) {
      // verify_shape is blanked, not deleted: the store carries an omitted key forward.
      Object.assign(parentMeta, { verify_shape: "", ...parentCheck, predicate_source: "gap_falsify:parent_check", falsified_at: new Date().toISOString() });
    }
    await resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { ...parent, classification_metadata: parentMeta, status: String(parent.status ?? "open") } } as never,
      parentCheck && parentVerdict ? { birthVerdict: parentVerdict } : undefined,
    );
  } catch { /* the children stand on their own */ }
  console.log(`[gap-decompose] ${parentId}: ${reason.slice(0, 400)}`);
  return { written, reason, ...(opts.parentCheck ? { parent_check: parentCheck ? "written" : parentCheckNote } : {}) };
}

export interface LocalizeResult {
  file: string;
  description: string;
  vessel: string;
  method: "metadata_edit_site" | "grep_unique" | "grep_dominant" | "llm_ranked";
  candidates?: number;
}

/**
 * Derive a CONCRETE existing edit-site for a gap that has no proposal-report edit target.
 * Returns null when no confident single file emerges (NEVER fabricates). Bounded + graceful.
 */
export async function localizeGap(gap: Record<string, unknown>, opts?: { useLlm?: boolean }): Promise<LocalizeResult | null> {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const summary = String(gap.summary ?? gap.title ?? "");

  // (b) HIGH-CONFIDENCE: an edit-site already named in metadata that maps to a real file.
  // suspected_real_location first: it is written back only by the semantic gate after it
  // refused a draft as mis-localized, so it is newer evidence than the original edit_site.
  // Trying edit_site first sent every retry back to the file the gate had just rejected.
  // A relocation hint (written when the gap's own check did not move under a draft) names the module the
  // failing assertion exercises: newer evidence than the edit_site the draft just failed at.
  const hinted = (meta.relocation_hint as { files?: unknown } | undefined)?.files;
  if (Array.isArray(hinted)) {
    for (const h of hinted) {
      if (typeof h !== "string" || !/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(h) || !repoPathExists(h)) continue;
      return { file: h, description: "change site named by the own check's failing assertion (relocation_hint)", vessel: h.match(/^repos\/([^/]+)\//)?.[1] ?? "", method: "metadata_edit_site" };
    }
  }
  for (const f of ["suspected_real_location", "edit_site", "change_site", "file_path"] as const) {
    let v = meta[f];
    if ((typeof v !== "string" || !v.trim()) && typeof (gap as Record<string, unknown>)[f] === "string") v = (gap as Record<string, unknown>)[f];
    if (typeof v !== "string" || !v.trim()) continue;
    let cand = v.trim();
    // Normalise /vessels/<v>/… and bare <v>/… into repos/<v>/…
    cand = cand.replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
    if (!/^repos\//.test(cand) && /^[^/]+\/(src|tests?)\//.test(cand)) cand = `repos/${cand}`;
    // strip a trailing :symbol / :line suffix
    cand = cand.replace(/:[A-Za-z0-9_$]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(cand) && repoPathExists(cand)) {
      const vesselDir = cand.match(/^repos\/([^/]+)\//)?.[1] ?? "";
      return { file: cand, description: `change site named by detector evidence (${f})`, vessel: vesselDir, method: "metadata_edit_site" };
    }
    // THE GATE NAMES A SYMBOL, NOT A PATH (contained-self-development, drafting reliability). The
    // semantic gate writes `suspected_real_location` as a symbol or shape (`self_fact_reconcile`,
    // `self_fact_reconcile:authoring_root`); the path check above skipped it, so every retry went
    // back to the edit_site the gate had just rejected, and TARGET-FILE-SCOPE forbade the drafter
    // from editing where the gate pointed (relevance-sink: 4 attempts at patch-with-tools.ts while
    // the gate named self_fact_reconcile). Resolve the symbol to the resolver file named after it,
    // or to the single file in the gap's vessel that mentions it.
    if (f === "suspected_real_location") {
      const sym = v.trim().split(/[:\s]/)[0] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(sym)) {
        const vesselForSym = identifyVessel(gap, meta);
        if (vesselForSym) {
          const kebab = sym.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
          const byName = `repos/${vesselForSym}/src/resolvers/${kebab}.ts`;
          if (repoPathExists(byName)) return { file: byName, description: `change site named by the semantic gate (${sym}, resolver file)`, vessel: vesselForSym, method: "metadata_edit_site" };
          const mentions = grepScoreFiles(join(runtimeRoot(), vesselForSym, "src"), vesselForSym, [sym]).filter((h) => h.matched.length > 0);
          if (mentions.length === 1 && mentions[0]) return { file: mentions[0].file, description: `change site named by the semantic gate (${sym}, sole file mentioning it)`, vessel: vesselForSym, method: "metadata_edit_site" };
        }
      }
    }
  }

  // (a) identify the target vessel.
  const vessel = identifyVessel(gap, meta);
  if (!vessel) return null;
  const srcAbs = join(runtimeRoot(), vessel, "src");
  if (!existsSync(srcAbs)) return null;

  // (c) extract terms + grep the vessel src/ for the best-matching file.
  const terms = localizeTerms(summary, meta);
  if (!terms.length) return null;
  const hits = grepScoreFiles(srcAbs, vessel, terms);
  if (!hits.length) return null;

  // Confidence: a single hit, or a clearly dominant hit (top score ≥ 2× runner-up AND
  // matched ≥2 terms). Otherwise optionally ask the LLM to pick among the close hits.
  const top = hits[0]!;
  if (hits.length === 1 && top.matched.length >= 1) {
    return { file: top.file, description: `derived via code-search (sole match on: ${top.matched.join(", ")})`, vessel, method: "grep_unique", candidates: 1 };
  }
  const runner = hits[1]!;
  if (top.score >= 2 * runner.score && top.matched.length >= 2) {
    return { file: top.file, description: `derived via code-search (dominant match on: ${top.matched.join(", ")})`, vessel, method: "grep_dominant", candidates: hits.length };
  }
  if (opts?.useLlm !== false) {
    const picked = await rankWithLlm(summary, hits);
    if (picked) {
      const h = hits.find((x) => x.file === picked)!;
      return { file: picked, description: `derived via code-search + LLM rank (matched: ${h.matched.join(", ")})`, vessel, method: "llm_ranked", candidates: hits.length };
    }
  }
  // Low confidence (several comparable hits, LLM declined/unavailable) → no fabrication.
  return null;
}

// ───────────────────────── DUAL-SIDE LOCALIZATION (2026-06-29, Stage B part 1) ─────────────────────────
// A responsibility_misallocation gap is frequently a MOVE: "vessel X does work that
// belongs behind a Y endpoint on vessel Z." The single-side localizer above pins only
// the SOURCE vessel (where the pattern matched), so feature_compose grounds + typechecks
// only the source and authors only the DELETION half (calling a destination endpoint that
// doesn't exist yet → UNFAVORABLE). dual-side localization parses the DESTINATION vessel
// (and, when present, the receiving endpoint/capability name) out of the gap text so BOTH
// vessels are grounded and BOTH halves get authored. STRICTLY ADDITIVE: only fires for
// move-type gaps with a destination DIFFERENT from the source; surgical/same-vessel gaps
// are untouched (returns null → unchanged single-side path).

export interface MoveTarget {
  /** Destination vessel dir name (exists under the runtime root), e.g. "activity-api". */
  vessel: string;
  /** repos/<vessel> path for verify_vessels grounding. */
  repoPath: string;
  /** Named receiving capability/endpoint when the gap states one, e.g. "select-activity-for-goal". */
  endpoint: string | null;
}

/** All vessel-shaped dir names under the runtime root (cached per call site is fine — cheap). */
function listVesselDirs(): string[] {
  try {
    return readdirSync(runtimeRoot()).filter((d) => {
      try {
        if (!statSync(join(runtimeRoot(), d)).isDirectory()) return false;
      } catch { return false; }
      return /-(vessel|api)$/.test(d) || /^(activity-api|goal-host-vessel)$/.test(d);
    });
  } catch {
    return [];
  }
}

/**
 * For a move-type gap, infer the DESTINATION vessel + (optional) receiving endpoint from
 * the summary/metadata. Returns null when no destination DIFFERENT from `sourceVessel`
 * can be confidently named (→ caller keeps single-side behaviour). Pure text parse; no IO
 * beyond a cheap dir-listing.
 */
function inferMoveTarget(
  gap: Record<string, unknown>,
  meta: Record<string, unknown>,
  sourceVessel: string | null,
): MoveTarget | null {
  // Only responsibility_misallocation is a move candidate. (Other categories may move
  // logic too, but we gate conservatively on the one category the detector emits for it.)
  if (String(gap.category ?? "") !== "responsibility_misallocation") return null;

  const summary = String(gap.summary ?? gap.title ?? "");
  // An explicit destination field wins if the detector ever sets one.
  for (const f of ["destination_vessel", "target_vessel", "move_to"]) {
    const v = meta[f];
    if (typeof v === "string" && v.trim() && vesselDirExists(v.trim()) && v.trim() !== sourceVessel) {
      return { vessel: v.trim(), repoPath: `repos/${v.trim()}`, endpoint: inferEndpointName(summary) };
    }
  }

  // Otherwise parse a destination vessel name out of the summary. Prefer one that appears
  // in a MOVE phrase ("on <v>", "to <v>", "into <v>", "behind … <v>", "live in <v>"),
  // and is a real vessel dir DIFFERENT from the source. The detector phrasing for the
  // canonical case is: "…should live behind a select-activity-for-goal endpoint on activity-api."
  const dirs = listVesselDirs().filter((d) => d !== sourceVessel);
  if (!dirs.length) return null;

  // Score each candidate dir by whether it appears as a hyphen/space-bounded token in the
  // summary, boosted when preceded by a move-preposition. Longest match wins ties.
  let best: { vessel: string; score: number } | null = null;
  for (const d of dirs) {
    const esc = d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // token-bounded occurrence anywhere in the summary
    if (!new RegExp(`(?:^|[^A-Za-z0-9-])${esc}(?:$|[^A-Za-z0-9-])`).test(summary)) continue;
    let score = d.length; // prefer the most-specific dir name
    // move-preposition immediately before the vessel name = strong move signal
    if (new RegExp(`\\b(?:on|to|into|in|onto|behind[^.]*?\\bon)\\s+${esc}\\b`, "i").test(summary)) score += 100;
    if (!best || score > best.score) best = { vessel: d, score };
  }
  if (!best) return null;
  return { vessel: best.vessel, repoPath: `repos/${best.vessel}`, endpoint: inferEndpointName(summary) };
}

/** Pull a receiving endpoint/capability name when the summary states one (e.g. "select-activity-for-goal endpoint"). */
function inferEndpointName(summary: string): string | null {
  // "a <kebab-name> endpoint" / "<kebab-name> endpoint" / "a /<route> endpoint"
  const m =
    summary.match(/\b([a-z][a-z0-9-]{3,}(?:-[a-z0-9]+)+)\s+endpoint\b/i) ??
    summary.match(/\bendpoint\s+(?:called|named)\s+["'`]?([a-z][a-z0-9/_-]{3,})["'`]?/i) ??
    summary.match(/\b(\/[a-z0-9/_-]{3,})\s+endpoint\b/i);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * gap_to_feature (2026-06-21) — closes the autonomy loop: routes maintenance-
 * detector gaps THROUGH the feature composer.
 *
 * detect (detectors emit substrateGap) -> SPEC (this bridge) -> author
 * (feature_compose) -> verify (typecheck) -> stage. This is the piece that lets
 * the substrate maintain/upkeep what it writes: a gap a detector raises (incl.
 * the new db_contention gap, and the model-opportunity gaps that the surgical
 * gate used to REFUSE as non_surgical) now becomes an authored, verified change.
 *
 * SAFETY: FAVORABLE results are STAGED (left in the /vessels runtime), NOT
 * auto-pushed — landing flows through the existing cutover gate / operator.
 * UNFAVORABLE rolls back (feature_compose does this). So the loop is autonomous
 * up to a verified staged change; deploying AI-authored code stays gated.
 */
export interface GapToFeaturePointer {
  type: "gap_to_feature";
  /** Specific gap id to address; if absent, pick the first open gap (optionally filtered). */
  gap_id?: string;
  /** Filter open gaps by category when picking (e.g. "db_contention", "model-opportunity"). */
  category?: string;
  model?: string;
  /** Plan only (do not apply). */
  dry_run?: boolean;
  /** How many open gaps to consider when auto-picking. */
  limit?: number;
}

/**
 * Return a REAL line from the live target file that occurs EXACTLY ONCE — a
 * deterministic MATCH ANCHOR the drafter can localize on. The drafter obeys the
 * spec anchor over the actual file, so a SCHEMATIC (non-existent) gap-derived
 * line mis-directs the edit and a NON-UNIQUE line fails closed. Selection order:
 *   1. the most-distinctive line drawn FROM the excerpt hint that is unique in
 *      the file — keeps the detector's intended context when the excerpt was
 *      accurate, and REJECTS it when schematic (no excerpt line exists uniquely);
 *   2. else the most-distinctive unique line in the edit-site window (±20 lines
 *      when a line number is known, else the whole file).
 * Returns the ORIGINAL file line (verbatim, with its indentation), or null when
 * nothing clears the uniqueness bar. Only ever returns text that literally
 * exists in the live file.
 */
export function groundedUniqueAnchor(
  liveLines: string[],
  excerptHint: string | null,
  startLine: number,
): string | null {
  const norm = (s: string) => s.trim();
  const MIN_LEN = 12;   // ignore short/boilerplate lines (braces, keywords)
  const MAX_LEN = 240;  // avoid quoting a minified/huge line as the anchor
  const counts = new Map<string, number>();
  const original = new Map<string, string>(); // norm -> first original (indented) line
  for (const l of liveLines) {
    const t = norm(l);
    if (t.length < MIN_LEN || t.length > MAX_LEN) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (!original.has(t)) original.set(t, l);
  }
  const uniqueOriginal = (t: string): string | null =>
    counts.get(t) === 1 ? (original.get(t) ?? null) : null;
  // (1) a unique line taken from the excerpt hint — most distinctive first.
  if (excerptHint) {
    const cand = excerptHint.split("\n").map(norm).filter((t) => t.length >= MIN_LEN);
    cand.sort((a, b) => b.length - a.length);
    for (const t of cand) {
      const o = uniqueOriginal(t);
      if (o) return o;
    }
  }
  // (2) a unique line inside the edit-site window.
  const from = startLine > 0 ? Math.max(0, startLine - 20) : 0;
  const to = startLine > 0 ? Math.min(liveLines.length, startLine + 20) : liveLines.length;
  const win = liveLines.slice(from, to).filter((l) => norm(l).length >= MIN_LEN);
  win.sort((a, b) => norm(b).length - norm(a).length);
  for (const l of win) {
    const o = uniqueOriginal(norm(l));
    if (o) return o;
  }
  return null;
}

// Grounds the spec anchor in the LIVE target file: hands the drafter real file
// text (a verbatim window + a proven-UNIQUE match line) instead of a gap-derived
// matched_excerpt that may be schematic or non-unique. matched_excerpt is used
// only as a HINT to select the unique line, never emitted verbatim unless the
// live target file cannot be read.
export function specFromGap(
  gap: Record<string, unknown>,
  editTargets: Array<{ file: string; description: string }> = [],
  move?: { source: string | null; sourceFile: string | null; target: MoveTarget } | null,
): string {
  const summary = String(gap.summary ?? gap.title ?? "");
  const meta = (gap.classification_metadata ?? gap.metadata ?? null) as Record<string, unknown> | null;
  // Include only the GROUNDING fields as crisp lines — NOT a full classification_metadata
  // JSON dump. The dump bloats the spec and measurably degrades feature_compose's decompose:
  // a gap that authored FAVORABLE (op_count:1, typecheck-clean) via a crisp DIRECT spec came
  // back UNFAVORABLE / 0-ops through this gap path purely from the extra framing + JSON dump.
  // Keeping the composer's input tight is a loop-wide authoring lever. (2026-07-01)
  const metaStr = meta
    ? (() => {
        // Anchor line: prefer upstream-set excerpt; fall back to live file contents
        // when editTargets names a real file under repos/<vessel>/src/.
        // Ground the anchor against the LIVE target file. The drafter obeys the
        // spec anchor over the real file, so a SCHEMATIC (non-existent) or
        // NON-UNIQUE gap-derived excerpt mis-localizes the edit — the drafter's
        // binding-constraint failure. Whenever the target is a readable
        // repos/<vessel>/src file we hand the drafter ONLY real file text: a
        // verbatim window for context PLUS a line proven to occur EXACTLY ONCE in
        // the live file to anchor on. matched_excerpt is used only as a HINT to
        // pick that unique line (excerpt-first, then edit-site window), never
        // emitted verbatim unless the live file cannot be read.
        let anchorLine = "";
        const firstTarget: string | undefined = editTargets[0]?.file;
        const excerptHint = meta.matched_excerpt != null ? String(meta.matched_excerpt) : "";
        let liveLines: string[] | null = null;
        if (firstTarget && /^\/repos\/[^/]+\/src\//.test(`/${firstTarget}`)) {
          try {
            liveLines = readFileSync(join(runtimeRoot(), firstTarget.replace(/^repos\//, "")), "utf8").split("\n");
          } catch {
            liveLines = null; // file unreadable — fall back below
          }
        }
        if (liveLines && firstTarget) {
          // Near-edit-site grounding (#18): center the ~40-line window on the edit
          // site when edit_site/suspected_real_location names a line; else top of file.
          const siteStr = `${String(meta.edit_site ?? "")} ${String(meta.suspected_real_location ?? "")}`;
          const lineMatch = siteStr.match(/(?::|line\s+|#L)(\d+)/i);
          let startLine = lineMatch ? (parseInt(lineMatch[1] ?? "0", 10) || 0) : 0;
          // REGION -> LINE. A ui-feedback gap names the surface's file but not a line, so
          // this window fell back to the TOP OF FILE and the drafter anchored on whatever
          // happened to be there. Observed: a complaint about `sub-card sub-card--fleet`
          // produced a plan anchored on `sub-step-shadowline`, an unrelated region, twice
          // over with the identical old_string.
          //
          // The region IS the literal CSS class the renderer passes to createDiv, so it is
          // greppable in the file we were just told to edit. Resolve it here — this code
          // runs in development-vessel, which HAS the repo; the filing vessel (an Obsidian
          // plugin) does not and cannot. Prefer the LAST occurrence: these views build a
          // compact row first and the expanded detail later, and a complaint about content
          // legibility is about the rendered detail.
          // AN EXPLICIT "~l.NNN[-MMM]" IN THE GAP IS THE AUTHOR'S STATEMENT OF THE SITE (09-30): it outranks the
          // region literal and the first-symbol match below, which grounded the drain gap's 9 drafts elsewhere
          // while its summary said ~l.249-264.
          if (startLine === 0) {
            const hinted = explicitLineHint(String(summary));
            if (hinted && hinted.start <= liveLines.length) { startLine = hinted.start; console.log(`[gap-to-feature] explicit line hint: ${firstTarget} grounded at line ${startLine}`); }
          }
          if (startLine === 0) {
            const region = String(meta.region ?? "").trim() || (() => { const t = String(siteStr).trim().split(" ")[0] ?? ""; const ci = t.indexOf(":"); const nm = ci >= 0 ? t.slice(ci + 1) : ""; return Number.isNaN(Number(nm)) ? (nm.startsWith("/") ? nm.slice(1) : nm) : ""; })();
            if (region) {
              const idx = liveLines.map((l, i) => (l.includes(region) ? i : -1)).filter((i) => i >= 0);
              if (idx.length > 0) {
                startLine = (idx[idx.length - 1] ?? 0) + 1;
                console.log(`[gap-to-feature] region->line: "${region}" found at ${idx.length} site(s) in ${firstTarget}; grounding on line ${startLine} (last occurrence)`);
              } else {
                console.warn(`[gap-to-feature] region->line: "${region}" NOT FOUND in ${firstTarget} — grounding falls back to top of file, drafter will likely anchor on the wrong code`);
              }
            }
          }
          if (startLine === 0) { const toks = Array.from(new Set(String(summary).split(" ").map((w) => w.replace(/[^A-Za-z0-9_]/g, "")).filter((w) => w.length > 5))); for (const id of toks) { const hit = liveLines.findIndex((l) => l.includes("function " + id) || l.includes("const " + id) || l.includes(id + "(")); if (hit >= 0) { startLine = hit + 1; console.log("[gap-to-feature] symbol->line: " + id + " grounds " + firstTarget + " at line " + startLine); break; } } }
          const from: number = Math.max(0, startLine - 15);
          const windowText = liveLines.slice(from, from + 40).join("\n");
          const fsRoots = ["/workspace", "/vessels", "/etc", "/tmp", "/var", "/usr", "/home", "/proc", "/opt", "/root"];
const premiseTokens = Array.from(new Set(String(summary).split(" ").filter((w) => w.startsWith("/")).map((w) => w.split(",")[0] ?? "").map((w) => w.split(")")[0] ?? "").filter((w) => w.length > 5))).filter((t) => !fsRoots.some((r) => t.startsWith(r)));
          const missingPremise = premiseTokens.filter((t) => !liveLines.some((l) => l.includes("'" + t + "'") || l.includes('"' + t + '"')));
          if (missingPremise.length > 0) { console.warn("[gap-to-feature] PREMISE UNVERIFIED: gap names " + missingPremise.join(", ") + " but no quoted occurrence exists in " + firstTarget); }
          const premiseWarning = missingPremise.length > 0 ? (" — PREMISE WARNING: this gap names " + missingPremise.join(", ") + " but NO quoted occurrence of it exists anywhere in this file, so the gap is probably MISLOCALIZED. Do NOT invent an anchor for it. If you cannot identify the real target in the excerpt below, emit ZERO ops and report the false premise instead.") : "";
          // No approval clause here: the boundary that removes a gap from autonomous work is operator_hold (filer-set,
          // enforced at admission and pick). A prose ban on every unapproved gap was ignored by drafters, except to forge approval.
          const anchorLabel = startLine > 0 ? ("Anchor (verbatim near edit site)" + premiseWarning) : ("Anchor (verbatim top of file)" + premiseWarning);
          const vesselName = firstTarget.split('/')[1] ?? 'unknown';
          const unique = groundedUniqueAnchor(liveLines, excerptHint || null, startLine);
          const uniqueNote = unique
            ? `\nMATCH ANCHOR (this REAL line occurs EXACTLY ONCE in ${firstTarget} — locate your edit relative to it, verbatim): \`\`\`\n${unique}\n\`\`\``
            : "";
          anchorLine = `File facts: ${firstTarget} (vessel: ${vesselName}), total_lines=${liveLines.length}, excerpt_start_line=${from + 1}\n${anchorLabel}: \`\`\`\n${windowText}\n\`\`\`${uniqueNote}`;
        } else if (excerptHint) {
          // Target is not a readable repos/<vessel>/src file — cannot ground.
          // Keep the upstream excerpt as-is (unchanged legacy behaviour).
          anchorLine = `Anchor (existing code near the change): \`\`\`\n${excerptHint}\n\`\`\``;
        }
        const lines = [
          meta.edit_site ? `Change site: ${String(meta.edit_site)}` : "",
          meta.suspected_real_location ? `Location: ${String(meta.suspected_real_location)}` : "",
          anchorLine,
        ].filter(Boolean).join("\n");
        return lines ? `\n\n${lines}` : "";
      })()
    : "";
  // PRIOR-ATTEMPT FEEDBACK: if the semantic gate already rejected a draft for this gap,
  // surface its findings as explicit, framed re-draft guidance (not just buried in the
  // detector-evidence JSON dump) so the next draft completes the partial fix. Additive.
  const priorFeedback = priorAttemptFeedbackBlock(meta);
  // When a prior analysis named concrete EXISTING files as the change site, make
  // them the mandated edit targets — this is what keeps the composer producing
  // `edit` ops that land instead of scaffolding a new vessel that phantom-lands.
  const targetStr = editTargets.length
    ? [
        "",
        "REQUIRED: this gap has a known change site in EXISTING source. EDIT these files IN PLACE.",
        "Do NOT create a new vessel, package.json, or any new file — emit `edit` ops on these exact paths only:",
        ...editTargets.map((t) => `  - ${t.file}${t.description ? ` — ${t.description}` : ""}`),
      ].join("\n")
    : "";

  // MOVE-AWARE BRANCH (2026-06-29): for a responsibility-MOVE gap, the right fix is NOT
  // the smallest surgical edit — it is a two-sided change: CREATE the receiving capability
  // in the destination vessel AND replace the inline logic in the source vessel with a
  // call to it. The "smallest surgical edit" framing biases AGAINST authoring both halves
  // (the planner deletes the source logic and calls a destination endpoint that doesn't
  // exist). This branch replaces that framing for move-type gaps only; surgical gaps fall
  // through to the unchanged instruction below (byte-identical).
  if (move && move.source && move.target && move.target.repoPath) {
    const epName = move.target.endpoint ?? "";
    const srcLabel = move.source;
    return [
      "This substrate gap is a RESPONSIBILITY MOVE between vessels — author BOTH halves of the move (this is NOT a single surgical edit):",
      `  HALF 1 (DESTINATION — ${move.target.repoPath}): CREATE the receiving capability${epName} in this vessel. Add it idiomatically — a resolver + its dispatch case + its discovery shape if the vessel exposes capabilities as impulse shapes, or a new HTTP route/handler if it exposes them as routes. Match how this vessel's existing capabilities are structured (read the grounded current contents to mirror its resolver/route pattern and return shape).`,
      `  HALF 2 (SOURCE — ${srcLabel}): REPLACE the inline logic that the detector flagged with a CALL to the new destination capability (e.g. a fetch to the new endpoint / a dispatch of the new impulse shape). Remove the misallocated inline implementation from the source; keep the source's behaviour intact by delegating to the destination.`,
      "Emit ops for BOTH vessels: at least one `create_file` or `edit` in the DESTINATION vessel AND at least one `edit` in the SOURCE vessel. Order destination ops before the source edit that references them.",
      "Both vessels MUST typecheck. Name real files under repos/<vessel>/src/ (the grounded file trees below show the real paths).",
      priorFeedback,
      "",
      `GAP: ${summary}`,
      metaStr,
    ].join("\n");
  }

  return [
    "Address the following substrate gap with the SMALLEST concrete, verifiable code change that resolves it.",
    "Prefer a minimal surgical edit to EXISTING vessel source. Only author a new file/vessel if the gap genuinely requires a capability no existing resolver provides, and then make it complete and dependency-free (Bun built-ins only).",
    "The change MUST typecheck. Name real files under repos/<vessel>/src/.",
    targetStr,
    priorFeedback,
    "",
    `GAP: ${summary}`,
    metaStr,
  ].join("\n");
}

// Whole-store id index for the pick in progress, set by the auto-pick caller just before it calls
// pickMostLandable. The admitted list alone cannot resolve a narrowed child's parent: the parent
// is often excluded (pending, held) while its child is admitted.
let pickLineageIndex: Map<string, Record<string, unknown>> = new Map();
function pickMostLandable(gaps: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!gaps.length) return null;
  // Learned category-level self-knowledge (expectation-setting step 3, 2026-06-29): strongly
  // deprioritise gaps in a category the substrate has EMPIRICALLY learned it cannot land
  // (>=8 attempts, 0 lands) — stop wasting cycles on a class it can't author, while leaving a
  // re-test path (penalty, not hard exclusion) if nothing better exists.
  const calib = readCalibration();
  const hopeless = (g: Record<string, unknown>): boolean => {
    const r = calib[String(g.category ?? "unknown")];
    if (!r || r.attempts < 8 || r.lands !== 0) return false;
    // HUMAN-AUTHORIZED EXEMPTION (2026-08-28). 143212a traded the automatic re-test path
    // ("leaving a re-test path", d1bb37a) for a HUMAN DECISION, and predicated this
    // exclusion on the row being "already escalated" — the human IS the designed escape.
    // Until escalation_disposition_apply existed nothing applied the answer, so the trade
    // was one-directional and the seal was permanent. A gap whose escalation a human has
    // ANSWERED carries a bounded exemption; it is per-GAP and decrements, so the category
    // stays sealed for every other member and the flood 143212a deliberately closed cannot
    // reopen. Not a threshold change: without an answered escalation this is a no-op.
    const gm = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    if (Number(gm.human_exemption_attempts_remaining ?? 0) > 0) return false;
    return true;
  };
  // Escalate hopeless gaps to a HUMAN and exclude them from selection.
  // The escalation is the uiQuestion_write and nothing else. This branch used to ALSO call
  // resolveDispatchGoal({ goalShape: "substrate_gap_decompose", payload: {...} }). That call
  // could never dispatch: DispatchGoalPointer has no `goalShape` and no `payload` (see
  // repos/development-vessel/src/resolvers/dispatch-goal.ts @ `export interface DispatchGoalPointer`),
  // so resolveDispatchGoal read an empty `pointer.goal` and RETURNED a structuredError at
  // `if (!goal) return { shape: "structuredError"` — a resolved promise, which the attached
  // .catch() can never observe. The `as never` cast hid the type error and the error value was
  // discarded, so the failure was invisible. It is not repaired, because repairing it needs a
  // producer for `substrate_gap_decompose` and none exists: discovery advertises 332 shapes and
  // zero match /decompos/ (measured 2026-08-06 against http://localhost:18100/registry/shapes).
  // A dispatch to a shape nothing serves is confabulation with a dispatch id attached.
  const actionableGaps: Record<string, unknown>[] = [];
  for (const g of gaps) {
    if (hopeless(g)) {
      const gid = String((g as Record<string,unknown>).id ?? (g as Record<string,unknown>).gap_id ?? "");
      if (gid && !solicitedHumanGaps.has(gid)) {
        const SOLICITED_GAPS_LOG = '/var/tmp/solicited_gaps.log';
        let alreadyPersisted = false;
        try {
          if (existsSync(SOLICITED_GAPS_LOG)) {
            const content = readFileSync(SOLICITED_GAPS_LOG, 'utf-8');
            if (content.includes(`${gid}\n`)) {
              alreadyPersisted = true;
              solicitedHumanGaps.add(gid); // Cache in memory to avoid re-reading file in this run
            }
          }
        } catch (e) {
          console.warn(`[gap-escalation] Failed to read solicitation log, may re-solicit: ${String(e)}`);
        }

        if (!alreadyPersisted) {
          // In-process only until delivery is confirmed: persisting BEFORE the send recorded asks that
          // threw as asked, so they were never retried (node 2: 316 ids, 09-29). Persist on acceptance.
          solicitedHumanGaps.add(gid);

          resolveUiWritePassthrough({ type: "uiQuestion_write", id: "needs-human-" + gid, title: "Gap needs a human decision", body: "Gap " + gid + " (" + String((g as Record<string,unknown>).category ?? "?") + ") has failed auto-repair 8+ times with 0 lands. It likely needs a human response: redefine the goal, provide missing information, grant access, or drop it. Summary: " + String((g as Record<string,unknown>).summary ?? "").slice(0, 300), kind: "gap_needs_human", importance: "high" } as never)
            .then((r) => {
              // An escalation that silently failed is indistinguishable from one that was never
              // attempted. Log ALL THREE outcomes so the absence of a line means "hopeless() never
              // fired", not "the escalation was eaten". Baseline before this change: 0 lines in 7d.
              const shape = (r as { shape?: unknown } | undefined)?.shape;
              const delivered = shape !== "structuredError" && ((r as { body?: { ok?: unknown } } | undefined)?.body?.ok !== false);
              if (!delivered) {
                console.warn(`[gap-escalation] uiQuestion_write REJECTED for hopeless gap ${gid}: ${JSON.stringify((r as { body?: unknown }).body).slice(0, 400)} — no human was asked; not recorded as solicited, retried after restart`);
              } else {
                try {
                  appendFileSync(SOLICITED_GAPS_LOG, `${gid}\n`);
                } catch (e) {
                  console.warn(`[gap-escalation] Failed to write to solicitation log: ${String(e)}`);
                }
                console.log(`[gap-escalation] uiQuestion_write accepted for hopeless gap ${gid} (shape=${String(shape)})`);
              }
            })
            .catch((e: unknown) => {
              console.warn(`[gap-escalation] uiQuestion_write THREW for hopeless gap ${gid}: ${String(e)} — no human was asked; not recorded as solicited, retried after restart`);
            });
        }
      }
      continue;
    }
    actionableGaps.push(g);
  }
  const scoredGaps = actionableGaps;
  // IMPACT-RANKED SELECTION (2026-07-09): landability alone drains the easiest gaps
  // first and lets a blocking gap starve behind them. Impact = how many OTHER open
  // gaps cite this gap (by id or by its failing_capability) in their summaries or
  // failure lessons — a cited blocker outranks its dependents, so a broken sensor
  // (missing_capability others depend on) self-prioritizes because it blocks
  // everything downstream. Computed from the gaps already in hand: no extra reads.
  // IMPACT MUST BE INDEPENDENT EVIDENCE (2026-08-06). `cited` counted ANY other open gap
  // whose summary contains this gap's id. The goal-host routing path mints children whose
  // summary IS the parent's goal text prefixed `Close substrate gap <parent-id>:`, so an
  // 80-generation prefix chain made every member cite its own ancestors. Measured on the
  // live store (651 admitted): 179 gaps sat at the x2.0 impact cap and ALL 179 were
  // edit_intent_route citing each other, while 0 of the 334 non-route gaps ever reached it.
  // A term meant to surface a BLOCKER was surfacing the one family that manufactures its
  // own citations. A citer in the SAME category is not independent evidence; count only
  // cross-category citations, which is exactly the "other kinds of work are blocked on
  // this" signal the term was introduced for.
  const impactOf = (g: Record<string, unknown>): number => {
    const id = String(g.id ?? "").toLowerCase();
    const gm = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    const cap = String(gm.failing_capability ?? "").toLowerCase();
    const myCat = String(g.category ?? "");
    let cited = 0;
    for (const other of gaps) {
      if (other === g || String(other.category ?? "") === myCat) continue;
      const om = (other.classification_metadata ?? other.metadata ?? {}) as Record<string, unknown>;
      const hay = (String(other.summary ?? "") + " " + JSON.stringify(om.per_gap_failure_lessons ?? om.failure_lessons ?? om.gap_lessons ?? "")).toLowerCase();
      if ((id.length > 8 && hay.includes(id)) || (cap.length > 3 && hay.includes(cap))) cited++;
    }
    let verifiabilityCredit = 0;
    const falsifier = String((gm.falsifier ?? '')).toLowerCase();
    if (falsifier === 'class1' || falsifier === 'class2') {
      verifiabilityCredit = 0.5; // Small ranking term for verifiability
    }
    return (1 + Math.min(1.0, 0.25 * cited)) + verifiabilityCredit;
  };
  // SIGN FIX + DEAD-FILTER FIX (2026-08-06). `* blockingWeight(g)` multiplied the score by
  // up to 1.6 for gaps whose metadata points at the picker/composer itself — the exact
  // OPPOSITE of the intent documented at the `bw > 1` branch of landabilityScore, which
  // already applies the intended -0.06 penalty. Net effect was +40% for self-targeting
  // gaps. And the map ran over `gaps`, so `scoredGaps` (hopeless-category rows escalated
  // and meant to be excluded) was computed and then discarded — the escalated gap was
  // selected anyway. When EVERY candidate is hopeless, return null so the caller emits its
  // documented graceful "no matching open gap" instead of selecting a gap the calibration
  // has already proven unlandable (and instead of ranked[0]! throwing on an empty array).
  if (!scoredGaps.length) return null;
  const selectionPool = scoredGaps;
  // A HUMAN'S REPORT OUTRANKS A MACHINE-GENERATED ROUTING RECORD.
  //
  // Nothing in the score distinguished who filed a gap, so a person's complaint about
  // the interface competed on equal terms with the substrate's own bookkeeping. Measured
  // today: 54 gaps tied at the identical top score of 0.9, the great majority of them
  // route-edit rows the routing path mints about itself. A reopened human complaint lost
  // that draw repeatedly and simply never got picked.
  //
  // Human input is the scarce signal here. The substrate can mint route-edit gaps
  // without limit and does; a person types a complaint once and it is the only evidence
  // of what they actually experience. Law 13 puts humans on the resolver side of this
  // system, not the preprocessor side — their reports are input to be acted on, and a
  // tie-break that ignores provenance quietly discards them.
  //
  // A 1.5x multiplier, not an override: it breaks ties and outranks equal-scored machine
  // rows, while a genuinely more landable or more blocking gap still wins on merit. This
  // does not make human gaps unconditionally first, and it must not — a syntax break
  // that wedges a vessel outranks a legibility complaint, and did so correctly today.
  const HUMAN_REPORT_PRIORITY = 1.5;
  // A LIVE HUMAN EXEMPTION COUNTS AS HUMAN ENDORSEMENT (2026-08-29). The bounded exemption granted
  // by escalation_disposition_apply bought immunity from the CATEGORY SEAL but nothing in
  // selection, so a gap the operator had just answered took one attempt and then lost the queue.
  // Measured: the lift-gate gap sat with 2 of its 3 exemption attempts UNSPENT and was picked ZERO
  // times in 25 minutes, while three competitors carrying failed_attempts of 122, 82 and 64 were
  // picked 8 times each — they were not winning on a reset penalty, they simply outranked it.
  //
  // An operator answering an escalation is the substrate's most expensive input: the one fact it
  // cannot derive for itself. Spending it on a single attempt and then stranding the remainder
  // wastes it, and leaves the seal's only designed escape opening onto a full room.
  //
  // A gap the operator has just ANSWERED is at least as human-endorsed as one the operator merely
  // REPORTED, so it earns the same 1.5x — a tie-breaker, not an override. Everything the comment
  // above says still holds: a genuinely more landable or more blocking gap still wins on merit.
  //
  // Self-limiting by construction: bumpFailedAttempts decrements the counter on every non-landing
  // attempt, so the preference expires after the three granted attempts and the gap returns to
  // ordinary ranking WITH ITS REAL HISTORY INTACT. Deliberately NOT done by zeroing
  // failed_attempts — that is the narrowing defect (a verbatim child with failed_attempts:0
  // outranking its own parent forever), which this store already carries a closed gap for.
  const hasLiveHumanExemption = (g: Record<string, unknown>): boolean => {
    const m = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    return Number(m.human_exemption_attempts_remaining ?? 0) > 0;
  };
  const humanWeight = (g: Record<string, unknown>): number =>
    String(g.source ?? "") === "human_reported" || hasLiveHumanExemption(g) ? HUMAN_REPORT_PRIORITY : (String(g.category) ?? '').startsWith('route-edit') ? 0.5 : 1;
  const ranked = selectionPool
    .map((g) => ({ g, s: landabilityScore(g) * impactOf(g) * humanWeight(g) }))
    .sort((a, b) => b.s - a.s);
  // LANDABILITY FLOOR (value-per-cost-selection 2.5). The class rerank below orders by a sampled
  // class theta BEFORE score, so a fresh class's uninformed posterior lifted a score-0 candidate
  // over a 0.9 one. Candidates below the floor are dropped before any posterior is consulted.
  const LANDABILITY_FLOOR = 0.15;
  const aboveFloor = ranked.filter((r) => landabilityScore(r.g) >= LANDABILITY_FLOOR);
  if (aboveFloor.length < ranked.length) {
    console.log(`[gap-to-feature] landability_floor excluded ${ranked.length - aboveFloor.length} of ${ranked.length} candidates (floor=${LANDABILITY_FLOOR})`);
    ranked.splice(0, ranked.length, ...aboveFloor);
  }
  if (!ranked.length) return null;
  // CLASS-THOMPSON RERANK (Option B): sample theta_c ~ Beta(alpha_c, beta_c) once per class in
  // the pool, then prefer the winning class; WITHIN a class the landability ranking above still
  // orders gaps, so the pick is the best-scored gap of the sampled class. chooseFirstActionable
  // below still walks past pending gaps, so a fully-pending winning class falls through to the
  // next class instead of starving the tick.
  const classPosteriorsNow = readClassPosteriors();
  const classTheta = new Map<string, number>();
  for (const r of ranked) {
    const c = gapClassOf(r.g);
    if (!classTheta.has(c)) classTheta.set(c, sampleClassTheta(c, classPosteriorsNow));
  }
  ranked.sort((a, b) => {
    const ta = classTheta.get(gapClassOf(a.g)) ?? 0.5;
    const tb = classTheta.get(gapClassOf(b.g)) ?? 0.5;
    return tb !== ta ? tb - ta : b.s - a.s;
  });
  // A GAP THAT CANNOT BE COMPOSED MUST NOT CONSUME THE PICK (2026-08-28).
  //
  // The eligibility test ran only AFTER selection: the branches at `pickConditionCheck ===
  // 'pending'` (~2300) and `_pickCond === 'pending'` (~2501) correctly refuse to re-compose a
  // gap that landed once but is unmeasured — a second landing would manufacture the re-land the
  // close-oracle scores as a false close. But by then the pick was already spent, so the cycle
  // ended in a no-op and the next tick re-selected the same gap.
  //
  // Self-sustaining, because a skipped pick does no work and therefore records no failed
  // attempt: the score never decays, so the same gap wins again. Measured over 6h on
  // recommit-route-edit-9077062c-typecheck_dangling_reference-narrowed: 50 picks, 0 composes,
  // failed_attempts 0, landability 1.0, open since 2026-08-16 — roughly one wasted cycle every
  // 7 minutes. Over the same window seven eligible operator-filed gaps were never picked once.
  //
  // Filter on the SAME predicate the post-selection branches use. 'pending' here is DERIVED at pick
  // time by verifyGapCondition from landed-commit provenance, because the livelocked gap did not carry
  // the stored disposition (it was null on that record while it logged PENDING on every pick).
  // The stored disposition is filtered too, one layer earlier: admission (admitActionableGaps,
  // isAwaitingLandVerification) excludes disposition pending_verification, because this skip missed
  // the gaps it cannot judge at pick time (2026-09-30, compose2: 35 of 75 picks went to gaps whose own
  // commit had already landed). Admission re-admits one once its landing is known not to have fixed it
  // (regressed_by, BEHAVIORAL VERIFICATION FAILED, or the sweep's release), so the two layers compose.
  //
  // Walked lazily rather than applied pool-wide: verifyGapCondition -> landedCommitVerdict
  // spawns `git log --grep` per clone plus `git log -1` per matching sha, so evaluating all
  // ~330 pooled gaps every pick would be hundreds of subprocesses. Walking the ranked list
  // costs one evaluation per pending gap actually encountered, normally one or two.
  //
  // Only 'pending' is skipped. 'absent' must still be selected — the post-selection branch
  // closes those as already_resolved, which is real work, not a no-op.
  // Extracted as a pure function with an injected predicate so the skip is unit-testable
  // without a git checkout — the same reason computeNewlyFailing was extracted in the cutover
  // resolver. A selection change that only a diff-reader has inspected is the inert-landing
  // risk fc-coverage warns about: only a test actually runs it.
  // SKIP A LANDED-BUT-UNVERIFIED GAP WHATEVER ITS VERDICT — not just 'pending'.
  //
  // This filter used to test `=== 'pending'` only, which protects a gap for exactly one
  // landing and then stops. Class-3 provenance returns 'pending' for a SINGLE landing and
  // 'present' for a RE-LAND, so the moment a gap lands twice it flips to 'present', drops out
  // of this skip, and is re-composed again — which produces a third landing, which is still
  // 'present'. The first re-land permanently removes the protection and guarantees the next.
  //
  // Measured 2026-08-31: `gap-env-gated-write-allowlist` has SIX substrate-authored commits,
  // every one editing src/resolvers/fs-write.ts — three of them inside 67 minutes on 08-17,
  // and one on 08-30 as a recommit-recommit-. At ~4% compose success those are among the most
  // expensive artifacts the lane produces, all spent re-fixing the same file. bafd83d in that
  // list is the commit §12.6 names as "the inert-diff hole": the operator fix stopped the
  // FALSE CLOSE and did nothing about the RE-WORK.
  //
  // The distinction that matters: a CLASS-1 'present' is MEASURED — the literal is still in
  // the file, the fix genuinely did not work, retrying is right. A CLASS-3 'present' only
  // means "landed >= 2 times"; it is evidence of churn, not of a surviving defect, and
  // treating it as a retry signal is backwards. So skip on the pending-verification STAMP for
  // gaps that carry no measurable predicate, and leave measured gaps alone.
  //
  // Over-skipping is the safe direction here. These gaps are already landed and already
  // escalated to a human; another compose cannot close them (only a predicate or a human
  // can), so skipping frees the scarcest resource in the system. chooseFirstActionable still
  // fails open when every candidate is skipped, so the lane cannot starve.
  const { chosen, skippedPending } = chooseFirstActionable(ranked, (g) => {

    const m = (g as { classification_metadata?: Record<string, unknown> }).classification_metadata ?? {};
    const landedAwaitingVerification = typeof m.pending_outcome_verification === 'string'
      && (m.pending_outcome_verification as string).length >= 7;
    const hasMeasurablePredicate = typeof m.hardcoded_url === 'string'
      || typeof m.evidence_resolve === 'string' || typeof m.verify_shape === 'string' || typeof m.expected_literal === 'string';
    const operatorHold = ((m as { operator_hold?: unknown }).operator_hold as boolean | undefined) === true;
    if (operatorHold) return true;
    // A falsified landing still in HEAD: another compose would build on the regression. Held until
    // its revert is recorded (regressed_by.revert_sha).
    const regressedBy = m.regressed_by as { revert_sha?: unknown } | null | undefined;
    if (regressedBy && typeof regressedBy === 'object' && !regressedBy.revert_sha) return true;
    if (landedAwaitingVerification && !hasMeasurablePredicate) return true;
    // A NARROWED CHILD WAITS WHILE ITS PARENT'S LANDING IS UNJUDGED (2026-09-28). The child repeats
    // its parent's defect at the same site; composing it now edits the parent's fresh lines with no
    // record that they are the parent's fix (39bef90 -> bc99f91, b20274c -> 9c86aff, each reversed
    // within 30 min). Skip only; the parent's landing never closes the child (measurement before
    // provenance). Once the parent's landing is judged, the stamp clears and the child is eligible.
    const parentId = typeof m.parent_gap_id === 'string' ? m.parent_gap_id : '';
    if (parentId) {
      const parent = pickLineageIndex.get(parentId) ?? gaps.find((p) => String(p.id ?? '') === parentId);
      const pm = (parent?.classification_metadata ?? {}) as Record<string, unknown>;
      if (typeof pm.pending_outcome_verification === 'string' && (pm.pending_outcome_verification as string).length >= 7) return true;
    }
    return verifyGapCondition(g) === 'pending';
  });
  const targetOf = (g: Record<string, unknown>): string =>
    String(((g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>).edit_site ?? "(no-target)");
  // TRACED SELECTION DECISION (law 12: record the counterfactual AT decision time). Without
  // this line a 90-way tie at one score over one target file is invisible at every
  // observation point, which is why the sign error above survived beside its own comment.
  console.log(`[gap-to-feature] pick ${JSON.stringify({
    owner: process.env["SUBSTRATE_NAME"] ?? "substrate",
    gap_id: String(chosen.g.id ?? ""),
    category: String(chosen.g.category ?? ""),
    target: targetOf(chosen.g),
    score: Number(chosen.s.toFixed(4)),
    landability: Number(landabilityScore(chosen.g).toFixed(4)),
    human_reported: String(chosen.g.source ?? "") === "human_reported",
    impact: Number(impactOf(chosen.g).toFixed(4)),
    pool: selectionPool.length,
    hopeless_excluded: gaps.length - selectionPool.length,
    operator_hold_excluded: ranked.filter((r) => {
      const mm = ((r.g as { classification_metadata?: { operator_hold?: unknown } }).classification_metadata) ?? {};
      return ((mm.operator_hold as boolean | undefined) === true);
    }).length,
    skipped_pending: skippedPending,
    tied_at_top: ranked.filter((r) => Math.abs(r.s - chosen.s) < 1e-9).length,
    distinct_targets_top20: new Set(ranked.slice(0, 20).map((r) => targetOf(r.g))).size,
    runner_up: ranked[1] ? { gap_id: String(ranked[1].g.id ?? ""), target: targetOf(ranked[1].g), score: Number(ranked[1].s.toFixed(4)) } : null,
  })}`);

  // OPTION A: durable pickDecision record, one JSON line per pick (same pattern as
  // compose-lessons.jsonl). Fail-open: emission must never block or fail the pick.
  try {
    const pickClass = gapClassOf(chosen.g);
    const pickPost = classPosteriorsNow[pickClass] ?? { alpha: 1, beta: 1 };
    appendFileSync(PICK_DECISIONS_PATH, JSON.stringify({
      at: new Date().toISOString(),
      gap_id: String(chosen.g.id ?? ""),
      class: pickClass,
      theta_sampled: Number((classTheta.get(pickClass) ?? 0.5).toFixed(4)),
      alpha: pickPost.alpha,
      beta: pickPost.beta,
      score: Number(chosen.s.toFixed(4)),
      cooldown_state: { skipped_pending: skippedPending },
      pool: selectionPool.length,
      alternatives_top3: ranked.slice(0, 3).map((r) => ({ gap_id: String(r.g.id ?? ""), class: gapClassOf(r.g), score: Number(r.s.toFixed(4)) })),
    }) + "\n");
  } catch { /* observability, never control flow */ }
  // STAMP THE COUNTERFACTUAL AT THE MOMENT OF THE DECISION.
  //
  // The log line above already records WHY this gap was chosen (law 12). What it does not
  // record is the value of the gap's own falsifier BEFORE anything acts on it — and without
  // that, a later re-measurement can only say "the defect is absent now", which is
  // indistinguishable from a predicate that was inert all along. That indistinguishability is
  // how a false close is manufactured, and it looks exactly like success.
  //
  // Fire-and-forget on purpose: selection must not block on I/O, and losing a baseline costs a
  // later verdict of "inconclusive" — honest, and far cheaper than delaying every pick.
  //
  // Stamped to its own impulse rather than back onto the gap, because substrateGap_write
  // REPLACES rather than merges and a partial write erases live fields.
  void (async () => {
    try {
      const meta = (chosen.g.classification_metadata ?? {}) as Record<string, unknown>;
      const literal = typeof meta["hardcoded_url"] === "string" ? (meta["hardcoded_url"] as string) : "";
      const editSite = typeof meta["edit_site"] === "string" ? (meta["edit_site"] as string) : "";
      const { measureClass1, stampBaseline, stampEnvironmentBaseline } = await import("./causal-adjudication.js");
      const actionIdEnv = `pick-${String(chosen.g.id ?? "")}-${new Date().toISOString().slice(0, 16)}`;
      // EVERY pick gets an environment before-reading, not just the ~1% carrying a predicate.
      const envOutcome = await stampEnvironmentBaseline(String(chosen.g.id ?? ""), actionIdEnv);
      console.log(`[gap-to-feature] env-baseline ${envOutcome} for ${String(chosen.g.id ?? "")}`);
      const root = process.env["REPO_ROOT"] ?? process.env["WORKSPACE_ROOT"] ?? "/workspace/git/super-repo";
      if (!literal) return; // predicate baseline needs a Class-1 literal; the env one is already stamped
      const obs = await measureClass1(root, editSite, literal);
      const actionId = `pick-${String(chosen.g.id ?? "")}-${new Date().toISOString().slice(0, 13)}`;
      const outcome = await stampBaseline(String(chosen.g.id ?? ""), actionId, obs, "class1");
      console.log(
        `[gap-to-feature] baseline ${outcome} for ${String(chosen.g.id ?? "")} ` +
          `(present=${obs === null ? "unmeasurable" : obs.present})`,
      );
    } catch {
      /* never let counterfactual bookkeeping break selection */
    }
  })();

  return chosen.g;
}

const PICK_DECISIONS_PATH = "/workspace/proposals/pick-decisions.jsonl";
/**
 * The same principle, applied to SELECTION rather than to credit.
 *
 * `isNonAttemptComposeResult` above already keeps a compose that never ran out of
 * `failed_attempts` and out of the category calibration. The compose COOLDOWN was never
 * given the same treatment, and that asymmetry is the bug: the stamp is written at
 * PICK-START (`gapComposeLastAttemptAt.set` below, before feature_compose is called, so it
 * "covers the whole compose wall time"), and nothing clears it when the compose comes back
 * BUSY. So a capacity refusal — work the host declined to start — cost the gap a full
 * GAP_COMPOSE_COOLDOWN_MS of exclusion from the auto-pick candidate set.
 *
 * Measured 2026-08-29: the autonomous lane holds exactly one slot
 * (`compose-slots.ts` `effectiveCap = max(1, cap - 1)`, one reserved for directed work) and
 * composes run for minutes, so most autonomous picks return BUSY. One gap was picked at
 * 19:26:31.9 / 19:31:46.5 / 19:36:52.6 / 19:41:56.7 / 19:47:01.5 — deltas of 5:14.6, 5:06.1,
 * 5:04.1, 5:04.8, i.e. cooldown-limited to the second rather than tick-limited — and every
 * one of those picks logged `verdict=BUSY stage=capacity`. Zero composes ran. Meanwhile the
 * picker walked the ranked backlog cooling one gap after another that had never been tried,
 * so the highest-priority gap was repeatedly selected, repeatedly refused for capacity, and
 * repeatedly penalised in selection for a refusal it did not cause.
 *
 * Takes the map as a parameter so the behaviour is unit-testable without a live pool — the
 * same reason `chooseFirstActionable` was extracted with an injected predicate. Returns
 * whether a stamp was actually rewritten, so a caller (or a test) can assert the effect
 * rather than infer it.
 *
 * DELIBERATELY NOT DONE HERE: nothing touches `failed_attempts` or `updateCalibration`. That
 * accounting is already correct for a non-attempt and must stay untouched — this only
 * restores eligibility.
 *
 * REQUEUE, NOT RELEASE (2026-08-30). The first version of this DELETED the stamp, making the
 * gap instantly re-eligible. That over-corrected: this map is not only a penalty, it is the
 * ONLY rotation pressure in the picker (`eligible` filters on it at the auto-pick site), and
 * the autonomous lane holds exactly one slot, so BUSY is the majority outcome — 45 of ~80
 * composes (56%) in a 4h window measured by the compose-lane-capacity gap. Releasing on the
 * majority path therefore removes rotation pressure: the top-ranked gap is refused,
 * immediately re-admitted, and re-picked.
 *
 * MEASURED CONCENTRATION, corrected 2026-08-30. An earlier version of this note claimed 88%
 * (73 of 83 picks). That was WRONG — it counted each pick line's `runner_up.gap_id` as a
 * second pick, roughly doubling the top-gap tally. Counting only the primary gap_id, the
 * real trend over 2026-08-30 04:00-07:00 is a steady narrowing rather than a monopoly:
 *
 *     hour    picks   distinct gaps   top-gap share
 *     04:00     114        13              16%
 *     05:00     115        14              13%
 *     06:00     114        12              21%
 *     07:00      89         9              35%
 *
 * Distinct gaps per hour falling 13 -> 9 while the top share rises 16% -> 35% is the signal
 * this change targets. It is a real degradation and worth fixing; it is NOT the 88% monopoly
 * first reported, and the fix should be judged against these numbers.
 *
 * Both extremes starve the backlog, in opposite directions:
 *   - full cooldown on BUSY  → cools gaps that were never tried (the bug this function fixed)
 *   - no cooldown on BUSY    → the highest-ranked gap monopolises every tick
 * So a non-attempt costs a SHORT requeue instead: long enough for the picker to advance to
 * the next candidate, far short of penalising the gap for work the host declined to start.
 * REQUEUE_MS matches the 45s backoff goal-host already applies to a BUSY verdict, so the two
 * lanes wait the same amount for the same signal.
 */
export const GAP_BUSY_REQUEUE_MS = 45_000;

export function requeueAfterNonAttempt(
  stamps: Map<string, number>,
  gapId: string,
  cb: Record<string, unknown> | null | undefined,
  opts: { nowMs?: number; cooldownMs?: number; requeueMs?: number } = {},
): boolean {
  if (!isNonAttemptComposeResult(cb)) return false;
  if (!gapId) return false;
  if (!stamps.has(gapId)) return false;
  const now = opts.nowMs ?? Date.now();
  const cooldown = opts.cooldownMs ?? GAP_COMPOSE_COOLDOWN_MS;
  const requeue = opts.requeueMs ?? GAP_BUSY_REQUEUE_MS;
  // Backdate the stamp so the remaining exclusion is `requeue`, not the full cooldown. A
  // requeue >= cooldown must never EXTEND the exclusion, hence the clamp at 0.
  stamps.set(gapId, now - Math.max(0, cooldown - requeue));
  return true;
}

/**
 * The inputs a chronic escalation acts on, as one comparable string: the falsifier class, the edit site, the arming
 * state (composeEligibilitySkipReason) and the last attempt outcome (the newest failure lesson). Equal fingerprints
 * mean the escalation would act on the same state it already acted on.
 */
export function chronicEscalationFingerprint(row: Record<string, unknown>, why: string): string {
  const meta = (row.classification_metadata ?? row.metadata ?? {}) as Record<string, unknown>;
  const rawFalsifier = meta.falsifier as unknown;
  const falsifier = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
  const lessons = Array.isArray(meta.failure_lessons) ? meta.failure_lessons as Array<Record<string, unknown> | null> : [];
  const last = lessons[lessons.length - 1] ?? null;
  return JSON.stringify({
    why,
    falsifier,
    edit_site: gapEditSite(row, meta) ?? "",
    arming: composeEligibilitySkipReason(row) ?? "eligible",
    last_outcome: last ? [String(last.class ?? ""), String(last.reason ?? "").slice(0, 300), String(last.at ?? "")] : null,
  });
}

/**
 * ESCALATE A STUCK GAP: decomposition first, the free-text investigation walk only when no valid step could be
 * produced. Reached when a gap reaches the chronic-failure threshold, and when one region of a gap is refused
 * twice by the no-effect constraint (feature_compose). Reads the autonomous_pick lease and the spend envelope,
 * because it is autonomous spending even after a DIRECTED compose. Always journaled; returns what it did.
 */
export async function escalateToDecomposition(gap: Record<string, unknown>, why: string): Promise<string> {
  const parentId = String(gap.id ?? "");
  const parentSummary = String(gap.summary ?? gap.title ?? "");
  if (!parentId) return "not dispatched: no gap id";
  // The investigation walk is autonomous spending even when a DIRECTED compose (gap_id)
  // failed, and directed composes skip the pre-selection block, so this dispatch reads the
  // same autonomous_pick lease and spend envelope as auto-pick (value-per-cost-selection
  // 4.2: a siteless gap family was re-walked here 17 times an hour with autonomy held).
  let invHold = "";
  try {
    const { resolveMaintenanceLease } = await import("./maintenance-lease.js");
    const invLease = (await resolveMaintenanceLease({ type: "maintenanceLease", name: "autonomous_pick" })).body as { held?: boolean; holder?: string } | undefined;
    if (invLease?.held === true) invHold = "autonomous_pick lease held by " + String(invLease.holder);
  } catch { /* an unreadable lease fails open, as in the pre-selection block */ }
  const invEnvelope = invHold ? null : await spendEnvelopeAllows();
  if (invEnvelope && !invEnvelope.allow) invHold = "spend envelope " + invEnvelope.reason;
  if (invHold) {
    console.log(`[gap-to-feature] investigation of ${parentId} (${why}) NOT dispatched: ${invHold}`);
    return "not dispatched: " + invHold;
  }
  // ONE DECOMPOSITION PER GAP (gap_falsify: 606 decompositions on one gap). The STORED row decides, read fresh
  // here (a caller's copy predates any decomposition since). Already decomposed: never decomposed again; when that
  // decomposition wrote steps they stand and nothing is dispatched, otherwise only the investigation walk runs.
  const fresh = await readGapFresh(parentId);
  if (!fresh) {
    console.log(`[gap-to-feature] escalation of ${parentId} (${why}) NOT dispatched: the stored row could not be read`);
    return "not dispatched: the stored row could not be read";
  }
  const freshMeta = (fresh.classification_metadata ?? fresh.metadata ?? {}) as Record<string, unknown>;
  const decomposedAt = freshMeta.decomposed_at ? String(freshMeta.decomposed_at) : "";
  if (decomposedAt) {
    const prior = freshMeta.decomposition as { children?: unknown } | undefined;
    console.log(`[gap-to-feature] ${parentId} already decomposed at ${decomposedAt}; not decomposed again`);
    if (Array.isArray(prior?.children) && prior!.children.length > 0) return `not dispatched: already decomposed at ${decomposedAt}`;
  }
  // ONE ESCALATION PER STATE (gap-lane livelock, 2026-10-10). An escalation that writes no step changes nothing the
  // next tick reads, so the same inputs escalated again on every chronic tick (node1: 126 investigations of one gap
  // in 24 h). The stored row carries the fingerprint of the inputs it last escalated on (chronic_escalation); the
  // same fingerprint is not escalated again. Keyed on state, not on a clock: a changed falsifier, edit site, arming
  // state or a new attempt outcome escalates again. Stamped before the dispatch, as pwt_escalated is.
  const fingerprint = chronicEscalationFingerprint(fresh, why);
  const priorEscalation = freshMeta.chronic_escalation as { fingerprint?: unknown; at?: unknown } | undefined;
  if (priorEscalation && priorEscalation.fingerprint === fingerprint) {
    console.log(`[gap-to-feature] escalation of ${parentId} (${why}) NOT dispatched: inputs unchanged since the escalation at ${String(priorEscalation.at ?? "?")}`);
    return `not dispatched: inputs unchanged since the escalation at ${String(priorEscalation.at ?? "?")}`;
  }
  try { await persistGapMetaPatch(fresh, { chronic_escalation: { fingerprint, at: new Date().toISOString(), why } }); }
  catch (e) { console.warn(`[gap-to-feature] escalation stamp for ${parentId} not written: ${(e as Error).message}`); }
  console.log(`[gap-to-feature] escalating ${parentId} (${why}): ${decomposedAt ? "investigation (already decomposed, no step written)" : "decomposition, then investigation if no step is valid"}`);
  void (async () => {
    // DECOMPOSITION FIRST (contained-self-development 6.3): structured, falsifiable child steps;
    // the free-text investigation walk only when no valid step could be produced.
    if (!decomposedAt) {
      const decomp = await decomposeGap(gap).catch((e: unknown) => ({ written: [] as string[], reason: "decompose threw: " + String(e) }));
      if (decomp.written.length > 0) return;
    }
    await fetch(GOAL_HOST_VESSEL_ENDPOINT + "/run-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: "ApiKey " + METABOB_API_KEY } : {}) },
      body: JSON.stringify({
        goal: "investigate and decompose gap " + parentId + ": " + parentSummary.replace(/^(?:Close substrate gap [\w:.!-]+:\s*)+/, "").replace(/^(?:investigate and decompose (?:gap|goal)[:\s]+(?:[\w:.!-]+[:\s]+)?)+/i, "").slice(0, 400).replace(/^(.{400})$/s, (_m, t) => t.replace(/\s\S*$/, "")),
        tags: ["escalated_from:" + parentId],
      }),
    }).catch(() => { });
  })();
  return decomposedAt ? `dispatched: investigation (already decomposed at ${decomposedAt}, no step written)` : "dispatched: decomposition, then investigation";
}

export async function capacitySlices(gap: Record<string, unknown>): Promise<Array<{ file: string; hint: string }>> {
  try {
    const meta = (gap.classification_metadata as Record<string, unknown>) ?? {};
    if (!(Number(meta.failed_attempts) >= 2)) return [];
    const reportPath = `/workspace/proposals/${String(gap.id)}-compose-report.json`;
    let report: Record<string, unknown>;
    try {
      const raw = await readFile(reportPath, "utf8");
      report = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const semanticGate = report.semantic_gate as Record<string, unknown> | undefined;
    const verifyArr = report.verify as Array<Record<string, unknown>> | undefined;
    const firstVerifyOutput = verifyArr && verifyArr[0] ? String((verifyArr[0] as Record<string, unknown>).output ?? "") : "";
    const opCount = Number(report.op_count);
    const hasCapacityEvidence =
      opCount >= 20 ||
      (semanticGate !== undefined && semanticGate.addresses === false) ||
      firstVerifyOutput.includes("TS1005");
    if (!hasCapacityEvidence) return [];
    const candidates = new Set<string>();
    const suspected = String(meta.suspected_real_location ?? "");
    for (const tok of suspected.split(/[,\s]+/)) {
      if (tok.startsWith("repos/") && tok.endsWith(".ts")) candidates.add(tok);
    }
    const reason = semanticGate && typeof semanticGate.reason === "string" ? (semanticGate.reason as string) : "";
    if (reason) {
      const re = /repos\/[A-Za-z0-9_-]+\/src\/[A-Za-z0-9_./-]+[.]ts/g;
      const matches = reason.match(re);
      if (matches) for (const m of matches) candidates.add(m);
    }
    if (candidates.size < 2) return [];
    const hint = reason ? reason.slice(0, 160) : "";
    return Array.from(candidates).map((file) => ({ file, hint }));
  } catch {
    return [];
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY-GAP → AUTHOR_NEW_RESOLVER bridge (net-new producer authoring, 2026-06-30)
//
// A capability gap filed by goal-host's shape-graph walk (fileCapabilityGap;
// classification_metadata.kind === "capability_gap") names a missing OUTPUT SHAPE
// with no producer AND no live resolver to bridge. The two existing routes BOTH
// fail this case: the orphaned_capability route needs an EXISTING resolver, and
// feature_compose free-drafts a phantom vessel for net-new producers (see the note
// on the orphaned route). The substrate already HAS the right primitive —
// author_new_resolver (Seam ③) authors a net-new resolver end-to-end (impl + test
// new_files[], spliced config.ts/impulses.ts overwrite_files[]) as a patch_proposal
// that apply_proposal_as_patch → mitosis cutover stages, gates (tsc +
// check-shape-dispatch + bun test) and lands. This route CONNECTS the walk's native
// recognition to that primitive, closing the whole class of missing-producer gaps
// autonomously rather than per-shape operator authoring (the S1→S2 unlock).
// ─────────────────────────────────────────────────────────────────────────────

/** camelCase / PascalCase shape → snake_case resolver name (the form
 *  author_new_resolver requires: /^[a-z][a-z0-9_]*$/). */
function shapeToResolverName(shape: string): string {
  return shape
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * DEAD (2026-07-01): no longer called. The capability-gap route now goes through
 * feature_compose (which drafts + verifies + repairs the whole resolver), retiring this
 * single-shot, unverified body-drafter that had no typecheck backstop. Kept only to avoid
 * a large template-literal delete mid-session; safe to remove wholesale in a follow-up.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function draftResolverImplBody(shape: string, goalText: string): Promise<string | null> {
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(6000),
    });
    if (!dr.ok) return null;
    const dd = (await dr.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> } };
    const best = (dd.content?.vessels ?? [])[0];
    if (!best) return null;
    const ep0 = best.resolve_endpoint ?? "/resolve";
    const endpoint = ep0.startsWith("http") ? ep0 : `${best.endpoint.replace(/\/$/, "")}${ep0.startsWith("/") ? ep0 : `/${ep0}`}`;
    const prompt =
      `Write the BODY (statements only — NO function signature, NO import lines, NO markdown fences) of an async TypeScript resolver that PRODUCES the impulse shape "${shape}".\n\n` +
      `WHAT IT MUST COMPUTE:\n${goalText}\n\n` +
      `CONTRACT:\n` +
      `- The body is wrapped as: export async function resolve...(pointer): Promise<ResolverResult> { <YOUR BODY> }\n` +
      `- It MUST end by returning { shape: "${shape}", body: <the computed report object> }.\n` +
      `- On any error, return { shape: "${shape}", body: { error: String(e) } } — never throw.\n` +
      `- ONLY GLOBALS are available: fetch, process.env, AbortSignal, JSON, Math, Date is NOT available for deterministic runs — avoid Date.now()/new Date(); if you need a timestamp read it from data you fetch.\n` +
      `- Read substrate data IDIOMATICALLY. Header on every call: Authorization: \`ApiKey \${process.env.METABOB_API_KEY}\`, Content-Type application/json, AbortSignal.timeout(20000). Tolerate non-OK/timeout gracefully (never throw). Available reads (USE THESE EXACT PATHS — do NOT invent paths like /traces or /activities):\n` +
      `    • activity-api = (process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080"):\n` +
      `        GET  {activity-api}/v2/activities/templates?limit=100      → { templates: [{ id, metrics:{ thompson_alpha, thompson_beta, success_rate }, output_shapes, ... }] }\n` +
      `        GET  {activity-api}/v2/activities/composition/graph?limit=200 → composition edges (producer→consumer shape flow)\n` +
      `        POST {activity-api}/v2/impulses/resolve  body { impulse:{ pointer:{ type:<readShape>, ...filters } } } → { content/body } (read shapes: activityMetrics, executionTraceList, compositionSuccess — each needs shape-specific filter fields; prefer the GET endpoints above when they suffice)\n` +
      `    • dev-vessel = (process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090"):\n` +
      `        POST {dev-vessel}/v2/impulses/resolve body { impulse:{ pointer:{ type:"substrateGap", status:"open", limit:200 } } } → { body:{ gaps:[...] } } (for unsatisfied-shape / closure demand)\n` +
      `- The producer MUST read REAL data from the correct endpoint above and aggregate it — a producer that returns hardcoded/empty data without fetching is a HOLLOW producer and will be rejected by the goal-reach gate.\n\n` +
      `STRICT TYPESCRIPT — the file is typechecked with strict:true + noUncheckedIndexedAccess:true. Follow these rules EXACTLY or it will NOT compile:\n` +
      `  • The wrapper signature is \`(pointer): Promise<ResolverResult>\` where pointer is typed \`{ type: string; [key: string]: unknown }\`. To read a pointer field, access it then coerce — NEVER cast the pointer to a shape. RIGHT: \`const limit = Number((pointer as Record<string, unknown>).limit ?? 100);\`  WRONG: \`pointer as { limit: number }\` (TS2352).\n` +
      `  • Type ALL fetched JSON as \`any\`: \`const data = (await res.json()) as any;\`. Then narrow arrays defensively: \`const rows: any[] = Array.isArray(data?.templates) ? data.templates : [];\`.\n` +
      `  • noUncheckedIndexedAccess: array/object index access is \`T | undefined\`. NEVER use \`!\` non-null assertions. Guard every access with \`?.\` and \`?? default\`, or iterate with \`for (const r of rows)\` where r is \`any\`.\n` +
      `  • Do NOT import anything (only \`ResolverResult\` is imported by the wrapper). Use only globals.\n\n` +
      `COMPILING SKELETON — adapt this exact structure (it compiles under the strict config); fill in the aggregation for THIS shape:\n` +
      `  const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";\n` +
      `  const apiKey = process.env.METABOB_API_KEY ?? "";\n` +
      `  const limit = Number((pointer as Record<string, unknown>).limit ?? 100);\n` +
      `  try {\n` +
      `    const res = await fetch(\`\${endpoint}/v2/activities/templates?limit=\${limit}\`, { headers: { Authorization: \`ApiKey \${apiKey}\`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000) });\n` +
      `    if (!res.ok) return { shape: ${JSON.stringify(shape)}, body: { error: \`http \${res.status}\` } };\n` +
      `    const data = (await res.json()) as any;\n` +
      `    const rows: any[] = Array.isArray(data?.templates) ? data.templates : [];\n` +
      `    // ... aggregate rows per the spec into \`report\` ...\n` +
      `    return { shape: ${JSON.stringify(shape)}, body: { count: rows.length, /* real aggregated fields */ } };\n` +
      `  } catch (e) {\n` +
      `    return { shape: ${JSON.stringify(shape)}, body: { error: String(e) } };\n` +
      `  }\n\n` +
      `Respond with ONLY the function-body statements (no signature, no imports, no fences).`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: "llm_completion", prompt, model: "auto", max_tokens: 2200 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: string; data?: string };
    let body = String(j.content ?? j.data ?? "").trim();
    if (!body) return null;
    // Strip accidental code fences.
    body = body.replace(/^```(?:ts|typescript)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    // Only unwrap a leaked FULL function: strip the signature AND its matching
    // closing brace together. Stripping a trailing `}` unconditionally corrupts a
    // statements-only body (the common case) that legitimately ends in `}` (e.g.
    // a closing try/catch or returned object literal) → brace imbalance → tsc fails.
    const sig = body.match(/^export\s+async\s+function[^{]*\{\s*/i);
    if (sig) {
      body = body.slice(sig[0].length).replace(/\}\s*$/, "").trim();
    }
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/**
 * Route a WALK-DEMANDED capability gap (missing producer for a shape a real goal
 * needed) to feature_compose, which authors a NEW resolver AND verifies+repairs it
 * (its typecheck + shape-dispatch-check gates enforce the three-place wiring) before
 * landing via cutover. Two operator constraints (2026-07-01) shape this:
 *   • JUSTIFY THE SPEND — author only when the capability_gap carries a `goal` (real
 *     walk demand). No goal ⇒ no demand ⇒ skip (reuse-before-mint; don't mint a
 *     producer nothing consumes).
 *   • FOLLOW THE PATTERN — reuse feature_compose's tested verify+repair loop rather
 *     than the prior single-shot draftResolverImplBody→author_new_resolver path, which
 *     had no verify backstop and stalled the whole route (0 lands / pending-mitosis
 *     churn; see finding_2026_07_01_capability_gap_route_stalls).
 * Target vessel defaults to development-vessel (the introspection meta-vessel); a gap
 * may override via classification_metadata.target_vessel.
 */
async function routeCapabilityGapToNewResolver(
  gap: Record<string, unknown>,
  missingShape: string,
  meta: Record<string, unknown>,
  pointer: GapToFeaturePointer,
  decisionId?: string,
): Promise<ResolverResult> {
  const targetVessel = typeof meta.target_vessel === "string" ? meta.target_vessel.trim() : "";
  // Validate target_vessel against the runtime root (module-level vesselDirExists, absolute
  // path); fall back to development-vessel when the named vessel does not exist.
  const vessel = targetVessel && vesselDirExists(targetVessel) ? targetVessel : "development-vessel";
  const resolverName = shapeToResolverName(missingShape);
  if (!/^[a-z][a-z0-9_]*$/.test(resolverName)) {
    return { shape: "gapToFeatureReport", body: { ok: false, route: "author_new_resolver", gap_id: gap.id, error: `cannot derive snake_case resolver name from shape "${missingShape}"` } };
  }
  const goalText = String(meta.goal ?? gap.summary ?? `produce the ${missingShape} shape`);

  // JUSTIFY THE SPEND (operator 2026-07-01): author a NEW resolver ONLY for a
  // WALK-DEMANDED capability gap — fileCapabilityGap sets `goal` precisely because a
  // real goal needed the shape with no producer. No goal = no demand = don't spend the
  // (expensive) author+verify+cutover time on a producer nothing consumes (reuse-before-
  // mint; minting an unconsumed producer raises ρ_grow for zero λ₁ gain).
  if (!String(meta.goal ?? "").trim()) {
    return { shape: "gapToFeatureReport", body: {
      ok: false, route: "capability_gap_skipped", gap_id: gap.id, shape: missingShape,
      reason: "no walk demand (capability_gap carries no goal) — not worth authoring a resolver (reuse-before-mint)",
    } };
  }


  const kebab = resolverName.replace(/_/g, "-");
  // FOLLOW THE PATTERN (operator 2026-07-01): route through feature_compose, whose
  // verify+repair loop is the tested backstop (its typecheck + shape-dispatch-check
  // gates enforce the three-place wiring). The prior single-shot draftResolverImplBody
  // → author_new_resolver path had NO verify backstop, so it staged un-typechecked code
  // that mitosis-cutover then rejected (0 lands / pending-mitosis churn — see
  // finding_2026_07_01_capability_gap_route_stalls). Reuse the existing tested machinery
  // instead of a one-off.
  const spec = [
    `MISSING PRODUCER for impulse shape "${missingShape}": a real goal needed it and no resolver produces it. AUTHOR A NEW RESOLVER in repos/${vessel} (this is a CREATE, not a surgical edit):`,
    `1. Create src/resolvers/${kebab}.ts exporting an async resolver \`(pointer): Promise<ResolverResult>\` that reads REAL substrate data and returns { shape: "${missingShape}", body: <computed report> }. It MUST fetch + aggregate real data — a hollow stub is rejected by the goal-reach gate.`,
    `2. WIRE IT THREE-PLACE in the SAME change (or the shape-dispatch-check fails the verify gate): add "${missingShape}" to the discovery.shapes array in src/config.ts; add \`case "${missingShape}":\` dispatching the new resolver before default: in src/routes/impulses.ts (with its import from "../resolvers/${kebab}.js"); add a per-resolver test test/resolvers/${kebab}.test.ts.`,
    `3. STRICT TS (strict + noUncheckedIndexedAccess): import only ResolverResult; use only globals (fetch, process.env, AbortSignal, JSON, Math — Date.now() is unavailable); type fetched JSON as any; guard every index access with ?./?? ; never use non-null !.`,
    `The goal that needs this shape (this is why the spend is justified): ${goalText}`,
  ].join("\n");

  // Pick-time condition verification: if the gap condition no longer holds,
  // close as already_resolved and skip composing.
  const pickConditionCheck = verifyGapCondition(gap as Record<string, unknown>);
  if (pickConditionCheck === 'absent') {
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} condition absent at pick time — closing as already_resolved`);
    try {
      const arMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution: 'already_resolved', closed_reason: 'already_resolved', closed_by: 'gap_to_feature.pick_condition_check', closed_at: new Date().toISOString() };
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: String(gap.id ?? ''),
          category: gap.category,
          source: gap.source,
          summary: gap.summary,
          detected_at: gap.detected_at,
          classification_metadata: arMeta,
          status: "closed",
        },
      } as never);
    } catch (writeErr) {
      console.log(`[gap-to-feature] already_resolved write failed: ${(writeErr as Error).message}`);
    }
    return { shape: "gapToFeatureReport", body: { ok: true, gap_id: gap.id, gap_category: gap.category, verdict: "already_resolved", note: "gap condition absent at pick time — closed as already_resolved" } };
  }
  if (pickConditionCheck === 'pending') {
    // A single non-reverted landing already exists for this gap (provenance), but the close-oracle
    // cannot MEASURE that it resolved the condition. Do NOT re-compose: a second landing would read
    // as a re-land and manufacture the false-close the oracle is calibrated against (§12.6 step 1).
    // The pending-verify sweep + human escalation own this gap now; skip composing.
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} PENDING verification at pick time (landed once, unmeasured) — skipping re-compose to avoid a manufactured re-land`);
    await markPendingVerification(gap, undefined, "pending at pick time: landed once, no measurement predicate — persisted so the candidate filter can exclude it");
    return { shape: "gapToFeatureReport", body: { ok: true, gap_id: gap.id, gap_category: gap.category, verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" } };
  }

  const isDirected = (pointer as { directed?: boolean }).directed === true;
  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    verify_vessels: [`repos/${vessel}`],
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    keep_on_fail: false,
    directed: isDirected,
    ...(decisionId ? { decision_id: decisionId } : {}),
    gap: {
      id: String(gap.id ?? ""),
      summary: String(gap.summary ?? gap.title ?? ""),
      classification_metadata: { ...meta, directed: isDirected },
      category: String(gap.category ?? ""),
    },
    land: !(pointer.dry_run ?? false),
  });
  await recordLineageSpend(String(gap.id ?? ""), compose.body, pointer.dry_run ?? false);
  const cb = (compose.body ?? {}) as Record<string, unknown>;
  try {
    const reachId = typeof cb["execution_id"] === "string" ? (cb["execution_id"] as string) : "";
    if (reachId.length > 0) {
      const reachEndpoint = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
      const reachKey = process.env["METABOB_API_KEY"] ?? "";
      void fetch(`${reachEndpoint}/v2/activities/execution-traces/reach`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(reachKey ? { Authorization: `ApiKey ${reachKey}` } : {}) },
        body: JSON.stringify({ execution_id: reachId, reached: cb["ok"] === true }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => { /* grading must never affect the compose result */ });
    }
  } catch { /* verdict delivery is best effort */ }

  if (pointer.dry_run) {
    return { shape: "gapToFeatureReport", body: {
      ok: cb.ok !== false, route: "capability_gap_via_feature_compose", verdict: "plan",
      gap_id: gap.id, gap_category: gap.category, target_vessel: vessel,
      resolver_name: resolverName, shape: missingShape, compose: cb,
      note: `plan: would author + VERIFY (feature_compose repair loop) a resolver producing "${missingShape}" in ${vessel} and land via cutover`,
    } };
  }

  // CLOSE-ON-LAND: only when feature_compose GENUINELY landed on origin/dev; otherwise
  // deprioritise so the picker advances (mirrors the main gap_to_feature flow).
  const { land, closed } = await gradeCapabilityCompose(gap, cb, decisionId, { ask: askHuman, escalate: escalateToDecomposition });
  // ...and a retry must be RETRYABLE: release the cooldown the pick stamped, or the "retry"
  // is a five-minute exclusion for a compose that never ran.
  requeueAfterNonAttempt(gapComposeLastAttemptAt, String(gap.id ?? ""), cb);
  return {
    shape: "gapToFeatureReport",
    body: {
      ok: land.landed, route: "capability_gap_via_feature_compose",
      gap_id: gap.id, gap_category: gap.category, target_vessel: vessel,
      resolver_name: resolverName, shape: missingShape,
      verdict: cb.verdict ?? null, landed: land.landed, landed_commit: land.commit_sha ?? null,
      gap_closed: closed, compose: cb,
      note: land.landed
        ? `authored + VERIFIED a new resolver producing "${missingShape}" (feature_compose verify+repair) and landed via cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}`
        : `feature_compose could not land a verified resolver for "${missingShape}" (verdict ${String(cb.verdict)}) — gap deprioritised, picker advances`,
    },
  };
}

import { sweepAttempts } from "./attempt-register.js";

let attemptSweepInFlight = false;
let scopeApplyInFlight = false;

// LLM-AVAILABILITY PROBE (value-per-cost-selection 2.4). With no llm_completion producer
// advertised every compose fails after taking a slot. Absent only when discovery answers OK
// with an empty producer list; an unreachable or malformed answer is unknown (null) and
// fails open like the capacity peek. Cached for LLM_PROBE_TTL_MS either way.
const LLM_PROBE_TTL_MS = 60_000;
let llmProbeCache: { at: number; available: boolean | null } | null = null;
async function llmProducerAdvertised(): Promise<boolean | null> {
  if (llmProbeCache && Date.now() - llmProbeCache.at < LLM_PROBE_TTL_MS) return llmProbeCache.available;
  let available: boolean | null = null;
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "llm_completion" } }),
      signal: AbortSignal.timeout(3000),
    });
    if (dr.ok) {
      const dd = (await dr.json()) as { content?: { vessels?: unknown } };
      const vessels = dd.content?.vessels;
      if (Array.isArray(vessels)) available = vessels.length > 0;
    }
  } catch { available = null; }
  llmProbeCache = { at: Date.now(), available };
  return available;
}

export async function resolveGapToFeature(pointer: GapToFeaturePointer): Promise<ResolverResult> {
  const attempt: { id?: string; gap?: Record<string, unknown>; inFlightGapId?: string } = {};
  let result: ResolverResult;
  try {
    result = await resolveGapToFeatureOnce(pointer, attempt);
  } catch (err) {
    if (attempt.id && attempt.gap) recordAttemptEnd(attempt.id, attempt.gap, null, err);
    throw err;
  } finally {
    if (attempt.inFlightGapId) endComposeInFlight(attempt.inFlightGapId);
  }
  if (attempt.id && attempt.gap) recordAttemptEnd(attempt.id, attempt.gap, result as { shape?: string; body?: unknown });
  return result;
}

async function resolveGapToFeatureOnce(pointer: GapToFeaturePointer, attempt: { id?: string; gap?: Record<string, unknown>; inFlightGapId?: string }): Promise<ResolverResult> {
  // For testing purposes, expose the map.
  (resolveGapToFeature as any).__test__gapComposeLastAttemptAt = () => gapComposeLastAttemptAt;
  // DECOMPOSE ON REQUEST (contained-self-development 6.3): run the decomposition contract for one
  // named gap and report what it wrote, so the step can be falsified directly.
  const decomposeId = (pointer as { decompose_gap_id?: string }).decompose_gap_id;
  if (typeof decomposeId === "string" && decomposeId) {
    const read = await resolveSubstrateGap({ type: "substrateGap", id: decomposeId } as never);
    const found = ((read as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps ?? []).find((g) => String(g.id) === decomposeId);
    if (!found) return { shape: "gapToFeatureReport", body: { ok: false, stage: "decompose", error: "gap not found: " + decomposeId } };
    const d = await decomposeGap(found, { directed: (pointer as { directed?: boolean }).directed === true });
    return { shape: "gapToFeatureReport", body: { ok: d.written.length > 0, stage: "decompose", gap_id: decomposeId, children: d.written, reason: d.reason } };
  }
  // 0-. AUTO-REVERT CATCH-UP, before the clone-heads fingerprint: a #1 regressed settlement from the attempt
  // sweep moves no HEAD, so behind the fingerprint it would wait for an unrelated landing. Not awaited.
  kickAutoRevert("tick");
  // 0. Land→close continuity: complete deferred self-cutover closures BEFORE selection,
  // so an already-landed gap cannot be re-picked and re-landed. Cheap, bounded, best-effort.
  await sweepIfCloneHeadsMoved({ ask: askHuman });
  // Causal attempt ledger: outcomes and settlements for registered landings. Started without
  // awaiting (snapshots can take tens of seconds) and guarded so sweeps never overlap.
  if (!attemptSweepInFlight) {
    attemptSweepInFlight = true;
    void sweepAttempts()
      .then((r) => { if (r.outcomes_written || r.settlements_written || r.errors.length) console.log(`[attempt-sweep] outcomes=${r.outcomes_written} settlements=${r.settlements_written} lessons=${r.lessons_written} errors=${r.errors.length}${r.errors.length ? " first=" + r.errors[0] : ""}`); })
      .catch((e) => console.error(`[attempt-sweep] failed: ${(e as Error).message}`))
      .finally(() => { attemptSweepInFlight = false; });
  }
  // 0a. THE ACCEPTED EVALUATOR OF SCOPE PROPOSALS (scope earn-in, REALIGNMENT §7 step 9). Beside the landing sweep:
  // the deployed code re-derives each autonomyScopeProposal's evidence itself and only then changes autonomyScope
  // (scope-earn-in.ts applyScopeProposals). Not awaited (a mutation run takes minutes) and never overlapping.
  if (!scopeApplyInFlight) {
    scopeApplyInFlight = true;
    void import("./scope-earn-in.js")
      .then((m) => m.applyScopeProposals())
      .then((r) => { if (r.applied.length || r.refused.length) console.log(`[scope-earn-in] applied=${JSON.stringify(r.applied.map((a) => `${a.change}:${a.path}`))} refused=${JSON.stringify(r.refused).slice(0, 400)}`); })
      .catch((e) => console.error(`[scope-earn-in] evaluator failed: ${(e as Error).message}`))
      .finally(() => { scopeApplyInFlight = false; });
  }
  // 0b. ASK FOR CAPACITY BEFORE PAYING FOR SELECTION (2026-08-31).
  //
  // The order used to be backwards: pick a gap, then discover the compose lane is full.
  // Selection is the expensive half — it reads the whole gap store and
  // `admitActionableGaps` shells a BLOCKING `bun run typecheck` per vessel (bounded at
  // TYPECHECK_MAX_RUNS_PER_PASS, TTL-cached, but real). Measured over 48h: 4482 picks,
  // 3699 of them (82.5%) ending `verdict=BUSY stage=capacity`. Every one of those paid
  // full selection price for a result the lane had nowhere to put.
  //
  // Safe because it cannot cost a landing: a pick that ended BUSY never composed. It
  // removes cost, not work.
  //
  // AFTER the sweep deliberately — the sweep is what CLOSES gaps, and it must keep
  // running on every tick, including the ones that skip selection.
  //
  // 0a. AUTONOMOUS-PICK LEASE. A coordinated window (a graded run, a measurement window)
  // holds the named maintenanceLease "autonomous_pick"; while it is held, auto-picks do not
  // select. Every in-process trigger (gap-write nudge, gap-drain-observer, interruption
  // sweep, the pick after each restart) reaches selection through this branch, so one read
  // here covers them all; masking gap-compose.service did not. Directed pointers (gap_id or
  // category) are unaffected. An unreadable lease fails open, like the capacity peek below,
  // and the lease TTL (max 1 h) releases a hold whose keeper died.
  if (!pointer.gap_id && !pointer.category) {
    try {
      const { resolveMaintenanceLease } = await import("./maintenance-lease.js");
      const lease = await resolveMaintenanceLease({ type: "maintenanceLease", name: "autonomous_pick" });
      const lb = lease.body as { held?: boolean; holder?: string; expires_at?: string } | undefined;
      if (lb?.held === true) {
        console.log(`[gap-to-feature] selection skipped: autonomous_pick lease held by ${lb.holder} until ${lb.expires_at}`);
        return {
          shape: "gapToFeatureReport",
          body: {
            ok: false,
            stage: "lease",
            verdict: "BUSY",
            error: `autonomous_pick lease held by ${lb.holder}`,
            lease_holder: lb.holder,
            lease_expires_at: lb.expires_at,
            skipped_selection: true,
          },
        };
      }
    } catch (err) {
      console.warn(`[gap-to-feature] autonomous_pick lease read failed; proceeding: ${String(err)}`);
    }
  }

  // AUTO-PICKS ONLY. A pointer naming a gap or a category was explicitly asked for by a
  // caller and behaves exactly as before (same carve-out as the cooldown filter and the
  // admission gate). A null peek means capacity is unobservable → FAIL OPEN and select,
  // matching compose-slots' own contract.
  // The envelope this auto-pick admitted under; its lineage ceiling (4.5) holds lineages below.
  let pickEnvelope: SpendEnvelopeVerdict | null = null;
  if (!pointer.gap_id && !pointer.category) {
    const capacity = await peekComposeCapacity();
    if (capacity && !hasFreeComposeCapacity(capacity)) {
      // Log the SKIP explicitly. A cost fix whose only evidence is the absence of the
      // old line is unmeasurable, and "nothing happened" is exactly the signal this
      // codebase has repeatedly mistaken for health.
      console.log(`[gap-to-feature] selection skipped: compose lane full live=${capacity.live} cap=${capacity.cap}`);
      // BUSY/capacity-shaped so `isNonAttemptComposeResult` and the caller's existing
      // 45s backoff classify it exactly as the refusal it replaces. This changes cost,
      // not cadence. No gap was picked, so no cooldown is stamped and no credit moves.
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: false,
          stage: "capacity",
          verdict: "BUSY",
          error: "compose lane full — selection skipped",
          observed: capacity.live,
          cap: capacity.cap,
          skipped_selection: true,
        },
      };
    }
    if ((await llmProducerAdvertised()) === false) {
      console.log(`[gap-to-feature] selection skipped: llm_unavailable (no llm_completion producer advertised)`);
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: false,
          stage: "capacity",
          verdict: "BUSY",
          error: "llm_unavailable: no llm_completion producer advertised — selection skipped",
          reason: "llm_unavailable",
          skipped_selection: true,
        },
      };
    }
    // SPEND ENVELOPE (value-per-cost-selection 4.2): exhausted, paused or unreadable means no
    // auto-pick. BUSY-shaped so isNonAttemptComposeResult classifies it as a non-attempt: no
    // gap is picked, no cooldown is stamped, no credit moves.
    const envelope = await spendEnvelopeAllows();
    if (!envelope.allow) {
      console.log(`[gap-to-feature] selection skipped: spend envelope ${envelope.reason}`);
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: false,
          stage: "budget",
          verdict: "BUSY",
          error: "spend envelope: " + envelope.reason + " (selection skipped)",
          reason: envelope.absent ? "budget_absent" : envelope.unreadable ? "budget_unreadable" : envelope.paused ? "budget_paused" : envelope.node_share_exhausted ? "budget_node_share" : "budget_exhausted",
          cap_usd: envelope.cap_usd ?? null,
          spent_usd: envelope.spent_usd ?? null,
          ...(envelope.node_share_exhausted ? { own_spent_usd: envelope.own_spent_usd ?? null, max_node_share: envelope.max_node_share ?? null } : {}),
          skipped_selection: true,
        },
      };
    }
    pickEnvelope = envelope;
  }
  // 1. Select a gap — landability-ranked when auto-picking (not arbitrary gaps[0]).
  let gap: Record<string, unknown> | null = null;
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      // Targeted dispatch: pass the id straight to the read so a SPECIFIC gap is
      // fetched directly. Without this, selection read a limit-25 window and did
      // gaps.find(id) on it — a buried gap (store has 1000+) was never found and
      // the resolver returned "no matching open gap" for a gap that plainly exists.
      ...(pointer.gap_id ? { id: pointer.gap_id } : {}),
      ...(pointer.category ? { category: pointer.category } : {}),
      status: "open",
      // Exclude goal-host auto_draft_* decision-log noise BEFORE the limit slice
      // so the actionable window is never starved by per-dispatch log entries.
      // (Log rows stay in the store; an explicit category/id query reads them.)
      exclude_categories: (pointer.category || pointer.gap_id) ? [] : [...DECISION_LOG_GAP_CATEGORIES],
      // Read the FULL real backlog, not a recency window. The read sorts by
      // updated_at DESC then slices; a small limit (was 25) silently DROPPED aged
      // gaps before pickMostLandable ever scored them — so a one-time operator- or
      // human-filed gap (obsidian DEVELOP request, an architectural gap) that isn't
      // continuously re-emitted by a detector AGED OUT of the window and was never
      // worked, however landable. With the decision-log noise already excluded the
      // real backlog is a few hundred gaps (all in memory via loadGaps), so scoring
      // them all per run is cheap; landability then governs the WHOLE backlog and
      // failed_attempts culls repeat-failers, so nothing high-value is starved by
      // age. This makes the human/operator-request channel reliable. (2026-07-01)
      // NO CONSTANT CAP (2026-09-29). 1000 assumed the backlog stays small; at 1838 open gaps the
      // window ended at 09-23 and aged operator gaps starved again (b11c6fb's class, recurring).
      // Any number that encodes a backlog size recurs when the store grows, so read it all.
      limit: pointer.limit ?? Number.MAX_SAFE_INTEGER,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    // Exclude gaps composed within the cooldown from AUTO-pick (per-candidate filter, exactly
    // boredom's cooling-candidate skip) so the picker advances to the next-landable gap. Targeted
    // picks (pointer.gap_id) BYPASS — the caller explicitly chose this gap (same carve-out as the
    // goal-host coalesce skipping requeues, and boredom not throttling explicit requests).
    const nowMs = Date.now();
    // Two independent brakes, both AUTO-pick only. The in-process cooldown covers the
    // wall time of a compose that may still be running; the durable per-gap backoff
    // slows a gap that keeps FAILING. Neither subsumes the other: the map is cleared by
    // every restart (and cutovers restart this vessel several times a day), and
    // `last_failed_at` says nothing about a compose currently in flight.
    let backoffExcluded = 0;
    let deepestLineage = 0;
    // LINEAGE CAP. A recommit-* gap is a retry minted from a failed compose; each retry gets
    // a fresh id, so per-gap checks and the time-based backoff never see that the lineage keeps
    // failing. Measured 2026-09-25/26: recommit-* took 92 of 200 picks (46%) and landed 4
    // (2 distinct gaps), with lineages carrying 14-18 failed attempts, while roots convert
    // near 27%. Past the cap a recommit waits for a new root attempt instead of being re-picked.
    const RECOMMIT_LINEAGE_ATTEMPT_CAP = 6;
    let lineageCapped = 0;
    let lineageSpendCapped = 0;
    // Index the candidate set once so the backoff can walk parent_gap_id / source_gap_id
    // chains without re-scanning per gap.
    const gapsById = new Map<string, Record<string, unknown>>();
    for (const g of gaps) { const id = String(g.id ?? ""); if (id) gapsById.set(id, g); }
    // One live gap per (lineage, check): read over the whole open set, so a holder cooling down still holds.
    const predicateHolds = pointer.gap_id ? new Map<string, string>() : inheritedPredicateHolds(gaps);
    const heldLines: string[] = [];
    const inFlightLines: string[] = [];
    const eligible = gaps.filter((g) => {
      const holder = predicateHolds.get(String(g.id ?? ""));
      if (holder) { heldLines.push(`${String(g.id)}: predicate held by ${holder}`); return false; }
      if (composeInFlight(String(g.id ?? ""))) { inFlightLines.push(String(g.id)); return false; }
      if (nowMs - (gapComposeLastAttemptAt.get(String(g.id ?? "")) ?? 0) < GAP_COMPOSE_COOLDOWN_MS) return false;
      const siteKey = String(((g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>).edit_site ?? "");
      if (siteKey && String(g.source ?? "") !== "human_reported" && nowMs - (siteComposeLastAttemptAt.get(siteKey) ?? 0) < SITE_COMPOSE_COOLDOWN_MS) return false;
      const state = lineageBackoffState(g, gapsById);
      if (String(g.id ?? "").startsWith("recommit-") && state.attempts >= RECOMMIT_LINEAGE_ATTEMPT_CAP) {
        lineageCapped++;
        return false;
      }
      // LINEAGE SPEND CEILING (4.5): roots and children alike, read from the envelope this pick admitted under.
      if (lineageSpendHeld(g, gapsById, nowMs, pickEnvelope)) {
        lineageSpendCapped++;
        return false;
      }
      if (gapIsBackedOff(g, nowMs, state)) {
        backoffExcluded++;
        if (state.depth > deepestLineage) deepestLineage = state.depth;
        return false;
      }
      return true;
    });
    // Emit the exclusion COUNT, not just its effect. A brake whose only evidence is
    // "fewer picks happened" is indistinguishable from a lane that has gone quiet for
    // some other reason — which is the confusion this codebase keeps paying for.
    if (inFlightLines.length > 0) console.log(`[gap-to-feature] compose in flight excluded ${inFlightLines.length} gap(s) from the auto-pick: ${inFlightLines.slice(0, 5).join(", ")}`);
    if (heldLines.length > 0) console.log(`[gap-to-feature] predicate hold excluded ${heldLines.length} gap(s): ${heldLines.slice(0, 5).join("; ")}`);
    if (lineageCapped > 0) {
      console.log(`[gap-to-feature] lineage cap excluded ${lineageCapped} recommit gap(s) (lineage failed_attempts >= ${RECOMMIT_LINEAGE_ATTEMPT_CAP})`);
    }
    if (lineageSpendCapped > 0) {
      console.log(`[gap-to-feature] lineage spend ceiling held ${lineageSpendCapped} gap(s) (lineage spent >= ${pickEnvelope?.lineage_usd_cap} USD in ${Math.round((pickEnvelope?.lineage_window_ms ?? 3_600_000) / 1000)}s without landing)`);
    }
    if (backoffExcluded > 0) {
      console.log(`[gap-to-feature] backoff excluded ${backoffExcluded} of ${gaps.length} gaps (eligible=${eligible.length}, deepest_lineage=${deepestLineage})`);
    }
    if (pointer.gap_id) {
      // Targeted dispatch BYPASSES the admission gate — the caller explicitly chose this gap
      // (same carve-out as the cooldown filter and boredom not throttling explicit requests).
      gap = gaps.find((g) => g.id === pointer.gap_id) ?? gaps[0] ?? null;
    } else {
      // ACTIONABILITY ADMISSION (auto-pick only): keep structurally-unclosable candidates
      // (no-producer orphans; phantom typecheck gaps whose error is already fixed) OUT of the
      // auto-pick set so they stop hollowing dispatches and starving the proven-landable path.
      const { admitted } = await admitActionableGaps(eligible);
      // Empty admitted (whole pool non-actionable — the common all-orphan case) → null,
      // which flows to the graceful "no matching open gap" path, not pickMostLandable([])'s throw.
      if (admitted.length) await refreshHeldCalibration();
      pickLineageIndex = gapsById;
      gap = admitted.length ? pickMostLandable(admitted) : null;
    }
  } catch (e) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: (e as Error).message } };
  }
  if (!gap) {
    return { shape: "gapToFeatureReport", body: { ok: false, stage: "select", error: "no matching open gap", category: pointer.category ?? null } };
  }
  // ADMISSION FOR THE TARGETED ENTRY: the auto-pick branch ran admitActionableGaps above; a targeted autonomous
  // dispatch runs the same exclusion here, before any decision, cooldown or in-flight mark.
  {
    const refused = targetedComposeExclusion(gap, pointer as Parameters<typeof targetedComposeExclusion>[1]);
    if (refused) return refused;
  }

  // OWNER ROUTING FOR DIRECTED GAP WORK (decentralized-compose-ownership). Auto-picks admit only
  // repos this node owns, but a targeted pointer.gap_id bypassed that filter: a node composed and
  // landed a repo another node owns, and two nodes composed the same gap. Forward it to the owning
  // node instead. A forwarded request carries forwarded_from and is never forwarded again; with no
  // single owner found, compose here as before.
  const forwardedFrom = (pointer as { forwarded_from?: string }).forwarded_from;
  if (pointer.gap_id && !forwardedFrom) {
    const targetVessel = identifyVessel(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>);
    const owned = ownedVessels();
    if (targetVessel && owned.size > 0 && !owned.has(targetVessel)) {
      const owner = await findComposeOwner(targetVessel);
      if (owner) {
        console.log(`[gap-to-feature] directed ${String(gap.id)} routed by ownership → ${owner.vesselId} (${targetVessel} is not owned here)`);
        try {
          const res = await fetch(owner.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
            body: JSON.stringify({ impulse: { pointer: { ...pointer, forwarded_from: process.env["SUBSTRATE_NAME"] ?? "substrate" } } }),
            ...({ timeout: false } as RequestInit),   // a compose outlives Bun's ~300 s default fetch cut
          });
          const j = await res.json() as { shape?: string; body?: unknown };
          const fwdBody = j.body && typeof j.body === "object" ? j.body as Record<string, unknown> : { result: j.body ?? null };
          return { shape: j.shape ?? "gapToFeatureReport", body: { ...fwdBody, routed_to: owner.vesselId } };
        } catch (e) {
          return { shape: "gapToFeatureReport", body: { ok: false, stage: "route", gap_id: gap.id, routed_to: owner.vesselId, error: `forward to owner failed: ${(e as Error).message}` } };
        }
      }
      console.log(`[gap-to-feature] directed ${String(gap.id)}: ${targetVessel} is not owned here and no single owner was found; composing here`);
    }
  }
  // Stamp the cooldown at pick-start (covers the whole compose wall time), auto-picks only —
  // a targeted pointer.gap_id must be re-runnable on demand. Mirrors boredom's set-after-select.
  if (!pointer.gap_id && gap.id) {
    gapComposeLastAttemptAt.set(String(gap.id), Date.now());
    const pickedSite = String(((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>).edit_site ?? "");
    if (pickedSite) siteComposeLastAttemptAt.set(pickedSite, Date.now());
  }
  // Held until resolveGapToFeature returns: the auto-pick must not re-pick a gap whose compose is still running.
  if (!pointer.dry_run && gap.id) { attempt.inFlightGapId = String(gap.id); beginComposeInFlight(attempt.inFlightGapId); }
  const decisionId = await recordApproachDecision(gap);
  if (decisionId && !pointer.dry_run) { attempt.id = decisionId; attempt.gap = gap; recordPickIntent(decisionId, gap); }
  // SURPRISE-ROUTED EXPLORE/EXPLOIT (2026-07-09): when-to-work-on-what is a measured
  // policy, not a habit. Low-confidence picks are NOT composed on a guess — they route
  // to investigation first. A high-confidence MISS (predicted land >= 0.7 but the last
  // attempt did not land) means the self-model's mapping is wrong — investigate before
  // recommitting. Calibrated confidence exploits (compose as usual). Targeted
  // dispatches (pointer.gap_id) bypass routing: the caller explicitly chose this gap.
  if (!pointer.gap_id) {
    try {
      const predR = predictLand(gap);
      const mR = (gap.classification_metadata ?? {}) as Record<string, unknown>;
      const highConfMiss = isHighConfidenceMiss(mR.approach_decisions);
      const lowConf = predR.p < 0.35;
      const alreadyInvestigated = mR.investigated_at !== undefined;
      if ((lowConf || highConfMiss) && !alreadyInvestigated) {
        const reason = highConfMiss ? "high_confidence_miss" : "low_confidence_pick";
        const isReconcileGap = String(gap.category ?? "").includes("reconcile") || String(gap.summary ?? "").includes("reconcile");
        const failedAttempts = Array.isArray(mR.approach_decisions) ? mR.approach_decisions.filter((d: any) => d.outcome?.landed === false).length : 0;
        if (isReconcileGap && failedAttempts >= 2) {
          await resolveDispatchGoal({ type: "dispatch_goal", goal: "skipping reconcile gap " + String(gap.id) + " after " + failedAttempts + " failed attempts: " + String(gap.summary ?? "").slice(0, 240) } as never);
          return { shape: "gapToFeatureReport", body: { ok: true, stage: "route", routed: "skip_reconcile", gap_id: gap.id, reason: "failed_attempts", predicted_p: predR.p } };
        }
        await resolveDispatchGoal({ type: "dispatch_goal", goal: "investigate gap " + String(gap.id) + " before composing (" + reason + ", predicted_p=" + predR.p.toFixed(2) + "): " + String(gap.summary ?? "").slice(0, 240) } as never);
        const invMeta = { ...mR, investigated_at: new Date().toISOString(), investigation_reason: reason, last_predicted_p: predR.p };
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...gap, classification_metadata: invMeta, status: String(gap.status ?? "open") } } as never);
        return { shape: "gapToFeatureReport", body: { ok: true, stage: "route", routed: "investigation", gap_id: gap.id, reason, predicted_p: predR.p } };
      }
    } catch { /* routing is best-effort; fall through to compose */ }
  }

  // RECOMMIT SOURCE-GAP LOCALIZATION (gap recommit-composer-mislocalized-edit-site):
  // A re_commit gap's id (e.g. "recommit-route-edit-e32a5778-verify_failed") should be treated as a new gap for lineage tracking
  // repo/vessel path; deriving the edit_site from it mis-localizes to a non-existent
  // repos/<gap-id>/ (ENOENT, fa
  // ADD TEST FOR resolveGapToFeature to ensure correct functionality.ilure_class mis_localized_path). The real edit site lives
  // on the SOURCE gap named in classification_metadata.source_gap_id. Fetch that source
  // gap and inherit its edit_site (and file_path/change_site/suspected_real_location) so
  // localizeGap below targets the actual file, not the recommit id. Best-effort.
  {
    const rcMeta = (gap.classification_metadata ?? {}) as Record<string, string | Record<string, unknown> | undefined>;
    const sourceGapId = typeof rcMeta.source_gap_id === "string" ? rcMeta.source_gap_id : "";
    const hasOwnSite = !!(rcMeta.edit_site || rcMeta.file_path || rcMeta.change_site || rcMeta.suspected_real_location);
    if (sourceGapId && !hasOwnSite) {
      try {
        const srcRead = await resolveSubstrateGap({ type: "substrateGap", id: sourceGapId, limit: 1 } as never);
        const srcGaps = ((srcRead?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
        const src = srcGaps.find((g) => g.id === sourceGapId) ?? srcGaps[0];
        const srcMeta = (src?.classification_metadata ?? {}) as Record<string, unknown>;
        for (const f of ["edit_site", "file_path", "change_site", "suspected_real_location"] as const) {
          if (!rcMeta[f] && typeof srcMeta[f] === "string" && srcMeta[f]) rcMeta[f] = srcMeta[f];
        }
        gap.classification_metadata = rcMeta;
      } catch { /* best-effort: fall through to normal localization */ }
    }
  }

  // Pick-time condition check: if the surgical gap's cited literal is already
  // absent from the codebase, close it as already_resolved without composing.
  const _pickCond = verifyGapCondition(gap);
  if (_pickCond === 'absent') {
    const closedAt = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id as string,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution: "already_resolved", closed_reason: "already_resolved", closed_by: "gap_to_feature.pick_condition_check", closed_at: closedAt },
        status: "closed",
      },
    } as never);
    return {
      shape: "gapToFeatureReport",
      body: {
        ok: true,
        gap_id: gap.id as string,
        gap_category: gap.category as string,
        verdict: "already_resolved",
        note: "gap condition absent at pick time — closed as already_resolved",
      },
    };
  }
  if (_pickCond === 'pending') {
    // Landed once but unmeasured — do NOT re-compose (a second landing manufactures a re-land the
    // close-oracle would score as a false-close). The sweep + human escalation own it. (§12.6 step 1)
    console.log(`[gap-to-feature] gap ${String(gap.id ?? '')} PENDING verification at pick time — skipping re-compose`);
    await markPendingVerification(gap, undefined, "pending at pick time (site B): landed once, no measurement predicate — persisted so the candidate filter can exclude it");
    return {
      shape: "gapToFeatureReport",
      body: { ok: true, gap_id: gap.id as string, gap_category: gap.category as string, verdict: "pending_verification", note: "landed once but unmeasured — held pending verification; not re-composed" },
    };
  }

  // 1a-pre. ALREADY-RESOLVED CHECK for missing_capability gaps: query discovery for a
  // live producer of the candidate shape named in the gap summary. If found, and (when
  // edit_site is present) the file exists via statSync, close the gap without composing
  // to prevent duplicate-identifier patches from re-applying already-landed patches.
  {
    const probed = await liveProducerProbeClose(gap);
    if (probed) return probed;
  }

  // 1a0. TRACE-STORE-RECONCILIATION gaps dispatch the seeded
  // development-vessel:trace-store-reconcile activity via goal-host, NOT
  // feature_compose (2026-07-08, openspec
  // 2026-07-08-substrate-self-managed-db-reconciliation). This is an
  // operational DB-maintenance swap (acquire lease -> db_admin
  // reconcile_trace_store -> verify -> release lease), not a code change —
  // feature_compose's typecheck-verify gate has nothing to typecheck here.
  // Dispatching by targetTemplateId (rather than freeform goal text) pins the
  // exact activity so goal-host's shape-graph walk doesn't have to infer it,
  // and the reach-gate still produces an honest `reached` verdict for the
  // learning loop (canonical loop: run_goal -> goal_status -> goal_reasoning
  // -> provide_feedback).
  if (String(gap.category ?? "") === "trace_store_reconciliation") {
    if (pointer.dry_run) {
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: true,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          dry_run: true,
          plan: "POST goal-host /run-goal targetTemplateId=development-vessel:trace-store-reconcile",
        },
      };
    }
    try {
      const auth: Record<string, string> = METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {};
      // Thompson-sample the trace-store-reconcile family (base + variants) and dispatch the argmax
      let selectedTemplateId = "development-vessel:trace-store-reconcile";
      try {
        const reachEndpoint = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
        const baseId = "development-vessel:trace-store-reconcile";
        const normalizeId = (s: unknown): string => {
          const raw = String(s ?? "");
          return raw.replace(/^activity:/, "").replace(/[<>⟨⟩]/g, "");
        };
        let family: string[] = [baseId];
        {
          // Ask the registry for the family instead of scanning the catalogue: the
          // /templates listing pages LIMIT/START without ORDER BY (2,771 rows paged =
          // 2,722 distinct, 49 duplicates — the variants fell in the gaps), while
          // GET /v2/activities/:id/variants returns base + variants directly now that
          // API-key callers can use it (97ff41d).
          const baseNorm = normalizeId(baseId);
          const fRes = await fetch(`${reachEndpoint}/v2/activities/${encodeURIComponent(baseNorm)}/variants`, {
            method: "GET",
            headers: { ...auth },
            signal: AbortSignal.timeout(10_000),
          });
          if (fRes.ok) {
            const body = (await fRes.json().catch(() => ({}))) as { variants?: Array<Record<string, unknown>> };
            for (const v of Array.isArray(body.variants) ? body.variants : []) {
              const id = normalizeId(v["id"]);
              const varOf = normalizeId(v["variant_of"]);
              const retired = Boolean(v["retired"] ?? false);
              const deprecated = Boolean(v["deprecated"] ?? false);
              if (!retired && !deprecated && id && varOf && varOf === baseNorm) family.push(id);
            }
          }
          family = Array.from(new Set(family));
        }
        type Posterior = { alpha: number; beta: number };
        const sampleNormal = (): number => {
          // Box–Muller transform
          let u = 0, v = 0;
          while (u === 0) u = Math.random();
          while (v === 0) v = Math.random();
          return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        };
        const sampleGamma = (k: number): number => {
          if (k <= 0) return 0;
          if (k < 1) {
            const u = Math.random();
            return sampleGamma(1 + k) * Math.pow(u, 1 / k);
          }
          const d = k - 1 / 3;
          const c = 1 / Math.sqrt(9 * d);
          for (;;) {
            const x = sampleNormal();
            let v = 1 + c * x;
            if (v <= 0) continue;
            v = v * v * v;
            const u = Math.random();
            if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
          }
        };
        const sampleBeta = (a: number, b: number): number => {
          const x = sampleGamma(Math.max(1e-6, a));
          const y = sampleGamma(Math.max(1e-6, b));
          const denom = x + y;
          return denom > 0 ? x / denom : 0;
        };
        const samples: Array<{ id: string; draw: number }> = [];
// Build Thompson-sampling family via paged read to work around /v2/activities/templates limit=100 cap.
// Cache per-root for a few minutes to avoid N-page scans on each observer dispatch.
const familySample: string[] = await (async () => {
  try {
    const rootId = normalizeId(selectedTemplateId);
    type CacheEntry = { ids: string[]; at: number };
    const g = globalThis as unknown as Record<string, unknown>;
    const cacheKey = "__dv_variant_family_cache__";
    const cacheTTLms = 3 * 60_000; // 3 minutes
    if (!g[cacheKey]) g[cacheKey] = new Map<string, CacheEntry>();
    const cache = g[cacheKey] as Map<string, CacheEntry>;
    const hit = cache.get(rootId);
    const now = Date.now();
    if (hit && now - hit.at < cacheTTLms && Array.isArray(hit.ids) && hit.ids.length > 0) return hit.ids.slice();

    const limit = 100;
    const maxPages = 40; // safety bound (<= 4k templates)
    const baseUrl = reachEndpoint; // same host used elsewhere in this resolver
    const headers = { "Content-Type": "application/json", ...auth } as Record<string, string>;
    const collected: string[] = [rootId];
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      const url = `${baseUrl}/v2/activities/templates?limit=${limit}&offset=${offset}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) break;
      const body = (await r.json().catch(() => ({}))) as { templates?: Array<Record<string, unknown>> };
      const rows = Array.isArray(body.templates) ? body.templates : [];
      for (const row of rows) {
        const vid = String(row["variant_of"] ?? "");
        const id = String(row["id"] ?? "");
        if (vid && id && normalizeId(vid) === rootId) collected.push(normalizeId(id));
      }
      if (rows.length < limit) break; // last page reached
    }
    const uniq = Array.from(new Set(collected));
    cache.set(rootId, { ids: uniq, at: now });
    return uniq;
  } catch {
    // Fall back to sampling ONLY the selected base when reads fail.
    return [normalizeId(selectedTemplateId)];
  }
})();
        // Two family sources now exist: `family` (the registry's /variants route, 97ff41d) and
        // `familySample` (a5b4772's paged read of the unordered /templates listing, which
        // skips rows and has returned [base] at every tick). Prefer the route when it found
        // variants; fall back to the paged sample otherwise.
        for (const id of (family.length > 1 ? family : familySample)) {
          const activity_id = normalizeId(id);
          let a = 1, b = 1;
          try {
            const pr = await fetch(`${reachEndpoint}/v2/impulses/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...auth },
              body: JSON.stringify({ impulse: { pointer: { type: "thompson_posterior", activity_id } } }),
              signal: AbortSignal.timeout(10_000),
            });
            if (pr.ok) {
              const pj = (await pr.json().catch(() => ({}))) as { content?: unknown };
              const contentStr = typeof pj.content === "string" ? pj.content : "";
              const parsed = contentStr ? (JSON.parse(contentStr) as { loaded?: boolean; content?: { alpha?: number; beta?: number } }) : { loaded: false };
              if (parsed.loaded && parsed.content) {
                const pa = Number(parsed.content.alpha);
                const pb = Number(parsed.content.beta);
                if (Number.isFinite(pa) && pa > 0) a = pa;
                if (Number.isFinite(pb) && pb > 0) b = pb;
              }
            }
          } catch {
            // keep default a=b=1 on read error
          }
          const draw = sampleBeta(a, b);
          samples.push({ id: activity_id, draw });
        }
        if (samples.length > 0) {
          let bestIndex = 0;
          for (let i = 1; i < samples.length; i++) if (samples[i]!.draw > samples[bestIndex]!.draw) bestIndex = i;
          selectedTemplateId = samples[bestIndex]!.id || selectedTemplateId;
        }
        console.log(`[gap-to-feature] trace-store-reconcile family sampled: ${samples.length} member(s) -> ${selectedTemplateId}`);
      } catch {
        // fall open to base (selectedTemplateId already set)
      }
      const res = await fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/run-goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          goal: "reconcile the trace store back under its configured cap",
          targetTemplateId: selectedTemplateId,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => "");
      const dispatched = res.ok;
      if (dispatched) {
        // Mark dispatched (classification_metadata only; status stays "open"
        // — the trace-store-health-observer stops re-emitting once row_count
        // drops back under cap, and gap-lifecycle-tick auto-closes stale
        // non-reproducing gaps; this resolver does not assert the swap
        // succeeded, only that it was handed off).
        try {
          await resolveSubstrateGapWrite({
            type: "substrateGap_write",
            gap: {
              id: String(gap.id ?? ""),
              category: gap.category,
              source: gap.source,
              summary: gap.summary,
              detected_at: gap.detected_at,
              classification_metadata: {
                ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>),
                dispatched_at: new Date().toISOString(),
                dispatch_route: "trace-store-reconcile",
              },
              status: "open",
            },
          } as never);
        } catch {
          /* best-effort marker write */
        }
      } else {
        await gradeTraceStoreDispatch(gap, res.status, text, attempt.id, escalateToDecomposition);
      }
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: dispatched,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          dispatch_status: res.status,
          dispatch_detail: text.slice(0, 300),
        },
      };
    } catch (e) {
      await gradeTraceStoreDispatchError(gap, attempt.id, escalateToDecomposition);
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: false,
          stage: "route_trace_store_reconcile",
          gap_id: gap.id,
          gap_category: gap.category,
          route: "trace-store-reconcile",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }

  // 1a. DOCUMENTATION-DRIFT gaps close via doc_drift_fix, NOT feature_compose (2026-07-01).
  // A doc is prose: feature_compose grounds/verifies .ts only, so its typecheck→rollback gate
  // is a no-op for a .md edit — routing prose through it would land an LLM draft with the gate
  // disabled. doc_drift_fix drafts the minimal edit and gates it with a prose reach-gate (the
  // doc analogue of verifyGoalReached). It is TRIAGE-only by default (DOC_FIX_AUTOLAND off).
  if (String(gap.category ?? "") === "documentation_drift") {
    // doc_drift_fix records its own failure bookkeeping (doc_fix status + failed_attempts);
    // re-upserting from the stale pre-run gap object here clobbered that write (lost update).
    return resolveDocDriftFix({ type: "doc_drift_fix", gap_id: String(gap.id ?? ""), dry_run: pointer.dry_run });
  }

  // 1b. ORPHANED-CAPABILITY gaps close via author_producer, NOT feature_compose
  // (2026-06-25). The closure for "resolver X is live but invoked by 0 activities"
  // is a RUNNABLE activity that invokes X — minted by the author_producer bridge
  // path (lever 1: author→validate→mint a 2-task goal_file_extract→produce bridge
  // for a file-consuming resolver). feature_compose authors vessel TypeScript and
  // here free-drafts a create_file into a NON-EXISTENT vessel (e.g. repos/executive/)
  // that phantom-lands and never invokes the resolver. Route to the primitive that
  // actually produces a discoverable, Thompson-selectable producer.
  if (String(gap.category ?? "") === "unreachable_producer") {
    const repaired = await resolveReachabilityGapRepair({ type: "reachability_gap_repair", gap_id: String(gap.id ?? ""), dry_run: pointer.dry_run });
    const rb = (repaired?.body ?? {}) as Record<string, unknown>;
    await settleReachabilityRepair(gap, rb, pointer.dry_run, attempt.id, escalateToDecomposition);
    return {
      shape: "gapToFeatureReport",
      body: { ok: rb["verdict"] === "FAVORABLE", stage: "route_reachability", gap_id: gap.id, gap_category: gap.category, route: "reachability_gap_repair", repair: rb },
    };
  }
  if (String(gap.category ?? "") === "orphaned_capability") {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const shape = String(meta.shape ?? "").trim();
    if (!shape) {
      return {
        shape: "gapToFeatureReport",
        body: { ok: false, stage: "route_orphan", gap_id: gap.id, gap_category: gap.category, error: "orphaned_capability gap missing classification_metadata.shape" },
      };
    }
    // The summary already states "Author an activity that invokes resolver X"; pass
    // it as goal context so author_producer's validate step can lift a real file
    // path from a file-shaped pointer field (buildTestPointer reads the goal).
    const goal = String(gap.summary ?? `author an activity that invokes resolver ${shape} and routes its output onward`);
    const author = pointer.dry_run
      ? null
      : await resolveAuthorProducer({ type: "author_producer", shape, goal });
    const ab = (author?.body ?? {}) as Record<string, unknown>;
    const minted = author?.shape === "author_producer";
    // Deprioritise repeated MINT_FAILED. This early-return branch never reached
    // bumpFailedAttempts (which fires only on the feature_compose path, ~L1056), so
    // an orphaned-capability gap whose resolver can't be provisioned was re-selected
    // every run FOREVER (observed: residual_shape_discovery MINT_FAILED hourly with
    // failed_attempts unset), starving other gaps — the same liveness bug as the
    // detector-re-emit wipe, on a different code path. Bump so the loop moves on. (2026-07-01)
    await settleAuthorProducerMint(gap, minted, pointer.dry_run, attempt.id, escalateToDecomposition);
    // CLOSE-ON-MINT (2026-07-01): a minted bridge IS the closure — the resolver is now
    // invoked by a Thompson-selectable activity, so it is no longer orphaned. Without
    // closing, the open-filtered picker re-selects the SAME top orphaned gap every run
    // and re-mints it idempotently, never advancing to the other orphaned resolvers
    // (observed: repairPolicy re-picked + re-MINTED though auto-bridge-repairPolicy
    // already existed). Mirrors closeLandedGap on the feature_compose path (~L1071).
    return {
      shape: "gapToFeatureReport",
      body: {
        ok: pointer.dry_run ? true : minted,
        gap_id: gap.id,
        gap_category: gap.category,
        gap_summary: gap.summary,
        route: "author_producer",
        orphan_shape: shape,
        verdict: pointer.dry_run ? "plan" : (minted ? "MINTED" : "MINT_FAILED"),
        minted_activity_id: minted ? ab.minted_activity_id : null,
        two_task_bridge: minted ? ab.two_task_bridge : null,
        author: ab,
        note: pointer.dry_run
          ? `plan: would mint a runnable bridge activity invoking resolver "${shape}" via author_producer`
          : (minted
            ? `MINTED runnable bridge "${ab.minted_activity_id}" invoking previously-orphaned resolver "${shape}" — capability now expressed and Thompson-selectable`
            : `author_producer could not mint a validated invocation of "${shape}" (see author.last_error); the resolver may need an input the bridge can't yet provision`),
      },
    };
  }

  // 1c. CAPABILITY-GAP (missing producer, no existing resolver) → author_new_resolver.
  // The walk files these (kind === "capability_gap", classification_metadata.
  // missing_shape) when no producer exists for a target output shape. Route to the
  // create-oriented primitive instead of feature_compose free-draft (see the bridge
  // note above). This is the S1→S2 unlock for the whole missing-producer class.
  {
    const cgMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    if (String(cgMeta.kind ?? "") === "capability_gap") {
      const missingShape = String(cgMeta.missing_shape ?? "").trim();
      if (missingShape) {
        const cgResult = await routeCapabilityGapToNewResolver(gap, missingShape, cgMeta, pointer, attempt.id);
        // Same liveness fix: this route's failure returns (ok:false) never bumped
        // failed_attempts either, so a capability_gap the author can't satisfy would
        // be re-selected forever. Bump on failure so the loop moves on. (2026-07-01)
        await gradeCapabilityRouteResult(gap, cgResult, pointer.dry_run, attempt.id, escalateToDecomposition);
        return cgResult;
      }
    }
  }

  // 2. Build a spec and route THROUGH the composer. If the gap's drafter
  // already named EXISTING change sites, inject them so the composer edits
  // existing source (lands) instead of scaffolding a new vessel (phantom).
  let editTargets = existingEditTargets(String(gap.id ?? ""));
  // LOCALIZATION (task #5): when no proposal-report edit target exists, DERIVE a
  // concrete edit-site from the gap's own text/metadata via code-search so the
  // composer edits existing source instead of free-drafting. Only a CONFIDENT single
  // file is returned; low-confidence → editTargets stays empty (composer free-drafts
  // as before — behaviour unchanged in that case).
  let localized: LocalizeResult | null = null;
  if (editTargets.length === 0) {
    try {
      localized = await localizeGap(gap, { useLlm: true });
    } catch { localized = null; }
    if (localized) {
      editTargets = [{ file: localized.file, description: localized.description }];
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        status: gap.status,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          localized: true,
          localized_at: new Date().toISOString(),
        },
      },
    });
    }
  }
  if (editTargets.length === 0) {
    const gapId = String(gap.id ?? "");
    console.log("[gap-to-feature] no existing edit targets found for gap", gapId, "— composer will scaffold new file");
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: gap.id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        status: gap.status,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          localization_failed: true,
          localization_failed_at: new Date().toISOString(),
        },
      },
    });
    await resolveUiWritePassthrough({
      type: "uiQuestion_write",
      id: "needs-localization-" + gapId,
      title: "Gap needs a change-site",
      body: "Localization failed for gap " + gapId + ": name the concrete repos/<vessel>/src file this gap should change, or say it is out of code reach. Summary: " + String(gap.summary ?? "").slice(0, 300),
      kind: "gap_needs_localization",
      importance: "medium",
    });
    void fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      body: JSON.stringify({ type: "substrateGap", filter: { id: gapId } }),
    }).catch((e: unknown) => {
      console.warn("[gap-to-feature] escalation fetch failed:", e instanceof Error ? e.message : String(e));
    });
  }

  // DUAL-SIDE LOCALIZATION (2026-06-29): a responsibility-MOVE gap names a DESTINATION
  // vessel to move logic TO. localizeGap above pins only the SOURCE; without grounding the
  // destination the composer authors only the deletion half (calling an endpoint that does
  // not exist yet → UNFAVORABLE). Infer the destination here and add it to editTargets so
  // it is ALSO grounded + typechecked, and pass a move context to specFromGap so the spec
  // mandates authoring BOTH halves. STRICTLY ADDITIVE: inferMoveTarget returns null for
  // surgical / same-vessel gaps → behaviour below is byte-identical to before.
  const gapMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const sourceVessel = identifyVessel(gap, gapMeta);
  const sourceFile = editTargets[0]?.file ?? localized?.file ?? null;
  const moveTarget = inferMoveTarget(gap, gapMeta, sourceVessel);
  let move: { source: string | null; sourceFile: string | null; target: MoveTarget } | null = null;
  if (moveTarget) {
    move = { source: sourceVessel, sourceFile, target: moveTarget };
    // Add the destination vessel as an edit target so it is grounded + typechecked. Point
    // at its capability dispatch surface (src/) — feature_compose's grounding reads the
    // whole tree, so a vessel-level hint is enough; the planner picks the concrete file.
    const destFile = `${moveTarget.repoPath}/src`;
    if (!editTargets.some((t) => t.file.startsWith(`${moveTarget.repoPath}/`))) {
      editTargets = [
        ...editTargets,
        { file: destFile, description: `MOVE DESTINATION — create the receiving capability${moveTarget.endpoint ? ` "${moveTarget.endpoint}"` : ""} here` },
      ];
    }
  }

  const spec = specFromGap(gap, editTargets, move);
  // Thread the localized/known vessel(s) into verify_vessels so the composer GROUNDS its
  // plan on the real file tree+contents of those vessels and typechecks them. For a move
  // gap this is BOTH the source AND the destination vessel.
  const verifyVessels = [...new Set(editTargets.map((t) => t.file.match(/^repos\/[^/]+/)?.[0]).filter((v): v is string => !!v))];
  const slices = await capacitySlices(gap);
  if (slices.length >= 2) {
    const sliceResults: Array<{ file: string; verdict: unknown }> = [];
    const priorSliceFlow: string[] = [];
    let lastBody: Record<string, unknown> | null = null;
    for (const s of slices) {
      const sliceCompose = await resolveFeatureCompose({
        type: "feature_compose",
        spec: spec + "\n" + `CAPACITY SLICE: this dispatch must touch ONLY the file ${s.file}; other slices are handled in separate dispatches.` + (s.hint ? ` Context: ${s.hint}` : "") + (priorSliceFlow.length ? "\nPRIOR SLICES ALREADY LANDED in this same gap (build on them, they are in the tree now, do not redo or contradict them): " + priorSliceFlow.join("; ") : ""),
        ...(verifyVessels.length ? { verify_vessels: verifyVessels } : {}),
        model: pointer.model,
        dry_run: pointer.dry_run ?? false,
        keep_on_fail: false,
        ...(attempt.id ? { decision_id: attempt.id } : {}),
        gap: {
          id: String(gap.id ?? ""),
          summary: String(gap.summary ?? gap.title ?? ""),
          classification_metadata: (gap.classification_metadata ?? gap.metadata ?? undefined) as Record<string, unknown> | undefined,
          category: String(gap.category ?? ""),
        },
        land: !(pointer.dry_run ?? false),
        max_ops: 8,
      } as never);
      await recordLineageSpend(String(gap.id ?? ""), sliceCompose.body, pointer.dry_run ?? false);
      lastBody = sliceCompose.body as Record<string, unknown>;
      sliceResults.push({ file: s.file, verdict: lastBody.verdict });
      if (lastBody.verdict === "FAVORABLE") { priorSliceFlow.push(s.file + " landed" + (typeof lastBody.commit_sha === "string" ? " (commit " + lastBody.commit_sha + ")" : "") + (typeof lastBody.summary === "string" ? ": " + String(lastBody.summary).slice(0, 120) : "")); }
      if (lastBody.verdict !== "FAVORABLE") break;
    }
    const allOk = sliceResults.length === slices.length && sliceResults.every((r) => r.verdict === "FAVORABLE");
    const sliceLand = await gradeSliceSequence(gap, lastBody, allOk, pointer.dry_run, attempt.id, { ask: askHuman, escalate: escalateToDecomposition });
    // ...so it must not serve the cooldown either. Same reasoning as the credit exemption above.
    requeueAfterNonAttempt(gapComposeLastAttemptAt, String(gap.id ?? ""), lastBody);
    return { shape: "gapToFeatureReport", body: { ok: allOk, stage: "route_compose", route: "capacity_slice_sequence", gap_id: gap.id, gap_category: gap.category, slices: sliceResults, landed: sliceLand.landed, landed_commit: sliceLand.commit_sha ?? null, compose: lastBody } };
  }

  // PREFER A FRESH PARK OVER A REDRAFT (resumable landings): a park is a patch for this
  // gap that already passed verify and the semantic gate and only lost its cutover.
  const parkTtlMs = Number((pointer as { parked_landing_ttl_ms?: number }).parked_landing_ttl_ms ?? 86_400_000);
  const park = await readParkedLanding(String(gap.id ?? "")).catch(() => null);
  const freshPark = park && Date.now() - Date.parse(park.parked_at) < parkTtlMs ? park : null;
  if (freshPark) console.log(`[gap-to-feature] picked ${String(gap.id)} has a fresh parked landing (${freshPark.compose_id}) - dispatching feature_compose with resume_from`);
  const compose = await resolveFeatureCompose({
    type: "feature_compose",
    spec,
    ...(freshPark ? { resume_from: freshPark, parked_landing_ttl_ms: parkTtlMs } : {}),
    ...(verifyVessels.length ? { verify_vessels: verifyVessels } : {}),
    model: pointer.model,
    dry_run: pointer.dry_run ?? false,
    keep_on_fail: false,
    directed: (pointer as { directed?: boolean }).directed === true,
    // The pick's decision rides to registerAttempt, so the landing's Attempt-Id maps back to it.
    ...(attempt.id ? { decision_id: attempt.id } : {}),
    // Thread the gap through so the semantic cutover-verification gate (lever 5)
    // can judge the patch AGAINST the gap on a live path and write
    // suspected_real_location back onto the gap when the drafter mis-localized.
    gap: {
      id: String(gap.id ?? ""),
      summary: String(gap.summary ?? gap.title ?? ""),
      classification_metadata: (gap.classification_metadata ?? gap.metadata ?? undefined) as Record<string, unknown> | undefined,
      category: String(gap.category ?? ""),
    },
    // Autonomous LAND: on FAVORABLE, push through vessel-mitosis-cutover (its
    // evidence+freshness gates are the self-verification; self-recovery is the
    // backstop). Suppressed in dry_run.
    land: !(pointer.dry_run ?? false),
  });
  await recordLineageSpend(String(gap.id ?? ""), compose.body, pointer.dry_run ?? false);

  const cb = compose.body as Record<string, unknown>;
  try {
    const reachId2 = typeof cb["execution_id"] === "string" ? (cb["execution_id"] as string) : "";
    if (reachId2.length > 0) {
      const reachEndpoint2 = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
      const reachKey2 = process.env["METABOB_API_KEY"] ?? "";
      void fetch(`${reachEndpoint2}/v2/activities/execution-traces/reach`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(reachKey2 ? { Authorization: `ApiKey ${reachKey2}` } : {}) },
        body: JSON.stringify({ execution_id: reachId2, reached: cb["ok"] === true }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => { /* grading must never affect the compose result */ });
    }
  } catch { /* verdict delivery is best effort */ }

  // CLOSE-ON-LAND: only when the fix GENUINELY landed on origin/dev (FAVORABLE +
  // a real "pushed" cutover, never dry_run / staged-only / soft-refuse). A
  // merely-staged or UNFAVORABLE result leaves the gap open so it (or another open
  // gap) is retried — closing on a non-land would lose a real, unfixed gap.

  if (isNonAttemptComposeResult(compose.body as Record<string, unknown>)) {
    // Handle the non-attempt compose case.
  }
  const { land, closure, nonAttempt } = await gradeComposeOutcome(gap, cb, spec, pointer.dry_run, attempt.id, { ask: askHuman, escalate: escalateToDecomposition });
  {
    // The grader judged a compose that never ran (a non-attempt): it costs the gap no cooldown.
    if (nonAttempt) {
      delete gap.cooldown_until;
      gapComposeLastAttemptAt.delete(String(gap.id)); // A compose that never ran must not cost its gap a cooldown
      console.log("[gap-to-feature] non-attempt (failure_kind=" + String(cb.failure_kind ?? "-") + ", verdict=" + String(cb.verdict ?? "-") + ", stage=" + String(cb.stage ?? "-") + ") for gap " + String(gap.id) + " — clearing cooldown");
      // A compose that never ran must not cost the gap its cooldown.
      gapComposeLastAttemptAt.delete(String(gap.id));
    }
  }

  return {
    shape: "gapToFeatureReport",
    body: {
      ok: cb?.ok ?? cb?.verdict === "FAVORABLE",
      gap_id: gap.id,
      gap_category: gap.category,
      gap_summary: gap.summary,
      edit_targets: editTargets.map((t) => t.file),
      localized: localized
        ? { file: localized.file, vessel: localized.vessel, method: localized.method, candidates: localized.candidates ?? null }
        : null,
      verify_vessels: verifyVessels,
      verdict: cb?.verdict ?? cb?.stage,
      compose: cb,
      // Surface the genuine-land + closure decision so the loop's progress is observable.
      landed: land.landed,
      landed_commit: land.commit_sha,
      gap_closed: closure.closed,
      gap_close_error: closure.error ?? null,
      note: land.landed
        ? (closure.closed
          ? `LANDED on origin/dev${land.commit_sha ? ` (${land.commit_sha})` : ""} and gap marked CLOSED — picker advances to the next open gap`
          : `LANDED on origin/dev but gap-close write failed (${closure.error}); gap stays open and will be retried`)
        : (cb?.verdict === "FAVORABLE"
          ? "FAVORABLE but NOT pushed (staged only / push gated) — gap stays OPEN; self-recovery is the backstop"
          : "composer could not produce a verified change for this gap (see compose.applied/verify) — gap stays OPEN"),
    },
  };
}
