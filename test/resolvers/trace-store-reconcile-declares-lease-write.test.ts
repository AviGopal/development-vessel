// THE TRACE-STORE-RECONCILE DISPATCH DECLARES ITS LEASE WRITE, SO GOAL-HOST'S TASK DOOR RUNS THE LEASE TASKS.
//
// gap_to_feature routes a trace_store_reconciliation gap to goal-host /run-goal pinned to
// development-vessel:trace-store-reconcile, and the body declared nothing. maintenanceLease_write is a STORE write
// (*_write). On a pinned dispatch not admitted as a change, goal-host hands the executor
// taskWriteDoor(false, seededOutputShapes ?? expectedOutputShapes ?? []), and a store write outside that product is
// refused: acquire_lease and release_lease were skipped (success, skipped, write_door_not_admitted, no output), so
// the reconcile task posted an empty lease_token and activity-api refused it ("`lease_token` is required") on every
// run. The body now declares ["maintenanceLease_write", "traceStoreHealthReport"]: a declared store write admits
// nothing, it makes the lease the goal's product, and the health report stays the reach target.
//
// THE DOOR BELOW: the host half is a PINNED COPY of goal-host src/write-door.ts at 0bd487ad3845b8b8174af971099e78212b6f5d1b
// (refusedWrite, isWriteShape, isStoreWrite, WALK_MECHANICS_WRITES, taskWriteDoor), with isMutationShape from
// src/judge/shapes.ts:10, isStoreWriteShape from src/resolve-pointer.ts:21 and FS_WRITE_SHAPES from
// src/fs-write-shapes.ts:18 (dv does not depend on goal-host). The executor half is the real refusedTaskWrites,
// imported from @avigopal/ias-executor-ts (src/write-door.ts:56), the predicate the engine applies per task.
//
// Driven through resolveGapToFeature over a stored gap with the judge-split harness (fixture store, guarded fetch);
// the /run-goal body is the captured request.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { refusedTaskWrites } from "@avigopal/ias-executor-ts";
import { beginPin, endPin, restoreHarness, seed, route, hitsOf, tick, RUN, type Row } from "../judge-split/harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");
const { TRACE_STORE_RECONCILE_TEMPLATE } = await import("../../src/seed/trace-store-reconcile.js");

// ── pinned goal-host door (see header) ──────────────────────────────────────────────────────────────
const FS_WRITE_SHAPES = new Set([
  "fs_edit", "fs_write", "fileEditResult", "fileWriteResult",
  "code_replace_lines", "code_insert_after_line", "code_add_import",
  "codeReplaceResult", "codeInsertResult", "codeAddImportResult",
  "gitCommitResult",
]);
const CHANGE_PRIMITIVE_SHAPES = new Set([
  "code_modification_proposal", "code_modification_proposal_write", "feature_compose", "patch_with_tools", "apply_proposal_as_patch",
  "gap_compose", "author_new_resolver", "author_producer", "author_composed_capability",
  "dispatch_goal", "dispatch_latest_auto_draft", "goalDispatchAsync",
  "vessel_mitosis_start", "prune_stale_mitosis", "template_repair", "reachability_gap_repair", "variant_promote",
  "activity_create_variant", "activityTemplate_deprecate", "escalation_disposition_apply",
  "git_add", "git_commit", "git_push", "git_branch_create", "gh_pr_create", "gh_pr_merge", "gh_repo_create",
  "systemd_restart", "pull_cutover", "surrealdb_import", "activate_substrate_script", "vessel_mitosis_cutover",
]);
const WALK_MECHANICS_WRITES = new Set(["poolImpulse_write"]);
const isWriteShape = (s: unknown): boolean => typeof s === "string" && (FS_WRITE_SHAPES.has(s) || CHANGE_PRIMITIVE_SHAPES.has(s));
const isStoreWriteShape = (s: string): boolean => /_write$/.test(s) || /(^|:)write_note$/.test(s);
const isMutationShape = (s: string): boolean => isStoreWriteShape(s) || FS_WRITE_SHAPES.has(s) || /_(?:update|create|delete)$/.test(s);
const isStoreWrite = (s: unknown): boolean => typeof s === "string" && !isWriteShape(s) && isMutationShape(s) && !WALK_MECHANICS_WRITES.has(s);
const refusedWrite = (s: unknown, product?: ReadonlySet<string> | null): boolean =>
  isWriteShape(s) || (isStoreWrite(s) && !(product?.has(s as string) ?? false));
