import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";
import { resolveFeatureCompose, priorAttemptFeedbackBlock, readParkedLanding, resolveDissentOutcome } from "./feature-compose.js";
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

import { appendRecord } from "./attempt-ledger.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES, predicateSuspect, class2PredicateKey, reevaluateBirthVerdicts, inheritableParentCheck, birthCheckRepo } from "./substrate-gap.js";
import { resolveAuthorProducer } from "./author-producer.js";
import { resolveDocDriftFix } from "./doc-drift-fix.js";
import { resolveReachabilityGapRepair } from "./reachability-gap-repair.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";
import { resolveUiWritePassthrough } from "./ui-write-passthrough.js";

const solicitedHumanGaps = new Set<string>();
import { DISCOVERY_ENDPOINT, METABOB_API_KEY, GOAL_HOST_VESSEL_ENDPOINT, lookupShape, describeLookup, discoveryFailureBackoffMs, __resetDiscoveryForTests } from "../config.js";
import { peekComposeCapacity, hasFreeComposeCapacity } from "../compose-slots.js";
import { gateLanding, landingsStopped } from "./push-policy.js";
import { readFile } from "node:fs/promises";
import { selfAuthHeaders } from "../lib/self-auth.js";

// Mirror feature-compose's path model: repos/<vessel>/... maps to the writable
// runtime ${MITOSIS_RUNTIME_DIR}/<vessel>/..., and the drafter writes proposal reports
// to <workspace>/proposals/<gapId>-report.json.
// READ AT CALL TIME, not frozen at module load. These were `const … = process.env.X ?? …`,
// which binds to whichever importer loaded this module FIRST. Under `bun test` the module
// registry is shared across test files, so a sibling that redirected these to its own tmp
// fixture won the binding and every later file silently inherited it — the admission test
// saw a sibling's MITOSIS_RUNTIME_DIR (whose tree happens to contain goal-host-vessel/src/index.ts,
// so the cited-file check passed) paired with a proposals dir that had none of its fixtures.
// It passed alone and failed in the suite, which reads as flake rather than as the ordering
// dependency it is. An empty string is treated as unset: exporting X="" is "no value", and
// `??` does not fall back on "" (same defect class as 3409fac in config.ts).
const envPath = (key: string, fallback: string): string => {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
};
const runtimeRoot = (): string => envPath("MITOSIS_RUNTIME_DIR", "/vessels");
const proposalsDir = (): string => envPath("PROPOSALS_DIR", "/workspace/proposals");

// COMPOSE-HORIZON DEDUP — the one selection primitive, applied at the compose horizon.
// Ports boredom-vessel's gapGoalLastDispatchAt + GAP_GOAL_COOLDOWN_MS (src/index.ts:3451-3485)
// and goal-host's /run-goal in-flight coalesce: a gap composed within the cooldown is
// guaranteed-redundant work (VoI~0 for the duplicate — same gap id, only a jittering residual
// float differs). Filter cooled gaps out of the AUTO-pick candidate set so the picker ADVANCES
// to the next-best gap instead of re-composing the same top gap every ~60-90s tick. This is the
// missing horizon that let cost-model-miscalibrated re-compose 17x/60min and starve self-authoring.
const GAP_COMPOSE_COOLDOWN_MS = parseInt(process.env.GAP_COMPOSE_COOLDOWN_MS ?? "300000", 10);
const gapComposeLastAttemptAt = new Map<string, number>();
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
 * ONE LIVE GAP PER (LINEAGE, CHECK). A narrowed or recommit child born with its parent's check
 * (inheritableParentCheck) is the same predicate as the parent and its siblings: picking all of them
 * splits attempts and spend three ways on one check. While such a child is open and able to work, it
 * HOLDS the predicate, and every other open gap of its lineage with a byte-identical evidence_resolve
 * is not auto-pickable. Returns held id -> holder id.
 *
 * A holder must be workable, or the hold would park the whole lineage: its own check trusted
 * (predicateSuspect null), no operator hold, no parking disposition, not an identical-repeated-failure
 * loss. Among several, the narrowed child (it carries the failure lessons) is preferred, then the one
 * with fewer failed attempts, then the id, so the choice is stable across passes.
 */
export function inheritedPredicateHolds(gaps: Record<string, unknown>[]): Map<string, string> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const g of gaps) { const id = String(g.id ?? ""); if (id) byId.set(id, g); }
  const metaOf = (g: Record<string, unknown>): Record<string, unknown> => (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
  const rootOf = (g: Record<string, unknown>): string => {
    let cur = g;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const id = String(cur.id ?? "");
      if (seen.has(id)) break;
      seen.add(id);
      const m = metaOf(cur);
      const up = String(m.parent_gap_id ?? m.source_gap_id ?? "");
      if (!up) return id;
      const next = byId.get(up);
      if (!next) return up; // a closed or unread ancestor still names the lineage
      cur = next;
    }
    return String(cur.id ?? "");
  };
  const checkKey = (m: Record<string, unknown>): string | null => {
    const er = m.evidence_resolve;
    return er && typeof er === "object" && typeof (er as { shape?: unknown }).shape === "string" ? class2PredicateKey({ evidence_resolve: er }) : null;
  };
  const groups = new Map<string, { members: string[]; holders: Record<string, unknown>[] }>();
  for (const g of gaps) {
    const id = String(g.id ?? "");
    const m = metaOf(g);
    const key = checkKey(m);
    if (!id || !key) continue;
    const gk = rootOf(g) + "\u0000" + key;
    const grp = groups.get(gk) ?? { members: [], holders: [] };
    grp.members.push(id);
    const isInheritedChild = m.predicate_source === "gap_falsify:inherit" && !!(m.parent_gap_id ?? m.source_gap_id);
    if (isInheritedChild && predicateSuspect(m) === null && m.operator_hold !== true && !isParkingDisposition(m.disposition) && !identicalRepeatedFailure(m.failure_lessons)) grp.holders.push(g);
    groups.set(gk, grp);
  }
  const held = new Map<string, string>();
  for (const { members, holders } of groups.values()) {
    if (holders.length === 0 || members.length < 2) continue;
    const rank = (g: Record<string, unknown>): [number, number, string] => [String(g.id ?? "").endsWith("-narrowed") ? 0 : 1, Number(metaOf(g).failed_attempts ?? 0) || 0, String(g.id ?? "")];
    holders.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
    const holder = String(holders[0]!.id ?? "");
    for (const id of members) if (id !== holder) held.set(id, holder);
  }
  return held;
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

/**
 * A repos/<vessel>/... path maps to an EXISTING file under the runtime root OR the vessel clone.
 * The runtime tree is an image layer that omits most test/ files, while the lane edits the clone,
 * so a gap whose edit_site is a test file read as ungroundable (measured 2026-09-29 on node 2:
 * /vessels/activity-api/test held 1 file; 8 open gaps cited clone-only paths, 3 of them class2).
 */
