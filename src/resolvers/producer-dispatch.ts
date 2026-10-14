// THE PRODUCER DISPATCHER (package A, user ruling 2026-10-13: "one more operator route, then freeze"; "full package").
//
// A goal that keeps failing because no producer makes the shape it needs has no way to a fix: the walk files a
// capability gap only when a SECOND distinct goal needs the shape (goal-host fileCapabilityGap: one goal is born closed),
// and nothing ever sent an open capability gap into the existing author route (gap-to-feature step 1c,
// routeCapabilityGapToNewResolver → capability_gap_via_feature_compose). This is that sender, and only that:
// admission, the judges and the author route are untouched.
//
// INTAKE (goal-linked, open):
//   - capability_gap rows naming a missing_shape (demand recorded on the row);
//   - goal-deficiency rows whose runs' inferred target shapes are NOT produced: the targets come from the record, never
//     prose. First the tally's structured missing_shapes (missing_producer/phantom entries), else the JSON payload of the
//     run's walkLog "goal-target inference" line (a log line, not a structured trace field: case C-targets-not-a-field).
//     A target the run's steps produced is wrong-content, not a missing producer: skipped, loudly.
// For each candidate shape: an identifier (else skipped, loudly); never a write/action shape; REUSE FIRST: advertised
// in discovery → skipped (reuse; the author route's own already-resolved check is the second line); unreadable
// discovery → skipped (unknown is not absent). Otherwise the capability row gap-<slug> (the id the walk's filer uses,
// even when it was born closed) is opened or reused, linked to the goal's demand, with its planned CREATE target as edit_site.
// It is ARMED (evidence_resolve {shape, mode:"producer_contract", required_keys}, package B) and sent to gap_to_feature by id
// ONLY when the shape has a DECLARED contract (required keys already on the row). A keyless check closes on any substantive
// body, so without declared keys the row records the demand and "not armed", and nothing is sent (exception (a), 10-13). Shaped: mode off|dry_run|live, a per-tick budget, a per-gap cooldown. Every skip is a reason.

// CONTAINED IS NOT MISSING (exception (a), 10-13): discovery answers only for producers that are UP. A vessel masked for
// harm containment, disabled, crashed or not yet booted advertises nothing, and its shape read as "no producer exists"
// (the dispatcher sent a contained capability to the author route). A shape some vessel in the running tree DECLARES is
// never authored: the second, independent reader below; unreadable declarations refuse too (unknown is not absent).

import { readdirSync, readFileSync } from "node:fs";
import { goalReachCheck, goalReachFalsifierSpec, GOAL_REACH_VERDICT_SHAPE } from "./goal-deficiency.js";
import { join } from "node:path";

export type ProducerDispatchMode = "off" | "dry_run" | "live";
export interface ProducerPlan { shape: string; goal: string; goal_hash: string; source_gap: string; via: "capability_gap" | "deficiency"; dispatch_id?: string }
export interface ProducerSkip { source_gap: string; shape?: string; why: string }

const SHAPE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
export const isShapeIdentifier = (s: unknown): s is string => typeof s === "string" && SHAPE_ID.test(s);

/** The capability row id the walk's filer uses for `shape` (goal-host fileCapabilityGap: gap-<kebab slug>). */
export const capabilityGapId = (shape: string): string => `gap-${shape.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}`;
/** The file the author route creates for `shape` (gap-to-feature shapeToResolverName, kebab-cased). */
export const plannedResolverFile = (shape: string, vessel = "development-vessel"): string => {
  const snake = shape.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `repos/${vessel}/src/resolvers/${snake.replace(/_/g, "-")}.ts`;
};

