import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveInterventionEvaluate,
} from "../../src/resolvers/intervention-evaluate.js";

const originalFetch = globalThis.fetch;

let tmpRoot: string;
let originalWorkspace: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "intervention-evaluate-"));
  originalWorkspace = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = tmpRoot;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWorkspace === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = originalWorkspace;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeFetch(
  conceptHits: Array<{ id: string; name?: string }>,
  traces: Array<{ execution_id: string; status: string }>,
): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (url.includes("/concepts/search")) {
      return new Response(JSON.stringify({ concepts: conceptHits }), { status: 200 });
    }
    if (url.includes("/execution-traces")) {
      return new Response(JSON.stringify({ traces }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("intervention_evaluate", () => {
  it("ACCEPTs when cited_evidence present and no contradicting priors", async () => {
    globalThis.fetch = fakeFetch(
      [{ id: "concept_xyz", name: "unrelated topic" }],
      [{ execution_id: "exec_1", status: "success" }],
    );
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: {
        target_path: "repos/metabob-activity-api/src/routes/activities.ts",
        diff_summary: "fix observability projection",
        source: "operator",
        intent: "fix flagged by phantom scan",
      },
      cited_evidence: [{ kind: "trace_id", ref: "exec_nv5xefms", note: "real" }],
      strictness: "balanced",
      conceptDbUrl: "http://concept",
      tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
    });
    expect(result.shape).toBe("interventionEvaluation");
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("ACCEPT");
    expect(body.cited_evidence_strength_score).toBe(1);
  });

  it("REFUSEs when cited_evidence empty AND contradicting prior exists", async () => {
    // "delete" verb in diff_summary triggers contradicts-classification when
    // concept name overlaps target_path token.
    globalThis.fetch = fakeFetch(
      [{ id: "concept_abc", name: "activities core path" }],
      [{ execution_id: "exec_a", status: "success" }],
    );
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: {
        target_path: "repos/metabob-activity-api/src/routes/activities.ts",
        diff_summary: "delete activities route entirely",
        source: "operator",
        intent: "cleanup",
      },
      cited_evidence: [],
      strictness: "balanced",
      conceptDbUrl: "http://concept",
      tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
    });
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("REFUSE");
    expect(typeof body.refusal_basis).toBe("string");
  });

  it("REFUSEs operator-modify of substrate-authored file under strict policy", async () => {
    // Plant a file with the Substrate-Authored-By trailer in tmpRoot.
    const subPath = "repos/dev/substrate-authored-file.ts";
    mkdirSync(join(tmpRoot, "repos/dev"), { recursive: true });
    writeFileSync(
      join(tmpRoot, subPath),
      "// Substrate-Authored-By: development-vessel\nconst x = 1;\n",
      "utf-8",
    );
    globalThis.fetch = fakeFetch(
      [{ id: "concept_z", name: "unrelated" }],
      [{ execution_id: "exec_b", status: "success" }],
    );
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: {
        target_path: subPath,
        diff_summary: "tweak constant value",
        source: "operator",
        intent: "small fix",
      },
      cited_evidence: [{ kind: "memo", ref: "operator says so" }],
      strictness: "strict",
      conceptDbUrl: "http://concept",
      tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
    });
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("REFUSE");
    expect(String(body.refusal_basis)).toContain("Substrate-Authored-By");
  });

  it("DEFERs when priors inconclusive (cited evidence present but no concept hits and no traces)", async () => {
    globalThis.fetch = fakeFetch([], []);
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: {
        target_path: "repos/some/path.ts",
        diff_summary: "refactor something",
        source: "operator",
        intent: "cleanup",
      },
      cited_evidence: [{ kind: "trace_id", ref: "exec_x" }],
      strictness: "balanced",
      conceptDbUrl: "http://concept",
      tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
    });
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("DEFER");
    expect(typeof body.defer_until_condition).toBe("string");
  });

  it("DEFERs when concept-db and traces both unreachable (network errors)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: {
        target_path: "repos/x/y.ts",
        diff_summary: "make change",
        source: "operator",
        intent: "intent",
      },
      cited_evidence: [{ kind: "trace_id", ref: "exec_q" }],
      strictness: "balanced",
      conceptDbUrl: "http://nope",
      tracesUrl: "http://nope/v2/activities/execution-traces",
    });
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("DEFER");
    expect(String(body.reason)).toContain("unreachable");
  });
});
