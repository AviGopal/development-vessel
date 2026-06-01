import { describe, it, expect } from "bun:test";
import {
  parseSystemctlShow,
  resolveServiceOomCascadeScan,
} from "../../src/resolvers/service-oom-cascade-scan.js";

interface CacheRow {
  NRestarts: number;
  MemoryCurrent: number;
  scannedAt: string;
}

type CacheMap = Record<string, CacheRow>;

interface PostRecord {
  url: string;
  body: unknown;
}

function makePorts(opts: {
  systemctlOutputs: Record<string, string | null>;
  initialCache?: CacheMap;
  postOk?: boolean;
  postStatus?: number;
}) {
  const initialCache = opts.initialCache ?? {};
  const cacheStore: { current: CacheMap } = { current: { ...initialCache } };
  const writes: Array<{ path: string; data: CacheMap }> = [];
  const posts: PostRecord[] = [];

  return {
    ports: {
      systemctlShow: async (unit: string) =>
        opts.systemctlOutputs[unit] ?? null,
      readCache: async (_path: string) => cacheStore.current,
      writeCache: async (path: string, data: CacheMap) => {
        cacheStore.current = data;
        writes.push({ path, data });
      },
      postGap: async (url: string, body: unknown) => {
        posts.push({ url, body });
        const ok = opts.postOk !== false;
        const status = opts.postStatus ?? 200;
        return { ok, status };
      },
    },
    writes,
    posts,
    cacheStore,
  };
}

const SAMPLE_OK = [
  "ActiveEnterTimestamp=Sat 2026-05-31 12:00:00 UTC",
  "MemoryCurrent=1073741824",
  "NRestarts=0",
  "",
].join("\n");

const SAMPLE_HIGH_MEM = [
  "ActiveEnterTimestamp=Sat 2026-05-31 11:00:00 UTC",
  "MemoryCurrent=5368709120", // 5 GB > 4 GB threshold
  "NRestarts=1",
  "",
].join("\n");

const SAMPLE_RAPID_RESTART_NOW = [
  "ActiveEnterTimestamp=Sat 2026-05-31 12:30:00 UTC",
  "MemoryCurrent=536870912", // 512 MB
  "NRestarts=10",
  "",
].join("\n");

const SAMPLE_NOT_SET = [
  "ActiveEnterTimestamp=Sat 2026-05-31 12:00:00 UTC",
  "MemoryCurrent=[not set]",
  "NRestarts=0",
  "",
].join("\n");

describe("parseSystemctlShow", () => {
  it("parses MemoryCurrent + NRestarts + ActiveEnterTimestamp", () => {
    const parsed = parseSystemctlShow(SAMPLE_HIGH_MEM);
    expect(parsed.MemoryCurrent).toBe(5368709120);
    expect(parsed.NRestarts).toBe(1);
    expect(parsed.ActiveEnterTimestamp).toBe(
      "Sat 2026-05-31 11:00:00 UTC",
    );
  });

  it("treats [not set] as null memory (systemd sentinel)", () => {
    const parsed = parseSystemctlShow(SAMPLE_NOT_SET);
    expect(parsed.MemoryCurrent).toBeNull();
    expect(parsed.NRestarts).toBe(0);
  });

  it("treats unbounded u64 max as null memory", () => {
    const parsed = parseSystemctlShow(
      "MemoryCurrent=18446744073709551615\nNRestarts=2\n",
    );
    expect(parsed.MemoryCurrent).toBeNull();
    expect(parsed.NRestarts).toBe(2);
  });

  it("ignores blank and malformed lines", () => {
    const parsed = parseSystemctlShow("\n\nNRestarts=5\nGarbageNoEq\n");
    expect(parsed.NRestarts).toBe(5);
    expect(parsed.MemoryCurrent).toBeNull();
  });
});