/** The inferred target shapes a run's walkLog records (the JSON payload of its "goal-target inference" line), or null. */
export function inferredTargets(walkLog: unknown): string[] | null {
  const lines = Array.isArray(walkLog) ? walkLog.map(String) : typeof walkLog === "string" ? walkLog.split("\n") : [];
  for (const l of lines) {
    const i = l.indexOf("goal-target inference ");
    if (i < 0) continue;
    const json = l.slice(i + "goal-target inference ".length).trim();
    try {
      const j = JSON.parse(json) as { inferred_target_shapes?: unknown };
      if (Array.isArray(j.inferred_target_shapes)) return j.inferred_target_shapes.filter((x): x is string => typeof x === "string");
    } catch { /* not the JSON payload: keep looking */ }
  }
  return null;
}
/** The shapes a run's steps produced: its completionShapes plus every `produced "<shape>"` its walkLog records. */
export function producedShapes(walkLog: unknown, completionShapes: unknown): Set<string> {
  const out = new Set<string>(Array.isArray(completionShapes) ? completionShapes.filter((x): x is string => typeof x === "string") : []);
  const lines = Array.isArray(walkLog) ? walkLog.map(String) : typeof walkLog === "string" ? walkLog.split("\n") : [];
  for (const l of lines) for (const m of l.matchAll(/\bproduced "([^"]+)"/g)) out.add(m[1]!);
  return out;
}

/** The files where a vessel declares the shapes it serves (its discovery contract, its resolver map). */
const DECLARATION_FILES = ["src/config.ts", "src/index.ts"];
export interface DeclarationIo { list: (dir: string) => string[]; read: (file: string) => string }
const fsIo: DeclarationIo = { list: (d) => readdirSync(d), read: (f) => readFileSync(f, "utf8") };
/**
 * The vessels under `root` whose declaration files name `shape` as a quoted literal: a producer exists in code whether or
 * not discovery advertises it. A missing file declares nothing; null = the root is unlistable or a declaration file
 * exists but cannot be read (the tree is unknown, not empty). Over-matching
 * (a vessel that only names the shape) refuses an author request; it can never send one.
 */
export function declaredBy(shape: string, root: string, io: DeclarationIo = fsIo): string[] | null {
  if (!isShapeIdentifier(shape)) return [];
  let dirs: string[];
  try { dirs = io.list(root); } catch { return null; }
  const lit = new RegExp(`["'\`]${shape}["'\`]`);
  const out: string[] = [];
  for (const d of dirs) for (const f of DECLARATION_FILES) {
    let text: string;
    try { text = io.read(join(root, d, f)); } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // not a declaration file of a vessel: nothing declared there
      return null; // a declaration that exists but cannot be read is unknown, not absent
    }
    if (lit.test(text)) { out.push(d); break; }
  }
  return out;
}

/** Why authoring `shape` must be refused because a producer exists in the running tree (or the tree is unreadable), or null. */
export function containedRefusal(shape: string, root: string, io: DeclarationIo = fsIo): string | null {
  const declared = declaredBy(shape, root, io);
  if (declared === null) return "declarations unreadable: not authored (unknown is not absent)";
  return declared.length > 0 ? `declared by ${declared.join(", ")} but not advertised: an offline or contained producer, never authored` : null;
}
/** A discovery lookup as the dispatcher reads it: true = served, false = none, null = unreadable (any failure, e.g. HTTP 401). */
export function advertisedFrom(r: { ok: boolean; producers?: unknown }): boolean | null {
  return r.ok === true && Array.isArray(r.producers) ? r.producers.length > 0 : null;
}

export interface RunRecord { walkLog?: unknown; completionShapes?: unknown }
export interface Deps {
  isWrite: (shape: string) => boolean;
  /** Discovery: true = some producer serves it, false = none, null = unreadable. */
  advertised: (shape: string) => Promise<boolean | null>;
  /** A run's record on this node's goal-host (walkLog, completionShapes), or null. */
  readRun: (dispatchId: string) => Promise<RunRecord | null>;
  /** Vessels in the running tree declaring the shape (declaredBy), or null = unreadable. */
  declaredBy: (shape: string) => Promise<string[] | null>;
}
const metaOf = (g: Record<string, unknown>) => (g["classification_metadata"] ?? {}) as Record<string, unknown>;
const demandHashes = (m: Record<string, unknown>): string[] => (Array.isArray(m["demand_goals"]) ? (m["demand_goals"] as unknown[]) : [])
  .map((d) => (d && typeof d === "object" ? String((d as Record<string, unknown>)["goal_hash"] ?? "") : "")).filter((h) => /^[0-9a-f]{8}$/.test(h));

