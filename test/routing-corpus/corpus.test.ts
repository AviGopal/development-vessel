// PROTECTED: every routing case meets its admission expectation at this tree (DESIGN §6.1).
//   - a case appended green reproduces `expect` (a red one is a flip: the candidate regressed it);
//   - a case appended known_red or entry_missing is REPORTED, not asserted (it may stay red; turning green is recorded
//     by the glue's ratchet);
//   - no case is nondeterministic, no green case reads a port it does not record, at least MIN_CASES ran.
// No skip and no environment condition: a runtime this test cannot judge FAILS, naming the reason.
import { describe, expect, test } from "bun:test";
import { runCorpus } from "./runner";

const MIN_CASES = 13;

const report = await runCorpus(import.meta.dir);

describe("routing corpus", () => {
  for (const r of report.cases) {
    if (r.status_at_append === "green") {
      test(`${r.id} (${r.entry}${r.control ? ", control" : ""}) stays green`, () => {
        expect({ id: r.id, observed: r.observed, reason: r.reason }).toEqual({ id: r.id, observed: "green", reason: null });
      });
    } else {
      test(`${r.id} (${r.entry}) appended ${r.status_at_append}: reported, observed ${r.observed}`, () => {
        console.log(`[routing-corpus] ${r.id} appended ${r.status_at_append}, observed ${r.observed}${r.reason ? ` (${r.reason})` : ""}`);
        expect(r.observed).not.toBe("nondeterministic");
      });
    }
  }
  test("the chain verifies, at least MIN_CASES ran, none nondeterministic", () => {
    expect(report.problems).toEqual([]);
    expect(report.cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(report.nondeterministic).toEqual([]);
    expect(report.flips).toEqual([]);
  });
});
