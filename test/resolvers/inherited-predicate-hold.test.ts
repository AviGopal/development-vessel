// ONE LIVE GAP PER (LINEAGE, CHECK) (qa F1, 10-02). A narrowed or recommit child born with its parent's check
// is the same predicate as its parent and siblings; auto-picking all of them split attempts and spend three
// ways on one check. While a workable inherited child is open it holds the predicate: the parent and siblings
// with a byte-identical evidence_resolve are not auto-pickable ("predicate held by <child>").
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `pred-hold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { inheritedPredicateHolds } = g2f;
const { class2PredicateKey } = sg;

const ER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" };
const OTHER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > c"] }, zero_field: "requested_not_passing" };
const SITE = "repos/activity-api/src/a.ts";
const gap = (id: string, meta: Record<string, unknown>) => ({ id, status: "open", classification_metadata: { edit_site: SITE, falsifier: "class2", ...meta } });
const parent = gap("P", { evidence_resolve: ER, failed_attempts: 7 });
const inherited = (id: string, up: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  gap(id, { evidence_resolve: ER, predicate_source: "gap_falsify:inherit", predicate_birth_verdict: "present", predicate_birth_key: class2PredicateKey({ evidence_resolve: ER }), ...up, ...extra });

describe("inheritedPredicateHolds", () => {
  it("the narrowed child holds: the parent and the recommit sibling with the identical check are held by it", () => {
    const held = inheritedPredicateHolds([parent, inherited("P-narrowed", { parent_gap_id: "P" }), inherited("recommit-P-verify_failed", { source_gap_id: "P" })]);
    expect(Object.fromEntries(held)).toEqual({ P: "P-narrowed", "recommit-P-verify_failed": "P-narrowed" });
  });

  it("a recommit child alone holds its parent; a recommit of the narrowed child is the same lineage", () => {
    expect(Object.fromEntries(inheritedPredicateHolds([parent, inherited("recommit-P-x", { source_gap_id: "P" })]))).toEqual({ P: "recommit-P-x" });
    const held = inheritedPredicateHolds([parent, inherited("P-narrowed", { parent_gap_id: "P" }), inherited("recommit-P-narrowed-x", { source_gap_id: "P-narrowed" })]);
    expect(held.get("P")).toBe("P-narrowed");
    expect(held.get("recommit-P-narrowed-x")).toBe("P-narrowed");
  });

  it("a gap of the lineage with a DIFFERENT check, and another lineage with the same check, are not held", () => {
    const held = inheritedPredicateHolds([parent, inherited("P-narrowed", { parent_gap_id: "P" }), gap("P-step-1", { evidence_resolve: OTHER, parent_gap_id: "P", predicate_source: "decompose" }), gap("Q", { evidence_resolve: ER })]);
    expect(Object.fromEntries(held)).toEqual({ P: "P-narrowed" });
  });

  it("a child that cannot work holds nothing: suspect check, operator hold, parking disposition", () => {
    for (const extra of [{ predicate_birth_verdict: "absent" }, { operator_hold: true }, { disposition: "awaiting_operator_review" }]) {
      expect(inheritedPredicateHolds([parent, inherited("P-narrowed", { parent_gap_id: "P" }, extra)]).size).toBe(0);
    }
  });

  it("a child carrying the check by its own authorship (not inherited) holds nothing", () => {
    expect(inheritedPredicateHolds([parent, gap("P-narrowed", { evidence_resolve: ER, parent_gap_id: "P" })]).size).toBe(0);
  });
});

describe("auto-pick reads the hold before admission (wiring)", () => {
  const originalFetch = globalThis.fetch;
  const savedPush = process.env["MITOSIS_DIRECT_PUSH"];
  const savedStore = process.env["GAP_STORE_ENDPOINT"];
  beforeAll(() => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const root = sg.gapStoreRootForTest();
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
    mkdirSync(join(root, "gaps"), { recursive: true });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
        return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      }
      if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
      // Unreachable elsewhere, as in the landings-stopped admission test: the llm-producer probe fails open.
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    sg.__setBirthJudgeForTests(async () => "present");
    g2fPolicy.__resetPolicyReadsForTests();
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    sg.__setBirthJudgeForTests(null);
    if (savedPush === undefined) delete process.env["MITOSIS_DIRECT_PUSH"]; else process.env["MITOSIS_DIRECT_PUSH"] = savedPush;
    if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  });
  it("the parent of an open inherited child is excluded from auto-pick with 'predicate held by <child>'", async () => {
    const run = Math.random().toString(36).slice(2, 8);
    const pid = `ph-${run}`;
    const write = async (id: string, meta: Record<string, unknown>) => {
      const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `hold fixture ${id}`, classification_metadata: { edit_site: SITE, evidence_resolve: ER, ...meta } } } as never);
      if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
    };
    await write(pid, {});
    await write(`${pid}-narrowed`, { parent_gap_id: pid, predicate_source: "gap_falsify:inherit" });
    await sg.__settleBirthEvaluationsForTests();
    // Landings stopped: admission admits nothing, so the pass ends at select without composing.
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try { await g2f.resolveGapToFeature({ type: "gapToFeature" } as never); } finally { console.log = orig; }
    const hold = lines.find((l) => l.includes("predicate hold excluded"));
    expect(hold).toBeDefined();
    expect(hold).toContain(`${pid}: predicate held by ${pid}-narrowed`);
    expect(hold).not.toContain(`${pid}-narrowed: predicate held`);
  });
});
