// THE READERS OF LIFECYCLE-SUBSCRIBER TRACES STAY HONEST WHEN NORMAL META-SUBSCRIBER RUNS ARE COUNTED (CHANGE DB1).
//
// With lifecycle.subscriber_trace_mode = 1, goal-host (ias-executor-ts SubscriberRunCounter) counts normal runs of
// validator-dispatch and slot-binding instead of tracing each; only their anomalous runs are traced.
//
//   [MUST-FAIL] substrate-health-tick leaves META templates (the shared isMetaTemplate) out of its confidence pairs, so
//               a counted subscriber's failures-only traces cannot read as a failing arm.
//   [MUST-FAIL] cyclic-flow-scan's report states that counted subscriber runs are not in its aggregate.
//   [CONTROL]   the shared META set holds BOTH counted subscribers. ias-executor-ts pins its counted set to exactly
//               these two (test/subscriber-run-counter.test.ts); the two pins name each other, whatever the land order.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { META_TEMPLATE_IDS, isMetaTemplate } from "../../src/lib/meta-templates.js";

const read = (p: string): string => readFileSync(new URL(`../../src/resolvers/${p}`, import.meta.url), "utf8");

describe("DB1: subscriber-trace readers with counted meta subscribers", () => {
  it("[MUST-FAIL] substrate-health-tick leaves meta templates out of its confidence pairs", () => {
    const src = read("substrate-health-tick.ts");
    expect(src).toContain('import { isMetaTemplate } from "../lib/meta-templates.js";');
    expect(src).toContain("if (activeNormIds.has(normalizeId(id)) && !isMetaTemplate(id)) {");
  });

  it("[MUST-FAIL] cyclic-flow-scan states what its aggregate excludes", () => {
    expect(read("cyclic-flow-scan.ts")).toContain('aggregate_excludes: "normal (counted) runs of the meta lifecycle subscribers when lifecycle.subscriber_trace_mode = 1",');
  });

  it("[CONTROL] the shared META set holds both counted subscribers (ias-executor-ts COUNTED_SUBSCRIBER_TEMPLATES)", () => {
    for (const t of ["validator-dispatch", "slot-binding"]) {
      expect(META_TEMPLATE_IDS.has(t)).toBe(true);
      expect(isMetaTemplate(`activity:⟨${t}⟩`)).toBe(true);
    }
    // the three subscribers that run real tasks are NOT meta, so they keep full traces
    for (const t of ["ribosome-extract", "audit-test-report", "debug-failing-audit"]) expect(isMetaTemplate(t)).toBe(false);
  });
});
