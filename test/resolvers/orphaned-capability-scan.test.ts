import { describe, it, expect, afterEach } from "bun:test";
import { resolveOrphanedCapabilityScan } from "../../src/resolvers/orphaned-capability-scan.js";

const originalFetch = globalThis.fetch;
import { mkdirSync } from "node:fs";

// HERMETIC WORKSPACE_ROOT. findCandidateConsumers — the second consumption surface added by
// 5693903 — shells out to `grep -rl` over ${WORKSPACE_ROOT}/repos. With the real repo present,
// every fixture shape has a "consumer" in some source file and is never classified an orphan,
// so these fixtures stopped describing the case they were written for. Point it at an empty
// tree so the fetch-mocked fixtures remain the only input to the classification.
const EMPTY_WS = "/tmp/ocs-empty-ws";
mkdirSync(`${EMPTY_WS}/repos`, { recursive: true });
process.env.WORKSPACE_ROOT = EMPTY_WS;

afterEach(() => { globalThis.fetch = originalFetch; });

function mockRouter(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// Discovery advertises an outward capability (problem_detection), an internal
// observer (concept_db_health_observer), and an invoked resolver (fs_read).
// Templates invoke only fs_read + json_path_extract.
function wireSubstrate(opts: {
  liveShapes: string[];
  templates: any[];
  onEmit: (body: any) => void;
}) {
  mockRouter([
    (url) => url.includes("/registry/shapes")
      ? new Response(JSON.stringify({ shapes: opts.liveShapes }), { status: 200 }) : null,
    // Single page: full corpus at offset=0, empty afterwards (mirrors the
    // endpoint's 100/page pagination so the resolver's offset loop terminates).
    (url) => {
      if (!url.includes("/v2/activities/templates")) return null;
      const off = Number(new URL(url, "http://x").searchParams.get("offset") ?? "0");
      const templates = off === 0 ? opts.templates : [];
      return new Response(JSON.stringify({ templates, total: opts.templates.length }), { status: 200 });
    },
    (url, init) => url.endsWith("/v2/impulses/resolve")
      ? (opts.onEmit(JSON.parse(init?.body as string)), new Response("{}", { status: 200 })) : null,
  ]);
}

const TEMPLATES = [
  { tasks: [{ resolver: "fs_read" }, { resolver: "json_path_extract" }] },
];

describe("orphaned_capability_scan", () => {
  it("emits an orphaned_capability gap for a live, never-invoked outward capability", async () => {
    const emits: any[] = [];
    wireSubstrate({
      liveShapes: ["problem_detection", "fs_read", "json_path_extract", "concept_db_health_observer"],
      templates: TEMPLATES,
      onEmit: (b) => emits.push(b),
    });
    const r = await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan" });
    const body = r.body as any;
    expect(r.shape).toBe("orphanedCapabilityReport");
    expect(body.degraded).toBe(false);
    // problem_detection is the only outward orphan (fs_read/json_path_extract are
    // invoked; concept_db_health_observer is internal-machinery and filtered out).
    expect(body.capability_orphans).toContain("problem_detection");
    expect(body.capability_orphans).not.toContain("fs_read");
    expect(body.capability_orphans).not.toContain("concept_db_health_observer");
    expect(body.gaps_emitted).toBe(1);
    const _w = emits.filter((e: any) => e.impulse.pointer.type === "substrateGap_write");
    expect(_w.length).toBe(1);
    expect(_w[0].impulse.pointer.gap.category).toBe("orphaned_capability");
    expect(_w[0].impulse.pointer.gap.id).toBe("orphaned-capability-problem_detection");
  });

  it("does not emit for an invoked resolver", async () => {
    const emits: any[] = [];
    wireSubstrate({
      liveShapes: ["fs_read", "json_path_extract"],
      templates: TEMPLATES,
      onEmit: (b) => emits.push(b),
    });
    const r = await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan" });
    const body = r.body as any;
    expect(body.capability_orphan_count).toBe(0);
    expect(body.gaps_emitted).toBe(0);
    expect(emits.filter((e: any) => e.impulse.pointer.type === "substrateGap_write").length).toBe(0);
  });

  it("uses a stable id so re-running upserts rather than duplicating", async () => {
    const run = async () => {
      const emits: any[] = [];
      wireSubstrate({
        liveShapes: ["problem_detection", "fs_read"],
        templates: TEMPLATES,
        onEmit: (b) => emits.push(b),
      });
      await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan" });
      return emits;
    };
    const a = await run();
    const b = await run();
    expect(a[0].impulse.pointer.gap.id).toBe(b[0].impulse.pointer.gap.id);
  });

  it("classify-only mode (emit_gaps:false) reports orphans without emitting", async () => {
    const emits: any[] = [];
    wireSubstrate({
      liveShapes: ["problem_detection", "fs_read"],
      templates: TEMPLATES,
      onEmit: (b) => emits.push(b),
    });
    const r = await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan", emit_gaps: false });
    const body = r.body as any;
    expect(body.capability_orphans).toContain("problem_detection");
    expect(body.gaps_emitted).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("does not storm when discovery/templates come back empty (degraded guard)", async () => {
    const emits: any[] = [];
    wireSubstrate({ liveShapes: ["problem_detection"], templates: [], onEmit: (b) => emits.push(b) });
    const r = await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan" });
    const body = r.body as any;
    expect(body.degraded).toBe(true); // invoked.size === 0
    expect(body.gaps_emitted).toBe(0);
    expect(emits.length).toBe(0);
  });

  it("respects max_emit cap", async () => {
    const emits: any[] = [];
    wireSubstrate({
      liveShapes: ["problem_detection", "code_quality", "concept", "git_status", "fs_read"],
      templates: TEMPLATES,
      onEmit: (b) => emits.push(b),
    });
    const r = await resolveOrphanedCapabilityScan({ type: "orphaned_capability_scan", max_emit: 2 });
    const body = r.body as any;
    expect(body.capability_orphan_count).toBe(4); // all but fs_read
    expect(body.gaps_emitted).toBe(2); // capped
  });
});
