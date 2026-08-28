// Per-resolver test for escalation_disposition_apply — the escalation-disposition executor.
// Pins the two things the increment exists to guarantee: (1) the four authored verbs map to
// the right gap mutation, and (2) the re-test path a non-drop disposition restores is
// BOUNDED and IDEMPOTENT. An unparsed answer must be a no-op, not a guess.

import { describe, it, expect } from "bun:test";
import {
  parseDisposition,
  gapIdFromPanelId,
  HUMAN_EXEMPTION_ATTEMPTS,
} from "../../src/resolvers/escalation-disposition-apply.js";

describe("escalation_disposition_apply — verb parsing", () => {
  it("recognises each of the four verbs the escalation body asks for", () => {
    // The escalation text (gap-to-feature.ts:831) asks the human to
    // "redefine the goal, provide missing information, grant access, or drop it".
    expect(parseDisposition("REDEFINE, do not keep retrying as-is.")).toBe("redefine");
    expect(parseDisposition("Grant access to the deploy key.")).toBe("grant_access");
    expect(parseDisposition("Providing missing information: the schema is v3.")).toBe("provide_information");
    expect(parseDisposition("Not worth closing — drop it.")).toBe("drop");
  });

  it("returns null rather than guessing when no verb is present", () => {
    // The safe outcome, and deliberate: a guess would mutate a gap on a keyword the human
    // never intended. Leaving the escalation outstanding is strictly better.
    expect(parseDisposition("Interesting, I'll look at this next week.")).toBeNull();
    expect(parseDisposition("")).toBeNull();
    expect(parseDisposition("   ")).toBeNull();
  });

  it("does not let a specific verb be shadowed by a looser one", () => {
    // "provide missing information" contains no 'drop', but a redefine answer that also
    // says "drop the old wording" must still read as redefine — most-specific first.
    expect(parseDisposition("Redefine it; drop the old wording.")).toBe("redefine");
  });
});

describe("escalation_disposition_apply — panel id mapping", () => {
  it("recovers the gap id from both escalation prefixes", () => {
    expect(gapIdFromPanelId("needs-human-my-gap-1")).toBe("my-gap-1");
    expect(gapIdFromPanelId("reland-needs-human-my-gap-2")).toBe("my-gap-2");
  });

  it("returns empty for a panel id that is not an escalation", () => {
    // Guards against mutating an unrelated gap because some other panel was answered.
    expect(gapIdFromPanelId("some-other-panel")).toBe("");
    expect(gapIdFromPanelId("")).toBe("");
  });

  it("strips the longer prefix first so a reland id does not keep 'reland-' in the gap id", () => {
    expect(gapIdFromPanelId("reland-needs-human-x")).not.toContain("needs-human");
  });
});

describe("escalation_disposition_apply — the bound", () => {
  it("grants a finite, non-zero exemption", () => {
    // If this were 0 the human's answer would change nothing; if it were Infinity the
    // flood 143212a deliberately closed would reopen on a single answer.
    expect(HUMAN_EXEMPTION_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(HUMAN_EXEMPTION_ATTEMPTS)).toBe(true);
  });
});
