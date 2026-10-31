// THE DOCS-ALIGN BRIDGE COUNTS ONLY THE GAP WRITES THE STORE ACCEPTED.
//
// docs_align_bridge discarded each substrateGap_write answer and counted every source as an emitted gap, so a refused
// write read as a gap filed, and docsAlignTickReport's gaps_emitted/sources claimed rows the store never took. A
// read-back of the report could not tell a filed gap from a refused one. Now the report lists the accepted writes
// (the row each landed on, its action, and updated_at only when the answer carries one), and lists the rest apart.
//
//   [MUST-FAIL, real store, no seam] a write the store REFUSES (an open re-emission onto a held, closed row) is not
//               counted and is listed under refused; a fresh source beside it is counted (on the parent: both counted).
//   [MUST-FAIL] a rejection answer that still names the gap id is not acceptance (an id in the answer is not a save).
//   [MUST-FAIL] a write still queued for replay (gap_store_unavailable, queued:true) is not counted.
//   [MUST-FAIL] compose_nudge_triggered for this gap is a saved write: counted; gap_service_start_failed comes after
//               the save, so it is listed as saved_unconfirmed and not counted.
//   [CONTROL]   an accepted write is counted and listed with the updated_at its answer returned; with none, none.
//   [CONTROL]   a dry run writes nothing and counts nothing.
//   [MUST-FAIL] docs_align_tick's report carries the bridge's writes / saved_unconfirmed / refused lists (the walk reads
//               the TICK's report, never the bridge's), each write naming a row the gap store holds.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

