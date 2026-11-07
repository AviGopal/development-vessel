// TEST_SUITE SAYS WHEN A RUN WAS KILLED AT ITS BUDGET (test-suite.ts suiteTimedOut, TIMED_OUT_MARKER).
// A run killed by `timeout` printed no summary and read ran:false, the same as a run that never started, so the
// pre-cutover gate could not tell a contended timeout from a missing suite.
//   (a) MUST-FAIL: the marker with 124 and a wall time at the budget reads timed out.
//   (b) MUST-FAIL: a 124 well before the budget, another code (137 included: no -k is used), or no marker is not a timeout.
//   (c) MUST-FAIL: the marker line never satisfies the summary rule `ran` is read by, so ran keeps its meaning.
//   (d) MUST-FAIL (source pin): the bun run keeps its `timeout <budget>` (no -k), prints the marker only on 124, keeps
//       its exit status 0, and the body carries timed_out only when the run timed out.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { suiteTimedOut, TIMED_OUT_MARKER } from "../../src/resolvers/test-suite.js";

const SRC = readFileSync(new URL("../../src/resolvers/test-suite.ts", import.meta.url), "utf8");
const partial = "bun test v1.3.14\n\ntest/a.test.ts:\n(pass) a > one [3.00ms]\n(fail) a > two [1.00ms]\n";

describe("suiteTimedOut", () => {
  it("[MUST-FAIL] the marker with 124 at the budget reads timed out", () => {
    expect(suiteTimedOut(`${partial}${TIMED_OUT_MARKER} rc=124 elapsed=870\n`, 870)).toBe(true);
    expect(suiteTimedOut(`${partial}${TIMED_OUT_MARKER} rc=124 elapsed=871\n`, 870)).toBe(true);
  });
  it("[MUST-FAIL] an early 124, another code (137 included), or no marker is not a timeout", () => {
    expect(suiteTimedOut(`${partial}${TIMED_OUT_MARKER} rc=124 elapsed=40\n`, 870)).toBe(false);
    expect(suiteTimedOut(`${partial}${TIMED_OUT_MARKER} rc=137 elapsed=885\n`, 870)).toBe(false);
    expect(suiteTimedOut(`${partial}${TIMED_OUT_MARKER} rc=1 elapsed=870\n`, 870)).toBe(false);
    expect(suiteTimedOut(partial, 870)).toBe(false);
  });
  it("[MUST-FAIL] the marker line never satisfies the summary rule ran is read by", () => {
    const ranRule = /const ran = (\/.*\/m)\.test\(raw\);/.exec(SRC)?.[1];
    expect(ranRule).toBe("/^\\s*\\d+\\s+(pass|fail)\\b/m");
    const rule = /^\s*\d+\s+(pass|fail)\b/m;
    expect(rule.test(`${TIMED_OUT_MARKER} rc=124 elapsed=870`)).toBe(false);
    expect(rule.test(`${partial}${TIMED_OUT_MARKER} rc=124 elapsed=870\n`)).toBe(false);
  });
});

describe("wiring (source pin)", () => {
  it("[MUST-FAIL] the bun run keeps its timeout (no -k), marks only 124, exits 0, and the body field is conditional", () => {
    expect(SRC).toContain("{ __ts=$(date +%s); timeout ${budgetSec} ${testChildEnvShellPrefix()} bun test");
    expect(SRC).toContain('[ "$__rc" = 124 ] && echo "${TIMED_OUT_MARKER} rc=$__rc elapsed=$(( $(date +%s) - __ts ))"; true; }');
    expect(SRC).toContain("...(suiteTimedOut(raw, budgetSec) ? { timed_out: true } : {}),");
  });
});
