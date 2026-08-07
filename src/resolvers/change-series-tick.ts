/**
 * change_series_tick — advance a multi-file change ONE atomic step per rhythm tick.
 *
 * WHY A TICK AND NOT A LOOP. A synchronous orchestrator cannot exist on this vessel:
 * development-vessel severs every connection at ~63s while the handler keeps running,
 * so a multi-minute series never delivers its result — it fails on the FIRST step,
 * deterministically. Worse, each step's mitosis cutover RESTARTS the vessel running
 * the series ~5s later, and the quiesce guards do not know about it. Measured on this
 * deployment: development-vessel started 27 times in 24h (~1 per 53 min), and twice in
 * 107 seconds during one investigation.
 *
 * So: one SHORT tick advances ONE step and returns. State lives durably outside the
 * process, and a restart between ticks costs at most one tick. This is law 5 as
 * written — pace is a rhythm the selector reads, not a timer and not a long loop.
 *
 * THE HOST. boredom-vessel drives the heartbeat (6 restarts/24h, and NOT the vessel a
 * step cutover restarts). This resolver holds zero state between ticks.
 *
 * THE STORE. poolImpulse -> /workspace/pool/standing.json on the named volume
 * substrate-workspace. Round trip proven across process death on this deployment, not
 * asserted: rows written weeks earlier read back with bodies intact through PIDs that
 * did not exist when they were written. Deliberately NOT the boredom queue, whose 369
 * rows have no consumer and which lives outside any volume.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TREE IS THE GROUND TRUTH, NOT THE EXECUTION STORE.
 *
 * The central hazard of any resumable series is re-dispatching an edit that already
 * landed, into an anchor that no longer matches. The execution store cannot answer
 * "did this land?" reliably — a lost verdict and a never-dispatched step look the
 * same, which is exactly why dispatch_goal now returns `reached` three-valued with
 * null meaning UNKNOWN rather than failure (7d471cf).
 *
 * This resolver does not rely on that. Before dispatching ANY step — pending, unknown,
 * or lease-expired — it reconciles against the file itself:
 *
 *   anchor absent AND replacement present  -> the edit LANDED. Advance, do not dispatch.
 *   anchor present exactly once            -> safe to dispatch.
 *   anything else                          -> BLOCKED, never guessed.
 *
 * That predicate is idempotent, needs no durable verdict, and survives any crash at
 * any point. A step killed mid-dispatch is simply re-examined on the next tick and
 * classified by what is actually in the file.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SCOPE, stated honestly. This advances a plan an operator or activity SEEDS; it does
 * not author plans. It handles IN-FILE contiguous-region edits only — whole-file
 * deletion is not dispatchable at all today, because a pure-deletion plan leaves
 * changedRel empty so the mitosis root is never created, and step 9a re-copies any
 * staged file missing from /vessels, resurrecting it. Deferred deliberately.
 */
import type { ResolverResult } from "./types.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { orderChangePlan, type PlannedChange } from "../maintenance/change-plan.js";
import { resolvePoolImpulse, resolvePoolImpulseWrite } from "./pool-impulse.js";
import { resolveDispatchGoal } from "./dispatch-goal.js";

const SERIES_SHAPE = "changeSeriesPlan";
const VESSELS_ROOT = process.env["VESSELS_ROOT"] ?? "/vessels";
/** Bounded well under boredom's 4s call timeout; the tick must never block a heartbeat. */
const DISPATCH_TIMEOUT_MS = 8_000;
/** A dispatched step is presumed in flight for this long before it is re-examined. */
const LEASE_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;

type StepState = "pending" | "dispatching" | "dispatched" | "landed" | "blocked";

interface SeriesStep {
  id: string;
  file: string;
  dependsOn?: string[];
  anchor: string;
  replacement: string;
  state?: StepState;
  dispatch_id?: string | null;
  attempts?: number;
  lease_until?: number;
  note?: string;
}

interface SeriesPlan {
  plan_id: string;
  steps: SeriesStep[];
  state?: "running" | "complete" | "refused";
  refused_reason?: string;
}

