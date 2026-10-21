// THE PICK REFUSES A ROW SITED AT ITS OWN CHECK BY NAME, BEFORE ITS OTHER BRAKES, AND UN-ARMS IT ONCE (2026-10-21).
//
// Live after e203286d: recommit-route-edit-7ffa6330-step-1-verify_failed (edit_site = its check's test_file =
// src/resolvers/substrate-gap.test.ts, carried ONLY in evidence_resolve, no check_supply ledger, falsifier class2,
// failed_attempts 6) and its decompose child -step-1 (predicate held by its parent) were never named. The pick excluded
// them earlier (the recommit lineage cap, the predicate hold), and only admission, which runs after those filters,
// named an own-check row. The supply tick's un-arm sweep reads them too, but runs only when its rhythm is due, and
// none had run since the push. So the rows stayed class2 and unnamed.
//
// THE CONTRACT: the auto-pick checks editSiteIsOwnCheck over every open row before the lease, hold, lineage-cap and
// backoff filters; it logs `[check-supply] refused <id>: edit_site_is_own_check (<site>)` for each; it writes the
// un-arm (own_check_unarmed, the same record the supply writes) for each class2 one, and the write seam re-labels it
// unresolvable on that write, so the next pass writes nothing; and an own-check row never holds a lineage's predicate.
// The rows are planted with the live rows' stored field values (no seam re-classification), as they sit in the store.
// CONTROL: a row of the same check sited at the src module is not refused, not written, and keeps class2.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = join(tmpdir(), `own-check-pick-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const ID = `recommit-route-edit-7ffa6330-step-1-verify_failed-${RUN}`;
const CHILD = `${ID}-step-1`;
const CONTROL = `own-check-pick-control-${RUN}`;
const SITE = "repos/development-vessel/src/resolvers/substrate-gap.test.ts";
// The live row's evidence_resolve, verbatim.
const ER = { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "src/resolvers/substrate-gap.test.ts", only_tests: ["still dedups by class against well-formed rows"], timeout_ms: 180000 }, zero_field: "requested_not_passing" };
const BIRTH_KEY = "{\"evidence_resolve\":{\"input\":{\"only_tests\":[\"still dedups by class against well-formed rows\"],\"test_file\":\"src/resolvers/substrate-gap.test.ts\",\"timeout_ms\":180000,\"vessel\":\"repos/development-vessel\"},\"shape\":\"test_suite\",\"zero_field\":\"requested_not_passing\"},\"verify_shape\":null}";
const row = (id: string, summary: string, meta: Row): Row => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary, detected_at: "2026-10-14T19:03:40.966Z", classification_metadata: meta });
/** recommit-route-edit-7ffa6330-step-1-verify_failed as stored (no check_supply ledger). */
const live = (): Row => row(ID, "compose for gap route-edit-7ffa6330-step-1 repeated already-recorded failure class verify_failed: (fail) the gap's own check (src/resolvers/substrate-gap.test.ts) is still red on this draft", {
  edit_site: SITE, evidence_resolve: ER, falsifier: "class2", falsifier_position: "evidence_resolve.shape", falsifier_classified_at: "2026-10-21T01:09:12.724Z",
  predicate_source: "gap_falsify:inherit", predicate_birth_verdict: "present", predicate_birth_key: BIRTH_KEY,
  re_commit: true, source_gap_id: "route-edit-7ffa6330-step-1", root_gap_id: "route-edit-7ffa6330-step-1", failure_class: "verify_failed",
  failed_attempts: 6, last_failed_at: "2026-10-21T01:09:12.590Z", suspected_real_location: "src/resolvers/substrate-gap.ts:decomposition_gap_rejection", localized: true,
});
/** Its decompose child -step-1 as stored: the same check, held by its parent's predicate. */
const child = (): Row => row(CHILD, "decomposed step of the recommit", {
  edit_site: SITE, evidence_resolve: ER, falsifier: "class2", falsifier_position: "evidence_resolve.shape", predicate_source: "decompose", parent_gap_id: ID, predicate_birth_verdict: "present",
});
const control = (): Row => row(CONTROL, "the same check, sited at the module it tests", {
  edit_site: "repos/development-vessel/src/resolvers/substrate-gap.ts", evidence_resolve: ER, falsifier: "class2", falsifier_position: "evidence_resolve.shape", predicate_source: "operator", failed_attempts: 0,
});

