// A VERIFIED CLOSE CASCADES DOWN TO OPEN SAME-PREDICATE DESCENDANTS (gap: a-landed-verified-close-cascades-to-
// ancestors-only-so-the-closed-rows-open-recommit-children-keep-being-picked). A recommit-<id>-<cls> child
// (source_gap_id) or a -narrowed child (parent_gap_id) carries its parent's check byte-identically. When the parent
// closes landed_verified on that exercised check, the child's defect is measured absent too: it is closed
// closed_via_parent with the parent's falsifier_exercise, so auto-pick admission (open rows only) stops picking it.
// A child on a DIFFERENT check, or a different edit_site, stays open. Driven against the real (temp) gap store.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `close-desc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fLanding = await import("../../src/judge/gap-landing-verdict.js");
const RUN = Math.random().toString(36).slice(2, 8);

const ER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" };
const OTHER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > c"] }, zero_field: "requested_not_passing" };
const SITE = "repos/activity-api/src/a.ts";
const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
type Row = Record<string, unknown>;

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async () => Response.json({ content: { vessels: [] } })) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

async function write(id: string, meta: Row): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `descendant fixture ${id}`, classification_metadata: { edit_site: SITE, ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function row(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0]!;
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
const EXERCISE = { detector: "gap-sweep", verdict: "absent", passed: true, ran_at: "2026-10-02T15:00:00.000Z", commit: "abc1234def" };
const parentClose = (extra: Row = {}): Row => ({ edit_site: SITE, evidence_resolve: ER, closed_reason: "landed_verified", close_basis: "absent", falsifier_exercise: EXERCISE, ...extra });

describe("closeDescendantsOnSamePredicate", () => {
  it("a landed_verified close closes its open same-predicate recommit and narrowed children; a different-predicate child stays open", async () => {
    expect(typeof (g2fLanding as Row)["closeDescendantsOnSamePredicate"]).toBe("function");
    const p = `cd-p-${RUN}`;
    const same = `recommit-${p}-syntax_break`;
    const narrowed = `${p}-narrowed`;
    const grand = `recommit-${p}-narrowed-verify_failed`;
    const other = `recommit-${p}-verify_failed`;
    const otherSite = `recommit-${p}-anchor_not_found`;
    await write(same, { evidence_resolve: ER, source_gap_id: p, re_commit: true, failure_class: "syntax_break" });
    await write(narrowed, { evidence_resolve: ER, parent_gap_id: p, predicate_source: "gap_falsify:inherit" });
    await write(grand, { evidence_resolve: ER, source_gap_id: narrowed, re_commit: true });
    await write(other, { evidence_resolve: OTHER, source_gap_id: p, re_commit: true });
    await write(otherSite, { evidence_resolve: ER, source_gap_id: p, edit_site: "repos/activity-api/src/b.ts" });
    const closed = await (g2fLanding as unknown as { closeDescendantsOnSamePredicate: (id: string, m: Row) => Promise<string[]> }).closeDescendantsOnSamePredicate(p, parentClose());
    expect([...closed].sort()).toEqual([grand, narrowed, same].sort());
    for (const id of [same, narrowed, grand]) {
      const r = await row(id);
      expect(r["status"]).toBe("closed");
      const m = metaOf(r);
      expect(m["closed_reason"]).toBe("closed_via_parent");
      expect((m["falsifier_exercise"] as Row)["verdict"]).toBe("absent");
      expect((m["falsifier_exercise"] as Row)["commit"]).toBe("abc1234def");
      expect((m["falsifier_exercise"] as Row)["via_parent"]).toBe(p);
    }
    expect((await row(other))["status"]).toBe("open");
    expect((await row(otherSite))["status"]).toBe("open");
  });

  it("closes nothing unless the parent's own check was exercised and passed on a verified landing", async () => {
    expect(typeof (g2fLanding as Row)["closeDescendantsOnSamePredicate"]).toBe("function");
    const p = `cd-unex-${RUN}`;
    const c = `recommit-${p}-syntax_break`;
    await write(c, { evidence_resolve: ER, source_gap_id: p });
    const fn = (g2fLanding as unknown as { closeDescendantsOnSamePredicate: (id: string, m: Row) => Promise<string[]> }).closeDescendantsOnSamePredicate;
    for (const extra of [{ closed_reason: "landed_literal_only" }, { falsifier_exercise: { ...EXERCISE, passed: false } }, { falsifier_exercise: undefined }]) {
      expect(await fn(p, parentClose(extra))).toEqual([]);
    }
    expect((await row(c))["status"]).toBe("open");
  });

  it("leaves an operator-held child open", async () => {
    expect(typeof (g2fLanding as Row)["closeDescendantsOnSamePredicate"]).toBe("function");
    const p = `cd-held-${RUN}`;
    const c = `recommit-${p}-syntax_break`;
    await write(c, { evidence_resolve: ER, source_gap_id: p, operator_hold: true });
    const fn = (g2fLanding as unknown as { closeDescendantsOnSamePredicate: (id: string, m: Row) => Promise<string[]> }).closeDescendantsOnSamePredicate;
    expect(await fn(p, parentClose())).toEqual([]);
    expect((await row(c))["status"]).toBe("open");
  });
});
