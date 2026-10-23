// A needs_information PARK IS DRAINED WHEN THE FACT IT WAITED FOR ARRIVES (gap row
// needs-information-is-the-dominant-admission-exclusion-and-nothing-drains-it-so-the-lane-cannot-reduce-what-it-cannot-admit).
//
// The write seam parks a new detector row it arms from its own reading (evidence_resolve_from detector_reading)
// disposition needs_information, "so it is armed later and never admitted on an unconfirmed check". Nothing lifted that
// label once the check's birth verdict read present: admission held the row as disposition(needs_information) and
// gap-check-supply (whose localizer would site it) skips any parking disposition, so the row stayed parked forever.
// Admission now drains it in the pass that sees the confirmed check (gap-admission detectorParkDrain).
//
// Driven through the real write seam on a temp gap store, with a stub birth judge (as detector-row-armability.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";
import { snapshotGapStore } from "../resolvers/gap-store-snapshot.js";

const ROOT = mkdtempSync(join(tmpdir(), "needs-info-drain-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { admitActionableGaps } = await import("../../src/judge/gap-admission.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { checkSupplyDisposition } = await import("../../src/resolvers/gap-check-supply.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, gapStoreRootForTest, __setBirthJudgeForTests } = sg;

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const SITE = "repos/development-vessel/src/resolvers/widget.ts";
const READING = { shape: "reach_rate_scan", input: { activity_id: "widget-family" }, field: "finding_count", value: 3 };
const SITELESS = "the dispatch rate fell below its floor over the last window";
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
// The stub birth judge: "present" unless the id is listed with another verdict.
const verdictFor: Record<string, "present" | "unknown"> = {};
let gapStore: { restore: () => Promise<void> } | null = null;

beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "ACTIVITY_API_ENDPOINT", "MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["ACTIVITY_API_ENDPOINT"];
  process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
  for (const d of ["gaps", "clones"]) mkdirSync(join(ROOT, d), { recursive: true });
  mkdirSync(join(ROOT, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
  writeFileSync(join(ROOT, "runtime", "development-vessel", "src", "resolvers", "widget.ts"), "export const widget = 1;\n");
  gapStore = snapshotGapStore(gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
  __setBirthJudgeForTests(async (g: Row) => verdictFor[String(g["id"])] ?? "present");
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await gapStore?.restore();
  __setBirthJudgeForTests(null);
  globalThis.fetch = originalFetch;
  __resetPolicyReadsForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function write(id: string, source: string, meta: Row): Promise<void> {
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source, status: "open", summary: SITELESS, detected_at: new Date().toISOString(), classification_metadata: meta } } as never, { vocabulary: null } as never);
  await __settleBirthEvaluationsForTests();
}
async function stored(id: string): Promise<Row> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Row[] }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error(`no row ${id}`);
  return g;
}
const metaOf = (row: Row): Row => (row.classification_metadata ?? {}) as Row;
/** A detector row born from its reading: parked needs_information, its class2 check birth-judged. */
async function parkedDetectorRow(id: string): Promise<Row> {
  await write(id, "substrate_detected", { detector: "reach_rate_scan", detector_reading: READING });
  const row = await stored(id);
  // PRECONDITION: the seam parked it, armed from its reading.
  expect(metaOf(row)).toMatchObject({ disposition: "needs_information", evidence_resolve_from: "detector_reading", falsifier: "class2" });
  return row;
}

describe("the needs_information drain", () => {
  it("MUST-FAIL a parked detector row whose check read present and whose site is now set is admitted in ONE pass, and the store row is unparked", async () => {
    const id = `ni-drain-sited-${RUN}`;
    await parkedDetectorRow(id);
    // The missing fact arrives: a later write names the site (the confirmed check is already on the row).
    await write(id, "substrate_detected", { edit_site: SITE });
    const before = await stored(id);
    expect(metaOf(before)).toMatchObject({ disposition: "needs_information", edit_site: SITE, predicate_birth_verdict: "present" });
    const adm = await admitActionableGaps([before]);
    expect({ admitted: adm.admitted.map((g) => String(g.id)), excluded: adm.excluded }).toEqual({ admitted: [id], excluded: [] });
    const after = metaOf(await stored(id));
    expect(after["disposition"]).toBe("");
    expect(after["needs_information_drained"]).toMatchObject({ from: "needs_information", because: "its detector_reading check read present at birth" });
  });

  it("MUST-FAIL a parked siteless detector row whose check read present is unparked, so the localizer's tick (check-supply) can take it", async () => {
    const id = `ni-drain-siteless-${RUN}`;
    const before = await parkedDetectorRow(id);
    expect(checkSupplyDisposition(before)).toBeNull();
    const adm = await admitActionableGaps([before]);
    expect(adm.admitted).toEqual([]);
    expect(adm.excluded).toEqual([{ id, reason: "needs_information(no_edit_site; falsifier=class2)" }]);
    const after = await stored(id);
    expect(metaOf(after)["disposition"]).toBe("");
    expect(checkSupplyDisposition(after)).not.toBeNull();
  });

  const unconfirmed = async (suffix: string): Promise<{ id: string; adm: Awaited<ReturnType<typeof admitActionableGaps>> }> => {
    const id = `ni-drain-unconfirmed-${suffix}-${RUN}`;
    verdictFor[id] = "unknown";
    await parkedDetectorRow(id);
    await write(id, "substrate_detected", { edit_site: SITE });
    const before = await stored(id);
    expect(metaOf(before)["predicate_birth_verdict"]).toBe("unknown");
    return { id, adm: await admitActionableGaps([before]) };
  };

  it("CONTROL a parked detector row whose check is NOT confirmed stays parked and excluded as parked, and nothing is written", async () => {
    const { id, adm } = await unconfirmed("ctl");
    expect(adm.admitted).toEqual([]);
    expect(adm.excluded.map((e) => e.id)).toEqual([id]);
    expect(String(adm.excluded[0]?.reason)).toStartWith("disposition(needs_information");
    const after = metaOf(await stored(id));
    expect(after["disposition"]).toBe("needs_information");
    expect(after["needs_information_drained"]).toBeUndefined();
  });

  it("MUST-FAIL the exclusion of a park still missing its fact names what it awaits", async () => {
    const { id, adm } = await unconfirmed("why");
    expect(adm.excluded).toEqual([{ id, reason: "disposition(needs_information; parked awaiting a confirmed check: birth verdict unknown)" }]);
  });

  it("CONTROL a human's needs_information park (no detector reading) and a detector park with an operator hold are never drained", async () => {
    const human = `ni-drain-human-${RUN}`;
    await write(human, "human_reported", { falsifier: "class1", expected_literal: "widgetFixed", edit_site: SITE, disposition: "needs_information" });
    const held = `ni-drain-held-${RUN}`;
    await parkedDetectorRow(held);
    await write(held, "substrate_detected", { edit_site: SITE, operator_hold: true });
    const adm = await admitActionableGaps([await stored(human), await stored(held)]);
    expect(adm.admitted).toEqual([]);
    expect(adm.excluded).toEqual([{ id: human, reason: "disposition(needs_information)" }, { id: held, reason: "operator_hold" }]);
    expect(metaOf(await stored(human))["disposition"]).toBe("needs_information");
    expect(metaOf(await stored(held))["disposition"]).toBe("needs_information");
  });
});