function repoPathExists(repoRelative: string): boolean {
  const rel = repoRelative.replace(/^repos\//, "");
  try {
    return existsSync(join(runtimeRoot(), rel)) || existsSync(join(vesselsCloneRoot(), rel));
  } catch {
    return false;
  }
}

/**
 * The unserved-quadrant fix (2026-06-23): a gap's drafter often writes a
 * patch_proposal naming the EXISTING file(s) that should change
 * (required_code_modifications[].file). Without surfacing those into the spec,
 * the composer's LLM freelances a NEW vessel (create_file ops) that has no
 * cutover clone and PHANTOM-lands. Reading the proposal and naming the concrete
 * existing targets in the spec steers the composer to `edit` ops on existing
 * source — which actually land. Only EXISTING files are returned; a proposal
 * naming a genuinely-new path is left for the composer to scaffold legitimately.
 */
function existingEditTargets(gapId: string): Array<{ file: string; description: string }> {
  try {
    const path = join(proposalsDir(), `${gapId}-report.json`);
    if (!existsSync(path)) return [];
    let raw = readFileSync(path, "utf8").trim();
    // Tolerant parse: drafters wrap JSON in ```json fences (sometimes multiple
    // concatenated objects — take the first balanced object).
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const end = raw.indexOf("}\n{");
    const firstObj = end > 0 ? raw.slice(0, end + 1) : raw;
    const parsed = JSON.parse(firstObj) as { required_code_modifications?: Array<{ file?: unknown; description?: unknown }> };
    const mods = Array.isArray(parsed.required_code_modifications) ? parsed.required_code_modifications : [];
    const out: Array<{ file: string; description: string }> = [];
    for (const m of mods) {
      const file = typeof m.file === "string" ? m.file : "";
      if (!file || !/^repos\/[^/]+\//.test(file)) continue;
      if (!repoPathExists(file)) continue; // only steer toward files that actually exist
      out.push({ file, description: typeof m.description === "string" ? m.description : "" });
    }
    return out;
  } catch {
    return [];
  }
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

/** Resolve the vessel directory under the runtime root, returning the repos/<vessel> rel path. */
function vesselDirExists(vessel: string): boolean {
  try {
    return statSync(join(runtimeRoot(), vessel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identify the target vessel for a gap. Order: explicit metadata.vessel, then an
 * edit-site/file_path's repos/<vessel>/ or /vessels/<vessel>/ prefix, then a vessel name
 * embedded in the gap id ("responsibility-<vessel>-…", "<…>-<vessel>-…"). Returns a
 * vessel dir name that EXISTS under the runtime root, else null.
 */
/**
 * The file a gap says it is about, in the order the rest of this file already trusts:
 * `edit_site` first, then the legacy aliases, then a top-level field.
 *
 * `gap.file_path` alone is not enough — measured 2026-08-10 over the live store, 0 of
 * 360 gaps carried a top-level `file_path` while 104 carried
 * `classification_metadata.edit_site`. Reading only the former handed `undefined`
 * downstream and threw.
 */
export function gapEditSite(gap: Record<string, unknown>, meta: Record<string, unknown>): string | undefined {
  for (const f of ["edit_site", "file_path", "change_site", "path"] as const) {
    const v = meta?.[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const top = gap?.["file_path"];
  return typeof top === "string" && top.trim() ? top.trim() : undefined;
}

function identifyVessel(gap: Record<string, unknown>, meta: Record<string, unknown>): string | null {
  // 1. explicit metadata.vessel
  const mv = typeof meta.vessel === "string" ? meta.vessel.trim() : "";
  if (mv && vesselDirExists(mv)) return mv;
  // 2. a path field already names the vessel
  for (const f of ["edit_site", "file_path", "change_site", "path"]) {
    const v = meta[f];
    if (typeof v === "string") {
      const m = v.match(/(?:^|\/)(?:repos|vessels)\/([^/]+)\//);
      if (m && m[1] && vesselDirExists(m[1])) return m[1];
    }
  }
  // 3. vessel name embedded in the gap id. Match the LONGEST existing vessel dir whose
  //    name appears as a hyphen-bounded token run in the id (so "goal-host-vessel" wins
  //    over "vessel"). Only consider dirs that look like vessels (end with "-vessel" or
  //    "-api", or are a known top-level vessel) to avoid spurious single-word matches.
  const id = String(gap.id ?? "");
  let best: string | null = null;
  try {
    const dirs = readdirSync(runtimeRoot()).filter((d) => {
      try { return statSync(join(runtimeRoot(), d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      if (!/-(vessel|api)$/.test(d) && !/^(activity-api|goal-host-vessel)$/.test(d)) continue;
      // hyphen-bounded: "-<dir>-" or "-<dir>" at end, or "<dir>-" at start
      if (new RegExp(`(?:^|-)${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-|$)`).test(id)) {
        if (!best || d.length > best.length) best = d;
      }
    }
  } catch { /* readdir best-effort */ }
  return best;
}

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
  if (meta.parent_gap_id || /-step-\d+$/.test(parentId)) return { written: [], reason: "a decomposed step is not decomposed again" };
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
  const redNow = async (label: string, id: string, pred: Record<string, unknown>): Promise<{ ok: true } | { ok: false; why: string }> => {
    if (deferToHolder) return { ok: true };
    let v: GapCheckVerdict = "unknown";
    try { v = await judge({ id, classification_metadata: { ...pred } }); } catch { v = "unknown"; }
    return v === "present" ? { ok: true } : { ok: false, why: `${label}: its check reads ${v} on the current tree, not present` };
  };

  // k=0: THE PARENT'S OWN CHECK (parent-check mode).
  let parentCheck: Record<string, unknown> | null = null;
  let parentCheckNote = "";
  if (opts.parentCheck) {
    const pc = parsed.parent_check;
    if (pc && typeof pc === "object") {
      const f = pc as Record<string, unknown>;
      if (typeof f.expected_literal === "string" || typeof f.hardcoded_url === "string") {
        parentCheckNote = "parent check: a literal is not a parent check (a word absent now is trivially red)";
      } else {
        const v = await validateShapeCheck("parent check", f, [predicate]);
        if (!v.ok) parentCheckNote = v.why;
        else {
          const red = await redNow("parent check", parentId, v.predicate);
          if (!red.ok) parentCheckNote = red.why;
          else parentCheck = v.predicate;
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
    let childVerdict: "present" | null = null;
    const hasShape = typeof f.verify_shape === "string" || (!!f.evidence_resolve && typeof (f.evidence_resolve as { shape?: unknown }).shape === "string");
    if (hasShape) {
      const v = await validateShapeCheck(`step ${k}`, f, parentCheck ? [predicate, parentCheck] : [predicate]);
      if (!v.ok) { refusals.push(v.why); continue; }
      const red = await redNow(`step ${k}`, `${parentId}-step-${k}`, v.predicate);
      if (!red.ok) { refusals.push(red.why); continue; }
      childPredicate = v.predicate;
      childVerdict = deferToHolder ? null : "present";
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
      childVerdict ? { birthVerdict: { predicate_key: class2PredicateKey(childMeta), verdict: childVerdict } } : undefined,
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
      parentCheck && !deferToHolder ? { birthVerdict: { predicate_key: class2PredicateKey(parentMeta), verdict: "present" } } : undefined,
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
          const approvalWarning = (meta?.operator_approved === true || meta?.approval_boundary === "operator_approved") ? "" : (" — APPROVAL BOUNDARY: this gap has no operator approval. Only an operator can grant approval; code must never write, set or default operator_approved. The drafter MUST emit ZERO ops and report this boundary.");
          const anchorLabel = startLine > 0 ? ("Anchor (verbatim near edit site)" + premiseWarning + approvalWarning) : ("Anchor (verbatim top of file)" + premiseWarning + approvalWarning);
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

// LANDABILITY-RANKED SELECTION (2026-06-28). gap_to_feature historically picked gaps[0]
// (arbitrary order), so the autonomous loop kept selecting hard META/ARCHITECTURAL gaps
// (stale-proposal-backlog, decision-without-action, performance-inefficiency) that
// feature_compose cannot author a verifying surgical diff for -> UNFAVORABLE, 0 lands.
// Rank open gaps by a landability prior — prefer a CONCRETE edit-site + surgically-
// authorable categories, deprioritise meta/architectural — so the loop spends its
// authoring budget on gaps it can actually LAND + push. This RAISES the autonomous land
// rate (the residual after the autonomous-commit-on-dev demonstration).
const HARD_CATEGORIES = new Set([
  "architectural_pattern", "performance_inefficiency", "decision_without_action",
  "responsibility_misallocation", "learning_signal_degeneracy", "resolver_distribution",
]);
const SURGICAL_CATEGORIES = new Set([
  "missing_capability", "systematic_failure", "reference_integrity", "service_failure",
  "forward_model_artifact",
  // orphaned_capability lands via author_producer as a DIRECT activity mint (a
  // Thompson-selectable bridge invoking a live-but-unused resolver) — no
  // feature_compose + cutover needed. Its provisionable members mint immediately
  // (e.g. auto-bridge-repairPolicy), so it is genuinely MORE landable than the
  // hard feature classes; scoring it neutral (0.5) made the picker prefer
  // systematic_failure gaps that mostly UNFAVORABLE at the LLM frontier, starving
  // real capability expression. failed_attempts now culls the un-provisionable
  // orphaned members (MINT_FAILED bump, 2026-07-01), so boosting the class is safe:
  // the mintable ones land first, the rest deprioritise. (2026-07-01)
  "orphaned_capability",
  // documentation_drift lands via doc_drift_fix as a DIRECT single-file prose edit
  // with no feature_compose draft and no mitosis cutover — more landable than
  // hard feature classes, not less. (2026-08-26)
  "documentation_drift",
]);
// Decision-log categories are LOGS, not work — hard-zero so even if one leaks
// into the candidate window (belt-and-suspenders to the read-side exclusion) the
// picker can never select it over a real gap.
const NONACTIONABLE_LOG_CATEGORIES = new Set<string>(DECISION_LOG_GAP_CATEGORIES);
function landabilityScore(gap: Record<string, unknown>): number {
  const cat0 = String(gap.category ?? "");
  if (NONACTIONABLE_LOG_CATEGORIES.has(cat0)) return 0;
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let s = 0.5;
  // A concrete change-site means feature_compose knows exactly where to edit (surgical).
  if (meta.edit_site || meta.suspected_real_location || meta.change_site || meta.failing_capability || meta.file_path || meta.doc_path) s += 0.3;
  if (typeof meta.edit_site === "string" || meta.single_file === true || typeof meta.doc_path === "string") s += 0.1;
  const cat = String(gap.category ?? "");
  if (HARD_CATEGORIES.has(cat)) s -= 0.4;
  if (SURGICAL_CATEGORIES.has(cat)) s += 0.15;
  if (cat === "documentation_drift") s += 0.2;
  // ids that empirically cycle UNFAVORABLE (meta/diagnostic; no surgical diff exists).
  if (/stale-proposal|demand-trace|forward[_-]chain|backlog|unknown/i.test(String(gap.id ?? ""))) s -= 0.3;
  // A RECOMMIT IS A RETRY OF A KNOWN FAILURE, AND THE PRIOR COULD NOT SEE IT.
  // Measured over a matched 3-day window: non-recommit composes convert at 26.9%
  // (76 landings / 283 attempts) while recommit-depth-1 converts at 5.3% (6 / 113)
  // -- five times worse -- yet recommit is ~32% of all compose attempts against a
  // backlog of ~423 open gaps. A recommit gap is filed under a NEW id, so its
  // failed_attempts starts at 0 and the fa penalty below never fires: the selector
  // scored a retry exactly like fresh work. This is a SCORED down-weight, not a
  // gate: recommit still runs when the pool is thin, which preserves the 11.6% of
  // landings it does earn. NOT depth-scaled -- depth-2 measured 22% (4 / 18), no
  // worse than fresh work, so penalising it harder would contradict the evidence.
  if (/(^|-)recommit-/i.test(String(gap.id ?? ""))) s -= 0.15;
  // Deprioritise gaps that keep failing to land: each prior UNFAVORABLE attempt drops
  // the score, so the loop stops re-picking a stuck high-rank gap and moves to landable
  // work. Capped so a transient fail doesn't permanently bury a genuine gap.
  const fa = Number((meta as Record<string, unknown>).failed_attempts ?? 0);
  // Gaps with a concrete edit_site are surgical — each failure is a bad LLM
  // draft, not evidence the gap is unlandable. Cap the per-attempt penalty at
  // 0.1 (vs 0.2) for surgical gaps so the picker keeps revisiting them after
  // a transient UNFAVORABLE rather than burying them behind meta/diagnostic
  // gaps that have no failed attempts only because they were never picked.
  const hasConcreteSite = Boolean(meta.edit_site || meta.change_site || meta.single_file);
  // Per-gap failure lessons capture the exact mistake so the next LLM draft
  // avoids it — a gap with lessons is MORE landable on re-pick, not less.
  const hasLessons = Boolean((meta as Record<string, unknown>).per_gap_failure_lessons);
  const penalty = Math.min(fa * (hasConcreteSite ? 0.1 : 0.2), 0.4) - (hasLessons ? 0.05 : 0);
  s -= penalty;
  // Penalise gaps whose metadata points at the picker/composer itself — selecting
  // them creates a self-referential loop that never lands. blockingWeight > 1
  // means the gap targets core infrastructure; discount proportionally so the
  // picker deprioritises them relative to ordinary capability gaps.
  const bw = blockingWeight(gap);
  if (bw > 1) s -= Math.min(0.3, 0.1 * (bw - 1));
  return Math.max(0, Math.min(1, s));
}
function blockingWeight(gap: Record<string, unknown>): number {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let w = 1.0;
  const hay = [meta.edit_site, meta.failing_capability, meta.file_path, meta.root_cause]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/gap-to-feature|feature-compose|feature_compose|mitosis|cutover|drafter|fetchposteriorsforsignature|boredom-vessel/.test(hay)) w += 0.6;
  if (String(gap.category ?? "") === "self_development_reliability") w += 0.3;
  return Math.min(2.0, w);
}

/** Bounded so the pick cannot spawn a git subprocess per pooled gap. See chooseFirstActionable. */
export const PENDING_SCAN_MAX = 120; // 2026-09-03, Operation 2: widen the scan window to allow deeper scanning for actionable gaps

/**
 * Walk a score-ranked candidate list and return the highest-ranked entry that is NOT pending.
 *
 * Split out of pickMostLandable so the skip can be tested with an injected predicate instead of
 * a real git history. `isPending` is evaluated LAZILY and at most PENDING_SCAN_MAX times: the
 * real predicate (verifyGapCondition -> landedCommitVerdict) spawns `git log` per clone, so
 * evaluating a ~330-gap pool on every pick would cost hundreds of subprocesses.
 *
 * Fail-open: if every candidate inside the scan window is pending, the top entry is returned
 * unchanged and the post-selection guard refuses it exactly as before. That preserves today's
 * behaviour rather than returning null and starving the tick.
 */
export function chooseFirstActionable<T>(
  ranked: Array<{ g: T; s: number }>,
  isPending: (g: T) => boolean,
  scanMax: number = PENDING_SCAN_MAX,
): { chosen: { g: T; s: number }; skippedPending: number; scanExhausted?: boolean } {
  let skippedPending = 0;
  const limit = Math.min(ranked.length, scanMax);
  for (let i = 0; i < limit; i++) {
    const cand = ranked[i]!;
    if (isPending(cand.g)) { skippedPending++; continue; }
    return { chosen: cand, skippedPending };
  }
  const extendedLimit = Math.min(ranked.length, scanMax * 2);
  for (let i = limit; i < extendedLimit; i++) {
    const cand = ranked[i]!;
    if (isPending(cand.g)) { skippedPending++; continue; }
    return { chosen: cand, skippedPending, scanExhausted: true };
  }
  return { chosen: ranked[extendedLimit] ?? ranked[0]!, skippedPending, scanExhausted: true };
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

// ─────────────────── ACTIONABILITY ADMISSION GATE (auto-pick only, 2026-07-30) ───────────────────
// The autonomous loop's PROVEN-landable path is a gap that carries a CONCRETE edit target:
// EITHER (a) a metadata-cited EXISTING repos/<vessel>/src file, OR (b) a proposal report naming
// required_code_modifications[].file. The selection pool, however, gets FLOODED with candidates
// that can never land — they hollow every dispatch and starve the proven path:
//   • orphaned_capability / unreachable_producer gaps that demand a PRODUCER for a capability with
//     none. author_producer returns "zero producers" / "empty activities list", so once one has
//     failed to mint it is structurally un-provisionable — yet it keeps out-scoring real work and
//     re-selecting each tick (failed_attempts alone caps the penalty at 0.4 — not enough).
//   • PHANTOM typecheck gaps whose id/summary encode a TSxxxx at a vessel file that NO LONGER
//     errors (e.g. "…_goal_host_vessel_src_index_l619_ts2322_variant" while `bun run typecheck`
//     is EXIT=0 clean). The referenced defect is gone but the gap re-selects and re-drafts forever.
// This gate ADMITS a gap to the auto-pick set only when it is actionable, and RETIRES a typecheck
// gap whose error has already been fixed. Gaps are NOT deleted: an excluded orphan stays OPEN in the
// store, reachable by a targeted pointer.gap_id dispatch — it is only kept out of AUTO selection.
// CONSERVATIVE by design: the two structurally-unclosable classes above are the only HARD
// exclusions. A gap with genuinely-unknown actionability (a feature_compose-routed gap with no
// cited file/proposal) is LEFT ADMITTED — the downstream localizer (localizeGap) may still derive a
// site, and hard-excluding it here would regress the working grep-localized band.

const EXCLUDE_ORPHAN_AFTER_FAILS = 1; // an orphan/unreachable gap that already failed to mint = no producer
const TYPECHECK_CACHE_TTL_MS = parseInt(process.env.GAP_TYPECHECK_CACHE_TTL_MS ?? "300000", 10);
const TYPECHECK_MAX_RUNS_PER_PASS = parseInt(process.env.GAP_TYPECHECK_MAX_RUNS_PER_PASS ?? "3", 10);
const typecheckCleanCache = new Map<string, { clean: boolean; at: number }>();

/** (a) CHEAP: does the gap's metadata cite a concrete repos/<vessel>/src file that exists on disk? */
export function citedExistingFile(gap: Record<string, unknown>): string | null {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  for (const f of ["edit_site", "file_path", "change_site", "suspected_real_location"]) {
    const v = meta[f];
    if (typeof v !== "string" || !v.trim()) continue;
    let cand = v.trim().replace(/^\/vessels\//, "repos/").replace(/^\/+/, "");
    if (!/^repos\//.test(cand) && /^[^/]+\/(src|tests?)\//.test(cand)) cand = `repos/${cand}`;
    cand = cand.replace(/:[A-Za-z0-9_$]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (/^repos\/[^/]+\/.+\.(ts|tsx)$/.test(cand) && repoPathExists(cand)) return cand;
  }
  return null;
}

/** (b): the gap carries a proposal report naming required_code_modifications[].file that EXISTS. */
export function hasProposalReport(gapId: string): boolean {
  return existingEditTargets(gapId).length > 0;
}

/**
 * Parse a typecheck-class gap: one whose id/summary encodes a TSxxxx error at a specific vessel
 * source file (the phantom-churn shape). Returns { vessel, tsCode } when both a TS code and an
 * EXISTING vessel dir are derivable, else null (→ not a typecheck-class gap; no tsc run).
 */
export function typecheckClassOf(gap: Record<string, unknown>): { vessel: string; tsCode: string } | null {
  const id = String(gap.id ?? "");
  const summary = String(gap.summary ?? gap.title ?? "");
  const hay = `${id}\n${summary}`;
  // TSxxxx as a token — underscore-delimited ("_ts2322_") or spaced ("TS2322"); NOT inside a word
  // like "artifacts123". Underscore counts as a boundary here, so \b cannot be used.
  const tsm = hay.match(/(?:^|[^a-z0-9])ts[_\s-]?(\d{4})(?![0-9])/i);
  if (!tsm || !tsm[1]) return null;
  const tsCode = `TS${tsm[1]}`;
  let vessel: string | null = null;
  // underscore form embedded in the id: "…_typecheck_goal_host_vessel_src_index_l619_ts2322_variant".
  // Take the token run immediately BEFORE _src_ and walk suffixes so the LONGEST existing vessel dir
  // wins ("goal-host-vessel"), never a spurious superset ("typecheck-goal-host-vessel").
  const srcIdx = id.search(/_src[_/]/i);
  if (srcIdx > 0) {
    const parts = id.slice(0, srcIdx).split(/[_/]/).filter(Boolean);
    for (let start = 0; start < parts.length; start++) {
      const cand = parts.slice(start).join("-");
      if (/-(vessel|api)$/.test(cand) && vesselDirExists(cand)) { vessel = cand; break; }
    }
  }
  // repos/<vessel>/src path in id or summary
  if (!vessel) {
    const pm = hay.match(/repos\/([^/\s]+)\/src\//);
    if (pm && pm[1] && vesselDirExists(pm[1])) vessel = pm[1];
  }
  if (!vessel) {
    const iv = identifyVessel(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>);
    if (iv) vessel = iv;
  }
  if (!vessel) return null;
  return { vessel, tsCode };
}

export type TypecheckRunner = (vessel: string) => { ran: boolean; clean: boolean };
/** Default runner: `bun run typecheck` in the vessel's runtime dir. Bounded by a wall timeout. */
function defaultTypecheckRunner(vessel: string): { ran: boolean; clean: boolean } {
  try {
    const cwd = join(runtimeRoot(), vessel);
    if (!existsSync(join(cwd, "package.json"))) return { ran: false, clean: false };
    // LOG THE SPAWN. This is a blocking, whole-project typecheck run from inside gap
    // SELECTION, and until now it was completely silent — so the substrate could not
    // attribute its own CPU. That is the same defect as local-tools-vessel never logging
    // the commands it runs, and it is why the cost of selection had to be inferred
    // rather than measured. One line per run makes the next estimate a measurement.
    const startedAt = Date.now();
    const res = Bun.spawnSync(["bun", "run", "typecheck"], { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    console.log(`[gap-admission] typecheck vessel=${vessel} exit=${String(res.exitCode)} ms=${Date.now() - startedAt}`);
    return { ran: true, clean: res.exitCode === 0 };
  } catch {
    return { ran: false, clean: false };
  }
}

export interface AdmissionResult {
  admitted: Record<string, unknown>[];
  excluded: Array<{ id: string; reason: string }>;
}

/**
 * (E4) The admission exclusion for a gap whose recorded attempts all failed for the same reason, after lowercasing
 * and masking digits and hex runs (first 120 chars), or null. Measured 2026-09-12: 20-27 of ~1460 open gaps qualify.
 * Two predicates, kept from what were three copies of this block (the second was the first verbatim, so it never
 * fired): (1) at least 3 reasons over 20 chars and one distinct key, where an "== install" build-log reason counts
 * as a key of its own, so it breaks identity; labelled with the lesson count. (2) at least 3 keys over 20 chars once
 * "== install" reasons are dropped, all identical; that dump is the same for every failure, so it is not evidence.
 */
export function identicalRepeatedFailure(lessons: unknown): string | null {
  if (!Array.isArray(lessons)) return null;
  const reason = (l: unknown): string => String((l as Record<string, unknown> | null | undefined)?.["reason"] ?? "");
  const key = (r: string): string => r.toLowerCase().replace(/[0-9a-f]{8,}/g, "H").replace(/[0-9]+/g, "N").slice(0, 120);
  if (lessons.filter((l) => reason(l).trim().length > 20).length >= 3
    && new Set(lessons.map((l, i) => reason(l).toLowerCase().startsWith("== install") ? "undistilled-build-log-placeholder-" + i : key(reason(l))).filter((s) => s.length > 20)).size === 1) {
    return "identical_repeated_failure(" + lessons.length + ")";
  }
  const keys = lessons.map((l) => key(reason(l))).filter((s) => s.length > 20 && !s.startsWith("== install"));
  return keys.length >= 3 && new Set(keys).size === 1 ? "identical_repeated_failure" : null;
}

/**
 * Filter the AUTO-pick candidate set to actionable gaps. Excludes the two structurally-unclosable
 * classes (no-producer orphans, phantom typecheck-clean gaps) and RETIRES the phantom typecheck
 * gaps whose error is already fixed. See the block comment above for the full rationale. The
 * typecheckRunner is injectable for tests; the default shells `bun run typecheck` per vessel,
 * cached (TTL) and bounded (TYPECHECK_MAX_RUNS_PER_PASS) so tsc is never run per-gap.
 */
export async function admitActionableGaps(
  gaps: Record<string, unknown>[],
  opts?: { typecheckRunner?: TypecheckRunner },
): Promise<AdmissionResult> {
  // LANDINGS STOPPED → ADMIT NOTHING. MITOSIS_DIRECT_PUSH=0 is the emergency stop the cutover
  // refuses every landing on (vessel-mitosis-cutover.ts, push-policy.ts landingsStopped). An
  // auto-pick admitted here would pay for the typecheck pass below, an LLM draft and compose
  // worktrees, only to be refused at cutover. Same predicate, same semantics: only an explicit
  // "0" stops (unset or "1" proceeds, as the cutover does); a pure env read cannot be
  // unevaluable. This is the only admission call, and only the auto-pick branch (no gap_id)
  // reaches it, so targeted and operator-directed composes are unaffected. Checked first, so a
  // stopped pass costs neither the scope read nor a typecheck. One line per pass, not per gap.
  if (landingsStopped()) {
    const excludedAll = gaps.map((g) => ({ id: String(g.id ?? ""), reason: "landings_stopped" }));
    console.log(`[gap-to-feature] auto-pick admission: landings_stopped (MITOSIS_DIRECT_PUSH=0): ${gaps.length} candidates → 0 admitted, ${excludedAll.length} excluded`);
    return { admitted: [], excluded: excludedAll };
  }
  const runner = opts?.typecheckRunner ?? defaultTypecheckRunner;
  // One scope read for the whole pass, so every candidate is judged against the same answer.
  const scope = await autonomyScope();
  // An UNREADABLE scope excludes every autonomous candidate, sited or not (no partial admission):
  // nothing here can tell which ones touch the lane core. Reported under one reason key in the
  // usual admission line, so an admitted-zero pass says why.
  if (!scope.readable) {
    const why = scope.absent ? "autonomy_scope_absent" : "autonomy_scope_unreadable";
    console.log(`[gap-to-feature] autonomy scope ${scope.absent ? "absent" : "unreadable"}: excluding all autonomous candidates (${scope.reason})`);
    const excludedAll = gaps.map((g) => ({ id: String(g.id ?? ""), reason: `${why}(${scope.reason})` }));
    if (excludedAll.length) console.log(`[gap-to-feature] auto-pick admission: ${gaps.length} candidates → 0 admitted, ${excludedAll.length} excluded ${JSON.stringify({ [why]: excludedAll.length })}`);
    return { admitted: [], excluded: excludedAll };
  }
  const admitted: Record<string, unknown>[] = [];
  // Gaps naming no existing file. Collected rather than admitted so the fail-open check
  // below can see whether there is any groundable work to prefer over them.
  const ungroundable: Record<string, unknown>[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  const CHILD_GAP_MONOPOLY_THRESHOLD = 3; // Arbitrary, but a concrete limit. This may be tuned in the future.
  const childGapsByEditSite = new Map<string, number>();
  let tscRuns = 0;
  const passCache = new Map<string, boolean | null>(); // vessel -> clean? (this pass; null = unknown)
  const vesselTypecheckClean = (vessel: string): boolean | null => {
    if (passCache.has(vessel)) return passCache.get(vessel) ?? null;
    const now = Date.now();
    const cached = typecheckCleanCache.get(vessel);
    if (cached && now - cached.at < TYPECHECK_CACHE_TTL_MS) { passCache.set(vessel, cached.clean); return cached.clean; }
    if (tscRuns >= TYPECHECK_MAX_RUNS_PER_PASS) { passCache.set(vessel, null); return null; } // budget spent → unknown
    tscRuns++;
    const r = runner(vessel);
    if (!r.ran) { passCache.set(vessel, null); return null; }
    typecheckCleanCache.set(vessel, { clean: r.clean, at: now });
    passCache.set(vessel, r.clean);
    return r.clean;
  };

  const MAX_ADMITTED_PER_EDIT_SITE_PER_CYCLE = 2;
  const admittedPerEditSite = new Map<string, number>();
  // vessel -> push_scope_refused reason, or null when the landing gate allows it (this pass only).
  const pushScopeRefusalByVessel = new Map<string, string | null>();

  for (const g of gaps) {
    const id = String(g.id ?? "");
    const cat = String(g.category ?? "");
    const meta = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
    const failedAttempts = Number(meta.failed_attempts ?? 0);

    const ownedVessel = identifyVessel(g, meta);
    const ownedSet = ownedVessels();
    if (ownedVessel && ownedSet.size > 0 && !ownedSet.has(ownedVessel)) {
      excluded.push({ id, reason: `not owned here(${ownedVessel})` });
      continue;
    }
    // PROTECTED VESSELS never cut over (vessel-mitosis-start.ts and vessel-mitosis-cutover.ts
    // refuse them), so a pick aimed at one spends a compose on a landing that cannot happen:
    // 19 of 123 auto-picks in the 24 h to 2026-09-26 10:20. Same set as those two files.
    if (ownedVessel === "discovery-vessel" || ownedVessel === "identity-vessel") {
      excluded.push({ id, reason: `protected_vessel(${ownedVessel})` });
      continue;
    }
    // PUSH SCOPE AT ADMISSION (value-per-cost-selection 2.1). The cutover refuses a landing
    // whose push remote is out of scope (vessel-mitosis-cutover.ts gateLanding), but only
    // after the draft was paid for. Ask the same gate here, once per vessel per pass, on the
    // clone the cutover pushes from (MITOSIS_PUSH_CLONE_DIR/<vessel> in direct-push mode).
    // The cutover stays the final authority and owns the kill switch. Fail-open on any error.
    if (ownedVessel) {
      if (!pushScopeRefusalByVessel.has(ownedVessel)) {
        let refusal: string | null = null;
        try {
          const pushCloneRoot = process.env["MITOSIS_PUSH_CLONE_DIR"];
          if (pushCloneRoot && process.env["MITOSIS_DIRECT_PUSH"] === "1") {
            const proc = Bun.spawnSync(["git", "-C", join(pushCloneRoot, ownedVessel), "remote", "get-url", "--push", "origin"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
            const landingGate = gateLanding({
              remoteUrl: proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : null,
              branch: "dev",
            });
            if (landingGate.kind === "push_scope_refused") refusal = landingGate.reason;
          }
        } catch { refusal = null; }
        pushScopeRefusalByVessel.set(ownedVessel, refusal);
        if (refusal) console.log(`[gap-admission] push_scope_refused vessel=${ownedVessel} reason=${refusal}`);
      }
      if (pushScopeRefusalByVessel.get(ownedVessel)) {
        excluded.push({ id, reason: `push_scope_refused(${ownedVessel})` });
        continue;
      }
    }
    // ACTIONABLE-ONLY ADMISSION (value-per-cost-selection 2.2). A gap with no edit site and no
    // class1/class2 falsifier gives compose nothing to edit and nothing to verify against; it
    // needs information (investigation), not a draft. Excluded on every pick, whether or not a
    // proposal report exists, so the one-shot investigated_at route cannot re-admit it.
    // Orphan-producer gaps route to author_producer, not compose; a recommit gap with a
    // source_gap_id inherits its site after selection; a typecheck-class gap (typecheckClassOf, the
    // phantom-typecheck predicate below) is decided by that check. All keep their existing routes.
    {
      const hasEditSite = !!(meta.edit_site || meta.file_path || meta.change_site || meta.suspected_real_location || g.file_path);
      const falsifierClass = String(meta.falsifier ?? "").toLowerCase();
      const orphanRoute = cat === "orphaned_capability" || cat === "unreachable_producer" || /orphaned[_-]capability/i.test(id);
      if (!hasEditSite && falsifierClass !== "class1" && falsifierClass !== "class2" && !orphanRoute && !meta.source_gap_id && !typecheckClassOf(g)) {
        excluded.push({ id, reason: `needs_information(falsifier=${falsifierClass || "unset"})` });
        continue;
      }
    }
    // AUTONOMY SCOPE (contained-self-development 1.2). Admission is the autonomous path, so a gap
    // whose edit site is in the lane core is refused here, before any draft. Directed goals never
    // come through admission. The compose verdict re-checks the paths actually touched.
    {
      const siteForScope = String(meta.edit_site || meta.file_path || meta.change_site || meta.suspected_real_location || g.file_path || "");
      if (siteForScope) {
        const scopeHit = autonomyScopeExcludes(scope, siteForScope);
        if (scopeHit) {
          excluded.push({ id, reason: `autonomy_scope(${scopeHit})` });
          continue;
        }
      }
      // The semantic gate writes where the fix really belongs. When that is an excluded path, every draft
      // at the gap's own edit_site is refused as not addressing it (obsidian authoring-root: 6 refusals on
      // 09-27, each naming self-fact-reconcile.ts), so the gap is out of autonomous reach.
      // A RELOCATION HINT into an excluded path is operator work: the own check's failing assertion exercises a
      // file the lane may not edit, so every autonomous draft would fail it again. The gap keeps the hint, is
      // parked (needs_information) and carries an operator routing marker naming the files. A hint inside the
      // scope never excludes on its own.
      const hintFiles = ((meta.relocation_hint as { files?: unknown } | undefined)?.files);
      const hinted = Array.isArray(hintFiles) ? hintFiles.filter((h): h is string => typeof h === "string") : [];
      const hintHit = hinted.map((h) => autonomyScopeExcludes(scope, h)).find((h): h is string => !!h);
      if (hintHit) {
        excluded.push({ id, reason: `autonomy_scope(relocation_hint ${hintHit})` });
        if (!(meta.operator_routing as { files?: unknown } | undefined)?.files) {
          // A MERGE: only the two keys are sent; the store carries every omitted key (the hint among them) forward.
          const routingMeta: Record<string, unknown> = {
            ...(isParkingDisposition(meta.disposition) ? {} : { disposition: "needs_information" }),
            operator_routing: { reason: `the own check's failing assertion exercises ${hintHit}, outside the autonomy scope (relocation_hint)`, files: hinted, at: new Date().toISOString() },
          };
          try {
            const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: g.status ?? "open", classification_metadata: routingMeta } } as never);
            if (w?.shape === "structuredError") console.warn(`[gap-admission] gap ${id}: operator routing marker REFUSED (${JSON.stringify(w.body).slice(0, 200)}); the exclusion stands without it`);
          } catch (err) {
            console.warn(`[gap-admission] gap ${id}: operator routing marker not written (${(err as Error)?.message ?? String(err)}); the exclusion stands without it`);
          }
        }
        continue;
      }
      const suspectedSite = String(meta.suspected_real_location ?? "").replace(/:[^/]*$/, "");
      if (suspectedSite && suspectedSite !== siteForScope) {
        const suspectedHit = autonomyScopeExcludes(scope, suspectedSite);
        if (suspectedHit) {
          excluded.push({ id, reason: `autonomy_scope(suspected_real_location ${suspectedHit})` });
          continue;
        }
      }
    }
    // An operator hold removes a gap from autonomous work. The picker's skip honours it, but falls back to
    // the top-ranked candidate when every candidate is skipped, so a held gap was picked every 1.5-3 min
    // (09-27 22:20-22:29) and refused at compose. Excluded here, the fallback cannot reach it.
    if (meta.operator_hold === true) { excluded.push({ id, reason: "operator_hold" }); continue; }
    // A disposition that parks the gap for a human was a label nobody read: an unlocalized needs_information gap
    // was picked on 2026-09-30 12:21 (for a stale test its only green is changing src to match it).
    if (isParkingDisposition(meta.disposition)) { excluded.push({ id, reason: `disposition(${String(meta.disposition)})` }); continue; }
    // A landing awaiting its verdict is not compose work: re-drafting it spends a draft on code that may already be
    // fixed (2026-09-30: 35 of 75 compose2 picks went to gaps whose own commit had landed). Re-admitted once the
    // landing is known not to have fixed it (regressed_by, BEHAVIORAL VERIFICATION FAILED, or the sweep's release).
    if (isAwaitingLandVerification(g)) { excluded.push({ id, reason: "disposition(pending_verification)" }); continue; }
    // Its own check already passes on the parent (op10 terminal refusal): re-picking cannot help until the sweep
    // closes it or an operator looks, so it waits out OWN_GREEN_ADMISSION_TTL_MS instead of a cooldown per cycle.
    if (greenOnParentFresh(meta)) { excluded.push({ id, reason: "own_check_green_on_parent" }); continue; }
    // PREDICATE SUSPECT (contained-self-development 8.5; gap_falsify v2). A class-2 check that did not read
    // 'present' when it was written has never seen the defect: a landing "verified" by it verifies nothing.
    // The write seam stamps the birth verdict; rows that predate it carry none and are unaffected.
    { const suspect = predicateSuspect(meta); if (suspect) { excluded.push({ id, reason: `predicate_suspect(${suspect})` }); continue; } }
    // FALSIFIER REQUIRED (contained-self-development). When the autonomyScope record names
    // require_falsifier_classes, an autonomous gap is admitted only if its falsifier is one of them;
    // otherwise it needs information, whatever its edit site. A typecheck-class gap keeps its own
    // machine check (tsc). No field: unchanged.
    {
      const requiredClasses = scope.requireFalsifierClasses;
      // A typecheck-class gap keeps its own machine check only while its vessel FAILS typecheck now:
      // a TS code carried into a summary by a failed attempt's lesson otherwise admitted the
      // fs-edit gap (local-tools typechecks clean) and redrafted it four times.
      const typecheckClass = typecheckClassOf(g);
      const typecheckFailingNow = typecheckClass ? vesselTypecheckClean(typecheckClass.vessel) === false : false;
      if (requiredClasses && requiredClasses.length > 0 && !typecheckFailingNow) {
        const rawFalsifier = meta.falsifier as unknown;
        const gapFalsifierClass = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
        if (!requiredClasses.includes(gapFalsifierClass)) {
          excluded.push({ id, reason: `needs_information(falsifier=${gapFalsifierClass || "unset"}; autonomyScope requires ${requiredClasses.join("/")})` });
          continue;
        }
        // A class2 check with no measured field reads 'unknown' in the sweep forever: its landing can be
        // neither closed nor recorded as falsified. c4bb14d (09-27 22:01) landed on such a step, hard-coded
        // a restart count to 0, and nothing in the system could say so.
        if (gapFalsifierClass === "class2") {
          const er = meta.evidence_resolve as Record<string, unknown> | null | undefined;
          const measured = !!er && typeof er === "object" && ["zero_field", "nonzero_field", "defect_field"].some((fk) => typeof er[fk] === "string");
          if (!measured) { excluded.push({ id, reason: "needs_information(class2 check names no zero_field/defect_field, so its landing could never be judged)" }); continue; }
        }
      }
    }
    // Increment child gap count if this is an auto-minted child gap.
    if (id.startsWith("recommit-") || id.endsWith("-narrowed")) {
      const editSite = String(meta.edit_site ?? "");
      if (editSite) {
        childGapsByEditSite.set(editSite, (childGapsByEditSite.get(editSite) ?? 0) + 1);
      }
    }

    // (E5) EDIT_SITE_SATURATED — cap the number of gaps admitted per distinct edit_site file per cycle.
    // Measured 2026-09-12: 57% of open gaps are auto-minted children; two files received 57% of compose attempts.
    // Fairness across files matters more than depth on one file; a file that has failed 161 times in a day
    // is not one attempt away from succeeding. Cap at a small share so the cap=1 compose lane serves diverse goals.
    try {
      const editSiteForCap = String(meta.edit_site ?? "");
      // human_reported gaps are EXEMPT from the site cap: the cap exists to stop auto-minted child churn (57% of attempts on two files, measured 2026-09-12), but it runs at ADMISSION in iteration order, BEFORE human_reported pick-weighting — so an operator-filed gap on a busy file was starved indefinitely behind route-edit children at the same site (measured 2026-09-20: gap-transform-oracle-verdict-line-omits-the-checked-address, 90 minutes, zero attempts, while the site cap excluded 58-59 gaps per cycle). Operator gaps are rare; exempting them cannot recreate the churn the cap prevents.
      if (editSiteForCap && String(g.source ?? "") !== "human_reported") {
        const admittedAtSite = admittedPerEditSite.get(editSiteForCap) ?? 0;
        if (admittedAtSite >= MAX_ADMITTED_PER_EDIT_SITE_PER_CYCLE) {
          excluded.push({ id, reason: `edit_site_saturated(${editSiteForCap})` });
          continue;
        }
        admittedPerEditSite.set(editSiteForCap, admittedAtSite + 1);
      }
    } catch { /* fail-open: admit as before */ }

    // (E4) IDENTICAL REPEATED FAILURE — a gap whose every recorded attempt failed for the
    // same normalized reason will fail that way again, so each retry burns a scarce LLM
    // completion for a guaranteed loss (see identicalRepeatedFailure).
    // FAIL-OPEN by construction: any parse or shape problem admits exactly as before.
    try {
      const editSite = String(meta.edit_site ?? "");
      const childGapsAtEditSite = childGapsByEditSite.get(editSite) ?? 0;
      if (editSite && childGapsAtEditSite >= CHILD_GAP_MONOPOLY_THRESHOLD) {
        excluded.push({ id, reason: `child_gap_monopoly_at_edit_site(${editSite})` });
        continue;
      }
      const repeated = identicalRepeatedFailure(meta.failure_lessons);
      if (repeated) {
        excluded.push({ id, reason: repeated });
        continue;
      }
    } catch { /* fail-open: admit as before */ }

    // (E3) PHANTOM ANCHOR — retire a gap whose quoted anchor is already gone from the file
    // it names. Measured 2026-09-11: 17 of 600 open gaps cite a complete anchor with zero
    // occurrences in their named file, so every retry must fail anchor_not_found forever.
    // FAIL-OPEN by construction: any parse, path or read problem admits exactly as before.
    try {
      const phantomSummary = String(g.summary ?? "");
      const phantomAnchor = phantomSummary
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .find((l) => (l.startsWith("const ") || l.startsWith("let ") || l.startsWith("function ")) && l.endsWith(";") && l.length > 20);
      const phantomSite = String(meta.edit_site ?? "").split(":")[0];
      if (phantomAnchor && phantomSite?.startsWith("repos/") && failedAttempts >= 2) {
        const phantomRoot = process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";
        const phantomParts = phantomSite.split("/");
        const phantomAbs = phantomRoot + "/" + phantomParts[1] + "/" + phantomParts.slice(2).join("/");
        if (existsSync(phantomAbs) && !readFileSync(phantomAbs, "utf8").includes(phantomAnchor)) {
          excluded.push({ id, reason: "phantom_anchor(" + phantomParts[1] + ")" });
          continue;
        }
      }
    } catch { /* fail-open: admit as before */ }

    // (E2) PHANTOM TYPECHECK — retire when the referenced error is already gone.
    const tc = typecheckClassOf(g);
    if (tc) {
      const clean = vesselTypecheckClean(tc.vessel);
      if (clean === true) {
        excluded.push({ id, reason: `typecheck_clean_phantom(${tc.vessel}:${tc.tsCode})` });
        // The write and re-stamp are removed from the pick path to resolve timeout issues.
        // The gap will still be excluded from consideration and closed by a separate background process.
        continue;
      }
      // clean === false (error still present) or null (unknown / over budget) → fall through:
      // a typecheck gap that still errors and cites a real file is genuinely actionable.
    }

    // (b) PROPOSAL-BACKED — the proven-landable path. ALWAYS admit (route unchanged).
    if (hasProposalReport(id)) { admitted.push(g); continue; }
    // (a) metadata cites a real EXISTING repos/<vessel>/src file.
    if (citedExistingFile(g)) { admitted.push(g); continue; }

    // (E1) ORPHAN / UNREACHABLE PRODUCER — no editable target; closes via author_producer /
    // reachability_gap_repair, not feature_compose. Admit a FRESH one for its single mint attempt,
    // but exclude once it has already failed to mint (structurally un-provisionable = "no producer")
    // or lacks the `shape` its route needs.
    const isOrphanClass = cat === "orphaned_capability" || cat === "unreachable_producer" || /orphaned[_-]capability/i.test(id);
    if (isOrphanClass) {
      const shape = String(meta.shape ?? "").trim();
      if (failedAttempts >= EXCLUDE_ORPHAN_AFTER_FAILS) { excluded.push({ id, reason: `orphan_no_producer(failed=${failedAttempts})` }); continue; }
      if (cat === "orphaned_capability" && !shape) { excluded.push({ id, reason: "orphan_missing_shape" }); continue; }
      admitted.push(g); // one auto-shot for a provisionable-looking orphan
      continue;
    }

    // NO GROUNDABLE TARGET. This branch used to read "do NOT hard-exclude; the localizer may
    // still derive a site downstream" and admit. Measured on the live fleet 2026-08-31
    // 01:55-03:16, that assumption is false: 14 picks produced 12
    // `[fc-grounding] REFUSED ungrounded decompose; targetFiles=[] verify_vessels=[]` and
    // ZERO compose reports. The localizer never derived a site — grounding refuses first.
    //
    // Reaching here means neither hasProposalReport nor citedExistingFile matched, i.e. the
    // gap names no file that exists. feature-compose's grounding gate rejects exactly that
    // input, deterministically, so admitting it spends a compose slot to be told no. At a
    // lane capacity of ~2 composes/hour that was the ENTIRE budget, and it was invisible
    // from outside: a refusal claims and releases a slot without creating a worktree, so the
    // lane reads idle (load 4, 0 slots held) while fully consumed.
    //
    // Deferred, not condemned — and NOT excluded on failed_attempts, which would recreate
    // hopeless() at gap grain (see the picker-starves gap's own do_not_fix_by). The test is
    // a property of the gap: does it name a file that exists. Give it a target and it is
    // admitted on the very next tick. A targeted `pointer.gap_id` dispatch bypasses this
    // gate entirely, so an operator can still force one.
    // DISAGREEMENT ADJUDICATION (2026-09-19). A gap describing an execution-vs-
    // verification disagreement names no file, so it parked here as ungroundable —
    // measured on gap-probe-count-execution-and-verification-disagree: event pickup
    // fired in 1s, then attempts=0 forever, and the only improvised action trusted
    // the WRONG mechanism (formulated writing the verifier's expected value over a
    // correct producer result). Adjudicate instead of defer: recompute the disputed
    // transform with an executable method, attribute the fault by comparing the
    // verifier's stated expectation against the recomputation, mint the edit_site
    // both mechanisms share (goal-host hosts the floor producer AND the reach
    // verifier), and admit the gap to the repair lane THIS tick. Fail-open: any
    // parse or compute failure falls through to the ungroundable deferral unchanged.
    try {
      const summaryText = String(g.summary ?? "");
      const disputed = summaryText.match(/\b(sha-?256|base64|reverse|uppercase|lowercase|lettercount|product)\((\S{1,120})\)/i);
      if (/disagree|mismatch/i.test(summaryText) && disputed && disputed[1] && disputed[2]) {
        const family = disputed[1].toLowerCase().replace("-", "");
        const operand = disputed[2].trim();
        let truth = "";
        if (family === "sha256") { const { createHash } = await import("node:crypto"); truth = createHash("sha256").update(operand, "utf8").digest("hex"); }
        else if (family === "base64") { truth = Buffer.from(operand, "utf8").toString("base64"); }
        else if (family === "reverse") { truth = operand.split("").reverse().join(""); }
        else if (family === "uppercase") { truth = operand.toUpperCase(); }
        else if (family === "lowercase") { truth = operand.toLowerCase(); }
        else if (family === "lettercount") { truth = String(operand.replace(/-/g, "").length); }
        else if (family === "product") { const pm = operand.match(/(\d{1,9})\s*[*xX×]\s*(\d{1,9})/); if (pm && pm[1] && pm[2]) truth = String(Number(pm[1]) * Number(pm[2])); }
        const expectedMatch = summaryText.match(/determines\s+([A-Za-z0-9+/=._-]+)\s+for\b/);
        const verifierExpected = expectedMatch && expectedMatch[1] ? expectedMatch[1] : "";
        if (truth && verifierExpected) {
          const wrongMechanism = verifierExpected === truth ? "producer" : "verifier";
          const adjudicated = {
            ...meta,
            edit_site: "repos/goal-host-vessel/src/index.ts",
            adjudication: { family, operand, recomputed_truth: truth, verifier_expected: verifierExpected, wrong_mechanism: wrongMechanism, method: "in-process executable recomputation", adjudicated_at: new Date().toISOString() },
          } as Record<string, unknown>;
          try {
            await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, classification_metadata: adjudicated, status: "open" } } as never);
          } catch { /* write-back is best-effort; in-memory admission still proceeds */ }
          (g as { classification_metadata?: Record<string, unknown> }).classification_metadata = adjudicated;
          console.log(`[gap-adjudicate] ${id}: recomputed ${family}(${operand})=${truth}; verifier expected ${verifierExpected} -> ${wrongMechanism} is wrong; edit_site minted, admitted`);
          admitted.push(g);
          continue;
        }
      }
    } catch { /* fail-open: defer as ungroundable below */ }
    ungroundable.push(g);
  }

  // FAIL OPEN. If deferring the ungroundable would leave nothing to work on, admit them
  // anyway: a starved lane is worse than a refused compose, and this gate must never be the
  // reason the substrate stops trying. Only skip them when there is real work to do instead.
  // Under containment (the autonomyScope record requires falsifier classes) a target-less gap is
  // never autonomous work: failing open onto them spent node 1's only slot on leaked test-fixture
  // gaps (falsifier-merge/pair/c2/heal-*), each refusal minting another -narrowed child.
  const containedAdmission = (scope.requireFalsifierClasses ?? []).length > 0;
  if (admitted.length === 0 && !containedAdmission) {
    for (const g of ungroundable) admitted.push(g);
    if (ungroundable.length) {
      console.log(`[gap-to-feature] auto-pick admission: no groundable candidates; failing open on ${ungroundable.length} ungroundable`);
    }
  } else {
    for (const g of ungroundable) excluded.push({ id: String(g.id ?? ""), reason: "no_groundable_target" });
  }

  if (excluded.length) {
    const byReason: Record<string, number> = {};
    for (const e of excluded) { const k = e.reason.replace(/\(.*$/, ""); byReason[k] = (byReason[k] ?? 0) + 1; }
    console.log(`[gap-to-feature] auto-pick admission: ${gaps.length} candidates → ${admitted.length} admitted, ${excluded.length} excluded ${JSON.stringify(byReason)}`);
  }
  return { admitted, excluded };
}

// CLOSE-ON-LAND (2026-06-29). A landed gap previously stayed status:open, so the
// landability-ranked picker could re-select the SAME (now-fixed) gap each tick — its
// staged fix re-applies as a no-op / fails to anchor (the change is already in source),
// wasting cycles and starving the OTHER open gaps. The fix: when a gap's fix GENUINELY
// LANDS on origin/dev, mark it status:"closed" so the open-filtered picker advances
// through the backlog. Genuine land is a HIGH bar — closing too eagerly would lose a
// real gap. We require ALL of:
//   - verdict === "FAVORABLE" (typecheck-clean, semantic-gate-passed), AND
//   - land was requested (pointer.land, i.e. NOT dry_run), AND
//   - at least one cutover whose result is a cutoverApplied shape with
//     push_status === "pushed" (a REAL push to origin/dev with a new commit sha).
// A merely-staged FAVORABLE (no push clone), a soft-refuse (applied:false), a
// local_only / host_sync_pending / skipped push (incl. skip_push test mode), or an
// UNFAVORABLE result is NOT a genuine land → the gap stays open. dry_run never closes.
interface LandSignal {
  landed: boolean;
  commit_sha: string | null;
  vessel: string | null;
  push_status: string | null;
}
function genuineLandSignal(composeBody: Record<string, unknown>, landRequested: boolean): LandSignal {
  const none: LandSignal = { landed: false, commit_sha: null, vessel: null, push_status: null };
  if (!landRequested) return none;
  if (composeBody?.verdict !== "FAVORABLE") return none;
  const cutovers = Array.isArray(composeBody.cutovers) ? composeBody.cutovers : [];
  for (const c of cutovers) {
    const co = (c ?? {}) as Record<string, unknown>;
    const result = (co.result ?? {}) as Record<string, unknown>;
    // A successful cutover returns the cutoverApplied body (push_status + new_git_sha).
    // The soft-refuse / no-op paths also carry shape:"cutoverApplied" but with
    // applied:false and push_status not "pushed" — so gate strictly on "pushed".
    if (result.push_status === "pushed") {
      const sha = typeof result.new_git_sha === "string" && result.new_git_sha.trim() ? result.new_git_sha.trim() : null;
      return {
        landed: true,
        commit_sha: sha,
        vessel: typeof co.vessel === "string" ? co.vessel : (typeof result.vessel_name === "string" ? result.vessel_name : null),
        push_status: "pushed",
      };
    }
  }
  return none;
}

/**
 * Verify whether a gap's condition still holds in the file system.
 * For surgical gaps with edit_site + hardcoded_url in classification_metadata:
 *   returns 'present' if the literal is still in the file, 'absent' if gone, 'unknown' otherwise.
 * For resolver-behaviour gaps with evidence_resolve or verify_shape in classification_metadata:
 *   POSTs to the vessel's own resolve endpoint, inspects the body for the defect signature
 *   (fetch_error field, or zero/empty value where ground truth is nonzero), returns
 *   'present' (defect still there), 'absent' (resolved healthy), 'unknown' on transport failure.
 * 'unknown' preserves today's behaviour — no false closes, no blocked closes.
 */
/**
 * CLASS 1b — INVERSE POLARITY. `expected_literal` PRESENT means FIXED; ABSENT means the
 * defect is still there (or has regressed).
 *
 * WHY THIS HAS TO EXIST. Class 1 can only say "this bad literal is still in the file". It
 * cannot say "this good guard is missing" — and that missing polarity is why automated
 * predicate derivation has failed twice on this fleet (be26a6b, reverted by 8a5223c).
 *
 * The proof is a real autonomous repair. Gap groupbounded-fix-not-propagated was fixed
 * correctly by Substrate Autonomous in local-tools-vessel 4d0c600 (FAVORABLE, pushed), which
 * INSERTED a guard:
 *     ( sleep t;                    __killtree $__cpid; kill -9 -$__cpid )
 *  -> ( sleep t; kill -0 $__cpid && __killtree $__cpid; kill -9 -$__cpid )
 * Measured with grep -c -F on both trees: the defect literal `kill -9 -$__cpid 2>/dev/null`
 * occurs ONCE at 4d0c600^ and ONCE at 4d0c600. The fix was ADDITIVE, so the cited literal
 * SURVIVED it. A Class-1 predicate — even one derived at gap-CREATION time, when the defect
 * genuinely was present — would still read 'present' after the correct fix, bypass the
 * pending->skip-re-compose guard, and manufacture a re-land. Moving derivation earlier does
 * not help: the polarity is what is wrong.
 *
 * Additive fixes are the COMMON case, not an edge case — adding an --exclude-dir, a capacity
 * guard, a transaction retry, a range branch. None remove a literal a detector would cite.
 *
 * STRICTLY ADDITIVE BY CONSTRUCTION: both call sites gate on `!hardcodedUrl`, so no gap
 * carrying a Class-1 predicate today can change verdict. A gap opts in by carrying
 * expected_literal and no hardcoded_url.
 */
/** Comment-stripped text of every body of `reader` in `src`: a definition (function reader( / reader = ( /
 *  reader = async ( / a method reader(…) {) or a call taking a callback (afterAll(() => { … })). Brace-matched from
 *  the first "{" after the name, skipping string and template literals. [] when the reader is not found. */
/** Index of the body "{" that follows a parameter list ending just before `from`, or -1. An optional return-type
 *  annotation (": T") is skipped as ONE balanced type expression, so a "{" inside it (Promise<{ a: number }>, or a
 *  type literal { a: number }) is never mistaken for the body, and a literal that exists only in the return type can
 *  never count as in-body (qa, 2026-09-30). Then "=>" (arrow) or "{" (function) must follow; an expression-bodied
 *  arrow has no braced body and returns -1. */
function bodyAfterParams(src: string, from: number): number {
  let i = from;
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  ws();
  if (src[i] === ":") {
    i++;
    let depth = 0, started = false, q: string | null = null;
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (q) { if (ch === "\\") { i++; continue; } if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { q = ch; started = true; continue; }
      if (depth === 0 && ch === "=" && src[i + 1] === ">" && started) break;
      if (depth === 0 && ch === "{" && started) break;
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") { depth++; started = true; continue; }
      if (ch === ">" || ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
      if (!/\s/.test(ch)) started = true;
    }
  }
  ws();
  if (src[i] === "=" && src[i + 1] === ">") { i += 2; ws(); }
  return src[i] === "{" ? i : -1;
}

export function readerBodies(src: string, reader: string): string[] {
  const esc = reader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:function\\s+" + esc + "\\b|\\b" + esc + "\\s*(?:=\\s*(?:async\\s*)?)?\\()", "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // The body must belong to THIS occurrence: a callback inside the call's own parentheses (afterAll(() => {…})),
    // or a "{" right after the closing ")" (optionally past a return type / "=>") as in a definition. A plain call
    // such as searchTemplates(q) has no body, and the next "{" further down belongs to something else.
    const lp = src.indexOf("(", m.index);
    if (lp < 0) continue;
    let pd = 0, rp = -1;
    for (let j = lp; j < src.length; j++) { const c = src[j]; if (c === "(") pd++; else if (c === ")") { pd--; if (pd === 0) { rp = j; break; } } }
    if (rp < 0) continue;
    // A DEFINITION (function R( / R = ( / R = async () owns only the "{" after its parameters: a "{" inside them is a
    // destructuring pattern, not a body. A CALL (R() may be a method definition (body after ")") or take a callback
    // whose body is the "{" inside its own parentheses (afterAll(() => {…})).
    const isDefinition = /^function\b|=/.test(m[0]);
    let open = bodyAfterParams(src, rp + 1);
    if (open < 0 && !isDefinition) { const inner = src.indexOf("{", lp); if (inner >= 0 && inner < rp) open = inner; }
    if (open < 0) continue;
    let depth = 0, i = open, q: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === "`") { q = c; continue; }
      if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    if (depth === 0) out.push(src.slice(open, i + 1).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1"));
  }
  return out;
}

/** A decomposed step's literal counts only in comment-free code INSIDE its literal_reader: anywhere else in the file
 *  (a comment, an unrelated function, a module-level constant) proves nothing about the reader. null = the reader
 *  cannot be located (unknown, never 'fixed'). */
export function literalInReaderBody(src: string, literal: string, reader: string): boolean | null {
  const bodies = readerBodies(src, reader);
  if (bodies.length === 0) return null;
  return bodies.some((b) => b.includes(literal));
}

function evaluateExpectedLiteral(editSite: string, expectedLiteral: string, literalReader?: string): 'present' | 'absent' | 'unknown' {
  const runtimePath = join(runtimeRoot(), editSite.replace(/^\//, '').replace(/^repos\//, ''));
  if (!existsSync(runtimePath)) return 'unknown';
  const contents = readFileSync(runtimePath, 'utf8');
  // A decomposed step names the function that must read its literal; whole-file presence closed steps on a comment,
  // an unrelated constant (a782ec1) or a helper the draft invented (qa + operator, 2026-09-30).
  if (literalReader) {
    const inReader = literalInReaderBody(contents, expectedLiteral, literalReader);
    return inReader === null ? 'unknown' : inReader ? 'absent' : 'present';
  }
  // PRESENT means the fix is in place, so the DEFECT is absent. Inverse of Class 1.
  return contents.includes(expectedLiteral) ? 'absent' : 'present';
}

/** A decomposed step closed ONLY by its literal is not a verification: the literal names new code, so its presence
 *  proves only that the new code exists (0f7e688 closed landed_verified on such a literal and was a regression). It
 *  still closes (so it is not re-landed), recorded as landed_literal_only with falsifier_exercise.passed=false. */
export function isLiteralOnlyStepClose(meta: Record<string, unknown>): boolean {
  return meta["predicate_source"] === "decompose" && typeof meta["expected_literal"] === "string" && (meta["expected_literal"] as string).trim() !== ""
    && !meta["evidence_resolve"] && !meta["verify_shape"];
}

/**
 * Non-empty string, else null. Empty string counts as ABSENT deliberately: it is the only
 * way to retire a bad predicate, because substrate-gap.ts:522-524 carries any key omitted
 * from a write forward from the existing row — gap metadata cannot be deleted.
 */
function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Exported for unit test only — same reason chooseFirstActionable and requeueAfterNonAttempt
// are: the behaviour is worth pinning without a live pool. No call-site change.
export function verifyGapCondition(gap: Record<string, unknown>): 'present' | 'absent' | 'pending' | 'unknown' {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): if this gap declares a Class-2
    // measurement predicate (evidence_resolve / verify_shape), the async sibling must run it —
    // do NOT let the sync landed-commit provenance short-circuit a measurable gap. Defer to async.
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
    // Prefer clean file_path field (surgical-gap-scan writes this without line suffix);
    // fall back to edit_site but strip trailing ':<digits>' line suffix if present.
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      // editSite is repo-relative like repos/some-vessel/src/file.ts
      // Map to runtime path using the same pattern as line 21
      const runtimePath = join(runtimeRoot(), editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      // A predicate the LANDING derived from its own diff (a line the commit removed,
      // stamped at cutover as predicate_source=removed_line_of_landing_commit) is a
      // DURABILITY sentinel — "is my change still in place?" — not a resolution
      // predicate. Reading its absence as 'absent' let a landing close a gap with the
      // evidence it manufactured itself (measured 2026-09-22: two gaps closed
      // close_basis=absent, three times, over an operator reopen). Its presence means
      // the change was reverted; its absence means only that the landing persists.
      if (meta['predicate_source'] === 'removed_line_of_landing_commit') {
        return contents.includes(hardcodedUrl) ? 'present' : 'pending';
      }
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // Class 1b: inverse polarity (expected_literal). Only when Class 1 did not apply.
    const expectedLiteral = nonEmptyStr(meta['expected_literal']);
    if (editSite && !hardcodedUrl && expectedLiteral) {
      return evaluateExpectedLiteral(editSite, expectedLiteral, nonEmptyStr(meta['literal_reader']) || undefined);
    }
    // ── Class 3 (sync): landed commit — a substrate-authored commit referencing this gap id already exists ──
    const gapIdForLandedSync = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    // THIS IS THE SECOND COPY OF THE SAME CHECK IN THIS FUNCTION, and it runs FIRST.
    //
    // I fixed the copy ~100 lines below (018fd05, 81d8474) and never looked for another.
    // This one kept the original behaviour — every clone, no revert awareness — so it
    // returned 'absent' before the corrected copy was ever reached, and the gap kept
    // closing as already_resolved five seconds after every pick while I verified fix
    // after fix as "deployed and running". Duplicated logic means a fix applied to one
    // site is not a fix.
    //
    // Same two corrections as the other copy: scope to the vessel the gap names, since
    // only that repo's history can show the change landing (a commit elsewhere is
    // discussion — my own fix commit in development-vessel was closing this very gap);
    // and refuse a match that IS a revert or WAS reverted, since git is append-only and
    // undoing a change adds a commit rather than removing one.
    const landedSiteSync = typeof ((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'] === 'string'
      ? String(((gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>)['edit_site'])
      : '';
    // Class 3 centralized (2026-08-14): a single non-reverted landing => 'pending' (landed,
    // UNVERIFIED — provenance, not measurement), a RE-LAND (>=2) => 'present'. Only runs when the
    // gap has no measurement predicate (else the async measurer owns the verdict).
    if (gapIdForLandedSync.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      const verdict = landedCommitVerdict(gapIdForLandedSync, landedSiteSync);
      if (verdict !== null) return verdict;
    }
    // Second evidence class: resolver-behaviour gaps.
    // classification_metadata may carry:
    //   evidence_resolve: { shape: string, input?: Record<string,unknown>, defect_field?: string, nonzero_field?: string, zero_field?: string }
    //   nonzero_field is a HEALTH field (0 = defect); zero_field is a DEFECT count (>0 = defect).
    // OR
    //   verify_shape: string  (shorthand — shape name only, defect detected by fetch_error or zero-count heuristic)
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    if (evidenceResolveRaw !== undefined || verifyShapeRaw !== undefined) {
      // This branch must be async; we cannot make verifyGapCondition async without
      // refactoring all callers, so we return a Promise that the caller awaits.
      // We wrap the async logic in an immediately-invoked function and return the
      // Promise cast — callers already await the outer closeLandedGap which in turn
      // calls verifyGapCondition. To keep the sync signature and avoid a full
      // refactor, we use a synchronous Bun-native approach: spawn a sub-call inline
      // with a helper that returns the verdict synchronously via Atomics + SharedArrayBuffer.
      // However, the cleanest zero-refactor approach is to make verifyGapCondition
      // return Promise<...> | 'unknown' and have callers handle it.  Since that would
      // require editing every caller, we instead use a different strategy:
      // return the sentinel 'unknown' here and rely on the async sibling
      // verifyGapConditionAsync which is called from the async closer path below.
      // The sentinel causes fail-open (no false close) — the async path does the real work.
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Async variant of verifyGapCondition that also handles the resolver-behaviour
 * evidence class (evidence_resolve / verify_shape in classification_metadata).
 * Called from closeLandedGap so the async fetch does not block the sync path.
 */
export type GapCheckVerdict = 'present' | 'absent' | 'pending' | 'unknown';
export interface GapCheckOpts {
  /** The transport for the class-2 resolve. Injected by tests and by the offline dry estimate; default global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the per-shape budget below. */
  timeoutMs?: number;
}

/**
 * THE CLASS-2 BUDGET IS THE CHECK'S OWN (gap_falsify v2). The judge aborted every class-2 resolve at 10 s,
 * but a test_suite check runs `bun test` with its own budget (input.timeout_ms; the resolver defaults to
 * 240 s and the pull-sync failing-test generator files 180 s). Aborting first read the check as 'unknown'
 * while the suite kept running in the shell, so a failing-test gap could be neither admitted nor closed by
 * its own check. The judge now waits longer than the resolver's own outer bound (its budget + 30 s,
 * test-suite.ts) so the resolver's report, not our abort, decides. Every other shape keeps 10 s.
 */
export function gapCheckTimeoutMs(shape: string, input: Record<string, unknown>): number {
  if (shape !== 'test_suite') return 10_000;
  const t = input['timeout_ms'];
  const budget = typeof t === 'number' && Number.isFinite(t) && t > 0 ? Math.min(t, 840_000) : 240_000;
  return budget + 60_000;
}

/**
 * ONE JUDGE (gap_falsify v2, REALIGNMENT §2.3; contained-self-development 8.5). The verdict a gap's check
 * gives on the tree now: at birth (substrateGap_write stamps predicate_birth_verdict), in the decomposition
 * proposer (a proposed check is written only if it reads 'present' before any fix), and at closure
 * (closeLandedGap and the pending-land sweep). All of them call this, so a fix to the judge is a fix
 * everywhere; there is no second evaluator.
 */
export async function evaluateGapCheck(gap: Record<string, unknown>, opts: GapCheckOpts = {}): Promise<GapCheckVerdict> {
  return verifyGapConditionAsync(gap, opts);
}

async function verifyGapConditionAsync(gap: Record<string, unknown>, opts: GapCheckOpts = {}): Promise<GapCheckVerdict> {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    // MEASUREMENT BEFORE PROVENANCE (§12.6 step 1, 2026-08-14): a Class-2 measurement predicate
    // (evidence_resolve / verify_shape) must be RUN before the Class-3 landed-commit provenance is
    // consulted. Previously Class 3 ran first and a gap with a real predicate closed on the commit
    // count without its predicate ever executing. When a predicate exists, skip provenance here and
    // let Class 2 below own the verdict (measured present/absent, or 'unknown'-abstain if unmeasurable).
    const hasClass2Predicate = meta['evidence_resolve'] !== undefined || meta['verify_shape'] !== undefined;
    // ── Class 1: surgical (file + literal) ──────────────────────────────────
    const rawEditSite = typeof meta['file_path'] === 'string'
      ? meta['file_path']
      : (typeof meta['edit_site'] === 'string' ? meta['edit_site'] : null);
    const editSite = rawEditSite ? rawEditSite.replace(/:\d+$/, '') : null;
    const hardcodedUrl = typeof meta['hardcoded_url'] === 'string' ? meta['hardcoded_url'] : null;
    if (editSite && hardcodedUrl) {
      const runtimePath = join(runtimeRoot(), editSite.replace(/^\//, '').replace(/^repos\//, ''));
      if (!existsSync(runtimePath)) return 'unknown';
      const contents = readFileSync(runtimePath, 'utf8');
      // A predicate the LANDING derived from its own diff (a line the commit removed,
      // stamped at cutover as predicate_source=removed_line_of_landing_commit) is a
      // DURABILITY sentinel — "is my change still in place?" — not a resolution
      // predicate. Reading its absence as 'absent' let a landing close a gap with the
      // evidence it manufactured itself (measured 2026-09-22: two gaps closed
      // close_basis=absent, three times, over an operator reopen). Its presence means
      // the change was reverted; its absence means only that the landing persists.
      if (meta['predicate_source'] === 'removed_line_of_landing_commit') {
        return contents.includes(hardcodedUrl) ? 'present' : 'pending';
      }
      return contents.includes(hardcodedUrl) ? 'present' : 'absent';
    }
    // Class 1b: inverse polarity (expected_literal). Only when Class 1 did not apply.
    const expectedLiteral = nonEmptyStr(meta['expected_literal']);
    if (editSite && !hardcodedUrl && expectedLiteral) {
      return evaluateExpectedLiteral(editSite, expectedLiteral, nonEmptyStr(meta['literal_reader']) || undefined);
    }
    // ── Class 3: landed commit — provenance (single landing => 'pending', NOT measurement) ──
    // Only consulted when no Class-2 predicate exists (measurement-before-provenance, above).
    const gapIdForLanded = typeof gap['id'] === 'string' ? (gap['id'] as string) : '';
    const behavioralFail = String(gap['summary'] ?? '').includes('BEHAVIORAL VERIFICATION FAILED') || ((gap['classification_metadata'] ?? {}) as Record<string, unknown>)['regressed_by'] !== undefined;
    if (gapIdForLanded.length >= 8 && !behavioralFail && !hasClass2Predicate) {
      // EVIDENCE MUST COME FROM THE REPO THE GAP IS ABOUT.
      //
      // This scanned EVERY clone, so a commit in an unrelated vessel that merely
      // MENTIONS the gap id counted as resolving it. The instance that exposed it is
      // hard to improve on: commit 018fd05 in development-vessel — whose message
      // explains that quoting a gap id is not evidence of a fix — became the false
      // evidence closing the very gap it was written about. My documentation resolved
      // the complaint it was documenting.
      //
      // A gap names its target through edit_site. Only that vessel's history can show
      // the change landing; a commit anywhere else is discussion, not resolution.
      const landedMeta = (gap['classification_metadata'] ?? gap['metadata'] ?? {}) as Record<string, unknown>;
      const landedSiteRaw = typeof landedMeta['edit_site'] === 'string' ? String(landedMeta['edit_site']) : '';
      // Class 3 centralized (2026-08-14): a single non-reverted landing => 'absent'; a RE-LAND
      // (>=2 non-reverted commits) => 'present' — the referent persisted despite landing, so a
      // commit naming the gap is not proof it is fixed. Revert-awareness + vessel scoping live in
      // landedCommitVerdict (the prior inline copies' revert lessons are folded into it).
      const verdict = landedCommitVerdict(gapIdForLanded, landedSiteRaw);
      if (verdict !== null) return verdict;
    }
    // ── Class 2: resolver-behaviour (evidence_resolve / verify_shape) ───────
    const evidenceResolveRaw = meta['evidence_resolve'];
    const verifyShapeRaw = meta['verify_shape'];
    let resolveShape: string | null = null;
    let resolveInput: Record<string, unknown> = {};
    let defectField: string | null = null;
    let nonzeroField: string | null = null;
    let zeroField: string | null = null;
    if (evidenceResolveRaw !== null && typeof evidenceResolveRaw === 'object') {
      const er = evidenceResolveRaw as Record<string, unknown>;
      resolveShape = typeof er['shape'] === 'string' ? er['shape'] : null;
      // ── Fallback A: sample-body-form evidence (no shape field) ──────────
      // Gap-filing paths (defect reports, surgical-gap-scan) write evidence_resolve
      // as a sample response body e.g. {obsidian_vessel_count:0, fetch_error:"..."}.
      // When shape is absent, fall back to classification_metadata.verify_shape,
      // then to a gap-id-derived shape. Also treat fetch_error/error keys as an
      // implied defect_field so the verifier rejects hollow closes on error bodies.
      if (resolveShape === null) {
        if (typeof verifyShapeRaw === 'string' && verifyShapeRaw.length > 0) {
          resolveShape = verifyShapeRaw;
        } else if (typeof meta['verify_shape'] === 'string' && (meta['verify_shape'] as string).length > 0) {
          resolveShape = meta['verify_shape'] as string;
        } else {
          // Derive shape from gap id: e.g. "gap-obsidian-vessel-count" -> "obsidian_vessel_count"
          const gapId = typeof gap['id'] === 'string' ? gap['id'] : '';
          if (gapId.length > 0) {
            const derived = gapId.replace(/^gap-/, '').replace(/-/g, '_');
            if (derived.length > 0) resolveShape = derived;
          }
        }
        // Treat fetch_error or error keys in sample-body-form evidence as implied defect_field
        if (defectField === null) {
          if (typeof er['fetch_error'] === 'string') {
            defectField = 'fetch_error';
          } else if (typeof er['error'] === 'string') {
            defectField = 'error';
          }
        }
      }
      resolveInput = (typeof er['input'] === 'object' && er['input'] !== null)
        ? (er['input'] as Record<string, unknown>)
        : {};
      defectField = typeof er['defect_field'] === 'string' ? er['defect_field'] : null;
      nonzeroField = typeof er['nonzero_field'] === 'string' ? er['nonzero_field'] : null;
      zeroField = typeof er['zero_field'] === 'string' ? er['zero_field'] : null;
    } else if (typeof verifyShapeRaw === 'string') {
      resolveShape = verifyShapeRaw;
    }
    if (!resolveShape) return 'unknown';
    // POST to the vessel's own in-container resolve endpoint.
    // THE ROUTE REQUIRES AN ENVELOPE (2026-09-01). This POSTed a FLAT body,
    // `{type, ...input}`, and src/routes/impulses.ts:1015-1027 requires
    // `{impulse:{pointer:{...}}}`. Measured against the running vessel:
    //
    //   flat {type,...}              -> HTTP 400
    //   {impulse:{pointer:{...}}}    -> HTTP 200
    //
    // and four lines below, `if (!resp.ok) return 'unknown'`. So EVERY Class-2
    // evidence_resolve / verify_shape predicate in the fleet has been silently inert
    // since this path was written — not one has ever been evaluated. The gap store
    // shows the consequence: 703 of 1207 lifetime exits are `expired_not_redetected`,
    // a 30-day timer, against 20 `landed_verified`.
    //
    // Nothing failed loudly because a 400 is indistinguishable from "no defect signal"
    // once it becomes 'unknown'. Fifth producer/consumer envelope mismatch found today;
    // this is the one that disabled a whole predicate class.
    // MEASURE WHERE THE STORE IS HELD (2026-09-28). A node that forwards its gap store answers this
    // check from its OWN filesystem and units, which are not the ones the gap's detector observed:
    // node 2's self_fact_reconcile saw 1 service repo and 0 divergences and closed a divergence node 1
    // still measures, crediting an inert landing (9c86aff). Abstain here; the holder's sweep runs over
    // the same store and measures it where it was observed. Logged, because a silent skip reads as a pass.
    // A CHECK THAT WRITES IS NOT A CHECK (2026-09-29). Decomposed steps were born with class-2
    // checks such as uiPanel_write {id:"test",...} and uiQuestion_write: executing them here
    // performs a live write as 'verification' and reads an unrelated field as a defect count.
    // Never execute a *_write shape; the gap stays unmeasured until it has a read-shaped check.
    if (/_write$/.test(resolveShape)) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} names a write shape (${resolveShape}) — not executed; unknown`);
      return 'unknown';
    }
    if (process.env['GAP_STORE_ENDPOINT']) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} (${resolveShape}) abstained on this node: the gap store is held elsewhere, so its sweep measures it`);
      return 'unknown';
    }
    const payload: Record<string, unknown> = { impulse: { pointer: { type: resolveShape, ...resolveInput } } };
    let respBody: Record<string, unknown>;
    try {
      const SELF_RESOLVE_ENDPOINT = process.env['SELF_RESOLVE_ENDPOINT'] ?? `http://localhost:${process.env['PORT'] ?? '8090'}/v2/impulses/resolve`;
      // The check's resolve shape comes from the gap, so it can be a write: carry the node key, or this
      // vessel's own write gate refuses it (lib/self-auth.ts).
      const resp = await (opts.fetchImpl ?? fetch)(SELF_RESOLVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...selfAuthHeaders(SELF_RESOLVE_ENDPOINT, SELF_RESOLVE_ENDPOINT) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs ?? gapCheckTimeoutMs(resolveShape, resolveInput)),
      });
      if (!resp.ok) return 'unknown';
      respBody = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Transport failure — fail open (unknown), no false close.
      return 'unknown';
    }
    // Unwrap nested body if the resolver wraps results in { body: { ... } }
    const inner = (typeof respBody['body'] === 'object' && respBody['body'] !== null)
      ? (respBody['body'] as Record<string, unknown>)
      : respBody;
    // AN INSTRUMENT THAT SAYS IT DID NOT OBSERVE IS NOT A MEASUREMENT (2026-09-29, class-wide).
    // A zero from a run that read nothing (no rows, unreadable source, missed canary) would
    // otherwise read as 'absent' and close the gap as verified. Any check whose response says
    // observed:false or measured:false is unknown; instruments that do not report it are unaffected.
    if (inner['observed'] === false || inner['measured'] === false) {
      console.log(`[gap-verify] class2 check for ${String(gap['id'] ?? '')} reported observed/measured false — unknown`);
      return 'unknown';
    }
    // Defect heuristic 1: explicit defect_field present in response
    if (defectField !== null && inner[defectField] !== undefined && inner[defectField] !== null && inner[defectField] !== '') {
      return 'present';
    }
    // Defect heuristic 1b: zero_field is a DEFECT count — >0 the defect stands, exactly 0 it is gone,
    // anything non-numeric is unmeasured. It exists because defect counts were written as
    // nonzero_field (below, a HEALTH field): self_fact_reconcile's divergence_count=1 read as fixed and
    // closed a live divergence landed_verified for a landing that was then reverted. Twice-seen class.
    if (zeroField !== null) {
      const zv = inner[zeroField];
      if (typeof zv === 'number' && zv > 0) return 'present';
      if (zv === 0) return 'absent';
      return 'unknown';
    }
    // Defect heuristic 2: explicit nonzero_field is a HEALTH count — a finite number >0 is absent, 0 is present.
    // null / missing / non-numeric is UNMEASURED and reads unknown. It used to read 'present', which held a gap
    // open (right for closing) but, since the falsified-landing record, also marks a landing FALSIFIED on an
    // outage or an under-volume null (wrong). Unknown does neither: the sweep abstains and the gap stays open.
    if (nonzeroField !== null) {
      const val = inner[nonzeroField];
      if (typeof val === 'number' && Number.isFinite(val)) return val > 0 ? 'absent' : 'present';
      return 'unknown';
    }
    // Defect heuristic 3 (generic): presence of a fetch_error field signals defect
    if (typeof inner['fetch_error'] === 'string' && inner['fetch_error'].length > 0) {
      return 'present';
    }
    // Defect heuristic 4 (generic): zero-count on common count fields
    for (const countKey of ['count', 'obsidian_vessel_count', 'vessel_count']) {
      if (countKey in inner) {
        const v = inner[countKey];
        if (v === 0 || v === null || v === undefined) return 'present';
        return 'absent';
      }
    }
    // NO DEFECT SIGNATURE FOUND — THAT IS 'unknown', NOT 'absent' (2026-09-01).
    //
    // This returned 'absent', which CLOSES the gap. So a predicate naming only a shape —
    // no defect_field, no nonzero_field — closed its gap on any HTTP 200 whose body
    // happened to carry no fetch_error and none of the count keys above. The resolver was
    // never asked a question about the defect, and its silence was read as an answer.
    //
    // Absence of evidence is not evidence of absence, and this is the one path whose whole
    // purpose is refusing to close on anything but measurement — the provenance class it
    // exists to replace sits at 0 closes / 766 false closes for precisely this mistake.
    //
    // MEASURED against the live store by driving the real sweep with three rows copied from
    // it, all carrying `evidence_resolve: {shape: "trace_failure_pattern_report"}` and no
    // field: with the Class-2 envelope armed, checked=8 closed=5 — three of them false,
    // each writing recordCloseVerdict("measured", false) into the calibration whose
    // unblemished 7/0 record is the only reason that class is trusted at all. Three
    // wrongful closes would have carried it to 10/0, crossing CLOSE_ORACLE_MIN_SAMPLES on
    // measurements that measured nothing.
    //
    // 'unknown' is the honest verdict: the sweep abstains, the gap stays open, and a human
    // or a later measurement decides. A predicate that names no field carries no
    // proposition, so there is nothing here that could have been found false.
    return 'unknown';
  } catch {
    // fall through to landed-commit evidence class
  }
  // ── Class 3: landed-commit evidence (centralized 2026-08-14 — now revert- and re-land-aware) ──
  // This copy was previously unscoped and NOT revert-aware; routing it through
  // landedCommitVerdict strengthens it to match the other sites and closes the same hole.
  try {
    const gapId = typeof gap.id === 'string' ? gap.id : '';
    const metadata = (gap.classification_metadata as Record<string, unknown> | undefined) ?? {};
    let editSite = typeof metadata['edit_site'] === 'string' ? String(metadata['edit_site']) : '';
    if (editSite.startsWith('/vessels/human-surface-vessel/')) {
      editSite = editSite.replace('/vessels/human-surface-vessel/', 'repos/human-surface-vessel/');
    }
    const verdict = landedCommitVerdict(gapId, editSite);
    if (verdict !== null) return verdict;
  } catch {
    // fail open
  }
  return 'unknown';
}

/** Mark a gap closed once its fix genuinely landed on origin/dev. Best-effort, guarded. */
// Exported for unit test only (the predicate_suspect guard, qa C2). No call-site change.
export async function closeLandedGap(gap: Record<string, unknown>, land: LandSignal): Promise<{ closed: boolean; error?: string }> {
  try {
    // Re-read the gap: the caller's copy was captured at pick time, before the cutover's pending-land
    // stamp and before any hold written since. Closing from it overwrote newer fields (the f705b61 close
    // kept a reverted pending sha) and could not see a hold written after the pick (09-30).
    const fresh = await readGapFresh(String(gap.id ?? ""));
    if (fresh) gap = fresh;
    if (((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>).operator_hold === true) {
      return { closed: false, error: "operator_hold: not closed on landing" };
    }
    // A decision made while the landing was in flight (withdrawn, verified_by_operator_review, superseded)
    // is not overwritten by a machine landed_verified: the sig-count gap was withdrawn on 09-29 with two
    // landings on it in flight.
    if (fresh && String(gap.status ?? "open") !== "open") {
      return { closed: false, error: `already ${String(gap.status)}: not re-closed on landing` };
    }
    // Outcome-verification (increment 2): use the async verifier which covers both
    // the surgical-class (file+literal) AND the resolver-behaviour class
    // (evidence_resolve / verify_shape). Fall back to the sync verifier result
    // only when the async path itself throws (belt-and-suspenders).
    let verifyResult: 'present' | 'absent' | 'pending' | 'unknown';
    try {
      verifyResult = await evaluateGapCheck(gap);
    } catch {
      verifyResult = verifyGapCondition(gap);
    }
    const gidV = String(gap.id ?? "");
    // A check that never read 'present' before the fix cannot say the fix worked (8.5): not closed on it.
    const suspectAtClose = verifyResult === 'absent' ? predicateSuspect((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) : null;
    if (suspectAtClose) {
      console.log(`[gap-to-feature] gap ${gidV} reads absent but is NOT closed: predicate_suspect (${suspectAtClose})`);
      return { closed: false, error: `predicate_suspect: ${suspectAtClose}` };
    }
    if (verifyResult === 'present') {
      // Defect still present — refuse close. If this 'present' is a RE-LAND (>=2 non-reverted
      // landings, none of which resolved it), the close-oracle is out of coverage: abstain ->
      // escalate to the human (§12.6 step 1) rather than leave it to re-compose inertly forever.
      const editSitePresent = gapEditSite(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) ?? "";
      if (landedCommitVerdict(gidV, editSitePresent) === 'present') {
        escalateRelandToHuman(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""));
      }
      return { closed: false, error: 'outcome_verification_failure: gap condition still present at close time' };
    }
    if (verifyResult === 'pending') {
      // SINGLE landing, unverified — provenance, not measurement. This is the inert-diff (bafd83d)
      // hole: a no-op diff typechecks, lands, and used to close green here. Abstain: hold PENDING
      // (do not close, do not re-compose) and ask the human. No false-close label — pending is not
      // yet a failure. If a measurement predicate later becomes available the sweep closes/refuses it.
      await markPendingVerification(gap, land.commit_sha ?? undefined, "landed once; awaiting outcome verification (no measurement predicate)");
      escalatePendingVerification(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""), land.commit_sha ?? undefined);
      return { closed: false, error: 'close-oracle abstains: single landing is provenance, not measured resolution — held pending verification' };
    }
    if (verifyResult === 'unknown' && !closeOracleEarnedTrust('landed_commit')) {
      // Unmeasured, and the landed-commit class has NOT earned fail-open trust (Beta(1,1) or a
      // poor track record never earns — trust is held closes, not assumed). Abstain: leave open for
      // the next tick rather than close on no evidence. No escalation — 'unknown' here is transient/
      // unmeasurable (e.g. clone not converged), distinct from 'pending' (which HAS a landing to verify).
      await markPendingVerification(gap, land.commit_sha ?? undefined, "unmeasured at close; landed-commit class has not earned fail-open trust");
      return { closed: false, error: 'close-oracle abstains: unmeasured close on a class without earned trust' };
    }
    // verifyResult === 'absent' (measured resolved) OR 'unknown' with EARNED trust: allow close.
    const id = gidV;
    if (!id) return { closed: false, error: "gap missing id" };
  if (typeof land.vessel==="string" && land.vessel.includes("development-vessel")) { await resolveSubstrateGapWrite({type:"substrateGap_write",gap:{id,category:gap.category,source:gap.source,summary:gap.summary,detected_at:gap.detected_at,classification_metadata:{...((gap['classification_metadata'] as Record<string,unknown>)??{}),pending_outcome_verification:land.commit_sha,pending_set_at:new Date().toISOString()},status:"open"}} as never); return {closed:false,error:"self-cutover: closure deferred to next-tick verification"}; }

  // Self-cutover guard: when a landed change targets development-vessel itself,
  // close-time outcome verification runs in the pre-cutover process and cannot
  // observe the post-cutover state — producing hollow gap closures (observed on
  // gap-obsidian-vessel-count at commit bbad5c4). Defer closure to next-tick
  // pick-time outcome verification instead.
  if (typeof land.vessel === "string" && land.vessel.includes("development-vessel")) {
    const pendingOutcomeVerification = land.commit_sha ?? "unknown";
    const pendingSetAt = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        status: "open",
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          pending_outcome_verification: pendingOutcomeVerification,
          pending_set_at: pendingSetAt,
        },
      },
    } as never);
    return { closed: false, error: "self-cutover: closure deferred to next-tick pick-time outcome verification" };
  }
    const selfAuthored = land.commit_sha ? selfAuthoredCheckInputs(gap, land.commit_sha) : [];
    if (selfAuthored.length > 0) {
      await markAwaitingOperatorReview(gap, land.commit_sha ?? "", selfAuthored);
      return { closed: false, error: `self-authored check: the landing edited its own check input(s) ${selfAuthored.join(", ")}` };
    }
    const resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    // Outcome verification: only close when the condition is observed gone.
    // Refuse on 'present' (still broken) AND 'pending' (single landing, unmeasured — provenance,
    // not resolution; the top-of-function gate already abstained on it, this is belt-and-suspenders).
    const conditionCheck = verifyGapCondition(gap);
    if (conditionCheck === 'present' || conditionCheck === 'pending') {
      const failureMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), outcome_verification_failure: `condition still present at close time after land ${land.commit_sha ?? 'unknown'}`, outcome_checked_at: new Date().toISOString() };
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id,
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: failureMeta,
            status: "open",
          },
        } as never);
      } catch { /* best-effort */ }
      return { closed: false, error: `outcome verification failed: hardcoded literal still present in edit_site after landing` };
    }
    // closed_reason + landed_sha (value-per-cost-selection 5.1): this close is a landing whose outcome
    // was verified above, the same fact the sweep records as `landed_verified`. Without the reason
    // the terminal measure (gaps closed by a verified landing) could not count this path at all.
    const literalOnlyClose = isLiteralOnlyStepClose((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>);
    const closedMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution, closed_reason: literalOnlyClose ? "landed_literal_only" : "landed_verified", ...(land.commit_sha ? { landed_sha: land.commit_sha } : {}), closed_at: new Date().toISOString(),
      falsifier_exercise: { detector: "closeLandedGap", verdict: literalOnlyClose ? "literal_present" : verifyResult, passed: !literalOnlyClose && verifyResult === "absent", ran_at: new Date().toISOString(), commit: land.commit_sha ?? null } };
    const meta = closedMeta;
    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: land.commit_sha ?? null });
    const landedCloseWrite = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "closed",
      },
    } as never);
    if (landedCloseWrite?.shape !== "structuredError") await closeAncestorsOnSamePredicate(id, meta);
    if (landedCloseWrite?.shape !== "structuredError") await closeDescendantsOnSamePredicate(id, meta);
    // Calibration land credit is taken by the gap-store holder from the close written above.
    updateClassPosterior(gapClassOf(gap), true);
    // CLOSURE-CREDIT: reward the filing detector for gap closure (not just filing).
    // Best-effort — never throw; wrapped in its own try/catch.
    try {
      const detectorName: unknown = (gap as Record<string, unknown>).classification_metadata &&
        typeof (gap as Record<string, unknown>).classification_metadata === "object"
        ? ((gap as Record<string, unknown>).classification_metadata as Record<string, unknown>).detector
        : undefined;
      if (typeof detectorName === "string" && detectorName.length > 0) {
        const ledgerPath: string = process.env.DETECTOR_CLOSURE_LEDGER_PATH ?? "/workspace/detector-closure-credit.json";
        type LedgerEntry = { closures: number; last_closed_at: string };
        type Ledger = Record<string, LedgerEntry>;
        let ledger: Ledger = {};
        if (existsSync(ledgerPath)) {
          try {
            ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
          } catch {
            ledger = {};
          }
        }
        const existing: LedgerEntry | undefined = ledger[detectorName];
        ledger[detectorName] = {
          closures: (existing?.closures ?? 0) + 1,
          last_closed_at: new Date().toISOString(),
        };
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
      }
    } catch {
      // best-effort ledger write — never propagate
    }
    return { closed: true };
  } catch (e) {
    return { closed: false, error: (e as Error).message };
  }
}

// ── Pending-land verification sweep (land→close continuity) ──────────────────
// Self-cutover lands defer closure: closeLandedGap stamps
// classification_metadata.pending_outcome_verification = <landed SHA> and leaves the
// gap open, expecting a "next-tick verification" that never existed — so gaps with
// genuinely-landed commits stayed open and were picked and re-landed (observed on
// gap-transport-health-observer-reads-lying-signals-2026-07-29 and the
// service-failure-model-reality-audit duplicate re-lands). This sweep completes the
// deferred path: at gap_to_feature tick start (an EXISTING rhythm — no new timer),
// every open gap carrying a pending SHA is checked deterministically against the same
// in-container clones this file already reads; when the SHA is an ancestor of a
// clone's HEAD, the land is observable post-cutover and the gap flips to closed via
// substrateGap_write (shape-flow preserved) with closed_reason=landed_verified.
// Bounded like gap-lifecycle; best-effort; a still-'present' condition refuses close.
const PENDING_VERIFY_SWEEP_LIMIT = 25;
// When this process last examined each pending gap, whatever the verdict. Only a 'pending' verdict
// persists pending_last_checked_at, so without this a gap stuck at present/unknown/not_in_clone sorted
// first every tick and held a slot forever. In-process on purpose: no extra store write per checked gap.
const sweepLastCheckedAt = new Map<string, string>();
// PERSISTED, because a process lives only 1-3 sweeps (every landing restarts it) and rotating the
// pending set needs ~7: an in-process map emptied before the rotation finished (qa, 09-29). One small
// state file, no gap-store write. Resolved at call time; no WORKSPACE_ROOT means no persistence, so a
// test run can never write a live path.
function sweepLastCheckedPath(): string | null {
  const root = process.env["WORKSPACE_ROOT"];
  return root ? join(root, "state", "sweep-last-checked.json") : null;
}
function loadSweepLastChecked(): void {
  const p = sweepLastCheckedPath();
  if (!p || !existsSync(p)) return;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && v > (sweepLastCheckedAt.get(k) ?? "")) sweepLastCheckedAt.set(k, v);
    }
  } catch (err) {
    console.warn(`[gap-sweep] sweep-last-checked state unreadable at ${p}: ${String(err)}`);
  }
}
function saveSweepLastChecked(): void {
  const p = sweepLastCheckedPath();
  if (!p) return;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    // Atomic: a restart lands mid-sweep, and a kill during a plain write leaves truncated JSON.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sweepLastCheckedAt)));
    renameSync(tmp, p);
  } catch (err) {
    console.warn(`[gap-sweep] sweep-last-checked state not written at ${p}: ${String(err)}`);
  }
}
// SINGLE-FLIGHT: two sweeps started in the same second several times on 09-29, computing the same slice
// and escalating twice. A call while one runs gets the running one.
let sweepInFlight: Promise<{ checked: number; closed: number }> | null = null;

/**
 * Finds commits that fixed this gap via lineage (parent/child relationship) when 
 * no direct mention is found in commit messages. Returns SHA if found, null otherwise.
 * Bounds lineage walk at depth 8 to prevent unbounded search.
 */
async function landedCommitViaLineage(gap: Record<string, unknown> & { id?: string }): Promise<string | null> {
  if (!gap.id) return null;
  
  // 1. Get metadata to find lineage
  const meta = gap.classification_metadata as Record<string, unknown> | undefined ?? {};
  const editSite = gapEditSite(gap, meta);
  
  // 2. Check direct commits first as fast path
  const directSha = await landedCommitVerdict(gap.id, editSite ?? "");
  if (directSha !== null) return directSha;
  
  // 3. Build lineage IDs set from parent/source chain
  const lineageIds = new Set<string>();
  let parentId = String(meta.parent_gap_id ?? meta.source_gap_id ?? "");
  let depth = 0;
  const seen = new Set<string>();  
  
  while (parentId && depth < 8 && !seen.has(parentId)) {
    seen.add(parentId);
    lineageIds.add(parentId);
    
    // Walk up lineage via stored metadata - requires access to gap store
    const parentGap = gap as Record<string, unknown>; // Simplified - real impl needs gap store access
    const parentMeta = parentGap.classification_metadata as Record<string, unknown> | undefined;
    parentId = String(parentMeta?.parent_gap_id ?? parentMeta?.source_gap_id ?? "");
    depth++;
  }
  
  if (lineageIds.size === 0) return null;
  
  // 4. Search clones for commits touching editSite and mentioning lineage IDs
  const cloneRoot = vesselsCloneRoot();
  let clones: string[] = [];
  try { clones = readdirSync(cloneRoot); } catch { return null; }
  
  for (const cloneName of clones) {
    const cloneDir = join(cloneRoot, cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    
    try {
      // Search for commits touching editSite and mentioning any lineage ID
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "log", "--grep", Array.from(lineageIds).join("\\\|"), "--fixed-strings", "--since=14.days", "--", String(editSite)], 
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      
      if (proc.exitCode === 0) {
        const commits = new TextDecoder().decode(proc.stdout).split("\n");
        for (const commitLine of commits) {
          const [sha, ...messageParts] = commitLine.split(" ");
          if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
            if (!shaWasRevertedInAnyClone(sha)) return sha;
          }
        }
      }
    } catch { /* per-repo failure — continue */ }
  }
  
  return null;
}
// Call-time (not module-load) so tests can point at a fixture clone tree; production
// never sets the override and uses the same path as the other clone readers here.
const vesselsCloneRoot = (): string => process.env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels";

export function ownedVessels(): Set<string> {
  try {
    const present = readdirSync(vesselsCloneRoot()).filter((d) => existsSync(join(vesselsCloneRoot(), d, ".git")));
    const declared = (process.env["SUBSTRATE_PUSH_VESSELS"] ?? "").split(/[\s,]+/).filter(Boolean);
    return new Set(declared.length > 0 ? present.filter((d) => declared.includes(d)) : present);
  } catch {
    return new Set();
  }
}

/** Deterministic land evidence: is `sha` an ancestor of HEAD in ANY vessel clone? */
// SWEEP ONLY ON NEW EVIDENCE. sweepPendingLandVerifications ran before EVERY auto-pick and
// did a lineage git search per predicate-carrying gap plus serial gap writes and
// escalations (~60-75 network writes per pass, measured 2026-09-26: selection took over
// 5 s and re-asked the same human questions). The only new evidence it can use is a new
// commit in a clone (a landing or a pull-sync convergence), so it runs when the clone
// HEADs changed since the last sweep. Condition-driven, not a timer; an unreadable
// fingerprint falls back to sweeping as before.
let lastSweepHeads: string | null = null;
function cloneHeadsFingerprint(): string | null {
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()).sort(); } catch { return null; }
  const heads: string[] = [];
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      if (proc.exitCode !== 0) return null;
      heads.push(`${cloneName}@${new TextDecoder().decode(proc.stdout).trim()}`);
    } catch { return null; }
  }
  return heads.join(",");
}

function shaIsAncestorOfAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "merge-base", "--is-ancestor", sha, "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

/**
 * Has this landed commit been REVERTED since it landed?
 *
 * shaIsAncestorOfAnyClone cannot tell: `git revert` adds a NEW commit that undoes the
 * change and leaves the original in history, so the reverted sha stays an ancestor of
 * HEAD forever. The sweep's own comment claimed the ancestor check covered "the land
 * was reverted" — it never did.
 *
 * Measured 2026-08-07: ad706ce landed a wrong-region UI patch, was reverted in 1812ee7,
 * and the sweep still closed the gap as `landed_verified` on a commit whose change no
 * longer exists. A human's UI complaint was marked resolved with the code containing no
 * trace of it — and a closed gap is never re-routed, so it could never be retried. That
 * is worse than leaving it open: the store asserts a resolution that the tree denies.
 *
 * `git revert` writes "This reverts commit <full-sha>." into the message, so look for a
 * descendant carrying it. Cheap, and it only has to catch the mechanised case; a manual
 * undo that rewrites the change by hand is not detectable here and is not claimed to be.
 */
function shaWasRevertedInAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const full = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", sha], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (full.exitCode !== 0) continue;
      const fullSha = new TextDecoder().decode(full.stdout).trim();
      if (!fullSha) continue;
      // Match BOTH forms. `git revert` writes the trailer "This reverts commit <full-sha>."
      // but that message is routinely REWRITTEN — an operator amending the revert to
      // explain WHY drops the trailer entirely. That is not hypothetical: the revert this
      // detector was written for (1812ee7) says "This reverts ad706ce" in prose and
      // carries no trailer, so a trailer-only grep misses the exact case that motivated
      // it. I asserted I had verified against that pair and had not; the query returned
      // empty. Accept "reverts <sha>" with a 7+ hex prefix as well, which survives an
      // amended message, and search the SHORT sha too since prose uses it.
      const shortSha = fullSha.slice(0, 12);
      // Allow arbitrary words between "reverts" and the sha, not only an optional "commit ".
      // An operator amending the revert message ("Reverts substrate-authored commit <sha>")
      // inserts words the fixed `(commit )?` alternative cannot absorb, and the trailer-only
      // form is defeated the same way. Measured 2026-08-23 on route-edit-56849210.
      const pattern = `reverts (\\w+ ){0,4}(commit )?(${fullSha}|${shortSha}|${sha})`;
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "log", "-E", "--grep", pattern, "-i", "--format=%H", `${sha}..HEAD`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim().length > 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

/**
 * Landed-commit evidence for a gap, with RE-LAND awareness (§12.6, 2026-08-14).
 *
 * Class 3 previously returned 'absent' whenever ONE non-reverted substrate-authored commit
 * referenced the gap id (`git log --grep <gapId> -1`). That certifies closure on a
 * producer-authored string — the commit message names the gap — rather than on a measured
 * condition. Demonstrated hole: gap-env-gated-write-allowlist "closed" on bafd83d, an inert
 * rename (WRITE_ALLOWLIST -> WRITE_ALLOWLIST_ENV) that left process.env["WRITE_ALLOWLIST"]
 * and thus the env-gate intact — and that gap had already been re-detected and re-landed once
 * (69d680b at 05:39, then bafd83d at 07:34: two non-reverted commits reference it).
 *
 * The re-detection is the referent's persistence signal. Count non-reverted commits:
 *   0  -> null      (no landed evidence — caller falls through, unchanged)
 *   1  -> 'pending' (first landing — PROVENANCE, NOT MEASUREMENT. A commit naming the gap is
 *          proof a change LANDED, not proof it DID ANYTHING. This is exactly the inert-diff
 *          (bafd83d) hole: a syntactically-valid no-op typechecks, lands, and — when this
 *          returned 'absent' — closed the gap green while the condition it named still held.
 *          'pending' means "landed, unverified": the close-oracle abstains (out of coverage
 *          for provenance-only evidence), so the caller must NOT close and must NOT re-compose
 *          (a second landing would read as a re-land and manufacture the false-close the oracle
 *          is calibrated against). Only a MEASUREMENT predicate (Class 1 literal / Class 2
 *          resolver-behaviour) can return 'absent' = positively-observed resolved.)
 *   >=2 -> 'present' (landed, re-detected, re-landed => prior landing did not resolve the
 *          condition => refuse close; callers refuse close on 'present')
 *
 * Scoped to the gap's target vessel (from editSite): a mention elsewhere is discussion, not
 * evidence — the same rule the three former inline copies carried. Uses vesselsCloneRoot() so
 * it is testable against a fixture clone tree; the inline copies hardcoded the path and were
 * therefore untested. Replaces the duplicated Class-3 blocks the authors were burned by
 * ("a fix applied to one site is not a fix").
 */
export function landedCommitVerdict(gapId: string, editSite: string): 'pending' | 'present' | null {
  if (typeof gapId !== 'string' || gapId.length < 8) return null;
  const landedVessel = (typeof editSite === 'string' ? editSite : '').match(/^repos\/([^/]+)\//)?.[1] ?? '';
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return null; }
  let nonReverted = 0;
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, '.git'))) continue;
    if (landedVessel && cloneName !== landedVessel) continue;
    try {
      // ALL matching commits (no -1) so re-lands are countable, not just the most recent.
      const gitLog = Bun.spawnSync(['git', '-C', cloneDir, 'log', '--grep', gapId, '--fixed-strings', '--format=%H', '--since=14.days'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      const shas = gitLog.exitCode === 0 ? new TextDecoder().decode(gitLog.stdout).trim().split(/\s+/).filter(Boolean) : [];
      for (const sha of shas) {
        const subjRaw = Bun.spawnSync(['git', '-C', cloneDir, 'log', '-1', '--format=%s', sha], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
        const subj = subjRaw.exitCode === 0 ? new TextDecoder().decode(subjRaw.stdout).trim() : '';
        // Accept git's default subject `Revert "<subject>"` AND the conventional-commits
        // forms `revert(scope): ...` / `revert: ...`. The default-only test /^Revert[\s"']/i
        // missed a `revert(scope):` subject whose body named the gap id, so that revert was
        // counted as a SECOND landing and flipped the verdict to 'present' — closing the gap it
        // was reverting as already_resolved. Measured 2026-08-23 on route-edit-56849210; pinned
        // by gap-to-feature-reland-verdict.test.ts ("conventional-commits revert(scope):").
        if (/^Revert[\s"']/i.test(subj) || /^revert(\([^)]*\))?:/i.test(subj)) continue;      // the match IS a revert
        if (shaWasRevertedInAnyClone(sha)) continue;     // the match WAS reverted
        nonReverted += 1;
      }
    } catch { /* per-repo failure — continue */ }
  }
  if (nonReverted === 0) return null;
  if (nonReverted >= 2) return 'present';
  return 'pending';
}

// ── Close-oracle EARNED-TRUST gate (§12.6 step 1, 2026-08-14) ────────────────────────────────
// The fail-open direction — closing a gap on an UNMEASURED verdict ('unknown') — is permitted ONLY
// when the close-oracle has EARNED that trust for the evidence class: enough samples AND a
// reliability floor. This is the inverse of satisfierProvenBad (satisfier-pick.ts) and reuses its
// constants. CRITICAL: a fresh class at Beta(1,1) (zero evidence) must NOT earn fail-open — "trust
// assumed" is exactly what the program forbids; trust is earned by holding closes. landed_commit at
// {closes:0,false_closes:8} => 8 samples < floor and reliability 0.1 < 0.3 => never earns => abstains.
const CLOSE_ORACLE_TRUST_FLOOR = 0.7;   // a class must hold >=70% of its closes to fail-open on unknown
const CLOSE_ORACLE_MIN_SAMPLES = 10;    // and have >=10 graded closes; below this it has no earned trust
export function closeOracleEarnedTrust(evidenceClass: string): boolean {
  const r = closeOracleReliability(evidenceClass);
  const samples = r.closes + r.false_closes;
  return samples >= CLOSE_ORACLE_MIN_SAMPLES && r.reliability >= CLOSE_ORACLE_TRUST_FLOOR;
}

/**
 * Abstain -> escalate (§12.6 step 1, 2026-08-14). The close-oracle refuses to close a gap on a
 * RE-LAND (>=2 non-reverted landings, none of which resolved the condition) — it is OUT OF
 * COVERAGE: repeated landing without closure means the automated fix is inert or wrong. Unlike
 * the category-hopeless escalation (which keys on lands===0 and therefore never fires for a gap
 * that DOES land), this fires per-gap at the close-refusal point and asks the human. The
 * uiQuestion_write is the durable escalation record and, once answered, an operator-verdict
 * corpus entry that calibrates the oracle. Deduped via solicitedHumanGaps; fire-and-forget.
 */
function escalateRelandToHuman(gapId: string, category: string, summary: string): void {
  if (!gapId || solicitedHumanGaps.has(gapId)) return;
  solicitedHumanGaps.add(gapId);
  // A re-land is the retrospective FALSE-CLOSE label for the landed-commit class: grade the oracle.
  recordCloseVerdict("landed_commit", true);
  const rel = closeOracleReliability("landed_commit");
  const relNote = ` [close-oracle landed-commit reliability so far: ${(rel.reliability * 100).toFixed(0)}% (${rel.closes} closes, ${rel.false_closes} re-lands)]`;
  void resolveUiWritePassthrough({ type: "uiQuestion_write", id: "reland-needs-human-" + gapId, title: "Gap re-lands without closing — needs a human decision", body: "Gap " + gapId + " (" + category + ") has had multiple substrate-authored landings, none of which resolved its condition (the close-oracle abstains — out of coverage). The automated fix keeps landing an inert or wrong change. It likely needs a human: redefine the goal, supply the missing fact, grant access, or drop it. Summary: " + summary.slice(0, 300) + relNote, kind: "gap_reland_needs_human", importance: "high" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] reland uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] reland uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] reland uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

// Dedup for pending-verification escalations, separate from re-land dedup: a gap can escalate as
// 'pending' (one landing, unverified) and LATER as 're-land' (>=2 landings) — distinct signals.
const pendingVerificationEscalated = new Set<string>();

/**
 * Abstain on a SINGLE landing (§12.6 step 1, 2026-08-14). A single non-reverted commit naming the
 * gap is PROVENANCE (a change landed), not MEASUREMENT (the condition resolved) — the inert-diff
 * (bafd83d) hole. The close-oracle abstains: it neither closes (an inert diff would close green)
 * nor labels a false-close (pending is not yet a failure — the landing may be genuine). It asks the
 * human to confirm the landed change actually did the thing. Deduped; fire-and-forget. NOTE: unlike
 * escalateRelandToHuman this records NO close-verdict — a pending gap has not failed, so labelling it
 * would poison the posterior with a verdict reality has not yet delivered.
 */
function escalatePendingVerification(gapId: string, category: string, summary: string, sha?: string): void {
  if (!gapId || pendingVerificationEscalated.has(gapId)) return;
  pendingVerificationEscalated.add(gapId);
  const shaNote = sha ? ` (landed ${String(sha).slice(0, 12)})` : "";
  void resolveUiWritePassthrough({ type: "uiQuestion_write", id: "pending-verify-" + gapId, title: "Gap landed but is unverified — did the change actually fix it?", body: "Gap " + gapId + " (" + category + ") had a single substrate-authored landing" + shaNote + ", but the close-oracle has no way to MEASURE whether the change resolved the condition (no literal/resolver predicate — provenance only). Rather than close it green on the commit alone (the inert-diff hole), it is held PENDING. Please confirm: did the landed change actually fix this, or is it inert/wrong? Summary: " + summary.slice(0, 300), kind: "gap_pending_verification", importance: "medium" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] pending-verify uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] pending-verify uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] pending-verify uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

/**
 * Mark a gap PENDING-VERIFICATION: keep it open, stamp pending_outcome_verification (so the
 * sweep re-checks it) and disposition:'pending_verification' (so ADMISSION skips re-composing it —
 * a second landing would read as a re-land and manufacture the false-close the oracle is calibrated
 * against). Best-effort; never throws into the caller.
 */
/** pending_last_checked_at for a pending mark. A NEW landing (a sha different from the one already pending) has
 *  never been examined by the sweep, so it gets "" and sorts FIRST in the least-recently-checked slice; stamping it
 *  "now" at landing time made every fresh landing look just-checked and wait behind the whole pending set (three
 *  verified landings sat 60+ min unexamined behind 103 pending gaps, 2026-09-30). A re-mark of the same landing
 *  keeps the current behaviour. */
export function pendingCheckedStamp(prevSha: unknown, sha: string | undefined, nowIso: string): string {
  // Never examined yet (no pending sha before this mark, whatever this one is) or a NEW sha: sort first.
  return !prevSha || (sha !== undefined && sha !== prevSha) ? "" : nowIso;
}

async function markPendingVerification(gap: Record<string, unknown>, sha: string | undefined, note: string): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at,
        classification_metadata: {
          ...meta0,
          pending_outcome_verification: sha ?? meta0['pending_outcome_verification'] ?? "unknown",
          // Keep the ORIGINAL stamp while the landing is the same one. Re-stamping on every check made
          // the gaps just checked the newest, so the newest-first sweep slice re-selected the same 24
          // every tick and 59 measurable pending gaps were never examined (09-29). The check time is
          // recorded separately and orders the sweep.
          pending_set_at: (sha === undefined || sha === meta0['pending_outcome_verification']) && typeof meta0['pending_set_at'] === "string"
            ? meta0['pending_set_at']
            : new Date().toISOString(),
          pending_last_checked_at: pendingCheckedStamp(meta0['pending_outcome_verification'], sha, new Date().toISOString()),
          // Never downgrade a parking disposition: it is what keeps the gap out of admission until a human acts.
          disposition: isParkingDisposition(meta0["disposition"]) ? meta0["disposition"] : "pending_verification",
          pending_note: note,
        },
        status: "open",
      },
    } as never);
  } catch { /* best-effort */ }
}

