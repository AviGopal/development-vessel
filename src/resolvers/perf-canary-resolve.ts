/**
 * perf_canary_resolve (2026-06-28) — the autonomous RESOLUTION loop for a
 * performance_inefficiency gap. It wires the verdict into ACTION, which is what
 * turns "detect + author" into "resolve". It is the perf analogue of the goal
 * /resolve loop's in-flight recovery (try-approach -> reach-gate -> on fail
 * exclude + try a DIFFERENT approach -> until reached or exhausted), with the
 * GOAL reach-gate replaced by the METRIC reach-gate (performance_reach_gate).
 *
 * Per attempt (fix-class escalation):
 *   1. snapshot the target file(s)            (so a non-improving change can be reverted)
 *   2. feature_compose(land:false)            (author + typecheck-stage into /vessels)
 *   3. CANARY cutover: restart the unit       (the staged change goes live)
 *   4. performance_reach_gate                 (re-measure: did the metric actually move?)
 *   5. reached -> KEEP (close the gap); else REVERT (restore snapshot + restart) and
 *      escalate to the NEXT fix-class (a genuinely different approach: single-file ->
 *      reduce-over-fetch -> architectural).
 * Exhausted -> ESCALATE TO OPERATOR (the anchor-maintainer role): some fixes (a
 * schema/summary-store change) exceed single-spec authoring; thrashing is worse than
 * a clean hand-off, so the loop records an operator-escalation memoryNote and stops.
 *
 * dry_run (DEFAULT TRUE) plans the loop — reads the gap, asks feature_compose for the
 * first approach's plan, and reports the canary decision it WOULD take — WITHOUT
 * applying, restarting, or reverting anything. Live execution restarts a running vessel
 * (incl. the trace store) and is therefore operator-gated.
 */
import { METABOB_API_KEY } from "../config.js";
import { resolveSubstrateGap } from "./substrate-gap.js";
import { resolveFeatureCompose } from "./feature-compose.js";
import { resolvePerformanceReachGate } from "./performance-reach-gate.js";
import type { ResolverResult } from "./types.js";

const DISCOVERY_ENDPOINT = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const RUNTIME_ROOT = process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";

export interface PerfCanaryResolvePointer {
  type: "perf_canary_resolve";
  /** The performance_inefficiency gap to resolve. */
  gap_id: string;
  /** Fix-class escalation attempts before escalating to the operator. Default 2. */
  max_attempts?: number;
  /** DEFAULT TRUE: plan only, no apply/cutover/revert. */
  dry_run?: boolean;
  model?: string;
}

type Json = Record<string, unknown>;

async function discover(shape: string): Promise<string | null> {
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json()) as { content?: { vessels?: Array<{ resolve_endpoint?: string; endpoint?: string }> } };
    const v = j.content?.vessels?.[0];
    return v?.resolve_endpoint ?? v?.endpoint ?? null;
  } catch {
    return null;
  }
}

async function callTool(endpoint: string, tool: string, args: Json): Promise<{ ok: boolean; body: Json }> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ type: tool, ...args }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok, body };
  } catch (e) {
    return { ok: false, body: { error: (e as Error).message } };
  }
}

