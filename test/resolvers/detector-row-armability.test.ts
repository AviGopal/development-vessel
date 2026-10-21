// A NEW DETECTOR ROW NOTHING CAN ARM IS ARMED FROM ITS OWN READING (substrate-gap.ts; gap row
// a-detector-filed-gap-must-carry-the-check-the-detector-measured-otherwise-it-is-born-unadmittable). goal_deficiency_recognition
// arms every row it files with the check it measured (goalReachCheck); that is the write-time contract for every detector
// source now. A new open detector row with no predicate, no site or file and no other route is armed from its own
// detector_reading (a class2 check, written needs_information); detectorRearmProposal is
// the read-only view of the rows already stored. Driven through the real write seam, on a temp gap store, with stubs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = mkdtempSync(join(tmpdir(), "detector-armability-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { goalReachCheck } = await import("../../src/resolvers/goal-deficiency.js");
const { admitActionableGaps } = await import("../../src/judge/gap-admission.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, gapStoreRootForTest, __setBirthJudgeForTests } = sg;
// Read off the module object, so a tree without them fails its assertions instead of the whole file.
const mod = sg as Record<string, unknown>;
const proposal = mod["detectorRearmProposal"] as ((rows: Row[], vocab?: unknown) => Row) | undefined;

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
const judged: string[] = [];
beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "ACTIVITY_API_ENDPOINT", "MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["ACTIVITY_API_ENDPOINT"];
  process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
  for (const d of ["gaps", "runtime", "clones"]) mkdirSync(join(ROOT, d), { recursive: true });
  // Nothing leaves the test: the pool answers the explicit open policy, everything else 404s.
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
  // A stub birth judge: no instrument is resolved; the ids it was asked about are recorded.
  __setBirthJudgeForTests(async (g: Row) => { judged.push(String(g["id"])); return "present"; });
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
// reach_rate_scan declares its response contract (finding_count is a field it returns)
const READING = { shape: "reach_rate_scan", input: { activity_id: "widget-family" }, field: "finding_count", value: 3 };

describe("MUST-FAIL: a new detector row nothing can arm is armed from its reading", () => {
  it("MUST-FAIL: one WITH a reading is written needs_information with a class2 predicate built from the reading (a count > 0 is a zero_field)", async () => {
    const id = `arm-reading-${RUN}`;
    const r = await write(id, "substrate_detected", SITELESS, { detector: "reach_rate_scan", detector_reading: READING });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body).toMatchObject({ action: "created", falsifier: "class2" });
    const m = metaOf(await stored(id));
    expect(m["evidence_resolve"]).toEqual({ shape: "reach_rate_scan", input: { activity_id: "widget-family" }, zero_field: "finding_count" });
    expect(m["disposition"]).toBe("needs_information");
    expect(m["falsifier"]).toBe("class2");
    expect(m["evidence_resolve_from"]).toBe("detector_reading");
    // the reading itself is kept beside the check (add beside, never rewrite)
    expect(m["detector_reading"]).toEqual(READING);
    expect(String(m["falsifier_unresolvable_reason"] ?? "")).toBe("");
    // a class2 check is birth-evaluated like any other arming (the stub judge here, no instrument resolved)
    expect(judged).toContain(id);
    // parked, so admission never takes it on an unconfirmed check
    const adm = await admitActionableGaps([await stored(id) as Row]);
    expect(adm.admitted).toEqual([]);
    expect(adm.excluded.map((e) => e.id)).toEqual([id]);
    expect(String(adm.excluded[0]?.reason)).toContain("needs_information");
  });

  it("MUST-FAIL: a health field the detector read at 0 becomes a nonzero_field", async () => {
    const id = `arm-health-${RUN}`;
    const r = await write(id, "orphaned_widget_scan", SITELESS, { detector_reading: { shape: "reach_rate_scan", field: "reached_count", value: 0 } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(metaOf(await stored(id))["evidence_resolve"]).toEqual({ shape: "reach_rate_scan", nonzero_field: "reached_count" });
  });
});

describe("MUST-FAIL: the one-time re-arm sweep proposal is read-only and classifies a fixture set", () => {
  const det = (id: string, meta: Row, extra: Row = {}): Row => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: SITELESS, detected_at: "2026-10-21T00:00:00.000Z", ...extra, classification_metadata: { falsifier: "none", ...meta } });
  const FIXTURE: Row[] = [
    det("p-reading", { detector_reading: READING }),
    det("p-rowfields", { detector: "reach_rate_scan", finding_count: 4 }),
    det("p-rowfields-scan-source", { reach_below_floor: 2 }, { source: "reach_rate_scan" }),
    det("p-site", { edit_site: "repos/development-vessel/src/resolvers/widget.ts" }),
    det("p-file", {}, { summary: `${SITELESS}; the counter lives in repos/analysis-vessel/src/index.ts` }),
    det("p-orphan", { shape: "widgetReport" }, { category: "orphaned_capability" }),
    det("p-bare", { detector: "vector_space_orthogonality_audit", trace_count: 9 }),
    { ...det("p-unstamped", {}), classification_metadata: {} },
    det("p-bad-reading", { detector_reading: { shape: "reach_rate_scan", field: "no_such_field", value: 1 } }),
    // not in the proposal: armed, closed, not a detector source
    det("x-armed", { falsifier: "class2", evidence_resolve: goalReachCheck("8202213c") }),
    det("x-closed", {}, { status: "closed" }),
    det("x-human", {}, { source: "human_reported" }),
    det("x-gdr", { falsifier: "class2", evidence_resolve: goalReachCheck("97109d74") }, { source: "goal_deficiency_recognition" }),
  ];

  it("MUST-FAIL: each unarmed detector row is classified, with the check or the reason, and nothing is written", async () => {
    expect(typeof proposal).toBe("function");
    const path = join(gapStoreRootForTest(), "gaps", "gaps.json");
    const before = (() => { try { return `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`; } catch { return "absent"; } })();
    const input = JSON.parse(JSON.stringify(FIXTURE)) as Row[];
    const body = proposal!(input, null);
    const after = (() => { try { return `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`; } catch { return "absent"; } })();
    expect(after).toBe(before);
    expect(input).toEqual(FIXTURE); // the rows passed in are not mutated
    expect(body["writes"]).toBe(0);
    expect(body["open_detector_rows"]).toBe(10);
    expect(body["unarmed_detector_rows"]).toBe(9);
    const rows = body["rows"] as Row[];
    const verdicts = Object.fromEntries(rows.map((r) => [String(r["id"]), r["verdict"]]));
    expect(verdicts).toEqual({
      "p-reading": "armable_from_reading",
      "p-rowfields": "armable_from_row_fields",
      "p-rowfields-scan-source": "armable_from_row_fields",
      "p-site": "localizable",
      "p-file": "localizable",
      "p-orphan": "routed_elsewhere",
      "p-bare": "not_armable",
      "p-unstamped": "not_armable",
      "p-bad-reading": "not_armable",
    });
    expect(body["counts"]).toEqual({ armable_from_reading: 1, armable_from_row_fields: 2, localizable: 2, routed_elsewhere: 1, not_armable: 3 });
    const byId = (id: string): Row => rows.find((r) => r["id"] === id)!;
    expect(byId("p-reading")["evidence_resolve"]).toEqual({ shape: "reach_rate_scan", input: { activity_id: "widget-family" }, zero_field: "finding_count" });
    expect(byId("p-rowfields")).toMatchObject({ evidence_resolve: { shape: "reach_rate_scan", zero_field: "finding_count" }, input_confirmed: false });
    expect(byId("p-rowfields-scan-source")["evidence_resolve"]).toEqual({ shape: "reach_rate_scan", zero_field: "reach_below_floor" });
    expect(String(byId("p-bare")["reason"])).toContain("detector_row_unarmable_no_reading");
    expect(String(byId("p-bad-reading")["reason"])).toContain("detector_row_unarmable_reading_unusable");
  });
});

