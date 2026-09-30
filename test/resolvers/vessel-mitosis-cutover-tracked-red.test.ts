// The pre-cutover test gate (vessel-mitosis-cutover step 5d) must not count a test an OPEN gap
// deliberately tracks as red (classification_metadata.evidence_resolve.input.only_tests, the
// class-2 check-first pattern) as a regression when it was ALREADY red on the untouched base
// tree. Without this, one check-first commit deadlocks the vessel: every cutover is refused as
// precutover_regression, and the baseline only refreshes on a green landing. Measured
// 2026-09-30 17:06: a FAVORABLE lane-derived patch for development-vessel was refused over 4
// tests two open gaps track as red.
// Matching mirrors scripts/substrate/substrate-pull-sync.sh tracked_fail_names + its awk
// matcher: exact leaf (" > <name>" suffix) or full-path ("(fail) <name>") match, each tracked
// name consumes at most one failing line, vessel filter with an optional "repos/" prefix.
// Every bound fails CLOSED: unknown landing gap, unreadable store, or no base result → nothing
// subtracted.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  trackedRedCandidates,
  subtractTrackedRed,
  makeTrackedRedFilter,
  loadTrackedRedNames,
} from "../../src/resolvers/vessel-mitosis-cutover.js";

const LEAF = "a written gap whose row carries disposition pending_verification is not dispatched";
const DESCRIBE = "gap-drain observer: a gap admission would exclude is never dispatched";
const LINE = `(fail) ${DESCRIBE} > ${LEAF}`;
const OTHER = "(fail) unrelated suite > a real regression";

describe("trackedRedCandidates / subtractTrackedRed", () => {
  it("subtracts a tracked name given as the full path when it is red on base", () => {
    expect(subtractTrackedRed([LINE, OTHER], [`${DESCRIBE} > ${LEAF}`], [], [LINE])).toEqual([OTHER]);
  });
  it("subtracts a tracked name given as the leaf when it is red on base", () => {
    expect(subtractTrackedRed([LINE, OTHER], [LEAF], [], [LINE])).toEqual([OTHER]);
  });
  it("KEEPS a tracked test that is green on base and red on the candidate: a regression this change caused", () => {
    expect(subtractTrackedRed([LINE, OTHER], [LEAF], [], [])).toEqual([LINE, OTHER]);
    expect(subtractTrackedRed([LINE, OTHER], [LEAF], [], [OTHER])).toEqual([LINE, OTHER]);
  });
  it("subtracts nothing when the base run produced no result (null)", () => {
    expect(subtractTrackedRed([LINE, OTHER], [LEAF], [], null)).toEqual([LINE, OTHER]);
  });
  it("does not subtract untracked names, even red on base, nor match by substring", () => {
    expect(subtractTrackedRed([LINE, OTHER], ["a real"], [], [LINE, OTHER])).toEqual([LINE, OTHER]);
    expect(subtractTrackedRed([LINE, OTHER], ["pending_verification is not dispatched"], [], [LINE, OTHER])).toEqual([LINE, OTHER]);
    expect(subtractTrackedRed([LINE, OTHER], [], [], [LINE, OTHER])).toEqual([LINE, OTHER]);
    expect(subtractTrackedRed([LINE, OTHER], null, [], [LINE, OTHER])).toEqual([LINE, OTHER]);
  });
  it("lets one tracked leaf hide at most ONE line (a shared leaf in another file stays a regression)", () => {
    const twin = `(fail) another file's describe > ${LEAF}`;
    expect(trackedRedCandidates([LINE, twin], [LEAF])).toEqual([LINE]);
    expect(subtractTrackedRed([LINE, twin], [LEAF], [], [LINE, twin])).toEqual([twin]);
  });
  it("never subtracts the landing gap's OWN still-red test, even when another open gap tracks it", () => {
    // The gap being landed must turn its own check green; a -step-N sibling listing the same
    // name must not wave the landing through with its own check still red.
    expect(subtractTrackedRed([LINE, OTHER], [LEAF], [`${DESCRIBE} > ${LEAF}`], [LINE])).toEqual([LINE, OTHER]);
    expect(subtractTrackedRed([LINE], [`${DESCRIBE} > ${LEAF}`], [LEAF], [LINE])).toEqual([LINE]);
  });
});