/** The row that releases a pending_verification hold, built from the gap as the store holds it NOW, or null when
 *  there is nothing to release: the row is gone, no longer open (a reopen would undo a close), or no longer held
 *  pending_verification (a human hold set meanwhile is not the sweep's to lift). The whole fresh row is returned so
 *  top-level keys (reopen_count, first_detected_at, ...) survive the write. A REVERTED landing also clears its
 *  pending_outcome_verification stamp ("" is the cleared convention) and records it as reverted_landing: the stamp
 *  would keep the picker skipping the gap and the sweep re-selecting it every tick. */
export function releasedRow(fresh: Record<string, unknown> | null, why: string, revertedSha?: string): Record<string, unknown> | null {
  if (!fresh || String(fresh.status ?? "") !== "open") return null;
  const lifted = liftLandVerificationHold((fresh.classification_metadata ?? {}) as Record<string, unknown>);
  if (!lifted) return null;
  const meta: Record<string, unknown> = { ...lifted, pending_note: `released: ${why}` };
  if (revertedSha) { meta.pending_outcome_verification = ""; meta.reverted_landing = revertedSha; }
  return { ...fresh, classification_metadata: meta };
}

/** The sweep judged a landing NOT to have resolved its gap: lift the pending_verification hold so admission takes
 *  the gap for another attempt. Decided on a FRESH read, not the sweep's snapshot (releasedRow). */
