import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * trace-store-health-observer — single-task tick template wrapping the
 * `trace_store_health_observer` resolver (openspec
 * 2026-07-08-substrate-self-managed-db-reconciliation).
 *
 * Reads activity-api's `GET /metrics/db` `traceStore` block (row_count, cap)
 * — a pre-aggregated counter, never a live scan of `activity_execution_traces`
 * — and emits a `substrateGap` (category `trace_store_reconciliation`) when
 * row_count exceeds cap, so the loop dispatches
 * `development-vessel:trace-store-reconcile` autonomously (via
 * gap_to_feature -> goal-host) instead of requiring an operator to notice.
 *
 * Model: detect-stale-pointer.ts (single deterministic resolver task, no LLM).
 */
export const TRACE_STORE_HEALTH_OBSERVER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:trace-store-health-observer",
  name: "trace-store-health-observer",
  description:
    "Reads activity-api's GET /metrics/db traceStore block (row_count, cap) and " +
    "emits a substrateGap(category=trace_store_reconciliation) when row_count > cap, " +
    "deduped by an hour-bucketed id so a sustained overage stays one open gap. " +
    "Never queries activity_execution_traces directly — counters only.",
  inputShapes: [],
  outputShapes: ["substrateGap", "traceStoreHealthReport"],
  tags: [
    "lift.autonomous.loop",
    "db.maintenance.trace-store",
    "substrate.self-management",
  ],
  variables: [],
  tasks: [
    {
      id: "observe",
      description:
        "Fetch /metrics/db, compare traceStore.row_count against traceStore.cap, " +
        "and emit a substrateGap on overage. Returns a traceStoreHealthReport.",
      resolver: "trace_store_health_observer",
      config: {
        type: "trace_store_health_observer",
      },
      outputShapes: ["traceStoreHealthReport"],
    },
  ],
};
