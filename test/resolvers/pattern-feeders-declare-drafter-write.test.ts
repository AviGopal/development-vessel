/**
 * Every pattern feeder's drafter dispatch declares the drafter's write, so goal-host admits it as a change.
 *
 * draft-activity-from-pattern's register_variant (activity_create_variant) was skipped on every run: goal-host's
 * write door hands the executor a task-level door, and on a dispatch not admitted as a change a task that writes is
 * skipped before it runs ("[write-door] ias dropped task activity_create_variant (dispatch not admitted)"). A
 * dispatch is admitted only when the caller declares a write shape in its /run-goal expected_output_shapes, and the
 * three feeders declared nothing. They now declare activity_create_variant.
 *
 * The door predicate below is a PINNED COPY of goal-host src/write-door.ts (isWriteShape over FS_WRITE_SHAPES and
 * CHANGE_PRIMITIVE_SHAPES, from src/fs-write-shapes.ts and src/write-door.ts at 2843dd53) with the user's ruling
 * "Drop the exclusion" applied: callerDeclaresWrite is `declared.some((s) => isWriteShape(s))`, no longer
 * skipping activity_create_variant. The commit is effective only once goal-host's door carries that change.
 *
 * Discovery is replaced through config's __setDiscoveryForTests and fetch is stubbed, so nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../../src/config.js";
import { resolveTraceRecurringPatternScan } from "../../src/resolvers/trace-recurring-pattern-scan.js";
import { resolveVesselGapToCluster } from "../../src/resolvers/vessel-gap-to-cluster.js";
import { DETECT_RECURRING_PATTERN_TEMPLATE } from "../../src/seed/detect-recurring-pattern.js";

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
const isWriteShape = (s: unknown): boolean => typeof s === "string" && (FS_WRITE_SHAPES.has(s) || CHANGE_PRIMITIVE_SHAPES.has(s));
/** callerDeclaresWrite after the ruling. */
const admitted = (declared: unknown): boolean => Array.isArray(declared) && declared.some((s) => isWriteShape(s));
/** callerDeclaresWrite before it (2843dd53), kept to show the door change is what makes the declaration count. */
const admittedBeforeRuling = (declared: unknown): boolean =>
  Array.isArray(declared) && declared.some((s) => s !== "activity_create_variant" && isWriteShape(s));

const realFetch = globalThis.fetch;
const realDiscovery = config.discovery;
let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "feeders-declare-write-"));
  const lookup = async (shape: string) => ({ ok: true as const, shape, producers: [], cached: false });
  config.__setDiscoveryForTests({ lookup, describe: () => "fake", failureBackoffMs: 0 } as unknown as Parameters<typeof config.__setDiscoveryForTests>[0]);
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  config.__setDiscoveryForTests(realDiscovery);
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Stub every fetch; answer the reads each feeder makes and capture the /run-goal body. */
function stubFetch(): Array<{ url: string; body: Record<string, unknown> | undefined }> {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const traces = [1, 2, 3, 4].map((n) => ({ execution_id: `e${n}`, activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha"] }));
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, body });
    if (u.includes("/v2/activities/execution-traces")) return new Response(JSON.stringify({ traces }), { status: 200 });
    if (u.endsWith("/resolve") && body?.pointer?.type === "vesselRegistry") {
      return new Response(JSON.stringify({ content: { vessels: [{ vesselId: "v", shapes: ["x:shape"], endpoint: "http://v" }] } }), { status: 200 });
    }
    if (u.includes("/run-goal")) return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

async function traceScanBody(): Promise<Record<string, unknown>> {
  const calls = stubFetch();
  const r = await resolveTraceRecurringPatternScan({
    type: "trace_recurring_pattern_scan",
    apiKey: "test-key",
    metabobEndpoint: "http://trace-source.test",
    goalHostEndpoint: "http://goalhost.test",
    patternsDir: tmp,
    dispatch: true,
  });
  expect((r.body as Record<string, unknown>).dispatched_to_author).toBe(true);
  return calls.find((c) => c.url.includes("/run-goal"))!.body!;
}

async function gapToClusterBody(): Promise<Record<string, unknown>> {
  const calls = stubFetch();
  const r = await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "x:shape", apiKey: "k", patternsDir: tmp, dispatch: true });
  expect((r.body as Record<string, unknown>).dispatched_to_author).toBe(true);
  return calls.find((c) => c.url.includes("/run-goal"))!.body!;
}

function detectSeedBody(): Record<string, unknown> {
  const task = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find((t) => t.id === "dispatch_drafter")!;
  return JSON.parse((task.config as { body: string }).body) as Record<string, unknown>;
}

const feeders: Array<[string, () => Promise<Record<string, unknown>> | Record<string, unknown>]> = [
  ["trace_recurring_pattern_scan", traceScanBody],
  ["vessel_gap_to_cluster", gapToClusterBody],
  ["detect-recurring-pattern dispatch_drafter", detectSeedBody],
];

describe("each pattern feeder's drafter dispatch declares activity_create_variant", () => {
  for (const [name, body] of feeders) {
    test(`MUST-FAIL: ${name}: the body declares the write and the door admits it`, async () => {
      const b = await body();
      expect(b["expected_output_shapes"]).toEqual(["activity_create_variant"]);
      expect(admitted(b["expected_output_shapes"])).toBe(true);
    });

    test(`CONTROL: ${name}: the other body fields are unchanged`, async () => {
      const b = await body();
      expect(Object.keys(b).filter((k) => k !== "expected_output_shapes").sort()).toEqual(["goal", "targetTemplateId", "variables"]);
      expect(typeof b["goal"]).toBe("string");
      expect(String(b["targetTemplateId"])).toMatch(/draft-activity-from-pattern|\{\{drafter_template_id\}\}/);
      const vars = b["variables"] as Record<string, unknown>;
      expect(vars["pattern_id"]).toBeDefined();
      expect(vars["patterns_dir"]).toBeDefined();
      expect(typeof vars["source"]).toBe("string");
    });
  }
});

describe("CONTROL: the door still refuses what is not declared", () => {
  test("a dispatch without the declaration is not admitted", () => {
    expect(admitted(undefined)).toBe(false);
    expect(admitted([])).toBe(false);
    expect(admitted(["activityTemplateVariant", "authoredActivityCandidate"])).toBe(false);
  });

  test("before the ruling, declaring activity_create_variant alone admitted nothing (the goal-host change is required)", () => {
    expect(admittedBeforeRuling(["activity_create_variant"])).toBe(false);
    expect(admitted(["activity_create_variant"])).toBe(true);
  });
});