async function releaseUnresolvedLanding(gap: Record<string, unknown>, why: string, revertedSha?: string): Promise<void> {
  const id = String(gap.id ?? "");
  try {
    const row = releasedRow(await readGapFresh(id), why, revertedSha);
    if (!row) return;
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: row } as never);
    console.warn(`[gap-sweep] released pending_verification on ${id}: ${why}; admitted for another attempt`);
  } catch (e) {
    console.warn(`[gap-sweep] could not release pending_verification on ${id}: ${(e as Error).message}`);
  }
}

// FALSIFIED AUTONOMOUS LANDING (contained-self-development 8.4a). The sweep measured a
// single landing 'present' and did nothing: three autonomous landings on 09-27 left their
// gap's defect in place, two passed the prose judge, and the system recorded none of it — the
// only verdict was the operator's. This records the system's own verdict, without reverting:
// the gap's predicate still reports the defect AFTER the edited vessel restarted onto the
// commit, so the landing did not fix it. Applies only to an attempt intent that says
// directed:false (an intent from before that field, or no Attempt-Id trailer, is not judged).
// The clone holding the commit names the vessel it edited, and its unit start time — not this
// vessel's — says whether the change is running.
let sweepAwaitingRestart = false;
function sweepGitOut(cloneDir: string, args: string[]): string | null {
  let out: string | null = null;
  try {
    const p = Bun.spawnSync(["git", "-C", cloneDir, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (p.exitCode === 0) out = new TextDecoder().decode(p.stdout).trim();
  } catch { /* spawn failed: no output */ }
  return out;
}
/**
 * A RE-DETECTED GAP IS NOT CLOSED ON A LANDING OLDER THAN THE RE-DETECTION (2026-10-03).
 * performance-inefficiency-execution_traces_list was reopened by the efficiency probe every ~20 min while the
 * list route stayed slow, and the pending-land sweep re-closed it each time landed_verified on the class2
 * source-text check of a 09-30 commit: true since 09-30, blind to the latency the detector had just measured.
 * Every cycle appended another FAVORABLE outcome for that same commit (posterior inflation, 19 in a day).
 * qa's rule: a close of a reopened row counts only if the commit it credits landed AFTER the re-detection
 * (the closer's own evidence run is always after it), or the row's check is a standing row that measures the
 * symptom itself. Otherwise the commit is the fix that did not hold, and nothing closes on it.
 */
export const STALE_EVIDENCE_REASON = "stale_evidence_predates_redetection";
export interface StaleCloseEvidence { reason: typeof STALE_EVIDENCE_REASON; sha: string; committed_at: string | null; redetected_at: string }

/** When the row was last re-detected: the store's reopened_at stamp; for a row reopened before that stamp
 *  existed (reopen_count > 0, no stamp), its detected_at. null for a row that was never reopened. */
export function redetectedAtOf(g: Record<string, unknown>): string | null {
  const ok = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (ok(g.reopened_at)) return g.reopened_at;
  if (Number(g.reopen_count ?? 0) > 0 && ok(g.detected_at)) return g.detected_at;
  return null;
}

/** A standing row: the check measures the symptom itself on every run (a self_fact_reconcile row,
 *  REALIGNMENT §2.1), not the source a landing changed, so a clean reading after a reopen is fresh evidence. */
export function checkIsStandingRow(meta: Record<string, unknown>): boolean {
  const er = meta.evidence_resolve as { shape?: unknown } | undefined;
  if (er && typeof er === "object" && er.shape === "self_fact_reconcile") return true;
  return meta.verify_shape === "self_fact_reconcile";
}

/** The committer time (when it landed on the branch) of a commit in any vessel clone, ISO; null when unknown. */
function commitTimeInAnyClone(sha: string): string | null {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git"))) continue;
      const ct = Number(sweepGitOut(dir, ["log", "-1", "--format=%ct", sha]) ?? "");
      if (Number.isFinite(ct) && ct > 0) return new Date(ct * 1000).toISOString();
    }
  } catch { /* no clone tree */ }
  return null;
}

