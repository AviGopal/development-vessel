// A DECOMPOSITION THAT DECLINES FOR MISSING INFORMATION STAMPS THE STATE IT DECLINED ON (the investigation damper).
//
// The gap-goal supply (boredom) sent "investigate and decompose gap X" walks for siteless rows about five times a day
// per gap; each reached development-vessel's gapDecomposition, and decomposeGap declined needs_information on the same
// inputs every time (0 reached in 24 h). Nothing on the row said the decline had happened. Now the decline stamps
// classification_metadata.investigation_declined = { fingerprint: chronicEscalationFingerprint(row, "investigation_declined"),
// at, reason }, the escalation's own fingerprint, stamped as chronic_escalation is; boredom's mirror skips the gap while
// the stamped readable row parts are unchanged. Driven through resolveGapToFeature's decompose_gap_id branch (the one
// gapDecomposition reaches) on the judge-split harness (in-memory store, routed fetch, unrouted calls recorded):
//   - [MUST-FAIL] a siteless row the localizer cannot site: the decline is stamped, with dv's own fingerprint;
//   - CONTROL: observe mode writes nothing; the stamp writes no disposition (check-supply's localizer must keep seeing
//     the row);
//   - PARITY: every stamp in the shared fixtures (test/fixtures/investigation-decline-damper-fixtures.json, byte for
//     byte boredom's src/fixtures/ copy) is what dv's real chronicEscalationFingerprint gives for its stamped row.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { beginPin, endPin, restoreHarness, seed, metaOf, writesFor, RUN, type Row } from "./harness.js";

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const FIX = JSON.parse(readFileSync(new URL("../fixtures/investigation-decline-damper-fixtures.json", import.meta.url).pathname, "utf8")) as { cases: Record<string, { stamped: Row | null; stamp: { fingerprint: string } | null; current: Row; skip: boolean }> };
const decompose = (id: string, extra: Row = {}) => g2f.resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: id, ...extra } as never);

beforeEach(() => { beginPin(); });
afterEach(() => { expect(endPin([/pick-decisions\.jsonl$/]).fetch).toEqual([]); });
afterAll(() => restoreHarness());

describe("gapDecomposition's needs_information decline stamps the inputs it declined on", () => {
  it("[MUST-FAIL] a siteless row the localizer cannot site: investigation_declined carries dv's own fingerprint", async () => {
    const g = seed({ id: `inv-decline-${RUN}`, summary: "a capability count is zero", classification_metadata: { falsifier: "none" } });
    const r = await decompose(g.id);
    expect(String((r.body as Row).reason)).toStartWith("needs_information");
    const stamp = metaOf(g.id).investigation_declined as Row | undefined;
    expect(stamp).toBeDefined();
    expect(stamp!.fingerprint).toBe(g2f.chronicEscalationFingerprint(g, "investigation_declined"));
    expect(typeof stamp!.at).toBe("string");
    expect(String(stamp!.reason)).toStartWith("needs_information");
  });

  it("[CONTROL] observe mode writes nothing; the stamp writes no disposition", async () => {
    const o = seed({ id: `inv-decline-observe-${RUN}`, summary: "a capability count is zero", classification_metadata: { falsifier: "none" } });
    await decompose(o.id, { learning_mode: "observe" });
    expect(writesFor(o.id)).toEqual([]);
    const g = seed({ id: `inv-decline-nodisp-${RUN}`, summary: "a capability count is zero", classification_metadata: { falsifier: "none" } });
    await decompose(g.id);
    expect(metaOf(g.id).investigation_declined).toBeDefined();
    expect(metaOf(g.id).disposition).toBeUndefined();
  });

  it("[CONTROL] check-supply's localizer still sees a stamped row (no disposition, no site field)", async () => {
    const supply = await import("../../src/resolvers/gap-check-supply.js");
    const meta = { falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/x.test.ts", only_tests: ["x"] } } };
    const before = { id: `inv-decline-cs-${RUN}`, summary: "a failing test", classification_metadata: meta };
    const after = { ...before, classification_metadata: { ...meta, investigation_declined: { fingerprint: g2f.chronicEscalationFingerprint(before, "investigation_declined"), at: "2026-11-02T00:00:00.000Z", reason: "needs_information: no readable edit site" } } };
    expect(supply.localizableBySupply(after)).toBe(supply.localizableBySupply(before));
  });

  it("[PARITY] every fixture stamp is dv's real fingerprint of its stamped row", () => {
    const stamped = Object.entries(FIX.cases).filter(([, c]) => c.stamped && c.stamp);
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped.map(([name, c]) => ({ name, fingerprint: c.stamp!.fingerprint }))).toEqual(stamped.map(([name, c]) => ({ name, fingerprint: g2f.chronicEscalationFingerprint(c.stamped!, "investigation_declined") })));
  });
});