/**
 * The candidates this tick (pure but for deps): each open goal-linked row → at most one shape to author, or a skip with
 * a reason. `missingShapesOf(goalHash)` is the tally's structured missing_shapes for the goal (first source).
 */
export async function planProducerDemand(
  rows: ReadonlyArray<Record<string, unknown>>, now: number, cooldownMs: number,
  missingShapesOf: (goalHash: string) => string[], deps: Deps,
  /** The goal's text (the R2 tally holds it; deficiency rows do not), else the run record's. */
  goalTextOf: (goalHash: string) => string = () => "",
): Promise<{ plans: ProducerPlan[]; skips: ProducerSkip[] }> {
  const plans: ProducerPlan[] = [], skips: ProducerSkip[] = [];
  const seenShapes = new Set<string>();
  const cooled = (m: Record<string, unknown>): boolean => {
    const at = Date.parse(String(((m["producer_dispatch"] ?? {}) as Record<string, unknown>)["at"] ?? ""));
    return Number.isFinite(at) && now - at < cooldownMs;
  };
  const judge = async (src: string, shape: string, goal: string, goalHash: string, via: ProducerPlan["via"], produced: Set<string> | null, dispatchId?: string): Promise<boolean> => {
    if (!isShapeIdentifier(shape)) { skips.push({ source_gap: src, shape, why: "target is not a shape identifier" }); return false; }
    if (deps.isWrite(shape)) { skips.push({ source_gap: src, shape, why: "write/action shape: never authored as a producer" }); return false; }
    if (produced?.has(shape)) { skips.push({ source_gap: src, shape, why: "target produced; not a missing-producer deficiency" }); return false; }
    if (seenShapes.has(shape)) { skips.push({ source_gap: src, shape, why: "shape already planned this tick" }); return false; }
    const adv = await deps.advertised(shape).catch(() => null);
    if (adv === null) { skips.push({ source_gap: src, shape, why: "discovery unreadable: not dispatched (unknown is not absent)" }); return false; }
    if (adv) { skips.push({ source_gap: src, shape, why: "already advertised: reuse the producer (producer_now_exists), no author request" }); return false; }
    const decl = await deps.declaredBy(shape).catch(() => null);
    if (decl === null) { skips.push({ source_gap: src, shape, why: "declarations unreadable: not dispatched (unknown is not absent)" }); return false; }
    if (decl.length > 0) { skips.push({ source_gap: src, shape, why: `declared by ${decl.join(", ")} but not advertised: an offline or contained producer, never authored` }); return false; }
    if (!goal.trim()) { skips.push({ source_gap: src, shape, why: "no goal text: the author route needs the demanding goal" }); return false; }
    seenShapes.add(shape);
    plans.push({ shape, goal, goal_hash: goalHash, source_gap: src, via, ...(dispatchId ? { dispatch_id: dispatchId } : {}) });
    return true;
  };
  for (const g of rows) {
    if (String(g["status"] ?? "") !== "open") continue;
    const id = String(g["id"] ?? ""), m = metaOf(g);
    if (m["kind"] === "capability_gap") {
      const hashes = demandHashes(m);
      if (hashes.length === 0) continue; // not goal-linked
      if (cooled(m)) { skips.push({ source_gap: id, why: "author request already sent within the cooldown" }); continue; }
      const shape = String(m["missing_shape"] ?? "");
      await judge(id, shape, String(m["goal"] ?? ""), hashes[0]!, "capability_gap", null);
      continue;
    }
    if (m["kind"] !== "goal_content_deficiency") continue;
    const goalHash = String(m["goal_hash"] ?? "");
    const ids = (Array.isArray(m["dispatch_ids"]) ? (m["dispatch_ids"] as unknown[]) : []).map(String);
    if (!goalHash || ids.length === 0) continue;
    const goal = String(m["goal"] ?? "") || goalTextOf(goalHash);
    // 1) the tally's structured missing_shapes; 2) the newest run's walkLog inference (its produced shapes rule it out)
    const structured = missingShapesOf(goalHash).filter(Boolean);
    let targets: string[] = structured, produced: Set<string> | null = null, from = "tally";
    let goalText = goal;
    if (targets.length === 0) {
      const newest = ids[ids.length - 1]!;
      const rec = await deps.readRun(newest).catch(() => null);
      if (!rec) { skips.push({ source_gap: id, why: `the newest run's record (${newest.slice(0, 8)}) is unreadable here` }); continue; }
      const t = inferredTargets(rec.walkLog);
      if (t === null) { skips.push({ source_gap: id, why: "the run record names no inferred targets (no goal-target inference line)" }); continue; }
      targets = t; produced = producedShapes(rec.walkLog, rec.completionShapes); from = "walkLog";
      if (!goalText) goalText = String((rec as Record<string, unknown>)["goal"] ?? "");
    }
    let planned = false;
    for (const s of targets) if (await judge(id, s, goalText, goalHash, "deficiency", produced, ids[ids.length - 1])) { planned = true; break; }
    if (!planned && targets.length === 0) skips.push({ source_gap: id, why: `no target shapes (${from})` });
  }
  return { plans, skips };
}