export async function resolvePerfCanaryResolve(pointer: PerfCanaryResolvePointer): Promise<ResolverResult> {
  const dryRun = pointer.dry_run ?? true;
  const maxAttempts = Math.max(1, Math.min(pointer.max_attempts ?? 2, 4));

  // 1. Read the gap.
  const gapRes = await resolveSubstrateGap({ type: "substrateGap", id: pointer.gap_id });
  const gaps = ((gapRes.body as { gaps?: unknown[] })?.gaps ?? []) as Array<Json>;
  const gap = gaps.find((g) => String(g.id) === pointer.gap_id) ?? gaps[0];
  if (!gap) {
    return { shape: "perfCanaryReport", body: { ok: false, error: `gap not found: ${pointer.gap_id}` } };
  }
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Json;
  const probePath = String(meta.path ?? "");
  const baseline = Number(meta.measured_latency_ms ?? 0) || undefined;
  const editSite = typeof meta.edit_site === "string" ? meta.edit_site : null;
  const proposedFix = typeof meta.proposed_fix === "string" ? meta.proposed_fix : String(gap.summary ?? "");
  const targetVessel = editSite ? editSite.split("/src/")[0] : null; // "repos/<vessel>"
  const restartUnit = targetVessel ? targetVessel.replace(/^repos\//, "") : null;

  if (!probePath || !targetVessel || !restartUnit || !editSite) {
    return { shape: "perfCanaryReport", body: { ok: false, error: "gap lacks probe path / edit_site to localize the target vessel", gap_id: pointer.gap_id } };
  }

  // Fix-class ladder. Each attempt is a GENUINELY DIFFERENT class; later attempts
  // are prompted to differ from the (failed) earlier ones — the recommendExcluding analogue.
  const fixClasses = [
    proposedFix,
    `A DIFFERENT approach than the previous (which did not move the metric): instead of editing the endpoint query, REDUCE what callers fetch — find the callers that request very large limits (e.g. 500-2000) and lower them to <=100, since the cost is materialising many large documents under concurrent load.`,
    `A DIFFERENT approach than the previous two: this likely needs an ARCHITECTURAL change (a denormalised lightweight summary table / projection so the list view never loads full trace documents, or a server-side hard cap on the list limit). If this exceeds a safe surgical edit, do the minimal safe version and report what remains.`,
  ];

  const attemptsPlanned = Math.min(maxAttempts, fixClasses.length);

  if (dryRun) {
    // Plan the first approach only (no apply), and report the loop the live run WOULD take.
    const llmEndpoint = await discover("llm_completion");
    let firstPlan: unknown = null;
    if (llmEndpoint) {
      const compose = await resolveFeatureCompose({
        type: "feature_compose",
        spec: `${proposedFix}\n\n(Target file: ${editSite}.)`,
        verify_vessels: [targetVessel],
        dry_run: true,
        model: pointer.model,
      } as Parameters<typeof resolveFeatureCompose>[0]);
      firstPlan = (compose.body as Json)?.ops ?? compose.body;
    }
    return {
      shape: "perfCanaryReport",
      body: {
        ok: true,
        dry_run: true,
        gap_id: pointer.gap_id,
        probe_path: probePath,
        baseline_latency_ms: baseline ?? null,
        target_vessel: targetVessel,
        restart_unit: restartUnit,
        attempts_planned: attemptsPlanned,
        fix_class_ladder: fixClasses.slice(0, attemptsPlanned),
        first_approach_plan: firstPlan,
        canary_loop: "for each fix-class: snapshot -> feature_compose(land:false) -> restart unit (canary) -> performance_reach_gate -> KEEP if reached else REVERT + escalate; exhausted -> escalate to operator",
        note: "dry_run: nothing applied/restarted/reverted. Run with dry_run:false to execute the canary (restarts the target vessel).",
      },
    };
  }

  // LIVE canary + escalation loop.
  const toolsEndpoint = await discover("shellResult");
  if (!toolsEndpoint) {
    return { shape: "perfCanaryReport", body: { ok: false, error: "shell tool endpoint discovery failed" } };
  }
  const editSiteAbs = `${RUNTIME_ROOT}/${editSite.replace(/^repos\//, "")}`;
  const attempts: Array<Json> = [];

  for (let i = 0; i < attemptsPlanned; i++) {
    const spec = `${fixClasses[i]}\n\n(Target file: ${editSite}.)`;
    // 1. SNAPSHOT the edit-site file content (the container /vessels is NOT a git repo,
    //    so revert is an fs restore, not git checkout). feature_compose rolls its OWN
    //    edits back on typecheck-fail; this snapshot is for the REACHED-FALSE case where
    //    the change typecheck-passed but did not move the metric and must be undone.
    const snap = await callTool(toolsEndpoint, "fs_read", { path: editSiteAbs });
    const snapshot = typeof (snap.body as { content?: unknown })?.content === "string"
      ? String((snap.body as { content?: unknown }).content)
      : null;
    // 2. author + stage (land:false keeps the change in /vessels on FAVORABLE; rolls back on typecheck-fail).
    const compose = await resolveFeatureCompose({
      type: "feature_compose",
      spec,
      verify_vessels: [targetVessel],
      dry_run: false,
      land: false,
      model: pointer.model,
    } as Parameters<typeof resolveFeatureCompose>[0]);
    const cbody = compose.body as Json;
    if (cbody?.verdict !== "FAVORABLE") {
      attempts.push({ fix_class: i, stage: "author", verdict: cbody?.verdict ?? "error", note: "did not stage; escalate fix-class" });
      continue;
    }
    // 3. CANARY cutover: restart the unit so the staged change goes live.
    await callTool(toolsEndpoint, "shell", { command: `systemctl restart ${restartUnit}`, cwd: RUNTIME_ROOT });
    // brief settle
    await callTool(toolsEndpoint, "shell", { command: `for i in $(seq 1 15); do curl -s -m2 -o /dev/null http://localhost:8080/health 2>/dev/null && break; sleep 2; done`, cwd: RUNTIME_ROOT });
    // 4. METRIC reach-gate.
    const gate = await resolvePerformanceReachGate({
      type: "performance_reach_gate",
      probe_path: probePath,
      baseline_latency_ms: baseline,
      samples: 3,
    } as Parameters<typeof resolvePerformanceReachGate>[0]);
    const gbody = gate.body as Json;
    if (gbody?.reached === true) {
      attempts.push({ fix_class: i, stage: "verify", reached: true, gate: gbody });
      return {
        shape: "perfCanaryReport",
        body: { ok: true, resolved: true, gap_id: pointer.gap_id, winning_fix_class: i, attempts, gate: gbody, action: "kept" },
      };
    }
    // 5. REVERT: restore the edit-site file from the fs snapshot + restart, then
    //    escalate to the next fix-class.
    let reverted = false;
    if (snapshot !== null) {
      const w = await callTool(toolsEndpoint, "fs_write", { path: editSiteAbs, content: snapshot });
      reverted = w.ok;
      await callTool(toolsEndpoint, "shell", { command: `systemctl restart ${restartUnit}`, cwd: RUNTIME_ROOT });
    }
    attempts.push({ fix_class: i, stage: "verify", reached: false, reverted, gate: gbody });
  }

  // Exhausted -> escalate to operator.
  return {
    shape: "perfCanaryReport",
    body: {
      ok: true,
      resolved: false,
      escalated_to_operator: true,
      gap_id: pointer.gap_id,
      attempts,
      note: `No fix-class reached the target after ${attemptsPlanned} attempts. This likely exceeds a safe surgical edit (architectural: summary store / limit policy). Escalating to the operator (anchor-maintainer) rather than thrashing.`,
    },
  };
}
