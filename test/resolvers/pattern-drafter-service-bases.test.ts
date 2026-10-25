/**
 * The pattern drafter's service bases come from discovery on every feeder.
 *
 * (1) draft-activity-from-pattern's prime_concepts fetched http://127.0.0.1:8260/concepts/search
 *     literally, and verify_outputs (convergent_validity_check) fell back to the same loopback. On a
 *     node without concept-db (role "store") task 3 died the way task 2 did. The template now reads
 *     {{concept_db_endpoint}}, the feeders pass the base discovery names for conceptGraph, and
 *     convergent_validity_check resolves it through discovery when its pointer does not carry one.
 * (2) vessel_arrival_scan dispatched the drafter with no activity_api_endpoint; it now passes the
 *     discovered one, as the trace scan does.
 * (3) vessel_gap_to_cluster passed an env/loopback activity_api_endpoint and no concept_db_endpoint;
 *     it now passes both discovered bases.
 *
 * Discovery is replaced through config's __setDiscoveryForTests (no module mock); fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../../src/config.js";
import { resolveTraceRecurringPatternScan } from "../../src/resolvers/trace-recurring-pattern-scan.js";
import { resolveVesselArrivalScan } from "../../src/resolvers/vessel-arrival-scan.js";
import { resolveConvergentValidityCheck } from "../../src/resolvers/convergent-validity-check.js";
import { resolveVesselGapToCluster } from "../../src/resolvers/vessel-gap-to-cluster.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE as TPL } from "../../src/seed/draft-activity-from-pattern.js";

const realFetch = globalThis.fetch;
const realDiscovery = config.discovery;
let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-service-bases-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  config.__setDiscoveryForTests(realDiscovery);
  await fs.rm(tmp, { recursive: true, force: true });
});

type Producer = { id: string; resolveEndpoint: string; origin?: string };
const PEER_AA: Producer = { id: "hub-aa", resolveEndpoint: "http://hub-host.test:18080/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" };
const PEER_CDB: Producer = { id: "hub-cdb", resolveEndpoint: "http://hub-host.test:18260/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" };
const LOCAL_AA: Producer = { id: "local-aa", resolveEndpoint: "http://127.0.0.1:8080/v2/impulses/resolve", origin: "local" };
const LOCAL_CDB: Producer = { id: "local-cdb", resolveEndpoint: "http://127.0.0.1:8260/v2/impulses/resolve", origin: "local" };
// development-vessel also serves `concept`; it must never be taken for concept-db.
const DV_CONCEPT: Producer = { id: "dv", resolveEndpoint: "http://127.0.0.1:8090/v2/impulses/resolve", origin: "local" };

function fakeDiscovery(byShape: Record<string, Producer[]>): void {
  const lookup = async (shape: string) => ({ ok: true as const, shape, producers: byShape[shape] ?? [], cached: false });
  config.__setDiscoveryForTests({ lookup, describe: () => "fake", failureBackoffMs: 0 } as unknown as Parameters<typeof config.__setDiscoveryForTests>[0]);
}
const hubOnly = () => fakeDiscovery({ activityTemplate: [PEER_AA], conceptGraph: [PEER_CDB], concept: [DV_CONCEPT, PEER_CDB] });
const allLocal = () => fakeDiscovery({ activityTemplate: [PEER_AA, LOCAL_AA], conceptGraph: [PEER_CDB, LOCAL_CDB], concept: [DV_CONCEPT, LOCAL_CDB] });

/** A task's URL as the engine fills it from the dispatched variables (template defaults otherwise). */
function taskUrl(taskId: string, vars: Record<string, string>): string {
  const task = TPL.tasks.find((t) => t.id === taskId)!;
  let url = (task.config as { url: string }).url;
  for (const v of TPL.variables ?? []) url = url.replace(`{{${v.name}}}`, vars[v.name] ?? String(v.default ?? ""));
  return url;
}

async function traceScanVars(): Promise<Record<string, string>> {
  let runGoal: Record<string, unknown> | undefined;
  const traces = [1, 2, 3, 4].map((n) => ({ execution_id: `e${n}`, activity_id: "real-composer", status: "success", output_impulse_shapes: ["alpha"] }));
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/v2/activities/execution-traces")) return new Response(JSON.stringify({ traces }), { status: 200 });
    if (u.includes("/run-goal")) { runGoal = JSON.parse(init?.body ?? "{}"); return new Response("{}", { status: 202 }); }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await resolveTraceRecurringPatternScan({ type: "trace_recurring_pattern_scan", apiKey: "k", metabobEndpoint: "http://trace-source.test", goalHostEndpoint: "http://goalhost.test", patternsDir: tmp, dispatch: true });
  return (runGoal?.["variables"] ?? {}) as Record<string, string>;
}

