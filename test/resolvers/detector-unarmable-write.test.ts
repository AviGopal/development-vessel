// A DETECTOR ROW NOTHING CAN ARM IS WRITTEN, MARKED BESIDE ITS "none" LABEL (substrate-gap.ts; class row
// detector-files-unarmed-rows, qa ruling (a) as revised, and ruling R1 (B)). 1,039 open detector rows on one node carry no
// falsifier, no edit site and no file in their summary: admission cannot take them and gap-check-supply cannot localize
// them. A NEW row like that from a detector source is stored with falsifier "none" (constraint A) and
// falsifier_unresolvable_reason prefixed "detector_row_unarmable: " beside it; every admission path keys on that prefix
// and excludes it (one must-fail per path, each with an ordinary "none" row as its control); it is counted per source
// (served on /health); its re-emissions keep the mark while still unarmable, and a check, a site or a file lifts it. A
// row another route acts on (orphan producer, capability gap) is not marked. Everything else is written as before.
// Driven through the real write seam.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = mkdtempSync(join(tmpdir(), "detector-unarmable-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { goalReachCheck } = await import("../../src/resolvers/goal-deficiency.js");
const { composeEligibilitySkipReason } = await import("../../src/judge/gap-eligibility.js");
const { checkSupplyDisposition } = await import("../../src/resolvers/gap-check-supply.js");
const { admitActionableGaps } = await import("../../src/judge/gap-admission.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, gapStoreRootForTest, __setBirthJudgeForTests, reevaluateBirthVerdicts } = sg;
// Read off the module object, so a tree without the counter fails its assertion instead of the whole file.
const rowCounts = (): Record<string, number> => ((sg as Record<string, unknown>)["unarmableDetectorRowCounts"] as (() => Record<string, number>) | undefined)?.() ?? {};
const MARK = "detector_row_unarmable: ";

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  // admission's file reads resolve against these (call time): empty scratch trees, so no real tree answers
  process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
  for (const d of ["gaps", "runtime", "clones"]) mkdirSync(join(ROOT, d), { recursive: true });
  // Nothing leaves the test: the pool answers the explicit open policy (admission reads the autonomy scope), all else 404.
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
  __setBirthJudgeForTests(async () => "present");
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await __settleBirthEvaluationsForTests();
  __setBirthJudgeForTests(null);
  globalThis.fetch = originalFetch;
  __resetPolicyReadsForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const SITELESS = "the dispatch rate fell below its floor over the last window";
async function write(id: string, source: string, summary: string, meta: Row = {}, category = "systematic_failure"): Promise<{ shape: string; body: Row }> {
  const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category, source, status: "open", summary, detected_at: new Date().toISOString(), classification_metadata: meta } } as never, { vocabulary: null } as never);
  await __settleBirthEvaluationsForTests();
  return r as unknown as { shape: string; body: Row };
}
async function stored(id: string): Promise<Row | undefined> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? []).find((g) => g.id === id);
}

const metaOf = (row: Row | undefined): Row => ((row?.classification_metadata ?? {}) as Row);
const reasonOf = (row: Row | undefined): string => String(metaOf(row).falsifier_unresolvable_reason ?? "");
const marked = (row: Row | undefined): boolean => reasonOf(row).startsWith(MARK);