describe("resolveServiceOomCascadeScan", () => {
  it("above-threshold service: absolute memory triggers a finding + POST", async () => {
    const { ports, posts } = makePorts({
      systemctlOutputs: { "goal-host-vessel": SAMPLE_HIGH_MEM },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["goal-host-vessel"],
        devVesselImpulsesUrl: "http://test/v2/impulses/resolve",
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    expect(result.shape).toBe("serviceOomReport");
    const body = result.body as {
      scanned: number;
      services_with_findings: number;
      emitted: number;
      findings: Array<{
        service: string;
        reasons: string[];
        memoryMB: number | null;
        posted: boolean;
        post_status?: number;
      }>;
    };
    expect(body.scanned).toBe(1);
    expect(body.services_with_findings).toBe(1);
    expect(body.emitted).toBe(1);
    expect(body.findings[0]!.service).toBe("goal-host-vessel");
    expect(body.findings[0]!.reasons.some((r) => r.startsWith("memory_absolute"))).toBe(true);
    expect(body.findings[0]!.posted).toBe(true);
    expect(body.findings[0]!.post_status).toBe(200);

    // POSTed body has the expected substrateGap_write shape.
    expect(posts).toHaveLength(1);
    const sent = posts[0]!.body as {
      impulse: {
        pointer: {
          type: string;
          gap: {
            id: string;
            category: string;
            classification_metadata: {
              gap_subtype: string;
              service: string;
              reasons: string[];
              fix_priors: string[];
            };
          };
        };
      };
    };
    expect(sent.impulse.pointer.type).toBe("substrateGap_write");
    expect(sent.impulse.pointer.gap.id).toContain(
      "service-oom-cascade-goal-host-vessel-",
    );
    expect(sent.impulse.pointer.gap.classification_metadata.gap_subtype).toBe(
      "service_oom_cascade",
    );
    expect(sent.impulse.pointer.gap.classification_metadata.service).toBe(
      "goal-host-vessel",
    );
    expect(
      sent.impulse.pointer.gap.classification_metadata.fix_priors,
    ).toContain("concept_RYl73llSCGfc");
  });

  it("below-threshold service: no finding, no POST", async () => {
    const { ports, posts } = makePorts({
      systemctlOutputs: { "goal-host-vessel": SAMPLE_OK },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["goal-host-vessel"],
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as {
      scanned: number;
      services_with_findings: number;
      emitted: number;
    };
    expect(body.scanned).toBe(1);
    expect(body.services_with_findings).toBe(0);
    expect(body.emitted).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it("first run (empty cache): no false-positive on delta thresholds", async () => {
    // Memory is 1 GB (below absolute 4 GB) and there is no prior baseline.
    // Even though MemoryCurrent looks "high" relative to nothing, no delta
    // can be computed and no false-positive should fire.
    const { ports, posts, cacheStore } = makePorts({
      systemctlOutputs: { "concept-db": SAMPLE_OK },
    });
    expect(cacheStore.current).toEqual({});
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["concept-db"],
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as { services_with_findings: number };
    expect(body.services_with_findings).toBe(0);
    expect(posts).toHaveLength(0);
    // But cache must be updated for the next run.
    expect(cacheStore.current["concept-db"]).toBeDefined();
    expect(cacheStore.current["concept-db"]!.NRestarts).toBe(0);
    expect(cacheStore.current["concept-db"]!.MemoryCurrent).toBe(1073741824);
  });

  it("rapid-restart delta triggers a finding when prior baseline exists", async () => {
    const { ports } = makePorts({
      systemctlOutputs: { "goal-host-vessel": SAMPLE_RAPID_RESTART_NOW },
      initialCache: {
        "goal-host-vessel": {
          NRestarts: 1,
          MemoryCurrent: 536870912,
          scannedAt: "2026-05-31T11:00:00.000Z",
        },
      },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["goal-host-vessel"],
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as {
      findings: Array<{
        service: string;
        reasons: string[];
        restartsSinceLast: number | null;
      }>;
    };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]!.restartsSinceLast).toBe(9);
    expect(
      body.findings[0]!.reasons.some((r) => r.startsWith("restarts_since_last")),
    ).toBe(true);
  });

  it("memory-delta threshold triggers when prior baseline exists", async () => {
    // Prior 100 MB, current 700 MB => delta 600 MB > 500 MB threshold,
    // absolute 700 MB still below 4 GB.
    const currentOutput = [
      "ActiveEnterTimestamp=Sat 2026-05-31 12:00:00 UTC",
      "MemoryCurrent=734003200",
      "NRestarts=0",
      "",
    ].join("\n");
    const { ports } = makePorts({
      systemctlOutputs: { "activity-api": currentOutput },
      initialCache: {
        "activity-api": {
          NRestarts: 0,
          MemoryCurrent: 104857600,
          scannedAt: "2026-05-31T11:00:00.000Z",
        },
      },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["activity-api"],
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as {
      findings: Array<{ service: string; reasons: string[]; deltaMB: number | null }>;
    };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]!.deltaMB).toBeGreaterThan(500);
    expect(
      body.findings[0]!.reasons.some((r) => r.startsWith("memory_delta")),
    ).toBe(true);
  });

  it("dry_run=true skips POST but still computes findings + updates cache", async () => {
    const { ports, posts, cacheStore } = makePorts({
      systemctlOutputs: { "goal-host-vessel": SAMPLE_HIGH_MEM },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["goal-host-vessel"],
        dry_run: true,
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as {
      services_with_findings: number;
      emitted: number;
      dry_run: boolean;
      findings: Array<{ posted: boolean }>;
    };
    expect(body.services_with_findings).toBe(1);
    expect(body.emitted).toBe(0);
    expect(body.dry_run).toBe(true);
    expect(body.findings[0]!.posted).toBe(false);
    expect(posts).toHaveLength(0);
    // Cache still advances even in dry_run.
    expect(cacheStore.current["goal-host-vessel"]).toBeDefined();
  });

  it("systemctl probe failure: counted, not crashed", async () => {
    const { ports, posts } = makePorts({
      systemctlOutputs: {
        "goal-host-vessel": null,
        "activity-api": SAMPLE_OK,
      },
    });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services: ["goal-host-vessel", "activity-api"],
        statePath: "/tmp/test-state.json",
      },
      ports,
    );
    const body = result.body as {
      scanned: number;
      probe_failures: number;
      services_with_findings: number;
    };
    expect(body.scanned).toBe(1);
    expect(body.probe_failures).toBe(1);
    expect(body.services_with_findings).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it("respects maxEmits cap", async () => {
    const services = ["svc-a", "svc-b", "svc-c", "svc-d", "svc-e"];
    const outputs: Record<string, string> = {};
    for (const s of services) outputs[s] = SAMPLE_HIGH_MEM;
    const { ports, posts } = makePorts({ systemctlOutputs: outputs });
    const result = await resolveServiceOomCascadeScan(
      {
        type: "service_oom_cascade_scan",
        services,
        statePath: "/tmp/test-state.json",
        maxEmits: 2,
      },
      ports,
    );
    const body = result.body as {
      services_with_findings: number;
      emitted: number;
      findings: unknown[];
    };
    // All 5 cross the absolute threshold, but only 2 are emitted.
    expect(body.services_with_findings).toBe(5);
    expect(body.findings).toHaveLength(2);
    expect(body.emitted).toBe(2);
    expect(posts).toHaveLength(2);
  });
});
