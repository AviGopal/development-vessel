import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveFailureModeMatrixScore } from "../../src/resolvers/failure-mode-matrix-score.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;

function makeScenario(id: string, outputShapes: string[]) {
  return JSON.stringify({
    id,
    expected_emergence: {
      activity_signature: { output_shapes_must_include: outputShapes },
    },
  });
}

function makeFetch(matchedForShapes: string[]) {
  return (async (url: string, opts?: RequestInit) => {
    if (String(url).includes("/v2/activities/discover-by-shapes")) {
      const body = JSON.parse(String(opts?.body ?? "{}")) as { required_shapes?: string[] };
      const required = body.required_shapes ?? [];
      const matched = required.some(s => matchedForShapes.includes(s));
      return new Response(
        JSON.stringify({
          activities: matched ? [{ id: "t:matched" }] : [],
          total: matched ? 1 : 0,
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("failure-mode-matrix-score resolver", () => {
  let tmpDir = "";

  beforeAll(async () => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
    tmpDir = await mkdtemp(join(tmpdir(), "fmms-test-"));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("returns failureModeReport shape", async () => {
    globalThis.fetch = makeFetch([]);
    await writeFile(join(tmpDir, "sc1.json"), makeScenario("sc1", ["shapeA"]));
    const result = await resolveFailureModeMatrixScore({
      type: "failure_mode_matrix_score",
      scenarios_dir: tmpDir,
    });
    expect(result.shape).toBe("failureModeReport");
  });

  it("all scenarios match → reuse counts correctly", async () => {
    globalThis.fetch = makeFetch(["shapeA", "shapeB"]);
    await writeFile(join(tmpDir, "a.json"), makeScenario("a", ["shapeA"]));
    await writeFile(join(tmpDir, "b.json"), makeScenario("b", ["shapeB"]));
    const result = await resolveFailureModeMatrixScore({
      type: "failure_mode_matrix_score",
      scenarios_dir: tmpDir,
    });
    const body = result.body as { summary: { reuse: number; gap: number }; scenarios_run: number };
    expect(body.summary.reuse).toBe(body.scenarios_run);
    expect(body.summary.gap).toBe(0);
  });

  it("mixed match/no-match → correct reuse + gap counts", async () => {
    globalThis.fetch = makeFetch(["shapeA"]);
    await writeFile(join(tmpDir, "match.json"), makeScenario("match", ["shapeA"]));
    await writeFile(join(tmpDir, "nomatch.json"), makeScenario("nomatch", ["shapeZ"]));
    const result = await resolveFailureModeMatrixScore({
      type: "failure_mode_matrix_score",
      scenarios_dir: tmpDir,
      label: "test-cycle",
    });
    const body = result.body as { summary: { reuse: number; gap: number } };
    expect(body.summary.reuse).toBeGreaterThanOrEqual(1);
    expect(body.summary.gap).toBeGreaterThanOrEqual(1);
  });

  it("empty scenarios dir → report with scenarios_run: 0", async () => {
    globalThis.fetch = makeFetch([]);
    const emptyDir = await mkdtemp(join(tmpdir(), "fmms-empty-"));
    const result = await resolveFailureModeMatrixScore({
      type: "failure_mode_matrix_score",
      scenarios_dir: emptyDir,
    });
    const body = result.body as { scenarios_run: number };
    expect(body.scenarios_run).toBe(0);
    await rm(emptyDir, { recursive: true }).catch(() => {});
  });

  it("non-200 from activity-api marks scenario as gap, others still scored", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/v2/activities/discover-by-shapes")) {
        callCount++;
        // First call fails
        if (callCount === 1) return new Response("error", { status: 500 });
        return new Response(JSON.stringify({ activities: [{ id: "t:ok" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const dir = await mkdtemp(join(tmpdir(), "fmms-err-"));
    await writeFile(join(dir, "fail.json"), makeScenario("fail", ["shapeX"]));
    await writeFile(join(dir, "pass.json"), makeScenario("pass", ["shapeY"]));
    const result = await resolveFailureModeMatrixScore({
      type: "failure_mode_matrix_score",
      scenarios_dir: dir,
    });
    const body = result.body as { scenarios_run: number };
    expect(body.scenarios_run).toBe(2);
    await rm(dir, { recursive: true }).catch(() => {});
  });
});
