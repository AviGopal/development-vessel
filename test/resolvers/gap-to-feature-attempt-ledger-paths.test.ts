// THE LEDGER OUTCOME FOR EVERY PATH THAT FOLLOWS A PICK (qa on the attempt-ledger fix). recordAttemptEnd reads the
// gapToFeatureReport a path returns. Two paths returned bodies it could not read: the capacity-slice sequence
// returned neither `landed` nor `compose` (every slice attempt recorded "refused", landed or not) and the
// capability-gap route returned no `compose` (a failure recorded "refused" with no stage or class). Pinned here:
// (1) each path's return shape records the right outcome, and (2) the source returns those fields and the
// resolveGapToFeature wrapper records the end on both return and throw.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["ATTEMPT_LEDGER_DIR"] = mkdtempSync(join(tmpdir(), "g2f-ledger-paths-"));
const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as unknown as Record<string, unknown>;
const { readRecords } = await import("../../src/resolvers/attempt-ledger.js");
type Row = Record<string, unknown>;
type End = (attemptId: string, gap: Row, result: { shape: string; body: unknown } | null, err?: unknown) => void;
const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
const gap = (id: string): Row => ({ id, classification_metadata: {} });
function outcomeOf(body: Row): Row {
  const id = `dec-path-${Math.random().toString(36).slice(2, 10)}`;
  (g2f["recordAttemptEnd"] as End)(id, gap(String(body.gap_id ?? "g")), { shape: "gapToFeatureReport", body });
  return (readRecords("attemptOutcome", { key: id })[0]?.record ?? {}) as Row;
}
const slices = (ok: boolean, landed: boolean, lastBody: Row): Row => ({ ok, stage: "route_compose", route: "capacity_slice_sequence", gap_id: "g-slice", gap_category: "c", slices: [{ file: "a.ts", verdict: lastBody.verdict }], landed, landed_commit: landed ? "feed123" : null, compose: lastBody });

describe("ledger outcome per path shape", () => {
  it("capacity slices that landed record landed with the commit", () => {
    const o = outcomeOf(slices(true, true, { ok: true, verdict: "FAVORABLE", commit_sha: "feed123" }));
    expect(o["outcome"]).toBe("landed");
    expect(o["commit"]).toBe("feed123");
  });
  it("capacity slices that failed record failed with the last slice's stage and class", () => {
    const o = outcomeOf(slices(false, false, { ok: false, verdict: "UNFAVORABLE", stage: "verify", failure_kind: "fix" }));
    expect(o["outcome"]).toBe("failed");
    expect(o["stage"]).toBe("verify");
    expect(o["class"]).toBe("fix");
  });
  it("a capability-gap compose that failed records failed with stage and class", () => {
    const o = outcomeOf({ ok: false, route: "capability_gap_via_feature_compose", gap_id: "g-cap", verdict: "UNFAVORABLE", landed: false, landed_commit: null, gap_closed: false, compose: { ok: false, stage: "decompose", error: "plan had no ops" } });
    expect(o["outcome"]).toBe("failed");
    expect(o["stage"]).toBe("decompose");
    expect(o["class"]).toBe("plan had no ops");
  });
});

describe("source pins: the paths return what the ledger reads, and the wrapper records both ends", () => {
  it("the capacity-slice return carries landed, landed_commit and compose: lastBody", () => {
    const ret = SRC.split("\n").find((l) => l.includes('route: "capacity_slice_sequence"')) ?? "";
    expect(ret).toContain("landed:");
    expect(ret).toContain("landed_commit:");
    expect(ret).toContain("compose: lastBody");
  });
  it("the capability-gap non-plan return carries compose: cb", () => {
    const i = SRC.indexOf('ok: land.landed, route: "capability_gap_via_feature_compose"');
    expect(i).toBeGreaterThan(0);
    expect(SRC.slice(i, i + 600)).toContain("compose: cb");
  });
  it("resolveGapToFeature records the attempt end on return AND on throw", () => {
    const i = SRC.indexOf("export async function resolveGapToFeature(");
    const body = SRC.slice(i, SRC.indexOf("async function resolveGapToFeatureOnce(", i));
    expect(body).toMatch(/catch \(err\) \{\s*if \(attempt\.id && attempt\.gap\) recordAttemptEnd\(attempt\.id, attempt\.gap, null, err\);\s*throw err;/);
    expect(body).toMatch(/if \(attempt\.id && attempt\.gap\) recordAttemptEnd\(attempt\.id, attempt\.gap, result/);
  });
});