// THE STORE IS HELD HERE, under this suite's temp root (see substrate-gap.test.ts for why each of these is set).
const savedGapStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
afterAll(() => { if (savedGapStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedGapStoreEndpoint; });
const gapEventPublishStub = stubGapEventPublish();
afterAll(() => gapEventPublishStub.restore());
const savedSkip = process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
afterAll(() => { if (savedSkip === undefined) delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"]; else process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = savedSkip; });
const testWorkspace = join(tmpdir(), `dv-docs-align-bridge-test-${Date.now()}`);
process.env["WORKSPACE_ROOT"] = testWorkspace;
isolateLearnedStateInProcess(process.env["WORKSPACE_ROOT"]!);

const gapMod = await import("../../src/resolvers/substrate-gap.js");
if (!gapMod.isScratchGapStoreRoot(gapMod.gapStoreRootForTest())) {
  throw new Error(`refusing to run: gap store ${gapMod.gapStoreRootForTest()} is not a scratch root`);
}
const { resolveSubstrateGapWrite, resolveSubstrateGap } = gapMod;
const { resolveDocsAlignBridge } = await import("../../src/resolvers/docs-align-bridge.js");

const tok = () => Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

// The tick reads its doc root once, at module load: a fresh import over a temp tree with one doc that cites a missing
// script (a setup_enablement finding). Its outbound reads (registry, vocabulary, scan self-calls) are answered 503, so
// nothing leaves the process; the bridge's gap write is in-process, to the scratch store above.
const docRoot = mkdtempSync(join(tmpdir(), "dv-docs-align-tick-root-"));
afterAll(() => rmSync(docRoot, { recursive: true, force: true }));
const tickDoc = `docs/tick${tok()}.md`;
mkdirSync(join(docRoot, "docs"), { recursive: true });
mkdirSync(join(docRoot, "scripts"), { recursive: true });
writeFileSync(join(docRoot, tickDoc), "# Setup\n\nRun `scripts/does-not-exist-anywhere.sh` to bring it up.\n");
const savedDocRoot = process.env["DOC_FIX_ROOT"];
process.env["DOC_FIX_ROOT"] = docRoot;
const { resolveDocsAlignTick } = await import(`../../src/resolvers/docs-align-tick.js?${"bridge-accepted-writes"}`);
if (savedDocRoot === undefined) delete process.env["DOC_FIX_ROOT"]; else process.env["DOC_FIX_ROOT"] = savedDocRoot;

type Body = { gaps_emitted: number; sources: string[]; writes?: Array<{ gap_id: string; action: string; updated_at?: string }>; refused?: Array<{ gap_id: string; reason: string }>; saved_unconfirmed?: Array<{ gap_id: string; reason: string }>; dry_run: boolean };
const finding = (source: string) => ({ doc_id: source, invariant: "setup_enablement", evidence: `a claim in ${source}`, suggested_repair: "fix it", source });
const slug = (s: string) => "docs-drift-" + s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
// Letters only: a digit run in a source would be stripped as a volatile token and merge the ids into one class.

describe("docs_align_bridge counts only accepted gap writes (real gap store)", () => {
  it("MUST-FAIL: an open re-emission onto a held, closed row is refused, not counted; a fresh source is counted", async () => {
    const held = `docs/held${tok()}.md`;
    const fresh = `docs/fresh${tok()}.md`;
    const heldId = slug(held);
    // A held row the operator closed: an open write without the marker may not change its status.
    const created = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: heldId, category: "documentation_drift", source: "substrate_detected", status: "open", detected_at: new Date().toISOString(), summary: `documentation drift in ${held}: 1 invariant violation(s) [setup_enablement]`, classification_metadata: { doc_path: held, operator_hold: true } } } as never);
    expect(created.shape).toBe("substrateGapWriteResult");
    const closed = await resolveSubstrateGapWrite({ type: "substrateGap_write", operator: "operator:test", gap: { id: heldId, category: "documentation_drift", source: "substrate_detected", status: "closed", detected_at: new Date().toISOString(), summary: `documentation drift in ${held}: 1 invariant violation(s) [setup_enablement]`, classification_metadata: { doc_path: held, operator_hold: true, closed_reason: "test fixture: closed under hold" } } } as never);
    expect(closed.shape).toBe("substrateGapWriteResult");

    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", findings: [finding(held), finding(fresh)] });
    const b = r.body as Body;
    expect(r.shape).toBe("docsAlignBridgeReport");
    expect(b.gaps_emitted).toBe(1);
    expect(b.sources).toEqual([fresh]);
    expect(b.refused?.map((x) => x.gap_id)).toEqual([heldId]);
    expect(b.refused?.[0]?.reason).toContain("validation_rejected");
    expect(b.writes?.map((w) => [w.gap_id, w.action])).toEqual([[slug(fresh), "created"]]);
  });
});