describe("makeTrackedRedFilter (the gate's filter)", () => {
  const loaded = async () => ({ tracked: [LEAF], own: [] as string[] });
  it("runs the base ONCE on only the tracked candidates, subtracting those red there", async () => {
    const calls: string[][] = [];
    const f = makeTrackedRedFilter(loaded, async (lines) => { calls.push(lines); return [LINE]; });
    const r = await f([LINE, OTHER]);
    expect(r.kept).toEqual([OTHER]);
    expect(r.subtracted).toEqual([LINE]);
    expect(calls).toEqual([[LINE]]);
    await f([LINE, OTHER]);                // second pass (after the isolation re-run) reuses the base result
    expect(calls.length).toBe(1);
  });
  it("keeps a tracked candidate green on base, and reports it", async () => {
    const f = makeTrackedRedFilter(loaded, async () => []);
    const r = await f([LINE, OTHER]);
    expect(r.kept).toEqual([LINE, OTHER]);
    expect(r.green_on_base).toEqual([LINE]);
  });
  it("subtracts nothing when the base run is unavailable (null or throws)", async () => {
    expect((await makeTrackedRedFilter(loaded, async () => null)([LINE, OTHER])).kept).toEqual([LINE, OTHER]);
    expect((await makeTrackedRedFilter(loaded, async () => { throw new Error("shell down"); })([LINE, OTHER])).kept).toEqual([LINE, OTHER]);
  });
  it("subtracts nothing, and never runs the base, when tracked names are unloadable", async () => {
    let ran = false;
    const f = makeTrackedRedFilter(async () => null, async () => { ran = true; return [LINE]; });
    expect((await f([LINE, OTHER])).kept).toEqual([LINE, OTHER]);
    expect(ran).toBe(false);
  });
  it("keeps a candidate that was not measured by the one base run", async () => {
    const twin = `(fail) another file's describe > ${LEAF}`;
    const f = makeTrackedRedFilter(async () => ({ tracked: [LEAF, LEAF], own: [] }), async () => [LINE, twin]);
    expect((await f([LINE])).kept).toEqual([]);
    expect((await f([twin])).kept).toEqual([twin]);   // twin was not in the measured set
  });
});

type Row = Record<string, unknown>;
const gap = (id: string, vessel: string, only: string[], extra: Row = {}): Row => ({
  id, status: "open",
  classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel, test_file: "test/x.test.ts", only_tests: only } } },
  ...extra,
});
const reader = (rows: Row[], opts: { failOpenList?: boolean; failOwn?: boolean } = {}) =>
  (async (p: { id?: string; status?: string }) => {
    if (p.id) {
      if (opts.failOwn) return { shape: "structuredError", body: { detail: "unreachable" } };
      return { shape: "substrateGap", body: { gaps: rows.filter((r) => r.id === p.id) } };
    }
    if (opts.failOpenList) return { shape: "structuredError", body: { detail: "gap store unreachable" } };
    return { shape: "substrateGap", body: { gaps: rows.filter((r) => !p.status || r.status === p.status) } };
  }) as never;

