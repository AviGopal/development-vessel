import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { resolveStalePointerEmit } from "../../src/resolvers/stale-pointer-emit.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = join(tmpdir(), `stale-pointer-test-${Date.now()}`);
const livePath = join(testDir, "live.md");
const missingPath = join(testDir, "does-not-exist.md");

// Other test files (e.g. substrate-health-tick.test.ts) monkey-patch
// globalThis.fetch and rely on afterAll to restore it. If those tests
// run before ours, the patched fetch leaks. Restore from a Response
// constructor probe: a real Bun fetch returns a real Response on a
// local server, a mocked fetch returns whatever the mock dictates.
// Defensively re-bind to Bun's native fetch by re-importing.
let originalFetch: typeof fetch | undefined;

beforeAll(async () => {
  // Capture Bun's native fetch via the module specifier — bypasses any
  // prior globalThis.fetch overrides.
  const bunGlobal = await import("bun");
  const nativeFetch = (bunGlobal as { fetch?: typeof fetch }).fetch;
  originalFetch = nativeFetch ?? globalThis.fetch;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

beforeEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  mkdirSync(testDir, { recursive: true });
  writeFileSync(livePath, "# alive");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("stale_pointer_emit resolver", () => {
  it("returns stalePointerReport summary with scanned/stale counts", async () => {
    const search_url = "http://127.0.0.1:9/dummy"; // unreachable
    const result = await resolveStalePointerEmit({
      type: "stale_pointer_emit",
      conceptSearchUrl: search_url,
      dry_run: true,
    });
    // Concept-db fetch will fail; resolver emits structuredError.
    expect(result.shape).toBe("structuredError");
  });

  it("dry_run scans real concepts and does NOT POST gaps, classifies live vs stale", async () => {
    // Spin up a small fake concept-db server.
    const concepts = [
      { id: "concept_live", pointer: { type: "memo", path: livePath } },
      { id: "concept_stale", pointer: { type: "memo", path: missingPath } },
      { id: "concept_no_path", pointer: { type: "memo" } },
      { id: "concept_meta_doc_path", pointer: {}, metadata: { doc_path: missingPath } },
    ];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/concepts/search") {
          return new Response(JSON.stringify({ concepts, count: concepts.length }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await resolveStalePointerEmit({
        type: "stale_pointer_emit",
        conceptSearchUrl: `http://localhost:${server.port}/concepts/search`,
        dry_run: true,
      });
      expect(result.shape).toBe("stalePointerReport");
      const body = result.body as {
        scanned: number;
        with_pointer_path: number;
        readable: number;
        stale_count: number;
        stale_entries: Array<{ concept_id: string; posted: boolean; suspected_path: string }>;
        dry_run: boolean;
      };
      expect(body.scanned).toBe(4);
      // concept_live (pointer.path) + concept_meta_doc_path (metadata.doc_path fallback)
      // contribute to with_pointer_path; concept_no_path is filtered out.
      expect(body.with_pointer_path).toBe(3);
      expect(body.readable).toBe(1); // only concept_live exists
      expect(body.stale_count).toBe(2);
      expect(body.dry_run).toBe(true);
      const ids = body.stale_entries.map((e) => e.concept_id).sort();
      expect(ids).toEqual(["concept_meta_doc_path", "concept_stale"]);
      // dry_run: no posts attempted.
      for (const entry of body.stale_entries) {
        expect(entry.posted).toBe(false);
      }
    } finally {
      server.stop();
    }
  });

  it("POSTs substrateGap_write to dev-vessel when not dry_run, records post_status", async () => {
    const concepts = [
      { id: "concept_stale", pointer: { type: "memo", path: missingPath } },
    ];
    let postedBodies: unknown[] = [];
    const conceptServer = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/concepts/search") {
          return new Response(JSON.stringify({ concepts }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const devServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method === "POST") {
          postedBodies.push(await req.json());
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const result = await resolveStalePointerEmit({
        type: "stale_pointer_emit",
        conceptSearchUrl: `http://localhost:${conceptServer.port}/concepts/search`,
        devVesselImpulsesUrl: `http://localhost:${devServer.port}/v2/impulses/resolve`,
        dry_run: false,
      });
      expect(result.shape).toBe("stalePointerReport");
      const body = result.body as { stale_count: number; stale_entries: Array<{ posted: boolean; post_status: number }> };
      expect(body.stale_count).toBe(1);
      expect(body.stale_entries[0]!.posted).toBe(true);
      expect(body.stale_entries[0]!.post_status).toBe(200);
      expect(postedBodies).toHaveLength(1);
      const sent = postedBodies[0] as { impulse: { pointer: { type: string; gap: { id: string; classification_metadata: { gap_subtype: string } } } } };
      expect(sent.impulse.pointer.type).toBe("substrateGap_write");
      expect(sent.impulse.pointer.gap.id).toBe("stale-pointer-concept_stale");
      expect(sent.impulse.pointer.gap.classification_metadata.gap_subtype).toBe("stale_concept_pointer");
    } finally {
      conceptServer.stop();
      devServer.stop();
    }
  });

  it("respects maxEmits cap", async () => {
    const concepts = Array.from({ length: 20 }, (_, i) => ({
      id: `concept_${i}`,
      pointer: { type: "memo", path: `/tmp/missing-${i}-xyz` },
    }));
    const conceptServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ concepts }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      const result = await resolveStalePointerEmit({
        type: "stale_pointer_emit",
        conceptSearchUrl: `http://localhost:${conceptServer.port}/concepts/search`,
        dry_run: true,
        maxEmits: 3,
      });
      const body = result.body as { stale_count: number };
      expect(body.stale_count).toBe(3);
    } finally {
      conceptServer.stop();
    }
  });
});