describe("docs_align_bridge classifies every gap write answer (injected write)", () => {
  const answers = (byId: Record<string, { shape: string; body: unknown }>) =>
    (async (p: { gap: { id: string } }) => byId[p.gap.id] ?? { shape: "substrateGapWriteResult", body: { id: p.gap.id, action: "created" } }) as never;

  it("MUST-FAIL: a rejection answer that names the gap id is not counted", async () => {
    const a = "docs/a.md", c = "docs/c.md";
    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", findings: [finding(a), finding(c)] }, answers({
      [slug(a)]: { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "no_op", id: slug(a), action: "skipped", skip_reason: "status_precondition_failed" } },
      [slug(c)]: { shape: "substrateGapWriteResult", body: { id: slug(c), action: "rejected" } },
    }));
    const b = r.body as Body;
    expect(b.gaps_emitted).toBe(0);
    expect(b.sources).toEqual([]);
    expect(b.refused?.map((x) => x.gap_id).sort()).toEqual([slug(a), slug(c)].sort());
  });

  it("MUST-FAIL: a write still queued for replay is not counted", async () => {
    const q = "docs/q.md";
    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", findings: [finding(q)] }, answers({
      [slug(q)]: { shape: "structuredError", body: { resolver: "substrateGap_write", failure_mode: "gap_store_unavailable", queued: true } },
    }));
    const b = r.body as Body;
    expect(b.gaps_emitted).toBe(0);
    expect(b.refused?.[0]?.reason).toContain("queued, not applied");
  });

  it("MUST-FAIL: compose_nudge_triggered for this gap counts; gap_service_start_failed is saved_unconfirmed, not counted", async () => {
    const n = "docs/n.md", f = "docs/f.md", other = "docs/o.md";
    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", findings: [finding(n), finding(f), finding(other)] }, answers({
      [slug(n)]: { shape: "compose_nudge_triggered", body: { gapId: slug(n) } },
      [slug(f)]: { shape: "structuredError", body: { error: "gap_service_start_failed", message: "exit code: 1" } },
      [slug(other)]: { shape: "compose_nudge_triggered", body: { gapId: "some-other-gap" } },
    }));
    const b = r.body as Body;
    expect(b.gaps_emitted).toBe(1);
    expect(b.writes?.map((w) => w.gap_id)).toEqual([slug(n)]);
    expect(b.saved_unconfirmed?.map((x) => [x.gap_id, x.reason])).toEqual([[slug(f), "gap_service_start_failed"]]);
    expect(b.refused?.map((x) => x.gap_id)).toEqual([slug(other)]);
  });

  it("CONTROL: an accepted write is counted with the updated_at its answer returned, and none when it returned none", async () => {
    const u = "docs/u.md", v = "docs/v.md";
    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", findings: [finding(u), finding(v)] }, answers({
      [slug(u)]: { shape: "substrateGapWriteResult", body: { id: slug(u), action: "updated", updated_at: "2026-10-31T04:40:14.218Z" } },
      [slug(v)]: { shape: "substrateGapWriteResult", body: { id: slug(v), action: "created" } },
    }));
    const b = r.body as Body;
    expect(b.gaps_emitted).toBe(2);
    expect(b.sources).toEqual([u, v]);
    expect(b.writes).toEqual([
      { gap_id: slug(u), source: u, action: "updated", updated_at: "2026-10-31T04:40:14.218Z" },
      { gap_id: slug(v), source: v, action: "created" },
    ] as never);
    expect(b.refused).toEqual([]);
  });

  it("CONTROL: a dry run writes nothing and counts nothing", async () => {
    let calls = 0;
    const r = await resolveDocsAlignBridge({ type: "docs_align_bridge", dry_run: true, findings: [finding("docs/d.md")] }, (async () => { calls += 1; return { shape: "substrateGapWriteResult", body: {} }; }) as never);
    const b = r.body as Body;
    expect(calls).toBe(0);
    expect(b.dry_run).toBe(true);
    expect(b.gaps_emitted).toBe(0);
    expect(b.sources).toEqual(["docs/d.md"]);
  });
});

describe("docs_align_tick carries the bridge's per-write lists", () => {
  it("MUST-FAIL: the tick report lists the accepted writes, and each names a row the gap store holds", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    let r: { shape: string; body: unknown };
    try {
      r = await resolveDocsAlignTick({ type: "docs_align_tick" });
    } finally {
      globalThis.fetch = realFetch;
    }
    const b = r.body as Body & { findings: number };
    expect(r.shape).toBe("docsAlignTickReport");
    expect(b.findings).toBeGreaterThan(0);
    expect(Array.isArray(b.writes)).toBe(true);
    expect(Array.isArray(b.refused)).toBe(true);
    expect(Array.isArray(b.saved_unconfirmed)).toBe(true);
    expect(b.writes!.map((w) => w.gap_id)).toContain(slug(tickDoc));
    expect(b.gaps_emitted).toBe(b.writes!.length);
    const read = await resolveSubstrateGap({ type: "substrateGap", id: slug(tickDoc) } as never);
    const rows = (read.body as { gaps?: Array<{ id: string; category?: string }> }).gaps ?? [];
    expect(rows.map((g) => [g.id, g.category])).toEqual([[slug(tickDoc), "documentation_drift"]]);
  });
});