describe("loadTrackedRedNames", () => {
  const own = gap("own", "development-vessel", ["mine"]);
  it("collects only_tests of open test_suite gaps for THIS vessel, held gaps included", async () => {
    const rows = [
      own,
      gap("a", "development-vessel", ["t1"]),
      gap("b", "repos/development-vessel", ["t2"], { classification_metadata: { operator_hold: true, disposition: "needs_information", evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", only_tests: ["t2"] } } } }),
      gap("c", "activity-api", ["t3"]),
      { ...gap("d", "development-vessel", ["t4"]), status: "closed" },
    ];
    const got = await loadTrackedRedNames("development-vessel", "own", reader(rows));
    expect(got).not.toBeNull();
    expect([...got!.tracked].sort()).toEqual(["mine", "t1", "t2"]);
    expect(got!.own).toEqual(["mine"]);
  });
  it("the own names shield the landing gap's test from a sibling that tracks it", async () => {
    const rows = [own, gap("sib", "development-vessel", ["mine", "theirs"])];
    const got = await loadTrackedRedNames("development-vessel", "own", reader(rows));
    const lines = ["(fail) s > mine", "(fail) s > theirs"];
    expect(subtractTrackedRed(lines, got!.tracked, got!.own, lines)).toEqual(["(fail) s > mine"]);
  });
  it("fails closed (null) when the landing gap is unknown (empty id)", async () => {
    expect(await loadTrackedRedNames("development-vessel", "", reader([own, gap("a", "development-vessel", ["t1"])]))).toBeNull();
    // Refused up front, without touching the store: an empty id must never fall through to a row lookup
    // that some reader could answer (resolveSubstrateGap ignores an empty id filter).
    let calls = 0;
    const counting = (async (p: unknown) => { calls++; return (reader([{ ...own, id: "" }]) as unknown as (q: unknown) => Promise<unknown>)(p); }) as never;
    expect(await loadTrackedRedNames("development-vessel", "", counting)).toBeNull();
    expect(calls).toBe(0);
  });
  it("fails closed (null) when the landing gap's row is not found", async () => {
    expect(await loadTrackedRedNames("development-vessel", "missing", reader([own]))).toBeNull();
  });
  it("fails closed (null) when the open-gap list cannot be read", async () => {
    expect(await loadTrackedRedNames("development-vessel", "own", reader([own], { failOpenList: true }))).toBeNull();
    const throwing = (async () => { throw new Error("boom"); }) as never;
    expect(await loadTrackedRedNames("development-vessel", "own", throwing)).toBeNull();
  });
  it("fails closed (null) when the landing gap is named but its row cannot be read", async () => {
    expect(await loadTrackedRedNames("development-vessel", "own", reader([own], { failOwn: true }))).toBeNull();
  });
});

describe("pre-cutover gate wiring (source position)", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/vessel-mitosis-cutover.ts"), "utf8");
  const gateStart = src.indexOf("5d. PRE-CUTOVER TEST GATE");
  const refuse = src.indexOf('unstage("precutover_regression")', gateStart);
  const gate = src.slice(gateStart, refuse);
  it("builds the filter from the store loader (landing gap id) and a base-tree run of the suite", () => {
    const def = gate.indexOf("makeTrackedRedFilter(");
    expect(def).toBeGreaterThan(0);
    const body = gate.slice(def, gate.indexOf("const dropTrackedRed", def));
    expect(body).toContain("loadTrackedRedNames(");
    expect(body).toContain("pointer.gap_id || pendingGapId");
    expect(body).toContain("runSuiteWith(");
    expect(body).toContain('base_ref: "HEAD"');
  });
  it("subtracts tracked red after the first computeNewlyFailing, before the isolation re-run", () => {
    const first = gate.indexOf("computeNewlyFailing(baseline, failNow)");
    expect(first).toBeGreaterThan(0);
    const sub = gate.indexOf("newlyFailing = await dropTrackedRed(newlyFailing);", first);
    expect(sub).toBeGreaterThan(first);
    expect(sub).toBeLessThan(gate.indexOf("const isolatedNames", first));
    expect(sub).toBeLessThan(gate.indexOf("runSuiteOnly(isolatedNames)"));
  });
  it("subtracts tracked red again after the isolation re-run, before refusing", () => {
    expect(gate).toContain("await dropTrackedRed(computeNewlyFailing(baseline, failAgain))");
    expect(gate.lastIndexOf("computeNewlyFailing(")).toBe(gate.indexOf("computeNewlyFailing(baseline, failAgain)"));
    expect(refuse).toBeGreaterThan(gateStart);
  });
  it("resolves the landing gap id (pointer or pending provenance) before the gate", () => {
    const pending = src.indexOf("let pendingGapId");
    expect(pending).toBeGreaterThan(0);
    expect(pending).toBeLessThan(gateStart);
  });
});