async function arrivalScanVars(): Promise<Record<string, string>> {
  let runGoal: Record<string, unknown> | undefined;
  let vessels: Array<{ vesselId: string; shapes?: string[] }> = [{ vesselId: "a" }];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.includes("/run-goal")) { runGoal = body; return new Response("{}", { status: 202 }); }
    if (u.endsWith("/resolve")) return new Response(JSON.stringify({ content: { vessels } }), { status: 200 });
    if (u.includes("/discover-by-shapes")) {
      return new Response(JSON.stringify(body.mode === "backward" ? { activities: [] } : { matched: false, emergence_class: "gap" }), { status: 200 });
    }
    if (u.includes("/execution-traces")) return new Response(JSON.stringify({ executions: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const ptr = {
    type: "vessel_arrival_scan" as const, apiKey: "k", snapshotPath: path.join(tmp, "snap.json"), scenariosDir: path.join(tmp, "scen"),
    patternsDir: path.join(tmp, "patterns"), goalHostEndpoint: "http://goalhost.test", metabobEndpoint: "http://trace-source.test",
    discoveryEndpoint: "http://disc.test", creditOnCharacterize: false,
  };
  await resolveVesselArrivalScan(ptr); // baseline: only vessel a
  vessels = [{ vesselId: "a" }, { vesselId: "b", shapes: ["x:orphan"] }];
  await resolveVesselArrivalScan(ptr); // b arrives with an unconsumed shape: cluster + dispatch
  return (runGoal?.["variables"] ?? {}) as Record<string, string>;
}

describe("(1) concept-db base for prime_concepts and verify_outputs", () => {
  test("MUST-FAIL: no local concept-db: the trace scan dispatch names the peer one and prime_concepts targets it", async () => {
    hubOnly();
    const vars = await traceScanVars();
    expect(vars["concept_db_endpoint"]).toBe("http://hub-host.test:18260");
    expect(taskUrl("prime_concepts", vars)).toBe("http://hub-host.test:18260/concepts/search?min_relevance=0.3&limit=15");
  });

  test("CONTROL: a local concept-db is still used, and development-vessel's concept shape is never taken for it", async () => {
    allLocal();
    const vars = await traceScanVars();
    expect(vars["concept_db_endpoint"]).toBe("http://127.0.0.1:8260");
    expect(taskUrl("prime_concepts", vars)).toBe("http://127.0.0.1:8260/concepts/search?min_relevance=0.3&limit=15");
  });

  test("MUST-FAIL: verify_outputs with its template config (placeholder unfilled) reads the discovered peer concept-db", async () => {
    hubOnly();
    const hits: string[] = [];
    globalThis.fetch = (async (url: string) => {
      hits.push(String(url));
      if (String(url).includes("/mcp/tools/call")) return new Response(JSON.stringify({ result: { edges: [] } }), { status: 200 });
      return new Response(JSON.stringify({ concepts: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const task = TPL.tasks.find((t) => t.id === "verify_outputs")!;
    await resolveConvergentValidityCheck(task.config as never);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.startsWith("http://hub-host.test:18260/"))).toBe(true);
  });

  test("CONTROL: an explicit concept_db_endpoint on the pointer is used as given", async () => {
    hubOnly();
    const hits: string[] = [];
    globalThis.fetch = (async (url: string) => { hits.push(String(url)); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await resolveConvergentValidityCheck({ type: "convergent_validity_check", produced_shapes: ["x"], concept_db_endpoint: "http://given.test:9" } as never);
    expect(hits[0]?.startsWith("http://given.test:9/")).toBe(true);
  });
});

describe("(2) vessel_arrival_scan's drafter dispatch carries the discovered activity-api", () => {
  test("MUST-FAIL: no local activity-api: the dispatch names the peer one and prime_vocabulary targets it", async () => {
    hubOnly();
    const vars = await arrivalScanVars();
    expect(vars["pattern_id"]).toBe("arrival-b");
    expect(vars["activity_api_endpoint"]).toBe("http://hub-host.test:18080");
    expect(taskUrl("prime_vocabulary", vars)).toBe("http://hub-host.test:18080/v2/activities/templates?limit=200");
    expect(vars["concept_db_endpoint"]).toBe("http://hub-host.test:18260");
  });

  test("CONTROL: a local activity-api is still used", async () => {
    allLocal();
    const vars = await arrivalScanVars();
    expect(vars["activity_api_endpoint"]).toBe("http://127.0.0.1:8080");
    expect(vars["patterns_dir"]).toBe(path.join(tmp, "patterns"));
  });
});

async function gapToClusterVars(): Promise<Record<string, string>> {
  let runGoal: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.includes("/run-goal")) { runGoal = body; return new Response("{}", { status: 202 }); }
    if (u.endsWith("/resolve") && body?.pointer?.type === "vesselRegistry") {
      return new Response(JSON.stringify({ content: { vessels: [{ vesselId: "v", shapes: ["x:shape"], endpoint: "http://v.test" }] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  // patternsDir is a tmp dir: the test never writes the live volume.
  await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "x:shape", apiKey: "k", patternsDir: path.join(tmp, "patterns"), metabobEndpoint: "http://trace-source.test", goalHostEndpoint: "http://goalhost.test", dispatch: true } as never);
  return (runGoal?.["variables"] ?? {}) as Record<string, string>;
}

describe("(3) vessel_gap_to_cluster's drafter dispatch carries both discovered bases", () => {
  test("MUST-FAIL: with only peer producers, the dispatch carries the peer activity-api and concept-db", async () => {
    hubOnly();
    const vars = await gapToClusterVars();
    expect(vars["patterns_dir"]).toBe(path.join(tmp, "patterns"));
    expect(vars["activity_api_endpoint"]).toBe("http://hub-host.test:18080");
    expect(vars["concept_db_endpoint"]).toBe("http://hub-host.test:18260");
    expect(taskUrl("prime_concepts", vars)).toBe("http://hub-host.test:18260/concepts/search?min_relevance=0.3&limit=15");
  });

  test("CONTROL: local producers are preferred", async () => {
    allLocal();
    const vars = await gapToClusterVars();
    expect(vars["activity_api_endpoint"]).toBe("http://127.0.0.1:8080");
    expect(vars["concept_db_endpoint"]).toBe("http://127.0.0.1:8260");
  });
});
