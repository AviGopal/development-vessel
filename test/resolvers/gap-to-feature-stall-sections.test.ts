// A STALL INSIDE A gap_to_feature PASS NAMES THE PHASE (lib/loop-stall.ts duringActivity, gap-to-feature.ts sections).
//
// Live: event-loop stalls of 15-23 s overlapped an in-flight gap_to_feature resolve on both nodes, and the [loop-stall]
// line could name only the resolve, never which phase of the pick held the loop. The pass now enters one named activity
// per phase ("gap_to_feature:<phase>"), so the line names the phase (in flight, or ended as the loop resumed), and the
// line's suspect field names the innermost entry that was running when the loop blocked.
//
// The block is planted through an EXISTING seam: the autonomy scope's live read (__setAutonomyScopeDepsForTests), which
// admitActionableGaps calls once per pass, holds the loop synchronously, as a sync child with no timeout would. The
// scope answers unreadable, so admission admits nothing and the pass ends at select without composing.
// CONTROLS: the same pass with no block logs no line; a resolveDispatch entry is still named as last activity.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = join(tmpdir(), `g2f-stall-sections-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const policy = await import("../../src/judge/gap-policy.js");
const ls = await import("../../src/lib/loop-stall.js");

const BLOCK_MS = 2_500;
const THRESHOLD_MS = 1_000;
const originalFetch = globalThis.fetch;
const savedPush = process.env["MITOSIS_DIRECT_PUSH"];
const savedStore = process.env["GAP_STORE_ENDPOINT"];
let gapStore: { restore: () => Promise<void> } | null = null;

/** The scope's live read: optionally hold the loop once, then answer unreadable (admission admits nothing). */
function scopeRead(block: boolean): void {
  let held = !block;
  policy.__setAutonomyScopeDepsForTests({
    live: async () => {
      if (!held) { held = true; Bun.sleepSync(BLOCK_MS); }
      return { excluded: [], readable: false, reason: "test fixture: unreadable" };
    },
  });
}
/** One auto-pick pass under a monitor with a short threshold; returns the [loop-stall] lines. */
async function monitoredPass(): Promise<string[]> {
  ls.stopLoopStallMonitor();
  const lines: string[] = [];
  ls.startLoopStallMonitor({ thresholdMs: THRESHOLD_MS, intervalMs: 100, log: (l) => lines.push(l) });
  const log = console.log;
  console.log = () => { /* the pass's own lines are not the subject */ };
  try {
    await Bun.sleep(250);
    await g2f.resolveGapToFeature({ type: "gapToFeature", dry_run: true } as never);
    await Bun.sleep(400);
  } finally { console.log = log; ls.stopLoopStallMonitor(); }
  return lines;
}

beforeAll(async () => {
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
  policy.__resetPolicyReadsForTests();
  // Landings not stopped, so admission reaches its scope read (an explicit "0" would return before it).
  delete process.env["MITOSIS_DIRECT_PUSH"];
  // Warm-up pass, unmonitored: first-call module loads are not the subject.
  scopeRead(false);
  const log = console.log;
  console.log = () => {};
  try { await g2f.resolveGapToFeature({ type: "gapToFeature", dry_run: true } as never); } finally { console.log = log; }
});
afterAll(async () => {
  ls.stopLoopStallMonitor();
  policy.__setAutonomyScopeDepsForTests(null);
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  if (savedPush === undefined) delete process.env["MITOSIS_DIRECT_PUSH"]; else process.env["MITOSIS_DIRECT_PUSH"] = savedPush;
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

describe("a stall inside a gap_to_feature pass names the phase that held the loop", () => {
  it("[MUST-FAIL] a synchronous block inside the admission call is named gap_to_feature:eligibility_pass in the [loop-stall] line", async () => {
    scopeRead(true);
    const lines = await monitoredPass();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(Number(/blocked (\d+)ms/.exec(lines[0]!)?.[1] ?? 0)).toBeGreaterThanOrEqual(THRESHOLD_MS);
    // In flight, or ended as the loop resumed: either field names the section with its age.
    expect(lines[0]).toMatch(/(still in flight|ended as the loop resumed): [^;]*gap_to_feature:eligibility_pass@\d+ms/);
  }, 20_000);

  it("[MUST-FAIL] the line's suspect is that section, the innermost entry running when the loop blocked", async () => {
    scopeRead(true);
    const lines = await monitoredPass();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatch(/; suspect: gap_to_feature:eligibility_pass@\d+ms$/);
  }, 20_000);

  it("[MUST-FAIL] the suspect is the innermost entry covering the block, not one entered after it (lib)", async () => {
    ls.stopLoopStallMonitor();
    const lines: string[] = [];
    ls.startLoopStallMonitor({ thresholdMs: 300, intervalMs: 100, log: (l) => lines.push(l) });
    try {
      await Bun.sleep(250);
      const outer = ls.noteActivity("outer_resolve");
      const inner = ls.noteActivity("outer_resolve:phase");
      Bun.sleepSync(1_000);
      inner();
      // Entered after the block, before the monitor runs: it is the LAST activity, and must not be the suspect.
      const queued = ls.noteActivity("queued_resolve");
      await Bun.sleep(300);
      queued(); outer();
    } finally { ls.stopLoopStallMonitor(); }
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("last activity: queued_resolve");
    expect(lines[0]).toMatch(/; suspect: outer_resolve:phase@\d+ms$/);
  });

  it("[CONTROL] the same pass with no block logs no line", async () => {
    scopeRead(false);
    const lines = await monitoredPass();
    expect(lines).toEqual([]);
  }, 20_000);

  it("[CONTROL] a resolveDispatch entry is still named as last activity and in flight", async () => {
    const { resolveDispatch } = await import(`../../src/routes/impulses.js?${"stall-sections"}`);
    ls.stopLoopStallMonitor();
    const lines: string[] = [];
    ls.startLoopStallMonitor({ thresholdMs: 300, intervalMs: 100, log: (l) => lines.push(l) });
    try {
      await Bun.sleep(250);
      await resolveDispatch({ type: "lift_demo_noop" });
      Bun.sleepSync(1_000);
      await Bun.sleep(300);
    } finally { ls.stopLoopStallMonitor(); }
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("last activity: lift_demo_noop");
  });
});