const originalFetch = globalThis.fetch;
const savedPush = process.env["MITOSIS_DIRECT_PUSH"];
const savedStore = process.env["GAP_STORE_ENDPOINT"];
let gapStore: { restore: () => Promise<void> } | null = null;
const storeFile = (): string => join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
function plant(rows: Row[]): void {
  let all: Row[] = [];
  try { all = JSON.parse(readFileSync(storeFile(), "utf8")) as Row[]; } catch { all = []; }
  writeFileSync(storeFile(), JSON.stringify([...all.filter((r) => !rows.some((x) => x["id"] === r["id"])), ...rows], null, 2));
}
const stored = (id: string): Row => ((JSON.parse(readFileSync(storeFile(), "utf8")) as Row[]).find((r) => r["id"] === id) ?? {}) as Row;
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
async function pick(): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await g2f.resolveGapToFeature({ type: "gapToFeature" } as never); } finally { console.log = orig; }
  await sg.__settleBirthEvaluationsForTests();
  return lines;
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    throw new TypeError("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  g2fPolicy.__resetPolicyReadsForTests();
  // Landings stopped: admission admits nothing, so each pass ends at select without composing.
  process.env["MITOSIS_DIRECT_PUSH"] = "0";
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedPush === undefined) delete process.env["MITOSIS_DIRECT_PUSH"]; else process.env["MITOSIS_DIRECT_PUSH"] = savedPush;
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

describe("the auto-pick names and un-arms a row sited at its own check (the live rows' stored shape)", () => {
  it("[MUST-FAIL] both live rows are refused BY NAME at pick, though the lineage cap and the predicate hold catch them too", async () => {
    plant([live(), child(), control()]);
    const lines = await pick();
    expect(lines).toContain(`[check-supply] refused ${ID}: edit_site_is_own_check (${SITE})`);
    expect(lines).toContain(`[check-supply] refused ${CHILD}: edit_site_is_own_check (${SITE})`);
    expect(lines.some((l) => l.includes(`refused ${CONTROL}`))).toBe(false);
    // an own-check row holds nothing: the control is not "predicate held by" either live row
    expect(lines.some((l) => l.includes("predicate hold excluded") && (l.includes(`predicate held by ${ID}`) || l.includes(`predicate held by ${CHILD}`)))).toBe(false);
  });

  it("[MUST-FAIL] the ledger-less class2 row is un-armed: own_check_unarmed written, re-labelled unresolvable, and a second pass writes nothing", async () => {
    plant([live(), child(), control()]);
    const first = await pick();
    expect(first).toContain(`[check-supply] un-armed ${ID}: edit_site_is_own_check (${SITE})`);
    const m = metaOf(stored(ID));
    expect(m["own_check_unarmed"]).toMatchObject({ site: SITE, check: "src/resolvers/substrate-gap.test.ts", reason: "edit_site_is_own_check" });
    expect(m["falsifier"]).toBe("unresolvable");
    expect(String(m["falsifier_unresolvable_reason"])).toStartWith("edit_site_is_own_check:");
    const at = (m["own_check_unarmed"] as Row)["at"];
    const second = await pick();
    expect(second.filter((l) => l.startsWith(`[check-supply] un-armed ${ID}:`))).toEqual([]);
    expect(second).toContain(`[check-supply] refused ${ID}: edit_site_is_own_check (${SITE})`);
    expect((metaOf(stored(ID))["own_check_unarmed"] as Row)["at"]).toBe(at);
  });

  it("[CONTROL] the src-sited row of the same check is not written and stays class2", async () => {
    plant([live(), child(), control()]);
    await pick();
    const m = metaOf(stored(CONTROL));
    expect(m["own_check_unarmed"]).toBeUndefined();
    expect(m["falsifier"]).toBe("class2");
  });
});
