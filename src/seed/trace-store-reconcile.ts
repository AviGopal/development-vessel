import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * trace-store-reconcile — the autonomous DB-maintenance activity (openspec
 * 2026-07-08-substrate-self-managed-db-reconciliation). Dispatched by
 * gap_to_feature when a `substrateGap(category=trace_store_reconciliation)`
 * is open (emitted by trace_store_health_observer).
 *
 * Sequence: acquire lease -> extract token -> invoke activity-api's
 * `db_admin reconcile_trace_store` (the copy-forward two-hop swap in
 * design.md §"The swap") -> verify the swap actually brought row_count
 * back under cap -> release lease.
 *
 * DATA-FLOW BINDING: cross-task values flow through `{{<taskId>_text}}`
 * (the string content of a task's first output impulse — see
 * draft-activity-from-pattern.ts's note on this). There is no
 * `{{shape.field}}` addressing, so pulling a single JSON field (the lease
 * `token`) out of acquire_lease's structured output requires its own
 * `json_path_extract` task first (same pattern as
 * drain-pending-substrate-gaps.ts's read_open_gaps -> extract_gap_id).
 * `extract_lease_token_text` is then reused by BOTH the reconcile task
 * (lease_token) and the release task (token) — accumulated variables persist
 * across the whole task list, not just the next task.
 *
 * FAILURE-PATH RELEASE: this template schema has no declared on-failure
 * branch (grep of src/seed/*.ts / ActivityTemplate found no such field), so
 * if the reconcile or verify task fails mid-run, `release_lease` is simply
 * never reached and the lease is NOT explicitly released here. The lease's
 * own TTL (default 15 min, see maintenance-lease.ts) is the backstop —
 * acquire_lease's ttl_ms is set to bound the abandoned-lease window rather
 * than relying on an in-template failure branch.
 */
export const TRACE_STORE_RECONCILE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:trace-store-reconcile",
  name: "trace-store-reconcile",
  description:
    "Acquires the maintenance lease, dispatches activity-api's db_admin " +
    "reconcile_trace_store (copy-forward swap of activity_execution_traces back " +
    "under its configured cap), verifies row_count <= cap post-swap, and releases " +
    "the lease. See openspec 2026-07-08-substrate-self-managed-db-reconciliation/design.md.",
  inputShapes: ["substrateGap"],
  outputShapes: ["maintenanceLeaseWriteResult", "traceStoreHealthReport"],
  tags: [
    "maintenance.db.reconcile",
    "lift.autonomous.loop",
    "db.maintenance.trace-store",
  ],
  variables: [],
  tasks: [
    {
      id: "acquire_lease",
      description:
        "Acquire the maintenance lease for this reconcile run. Refuses (acquired: " +
        "false) if a different holder already holds an unexpired lease.",
      resolver: "maintenanceLease_write",
      config: {
        type: "maintenanceLease_write",
        op: "acquire",
        holder: "trace-store-reconcile",
        ttl_ms: 900_000,
      },
      outputShapes: ["maintenanceLeaseWriteResult"],
    },
    {
      id: "extract_lease_token",
      description:
        "Pull the acquired lease's token out of acquire_lease's JSON output so it " +
        "can be threaded into the db_admin call and the release call below.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{acquire_lease_text}}",
        path: "token",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "reconcile",
      description:
        "Invoke activity-api's db_admin reconcile_trace_store op (live run, not " +
        "dry_run) with the acquired lease token. activity-api validates the token " +
        "against the same /workspace/leases/maintenance.json file before executing " +
        "the copy-forward swap.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8080/v2/db/admin/reconcile-trace-store",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer {{extract_lease_token_text}}",
        },
        body: JSON.stringify({
          dry_run: false,
        }),
        failOnNon2xx: true,
      },
      outputShapes: ["httpResponse"],
    },
    {
      id: "verify",
      description:
        "Re-read the traceStore counters (dry_run so this check itself never " +
        "re-emits a gap) and assert row_count <= cap post-swap.",
      resolver: "trace_store_health_observer",
      config: {
        type: "trace_store_health_observer",
        dry_run: true,
      },
      outputShapes: ["traceStoreHealthReport"],
      validation: {
        forbiddenPatterns: ['"over_cap":true'],
      },
    },
    {
      id: "release_lease",
      description:
        "Release the maintenance lease using the same token acquired above.",
      resolver: "maintenanceLease_write",
      config: {
        type: "maintenanceLease_write",
        op: "release",
        token: "{{extract_lease_token_text}}",
      },
      outputShapes: ["maintenanceLeaseWriteResult"],
    },
  ],
};