function absOf(file: string): string {
  return file.startsWith("/") ? file : join(VESSELS_ROOT, file.replace(/^repos\//, ""));
}

/**
 * Reconcile a step against the FILE, which is authoritative. Returns the only three
 * answers that are honest; "probably fine" is not among them.
 */
function reconcile(step: SeriesStep): { verdict: "landed" | "dispatchable" | "blocked"; detail: string } {
  const abs = absOf(step.file);
  if (!existsSync(abs)) return { verdict: "blocked", detail: `file not found: ${abs}` };
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    return { verdict: "blocked", detail: `unreadable: ${(e as Error).message}` };
  }
  const occOld = step.anchor.length > 0 ? text.split(step.anchor).length - 1 : 0;
  const occNew = step.replacement.length > 0 ? text.split(step.replacement).length - 1 : 0;
  if (occOld === 0 && occNew >= 1) return { verdict: "landed", detail: "anchor gone, replacement present" };
  if (occOld === 1) return { verdict: "dispatchable", detail: "anchor unique" };
  if (occOld === 0) return { verdict: "blocked", detail: "anchor absent and replacement absent — the file moved under the plan" };
  return { verdict: "blocked", detail: `anchor occurs ${occOld} times — not a unique contiguous region` };
}

/**
 * Validate the plan ONCE, honouring every caller obligation orderChangePlan imposes.
 * All four are real and were proven by execution, not read off the source:
 *   (a) on a CYCLE it still returns EVERY node in `ordered` — a caller that ignores
 *       cycles.length gets a complete-looking, silently WRONG sequence;
 *   (b) it SILENTLY DROPS a node when two changes share an id, and cycles stays empty,
 *       so no existing gate catches it — this function must check ids itself;
 *   (c) a dangling dependsOn id is ignored by its byId guard;
 *   (d) ordering is deterministic (id-lexicographic).
 * Plus the anchor-staleness invariant: two steps naming the SAME FILE are refused,
 * because one step per file is what guarantees no step can invalidate another's anchor.
 */
function validatePlan(plan: SeriesPlan): { ok: true; ordered: SeriesStep[] } | { ok: false; reason: string } {
  const ids = plan.steps.map((s) => s.id);
  const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupId !== undefined) return { ok: false, reason: `duplicate step id '${dupId}' — orderChangePlan would silently drop a node` };
  const files = plan.steps.map((s) => s.file);
  const dupFile = files.find((f, i) => files.indexOf(f) !== i);
  if (dupFile !== undefined) return { ok: false, reason: `two steps name the same file '${dupFile}' — one step per file is the anchor-staleness invariant` };
  const changes: PlannedChange[] = plan.steps.map((s) => ({ id: s.id, file: s.file, dependsOn: s.dependsOn ?? [] }));
  const { ordered, cycles } = orderChangePlan(changes);
  if (cycles.length > 0) return { ok: false, reason: `dependency cycle: ${cycles.map((c) => c.join("->")).join(", ")}` };
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  return { ok: true, ordered: ordered.map((c) => byId.get(c.id)!).filter(Boolean) };
}

function renderGoal(step: SeriesStep): string {
  return [
    `Edit ${step.file} to apply one atomic change.`,
    "",
    "Find this exact anchor text:",
    "```",
    step.anchor,
    "```",
    "",
    "Replace it with:",
    "```",
    step.replacement,
    "```",
  ].join("\n");
}

function loadPlans(): Array<{ id: string; plan: SeriesPlan }> {
  const res = resolvePoolImpulse({ type: "poolImpulse", shape: SERIES_SHAPE, status: "open", limit: 50 });
  const impulses = (res.body as { impulses?: Array<{ id: string; body: unknown }> }).impulses ?? [];
  const out: Array<{ id: string; plan: SeriesPlan }> = [];
  for (const imp of impulses) {
    const plan = imp.body as SeriesPlan | null;
    if (plan && Array.isArray(plan.steps) && typeof plan.plan_id === "string") out.push({ id: imp.id, plan });
  }
  return out;
}

function persist(rowId: string, plan: SeriesPlan): void {
  resolvePoolImpulseWrite({ type: "poolImpulse_write", id: rowId, shape: SERIES_SHAPE, body: plan, source: "change-series-tick", status: "open" });
}