describe("a new detector row with no falsifier, no edit_site and no file named is written \"none\", marked beside it, and counted", () => {
  it("MUST-FAIL: an exact substrate_detected write with none of them is STORED with falsifier none, the mark beside it, and counted", async () => {
    const id = `det-unarmable-${RUN}`;
    const before = rowCounts()["substrate_detected"] ?? 0;
    const r = await write(id, "substrate_detected", SITELESS);
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body).toMatchObject({ action: "created", falsifier: "none" });
    const row = await stored(id);
    expect(row).toBeDefined();
    expect(metaOf(row).falsifier).toBe("none");
    expect(marked(row)).toBe(true);
    expect(reasonOf(row)).toContain("goalReachCheck");
    expect((sg as Record<string, unknown>)["DETECTOR_ROW_UNARMABLE_REASON"]).toBe(MARK);
    expect((rowCounts()["substrate_detected"] ?? 0) - before).toBe(1);
    // the /health field serves this counter
    expect(readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8")).toContain("unarmable_detector_rows: unarmableDetectorRowCounts()");
  });

  it("MUST-FAIL: a <name>_detector and a <name>_scan source are detector sources too, each counted under its own name", async () => {
    // (not an orphaned_capability_* name: an id naming an orphan producer is the orphan route's, and is not marked)
    for (const src of ["joint_liveness_detector", "dispatch_rate_scan"]) {
      const before = rowCounts()[src] ?? 0;
      const id = `det-${src}-${RUN}`;
      const r = await write(id, src, SITELESS);
      expect({ src, falsifier: r.body["falsifier"], marked: marked(await stored(id)) }).toEqual({ src, falsifier: "none", marked: true });
      expect((rowCounts()[src] ?? 0) - before).toBe(1);
    }
  });

  it("MUST-FAIL: a re-emission keeps the mark and is not counted again; a check, a site or a file each lifts it", async () => {
    const lifts: Array<[string, Row, string]> = [
      ["check", { evidence_resolve: goalReachCheck("8202213c") }, SITELESS],
      ["site", { edit_site: "repos/development-vessel/src/resolvers/widget.ts" }, SITELESS],
      ["file", {}, `${SITELESS}; the counter lives in repos/analysis-vessel/src/index.ts`],
    ];
    for (const [how, meta, summary] of lifts) {
      const id = `det-reemit-${how}-${RUN}`;
      await write(id, "substrate_detected", SITELESS);
      const before = rowCounts()["substrate_detected"] ?? 0;
      const again = await write(id, "substrate_detected", SITELESS);
      expect({ how, body: again.body["action"], falsifier: again.body["falsifier"], marked: marked(await stored(id)) }).toEqual({ how, body: "updated", falsifier: "none", marked: true });
      expect((rowCounts()["substrate_detected"] ?? 0) - before).toBe(0);
      await write(id, "substrate_detected", summary, meta);
      expect({ how, marked: marked(await stored(id)), reason: reasonOf(await stored(id)) }).toEqual({ how, marked: false, reason: "" });
    }
  });

  it("MUST-FAIL: a row another route acts on is written and NOT marked (an orphan producer, a goal-walk capability gap, a structured tsc error)", async () => {
    const tsc = `det-tsc-${RUN}`;
    expect((await write(tsc, "typecheck_scan", "the vessel no longer typechecks", { tsc_error: { code: "TS2304", file: "src/resolvers/widget.ts", vessel: "development-vessel" } })).shape).toBe("substrateGapWriteResult");
    expect({ stored: (await stored(tsc)) !== undefined, marked: marked(await stored(tsc)) }).toEqual({ stored: true, marked: false });
    const orphan = `det-orphan-${RUN}`;
    expect((await write(orphan, "orphaned_capability_scan", "no producer serves shape widgetReport", { shape: "widgetReport" }, "orphaned_capability")).shape).toBe("substrateGapWriteResult");
    expect({ stored: (await stored(orphan)) !== undefined, marked: marked(await stored(orphan)) }).toEqual({ stored: true, marked: false });
    const cap = `det-capability-${RUN}`;
    expect((await write(cap, "substrate_detected", "Capability gap: the goal-walk needs a producer for shape \"widgetReport\"", { kind: "capability_gap", missing_shape: "widgetReport" }, "missing_capability")).shape).toBe("substrateGapWriteResult");
    expect({ stored: (await stored(cap)) !== undefined, marked: marked(await stored(cap)) }).toEqual({ stored: true, marked: false });
  });
});

// ONE MUST-FAIL PER ADMISSION PATH, each read on the prefix and never on the label, each with an ordinary "none" row of
// the same shape as its control (its verdict unchanged).
describe("every admission path excludes a marked row and leaves an ordinary none row as it was", () => {
  const plain = (id: string, extra: Row = {}, category = "systematic_failure"): Row => ({ id, category, source: "substrate_detected", status: "open", summary: SITELESS, detected_at: "2026-10-19T00:00:00.000Z", classification_metadata: { falsifier: "none", ...extra } });
  const withMark = (row: Row): Row => ({ ...row, classification_metadata: { ...metaOf(row), falsifier_unresolvable_reason: `${MARK}fixture` } });

  it("gap-eligibility: a marked row is unarmed, and so is an ordinary none row (the label already excludes it; guard)", () => {
    expect(composeEligibilitySkipReason(withMark(plain("elig-marked")))).toBe("unarmed");
    expect(composeEligibilitySkipReason(plain("elig-plain"))).toBe("unarmed");
  });

  it("MUST-FAIL gap-check-supply: a marked row is not a candidate; CONTROL an ordinary none row still is", () => {
    expect(checkSupplyDisposition(withMark(plain("cs-marked")))).toBeNull();
    expect(checkSupplyDisposition(plain("cs-plain"))).toBe("needs_localization");
  });

  it("MUST-FAIL gap-admission: a marked row is excluded on the prefix; CONTROL the same orphan-route none row is admitted", async () => {
    // The write seam never marks an orphan-route row (above); this holds the reader contract wherever a marked row
    // reaches admission, on the one none-labelled route admission admits.
    const row = plain("orphaned-capability-det-probe", { shape: "widgetReport" }, "orphaned_capability");
    const ctl = await admitActionableGaps([row]);
    expect(ctl.admitted.map((g) => String(g.id))).toEqual(["orphaned-capability-det-probe"]);
    const r = await admitActionableGaps([withMark(row)]);
    expect(r.admitted).toEqual([]);
    expect(r.excluded).toEqual([{ id: "orphaned-capability-det-probe", reason: "detector_row_unarmable" }]);
  });

  it("birth sweep: neither a marked row nor an ordinary none row is re-taken or re-classified (it takes class2 rows only; guard)", async () => {
    const m = `det-birth-marked-${RUN}`;
    await write(m, "substrate_detected", SITELESS);
    const p = `det-birth-plain-${RUN}`;
    await write(p, "human_reported", SITELESS);
    const before = [await stored(m), await stored(p)];
    expect(marked(before[0])).toBe(true);
    expect(metaOf(before[1]).falsifier).toBe("none");
    expect(await reevaluateBirthVerdicts(before as Row[], 10, async () => "present")).toEqual([]);
    expect([metaOf(await stored(m)), metaOf(await stored(p))]).toEqual([metaOf(before[0]), metaOf(before[1])]);
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
