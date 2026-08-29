// REWIRE BEFORE MINT (law 3).
//
// Every orphan gap this scan emitted said "Author an activity that invokes resolver X" — 114 of
// 114 measured 2026-08-29. That prescription satisfies the orphan METRIC by creating a consumer
// that exists only to consume: the documented poison_producer path, with 12 such gaps open while
// the orphaned_capability category itself sits at 346 attempts / 0 lands.
//
// The real defect shape is a producer/consumer SURFACE MISMATCH — an intended consumer exists and
// reads a different key, tree, file or window. Three verified instances in one session, all
// repaired by rewiring, none by minting.
//
// A rewire needs to know who already references the shape; the gap could not say, so it asked for
// the only repair it could describe. These pin that the gap now carries the missing half, AND that
// the mint fallback survives for the genuinely-unreferenced case — a test asserting only the
// rewire wording would also pass if the scan had stopped being able to ask for a mint at all.

import { describe, it, expect } from "bun:test";

const SRC = new URL("../../src/resolvers/orphaned-capability-scan.ts", import.meta.url);
const src = async (): Promise<string> => await Bun.file(SRC).text();

describe("orphan gaps prescribe rewiring first", () => {
  it("looks for consumers that already reference the shape", async () => {
    const s = await src();
    expect(s).toContain("function findCandidateConsumers");
    // Tests are not consumers — a test file referencing a shape is not an intended reader.
    expect(s).toContain('!l.includes(".test.")');
  });

  it("carries the candidates and an explicit repair direction on the gap", async () => {
    const s = await src();
    expect(s).toContain("candidate_consumers: candidateConsumers");
    expect(s).toContain('repair_direction: hasCandidates ? "rewire" : "mint"');
  });

  it("names the surface-mismatch hypothesis rather than assuming an absent consumer", async () => {
    // The load-bearing wording: the gap must tell the reader WHAT to look for.
    const s = await src();
    expect(s).toMatch(/wrong key, wrong tree, wrong file, wrong window/);
  });

  it("STILL asks for a mint when nothing references the shape", async () => {
    // The fallback must survive. Law 3's exception is a true gap with no existing producer, and
    // an orphan with no candidate consumer is exactly that case.
    const s = await src();
    expect(s).toContain("No existing consumer references this shape");
    expect(s).toContain("author a bridge activity");
  });

  it("warns that minting satisfies the count without satisfying the need", async () => {
    expect(await src()).toContain("adding a consumer nobody wanted");
  });
});

describe("the detector's own surface (2026-08-29)", () => {
  // THE DETECTOR HAD THE DEFECT IT DETECTS. It counted ACTIVITY-mediated invocation only, so a
  // resolver consumed directly by another RESOLVER was invisible. Proven live:
  // solicitation_outcome_scan consumes the uiQuestion read shape on every bare dispatch (85
  // outcomes), and orphaned-capability-uiQuestion was STILL emitted afterwards — the detector could
  // not see a repair that had already happened.
  it("treats a shape with existing consumers as NOT an orphan", async () => {
    const s = await src();
    expect(s).toMatch(/\.filter\(\(s\) => findCandidateConsumers\(s\)\.length === 0\)/);
  });

  it("keeps the activity-corpus check — this widens, it does not replace", async () => {
    const s = await src();
    expect(s).toContain("orphanCandidates = liveShapes.filter((s) => !invokedSet.has(s))");
    expect(s).toContain(".filter(isOutwardCapability)");
  });

  it("reports a numerator drawn from its denominator's population", async () => {
    // The report printed "394/389 live resolvers are ever invoked" — a numerator exceeding its
    // denominator, because invokedSet counts resolvers invoked ANYWHERE. Neither the ratio nor the
    // orphan count could be trusted as a worklist while that held.
    const s = await src();
    expect(s).toContain("const invokedLive = liveShapes.filter((s) => invokedSet.has(s)).length");
    expect(s).toContain("invoked_resolver_count: invokedLive");
  });

  it("still surfaces the raw total so nothing is hidden by the reconciliation", async () => {
    expect(await src()).toContain("invoked_anywhere_count: invokedSet.size");
  });

  it("passes the reconciled count into the gap summary too", async () => {
    // The summary renders "(N/M live resolvers are ever invoked)"; passing invoked.size there is
    // how that sentence came to print 394/389.
    expect(await src()).toContain("liveShapes.length, invokedLive)");
  });
});
