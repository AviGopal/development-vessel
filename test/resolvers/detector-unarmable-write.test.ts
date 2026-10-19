// A DETECTOR ROW NOTHING CAN ARM IS NOT WRITTEN (substrate-gap.ts; class row detector-files-unarmed-rows, qa ruling (a)).
// 1,039 open detector rows on one node carry no falsifier, no edit site and no file in their summary: admission cannot
// take them and gap-check-supply cannot localize them, so they are born dead. A NEW row like that from a detector
// source is refused with error detector_row_unarmable and counted per source (served on /health); everything else is
// written as before. Driven through the real write seam.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "detector-unarmable-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { goalReachCheck } = await import("../../src/resolvers/goal-deficiency.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, unarmableDetectorRefusalCounts, gapStoreRootForTest, __setBirthJudgeForTests } = sg;

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch; // nothing leaves the test
  __setBirthJudgeForTests(async () => "present");
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await __settleBirthEvaluationsForTests();
  __setBirthJudgeForTests(null);
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const SITELESS = "the dispatch rate fell below its floor over the last window";
async function write(id: string, source: string, summary: string, meta: Row = {}): Promise<{ shape: string; body: Row }> {
  const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source, status: "open", summary, detected_at: new Date().toISOString(), classification_metadata: meta } } as never, { vocabulary: null } as never);
  await __settleBirthEvaluationsForTests();
  return r as unknown as { shape: string; body: Row };
}
async function stored(id: string): Promise<Row | undefined> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? []).find((g) => g.id === id);
}

describe("a new detector row with no falsifier, no edit_site and no file named is refused and counted", () => {
  it("MUST-FAIL: an exact substrate_detected write with none of them is refused with the named reason, counted, and not stored", async () => {
    const id = `det-unarmable-${RUN}`;
    const before = unarmableDetectorRefusalCounts()["substrate_detected"] ?? 0;
    const r = await write(id, "substrate_detected", SITELESS);
    expect(r.shape).toBe("structuredError");
    expect(r.body).toMatchObject({ error: "detector_row_unarmable", failure_mode: "validation_rejected", source: "substrate_detected" });
    expect(String(r.body["detail"])).toContain("goalReachCheck");
    expect((unarmableDetectorRefusalCounts()["substrate_detected"] ?? 0) - before).toBe(1);
    expect(await stored(id)).toBeUndefined();
  });

  it("MUST-FAIL: a <name>_detector and a <name>_scan source are detector sources too, each counted under its own name", async () => {
    for (const src of ["joint_liveness_detector", "orphaned_capability_scan"]) {
      const before = unarmableDetectorRefusalCounts()[src] ?? 0;
      const r = await write(`det-${src}-${RUN}`, src, SITELESS);
      expect({ src, error: r.body["error"] }).toEqual({ src, error: "detector_row_unarmable" });
      expect((unarmableDetectorRefusalCounts()[src] ?? 0) - before).toBe(1);
    }
  });
});

describe("controls: every other row is written exactly as before", () => {
  it("a substrate_detected row WITH an edit_site is written", async () => {
    const id = `det-site-${RUN}`;
    const r = await write(id, "substrate_detected", SITELESS, { edit_site: "repos/development-vessel/src/resolvers/widget.ts" });
    expect(r.shape).not.toBe("structuredError");
    expect(await stored(id)).toBeDefined();
  });

  it("a substrate_detected row with no edit_site but a file named in its summary is written", async () => {
    const id = `det-file-${RUN}`;
    const r = await write(id, "substrate_detected", `${SITELESS}; the counter lives in repos/analysis-vessel/src/index.ts`);
    expect(r.shape).not.toBe("structuredError");
    expect(await stored(id)).toBeDefined();
  });

  it("a substrate_detected row carrying the check it measured (a falsifier, no site) is written", async () => {
    const id = `det-armed-${RUN}`;
    const r = await write(id, "substrate_detected", SITELESS, { evidence_resolve: goalReachCheck("8202213c") });
    expect(r.shape).not.toBe("structuredError");
    expect(((await stored(id))?.classification_metadata as Row).falsifier).toBe("class2");
  });

  it("goal_deficiency_recognition rows are unchanged (armed by R2, written; and not a detector source even unarmed)", async () => {
    for (const [n, meta] of [["armed", { evidence_resolve: goalReachCheck("97109d74") }], ["unarmed", {}]] as const) {
      const id = `det-gdr-${n}-${RUN}`;
      const r = await write(id, "goal_deficiency_recognition", SITELESS, meta);
      expect({ n, shape: r.shape }).not.toEqual({ n, shape: "structuredError" });
      expect(await stored(id)).toBeDefined();
    }
  });

  it("human and operator rows with no falsifier, site or file are unchanged (written)", async () => {
    for (const src of ["human_reported", "operator", "operator:ac8b0aad", "goal_host_auto_draft", "substrate_detected_by_hand"]) {
      const id = `det-ctl-${src.replace(/[^a-z0-9]/g, "-")}-${RUN}`;
      const r = await write(id, src, SITELESS);
      expect({ src, shape: r.shape }).not.toEqual({ src, shape: "structuredError" });
      expect(await stored(id)).toBeDefined();
    }
  });

  it("not retroactive: a re-emission onto a stored unarmed, siteless detector row is written (the row is refreshed, not refused)", async () => {
    const id = `det-legacy-${RUN}`;
    const path = join(gapStoreRootForTest(), "gaps", "gaps.json");
    let rows: Row[] = [];
    try { rows = JSON.parse(readFileSync(path, "utf-8")) as Row[]; } catch { rows = []; }
    rows.push({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: SITELESS, detected_at: "2026-10-01T00:00:00.000Z", first_detected_at: "2026-10-01T00:00:00.000Z", classification_metadata: { falsifier: "none" } });
    writeFileSync(path, JSON.stringify(rows));
    const r = await write(id, "substrate_detected", SITELESS);
    expect(r.shape).not.toBe("structuredError");
    expect((await stored(id))?.status).toBe("open");
  });
});