/** Why closing this row on `sha` would be stale, or null when it may close: the row was re-detected, its check
 *  is not a standing row, and the commit did not land after the re-detection (an unknown landing time counts as
 *  not after: nothing proves it). Exported for tests. */
export function staleCloseEvidence(g: Record<string, unknown>, sha: string): StaleCloseEvidence | null {
  const redetectedAt = redetectedAtOf(g);
  if (!redetectedAt) return null;
  if (checkIsStandingRow((g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>)) return null;
  const committedAt = commitTimeInAnyClone(sha);
  if (committedAt !== null && Date.parse(committedAt) > Date.parse(redetectedAt)) return null;
  return { reason: STALE_EVIDENCE_REASON, sha, committed_at: committedAt, redetected_at: redetectedAt };
}

/** The sweep found the stamped landing stale for a reopened row: record why, and stop holding the row on it
 *  (pending_outcome_verification cleared, a pending_verification hold lifted) so the sweep does not re-take it
 *  and the gap is admitted for a landing that can close it. Decided on a FRESH read; open rows only. */
async function releaseStaleLanding(gap: Record<string, unknown>, stale: StaleCloseEvidence): Promise<void> {
  const id = String(gap.id ?? "");
  try {
    const fresh = await readGapFresh(id);
    if (!fresh || String(fresh.status ?? "") !== "open") return;
    const m0 = (fresh.classification_metadata ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {
      ...(liftLandVerificationHold(m0) ?? m0),
      pending_outcome_verification: "",
      stale_landing: stale.sha,
      stale_close_evidence: { ...stale, at: new Date().toISOString() },
      pending_note: `released: ${stale.reason} (landed ${stale.committed_at ?? "at an unknown time"}, re-detected ${stale.redetected_at})`,
    };
    await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...fresh, classification_metadata: meta } } as never);
  } catch (e) {
    console.warn(`[gap-sweep] could not record stale landing on ${id}: ${(e as Error).message}`);
  }
}

/** The gap as the store holds it now, or null when it cannot be read (the caller keeps its own copy). */
async function readGapFresh(id: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  try {
    const read = await resolveSubstrateGap({ type: "substrateGap", id } as never);
    const rows = (read as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps;
    return Array.isArray(rows) ? (rows.find((r) => String(r.id) === id) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Did the landing edit its own check? When a class2 test_suite check's test file, or any path recorded in
 * check_inputs, is in the landed commit's diff, a passing verdict certifies nothing: the landing wrote the
 * thing that judges it. Observed 09-29/30: concept-db f705b61 and activity-api 0f96c62 were closed
 * landed_verified by the tests they had just edited. Returns the offending repos/<vessel>/ paths, or []
 * when the gap names no check input or the commit is in no clone.
 */
function selfAuthoredCheckInputs(gap: Record<string, unknown>, sha: string): string[] {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const inputs = new Set<string>();
  if (Array.isArray(meta.check_inputs)) for (const p of meta.check_inputs) if (typeof p === "string" && p) inputs.add(p.replace(/^\/+/, ""));
  const er = meta.evidence_resolve as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown } } | undefined;
  if (er && er.shape === "test_suite" && typeof er.input?.vessel === "string" && typeof er.input?.test_file === "string") {
    inputs.add(`repos/${er.input.vessel}/${er.input.test_file.replace(/^\/+/, "")}`);
  }
  if (inputs.size === 0 || !sha) return [];
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) continue;
      const touched = (sweepGitOut(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? "").split("\n").filter(Boolean);
      return touched.map((f) => `repos/${name}/${f}`).filter((f) => inputs.has(f));
    }
    console.warn(`[gap-verify] cannot judge self-authorship for ${String(gap.id ?? "?")}: ${sha.slice(0, 12)} is in no vessel clone`);
  } catch (e) {
    console.warn(`[gap-verify] cannot judge self-authorship for ${String(gap.id ?? "?")}: ${(e as Error).message}`);
  }
  return [];
}

/**
 * A landing whose check it edited itself leaves the gap open with disposition awaiting_operator_review and
 * the landed sha still pending, so the picker does not re-compose it and the sweep skips it cheaply. The
 * resolution is an operator's recorded verdict (verified_by_operator_review, or a regression).
 */
async function markAwaitingOperatorReview(gap: Record<string, unknown>, sha: string, files: string[]): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at,
        classification_metadata: {
          ...meta0,
          pending_outcome_verification: sha || meta0["pending_outcome_verification"] || "unknown",
          pending_set_at: sha === meta0["pending_outcome_verification"] && typeof meta0["pending_set_at"] === "string" ? meta0["pending_set_at"] : now,
          disposition: "awaiting_operator_review",
          self_authored_check: { sha, files, at: now },
        },
        status: "open",
      },
    } as never);
  } catch (e) {
    console.warn(`[gap-verify] could not mark ${String(gap.id ?? "?")} awaiting operator review: ${(e as Error).message}`);
  }
}

/**
 * Is the landed commit RUNNING on this node? A measured 'absent' read from this node's runtime file is
 * evidence only if this node actually serves the vessel on that code: on 2026-09-29 node 2 closed a gap
 * landed_verified for activity-api, which node 2 does not run, while node 1 still served the old code.
 * 'running' also covers a commit in no vessel clone (e.g. the super-repo), where this cannot be judged.
 */
async function landedCommitRunningHere(sha: string): Promise<"running" | "not served here" | "awaiting restart"> {
  let vessel: string | null = null;
  let cloneDir = "";
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (existsSync(join(dir, ".git")) && sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null) { vessel = name; cloneDir = dir; break; }
    }
  } catch { return "running"; }
  if (!vessel) return "running";
  // A commit that touches only test files never reaches the runtime (pull-sync mirrors src/ sql/
  // scripts/ and does not restart for it), so waiting for a restart would hold its gap open
  // forever. Its check (a test_suite run) reads the clone, which the loop above proved contains it.
  const touched = (sweepGitOut(cloneDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? "").split("\n").filter(Boolean);
  if (touched.length > 0 && touched.every((f) => /^tests?\//.test(f))) return "running";
  let active = "";
  let startedAt = 0;
  try {
    active = new TextDecoder().decode(Bun.spawnSync(["systemctl", "is-active", vessel], { stdout: "pipe", stderr: "pipe", timeout: 5_000 }).stdout).trim();
    const p = Bun.spawnSync(["systemctl", "show", vessel, "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const m = new TextDecoder().decode(p.stdout).trim().match(/^@(\d+)$/);
    startedAt = m ? Number(m[1]) : 0;
  } catch { return "awaiting restart"; }
  if (active !== "active") return "not served here";
  const committedAt = Number(sweepGitOut(cloneDir, ["log", "-1", "--format=%ct", sha]) ?? "0");
  if (!startedAt || !committedAt || startedAt <= committedAt) return "awaiting restart";
  const { selfRestartAlreadyOwed } = await import("./vessel-mitosis-cutover.js");
  if (selfRestartAlreadyOwed(vessel)) return "awaiting restart";
  return "running";
}

/** The catch for a dissent-outcome write: logged, never fatal to the sweep (calibration loses one sample). */
function dissentOutcomeUnwritten(gapId: string, result: "passed" | "failed"): (err: unknown) => number {
  return (err) => {
    console.warn(`[gap-sweep] gap ${gapId}: semantic-dissent outcome '${result}' NOT written (${(err as Error)?.message ?? String(err)})`);
    return 0;
  };
}

async function recordFalsifiedAutonomousLanding(g: Record<string, unknown>, meta: Record<string, unknown>, sha: string): Promise<"recorded" | "awaiting_restart" | "not_applicable"> {
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return "not_applicable";
  if (meta.predicate_source === "removed_line_of_landing_commit") return "not_applicable";
  let vessel: string | null = null;
  let cloneDir = "";
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (existsSync(join(dir, ".git")) && sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null) { vessel = name; cloneDir = dir; break; }
    }
  } catch { return "not_applicable"; }
  if (!vessel) return "not_applicable";
  const attemptId = sweepGitOut(cloneDir, ["log", "-1", "--format=%(trailers:key=Attempt-Id,valueonly)", sha]) ?? "";
  if (!attemptId) return "not_applicable";
  const { readRecords, appendRecord } = await import("./attempt-ledger.js");
  const intent = ((await readRecords("attemptIntent", { key: attemptId }))[0]?.record ?? null) as { directed?: unknown } | null;
  if (!intent || intent.directed !== false) return "not_applicable";
  const committedAt = Number(sweepGitOut(cloneDir, ["log", "-1", "--format=%ct", sha]) ?? "0");
  let startedAt = 0;
  try {
    const p = Bun.spawnSync(["systemctl", "show", vessel, "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const m = new TextDecoder().decode(p.stdout).trim().match(/^@(\d+)$/);
    startedAt = m ? Number(m[1]) : 0;
  } catch { /* unit unreadable: cannot tell what is running here */ }
  if (!startedAt || !committedAt) return "not_applicable";
  const { selfRestartAlreadyOwed } = await import("./vessel-mitosis-cutover.js");
  if (startedAt <= committedAt || selfRestartAlreadyOwed(vessel)) return "awaiting_restart";
  const at = new Date().toISOString();
  await resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: {
      id: String(g.id), category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: "open",
      classification_metadata: { ...meta, regressed_by: { sha, at, verdict: "present", attempt_id: attemptId, vessel, revert_sha: null, by: "gap-sweep:falsified_after_restart" } },
    },
  } as never);
  // The gap store can drop the stamp above (lost-update race, filed), so the next sweep may land here
  // again for the same landing. The local ledger is durable: its #2 settlement is the once-only marker.
  const alreadySettled = (await readRecords("attemptSettlement", { key: `${attemptId}#2` })).length > 0;
  if (!alreadySettled) {
    joinDecisionOutcome(meta, { landed: true, verdict: "UNFAVORABLE", commit: sha, falsified_after_restart: true });
    updateClassPosterior(gapClassOf(g), false);
    await appendRecord("attemptSettlement", `${attemptId}#2`, { attempt_id: attemptId, settlement_seq: 2, verdict: "regressed", credit_eligible: false, shas: [sha], gap_id: String(g.id), source: "falsified_after_restart", at });
  }
  console.warn(`[gap-sweep] FALSIFIED autonomous landing gap=${String(g.id)} sha=${sha.slice(0, 12)} vessel=${vessel} attempt=${attemptId} — its predicate still reports the defect after ${vessel} restarted onto it; recorded regressed_by, held from re-pick until reverted`);
  return "recorded";
}

// OPERATOR REGRESSIONS REACH THE LEARNING PATH (contained-self-development 8.20). On 09-28 four
// autonomous landings passed their own check (three were even closed landed_verified) and were reverted
// by the operator. The only trace was regressed_by on the gap, read by the picker hold alone: the
// settlement stayed `held`, the posterior counted a success and no lesson reached the drafter. This
// feeds that verdict, once, into the same records a falsified landing writes. Acts only on the node
// that registered the attempt (the ledger is node-local).
async function recordOperatorRegression(g: Record<string, unknown>): Promise<boolean> {
  const meta = { ...((g.classification_metadata ?? {}) as Record<string, unknown>) };
  const rb = meta.regressed_by as { sha?: unknown; attempt_id?: unknown; revert_sha?: unknown; by?: unknown; reason?: unknown; learned_at?: unknown } | null | undefined;
  if (!rb || typeof rb !== "object" || !rb.revert_sha || !rb.attempt_id || rb.learned_at) return false;
  if (String(rb.by ?? "").startsWith("gap-sweep")) return false;
  const attemptId = String(rb.attempt_id);
  const { readRecords, appendRecord } = await import("./attempt-ledger.js");
  if ((await readRecords("attemptIntent", { key: attemptId })).length === 0) return false;
  const at = new Date().toISOString();
  const sha = String(rb.sha ?? "");
  if ((await readRecords("attemptSettlement", { key: `${attemptId}#2` })).length === 0) {
    joinDecisionOutcome(meta, { landed: true, verdict: "UNFAVORABLE", commit: sha, reverted_by: String(rb.revert_sha), operator_regression: true });
    updateClassPosterior(gapClassOf(g), false);
    await appendRecord("attemptSettlement", `${attemptId}#2`, { attempt_id: attemptId, settlement_seq: 2, verdict: "regressed", credit_eligible: false, shas: [sha], gap_id: String(g.id), source: "operator_revert", reverted_by: String(rb.revert_sha), at });
  }
  const lessons = Array.isArray(meta.failure_lessons) ? [...(meta.failure_lessons as unknown[])] : [];
  if (!lessons.some((l) => (l as { attempt_id?: unknown; class?: unknown }).attempt_id === attemptId && (l as { class?: unknown }).class === "attempt_consequence")) {
    lessons.push({ class: "attempt_consequence", reason: `<${attemptId}> landed <${sha.slice(0, 12)}> and was reverted by <${String(rb.revert_sha).slice(0, 12)}>: ${String(rb.reason ?? "judged a regression by the operator").slice(0, 400)}`, at, attempt_id: attemptId });
  }
  await resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id: String(g.id), category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: g.status ?? "open", classification_metadata: { ...meta, failure_lessons: lessons, regressed_by: { ...rb, learned_at: at } } },
  } as never);
  console.warn(`[gap-sweep] OPERATOR REGRESSION learned gap=${String(g.id)} sha=${sha.slice(0, 12)} attempt=${attemptId} reverted_by=${String(rb.revert_sha).slice(0, 12)} — settlement regressed, posterior miss, lesson written`);
  return true;
}

/**
 * A CHILD'S VERIFIED CLOSE IS ITS ANCESTORS' MEASUREMENT when they hold the same predicate (qa F2, 10-02).
 * A narrowed or recommit child carries its parent's check byte-identically (inheritableParentCheck), and while
 * it is open the parent is held from auto-pick (inheritedPredicateHolds). When the child closes landed_verified
 * on its own exercised check (passed, verdict absent), that very check now reads absent for the parent too:
 * the ancestor is closed on that measurement, with the child's falsifier_exercise (verdict, commit) carried
 * and a resolution naming the child. Not a stamp by id: an ancestor whose evidence_resolve differs in any
 * byte is never closed, and the walk stops there. Operator-held ancestors are left alone. Ancestors are
 * closed as `closed_via_child`, not landed_verified, so no landing is credited twice.
 * Each close is conditional (expect_status "open", checked under the store lock): an ancestor closed or
 * otherwise changed state since it was read is not overwritten, and the walk stops there, since whatever
 * settled that ancestor also owns what lies above it.
 */
let __ancestorCloseRaceHook: ((ancestorId: string) => Promise<void>) | null = null;
/** Tests only: runs between an ancestor's read and its close write, to stage a concurrent writer. */
export function __setAncestorCloseRaceHookForTests(h: ((ancestorId: string) => Promise<void>) | null): void { __ancestorCloseRaceHook = h; }
export async function closeAncestorsOnSamePredicate(childId: string, childClosedMeta: Record<string, unknown>): Promise<string[]> {
  const closed: string[] = [];
  try {
    const ex = childClosedMeta.falsifier_exercise as { passed?: unknown; verdict?: unknown } | undefined;
    if (childClosedMeta.closed_reason !== "landed_verified" || !ex || ex.passed !== true || ex.verdict !== "absent") return closed;
    const er = childClosedMeta.evidence_resolve;
    if (!er || typeof er !== "object" || typeof (er as { shape?: unknown }).shape !== "string") return closed;
    const key = class2PredicateKey({ evidence_resolve: er });
    let up = String(childClosedMeta.parent_gap_id ?? childClosedMeta.source_gap_id ?? "");
    const seen = new Set<string>([childId]);
    for (let depth = 0; up && !seen.has(up) && depth < 8; depth++) {
      seen.add(up);
      const read = await resolveSubstrateGap({ type: "substrateGap", id: up, limit: 1 } as never);
      const row = (((read?.body as { gaps?: Record<string, unknown>[] } | undefined)?.gaps) ?? [])[0];
      if (!row || String(row.id ?? "") !== up) break;
      const am = (row.classification_metadata ?? row.metadata ?? {}) as Record<string, unknown>;
      const aer = am.evidence_resolve;
      if (!aer || typeof aer !== "object" || class2PredicateKey({ evidence_resolve: aer }) !== key) break;
      const staleAnc = String(row.status ?? "") === "open" ? staleCloseEvidence(row, String((ex as { commit?: unknown }).commit ?? "")) : null;
      if (staleAnc) {
        console.log(`[gap-sweep] ${up}: not closed via child ${childId}: ${staleAnc.reason} (commit ${staleAnc.sha.slice(0, 12) || "none"} landed ${staleAnc.committed_at ?? "unknown"}, re-detected ${staleAnc.redetected_at}); lineage walk stops`);
        break;
      }
      if (String(row.status ?? "") === "open" && am.operator_hold !== true) {
        const resolution = `closed via child ${childId}: same predicate exercised`;
        if (__ancestorCloseRaceHook) await __ancestorCloseRaceHook(up);
        const w = await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          expect_status: "open",
          gap: {
            id: up,
            category: row.category,
            source: row.source,
            summary: row.summary,
            detected_at: row.detected_at,
            classification_metadata: { ...am, closed_reason: "closed_via_child", close_basis: "absent", closed_via_child: childId, resolution, falsifier_exercise: { ...(ex as Record<string, unknown>), via_child: childId }, closed_at: new Date().toISOString() },
            status: "closed",
          },
        } as never);
        const wb = (w?.body ?? {}) as { action?: unknown; skip_reason?: unknown; stored_status?: unknown };
        if (w?.shape === "structuredError" || wb.action === "skipped") {
          console.log(`[gap-sweep] ${up}: not closed via child ${childId} (${w?.shape === "structuredError" ? "write refused" : `${String(wb.skip_reason)}, stored ${String(wb.stored_status)}`}); lineage walk stops`);
          break;
        }
        closed.push(up);
        console.log(`[gap-sweep] ${up}: ${resolution}`);
      }
      up = String(am.parent_gap_id ?? am.source_gap_id ?? "");
    }
  } catch (err) {
    console.warn(`[gap-sweep] closing ancestors of ${childId} on its predicate failed: ${String(err).slice(0, 200)}`);
  }
  return closed;
}

/**
 * A VERIFIED CLOSE IS ITS OPEN DESCENDANTS' MEASUREMENT TOO, when they hold the same predicate. The mirror of
 * closeAncestorsOnSamePredicate: a recommit-<id>-<cls> child (source_gap_id) or a -narrowed child (parent_gap_id)
 * carries its parent's check byte-identically on the same edit_site, so once the parent closes landed_verified
 * on that exercised check (passed, verdict absent) the child's defect reads absent as well. Left open, auto-pick
 * kept composing it. Each open descendant (grandchildren included) with the identical evidence_resolve and
 * edit_site closes as `closed_via_parent` with the parent's falsifier_exercise; a child on a different check or
 * edit_site, and an operator-held child, stay open. Conditional writes (expect_status "open").
 */
export async function closeDescendantsOnSamePredicate(parentId: string, parentClosedMeta: Record<string, unknown>): Promise<string[]> {
  const closed: string[] = [];
  try {
    const ex = parentClosedMeta.falsifier_exercise as { passed?: unknown; verdict?: unknown } | undefined;
    if (parentClosedMeta.closed_reason !== "landed_verified" || !ex || ex.passed !== true || ex.verdict !== "absent") return closed;
    const er = parentClosedMeta.evidence_resolve;
    if (!er || typeof er !== "object" || typeof (er as { shape?: unknown }).shape !== "string") return closed;
    const key = class2PredicateKey({ evidence_resolve: er });
    const site = String(parentClosedMeta.edit_site ?? "");
    const read = await resolveSubstrateGap({ type: "substrateGap", status: "open", limit: Number.MAX_SAFE_INTEGER, exclude_categories: [...DECISION_LOG_GAP_CATEGORIES] } as never);
    const open = (((read?.body as { gaps?: Record<string, unknown>[] } | undefined)?.gaps) ?? []);
    const metaOf = (r: Record<string, unknown>) => (r.classification_metadata ?? r.metadata ?? {}) as Record<string, unknown>;
    const queue = [parentId];
    const seen = new Set<string>([parentId]);
    while (queue.length > 0 && seen.size < 64) {
      const up = queue.shift()!;
      for (const row of open) {
        const id = String(row.id ?? "");
        const am = metaOf(row);
        if (!id || seen.has(id) || String(am.parent_gap_id ?? am.source_gap_id ?? "") !== up) continue;
        const aer = am.evidence_resolve;
        if (!aer || typeof aer !== "object" || class2PredicateKey({ evidence_resolve: aer }) !== key || String(am.edit_site ?? "") !== site) continue;
        seen.add(id);
        if (String(row.status ?? "") !== "open" || am.operator_hold === true) continue;
        const staleDesc = staleCloseEvidence(row, String((ex as { commit?: unknown }).commit ?? ""));
        if (staleDesc) { console.log(`[gap-sweep] ${id}: not closed via parent ${parentId}: ${staleDesc.reason} (commit ${staleDesc.sha.slice(0, 12) || "none"} landed ${staleDesc.committed_at ?? "unknown"}, re-detected ${staleDesc.redetected_at})`); continue; }
        const resolution = `closed via parent ${parentId}: same predicate exercised`;
        const w = await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          expect_status: "open",
          gap: { id, category: row.category, source: row.source, summary: row.summary, detected_at: row.detected_at, status: "closed",
            classification_metadata: { ...am, closed_reason: "closed_via_parent", close_basis: "absent", closed_via_parent: parentId, resolution, falsifier_exercise: { ...(ex as Record<string, unknown>), via_parent: parentId }, closed_at: new Date().toISOString() } },
        } as never);
        const wb = (w?.body ?? {}) as { action?: unknown };
        if (w?.shape === "structuredError" || wb.action === "skipped") { console.log(`[gap-sweep] ${id}: not closed via parent ${parentId} (write refused or skipped)`); continue; }
        closed.push(id);
        queue.push(id);
        console.log(`[gap-sweep] ${id}: ${resolution}`);
      }
    }
  } catch (err) {
    console.warn(`[gap-sweep] closing descendants of ${parentId} on its predicate failed: ${String(err).slice(0, 200)}`);
  }
  return closed;
}

export async function sweepPendingLandVerifications(): Promise<{ checked: number; closed: number }> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = sweepPendingLandVerificationsOnce().finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}

async function sweepPendingLandVerificationsOnce(): Promise<{ checked: number; closed: number }> {
  const out = { checked: 0, closed: 0 };
  loadSweepLastChecked();
  // OBSERVABILITY, because this sweep has been silent since it was written.
  //
  // It returns {checked, closed} and logs NOTHING, so from outside there is no way to tell
  // whether it ran, what it examined, or why nothing closed. Measured 2026-08-31: 1606 gaps,
  // 1025 of them closed, and ZERO carrying closed_reason=landed_verified — the lane this
  // function exists to drive has never once produced a surviving row. Whether that was a
  // broken sweep, an empty input, or correct abstention was indistinguishable from the
  // journal, and that ambiguity is the entire reason it went unexamined.
  //
  // Live at the time of writing: 13 gaps carry pending_outcome_verification, 11 of them
  // have no predicate at all — so the honest answer is "correctly abstaining on an input
  // that cannot be measured", not "broken". A counter per verdict says that out loud.
  const tally = { absent: 0, present: 0, pending: 0, unknown: 0, not_in_clone: 0, reverted: 0, awaiting_restart: 0, falsified: 0, self_authored: 0, birth_retaken: 0, stale: 0 };
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      status: "open",
      // NO CONSTANT CAP (2026-09-29, sibling of the auto-pick read in 355d6de): at 1844 open gaps a
      // 1000 window hid 5 pending landings and 50 predicate-bearing gaps from verification.
      limit: Number.MAX_SAFE_INTEGER,
      exclude_categories: [...DECISION_LOG_GAP_CATEGORIES],
      // Bookkeeping, not supply: a held gap's landing is still verified (it is only never closed on it).
      include_held: true,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    // First, stamp lineage-linked commits as pending verification for gaps with predicates but no stamp
for (const g of gaps) {
  const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
  const hasPredicate = !!m.expected_literal || !!m.hardcoded_url || !!m.verify_shape;
  if (hasPredicate && !m.pending_outcome_verification) {
    const lineageSha = await landedCommitViaLineage(g);
    // A reopened row is not re-stamped with a landing older than its re-detection: that is the fix that did
    // not hold, and stamping it would hand the sweep the stale close it refuses below.
    const staleLineage = lineageSha ? staleCloseEvidence(g, lineageSha) : null;
    if (staleLineage) console.log(`[gap-sweep] gap ${String(g.id)}: lineage landing ${lineageSha!.slice(0, 12)} not stamped: ${staleLineage.reason} (landed ${staleLineage.committed_at ?? "unknown"}, re-detected ${staleLineage.redetected_at})`);
    if (lineageSha && !staleLineage) {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: g.id,
          classification_metadata: {...m, pending_outcome_verification: lineageSha},
          status: "open"
        }
      });
    }
  }
}

// Operator reverts reach the learning path before anything else reads these gaps.
for (const g of gaps) { try { await recordOperatorRegression(g); } catch { /* best-effort; retried next tick */ } }

// BIRTH RE-EVALUATION (qa R1): unknown, or pending past the hour, re-taken BIRTH_REEVAL_PER_TICK per tick,
// oldest first, on the same birth chain and judge as a write's (substrate-gap reevaluateBirthVerdicts).
try { tally.birth_retaken = (await reevaluateBirthVerdicts(gaps)).length; } catch (err) { console.warn(`[gap-sweep] birth re-evaluation skipped: ${String(err).slice(0, 200)}`); }

