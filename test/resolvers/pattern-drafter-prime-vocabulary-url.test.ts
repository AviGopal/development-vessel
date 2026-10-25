/**
 * draft-activity-from-pattern never fetches a baked loopback base.
 *
 * A drafter run fetched http://127.0.0.1:8080/v2/activities/templates?limit=200 at prime_vocabulary
 * and died "Unable to connect". The url is templated on {{activity_api_endpoint}}; the literal is
 * that variable's default, which applies whenever a feeder dispatches without the field. These pins
 * hold both halves: (a) no http_fetch task in the template bakes a base (every url starts with a
 * declared variable), and (b) vessel_gap_to_cluster's dispatch, with only a peer activity-api in
 * discovery, fills prime_vocabulary with the peer base (the trace and arrival scans are pinned in
 * pattern-drafter-dispatch-endpoint and pattern-drafter-service-bases).
 *
 * Discovery is replaced through config's __setDiscoveryForTests (no module mock); fetch is stubbed,
 * and the cluster is written to a tmp patternsDir, so nothing leaves the process or the tmp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as config from "../../src/config.js";
import { resolveVesselGapToCluster } from "../../src/resolvers/vessel-gap-to-cluster.js";
import { DRAFT_ACTIVITY_FROM_PATTERN_TEMPLATE as TPL } from "../../src/seed/draft-activity-from-pattern.js";

const realFetch = globalThis.fetch;
const realDiscovery = config.discovery;
let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-prime-vocabulary-url-"));
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  config.__setDiscoveryForTests(realDiscovery);
  await fs.rm(tmp, { recursive: true, force: true });
});

type Producer = { id: string; resolveEndpoint: string; origin?: string };
const PEER_AA: Producer = { id: "hub-aa", resolveEndpoint: "http://hub-host.test:18080/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" };
const PEER_CDB: Producer = { id: "hub-cdb", resolveEndpoint: "http://hub-host.test:18260/v2/impulses/resolve", origin: "peer:http://hub-host.test:18100" };
function hubOnly(): void {
  const byShape: Record<string, Producer[]> = { activityTemplate: [PEER_AA], conceptGraph: [PEER_CDB], concept: [PEER_CDB] };
  const lookup = async (shape: string) => ({ ok: true as const, shape, producers: byShape[shape] ?? [], cached: false });
  config.__setDiscoveryForTests({ lookup, describe: () => "fake", failureBackoffMs: 0 } as unknown as Parameters<typeof config.__setDiscoveryForTests>[0]);
}

const httpTasks = () => TPL.tasks.filter((t) => (t.config as { type?: string } | undefined)?.type === "http_fetch");

/** The prime_vocabulary URL as the engine fills it from the dispatched variables (template defaults otherwise). */
function primeVocabularyUrl(vars: Record<string, string>): string {
  let url = (TPL.tasks.find((t) => t.id === "prime_vocabulary")!.config as { url: string }).url;
  for (const v of TPL.variables ?? []) url = url.replace(`{{${v.name}}}`, vars[v.name] ?? String(v.default ?? ""));
  return url;
}

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
  await resolveVesselGapToCluster({ type: "vessel_gap_to_cluster", shape: "x:shape", apiKey: "k", patternsDir: path.join(tmp, "patterns"), metabobEndpoint: "http://trace-source.test", goalHostEndpoint: "http://goalhost.test", dispatch: true } as never);
  return (runGoal?.["variables"] ?? {}) as Record<string, string>;
}

describe("draft-activity-from-pattern's fetch bases", () => {
  test("MUST-FAIL: no http_fetch task bakes a base; every url starts with a declared variable", () => {
    const declared = new Set((TPL.variables ?? []).map((v) => v.name));
    const tasks = httpTasks();
    expect(tasks.map((t) => t.id)).toContain("prime_vocabulary");
    for (const t of tasks) {
      const url = String((t.config as { url?: unknown }).url ?? "");
      const lead = /^\{\{([A-Za-z0-9_]+)\}\}\//.exec(url)?.[1];
      expect({ task: t.id, lead: lead && declared.has(lead) ? lead : url }).toEqual({ task: t.id, lead: lead ?? "<none>" });
      expect(url).not.toMatch(/^https?:\/\//);
    }
  });

  test("MUST-FAIL: with only a peer activity-api, vessel_gap_to_cluster's dispatch fills prime_vocabulary with the peer base", async () => {
    hubOnly();
    const vars = await gapToClusterVars();
    expect(vars["activity_api_endpoint"]).toBe("http://hub-host.test:18080");
    expect(primeVocabularyUrl(vars)).toBe("http://hub-host.test:18080/v2/activities/templates?limit=200");
  });

  test("CONTROL: a dispatch that carries no activity_api_endpoint still gets the template default, unchanged", () => {
    expect((TPL.tasks.find((t) => t.id === "prime_vocabulary")!.config as { url: string }).url).toBe("{{activity_api_endpoint}}/v2/activities/templates?limit=200");
    expect(primeVocabularyUrl({ pattern_id: "p" })).toBe("http://127.0.0.1:8080/v2/activities/templates?limit=200");
  });
});