export async function resolveChangeSeriesTick(_pointer: Record<string, unknown>): Promise<ResolverResult> {
  const plans = loadPlans();
  const active = plans.find((p) => (p.plan.state ?? "running") === "running");
  if (!active) return { shape: "changeSeriesTickResult", body: { advanced: false, reason: "no running plan" } };

  const { id: rowId, plan } = active;

  const valid = validatePlan(plan);
  if (!valid.ok) {
    plan.state = "refused";
    plan.refused_reason = valid.reason;
    persist(rowId, plan);
    console.warn(`[change-series] plan ${plan.plan_id} REFUSED: ${valid.reason}`);
    return { shape: "changeSeriesTickResult", body: { advanced: false, refused: true, reason: valid.reason } };
  }

  const now = Date.now();
  for (const step of valid.ordered) {
    const state = step.state ?? "pending";
    if (state === "landed" || state === "blocked") continue;

    // A step still inside its lease is presumed IN FLIGHT — for BOTH "dispatching" and
    // "dispatched". Covering only "dispatching" was a real defect, observed live: the
    // window between the pre-dispatch write and the post-dispatch write is milliseconds,
    // so the guard essentially never fired, and a dispatched goal — which takes MINUTES
    // to travel the drafter, semantic gate and cutover — was re-dispatched on the very
    // next 30s beat. Measured: step a-ribosome reached attempt=2 within 33 seconds, and
    // would have exhausted MAX_ATTEMPTS and blocked itself long before the first goal
    // could land. The lease, not the state name, is what says "leave this alone".
    if ((state === "dispatching" || state === "dispatched") && typeof step.lease_until === "number" && step.lease_until > now) {
      return { shape: "changeSeriesTickResult", body: { advanced: false, reason: "step in flight", plan_id: plan.plan_id, step: step.id } };
    }

    // RECONCILE BEFORE ANY DISPATCH — pending, dispatched and lease-expired alike.
    // This is the whole B3 defence: the answer comes from the file, never from a
    // verdict that may have been lost.
    const rec = reconcile(step);
    if (rec.verdict === "landed") {
      step.state = "landed";
      step.note = rec.detail;
      persist(rowId, plan);
      console.log(`[change-series] plan=${plan.plan_id} step=${step.id} LANDED (${rec.detail}) — reconciled from the file, not a verdict`);
      return { shape: "changeSeriesTickResult", body: { advanced: true, plan_id: plan.plan_id, step: step.id, outcome: "landed" } };
    }
    if (rec.verdict === "blocked") {
      step.state = "blocked";
      step.note = rec.detail;
      persist(rowId, plan);
      console.warn(`[change-series] plan=${plan.plan_id} step=${step.id} BLOCKED: ${rec.detail}`);
      return { shape: "changeSeriesTickResult", body: { advanced: true, plan_id: plan.plan_id, step: step.id, outcome: "blocked", detail: rec.detail } };
    }

    const attempts = (step.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      step.state = "blocked";
      step.note = `max attempts (${MAX_ATTEMPTS}) exhausted`;
      persist(rowId, plan);
      console.warn(`[change-series] plan=${plan.plan_id} step=${step.id} BLOCKED: max attempts`);
      return { shape: "changeSeriesTickResult", body: { advanced: true, plan_id: plan.plan_id, step: step.id, outcome: "blocked", detail: step.note } };
    }

    // PRE-DISPATCH WRITE. attempts is incremented and the lease taken BEFORE the call,
    // so a crash inside the dispatch window still consumes an attempt and still leaves
    // a held lease. Incrementing afterwards would let a crash loop retry forever.
    step.state = "dispatching";
    step.attempts = attempts;
    step.lease_until = now + LEASE_MS;
    persist(rowId, plan);

    const goal = renderGoal(step);
    const res = await resolveDispatchGoal({
      type: "dispatch_goal",
      goal,
      tags: ["change_series", `plan:${plan.plan_id}`, `step:${step.id}`],
      timeout_ms: DISPATCH_TIMEOUT_MS,
    } as Parameters<typeof resolveDispatchGoal>[0]);

    const dispatchId = ((res as { body?: { dispatch_id?: string | null } }).body?.dispatch_id) ?? null;
    step.state = "dispatched";
    step.dispatch_id = dispatchId;
    persist(rowId, plan);
    console.log(`[change-series] plan=${plan.plan_id} step=${step.id} DISPATCHED dispatch_id=${String(dispatchId)} attempt=${attempts} file=${step.file}`);
    return { shape: "changeSeriesTickResult", body: { advanced: true, plan_id: plan.plan_id, step: step.id, outcome: "dispatched", dispatch_id: dispatchId } };
  }

  plan.state = "complete";
  persist(rowId, plan);
  const landed = valid.ordered.filter((s) => s.state === "landed").length;
  const blocked = valid.ordered.filter((s) => s.state === "blocked").length;
  console.log(`[change-series] plan=${plan.plan_id} COMPLETE landed=${landed} blocked=${blocked} of ${valid.ordered.length}`);
  return { shape: "changeSeriesTickResult", body: { advanced: true, plan_id: plan.plan_id, outcome: "complete", landed, blocked, total: valid.ordered.length } };
}