/** The shape's DECLARED contract keys: the required_keys a producer_contract check already on the row names for this shape
 *  (put there by whoever declared the contract), else none. Nothing here invents keys from the shape's name or the goal's prose. */
export function declaredContractKeys(existing: Record<string, unknown> | null, shape: string): string[] {
  const er = (existing ? metaOf(existing) : {})["evidence_resolve"] as Record<string, unknown> | undefined;
  if (!er || er["mode"] !== "producer_contract" || er["shape"] !== shape || !Array.isArray(er["required_keys"])) return [];
  return [...new Set((er["required_keys"] as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0))];
}
const keysOf = (gap: { classification_metadata: Record<string, unknown> }): string => JSON.stringify(((gap.classification_metadata["evidence_resolve"] ?? {}) as Record<string, unknown>)["required_keys"] ?? []);
export const NOT_ARMED_NO_GOAL = "no declared contract and no demanding goal to judge it by: not armed";
export const NOT_ARMED_NO_CONTRACT = "no declared contract: not armed (a producer_contract check without required keys closes on any substantive body, so a hollow producer would close it)";

/** The capability row write that opens/reuses gap-<slug> and links the goal's demand. It ARMS the producer_contract check only
 *  from a DECLARED contract (declaredContractKeys); with none it arms nothing and says so (armed:false), and an evidence_resolve
 *  already on the row, of any kind, is left exactly as it is. */
