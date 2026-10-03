// CHECK-FIRST (RED) — gap_lifecycle_scan's expiry of orphaned_capability gaps reads the
// orphaned_capability_scan's per-tick scan-result record instead of gap age.
//
// Companion to orphaned-capability-scan-callers-history-lifecycle.test.ts, which pins the WRITER
// side (exactly one `orphanedCapabilityScanRecord_write` per emitting tick). This file pins the
// READER side and stands alone: no helper is shared with the scanner tests.
//
// CONTRACT: gap_lifecycle_scan takes the records as pointer.scan_records (newest last; each
// { detector, generated_at, orphans: [{ gap_id, shape, fingerprint }] }) and
// pointer.absent_scans_to_expire (N). For an orphaned_capability gap, when records are supplied:
// present in the LATEST record ⇒ never expired, whatever its age; absent from each of the latest
// N records ⇒ expired (closed_reason "expired_not_redetected"), whatever its age. No records ⇒
// the age rule is unchanged. How production loads the records when the pointer omits them is
// left to the fix.
//
// HERMETIC: temp gaps.json + proposals dir, WORKSPACE_ROOT at the temp dir (the scan appends its
// funnel history and landability log there), and a fetch spy (restored after each test) that
// answers every write. No live service, no /workspace, no DB.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";

type Gap = { id: string; status?: string; category?: string; summary?: string; classification_metadata?: Record<string, any> } & Record<string, any>;

const DEV = "http://dev-vessel.fixture.invalid/v2/impulses/resolve";
let ws = "";
let priorRoot: string | undefined;
let priorStoreEndpoint: string | undefined;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "gls-orphan-expiry-"));
  priorRoot = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
  // Only the gap-store holder writes; make sure this process is the holder.
  priorStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  if (priorRoot === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = priorRoot;
  if (priorStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = priorStoreEndpoint;
  rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// gap_lifecycle_scan's expiry, decided by the scan-result records rather than by gap age.
//
// gap-lifecycle-scan.ts's expired_not_redetected pass (the write at :583) decides by AGE only
// (updated_at older than detectorExpireHours) — and its own summary admits "a detector that never
// ran is indistinguishable from a defect that was repaired". Once the orphan scan stops re-writing
// unchanged gaps (its flood guard), age alone would expire every live orphan. The decision is
// inline in resolveGapLifecycleScan (no narrower export exists), so it is driven through that
// function with a temp gaps.json, a temp proposals dir, WORKSPACE_ROOT at the temp dir, a fetch
// spy for every write, and the records injected as pointer.scan_records.
// ---------------------------------------------------------------------------------------------

describe("gap-lifecycle-scan: orphan expiry reads the per-tick scan-result record", () => {
  const H = 3_600_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  function orphanGap(shape: string, updatedMsAgo: number): Gap {
    return {
      id: `orphaned-capability-${shape}`,
      category: "orphaned_capability",
      source: "substrate_detected",
      status: "open",
      summary: `Resolver "${shape}" is live but uncalled`,
      created_at: iso(updatedMsAgo + H),
      updated_at: iso(updatedMsAgo),
      // attempt evidence, so hasNoAttemptEvidence() does not exempt it from expiry
      classification_metadata: { shape, failed_attempts: 1 },
    };
  }
  const record = (gapIds: string[], minutesAgo: number) => ({
    detector: "orphaned_capability_scan",
    generated_at: iso(minutesAgo * 60_000),
    orphans: gapIds.map((gap_id) => ({ gap_id, shape: gap_id.replace(/^orphaned-capability-/, ""), fingerprint: "fp" })),
  });

  async function runLifecycle(gaps: Gap[], extra: Record<string, unknown>): Promise<{ expired: string[]; body: any }> {
    mkdirSync(join(ws, "gaps"), { recursive: true });
    mkdirSync(join(ws, "proposals", ".applied"), { recursive: true });
    const gapsPath = join(ws, "gaps", "gaps.json");
    writeFileSync(gapsPath, JSON.stringify(gaps));
    const writes: Gap[] = [];
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      const ptr = b?.impulse?.pointer ?? {};
      if (ptr.type === "substrateGap_write" && ptr.gap) writes.push(ptr.gap);
      return new Response(JSON.stringify({ shape: "ok", body: {} }), { status: 200 });
    }) as unknown as typeof fetch);
    const r = (await resolveGapLifecycleScan({
      type: "gap_lifecycle_scan",
      gapsPath,
      proposalsDir: join(ws, "proposals"),
      staleHours: 48,
      autoClose: true,
      falsify: false,
      devVesselImpulsesUrl: DEV,
      ...extra,
    } as never)) as { body: any };
    const expired = writes
      .filter((w) => w.status === "closed" && w.classification_metadata?.closed_reason === "expired_not_redetected")
      .map((w) => w.id);
    return { expired, body: r.body };
  }

  it("MUST-FAIL: an orphan gap still present in the LATEST scan record does not expire, however old", async () => {
    const old = orphanGap("still_here", 400 * H); // far past every age threshold
    const recs = [record(["orphaned-capability-other"], 30), record(["orphaned-capability-other"], 20), record([old.id], 10)];
    const { expired } = await runLifecycle([old], { scan_records: recs, absent_scans_to_expire: 3 });
    expect(expired).not.toContain(old.id);
  });

  it("MUST-FAIL: an orphan gap absent from N consecutive scan records expires, however fresh", async () => {
    const fresh = orphanGap("gone_quiet", 60_000); // touched a minute ago
    const recs = [record([fresh.id], 40), record(["orphaned-capability-other"], 30), record(["orphaned-capability-other"], 20), record(["orphaned-capability-other"], 10)];
    const { expired } = await runLifecycle([fresh], { scan_records: recs, absent_scans_to_expire: 3 });
    expect(expired).toContain(fresh.id);
  });

  it("control: absent from only N-1 records, a fresh orphan gap does not expire", async () => {
    const fresh = orphanGap("briefly_quiet", 60_000);
    const recs = [record([fresh.id], 30), record(["orphaned-capability-other"], 20), record(["orphaned-capability-other"], 10)];
    const { expired } = await runLifecycle([fresh], { scan_records: recs, absent_scans_to_expire: 3 });
    expect(expired).not.toContain(fresh.id);
  });

  it("control: with no scan records supplied, the age rule is unchanged (an old orphan gap expires)", async () => {
    const old = orphanGap("aged_out", 400 * H);
    const { expired } = await runLifecycle([old], {});
    expect(expired).toContain(old.id);
  });
});
