import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVesselResponsibilityAudit } from "../../src/resolvers/vessel-responsibility-audit.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FetchSpec {
  concepts?: unknown[];
  ok?: boolean;
}

function makeFetch(routes: Record<string, FetchSpec>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const [needle, spec] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify({ concepts: spec.concepts ?? [] }), {
          status: spec.ok === false ? 500 : 200,
        });
      }
    }
    // Default: substrateGap_write emit endpoint.
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function setupFakeVessel(opts: {
  vesselName: string;
  files: Record<string, string>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vra-"));
  const reposDir = join(root, "repos");
  await mkdir(reposDir, { recursive: true });
  const vesselSrc = join(reposDir, opts.vesselName, "src");
  await mkdir(vesselSrc, { recursive: true });
  for (const [name, content] of Object.entries(opts.files)) {
    await writeFile(join(vesselSrc, name), content);
  }
  return root;
}

describe("vessel_responsibility_audit", () => {
  it("flags goal-host-vessel when source matches backend-is-trace-store principle", async () => {
    const root = await setupFakeVessel({
      vesselName: "goal-host-vessel",
      files: {
        "index.ts":
          `// goal-host dispatch loop\n` +
          `const url = "http://api/v2/activities/templates?limit=200";\n` +
          `await fetch(url);\n` +
          `// LLM-reuse over catalogue\n`,
      },
    });
    try {
      globalThis.fetch = makeFetch({
        "concepts/search": {
          concepts: [
            {
              id: "concept_test_backend",
              metadata: {
                severity: "structural",
                principle_name: "backend_is_trace_store_not_universal_resolver",
                check_hints: [
                  {
                    target_vessel: "goal-host-vessel",
                    forbidden_pattern_regex: "v2/activities/templates\\?limit=|LLM[-_]?reuse",
                    detail: "template-catalogue fetch + LLM-reuse belongs to activity-api",
                  },
                ],
              },
            },
          ],
        },
      });
      const r = await resolveVesselResponsibilityAudit({
        type: "vessel_responsibility_audit",
        vessel_name: "goal-host-vessel",
        workspaceRoot: root,
        dry_run: true,
      });
      expect(r.shape).toBe("vesselResponsibilityAudit");
      const body = r.body as any;
      expect(body.vessels_scanned).toBe(1);
      expect(body.principles_consulted).toBe(1);
      expect(body.total_violations).toBeGreaterThan(0);
      const v = body.violations[0];
      expect(v.vessel).toBe("goal-host-vessel");
      expect(v.principle_name).toBe("backend_is_trace_store_not_universal_resolver");
      expect(v.matched_pattern).toContain("v2/activities/templates");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns zero violations when source is clean", async () => {
    const root = await setupFakeVessel({
      vesselName: "clean-vessel",
      files: { "index.ts": `console.log("nothing forbidden here");\n` },
    });
    try {
      globalThis.fetch = makeFetch({
        "concepts/search": {
          concepts: [
            {
              id: "p",
              metadata: {
                severity: "structural",
                principle_name: "backend",
                check_hints: [
                  { forbidden_pattern_regex: "LLM[-_]?reuse", detail: "x" },
                ],
              },
            },
          ],
        },
      });
      const r = await resolveVesselResponsibilityAudit({
        type: "vessel_responsibility_audit",
        vessel_name: "clean-vessel",
        workspaceRoot: root,
        dry_run: true,
      });
      const body = r.body as any;
      expect(body.total_violations).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces concept-db failure in fetch_error and proceeds with zero principles", async () => {
    globalThis.fetch = (async () => {
      throw new Error("concept-db down");
    }) as unknown as typeof fetch;
    const r = await resolveVesselResponsibilityAudit({
      type: "vessel_responsibility_audit",
      workspaceRoot: "/nonexistent",
      dry_run: true,
    });
    expect(r.shape).toBe("vesselResponsibilityAudit");
    const body = r.body as any;
    expect(body.fetch_error).toContain("concept-db down");
    expect(body.principles_fetched_total).toBe(0);
    expect(body.total_violations).toBe(0);
  });

  it("filters check_hints by target_vessel — non-matching vessels skip the hint", async () => {
    const root = await setupFakeVessel({
      vesselName: "other-vessel",
      files: { "index.ts": `const url = "v2/activities/templates?limit=200";\n` },
    });
    try {
      globalThis.fetch = makeFetch({
        "concepts/search": {
          concepts: [
            {
              id: "p",
              metadata: {
                severity: "structural",
                principle_name: "x",
                check_hints: [
                  {
                    target_vessel: "goal-host-vessel",
                    forbidden_pattern_regex: "v2/activities/templates",
                    detail: "x",
                  },
                ],
              },
            },
          ],
        },
      });
      const r = await resolveVesselResponsibilityAudit({
        type: "vessel_responsibility_audit",
        vessel_name: "other-vessel",
        workspaceRoot: root,
        dry_run: true,
      });
      const body = r.body as any;
      expect(body.total_violations).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