describe("controls: everything else is written exactly as before", () => {
  it("CONTROL: goal_deficiency_recognition rows are unchanged (armed with goalReachCheck, class2, written; admitted once localized)", async () => {
    const id = `arm-gdr-${RUN}`;
    const r = await write(id, "goal_deficiency_recognition", SITELESS, { kind: "goal_content_deficiency", goal_hash: "97109d74", evidence_resolve: goalReachCheck("97109d74") });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["falsifier"]).toBe("class2");
    const row = await stored(id);
    expect(metaOf(row)["evidence_resolve"]).toEqual(goalReachCheck("97109d74"));
    expect(metaOf(row)["disposition"]).toBeUndefined();
    // as R2 files it, it enters the pipeline needing localization (no edit_site), never as a detector row
    const adm = await admitActionableGaps([row as Row]);
    expect(adm.excluded).toEqual([{ id, reason: "needs_information(no_edit_site; falsifier=class2)" }]);
    const localized = { ...(row as Row), classification_metadata: { ...metaOf(row), edit_site: "repos/development-vessel/src/resolvers/widget.ts" } };
    const adm2 = await admitActionableGaps([localized]);
    expect({ admitted: adm2.admitted.map((g) => String(g.id)), excluded: adm2.excluded }).toEqual({ admitted: [id], excluded: [] });
  });

  it("CONTROL: a non-detector source write is unchanged (a human_reported row with no check, site or file is written, unmarked, no disposition)", async () => {
    for (const src of ["human_reported", "operator:ac8b0aad", "development-vessel"]) {
      const id = `arm-ctl-${src.replace(/[^a-z0-9]/g, "-")}-${RUN}`;
      const r = await write(id, src, SITELESS);
      expect({ src, shape: r.shape, falsifier: r.body["falsifier"] }).toEqual({ src, shape: "substrateGapWriteResult", falsifier: "none" });
      const m = metaOf(await stored(id));
      expect({ src, disposition: m["disposition"], reason: m["falsifier_unresolvable_reason"] }).toEqual({ src, disposition: undefined, reason: undefined });
    }
  });

  it("CONTROL: an already-armed detector write is accepted unchanged (its check kept, no disposition set)", async () => {
    const id = `arm-armed-${RUN}`;
    const r = await write(id, "substrate_detected", SITELESS, { evidence_resolve: goalReachCheck("8202213c") });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body).toMatchObject({ action: "created", falsifier: "class2" });
    const m = metaOf(await stored(id));
    expect(m["evidence_resolve"]).toEqual(goalReachCheck("8202213c"));
    expect(m["disposition"]).toBeUndefined();
    expect(m["evidence_resolve_from"]).toBeUndefined();
  });

  it("CONTROL: a detector row with an edit_site, or a file in its summary, is written as before (gap-check-supply localizes it)", async () => {
    const site = `arm-site-${RUN}`;
    expect((await write(site, "substrate_detected", SITELESS, { edit_site: "repos/development-vessel/src/resolvers/widget.ts" })).shape).toBe("substrateGapWriteResult");
    expect(await stored(site)).toBeDefined();
    const file = `arm-file-${RUN}`;
    expect((await write(file, "substrate_detected", `${SITELESS}; the counter lives in repos/analysis-vessel/src/index.ts`)).shape).toBe("substrateGapWriteResult");
    expect(metaOf(await stored(file))["disposition"]).toBeUndefined();
  });
});
