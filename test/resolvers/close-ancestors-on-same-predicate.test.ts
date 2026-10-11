// A CHILD'S VERIFIED CLOSE CLOSES ITS SAME-PREDICATE ANCESTORS (qa F2, 10-02).
// A narrowed or recommit child carries its parent's check byte-identically and holds it from auto-pick. When the
// child closes landed_verified on its own exercised check, the parent (and further ancestors) with the IDENTICAL
// evidence_resolve close on that measurement: closed_via_child, the child's falsifier_exercise carried. An
// ancestor whose check differs is never closed. Driven against the real (temp) gap store.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `close-anc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fLanding = await import("../../src/judge/gap-landing-verdict.js");
const g2fCredit = await import("../../src/judge/gap-attempt-credit.js");
const RUN = Math.random().toString(36).slice(2, 8);

const ER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" };
const OTHER = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/a.test.ts", only_tests: ["a > c"] }, zero_field: "requested_not_passing" };
const SITE = "repos/activity-api/src/a.ts";
const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
type Row = Record<string, unknown>;

// Leave the shared gap store as this file found it (test/resolvers/gap-store-snapshot.ts).
let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async () => Response.json({ content: { vessels: [] } })) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

async function write(id: string, meta: Row): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `ancestor fixture ${id}`, classification_metadata: { edit_site: SITE, ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function row(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0]!;
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
const EXERCISE = { detector: "gap-sweep", verdict: "absent", passed: true, ran_at: "2026-10-02T15:00:00.000Z", commit: "abc1234def" };
const childClose = (up: Row, extra: Row = {}): Row => ({ evidence_resolve: ER, closed_reason: "landed_verified", close_basis: "absent", falsifier_exercise: EXERCISE, ...up, ...extra });

describe("closeAncestorsOnSamePredicate", () => {
  it("a narrowed child's verified close closes its parent on the same predicate, carrying the child's exercise", async () => {
    const p = `ca-p-${RUN}`;
    await write(p, { evidence_resolve: ER, failed_attempts: 7 });
    const closed = await g2fLanding.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose({ parent_gap_id: p }));
    expect(closed).toEqual([p]);
    const r = await row(p);
    expect(r["status"]).toBe("closed");
    const m = metaOf(r);
    expect(m["closed_reason"]).toBe("closed_via_child");
    expect(m["resolution"]).toBe(`closed via child ${p}-narrowed: same predicate exercised`);
    expect((m["falsifier_exercise"] as Row)["commit"]).toBe("abc1234def");
    expect((m["falsifier_exercise"] as Row)["verdict"]).toBe("absent");
    expect((m["falsifier_exercise"] as Row)["via_child"]).toBe(`${p}-narrowed`);
  });

  it("walks the lineage: a recommit of the narrowed child closes both the narrowed child and the root", async () => {
    const p = `ca-chain-${RUN}`;
    await write(p, { evidence_resolve: ER });
    await write(`${p}-narrowed`, { evidence_resolve: ER, parent_gap_id: p, predicate_source: "gap_falsify:inherit" });
    const closed = await g2fLanding.closeAncestorsOnSamePredicate(`recommit-${p}-narrowed-x`, childClose({ source_gap_id: `${p}-narrowed` }));
    expect(closed).toEqual([`${p}-narrowed`, p]);
  });

  it("never closes an ancestor whose check differs", async () => {
    const p = `ca-diff-${RUN}`;
    await write(p, { evidence_resolve: OTHER });
    expect(await g2fLanding.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose({ parent_gap_id: p }))).toEqual([]);
    expect((await row(p))["status"]).toBe("open");
  });

  it("closes nothing unless the child's own check was exercised and passed on a verified landing", async () => {
    const p = `ca-unex-${RUN}`;
    await write(p, { evidence_resolve: ER });
    for (const extra of [{ closed_reason: "landed_literal_only" }, { falsifier_exercise: { ...EXERCISE, passed: false } }, { falsifier_exercise: { ...EXERCISE, verdict: "unknown" } }, { falsifier_exercise: undefined }]) {
      expect(await g2fLanding.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose({ parent_gap_id: p }, extra))).toEqual([]);
    }
    expect((await row(p))["status"]).toBe("open");
  });

  it("leaves an operator-held ancestor open", async () => {
    const p = `ca-held-${RUN}`;
    await write(p, { evidence_resolve: ER, operator_hold: true });
    expect(await g2fLanding.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose({ parent_gap_id: p }))).toEqual([]);
    expect((await row(p))["status"]).toBe("open");
  });

  it("race: an ancestor closed by another writer between the read and the close keeps its own close; the walk stops", async () => {
    const p = `ca-race-close-${RUN}`;
    await write(p, { evidence_resolve: ER });
    await write(`${p}-narrowed`, { evidence_resolve: ER, parent_gap_id: p, predicate_source: "gap_falsify:inherit" });
    g2fLanding.__setAncestorCloseRaceHookForTests(async (id) => {
      if (id !== `${p}-narrowed`) return;
      const cur = await row(id);
      await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...cur, status: "closed", classification_metadata: { ...metaOf(cur), closed_reason: "landed_verified", landed_sha: "fff0000" } } } as never);
    });
    try {
      expect(await g2fLanding.closeAncestorsOnSamePredicate(`recommit-${p}-narrowed-x`, childClose({ source_gap_id: `${p}-narrowed` }))).toEqual([]);
    } finally { g2fLanding.__setAncestorCloseRaceHookForTests(null); }
    const n = metaOf(await row(`${p}-narrowed`));
    expect(n["closed_reason"]).toBe("landed_verified");
    expect(n["landed_sha"]).toBe("fff0000");
    expect(n["closed_via_child"]).toBeUndefined();
    // The walk stopped at the skipped ancestor: the root above it is untouched.
    expect((await row(p))["status"]).toBe("open");
  });

  it("race: a bump of the ancestor around the close neither blocks it nor reopens it", async () => {
    const p = `ca-race-bump-${RUN}`;
    await write(p, { evidence_resolve: ER, failed_attempts: 5 });
    const snapshot = JSON.parse(JSON.stringify(await row(p))) as Row;
    // A bump that lands between the read and the close leaves the row open: the close still applies.
    g2fLanding.__setAncestorCloseRaceHookForTests(async (id) => {
      if (id !== p) return;
      const cur = await row(id);
      await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...cur, status: "open", classification_metadata: { ...metaOf(cur), failed_attempts: 6 } } } as never);
    });
    try {
      expect(await g2fLanding.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose({ parent_gap_id: p }))).toEqual([p]);
    } finally { g2fLanding.__setAncestorCloseRaceHookForTests(null); }
    // A bump that read the row before the close and writes after it is a no-op, not a reopen.
    await g2fCredit.bumpFailedAttempts(snapshot, { escalate: g2f.escalateToDecomposition });
    const r = await row(p);
    expect(r["status"]).toBe("closed");
    expect(metaOf(r)["closed_reason"]).toBe("closed_via_child");
  });
});