export function capabilityRowWrite(plan: ProducerPlan, existing: Record<string, unknown> | null, nowIso: string, mode: ProducerDispatchMode) {
  const id = capabilityGapId(plan.shape);
  const m = existing ? metaOf(existing) : {};
  const tag = `producer_author:${plan.goal_hash}:${plan.shape}`;
  const keys = declaredContractKeys(existing, plan.shape);
  // WHAT JUDGES THE AUTHORED PRODUCER (exception (a), 10-13): a DECLARED contract first (its required keys); else the DEMANDING
  // GOAL's own reach (goalReachCheck: the class-2 check R2 arms deficiency rows with, since-aware in the judge), so only a later
  // reached run of the goal closes it, never a landing alone or a hollow body. An evidence_resolve already on the row is left as it
  // is: it counts as armed only when it is that goal-reach check. No goal hash and no contract: nothing arms it.
  const existingEr = m["evidence_resolve"] as Record<string, unknown> | undefined;
  const goalOk = /^[0-9a-f]{8}$/.test(plan.goal_hash);
  const basis: "declared_contract" | "goal_reach" | null = keys.length > 0 ? "declared_contract"
    : existingEr ? (existingEr["shape"] === GOAL_REACH_VERDICT_SHAPE ? "goal_reach" : null)
    : goalOk ? "goal_reach" : null;
  const armed = basis !== null;
  const gap = {
    id,
    category: String(existing?.["category"] ?? "missing_capability"),
    source: String(existing?.["source"] ?? "goal_reach_producer_dispatch"),
    status: "open",
    detected_at: String(existing?.["detected_at"] ?? nowIso),
    summary: String(existing?.["summary"] ?? `Capability gap: a goal needs a producer for shape "${plan.shape}" and no advertised producer serves it. AUTHOR a resolver that produces ONLY "${plan.shape}".`),
    classification_metadata: {
      ...m,
      kind: "capability_gap", missing_shape: plan.shape, allowed_output_shapes: [plan.shape], goal: String(m["goal"] ?? plan.goal) || plan.goal,
      ...(basis === "declared_contract" ? { evidence_resolve: { shape: plan.shape, mode: "producer_contract", required_keys: keys } }
        : basis === "goal_reach" && !existingEr ? { evidence_resolve: goalReachCheck(plan.goal_hash), falsifier_spec: goalReachFalsifierSpec(plan.goal_hash) } : {}),
      edit_site: plannedResolverFile(plan.shape, typeof m["target_vessel"] === "string" && m["target_vessel"] ? String(m["target_vessel"]) : "development-vessel"),
      producer_dispatch: { at: nowIso, shape: plan.shape, mode, via: plan.via, source_gap: plan.source_gap, tag, armed, ...(basis === "declared_contract" ? { arm_basis: basis, required_keys: keys } : basis === "goal_reach" ? { arm_basis: basis } : { not_armed: existingEr ? NOT_ARMED_NO_CONTRACT : NOT_ARMED_NO_GOAL }) },
      ...(plan.via === "deficiency" ? { parent_gap: plan.source_gap } : {}),
    },
  };
  const demand = { source: "goal_reach" as const, goal_hash: plan.goal_hash, dispatch_id: plan.dispatch_id ?? "", origin: "autonomous" as const };
  return { gap, demand, tag, armed };
}

export interface DispatchDeps extends Deps {
  /** substrateGap_write with demand_goals_append; returns whether it was written. */
  write: (gap: Record<string, unknown>, demand: Record<string, unknown>) => Promise<{ ok: boolean; why?: string }>;
  /** Send gap_to_feature for this gap id (fire-and-forget is the caller's choice); returns whether it was sent. */
  dispatch: (gapId: string, tag: string) => Promise<{ ok: boolean; why?: string }>;
}
export interface ProducerDispatchReport { mode: ProducerDispatchMode; planned: ProducerPlan[]; sent: Array<{ gap_id: string; shape: string; source_gap: string; tag: string }>; refused: Array<{ gap_id: string; why: string }>; skips: ProducerSkip[] }

/**
 * One tick of the dispatcher over the whole gap store. `missingShapesOf(goalHash)` reads the tally. Mode "dry_run" plans
 * and logs only; "live" opens/arms the capability row (with the goal's demand) and sends it to gap_to_feature, at most
 * `budget` per tick. Every skip and refusal is reported and logged.
 */