// Then process existing pending verifications as before
const pending = gaps
      .filter((g) => {
        const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
        return typeof m.pending_outcome_verification === "string" && (m.pending_outcome_verification as string).length >= 7;
      })
      // Measurable gaps first: predicate-less stamped gaps can never resolve, and taking the first N in
      // store order let them hold every slot. Then LEAST RECENTLY CHECKED first (never-checked, i.e. new
      // landings, sort first), so every pending gap rotates through the slice. Newest pending_set_at first
      // was a fixed set, because checking a gap re-stamped it (09-29).
      .sort((a, b) => {
        const ma = (a.classification_metadata ?? {}) as Record<string, unknown>;
        const mb = (b.classification_metadata ?? {}) as Record<string, unknown>;
        const pa = ma.expected_literal || ma.hardcoded_url || ma.verify_shape || ma.evidence_resolve ? 0 : 1;
        const pb = mb.expected_literal || mb.hardcoded_url || mb.verify_shape || mb.evidence_resolve ? 0 : 1;
        const lastChecked = (g: Record<string, unknown>, m: Record<string, unknown>): string => {
          const persisted = String(m.pending_last_checked_at ?? "");
          const seen = sweepLastCheckedAt.get(String(g.id ?? "")) ?? "";
          return seen > persisted ? seen : persisted;
        };
        return pa - pb || lastChecked(a, ma).localeCompare(lastChecked(b, mb));
      })
      .slice(0, PENDING_VERIFY_SWEEP_LIMIT);
    for (const g of pending) {
      out.checked += 1;
      sweepLastCheckedAt.set(String(g.id ?? ""), new Date().toISOString());
      saveSweepLastChecked();
      const meta = { ...((g.classification_metadata ?? {}) as Record<string, unknown>) };
      // An operator hold is a statement that the falsifier cannot yet be exercised; the
      // sweep never closes over it. It is lifted by an exercised falsifier, not by a landing.
      if (meta.operator_hold === true) {
        console.log(`[gap-sweep] gap ${String(g.id)} held by operator_hold — not closed on landing`);
        continue;
      }
      const sha = String(meta.pending_outcome_verification);
      // Not yet observable in a clone (pull-sync hasn't converged, or the land was
      // reverted) — leave open; the sweep retries on every tick.
      if (!shaIsAncestorOfAnyClone(sha)) { tally.not_in_clone += 1; continue; }
      // A REVERTED land is not a land. The ancestor check above passes forever once the
      // commit exists, revert or not, so ask explicitly.
      // A revert the operator recorded on the gap counts too: route-edit and direct reverts carry no
      // `This reverts commit` line for the clone check to find.
      const rbSweep = meta.regressed_by as { sha?: unknown; revert_sha?: unknown } | null | undefined;
      const operatorReverted = !!rbSweep && typeof rbSweep === "object" && !!rbSweep.revert_sha && String(rbSweep.sha ?? "").startsWith(sha.slice(0, 7));
      if (operatorReverted || shaWasRevertedInAnyClone(sha)) {
        tally.reverted += 1;
        console.warn(`[gap-sweep] gap ${String(g.id)} NOT closed: landed sha ${sha.slice(0, 12)} was REVERTED — the change is gone from HEAD, so the gap is unresolved and stays open for another attempt`);
        await releaseUnresolvedLanding(g, `landed ${sha.slice(0, 12)} was reverted`, sha);
        // A landing made under a semantic dissent resolves its by-effect check as failed: it is gone.
        await resolveDissentOutcome(String(g.id ?? ""), { result: "failed" }).catch(dissentOutcomeUnwritten(String(g.id ?? ""), "failed"));
        continue;
      }
      // A REOPENED row is not re-closed on a landing older than its re-detection (see staleCloseEvidence):
      // checked BEFORE the evidence run, which proves nothing about this reopen and can cost a test_suite.
      const staleSweep = staleCloseEvidence(g, sha);
      if (staleSweep) {
        tally.stale += 1;
        console.warn(`[gap-sweep] gap ${String(g.id)} NOT closed: ${staleSweep.reason} — credited sha ${sha.slice(0, 12)} landed ${staleSweep.committed_at ?? "at an unknown time"}, gap re-detected ${staleSweep.redetected_at}; no outcome appended, released for a landing after the re-detection`);
        await releaseStaleLanding(g, staleSweep);
        continue;
      }
      // Post-cutover: the async verifier CAN now observe the landed state. Close ONLY on a
      // positively-MEASURED 'absent' (a Class-1 literal or Class-2 resolver-behaviour predicate
      // observed the condition gone). Everything else abstains (§12.6 step 1):
      //   'present'  -> defect still there; a RE-LAND (>=2) is out of coverage -> escalate.
      //   'pending'  -> SINGLE landing, no measurement predicate: PROVENANCE, not resolution.
      //                 This is the inert-diff (bafd83d) hole — a no-op diff landed and used to
      //                 close green HERE. Hold pending, ask the human, do NOT close, do NOT
      //                 re-compose (disposition set so the picker skips it -> no manufactured re-land).
      //   'unknown'  -> unmeasured; close only if the landed-commit class has EARNED fail-open trust
      //                 (it never does on provenance alone -> abstain, retry next tick).
      // Marked on an earlier tick: its check was edited by its own landing, so re-running it proves nothing.
      if (meta.disposition === "awaiting_operator_review" && (meta.self_authored_check as { sha?: unknown } | undefined)?.sha === sha) { tally.self_authored += 1; continue; }
      const verdict = await evaluateGapCheck(g);
      const gidSweep = String(g.id ?? "");
      // 8.5: an 'absent' from a check that never read 'present' at birth closes nothing.
      const suspectSweep = verdict === "absent" ? predicateSuspect(meta) : null;
      if (suspectSweep) {
        tally.unknown += 1;
        console.log(`[gap-sweep] gap ${gidSweep} reads absent but is NOT closed: predicate_suspect (${suspectSweep})`);
        continue;
      }
      if (verdict === "present") {
        tally.present += 1;
        const falsified = await recordFalsifiedAutonomousLanding(g, meta, sha);
        if (falsified === "awaiting_restart") { tally.awaiting_restart += 1; sweepAwaitingRestart = true; continue; }
        // A semantic dissent's by-effect check fails only on a 'present' ATTRIBUTABLE to the landing (the
        // landed code is running here); a 'present' read before the restart says nothing about it.
        if (falsified === "recorded") {
          await resolveDissentOutcome(gidSweep, { result: "failed" }).catch(dissentOutcomeUnwritten(gidSweep, "failed"));
          tally.falsified += 1;
          continue;
        }
        // A MEASURED 'present' while the landing runs here: the change did not fix it, so it gets another attempt.
        // Class-3 'present' (landed twice) stays held for the human the re-land escalation asks.
        if (liftLandVerificationHold(meta) && landVerdictIsMeasured(meta) && (await landedCommitRunningHere(sha)) === "running") {
          await releaseUnresolvedLanding(g, `measured present with landed ${sha.slice(0, 12)} running`);
          await resolveDissentOutcome(gidSweep, { result: "failed" }).catch(dissentOutcomeUnwritten(gidSweep, "failed"));
        }
        const editSitePresent = gapEditSite(g, (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>) ?? "";
        if (landedCommitVerdict(gidSweep, editSitePresent) === 'present') {
          escalateRelandToHuman(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""));
        }
        continue;
      }
      if (verdict === "pending") {
        tally.pending += 1;
        await markPendingVerification(g, sha, "pending sweep: single landing, no measurement predicate");
        escalatePendingVerification(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""), sha);
        continue;
      }
      if (verdict === "unknown" && !closeOracleEarnedTrust("landed_commit")) {
        tally.unknown += 1;
        continue; // unmeasured and untrusted — leave open for the next tick
      }
      // CLOSE ONLY WHERE THE FIX RUNS (09-29): this node's runtime file is evidence only if this node serves
      // the vessel on the landed code. Otherwise leave it open for the node that does.
      const runningHere = await landedCommitRunningHere(sha);
      if (runningHere !== "running") {
        tally.awaiting_restart += 1;
        sweepAwaitingRestart = true;
        console.log(`[gap-sweep] gap ${gidSweep} reads ${verdict} but landed ${sha.slice(0, 12)} is ${runningHere} on this node — not closed here`);
        continue;
      }
      const selfAuthoredSweep = selfAuthoredCheckInputs(g, sha);
      if (selfAuthoredSweep.length > 0) {
        tally.self_authored += 1;
        console.log(`[gap-sweep] gap ${gidSweep} reads ${verdict} but landed ${sha.slice(0, 12)} edited its own check input(s) ${selfAuthoredSweep.join(", ")}; not closed (awaiting operator review)`);
        await markAwaitingOperatorReview(g, sha, selfAuthoredSweep);
        continue;
      }
      // verdict === 'absent' (MEASURED resolved) OR 'unknown' with earned trust -> close.
      tally.absent += 1;
      // ONE CREDIT PER (gap, landing): a standing row may re-close after a reopen on the landing it already
      // credited; that close is recorded, but the landing's posterior and the close-oracle are not paid twice.
      const credited = joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: sha });
      if (!credited) console.log(`[gap-sweep] gap ${gidSweep}: landing ${sha.slice(0, 12)} already credited FAVORABLE; closing without a second credit`);
      // SUCCESS label for the close-oracle (§12.6 1a): a MEASURED close builds the trustworthy
      // "measured" class posterior. Provenance-only closes no longer happen here, so landed_commit
      // never accrues a fake success from a commit count — it earns trust only via human confirmation
      // (solicitation-outcome-scan) and loses it on re-lands. That asymmetry is deliberate.
      if (credited) recordCloseVerdict("measured", false);
      const sweepClosedMeta: Record<string, unknown> = {
        ...meta,
        closed_reason: isLiteralOnlyStepClose(meta) ? "landed_literal_only" : "landed_verified",
        close_basis: verdict,
        falsifier_exercise: isLiteralOnlyStepClose(meta)
          ? { detector: "gap-sweep", verdict: "literal_present", passed: false, ran_at: new Date().toISOString(), commit: sha }
          : { detector: "gap-sweep", verdict, passed: verdict === "absent", ran_at: new Date().toISOString(), commit: sha },
        resolution: `landed via mitosis cutover ${sha} (${verdict === 'absent' ? 'measured condition check' : 'earned close-oracle trust'})`,
        closed_at: new Date().toISOString(),
      };
      const sweepCloseWrite = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: String(g.id),
          category: g.category,
          source: g.source,
          summary: g.summary,
          detected_at: g.detected_at,
          classification_metadata: sweepClosedMeta,
          status: "closed",
        },
      } as never);
      if (sweepCloseWrite?.shape !== "structuredError") await closeAncestorsOnSamePredicate(String(g.id), sweepClosedMeta);
      if (sweepCloseWrite?.shape !== "structuredError") await closeDescendantsOnSamePredicate(String(g.id), sweepClosedMeta);
      // Calibration land credit is taken by the gap-store holder from the close written above.
      if (credited) updateClassPosterior(gapClassOf(g), true);
      // The by-effect check passed: a landing made under a semantic dissent resolves it as passed.
      if (sweepCloseWrite?.shape !== "structuredError") await resolveDissentOutcome(String(g.id), { result: "passed" }).catch(dissentOutcomeUnwritten(String(g.id), "passed"));
      out.closed += 1;
    }
  } catch (err) {
    // Was a bare `catch {}`. A sweep that dies mid-batch left NO evidence it had, which is
    // indistinguishable from a sweep that found nothing — the same ambiguity this tally
    // exists to remove. Still best-effort; it just says so now.
    console.warn(`[gap-sweep] aborted after checked=${out.checked}: ${(err as Error)?.message ?? String(err)}`);
  }
  // ALWAYS log, including the all-zero case. "checked=0" is a real finding (nothing is
  // stamped pending) and is not the same as "checked=13 closed=0 pending=11", which says the
  // machinery works and the INPUT is unmeasurable. Silence conflated those two for the whole
  // life of this function.
  console.log(`[gap-sweep] checked=${out.checked} closed=${out.closed} ${JSON.stringify(tally)}`);
  return out;
}

// Increment a gap's failed_attempts counter when an authoring attempt does NOT land
// (UNFAVORABLE / staged-not-pushed). Feeds landabilityScore so a stuck gap drops in
// priority and the loop stops churning on it instead of reaching landable work. Best-effort.
// EXPECTATION-SETTING (closure primitive, 2026-06-29): commit an explicit prediction of
// whether a gap will LAND, from its features (the landability prior IS the self-model's point
// estimate). The prediction is measured against the actual outcome (surprise = prediction
// error) so the substrate accrues a CALIBRATED self-model instead of acting blind. The
// counterfactual baseline is the 0.5 no-signal prior; p above/below it is the discriminating
// expectation.
// Learned per-category COUNTERFACTUAL baselines (expectation-setting step 2, 2026-06-29):
// persist the empirical {attempts,lands} per gap category in the workspace volume so
// predictLand's baseline is the real land-rate for "a gap like this", not a static 0.5 prior.
// The gap-specific signal (landabilityScore p) is judged AGAINST that learned counterfactual.
const CALIB_PATH = process.env.EXPECTATION_CALIB_PATH ?? "/workspace/expectation-calibration.json";
type CalibRec = Record<string, { attempts: number; lands: number }>;
// HELD, NOT LOCAL (value-per-cost-selection 5.5). The calibration is credited by the node that
// holds the gap store, from the gap writes every compose node sends it (a failed_attempts rise;
// a close with closed_reason landed_verified). A compose node reads that table, refreshed before
// each auto-pick, and uses its own file only when the holder cannot be read (logged). On the
// holder the read resolves locally and returns the same file.
let heldCalibration: CalibRec | null = null;
async function refreshHeldCalibration(): Promise<void> {
  try {
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1, include_calibration: true } as never);
    const cal = (r.body as { expectation_calibration?: unknown } | undefined)?.expectation_calibration;
    if (cal && typeof cal === "object") { heldCalibration = cal as CalibRec; return; }
    console.warn(`[expectation-calibration] gap store returned no calibration (shape=${String(r.shape)}) - using the local file`);
  } catch (err) {
    console.warn(`[expectation-calibration] holder read failed: ${String(err).slice(0, 200)} - using the local file`);
  }
  heldCalibration = null;
}
function readCalibration(): CalibRec {
  if (heldCalibration) return heldCalibration;
  try { return existsSync(CALIB_PATH) ? (JSON.parse(readFileSync(CALIB_PATH, "utf8")) as CalibRec) : {}; }
  catch { return {}; }
}

// ── Close-oracle posterior (§12.6 step 1(a), 2026-08-14) ────────────────────────────────
// The close-oracle is graded like any other activity: its per-evidence-class reliability accrues
// from ground truth, so its trust is EARNED, not assumed. A single-landing close via the
// landed-commit class is a provisional SUCCESS; a later RE-LAND on that class is the retrospective
// FALSE-CLOSE label (the prior close did not hold — reality re-detected the gap). Both labels are
// recorded at the close/refuse decision points, so the posterior is calibrated against the
// UN-AUTHORABLE REFERENT (re-detection) without instrumenting the re-open path. Per class the
// posterior is Beta(closes_that_held + 1, false_closes + 1); closeOracleReliability reads its mean.
// One label per gap (the callers dedup), so a single thrashing gap cannot dominate the posterior.
// Call-time (not module-load) so tests can point at a fixture file; production never sets it.
// ---- Gap-class Thompson posterior (Option B) + pickDecision emission (Option A) ----
// Same local-JSON pattern as CALIB_PATH / close-oracle-calibration: one row per gap CLASS,
// Beta(alpha, beta) over "a compose attempt on a gap of this class lands".
const CLASS_POSTERIOR_PATH = process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json";
const PICK_DECISIONS_PATH = "/workspace/proposals/pick-decisions.jsonl";
type ClassPosteriors = Record<string, { alpha: number; beta: number }>;
export function gapClassOf(g: Record<string, unknown>): string {
  // HUMAN-REPORTED CLASS BUCKET SPLIT (2026-09-25):
  // Previously, all operator-filed (human_reported) gaps were grouped into a single
  // class "human", forcing one Beta to represent ~70 unrelated works and letting
  // narrow recommit:* classes win the class re-rank. Key the class by the gap's
  // concrete edit_site stem when present so each operator-filed gap family learns
  // its own posterior and competes fairly.
  {
    const __cat = String((g as Record<string, unknown>).category ?? "");
    if (__cat === "human_reported") {
      const __gm = ((g as { classification_metadata?: unknown; metadata?: unknown }).classification_metadata
        ?? (g as { metadata?: unknown }).metadata
        ?? {}) as Record<string, unknown>;
      const __siteRaw = String((__gm.edit_site ?? __gm.change_site ?? __gm.single_file ?? __gm.file_path ?? "") || "");
      if (__siteRaw) {
        const __file = __siteRaw.split(/[\\\/]/).pop() ?? __siteRaw;
        const __stem = __file.replace(/\.[^.]+$/, "").toLowerCase();
        if (__stem) return `human:${__stem}`;
      }
      // Fallback: derive a light-weight bucket from the id so we still avoid a single monolith.
      const __id = String((g as Record<string, unknown>).id ?? "").toLowerCase();
      const __tok = (__id.match(/[a-z0-9]+/g) ?? ["unsited"]).slice(0, 1).join("-");
      return `human:${__tok || "unsited"}`;
    }
  }
  if (String(g.source ?? "") === "human_reported") return "human";
  let id = String(g.id ?? "");
  let recommit = false;
  while (id.startsWith("recommit-")) { id = id.slice("recommit-".length); recommit = true; }
  // Lineage stem: id up to the first volatile token (colon nonce, hex hash, long number),
  // capped at 3 hyphen tokens so per-artifact ids (docs-drift-<doc>) do not each mint a class.
  const stem = id.split(":")[0]!.replace(/-?[0-9a-f]{6,}.*$/i, "").replace(/-?\d{4,}.*$/, "").replace(/-$/, "").split("-").slice(0, 3).join("-");
  const base = stem.length >= 3 ? stem : String(g.category ?? "unknown");
  return (recommit ? "recommit:" : "") + base;
}
function readClassPosteriors(): ClassPosteriors {
  try { return existsSync(CLASS_POSTERIOR_PATH) ? (JSON.parse(readFileSync(CLASS_POSTERIOR_PATH, "utf8")) as ClassPosteriors) : backfillClassPosteriors(); }
  catch { return {}; }
}
// BACKFILL: an absent store seeds beta from historical compose failures (compose-lessons.jsonl
// rows carry gap_id; the file holds failures only). sqrt-damped so history cannot drown live evidence.
function backfillClassPosteriors(): ClassPosteriors {
  const out: ClassPosteriors = {};
  try {
    const fails = new Map<string, number>();
    for (const l of readFileSync("/workspace/proposals/compose-lessons.jsonl", "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const gid = String((JSON.parse(l) as Record<string, unknown>)["gap_id"] ?? "");
        if (gid) { const c = gapClassOf({ id: gid, source: "" }); fails.set(c, (fails.get(c) ?? 0) + 1); }
      } catch { /* skip bad line */ }
    }
    for (const [c, n] of fails) out[c] = { alpha: 1, beta: 1 + Math.min(30, Math.round(Math.sqrt(n))) };
    writeFileSync(CLASS_POSTERIOR_PATH, JSON.stringify(out));
  } catch { /* best-effort; an empty store is fine */ }
  return out;
}
export function updateClassPosterior(cls: string, landed: boolean): void {
  try {
    const p = readClassPosteriors();
    const rec = p[cls] ?? { alpha: 1, beta: 1 };
    if (landed) rec.alpha += 1; else rec.beta += 1;
    p[cls] = rec;
    writeFileSync(CLASS_POSTERIOR_PATH, JSON.stringify(p));
  } catch { /* best-effort */ }
}
// Exploration floor: every class samples from at least Beta(1,1) + its counts, never hard-zero mass.
export function sampleClassTheta(cls: string, posteriors?: ClassPosteriors): number {
  const rec = (posteriors ?? readClassPosteriors())[cls] ?? { alpha: 1, beta: 1 };
  const g = (k: number): number => { // Marsaglia-Tsang Gamma(k,1); valid for k >= 1
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = 0, v = 0;
      do { x = Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random()); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const ga = g(Math.max(1, rec.alpha)), gb = g(Math.max(1, rec.beta));
  return ga / (ga + gb);
}
// Infrastructure refusal: the host could not ground or admit the compose, so no draft ran and
// the outcome carries zero evidence about the gap class. Covers everything
// isNonAttemptComposeResult exempts, plus grounding/guard REFUSED (e.g. Grounding window (0 bytes)).
export function isInfraRefusalBody(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  if (isNonAttemptComposeResult(cb)) return true;
  const stage = String(cb.stage ?? "");
  return (stage === "grounding" || stage === "guard") && String(cb.verdict ?? "") === "REFUSED";
}
const closeOracleCalibPath = (): string => process.env["CLOSE_ORACLE_CALIB_PATH"] ?? "/workspace/close-oracle-calibration.json";
type CloseOracleCalib = Record<string, { closes: number; false_closes: number; operator_engaged?: number }>;
function readCloseOracleCalib(): CloseOracleCalib {
  try { const p = closeOracleCalibPath(); return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CloseOracleCalib) : {}; }
  catch { return {}; }
}
function recordCloseVerdict(evidenceClass: string, falseClose: boolean): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    if (falseClose) rec.false_closes += 1; else rec.closes += 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
// Operator-verdict-corpus calibration (§12.6 step 1b): when a HUMAN answers a re-land escalation
// (read back via solicitation_outcome_scan over obsidian interaction episodes), that engagement is
// an operator verdict corroborating the abstain — the oracle calibrating against the operator
// corpus, not just against reality's re-detection. Tracked honestly as engagement (met/unmet), not
// folded into the reliability posterior as a fake polar verdict, since met/unmet carries no polarity.
export function recordOperatorEngagement(evidenceClass: string): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    rec.operator_engaged = (rec.operator_engaged ?? 0) + 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
/** Beta-mean reliability of the close-oracle at an evidence class: P(a close of this class holds). */
export function closeOracleReliability(evidenceClass: string): { alpha: number; beta: number; reliability: number; closes: number; false_closes: number; operator_engaged: number } {
  const rec = readCloseOracleCalib()[evidenceClass || "unknown"] ?? { closes: 0, false_closes: 0 };
  const held = Math.max(0, rec.closes - rec.false_closes); // closes that did NOT later re-land
  const alpha = held + 1;                                  // Beta(1,1) prior
  const beta = rec.false_closes + 1;
  return { alpha, beta, reliability: alpha / (alpha + beta), closes: rec.closes, false_closes: rec.false_closes, operator_engaged: rec.operator_engaged ?? 0 };
}
function predictLand(gap: Record<string, unknown>): { predicted: boolean; p: number; baseline: number } {
  const p = landabilityScore(gap);
  // Counterfactual baseline = empirical land-rate for this gap's category (>=5 samples),
  // else the 0.5 no-signal prior. Predict land only if the gap's signal beats its class.
  const c = readCalibration();
  const rec = c[String(gap.category ?? "unknown")];
  const baseline = rec && rec.attempts >= 5 ? rec.lands / rec.attempts : 0.5;
  return { predicted: p >= Math.max(0.4, baseline), p, baseline };
}

/**
 * A compose that never RAN is not a compose that FAILED.
 *
 * feature-compose returns `verdict: "BUSY"` / `stage: "capacity"` when the slot cap is
 * hit, and its own comment marks the distinction as load-bearing: "BUSY, not REFUSED.
 * Capacity is TRANSIENT — the work is fine, the host is full — whereas REFUSED means
 * this should not be done." goal-host honours it (backs off 45s and retries). This file
 * did not: the word BUSY appeared nowhere in it, so a capacity refusal fell through as
 * a plain `ok:false` into bumpFailedAttempts, which BOTH decays the gap's score and
 * calls updateCalibration(category, false). Since hopeless() excludes a category at
 * attempts >= 8 with lands === 0, a run of capacity refusals could seal an ENTIRE
 * CATEGORY without a single compose ever having run — a non-attempt recorded as a
 * failed attempt.
 *
 * Measured 2026-08-29: `reach_grounding_gap` went from absent (attempts 0) to
 * attempts=5 / lands=0 in ~6h on refusals alone, three short of sealing, while five
 * gaps sat at failed_attempts=2 with `approach_decisions[].outcome.joined_at` within
 * 200-800ms of the pick — orders of magnitude too fast for a compose to have run.
 *
 * `environment` was already excluded at the main call site for exactly this reason;
 * capacity is the same class, so both live here and every call site asks one question.
 */
/** A TERMINAL refusal (feature-compose op10): the gap is closed, or its own check is already GREEN on the
 *  parent tree. Unlike a non-attempt the compose DID run, so it keeps its full cooldown; unlike a failure no
 *  repair can change it, so it never bumps failed_attempts, never narrows and never decomposes (those spawn
 *  the redispatches that re-composed a fixed gap for 40 min on 2026-09-30). */
export function isTerminalRefusalResult(cb: Record<string, unknown> | null | undefined): boolean {
  return String(cb?.failure_kind ?? "") === "terminal_refusal";
}

/** Hours an OPEN gap whose own check was found GREEN on the parent stays out of admission. The check passing
 *  without a fix means the gap is already fixed (the sweep will close it) or its check is wrong (an operator
 *  must look); re-picking it every cooldown can do neither. */
export const OWN_GREEN_ADMISSION_TTL_MS = 6 * 60 * 60 * 1000;
export function greenOnParentFresh(meta: Record<string, unknown>, nowMs: number = Date.now()): boolean {
  const m = meta.own_check_green_on_parent as { at?: unknown } | undefined;
  const at = typeof m?.at === "string" ? Date.parse(m.at) : NaN;
  return Number.isFinite(at) && nowMs - at < OWN_GREEN_ADMISSION_TTL_MS;
}

/** The commit that turned a gap's own check green: the newest commit touching the check's subject files (the
 *  own-check test file, the edit_site, check_inputs; see birthCheckRepo) after the gap's birth tree
 *  (predicate_birth_sha, else detected_at), on the clone HEAD the parent tree was cut from. null when none. */
function fixingCommitSinceBirth(gap: Record<string, unknown>, meta: Record<string, unknown>): { sha: string; head: string } | null {
  const repo = birthCheckRepo(meta);
  if (!repo || repo.files.length === 0 || !existsSync(join(repo.dir, ".git"))) return null;
  const head = sweepGitOut(repo.dir, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const birth = typeof meta.predicate_birth_sha === "string" ? meta.predicate_birth_sha : "";
  const since = typeof gap.detected_at === "string" && Number.isFinite(Date.parse(gap.detected_at)) ? gap.detected_at : "";
  const range = birth && sweepGitOut(repo.dir, ["cat-file", "-e", `${birth}^{commit}`]) !== null ? [`${birth}..HEAD`] : since ? [`--since=${since}`, "HEAD"] : null;
  if (!range) return null;
  const sha = sweepGitOut(repo.dir, ["log", "-1", "--format=%H", ...range, "--", ...repo.files]);
  return sha ? { sha, head } : null;
}

/** Exported for tests. A green-on-parent refusal with a commit that fixed the check's subject since the gap's
 *  birth CLOSES the gap fixed_elsewhere (a measurement, naming that commit), instead of re-picking it after
 *  every exclusion. With no such commit the green is unexplained (flaky, environmental): exclusion only. */
export async function markTerminalRefusal(gap: Record<string, unknown>, cb: Record<string, unknown> | null | undefined): Promise<void> {
  const why = String(cb?.terminal_refusal ?? "");
  console.log(`[gap-to-feature] terminal refusal for ${String(gap.id ?? "?")}: ${why || "(no reason)"}; no bump, full cooldown`);
  if (!why.startsWith("the gap's own check is already GREEN on the parent tree")) return;
  try {
    const fresh = await readGapFresh(String(gap.id ?? ""));
    if (!fresh || String(fresh.status ?? "") !== "open") return;
    const m0 = ((fresh.classification_metadata ?? {}) as Record<string, unknown>);
    const fix0 = predicateSuspect(m0) === null ? fixingCommitSinceBirth(fresh, m0) : null;
    // A reopened gap is not fixed_elsewhere by a commit that landed before its re-detection.
    const staleFix = fix0 ? staleCloseEvidence(fresh, fix0.sha) : null;
    if (staleFix) console.log(`[gap-to-feature] ${String(fresh.id)}: not closed fixed_elsewhere: ${staleFix.reason} (${fix0!.sha.slice(0, 12)} landed ${staleFix.committed_at ?? "unknown"}, re-detected ${staleFix.redetected_at})`);
    const fix = staleFix ? null : fix0;
    if (fix) {
      const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...fresh, status: "closed", classification_metadata: { ...m0,
        closed_reason: "fixed_elsewhere", close_basis: "absent", resolution: `fixed elsewhere by ${fix.sha.slice(0, 12)}: own check green on parent ${fix.head.slice(0, 12)}`, closed_at: new Date().toISOString(),
        falsifier_exercise: { detector: "gap-to-feature:terminal_refusal", verdict: "absent", passed: true, ran_at: new Date().toISOString(), commit: fix.head, fixed_by: fix.sha } } } } as never);
      if (w?.shape !== "structuredError" && (w?.body as { action?: unknown } | undefined)?.action !== "skipped") {
        console.log(`[gap-to-feature] ${String(fresh.id)}: closed fixed_elsewhere by ${fix.sha.slice(0, 12)} (own check green on parent ${fix.head.slice(0, 12)})`);
        return;
      }
    } else {
      console.log(`[gap-to-feature] ${String(fresh.id)}: green on parent but no fixing commit found — not closing`);
    }
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...fresh, classification_metadata: { ...m0, own_check_green_on_parent: { at: new Date().toISOString(), reason: why.slice(0, 300) } } } } as never);
  } catch { /* best-effort: without the marker the full cooldown still bounds re-picks */ }
}

/** Dispositions that park a gap OUT of autonomous work until a human acts: needs_information (waiting for a fact
 *  or a localization) and awaiting_operator_review (a landing waiting for review). Admission reads them, and
 *  generic writers must not overwrite them (markPendingVerification clobbered awaiting_operator_review within
 *  40 s on 2026-09-30); a human answer clears needs_information (escalation-disposition-apply). */
// "needs_info" is the spelling gap-lifecycle-scan writes when it parks a chronic re-emitter (qa, 2026-09-30).
export const PARKING_DISPOSITIONS: readonly string[] = ["needs_information", "needs_info", "awaiting_operator_review"];
export function isParkingDisposition(d: unknown): boolean {
  return typeof d === "string" && PARKING_DISPOSITIONS.includes(d);
}

/** A landed gap held for its verdict: disposition pending_verification (markPendingVerification) with nothing yet
 *  saying the landing failed. regressed_by or a BEHAVIORAL VERIFICATION FAILED summary means it did not fix the
 *  gap, so the gap is work again; the sweep's not-resolved verdict lifts the disposition (liftLandVerificationHold). */
export function isAwaitingLandVerification(gap: Record<string, unknown>): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  if (meta.disposition !== "pending_verification") return false;
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return false;
  if (String(gap.summary ?? "").includes("BEHAVIORAL VERIFICATION FAILED")) return false;
  return true;
}

/** The metadata that releases a pending_verification hold ("" because the gap store carries omitted keys
 *  forward), or null when there is no such hold: parking dispositions are a human's to lift, and a null lets the
 *  sweep write once rather than every tick. */
export function liftLandVerificationHold(meta: Record<string, unknown>): Record<string, unknown> | null {
  return meta.disposition === "pending_verification" ? { ...meta, disposition: "" } : null;
}

/** Whether the verifier's 'present' for this gap is a MEASUREMENT (class 1 literal, class 1b expected literal,
 *  class 2 resolver behaviour) rather than class-3 provenance, where 'present' only means "landed twice" and goes
 *  to a human. Mirrors the predicate order in verifyGapConditionAsync. */