const callerDeclaresWrite = (declared: unknown): boolean => Array.isArray(declared) && declared.some((s) => isWriteShape(s));
function taskWriteDoor(admitted: boolean, goalProduct: Iterable<string>) {
  const product = new Set(goalProduct);
  return { admitted, governs: (shape: string) => refusedWrite(shape, product) };
}

/** What the engine would skip per task on this pinned dispatch: the door goal-host builds from the declared shapes. */
function refusedByTask(declared: unknown): Record<string, string[]> {
  const product = Array.isArray(declared) ? (declared as string[]) : [];
  const door = taskWriteDoor(callerDeclaresWrite(declared), product);
  const out: Record<string, string[]> = {};
  for (const t of TRACE_STORE_RECONCILE_TEMPLATE.tasks) out[t.id] = refusedTaskWrites(t, door);
  return out;
}

const pathIs = (re: RegExp) => (u: string) => { try { return re.test(new URL(u).pathname); } catch { return false; } };
function routeTraceStore(): void {
  route({ name: "variants", match: pathIs(/^\/v2\/activities\/[^/]+\/variants$/), respond: () => Response.json({ variants: [] }) });
  route({ name: "templates", match: pathIs(/^\/v2\/activities\/templates$/), respond: () => Response.json({ templates: [] }) });
  route({ name: "posterior", match: (u, b) => pathIs(/^\/v2\/impulses\/resolve$/)(u) && b?.impulse?.pointer?.type === "thompson_posterior", respond: () => Response.json({ content: "" }) });
  route({ name: "run-goal", match: pathIs(/^\/run-goal$/), respond: () => Response.json({ ok: true, dispatchId: "lease-declare" }) });
}

async function reconcileBody(tag: string): Promise<Row> {
  const id = `ts-lease-declare-${tag}-${RUN}`;
  seed({ id, category: "trace_store_reconciliation", classification_metadata: {} });
  await tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, directed: true } as never));
  const hits = hitsOf("run-goal");
  expect(hits.length).toBe(1);
  return hits[0]!.body;
}

beforeEach(() => { beginPin(); routeTraceStore(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("trace-store-reconcile /run-goal declares the lease write", () => {
  it("[MUST-FAIL] the body declares maintenanceLease_write with the health report as the reach target", async () => {
    const body = await reconcileBody("decl");
    expect(body.targetTemplateId).toBe("development-vessel:trace-store-reconcile");
    expect(body.expected_output_shapes).toEqual(["maintenanceLease_write", "traceStoreHealthReport"]);
  });

  it("[MUST-FAIL] through the task door that body builds, acquire_lease and release_lease are not refused", async () => {
    const body = await reconcileBody("door");
    const refused = refusedByTask(body.expected_output_shapes);
    expect(refused["acquire_lease"]).toEqual([]);
    expect(refused["release_lease"]).toEqual([]);
    // Nothing else in the template is touched by the door either way.
    expect(refused["extract_lease_token"]).toEqual([]);
    expect(refused["reconcile"]).toEqual([]);
    expect(refused["verify"]).toEqual([]);
  });

  it("[CONTROL] the declaration admits nothing: the dispatch is still not a change", async () => {
    const body = await reconcileBody("noadmit");
    expect(callerDeclaresWrite(body.expected_output_shapes)).toBe(false);
  });
});

describe("[CONTROL] an undeclared body IS refused (the door is what skipped the lease)", () => {
  it("with no declaration the lease tasks are refused on maintenanceLease_write and nothing else is", () => {
    const refused = refusedByTask(undefined);
    expect(refused["acquire_lease"]).toEqual(["maintenanceLease_write"]);
    expect(refused["release_lease"]).toEqual(["maintenanceLease_write"]);
    expect(refused["extract_lease_token"]).toEqual([]);
    expect(refused["reconcile"]).toEqual([]);
    expect(refused["verify"]).toEqual([]);
  });

  it("declaring only the health report (the product the template advertises) still refuses the lease", () => {
    const refused = refusedByTask(["traceStoreHealthReport"]);
    expect(refused["acquire_lease"]).toEqual(["maintenanceLease_write"]);
    expect(refused["release_lease"]).toEqual(["maintenanceLease_write"]);
  });
});
