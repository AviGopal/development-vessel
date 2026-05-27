import { Hono } from "hono";
import { resolveGitStatus } from "../resolvers/git-status.js";
import { resolveGitAdd } from "../resolvers/git-add.js";
import { resolveGitCommit } from "../resolvers/git-commit.js";
import { resolveGitDiff } from "../resolvers/git-diff.js";
import { resolveGitLog } from "../resolvers/git-log.js";
import { resolveFsRead } from "../resolvers/fs-read.js";
import { resolveFsWrite } from "../resolvers/fs-write.js";
import { resolveFsEdit } from "../resolvers/fs-edit.js";
import { resolveActivityFetch } from "../resolvers/activity-fetch.js";
import { resolveActivityCreateVariant } from "../resolvers/activity-create-variant.js";
import { resolveVesselRegisterPassthrough } from "../resolvers/vessel-register-passthrough.js";
import { resolveCodeIntrospect } from "../resolvers/code-introspect.js";
import { resolvePropagateJudgment } from "../resolvers/propagate-judgment.js";
import { resolveLiftDemoNoop } from "../resolvers/lift-demo-noop.js";
import { resolveLlmCompletionDispatch } from "../resolvers/llm-completion-dispatch.js";
import { resolveJsonPathExtract } from "../resolvers/json-path-extract.js";
import { resolveActivityRecommend } from "../resolvers/activity-recommend.js";
import { resolveActivityDiscoverByShapes } from "../resolvers/activity-discover-by-shapes.js";
import { resolveSystemdRestart } from "../resolvers/systemd-restart.js";
import { resolveLearnedTopologySnapshot } from "../resolvers/learned-topology-snapshot.js";
import { resolveReachableUnlearnedReport } from "../resolvers/reachable-unlearned-report.js";
import { resolveUnknownShapeReport } from "../resolvers/unknown-shape-report.js";
import { resolveCoverageTick } from "../resolvers/coverage-tick.js";
import { resolveSubstrateHealthTick } from "../resolvers/substrate-health-tick.js";
import { resolveFailureModeMatrixScore } from "../resolvers/failure-mode-matrix-score.js";
import { resolveBoredomEnqueue } from "../resolvers/boredom-enqueue.js";
import { resolveMemoryNote, resolveMemoryNoteWrite } from "../resolvers/memory-note.js";
import { resolveFsList } from "../resolvers/fs-list.js";
import { resolveHttpFetch } from "../resolvers/http-fetch.js";
import { resolveReachableUnlearnedProbe } from "../resolvers/reachable-unlearned-probe.js";
import type { ResolverResult } from "../resolvers/types.js";

type AnyPointer = { type: string } & Record<string, unknown>;