export function landVerdictIsMeasured(meta: Record<string, unknown>): boolean {
  if (meta.evidence_resolve !== undefined || meta.verify_shape !== undefined) return true;
  const editSite = typeof meta.file_path === "string" ? meta.file_path : (typeof meta.edit_site === "string" ? meta.edit_site : "");
  if (!editSite) return false;
  return nonEmptyStr(meta.hardcoded_url) !== null || nonEmptyStr(meta.expected_literal) !== null;
}

export function isNonAttemptComposeResult(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  if (String(cb.failure_kind ?? "") === "environment") return true;
  if (String(cb.verdict ?? "") === "BUSY") return true;
  if (String(cb.stage ?? "") === "capacity") return true;
  return false;
}

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

// Decide whether a chronically-failing gap should be narrowed into a fresh child.
//
// Only narrow a ROOT gap; an already-narrowed child (parent_gap_id set) must not spawn
// grandchildren, else chronic failure produces an unbounded -narrowed-narrowed chain.
// A recommit- gap (feature-compose.ts's own retry-cap mechanism) records its lineage as
// re_commit/source_gap_id, never parent_gap_id, so without this check it looks like a
// root to THIS guard and gets narrowed too — then, if the narrowed result fails compose
// again, feature-compose wraps it in another recommit- layer (which again omits
// parent_gap_id), making it eligible for narrowing all over again. Each narrowing resets
// failed_attempts to 0 (and with it landability back to 1.0), so the two caps alternate
// forever instead of either ever holding — confirmed via the recommit-*-syntax_break-
// -narrowed chain measured on 2026-08-07 (id: route-edit-2206dec0:1's lineage).
export function shouldNarrowForChronicFailure(failedAttempts: number, meta: Record<string, unknown>): boolean {
  return failedAttempts >= 3 && !meta.parent_gap_id && !meta.re_commit && !meta.source_gap_id;
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

// Exported for unit test only (the investigation caller's one-decomposition-per-gap guard). No call-site change.
export async function bumpFailedAttempts(gap: Record<string, unknown>, opts: { surprise?: boolean; predictedP?: number } = {}): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    // The write below is unconditional (status open), so on a gap that CLOSED while its compose was in flight it
    // would REOPEN it with closed_at carried forward. Re-read first; a closed or unreadable row is not bumped.
    const fresh = await readGapFresh(id);
    if (!fresh || String(fresh.status ?? "") === "closed") return;
    // BUILD ON THE STORED ROW, NOT THE CALLER'S SNAPSHOT. The snapshot is the gap as it was PICKED;
    // the compose that just failed wrote its failure lesson to the store in between, and the store
    // replaces classification_metadata (it carries forward only OMITTED keys). Writing the snapshot
    // back wiped that lesson whenever the snapshot already held a failure_lessons key, and the
    // narrowing check below then read the same stale list ("NOT narrowing: no failure_lessons
    // recorded"). Measured 10-01: every compose followed by a bump lost its lesson, on both nodes.
    const freshMeta = fresh.classification_metadata ?? fresh.metadata;
    const meta0 = ((freshMeta && typeof freshMeta === "object" && !Array.isArray(freshMeta)) ? freshMeta : (gap.classification_metadata ?? gap.metadata ?? {})) as Record<string, unknown>;
    // A non-landing attempt the substrate PREDICTED would land is a high-information SURPRISE
    // (over-optimistic self-model) → deprioritise harder (x2) and tally the calibration miss so
    // the self-model is measurable. A correctly-predicted fail bumps normally.
    // Calibration attempt credit is taken by the gap-store holder from the failed_attempts rise below.
    const weight = opts.surprise ? 2 : 1;
    const fa = Number(meta0.failed_attempts ?? 0) + weight;
    const mis = Number(meta0.mispredicted_lands ?? 0) + (opts.surprise ? 1 : 0);
    // SPEND THE HUMAN-AUTHORIZED EXEMPTION (2026-08-28). The exemption granted by
    // escalation_disposition_apply is BOUNDED, and this is the only place the bound can
    // bind: a non-landing attempt consumes one. Without this decrement "bounded" would be
    // a word in a comment — the gap would re-enter selection forever on one human answer
    // and re-open the flood 143212a deliberately closed. At zero the seal applies again
    // and the gap re-escalates, which is the correct end state: the human's answer was
    // tried, it did not land, and the human should be asked again rather than the loop
    // grinding on it.
    const exRem = Number(meta0.human_exemption_attempts_remaining ?? 0);
    const exemptionPatch = exRem > 0
      ? { human_exemption_attempts_remaining: exRem - 1, human_exemption_spent_at: new Date().toISOString() }
      : {};
    const meta = { ...meta0, ...exemptionPatch, failed_attempts: fa, last_failed_at: new Date().toISOString(), mispredicted_lands: mis, last_predicted_p: opts.predictedP ?? meta0.last_predicted_p };
    joinDecisionOutcome(meta, { landed: false });
    const bumpWrite = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      // Conditional: a row closed since the fresh read above stays closed (no reopen, no compose pickup).
      expect_status: "open",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "open",
      },
    } as never);
    // Closed in between: nothing was written, so nothing is narrowed or escalated from the stale copy.
    if ((bumpWrite?.body as { skip_reason?: unknown } | undefined)?.skip_reason === "status_precondition_failed") {
      console.log(`[gap-to-feature] failed-attempt bump for ${id} not written: the row is no longer open`);
      return;
    }
    // Emit narrowed child gap when the gap has now reached the chronic-failure
    // threshold (>= 3 failed_attempts). The child carries a tighter description
    // and resets failed_attempts to 0 so it re-enters the dispatch queue at
    // normal priority rather than being culled by the landabilityScore filter.
    const willExceedThreshold = shouldNarrowForChronicFailure(fa, meta0);
    if (willExceedThreshold) {
      try {
        const parentId: string = id;
        const parentSummary = String(gap.summary ?? gap.title ?? "");
        // A narrowed child is a NEW gap about the same defect. It must not inherit
        // fields that assert authorship or closure STATE: `detector` and
        // `evidence_resolve` made self_fact_reconcile close two clones it never filed
        // (2026-09-23 03:35, 04:00); landing/closed/pending stamps would let the sweep
        // grade the child on the parent's evidence. Localisation (edit_site, file_path)
        // and an operator-authored predicate (expected_literal / hardcoded_url /
        // verify_shape) ARE the defect and stay. A predicate DERIVED from the parent's
        // landing commit (predicate_source set) goes with its stamps: the parent already
        // landed that literal and still failed, so the child would be born satisfied.
        // The store reclassifies `falsifier` on write (substrate-gap.ts), so the class
        // label is recomputed from what survives, never carried.
        const INHERIT_NEVER = new Set([
          "detector", "evidence_resolve", "falsifier_exercise",
          "pending_outcome_verification", "pending_set_at", "pending_note",
          "predicate_source", "predicate_derived_at", "predicate_commit",
          "closed_reason", "close_basis", "closed_at", "resolution", "landed_sha",
          "operator_hold", "operator_hold_reason", "reopen_note",
        ]);
        const derivedPredicate = typeof (meta as Record<string, unknown>)["predicate_source"] === "string";
        const inherited: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(meta)) {
          if (INHERIT_NEVER.has(k)) continue;
          if (derivedPredicate && (k === "expected_literal" || k === "hardcoded_url")) continue;
          inherited[k] = v;
        }
        // THE PARENT'S CHECK COMES BACK when the child's scope still covers it (inheritableParentCheck: a
        // trusted class-2 test_suite check on the same edit site). Stripping it with the closure stamps above
        // left every narrowed child of a verifiable parent falsifier=none, so none could ever close verified.
        Object.assign(inherited, inheritableParentCheck(meta, (meta as Record<string, unknown>)["edit_site"]));
        const childMeta = { ...inherited, failed_attempts: 0, parent_gap_id: parentId, narrowed_at: new Date().toISOString() };
        // Without failure lessons the child's summary would be the parent's verbatim
        // (measured: 222 `-narrowed` rows, many byte-identical to their parent) — a
        // duplicate that only splits the picker's attention. Narrow only what can be
        // narrowed.
        const lessonsForChild = Array.isArray((meta as Record<string, unknown>)["failure_lessons"]) ? ((meta as Record<string, unknown>)["failure_lessons"] as unknown[]) : [];
        if (lessonsForChild.length === 0 || String((lessonsForChild[lessonsForChild.length - 1] as Record<string, unknown>)?.["reason"] ?? "").startsWith("[deterministic] ")) {
          console.log(`[gap-to-feature] NOT narrowing ${parentId}: no failure_lessons recorded — the child would be a verbatim duplicate`);
        } else {
        const childRecord: Record<string, unknown> = {
          // Deterministic id so re-narrowing the SAME parent upserts one idempotent child
          // (gapClassKey has no volatile token to strip here) instead of throwing on a
          // missing id or spawning a new row every failure.
          id: `${parentId}-narrowed`,
          category: gap.category,
          source: gap.source,
          summary: "[narrowed from " + parentId + "] " + parentSummary.replace(/^\[narrowed from [\w:.!-]+\]\s*/g, "") + (Array.isArray((meta as Record<string, unknown>)["failure_lessons"]) && ((meta as Record<string, unknown>)["failure_lessons"] as unknown[]).length > 0 ? "\n\nWHY PREVIOUS ATTEMPTS ON THIS GAP FAILED (most recent last):\n" + ((meta as Record<string, unknown>)["failure_lessons"] as Array<Record<string, unknown>>).slice(-3).map((l) => "- " + String(l["class"] ?? "?") + ": " + String(l["reason"] ?? "").slice(0, 300)).join("\n") + "\n\nDo not repeat these failures. Address the specific cause named above." : ""),
          detected_at: gap.detected_at,
          classification_metadata: childMeta,
          status: "open",
        };
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: childRecord as never });
        const childId = String((childRecord as Record<string,unknown>).id ?? "");
        console.log(`[gap-to-feature] emitted narrowed child gap for chronically-stuck gap ${parentId}: ${childId}`);
        }
        await escalateToDecomposition(gap, "chronic failure");
      } catch (err) {
        // Child gap emission is best-effort; never block the parent update.
        console.warn(`[bumpFailedAttempts] child gap emit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch { /* best-effort */ }
}

/** The node an approach decision and its outcome belong to (as registerAttempt stamps attempt intents). */
const decisionNode = (): string => process.env["SUBSTRATE_NAME"] ?? "substrate";

/** Records the pick's decision and returns its decision_id (null when the write could not be built). */
export async function recordApproachDecision(gap: Record<string, unknown>): Promise<string | null> {
  try {
    const pred = predictLand(gap);
    const meta = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(meta.approach_decisions) ? (meta.approach_decisions as unknown[]) : [];
    const decisionId = `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    arr.push({
      decision_id: decisionId,
      node: decisionNode(),
      at: new Date().toISOString(),
      predicted_p: pred.p,
      predicted_land: pred.predicted,
      edit_site: meta.edit_site ? String(meta.edit_site) : "",
      alternatives: ["full-scope-compose"],
    });
    while (arr.length > 5) arr.shift();
    meta.approach_decisions = arr;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { ...gap, classification_metadata: meta, status: String(gap.status ?? "open") },
    } as never);
    return decisionId;
  } catch { /* best-effort */ return null; }
}

/** OWNED JOIN: an outcome joins the entry with its decision_id, else the newest unjoined entry its own node made
 *  (or a legacy entry with no node), else it is appended as its own joined entry. It never writes onto another
 *  node's decision: two nodes picking one gap each keep their own decision/outcome pair. */
export function joinDecisionOutcome(meta: Record<string, unknown>, outcome: Record<string, unknown>, ref: { decision_id?: string; node?: string } = {}): boolean {
  const node = ref.node ?? decisionNode();
  // An absent or fully-joined decision list is not a reason to discard a terminal outcome.
  // recordApproachDecision pushes a fresh unjoined entry on every PICK, so the ordinary
  // compose path always has somewhere to write. The mitosis-cutover sweep closes gaps in
  // BULK with no pick, so it has no unjoined entry and often no decision list at all, and
  // this function used to drop its landed:true write silently every single time.
  // Measured 2026-09-05 on the live store: of 44 gaps closed with a landed reason, 25 of the
  // 32 carrying decisions had EVERY decision reading landed:false, and a further 12 had no
  // approach_decisions key at all. 37 of 44 landings were invisible.
  if (meta.approach_decisions === undefined) meta.approach_decisions = [];
  const arr = meta.approach_decisions;
  if (!Array.isArray(arr)) return false;
  // IDEMPOTENT PER (gap, commit) for a FAVORABLE landing (2026-10-03): a gap re-closed on the landing it was
  // already credited for (19 times in a day for one commit on the trace-list gap) is not a new success.
  // Returns false so the caller does not pay the landing's posterior again either.
  if (outcome.landed === true && outcome.verdict === "FAVORABLE" && typeof outcome.commit === "string" && outcome.commit) {
    const already = arr.some((e) => {
      const o = (e && typeof e === "object" ? (e as Record<string, unknown>).outcome : undefined) as Record<string, unknown> | undefined;
      return !!o && o.landed === true && o.verdict === "FAVORABLE" && o.commit === outcome.commit;
    });
    if (already) return false;
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || "outcome" in entry) continue;
    const mine = ref.decision_id ? entry.decision_id === ref.decision_id : (entry.node === undefined || entry.node === node);
    if (mine) {
      entry.outcome = { ...outcome, joined_at: new Date().toISOString() };
      return true;
    }
  }
  arr.push({ at: new Date().toISOString(), appended_by: "joinDecisionOutcome", ...(ref.decision_id ? { decision_id: ref.decision_id } : {}), node, outcome: { ...outcome, joined_at: new Date().toISOString() } });
  while (arr.length > 5) arr.shift();
  return true;
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
  const land = genuineLandSignal(cb, true);
  let closed = false;
  if (land.landed) {
    const c = await closeLandedGap(gap, land);
    closed = c.closed;
  } else if (isTerminalRefusalResult(cb)) {
    await markTerminalRefusal(gap, cb);
  } else if (!isNonAttemptComposeResult(cb)) {
    if (!isInfraRefusalBody(cb)) updateClassPosterior(gapClassOf(gap), false);
    // A capacity refusal here is a retry, not a failure — see isNonAttemptComposeResult.
    await bumpFailedAttempts(gap);
  }
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

// SPEND ENVELOPE (value-per-cost-selection 4.1/4.2). Autonomous spending obeys one hourly USD
// envelope read at use time as a shaped impulse: the newest open poolImpulse of shape
// `spendEnvelope` ({usd_cap_per_hour, paused, reason}) across every poolImpulse producer of THIS
// substrate (discoverOwnResolveUrls: a peer substrate's producers never count), so a record written
// on either node binds both. Spent = the sum over every
// distinct llmSpendSummary producer of its current window plus the unexpired share of its
// previous window (a sliding hour). NO CAP IS ONLY EVER EXPLICIT: a record {uncapped: true}
// (and not paused) allows without a cap. Every own producer answering with no spendEnvelope
// record is ABSENT, and absent refuses exactly like unreadable (`absent: true` names which): a
// node that holds no record of its own must not read "no record" as "no cap" (10-01, node 2).
// A record with neither a finite usd_cap_per_hour nor uncapped:true, or with both, refuses too.
// A discovered producer that does not answer makes the envelope UNREADABLE, and unreadable
// blocks (fail closed): a partial read could miss the one node that holds the pause.
// Cached for SPEND_ENVELOPE_TTL_MS so a gap-write burst costs one read.
// `lookup_failed` marks an unreadable verdict whose cause was discovery itself (timeout, network,
// 5xx), as opposed to a discovery answer naming no producer: both fail closed, but only the second
// says anything about the fleet.
// FAIR SHARE (value-per-cost-selection 4.5), optional fields on the same record, each absent = off:
//   lineage_usd_cap_per_window + lineage_window_s (default 3600): a gap lineage that has spent the
//     ceiling inside the window without landing is held from auto-pick (lineageSpendHeld), so one
//     low-yield lineage cannot drain the shared cap;
//   max_node_share (0 < f <= 1): this node refuses once ITS OWN spend reaches f x cap, leaving the rest of
//     the shared cap to the other nodes (`node_share_exhausted`). Not yield-weighted: no per-node landing
//     count is read here (5.3 remains open for that).
// A field that is present but not a positive finite number (or a share above 1) is a misconfiguration and
// refuses like a non-finite cap. The global cap stays the hard ceiling either way.
export type SpendEnvelopeVerdict = { allow: boolean; reason: string; unreadable?: boolean; absent?: boolean; lookup_failed?: boolean; paused?: boolean; cap_usd?: number; spent_usd?: number; spend_sources?: number; lineage_usd_cap?: number; lineage_window_ms?: number; max_node_share?: number; own_spent_usd?: number; node_share_exhausted?: boolean };
const SPEND_ENVELOPE_TTL_MS = 30_000;
// An UNREADABLE policy verdict is remembered only as long as a failed discovery lookup is, so the
// next read after a slow peer re-reads instead of refusing for 30 s on one timeout (09-30, node 2).
const policyUnreadableRetryMs = (): number => discoveryFailureBackoffMs();
let spendEnvelopeCache: { at: number; v: SpendEnvelopeVerdict } | null = null;
// An UNREADABLE envelope always refuses, and so does an ABSENT one (a read that succeeded and found
// no spendEnvelope record on any own producer): "no cap" is a record that says {uncapped: true},
// never the lack of one. Whether a record was ever seen is process memory, false at every start,
// so no refusal may be gated on it (it failed open after every restart whose first read failed).
/** The resolve URL of every producer of `shape`, through the shared discovery client. A lookup
 *  that could not be answered comes back as `{ok:false}` with its reason, never as an empty list. */
async function discoverResolveUrls(shape: string): Promise<{ ok: true; urls: string[] } | { ok: false; why: string }> {
  const r = await lookupShape(shape);
  if (!r.ok) return { ok: false, why: describeLookup(r) };
  return { ok: true, urls: [...new Set(r.producers.map((p) => p.resolveEndpoint).filter((u) => u.length > 0))] };
}

// OWN-SUBSTRATE PRODUCERS ONLY (substrate-local policy reads). Discovery unions this node's producers
// with every federated peer's, so "the newest record across every poolImpulse producer" let a PEER
// substrate set OUR autonomy scope and spend envelope by writing a permissive record with a later
// updated_at. The policy readers below take a producer only when it is provably this substrate's:
//   - origin "local": served from this node's own discovery registry, or
//   - origin "peer:<E>" with E in this substrate's node list AND origin_upstream "local": served from
//     the registry of a node of this same substrate (not merely relayed through one, which is how a
//     third substrate's rows reach node 2 via node 1).
// Everything else is foreign: other peers, libp2p facades ("overlay"), and every UNSTAMPED row (an
// older discovery that names no origin is not provably anyone's, so it fails closed, never open).
// The node list is itself a shaped record read at use time (law 1): the newest open poolImpulse of
// shape `substrateNodes` ({discovery_endpoints: string[], reason}), read from LOCAL-origin producers
// only, since a list read through peers could be written by the very peer it is meant to exclude.
// No record = an empty list: peer rows are refused and local rows are still own, so a standalone node
// never halts on it (a node of a multi-node substrate then reads only its own pool until the list is
// written). An UNREADABLE list fails the policy read closed. It is read only when discovery returned a
// peer row that could be own (a listed node's local row), so a standalone node never reads it. Cached
// like the scope.
export type OwnProducerView = { origin?: string; originUpstream?: string | null };
const endpointKey = (e: string): string => {
  const t = String(e).trim();
  try { const u = new URL(t); if (u.protocol === "http:" || u.protocol === "https:") return u.origin; } catch { /* not a URL */ }
  return t.replace(/\/+$/, "");
};
// A FUTURE libp2p POLICY PRODUCER FAILS CLOSED. Discovery stamps a libp2p row in its own registry
// "overlay" (a facade for a vessel served elsewhere), and "overlay" is never own here. If this
// substrate ever serves poolImpulse over libp2p from one of its own nodes, these reads will refuse that
// producer (and, if it is the only one, read unreadable) until the overlay origin is classified: e.g.
// discovery stamping an own-substrate overlay row by an attested peer id. Do not widen this predicate to
// accept "overlay" without that classification; an overlay row is registered on behalf of a remote peer.
// origin_upstream is read ONLY here, as the claim of a node already in the list; nothing else may treat
// it as an identity.
/** True iff a discovered producer is this substrate's own (see above). Unstamped rows are never own. */
export function isOwnSubstrateProducer(p: OwnProducerView, nodeEndpoints: readonly string[]): boolean {
  if (p.origin === "local") return true;
  if (typeof p.origin !== "string" || !p.origin.startsWith("peer:")) return false;
  if (p.originUpstream !== "local") return false;
  const asked = endpointKey(p.origin.slice("peer:".length));
  return nodeEndpoints.some((e) => endpointKey(e) === asked);
}
type SubstrateNodes = { ok: true; endpoints: string[]; reason: string } | { ok: false; why: string };
const SUBSTRATE_NODES_TTL_MS = 30_000;
let substrateNodesCache: { at: number; v: SubstrateNodes } | null = null;
/** This substrate's discovery endpoints, from the newest open `substrateNodes` poolImpulse on LOCAL producers. */
export async function substrateNodeEndpoints(): Promise<SubstrateNodes> {
  if (substrateNodesCache && Date.now() - substrateNodesCache.at < (substrateNodesCache.v.ok ? SUBSTRATE_NODES_TTL_MS : policyUnreadableRetryMs())) return substrateNodesCache.v;
  let v: SubstrateNodes;
  try {
    const r = await lookupShape("poolImpulse");
    if (!r.ok) {
      v = { ok: false, why: "substrateNodes unreadable: " + describeLookup(r) };
      console.log(policyReadLine("substrateNodes", { asked: [], verdict: `unreadable (${v.why})` }));
    } else {
      const local = policyProducers(r.producers.filter((p) => (p as OwnProducerView).origin === "local"));
      if (local.length === 0) {
        v = { ok: false, why: `substrateNodes unreadable: no local-origin poolImpulse producer (${r.producers.length} non-local ignored)` };
        console.log(policyReadLine("substrateNodes", { asked: local, verdict: `unreadable (${v.why})` }));
      } else {
        const read = await readNewestPoolRecord("substrateNodes", local);
        if (read.silent.length > 0) {
          v = { ok: false, why: "substrateNodes unreadable: no answer from " + read.silent[0]!.url };
          console.log(policyReadLine("substrateNodes", { asked: local, answered: read.answered, verdict: `unreadable (${v.why})` }));
        } else {
          const raw = (read.newest?.body as { discovery_endpoints?: unknown } | undefined)?.discovery_endpoints;
          const endpoints = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map(endpointKey) : [];
          v = { ok: true, endpoints, reason: read.newest ? `substrateNodes: ${endpoints.length} node endpoint(s)` : "no substrateNodes record (local producers only)" };
          console.log(policyReadLine("substrateNodes", { asked: local, answered: read.answered, found: !!read.newest, entries: endpoints.length, verdict: read.newest ? `${endpoints.length} node endpoint(s)` : "no node list: peer rows refused, local rows only" }));
        }
      }
    }
  } catch (err) {
    v = { ok: false, why: "substrateNodes unreadable: " + String(err) };
  }
  substrateNodesCache = { at: Date.now(), v };
  return v;
}
/** discoverResolveUrls restricted to this substrate's own producers. A failed lookup, or an unreadable
 *  node list, is `{ok:false}`; `foreign` counts the producers set aside. */
export async function discoverOwnResolveUrls(shape: string): Promise<{ ok: true; urls: string[]; producers: PolicyProducer[]; foreign: number } | { ok: false; why: string; lookup_failed: boolean }> {
  const r = await lookupShape(shape);
  if (!r.ok) return { ok: false, why: describeLookup(r), lookup_failed: true };
  // The node list matters only for a peer row that could be own (a listed node's local row). With
  // none, it is not read: a standalone node's reads never depend on it.
  const mayBeOwnPeer = r.producers.some((p) => { const v = p as OwnProducerView; return typeof v.origin === "string" && v.origin.startsWith("peer:") && v.originUpstream === "local"; });
  let nodeEndpoints: string[] = [];
  if (mayBeOwnPeer) {
    const nodes = await substrateNodeEndpoints();
    if (!nodes.ok) return { ok: false, why: nodes.why, lookup_failed: false };
    nodeEndpoints = nodes.endpoints;
  }
  const own = r.producers.filter((p) => isOwnSubstrateProducer(p as OwnProducerView, nodeEndpoints));
  const producers = policyProducers(own);
  return { ok: true, urls: producers.map((p) => p.url), producers, foreign: r.producers.length - own.length };
}
// A policy producer as the read logs it: its resolve URL and the origin discovery stamped on it.
type PolicyProducer = { url: string; origin: string };
const policyProducers = (ps: ReadonlyArray<{ resolveEndpoint: string }>): PolicyProducer[] => {
  const seen = new Map<string, PolicyProducer>();
  for (const p of ps) if (p.resolveEndpoint.length > 0 && !seen.has(p.resolveEndpoint)) seen.set(p.resolveEndpoint, { url: p.resolveEndpoint, origin: String((p as OwnProducerView).origin ?? "unstamped") });
  return [...seen.values()];
};
type PoolRecord = { shape?: string; updated_at?: string; body?: unknown };
/** The newest open pool record of `shape` across `producers`, read in parallel. `silent` lists every
 *  producer that gave no answer (the read is then unreadable); `newest` is null when none holds one. */
async function readNewestPoolRecord(shape: string, producers: readonly PolicyProducer[]): Promise<{ answered: PolicyProducer[]; silent: PolicyProducer[]; newest: PoolRecord | null }> {
  const res = await Promise.all(producers.map((p) => postEnvelopeRead(p.url, { impulse: { type: "poolImpulse", shape, status: "open" } })));
  const answered: PolicyProducer[] = [];
  const silent: PolicyProducer[] = [];
  let newest: PoolRecord | null = null;
  producers.forEach((p, i) => {
    const imps = (res[i]?.["body"] as { impulses?: unknown } | undefined)?.impulses;
    if (!Array.isArray(imps)) { silent.push(p); return; }
    answered.push(p);
    for (const imp of imps as PoolRecord[]) {
      if (imp.shape === shape && (!newest || String(imp.updated_at ?? "") > String(newest.updated_at ?? ""))) newest = imp;
    }
  });
  return { answered, silent, newest };
}
// ONE JOURNAL LINE PER POLICY READ (on cache refresh, never per cached use): which own producers were
// asked (count + origins), which answered, whether a record was found and how many entries it holds,
// and the verdict. "Readable but empty" is a line of its own (record ABSENT among N answering own
// producers -> closed), so a node reading no policy is visible in the journal, never silent.
const describeProducers = (ps: readonly PolicyProducer[]): string => `${ps.length} [${ps.map((p) => p.origin).join(", ")}]`;
export function policyReadLine(shape: string, a: { asked: readonly PolicyProducer[]; answered?: readonly PolicyProducer[]; found?: boolean; entries?: number; verdict: string }): string {
  const answered = a.answered ? `answered ${describeProducers(a.answered)}` : "answered -";
  const record = a.found === undefined ? "record -" : a.found ? `record found (${a.entries ?? 0} entr${a.entries === 1 ? "y" : "ies"})` : `record ABSENT among ${a.answered?.length ?? 0} answering own producer(s)`;
  return `[policy-read] ${shape}: asked ${describeProducers(a.asked)} own producer(s); ${answered}; ${record} → ${a.verdict}`;
}
const foreignNote = (n: number): string => (n > 0 ? ` (${n} non-own producer(s) ignored)` : "");

