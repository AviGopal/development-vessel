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
 * own TTL (see maintenance-lease.ts) is the backstop — acquire_lease's
 * ttl_ms is set to bound the abandoned-lease window rather than relying on
 * an in-template failure branch.
 *
 * THE TTL IS A DEADLINE FOR OTHER WORK, NOT JUST FOR THIS ONE (2026-08-09).
 * `change_window` has NO name dimension — maintenance-lease.ts keys a single
 * global mutex and silently discards the `name:` every caller passes — so the
 * lease this template holds is the SAME lease vessel-mitosis-cutover must take
 * before it may write to /vessels. That cutover waits CUTOVER_LEASE_WAIT_MS
 * (default 90s) and then defers.
 *
 * So the abandoned-lease window is not a private cost: while it is held, no
 * substrate-authored edit can land anywhere in the fleet. With a 15-minute TTL
 * and a re-dispatch cadence near 10 minutes, a task that always failed produced
 * a ~100%-duty-cycle exclusion lock — measured 2026-08-09, and it is why the
 * fleet could not self-edit at all.
 *
 * ttl_ms is therefore sized to the work (a copy-forward swap, seconds to a few
 * minutes) rather than left generous "just in case". The trade is deliberate:
 * too short and a genuinely slow swap loses its lease mid-run and a second
 * reconcile could start concurrently; too long and every failure blocks all
 * self-editing for that duration. 5 minutes keeps ample headroom over an
 * observed swap while bounding the blast radius of an abort to one third of
 * what it was. The durable fix for the concurrency edge is a release on the
 * failure path, which needs template-schema support that does not exist yet.
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
  variables: [
    // DECLARE IT OR IT RENDERS EMPTY. An undeclared {{placeholder}} has no
    // producer and no default, so the URL would come out as "/v2/impulses/
    // resolve" and fail exactly as the old hardcoded one did — differently
    // broken, equally dead. `activity_api_endpoint` is the fleet's established
    // name for this (detect-cutover-stuck-loop.ts:69 declares it the same way
    // for the same /v2/impulses/resolve call); the default is only correct on a
    // hub, which is where the trace store lives, and a spoke overrides it.
    { name: "activity_api_endpoint", description: "Activity-api base URL. Default http://127.0.0.1:8080." },
  ],
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
        // 5 min, not 15 — see "THE TTL IS A DEADLINE FOR OTHER WORK" above.
        // This lease is the global change_window every cutover must take.
        ttl_ms: 300_000,
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
        // THREE DEFECTS IN ONE CALL, ALL FATAL, NONE EVER OBSERVED (2026-08-09).
        // This task had never succeeded on any host since it was written, and the
        // failure was invisible because the run dies here — BEFORE release_lease —
        // so the 15-minute lease is left parked and re-taken by the next re-dispatch.
        // With change_window at a ~100% duty cycle, every vessel-mitosis-cutover
        // lease acquire timed out, so NO self-authored edit could land at all.
        //
        //  1. The URL named a route that does not exist: `grep -rn
        //     "reconcile-trace-store" repos/activity-api/src` returns NOTHING. The
        //     db_admin ops are reached through the impulse plane
        //     (routes/impulses.ts:5243 `case 'db_admin'`), never a REST path.
        //  2. `127.0.0.1:8080` is unreachable wherever activity-api is not local.
        //     activity-api is role `api` — hub-owned — so on every spoke this is a
        //     connection refusal by construction. Endpoints belong to discovery,
        //     not to a hardcoded loopback port (law 11).
        //  3. The lease token was sent as an `Authorization: Bearer` header, but
        //     resolveReconcileTraceStore reads `pointer.lease_token` from the BODY
        //     (routes/db-admin-reconcile.ts:217) and fail-closes 403 without it. So
        //     even against a correct URL on a correct host, the gate would refuse.
        //
        // {{activity_api_endpoint}} is a DECLARED variable (see `variables`
        // above) — an undeclared placeholder has no producer and would render
        // empty, which is how the first draft of this fix was still broken.
        url: "{{activity_api_endpoint}}/v2/impulses/resolve",
        // NO EXPLICIT `headers` — that is load-bearing, not an omission.
        // http_fetch auto-attaches METABOB_API_KEY for substrate-local hosts
        // (documented in ias-executor-ts/src/templates/lifecycle/ribosome-extract.json),
        // and supplying a headers object suppresses it: the impulse plane then
        // answers 401 MISSING_AUTH. The original code only got past that check by
        // accident, because its (wrongly-populated) Authorization: Bearer header
        // happened to satisfy the presence test. Every sibling that POSTs to
        // /v2/impulses/resolve sends no headers at all — see
        // detect-cutover-stuck-loop.ts:150-155.
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "db_admin",
              operation: "reconcile_trace_store",
              dry_run: false,
              lease_token: "{{extract_lease_token_text}}",
            },
          },
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