export async function runProducerDispatch(
  rows: ReadonlyArray<Record<string, unknown>>, now: number,
  policy: { producer_dispatch: ProducerDispatchMode; max_producer_dispatches: number; producer_dispatch_cooldown_ms: number },
  missingShapesOf: (goalHash: string) => string[], deps: DispatchDeps,
  goalTextOf: (goalHash: string) => string = () => "",
): Promise<ProducerDispatchReport> {
  const mode = policy.producer_dispatch;
  const report: ProducerDispatchReport = { mode, planned: [], sent: [], refused: [], skips: [] };
  if (mode === "off" || policy.max_producer_dispatches <= 0) return report;
  const { plans, skips } = await planProducerDemand(rows, now, policy.producer_dispatch_cooldown_ms, missingShapesOf, deps, goalTextOf);
  report.skips = skips;
  for (const s of skips) console.log(`[producer-dispatch] skip ${s.source_gap}${s.shape ? ` (${s.shape})` : ""}: ${s.why}`);
  const nowIso = new Date(now).toISOString();
  const byId = new Map(rows.map((g) => [String(g["id"] ?? ""), g]));
  for (const plan of plans.slice(0, policy.max_producer_dispatches)) {
    report.planned.push(plan);
    const id = capabilityGapId(plan.shape);
    const existing = byId.get(id) ?? null;
    // the capability row's own cooldown, when the plan came from a deficiency row
    const last = Date.parse(String(((((existing?.["classification_metadata"] ?? {}) as Record<string, unknown>)["producer_dispatch"] ?? {}) as Record<string, unknown>)["at"] ?? ""));
    if (Number.isFinite(last) && now - last < policy.producer_dispatch_cooldown_ms) { report.refused.push({ gap_id: id, why: "author request already sent within the cooldown" }); continue; }
    const { gap, demand, tag, armed } = capabilityRowWrite(plan, existing, nowIso, mode);
    if (mode === "dry_run") { console.log(armed ? `[producer-dispatch] DRY-RUN would arm ${id} (${plan.shape}, ${String(((gap.classification_metadata["producer_dispatch"] ?? {}) as Record<string, unknown>)["arm_basis"]) === "declared_contract" ? `declared keys ${keysOf(gap)}` : "on the demanding goal's reach"}) and send it to the author route; goal ${plan.goal_hash} via ${plan.source_gap}` : `[producer-dispatch] DRY-RUN ${id} (${plan.shape}): ${NOT_ARMED_NO_CONTRACT}; would record the demand only`); continue; }
    const w = await deps.write(gap, demand).catch((e: unknown) => ({ ok: false, why: String(e) }));
    if (!w.ok) { report.refused.push({ gap_id: id, why: `write refused: ${w.why ?? "?"}` }); console.warn(`[producer-dispatch] ${id}: write refused: ${w.why ?? "?"}`); continue; }
    // UNARMED IS NOT SENT: the demand is recorded on the row (above), but an author request for a shape with no declared
    // contract would be graded by a check any substantive body satisfies. The author route never sees it.
    if (!armed) { const why = String(((gap.classification_metadata["producer_dispatch"] ?? {}) as Record<string, unknown>)["not_armed"] ?? NOT_ARMED_NO_CONTRACT); report.refused.push({ gap_id: id, why }); console.warn(`[producer-dispatch] ${id} (${plan.shape}): ${why}; demand recorded, NOT sent to the author route`); continue; }
    const d = await deps.dispatch(id, tag).catch((e: unknown) => ({ ok: false, why: String(e) }));
    if (!d.ok) { report.refused.push({ gap_id: id, why: `dispatch failed: ${d.why ?? "?"}` }); console.warn(`[producer-dispatch] ${id}: dispatch failed: ${d.why ?? "?"}`); continue; }
    report.sent.push({ gap_id: id, shape: plan.shape, source_gap: plan.source_gap, tag });
    console.log(`[producer-dispatch] SENT ${id} (missing producer ${plan.shape}) to the author route; armed (${String(((gap.classification_metadata["producer_dispatch"] ?? {}) as Record<string, unknown>)["arm_basis"] ?? "?")}); goal ${plan.goal_hash} via ${plan.source_gap}; tag ${tag}`);
  }
  return report;
}