/** Tests only: forget the policy verdicts and every remembered discovery lookup (a fresh process). */
export function __resetPolicyReadsForTests(): void {
  spendEnvelopeCache = null;
  autonomyScopeCache = null;
  substrateNodesCache = null;
  __resetDiscoveryForTests();
}
async function postEnvelopeRead(url: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch { return null; }
}
async function readSpendEnvelope(): Promise<SpendEnvelopeVerdict> {
  const [pool, spend] = await Promise.all([discoverOwnResolveUrls("poolImpulse"), discoverOwnResolveUrls("llmSpendSummaryNode")]);
  if (!pool.ok) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, ...(pool.lookup_failed ? { lookup_failed: true } : {}), reason: "envelope unreadable: " + pool.why };
    console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` }));
    return v;
  }
  if (pool.producers.length === 0) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, reason: "envelope unreadable: no " + (pool.foreign > 0 ? "own-substrate " : "") + "poolImpulse producer discovered" + foreignNote(pool.foreign) };
    console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` }));
    return v;
  }
  const read = await readNewestPoolRecord("spendEnvelope", pool.producers);
  const line = (verdict: string, found?: boolean, entries?: number) => console.log(policyReadLine("spendEnvelope", { asked: pool.producers, answered: read.answered, ...(found === undefined ? {} : { found, entries }), verdict }));
  if (read.silent.length > 0) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, reason: "envelope unreadable: no answer from " + read.silent[0]!.url };
    line(`closed (${v.reason})`);
    return v;
  }
  const newest = read.newest;
  if (!newest) {
    const v: SpendEnvelopeVerdict = { allow: false, unreadable: true, absent: true, reason: `envelope absent: no spendEnvelope record among ${read.answered.length} answering own producer(s) (no cap must be explicit: {uncapped: true})` };
    line("closed (absent)", false, 0);
    return v;
  }
  const env = (newest.body ?? {}) as { usd_cap_per_hour?: unknown; paused?: unknown; uncapped?: unknown; reason?: unknown; lineage_usd_cap_per_window?: unknown; lineage_window_s?: unknown; max_node_share?: unknown };
  const entries = (["usd_cap_per_hour", "paused", "uncapped"] as const).filter((k) => env[k] !== undefined && env[k] !== null).length;
  const rec = (v: SpendEnvelopeVerdict, verdict: string): SpendEnvelopeVerdict => { line(verdict, true, entries); return v; };
  if (env.paused === true) return rec({ allow: false, paused: true, reason: "paused: " + String(env.reason ?? "no reason given") }, "closed (paused)");
  const rawCap = env.usd_cap_per_hour;
  // A cap that is present but not a finite number is a misconfiguration, not "no cap".
  if (rawCap !== undefined && rawCap !== null && !(typeof rawCap === "number" && Number.isFinite(rawCap))) return rec({ allow: false, unreadable: true, reason: "envelope unreadable: usd_cap_per_hour is not a finite number" }, "closed (cap not a finite number)");
  const cap = typeof rawCap === "number" ? rawCap : null;
  if (cap !== null && env.uncapped === true) return rec({ allow: false, unreadable: true, reason: "envelope unreadable: the record sets both usd_cap_per_hour and uncapped:true" }, "closed (contradictory record)");
  if (cap === null) {
    if (env.uncapped === true) return rec({ allow: true, reason: "spendEnvelope is explicitly uncapped (no cap)" }, "open (explicitly uncapped)");
    return rec({ allow: false, unreadable: true, reason: "envelope unreadable: the record has no finite usd_cap_per_hour and is not explicitly uncapped" }, "closed (no cap and not uncapped:true)");
  }
  // Fair-share fields (4.5): parsed only under a finite cap; present-but-invalid refuses.
  const posNum = (v: unknown): number | null | undefined => (v === undefined || v === null ? undefined : typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const lineageCap = posNum(env.lineage_usd_cap_per_window);
  const lineageWindowS = posNum(env.lineage_window_s);
  const nodeShare = posNum(env.max_node_share);
  if (lineageCap === null || lineageWindowS === null || nodeShare === null || (typeof nodeShare === "number" && nodeShare > 1)) {
    return rec({ allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: a fair-share field (lineage_usd_cap_per_window, lineage_window_s, max_node_share) is not a positive finite number (share <= 1)" }, "closed (invalid fair-share field)");
  }
  const fair = {
    ...(lineageCap !== undefined ? { lineage_usd_cap: lineageCap, lineage_window_ms: (lineageWindowS ?? 3600) * 1000 } : {}),
    ...(nodeShare !== undefined ? { max_node_share: nodeShare } : {}),
  };
  line(`cap ${cap} USD/h` + (lineageCap !== undefined ? `, lineage ${lineageCap} USD/${lineageWindowS ?? 3600}s` : "") + (nodeShare !== undefined ? `, node share ${nodeShare}` : ""), true, entries);
  if (!spend.ok) return { allow: false, unreadable: true, ...(spend.lookup_failed ? { lookup_failed: true } : {}), cap_usd: cap, reason: "envelope unreadable: " + spend.why };
  const spendUrls = spend.urls;
  if (spendUrls.length === 0) return { allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: no " + (spend.foreign > 0 ? "own-substrate " : "") + "llmSpendSummaryNode producer discovered" + foreignNote(spend.foreign) };
  // One llmSpendSummaryNode producer per node (development-vessel relays its own node's
  // llm-resolver, whose own endpoint is loopback-only), so the sum covers every node (4.0a).
  const sums = await Promise.all(spendUrls.map((u) => postEnvelopeRead(u, { impulse: { pointer: { type: "llmSpendSummaryNode" } } })));
  let spent = 0;
  let ownSpent = 0;
  for (let i = 0; i < spendUrls.length; i++) {
    const b = sums[i]?.["body"] as { window_ms?: number; current?: { window_start?: string; cost_usd?: number }; previous?: { cost_usd?: number } | null } | undefined;
    if (!b || !b.current || typeof b.current.cost_usd !== "number") return { allow: false, unreadable: true, cap_usd: cap, reason: "envelope unreadable: no spend summary from " + spendUrls[i] };
    const windowMs = Number(b.window_ms) > 0 ? Number(b.window_ms) : 3_600_000;
    const elapsed = Date.now() - Date.parse(String(b.current.window_start ?? ""));
    const prevShare = Number.isFinite(elapsed) ? Math.max(0, 1 - elapsed / windowMs) : 1;
    const nodeSpent = b.current.cost_usd + (typeof b.previous?.cost_usd === "number" ? b.previous.cost_usd * prevShare : 0);
    spent += nodeSpent;
    // This node's own relay is the LOCAL-origin producer (discovery stamps it "local").
    if (spend.producers.find((p) => p.url === spendUrls[i])?.origin === "local") ownSpent += nodeSpent;
  }
  const verdict = { cap_usd: cap, spent_usd: spent, spend_sources: spendUrls.length, ...fair, ...(nodeShare !== undefined ? { own_spent_usd: ownSpent } : {}) };
  if (spent >= cap) return { allow: false, ...verdict, reason: "exhausted: spent " + spent.toFixed(3) + " USD of " + cap + " USD/h over " + spendUrls.length + " spend source(s)" };
  if (nodeShare !== undefined && ownSpent >= nodeShare * cap) return { allow: false, ...verdict, node_share_exhausted: true, reason: "node share exhausted: this node spent " + ownSpent.toFixed(3) + " USD of its " + (nodeShare * cap).toFixed(3) + " USD/h share (" + nodeShare + " x " + cap + "); fleet total " + spent.toFixed(3) };
  return { allow: true, ...verdict, reason: "within envelope: spent " + spent.toFixed(3) + " USD of " + cap + " USD/h" };
}
export async function spendEnvelopeAllows(): Promise<SpendEnvelopeVerdict> {
  // An ABSENT record is a successful read that found nothing, not a transient failure: it is held for
  // the normal TTL (a 2 s retry would re-read and re-log every 2 s on a node that holds no record).
  if (spendEnvelopeCache && Date.now() - spendEnvelopeCache.at < (spendEnvelopeCache.v.unreadable && !spendEnvelopeCache.v.absent ? policyUnreadableRetryMs() : SPEND_ENVELOPE_TTL_MS)) return spendEnvelopeCache.v;
  let v: SpendEnvelopeVerdict;
  try { v = await readSpendEnvelope(); } catch (err) { v = { allow: false, unreadable: true, reason: "envelope unreadable: " + String(err) }; console.log(policyReadLine("spendEnvelope", { asked: [], verdict: `closed (${v.reason})` })); }
  if (v.unreadable) v = { ...v, allow: false }; // fail closed, whatever this process has seen before
  spendEnvelopeCache = { at: Date.now(), v };
  return v;
}

// AUTONOMY SCOPE (contained-self-development 1.1). Autonomous work must not land on the machinery
// that lands and verifies work (the lane core), or its first failure is the lane refusing its own
// repair. The excluded paths are a shaped impulse read at use time: the newest open poolImpulse of
// shape `autonomyScope` ({excluded_paths: string[], reason}) across every poolImpulse producer of THIS
// substrate (discoverOwnResolveUrls), so one record binds every node and no peer substrate's does. Entries are repo-relative (`repos/<vessel>/src/
// file.ts`, or a directory ending in `/`). NO SCOPE IS ONLY EVER EXPLICIT: a record {unrestricted:
// true, reason} excludes nothing. A read that succeeded and found no record on any own producer is
// ABSENT, and absent excludes everything autonomous exactly like unreadable (`absent: true` names
// which): on 10-01 node 2, holding no record of its own while node 1 was not yet own, read the scope
// as empty and readable, admitted 229 gaps and composed on an excluded path. A record whose
// excluded_paths is empty or missing without unrestricted:true, or that sets unrestricted:true AND
// lists paths, is a misconfiguration and closed too. An unreadable scope excludes everything
// autonomous (fail closed), including on a fresh process that has not read one yet.
// Directed work never consults it. Cached 30 s.
export type AutonomyScope = { excluded: string[]; readable: boolean; reason: string; absent?: boolean; lookup_failed?: boolean; requireFalsifierClasses?: string[] };
let autonomyScopeCache: { at: number; v: AutonomyScope } | null = null;
export async function autonomyScope(): Promise<AutonomyScope> {
  // ABSENT is held for the normal TTL like a readable scope (a successful read; see spendEnvelopeAllows).
  if (autonomyScopeCache && Date.now() - autonomyScopeCache.at < (autonomyScopeCache.v.readable || autonomyScopeCache.v.absent ? 30_000 : policyUnreadableRetryMs())) return autonomyScopeCache.v;
  let v: AutonomyScope;
  try {
    const pool = await discoverOwnResolveUrls("poolImpulse");
    if (!pool.ok) {
      v = { excluded: [], readable: false, ...(pool.lookup_failed ? { lookup_failed: true } : {}), reason: pool.why };
      console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (unreadable: ${v.reason})` }));
    } else if (pool.producers.length === 0) {
      v = { excluded: [], readable: false, reason: "no " + (pool.foreign > 0 ? "own-substrate " : "") + "poolImpulse producer discovered" + foreignNote(pool.foreign) };
      console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (unreadable: ${v.reason})` }));
    } else {
      const read = await readNewestPoolRecord("autonomyScope", pool.producers);
      const line = (verdict: string, found?: boolean, entries?: number) => console.log(policyReadLine("autonomyScope", { asked: pool.producers, answered: read.answered, ...(found === undefined ? {} : { found, entries }), verdict }));
      const body = (read.newest?.body ?? {}) as { excluded_paths?: unknown; unrestricted?: unknown; require_falsifier_classes?: unknown };
      const raw = body.excluded_paths;
      const excluded = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : [];
      if (read.silent.length > 0) {
        v = { excluded: [], readable: false, reason: "no answer from " + read.silent[0]!.url };
        line(`closed (unreadable: ${v.reason})`);
      } else if (!read.newest) {
        v = { excluded: [], readable: false, absent: true, reason: `autonomyScope absent: no record among ${read.answered.length} answering own producer(s) (no scope must be explicit: {unrestricted: true})` };
        line("closed (absent)", false, 0);
      } else if (body.unrestricted === true && excluded.length > 0) {
        v = { excluded: [], readable: false, reason: `autonomyScope misconfigured: unrestricted:true with ${excluded.length} excluded path(s)` };
        line("closed (contradictory record)", true, excluded.length);
      } else if (body.unrestricted !== true && excluded.length === 0) {
        v = { excluded: [], readable: false, reason: "autonomyScope misconfigured: the record names no excluded_paths and is not explicitly unrestricted" };
        line("closed (no excluded_paths and not unrestricted:true)", true, 0);
      } else {
        // require_falsifier_classes: autonomous admission takes only gaps a pre-existing,
        // machine-checkable falsifier can verify (a post-landing removed-line predicate is true by
        // construction, so a landing without one cannot be credited as an improvement).
        const reqRaw = body.require_falsifier_classes;
        const requireFalsifierClasses = Array.isArray(reqRaw) ? reqRaw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().toLowerCase()) : undefined;
        v = { excluded, readable: true, reason: body.unrestricted === true ? "autonomyScope: explicitly unrestricted" : `autonomyScope: ${excluded.length} excluded path(s)`, ...(requireFalsifierClasses ? { requireFalsifierClasses } : {}) };
        line(body.unrestricted === true ? "open (explicitly unrestricted)" : `contained (${excluded.length} excluded path(s))`, true, excluded.length);
      }
    }
  } catch (err) {
    v = { excluded: [], readable: false, reason: "autonomyScope unreadable: " + String(err) };
    console.log(policyReadLine("autonomyScope", { asked: [], verdict: `closed (${v.reason})` }));
  }
  autonomyScopeCache = { at: Date.now(), v };
  return v;
}
/** The scope entry that excludes `path` from autonomous work, or null. An unreadable scope excludes
 *  everything. Paths may be absolute, repo-relative or carry `:line`. */
export function autonomyScopeExcludes(scope: AutonomyScope, path: string): string | null {
  if (!scope.readable) return `scope ${scope.absent ? "absent" : "unreadable"} (${scope.reason})`;
  const n = String(path).replace(/:\d+.*$/, "").replace(/\\/g, "/").trim();
  for (const e of scope.excluded) {
    const s = e.replace(/^\.\//, "").replace(/^repos\//, "");
    if (s.endsWith("/")) {
      if (n.startsWith(s) || n.includes("/" + s)) return e;
    } else if (n === s || n.endsWith("/" + s)) {
      return e;
    }
  }
  return null;
}

/** The autonomy-scope floor for one autonomous compose: the scope entries its applied paths hit, and,
 *  when those hits exist only because the scope could not be read, why. That withhold still fails
 *  closed, but it is an environment condition, not a verdict on the draft. */
export function autonomyScopeFloor(scope: AutonomyScope, appliedPaths: string[]): { hits: string[]; unreadable: string | null } {
  const hits = [...new Set(appliedPaths.map((p) => autonomyScopeExcludes(scope, p)).filter((h): h is string => !!h))];
  const unreadable = hits.length > 0 && !scope.readable
    ? `autonomy scope ${scope.absent ? "absent" : "unreadable"}${scope.lookup_failed ? " (discovery lookup failed)" : ""}: ${scope.reason}`
    : null;
  return { hits, unreadable };
}

/** The compose node that owns `vessel`: the one feature_compose producer whose composeOwnership
 *  lists it. Null when discovery is unreadable or when zero or several producers claim it. */
async function findComposeOwner(vessel: string): Promise<{ vesselId: string; url: string } | null> {
  try {
    const dr = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "feature_compose" } }),
      signal: AbortSignal.timeout(5_000),
    });
    const dj = await dr.json() as { content?: { vessels?: Array<{ vesselId?: string; endpoint?: string; resolve_endpoint?: string }> } };
    const rows = dj.content?.vessels ?? [];
    const owners: Array<{ vesselId: string; url: string }> = [];
    await Promise.all(rows.map(async (r) => {
      const ep = String(r.resolve_endpoint ?? "/v2/impulses/resolve");
      const url = ep.startsWith("http") ? ep : `${String(r.endpoint ?? "").replace(/\/+$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
          body: JSON.stringify({ impulse: { pointer: { type: "composeOwnership" } } }),
          signal: AbortSignal.timeout(3_000),
        });
        const j = await res.json() as { body?: { owned_repos?: unknown } };
        const owned = j.body?.owned_repos;
        if (Array.isArray(owned) && owned.map(String).includes(vessel)) owners.push({ vesselId: String(r.vesselId ?? url), url });
      } catch { /* a producer that does not answer claims nothing */ }
    }));
    return owners.length === 1 ? owners[0]! : null;
  } catch {
    return null;
  }
}

/**
 * EVERY ADMITTED COMPOSE ATTEMPT ON THE CAUSAL LEDGER. The ledger used to get an attemptIntent only at cutover
 * (feature-compose registerAttempt), so a failed attempt had no record. A pick now writes an attemptIntent keyed
 * by its approach decision_id (route gap_to_feature, no snapshot: pre_snapshot_id null, so the landing sweep,
 * which acts only on intents with landing events, never picks these up), and the attempt's end writes an
 * attemptOutcome under the same key: landed (commit), failed (stage + class) or refused (terminal refusal, a
 * non-attempt, or no compose ran). A killed attempt cannot write its own end, so it stays intent-only.
 * Record, never block: a ledger failure is logged and the compose goes on.
 */
export function recordPickIntent(attemptId: string, gap: Record<string, unknown>): void {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    appendRecord("attemptIntent", attemptId, {
      attempt_id: attemptId, route: "gap_to_feature", repo: null, touched_files: [], gap_id: String(gap.id ?? ""), proposal_id: null,
      authoring_execution_id: null, dispatch_id: null, directed: typeof meta.directed === "boolean" ? meta.directed : null,
      node: decisionNode(), prediction: { expect_pass: [], expect_change: [] }, pre_snapshot_id: null, stage: "pick", registered_at: new Date().toISOString(),
    });
  } catch (err) { console.warn(`[gap-to-feature] attempt ledger intent for ${attemptId} not written: ${String(err).slice(0, 200)}`); }
}
export function recordAttemptEnd(attemptId: string, gap: Record<string, unknown>, result: { shape?: string; body?: unknown } | null, err?: unknown): void {
  try {
    const body = ((result?.body ?? {}) as Record<string, unknown>);
    const cb = ((body.compose && typeof body.compose === "object" ? body.compose : {}) as Record<string, unknown>);
    const landed = body.landed === true;
    const composed = Object.keys(cb).length > 0;
    const refused = isTerminalRefusalResult(cb) || (composed && isNonAttemptComposeResult(cb));
    const outcome = err !== undefined ? "failed" : landed ? "landed" : refused || !composed ? "refused" : "failed";
    const cls = err !== undefined ? "exception" : String(cb.failure_kind ?? cb.error ?? body.error ?? (composed ? cb.verdict : body.verdict ?? body.route) ?? "") || null;
    appendRecord("attemptOutcome", attemptId, {
      attempt_id: attemptId, route: "gap_to_feature", gap_id: String(gap.id ?? body.gap_id ?? ""), node: decisionNode(), at: new Date().toISOString(),
      outcome, landed, stage: String(cb.stage ?? body.stage ?? (err !== undefined ? "exception" : "")) || null, class: landed ? null : (cls ? cls.slice(0, 200) : null),
      verdict: cb.verdict ?? body.verdict ?? null, commit: typeof body.landed_commit === "string" ? body.landed_commit : null,
      ...(err !== undefined ? { error: String(err).slice(0, 300) } : {}),
    });
  } catch (e) { console.warn(`[gap-to-feature] attempt ledger outcome for ${attemptId} not written: ${String(e).slice(0, 200)}`); }
}

/** A goal-host 503 whose JSON body says it is draining or quiesced ({retryable:true}, {draining:true}, or an
 *  error naming either): the dispatch was refused before it ran, so it is not a failed attempt. Anything else
 *  (another status, a 503 that does not say so, an unparseable body) is a real failure. */
export function isRetryableDispatchRefusal(status: number, text: string): boolean {
  if (status !== 503) return false;
  try {
    const b = JSON.parse(text) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return false;
    return b.retryable === true || b.draining === true || b.quiesced === true || /\b(quiesc|drain)/i.test(String(b.error ?? ""));
  } catch { return false; }
}

export async function resolveGapToFeature(pointer: GapToFeaturePointer): Promise<ResolverResult> {
  const attempt: { id?: string; gap?: Record<string, unknown> } = {};
  let result: ResolverResult;
  try {
    result = await resolveGapToFeatureOnce(pointer, attempt);
  } catch (err) {
    if (attempt.id && attempt.gap) recordAttemptEnd(attempt.id, attempt.gap, null, err);
    throw err;
  }
  if (attempt.id && attempt.gap) recordAttemptEnd(attempt.id, attempt.gap, result as { shape?: string; body?: unknown });
  return result;
}

async function resolveGapToFeatureOnce(pointer: GapToFeaturePointer, attempt: { id?: string; gap?: Record<string, unknown> }): Promise<ResolverResult> {
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
  // 0. Land→close continuity: complete deferred self-cutover closures BEFORE selection,
  // so an already-landed gap cannot be re-picked and re-landed. Cheap, bounded, best-effort.
  try {
    const heads = cloneHeadsFingerprint();
    if (heads === null || heads !== lastSweepHeads) {
      sweepAwaitingRestart = false;
      await sweepPendingLandVerifications();
      // A landing awaiting its vessel's restart is re-examined after the restart, which moves no
      // clone HEAD — so leave the fingerprint unset and sweep again next tick.
      lastSweepHeads = sweepAwaitingRestart ? null : heads;
    }
  } catch { /* never block the tick */ }
  // Causal attempt ledger: outcomes and settlements for registered landings. Started without
  // awaiting (snapshots can take tens of seconds) and guarded so sweeps never overlap.
  if (!attemptSweepInFlight) {
    attemptSweepInFlight = true;
    void sweepAttempts()
      .then((r) => { if (r.outcomes_written || r.settlements_written || r.errors.length) console.log(`[attempt-sweep] outcomes=${r.outcomes_written} settlements=${r.settlements_written} lessons=${r.lessons_written} errors=${r.errors.length}${r.errors.length ? " first=" + r.errors[0] : ""}`); })
      .catch((e) => console.error(`[attempt-sweep] failed: ${(e as Error).message}`))
      .finally(() => { attemptSweepInFlight = false; });
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
    const eligible = gaps.filter((g) => {
      const holder = predicateHolds.get(String(g.id ?? ""));
      if (holder) { heldLines.push(`${String(g.id)}: predicate held by ${holder}`); return false; }
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
      const decs = Array.isArray(mR.approach_decisions) ? mR.approach_decisions as Array<Record<string, unknown>> : [];
      const last = decs.length ? decs[decs.length - 1] : undefined;
      const lastOutcome = last ? last.outcome as Record<string, unknown> | undefined : undefined;
      const highConfMiss = !!(last && Number(last.predicted_p ?? 0) >= 0.7 && lastOutcome && lastOutcome.landed === false);
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
  if (String(gap.category ?? "") === "missing_capability") {
    const mcMeta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const mcEditSite = typeof mcMeta["edit_site"] === "string" ? mcMeta["edit_site"] as string : undefined;
    const mcSummary = typeof gap.summary === "string" ? gap.summary as string : "";
    const _quotedMatch = mcSummary.match(/"([^"]+)"/);
    const _metaShape = typeof (gap as Record<string, unknown>).classification_metadata === "object" && (gap as Record<string, unknown>).classification_metadata !== null
      ? ((gap as Record<string, unknown>).classification_metadata as Record<string, unknown>).shape as string | undefined
      : undefined;
    const candidateShape: string = (_quotedMatch?.[1]) ?? (_metaShape ?? "") ?? (mcSummary.match(/[a-z][a-z0-9_:-]{2,}/)?.[0] ?? "");
    const mcCandidateShape = candidateShape || undefined;
    let mcAlreadyResolved = false;
    if (mcCandidateShape) {
      try {
        const mcDiscoveryEndpoint = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
        const mcProbeRes = await fetch(
          `${mcDiscoveryEndpoint}/vessels?shape=${encodeURIComponent(mcCandidateShape)}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (mcProbeRes.ok) {
          const mcProbeBody = (await mcProbeRes.json()) as { vessels?: unknown[] };
          if (Array.isArray(mcProbeBody.vessels) && mcProbeBody.vessels.length > 0) {
            if (mcEditSite) {
              try {
                statSync(mcEditSite);
                mcAlreadyResolved = true;
              } catch {
                // File absent — capability registered but file not present; let composer run
              }
            } else {
              mcAlreadyResolved = true;
            }
          }
        }
      } catch {
        // Discovery unreachable or timeout — proceed with normal compose
      }
    }
    if (mcAlreadyResolved) {
      const mcClosureNote = `already_resolved: live producer found for shape '${mcCandidateShape ?? mcSummary}'${
        mcEditSite ? ` and edit_site '${mcEditSite}' exists in container tree` : ""
      }; gap closed without recompose to prevent duplicate-identifier patches`;
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: { ...mcMeta, resolution: "already_resolved", closed_reason: "already_resolved", closed_by: "gap_to_feature.live_producer_probe", closed_at: new Date().toISOString() },
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
      return {
        shape: "gapToFeatureReport",
        body: {
          ok: true,
          gap_id: gap.id,
          gap_category: gap.category,
          verdict: "already_resolved",
          note: mcClosureNote,
        },
      };
    }
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
      } else if (isRetryableDispatchRefusal(res.status, text)) {
        // goal-host is draining or quiesced: the dispatch never ran, so it is not an attempt. No bump; the
        // gap stays as it is for the next tick.
        console.log(`[gap-to-feature] trace-store-reconcile for ${String(gap.id ?? "?")}: goal-host refused retryably (${res.status} ${text.slice(0, 160)}); not a failed attempt, left for the next tick`);
      } else {
        await bumpFailedAttempts(gap);
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
      await bumpFailedAttempts(gap);
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
    if (!pointer.dry_run && rb["verdict"] !== "FAVORABLE") await bumpFailedAttempts(gap);
    if (!pointer.dry_run && rb["verdict"] === "FAVORABLE") {
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), closed_reason: "producer_now_exists", closed_by: "reachability_gap_repair" },
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
    }
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
    if (!pointer.dry_run && !minted) await bumpFailedAttempts(gap);
    // CLOSE-ON-MINT (2026-07-01): a minted bridge IS the closure — the resolver is now
    // invoked by a Thompson-selectable activity, so it is no longer orphaned. Without
    // closing, the open-filtered picker re-selects the SAME top orphaned gap every run
    // and re-mints it idempotently, never advancing to the other orphaned resolvers
    // (observed: repairPolicy re-picked + re-MINTED though auto-bridge-repairPolicy
    // already existed). Mirrors closeLandedGap on the feature_compose path (~L1071).
    if (!pointer.dry_run && minted) {
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: String(gap.id ?? ""),
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), closed_reason: "producer_now_exists", closed_by: "author_producer" },
            status: "closed",
          },
        } as never);
      } catch { /* best-effort */ }
    }
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
        const cgResult = await routeCapabilityGapToNewResolver(gap, missingShape, cgMeta, pointer);
        // Same liveness fix: this route's failure returns (ok:false) never bumped
        // failed_attempts either, so a capability_gap the author can't satisfy would
        // be re-selected forever. Bump on failure so the loop moves on. (2026-07-01)
        if (!pointer.dry_run && (cgResult?.body as { ok?: boolean } | undefined)?.ok === false) {
          await bumpFailedAttempts(gap);
        }
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
    const sliceLand: LandSignal = allOk && lastBody ? genuineLandSignal(lastBody, !(pointer.dry_run ?? false)) : { landed: false, commit_sha: null, vessel: null, push_status: null };
    if (allOk && lastBody) {
      if (sliceLand.landed) await closeLandedGap(gap, sliceLand);
      const reachVerdict = sliceLand.landed ? 'SUCCESS' : 'UNFAVORABLE';
      console.log(`[gap-to-feature] reach verdict: ${reachVerdict}`);
    }
    // A slice sequence cut short by a capacity refusal never got its attempt either.
    if (!allOk && !pointer.dry_run && isTerminalRefusalResult(lastBody)) await markTerminalRefusal(gap, lastBody);
    else if (!allOk && !pointer.dry_run && !isNonAttemptComposeResult(lastBody)) {
      if (!isInfraRefusalBody(lastBody)) updateClassPosterior(gapClassOf(gap), false);
      await bumpFailedAttempts(gap);
    }
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
  const land = genuineLandSignal(cb, !(pointer.dry_run ?? false));
  let closure: { closed: boolean; error?: string; resolution?: string } = { closed: false };
  if (land.landed) {
    closure = await closeLandedGap(gap, land);
    if (closure.closed) {
      closure.resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    }
  } else if (!(pointer.dry_run ?? false)) {
    // Did not land. EXPECTATION-SETTING: measure the prediction-vs-outcome SURPRISE. A gap the
    // self-model predicted would land but (test missing in test suite) didn't is over-optimistic (high-information) → bump
    // harder; a correctly-predicted fail bumps normally. Feeds the calibrated self-model.
    if (isNonAttemptComposeResult(cb)) {
      delete gap.cooldown_until;
      gapComposeLastAttemptAt.delete(String(gap.id)); // A compose that never ran must not cost its gap a cooldown
      console.log("[gap-to-feature] non-attempt (failure_kind=" + String(cb.failure_kind ?? "-") + ", verdict=" + String(cb.verdict ?? "-") + ", stage=" + String(cb.stage ?? "-") + ") for gap " + String(gap.id) + " — clearing cooldown");
      // A compose that never ran must not cost the gap its cooldown.
      gapComposeLastAttemptAt.delete(String(gap.id));
    } else if (isTerminalRefusalResult(cb)) {
      await markTerminalRefusal(gap, cb);
    } else {
      const pred = predictLand(gap);
      // Bounded one-shot patch_with_tools escalation on an APPLY failure (anchor_not_found /
      // localization miss — ~40% of autonomous compose failures). feature_compose already rolled
      // back on applyFailed (nothing to double-land); pwt reads-then-edits the target agentically
      // where blind-draft could not match old_string. One-shot PER GAP LINEAGE via pwt_escalated
      // (no cross-tick loop); fires ONLY on apply_failed (never on semantic/verify rejects); any
      // error or non-land falls through to bumpFailedAttempts unchanged. NB classification_metadata
      // is an OBJECT — the coaxed draft (daf6d36) used .includes/.push on it (runtime crash) + a
      // bogus threading string; corrected here to property access + the real resolver signature.
      const _gm = ((gap as { classification_metadata?: Record<string, unknown> }).classification_metadata ??= {});
      let _pwtLanded = false;
      if (cb.apply_failed && !_gm.pwt_escalated) {
        _gm.pwt_escalated = true; // one-shot BEFORE the attempt: a crash/retry can never re-escalate
        try {
          const { resolvePatchWithTools } = await import('./patch-with-tools.js');
          const result = await resolvePatchWithTools({
            type: "patch_with_tools",
            proposal_text: spec + `\n\nPRIOR FEATURE-COMPOSE APPLY FAILURE ON THIS FILE (do not repeat it): op_count=${cb.op_count}, apply_failed, rolled_back=${cb.rolled_back}`,
            // `gap.file_path` is ALWAYS undefined — measured 0 of 360 live gaps carry a
            // top-level file_path, while 104 carry classification_metadata.edit_site. So
            // this handed patch_with_tools `undefined`, deriveVesselFromPath threw
            // "undefined is not an object (evaluating 'filePath.match')", and the
            // escalation had never once run. Worse, pwt_escalated is set one-shot ABOVE
            // this line, so every gap that reached here was permanently marked escalated
            // by a crash. Same field order identifyVessel() already uses.
            target_file: gapEditSite(gap, _gm),
            gap_id: gap.id,
            proposal_id: gap.id,
            // Explicit, not the resolver's silent `?? "/vessels"` default: the value
            // becomes visible in the trace, which is the point of threading it.
            vessels_root: process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
          } as never);
          const rb = (((result as unknown as Record<string, unknown>)?.body ?? result ?? {}) as Record<string, unknown>);
          const _land = (rb.landing ?? {}) as Record<string, unknown>;
          const _sha = (rb.new_git_sha ?? rb.commit_sha ?? _land.new_git_sha) as string | undefined;
          const _pushed = rb.push_status === "pushed" || _land.push_status === "pushed" || _land.landed === true;
          if (rb.mitosisStaged && _pushed && _sha) {
            await closeLandedGap(gap, { landed: true, commit_sha: String(_sha), vessel: "development-vessel", push_status: "pushed" });
            _pwtLanded = true;
          }
        } catch (e) {
          console.warn("[gap-to-feature] pwt escalation error: " + (e as Error).message);
        }
      }
      if (!_pwtLanded) {
        if (!isInfraRefusalBody(cb)) updateClassPosterior(gapClassOf(gap), false);
        await bumpFailedAttempts(gap, { surprise: pred.predicted, predictedP: pred.p });
      }
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