/** Shared dispatch logic — used by both the HTTP route and the CLI. */
export async function resolveDispatch(pointer: AnyPointer): Promise<ResolverResult> {
  const p = pointer as unknown;
  switch (pointer.type) {
    case "lift_demo_noop":
      return resolveLiftDemoNoop();
    case "git_status":
      return resolveGitStatus(p as Parameters<typeof resolveGitStatus>[0]);
    case "git_add":
      return resolveGitAdd(p as Parameters<typeof resolveGitAdd>[0]);
    case "git_commit":
      return resolveGitCommit(p as Parameters<typeof resolveGitCommit>[0]);
    case "git_diff":
      return resolveGitDiff(p as Parameters<typeof resolveGitDiff>[0]);
    case "git_log":
      return resolveGitLog(p as Parameters<typeof resolveGitLog>[0]);
    case "fs_read":
      return resolveFsRead(p as Parameters<typeof resolveFsRead>[0]);
    case "fs_write":
      return resolveFsWrite(p as Parameters<typeof resolveFsWrite>[0]);
    case "fs_edit":
      return resolveFsEdit(p as Parameters<typeof resolveFsEdit>[0]);
    case "activity_fetch":
      return resolveActivityFetch(p as Parameters<typeof resolveActivityFetch>[0]);
    case "activity_create_variant":
      return resolveActivityCreateVariant(p as Parameters<typeof resolveActivityCreateVariant>[0]);
    case "vessel_register_passthrough":
      return resolveVesselRegisterPassthrough(p as Parameters<typeof resolveVesselRegisterPassthrough>[0]);
    case "code_introspect":
      return resolveCodeIntrospect(p as Parameters<typeof resolveCodeIntrospect>[0]);
    case "propagate_judgment":
      return resolvePropagateJudgment(p as Parameters<typeof resolvePropagateJudgment>[0]);
    case "llm_completion_dispatch":
      return resolveLlmCompletionDispatch(p as Parameters<typeof resolveLlmCompletionDispatch>[0]);
    case "json_path_extract":
      return resolveJsonPathExtract(p as Parameters<typeof resolveJsonPathExtract>[0]);
    case "activity_recommend":
      return resolveActivityRecommend(p as Parameters<typeof resolveActivityRecommend>[0]);
    case "activity_discover_by_shapes":
      return resolveActivityDiscoverByShapes(p as Parameters<typeof resolveActivityDiscoverByShapes>[0]);
    case "systemd_restart":
      return resolveSystemdRestart(p as Parameters<typeof resolveSystemdRestart>[0]);
    case "learned_topology_snapshot":
      return resolveLearnedTopologySnapshot(p as Parameters<typeof resolveLearnedTopologySnapshot>[0]);
    case "reachable_unlearned_report":
      return resolveReachableUnlearnedReport(p as Parameters<typeof resolveReachableUnlearnedReport>[0]);
    case "unknown_shape_report":
      return resolveUnknownShapeReport(p as Parameters<typeof resolveUnknownShapeReport>[0]);
    case "coverage_tick":
      return resolveCoverageTick(p as Parameters<typeof resolveCoverageTick>[0]);
    case "substrate_health_tick":
      return resolveSubstrateHealthTick(p as Parameters<typeof resolveSubstrateHealthTick>[0]);
    case "failure_mode_matrix_score":
      return resolveFailureModeMatrixScore(p as Parameters<typeof resolveFailureModeMatrixScore>[0]);
    case "boredom_enqueue":
      return resolveBoredomEnqueue(p as Parameters<typeof resolveBoredomEnqueue>[0]);
    case "memoryNote":
      return resolveMemoryNote(p as Parameters<typeof resolveMemoryNote>[0]);
    case "memoryNote_write":
      return resolveMemoryNoteWrite(p as Parameters<typeof resolveMemoryNoteWrite>[0]);
    case "fs_list":
      return resolveFsList(p as Parameters<typeof resolveFsList>[0]);
    case "http_fetch":
      return resolveHttpFetch(p as Parameters<typeof resolveHttpFetch>[0]);
    case "reachable_unlearned_probe":
      return resolveReachableUnlearnedProbe(p as Parameters<typeof resolveReachableUnlearnedProbe>[0]);
    default:
      throw new Error(`unknown shape: ${pointer.type}`);
  }
}

export const impulsesRouter = new Hono();

/**
 * Vessel-proxy adapter endpoint.
 *
 * VesselResolverProxy in minibob calls POST /resolvers/execute with:
 *   { resolver: string, impulseRefs: ImpulseRef[], config: Record<string,unknown> }
 * and expects back:
 *   { impulses: Impulse[] }
 *
 * This adapts the minibob vessel-proxy wire format to dev-vessel's own
 * resolver dispatch logic and wraps the result as a single-item impulses array.
 */
impulsesRouter.post("/resolvers/execute", async (c) => {
  let body: { resolver?: string; impulseRefs?: unknown[]; config?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const resolverName = body?.resolver;
  if (!resolverName) {
    return c.json({ error: "resolver field is required" }, 400);
  }

  try {
    const pointer = { ...(body.config ?? {}), type: resolverName };
    const result = await resolveDispatch(pointer as { type: string } & Record<string, unknown>);
    const content = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    const impulse = {
      id: `dv-resolver-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      pointer: { type: "memo", content },
      content,
      loaded: true,
      budget: Math.ceil(content.length / 4),
      priority: "high" as const,
      metadata: { shape: result.shape },
      createdAt: Date.now(),
    };
    return c.json({ impulses: [impulse] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

impulsesRouter.post("/v2/impulses/resolve", async (c) => {
  let body: { impulse?: { type?: string; pointer?: { type?: string } } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const pointer = body?.impulse?.pointer ?? body?.impulse;
  const pointerType = pointer?.type ?? body?.impulse?.type;

  if (!pointerType) {
    return c.json({ success: false, error: "pointer.type is required" }, 400);
  }

  try {
    const result = await resolveDispatch({ ...(pointer as Record<string, unknown>), type: pointerType });
    return c.json({ success: true, shape: result.shape, body: result.body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown shape:")) {
      return c.json({ success: false, error: message }, 400);
    }
    return c.json({ success: false, error: message }, 500);
  }
});
