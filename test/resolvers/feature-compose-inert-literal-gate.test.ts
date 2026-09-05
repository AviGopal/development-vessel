import { describe, it, expect } from "bun:test";
import { inertRegexEditRefusal } from "../../src/resolvers/feature-compose.js";

/**
 * A PATCH THAT CHANGES BYTES BUT NOT BEHAVIOUR.
 *
 * The compose pipeline asks two questions of every change — "is it valid?" (typecheck,
 * shape-dispatch, tests) and "does it address the goal?" (the semantic gate). Nothing asks
 * the third: DOES IT DO ANYTHING. A regex edit that alters the source but not the decisions
 * the regex drives passes every existing gate, lands, is recorded as a success, and credits
 * the arm that produced it.
 *
 * OBSERVED LIVE 2026-09-05: compose route-edit-5cdf696a returned UNFAVORABLE on a semantic
 * reject; the recommit path then produced 5cd4e72, which landed autonomously at 06:54:27 and
 * appends `|\?\?=` to a GUARD_RE that ALREADY contains `\?\?` and is used unanchored — so the
 * new alternative can never match anything the old one missed. Proven inert by executing both
 * regexes over 8 probe strings: zero behavioural differences.
 *
 * That is the failure mode this gate closes, and it reveals a gradient: the cheapest way to
 * satisfy a gate that rejected you is to change nothing meaningful. `empty_diff_identity_edit`
 * does not catch it — that rule only rejects a diff that is LITERALLY empty, and this one is not.
 *
 * DESIGN NOTE — the gate must ABSTAIN whenever it cannot be sure. A false refusal blocks real
 * work, which is worse than letting an inert patch through, so every unparseable or mixed diff
 * returns null. The controls below pin that behaviour, not just the refusal.
 */
describe("inertRegexEditRefusal — refuse a literal edit that cannot change any decision", () => {
  // The verbatim diff of 5cd4e72, the commit observed landing inert.
  const REAL_INERT = [
    `-const GUARD_RE = /if \\(!|return null|return FALLBACK|return;|continue;|=== ['"]false['"]|!== ['"]true['"]|\\?\\?/;`,
    `+const GUARD_RE = /if \\(!|return null|return FALLBACK|return;|continue;|=== ['"]false['"]|!== ['"]true['"]|\\?\\?|\\?\\?=/;`,
  ].join("\n");

  it("REFUSES the real inert landing (5cd4e72): |\\?\\?= adds nothing to a regex already matching \\?\\?", () => {
    const r = inertRegexEditRefusal(REAL_INERT);
    expect(r).not.toBeNull();
    expect(r).toContain("[fc-inert-literal]");
    expect(r).toContain("behaves IDENTICALLY");
  });

  it("ALLOWS a regex change that genuinely widens the match", () => {
    const diff = `-const R = /alpha|beta/;\n+const R = /alpha|beta|gamma/;`;
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  it("ALLOWS a regex change that genuinely narrows the match", () => {
    const diff = `-const R = /alpha|beta|gamma/;\n+const R = /alpha|beta/;`;
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  it("ALLOWS an anchoring change, which alters behaviour even though the alternatives are equal", () => {
    const diff = `-const R = /foo/;\n+const R = /^foo$/;`;
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  // ---- abstention controls: the gate must not fire when it cannot be certain ----

  it("ABSTAINS on a diff that touches ordinary code, not a regex literal", () => {
    expect(inertRegexEditRefusal(`-const x = 1;\n+const x = 2;`)).toBeNull();
  });

  it("ABSTAINS on a MIXED diff — a regex edit plus a real code change must not be refused", () => {
    const diff = [
      `-const R = /a|b/;`,
      `-const y = 1;`,
      `+const R = /a|b|a/;`,
      `+const y = compute();`,
    ].join("\n");
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  it("ABSTAINS on an empty diff", () => {
    expect(inertRegexEditRefusal("")).toBeNull();
  });

  it("ABSTAINS when the added and removed line counts differ (cannot pair them)", () => {
    const diff = `-const R = /a/;\n+const R = /a/;\n+const S = /b/;`;
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  it("ABSTAINS on an unparseable regex rather than throwing", () => {
    const diff = `-const R = /a(/;\n+const R = /a(|b/;`;
    expect(() => inertRegexEditRefusal(diff)).not.toThrow();
    expect(inertRegexEditRefusal(diff)).toBeNull();
  });

  it("ignores diff headers so a real unified diff still parses", () => {
    const diff = [
      `--- a/src/x.ts`,
      `+++ b/src/x.ts`,
      `-const R = /p|q|p/;`,
      `+const R = /p|q|p|q/;`,
    ].join("\n");
    // duplicated alternatives on both sides: no behavioural difference
    expect(inertRegexEditRefusal(diff)).not.toBeNull();
  });
});
