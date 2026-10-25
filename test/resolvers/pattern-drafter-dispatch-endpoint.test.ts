/**
 * The pattern feeders hand draft-activity-from-pattern what its tasks need on any profile.
 *
 * (a) trace_recurring_pattern_scan dispatched the drafter with no activity_api_endpoint, so the
 *     drafter's prime_vocabulary task fetched its default http://127.0.0.1:8080 and died on a node
 *     with no local activity-api, right after load_cluster. The dispatch now carries the endpoint
 *     discovery names for activityTemplate (a local producer first, else an http peer row).
 * (b) vessel_gap_to_cluster wrote its clusters under WORKSPACE_ROOT/patterns (the super-repo clone),
 *     a second pattern dir beside the volume one; it now writes PATTERNS_DIR like the other writers.
 *
 * Discovery is replaced through config's __setDiscoveryForTests (no module mock); fetch is stubbed
 * for the trace read and the goal-host dispatch, so nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../../src/config.js";
import { resolveTraceRecurringPatternScan } from "../../src/resolvers/trace-recurring-pattern-scan.js";
import * as gapToCluster from "../../src/resolvers/vessel-gap-to-cluster.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE } from "../../src/seed/draft-activity-from-pattern.js";

const realFetch = globalThis.fetch;
const realDiscovery = config.discovery;
let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-dispatch-endpoint-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  config.__setDiscoveryForTests(realDiscovery);
  await fs.rm(tmp, { recursive: true, force: true });
});

type Producer = { id: string; resolveEndpoint: string; origin?: string };
function fakeDiscovery(producers: Producer[] | "unreadable"): void {
  const lookup = async (shape: string) =>
    producers === "unreadable"
      ? { ok: false as const, shape, reason: "network" as const, detail: "down", cached: false }
      : { ok: true as const, shape, producers: shape === "activityTemplate" ? producers : [], cached: false };
  config.__setDiscoveryForTests({ lookup, describe: () => "fake", failureBackoffMs: 0 } as unknown as Parameters<typeof config.__setDiscoveryForTests>[0]);
}

/** Stub the trace read (4 recurrent successes) and capture the /run-goal dispatch body. */
function stubFetch(): Array<{ url: string; body: Record<string, unknown> | undefined }> {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const traces = [1, 2, 3, 4].map((n) => ({ execution_id: `e${n}`, activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha"] }));
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.includes("/v2/activities/execution-traces")) return new Response(JSON.stringify({ traces }), { status: 200 });
    if (u.includes("/run-goal")) return new Response(JSON.stringify({ status: "queued" }), { status: 202 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

async function dispatchedVariables(): Promise<Record<string, string>> {
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
  const d = calls.find((c) => c.url.includes("/run-goal"));
  return (d?.body?.["variables"] ?? {}) as Record<string, string>;
}

/** The drafter's prime_vocabulary URL as the engine fills it from the dispatched variables. */
function primeVocabularyUrl(vars: Record<string, string>): string {
  const task = DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE.tasks.find((t) => t.id === "prime_vocabulary")!;
  const def = DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE.variables!.find((v) => v.name === "activity_api_endpoint")!.default as string;
  return (task.config as { url: string }).url.replace("{{activity_api_endpoint}}", vars["activity_api_endpoint"] ?? def);
}

describe("(a) the trace scan's drafter dispatch carries the discovered activity-api", () => {
  test("MUST-FAIL: no local activity-api: the dispatch names the peer one and prime_vocabulary targets it", async () => {
    fakeDiscovery([
      { id: "overlay-aa", resolveEndpoint: "libp2p://peer/aa", origin: "overlay" },
      { id: "hub-aa", resolveEndpoint: "http://hub-host.test:18080/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" },
    ]);
    const vars = await dispatchedVariables();
    expect(vars["activity_api_endpoint"]).toBe("http://hub-host.test:18080");
    expect(primeVocabularyUrl(vars)).toBe("http://hub-host.test:18080/v2/activities/templates?limit=200");
  });

  test("CONTROL: a local activity-api is still the one used, ahead of any peer", async () => {
    fakeDiscovery([
      { id: "hub-aa", resolveEndpoint: "http://hub-host.test:18080/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" },
      { id: "local-aa", resolveEndpoint: "http://127.0.0.1:8080/v2/impulses/resolve", origin: "local" },
    ]);
    const vars = await dispatchedVariables();
    expect(vars["activity_api_endpoint"]).toBe("http://127.0.0.1:8080");
    expect(primeVocabularyUrl(vars)).toBe("http://127.0.0.1:8080/v2/activities/templates?limit=200");
  });

  test("an unreadable lookup falls back to the activity-api the scan read its traces from", async () => {
    fakeDiscovery("unreadable");
    const vars = await dispatchedVariables();
    expect(vars["activity_api_endpoint"]).toBe("http://trace-source.test");
  });

  test("the dispatch still names the pattern and its dir", async () => {
    fakeDiscovery([{ id: "local-aa", resolveEndpoint: "http://127.0.0.1:8080/v2/impulses/resolve", origin: "local" }]);
    const vars = await dispatchedVariables();
    expect(vars["patterns_dir"]).toBe(tmp);
    expect(vars["pattern_id"]).toMatch(/^trace-pattern-/);
  });
});

describe("(b) vessel_gap_to_cluster writes the volume pattern dir", () => {
  test("MUST-FAIL: its default pattern dir is PATTERNS_DIR under VOLUME_ROOT, not WORKSPACE_ROOT", () => {
    const dir = (gapToCluster as Record<string, unknown>)["DEFAULT_PATTERNS_DIR"];
    expect(dir).toBe(`${config.VOLUME_ROOT}/patterns`);
    expect(dir).toBe(config.PATTERNS_DIR);
  });

  test("CONTROL: the fs_read guard reads that dir, and the drafter's own default is the same dir", () => {
    expect(config.VOLUME_RUNTIME_READ_DIRS).toContain(config.PATTERNS_DIR);
    const def = DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE.variables!.find((v) => v.name === "patterns_dir")!.default;
    expect(def).toBe(config.PATTERNS_DIR);
  });
});
