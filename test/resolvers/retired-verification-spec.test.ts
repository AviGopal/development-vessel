// THE verification_spec READER IS RETIRED, NOT FAKED (operator ruling 2026-10-10, "retire the spec").
//
// The cutover executed classification_metadata.verification_spec through behavioral-verification.ts after
// every landing. No repo ever wrote a verification_spec, so the reader returned {ran:false} on every landing
// while looking like a post-landing verifier, and its joint (behavioral-verification-input) read severed with
// nothing able to repair it. A dormant reader is a promise of verification that nothing keeps: it is removed,
// and a landing with no measurable predicate goes to the human lane at the pending-land stamp instead
// (cutover-pending-unmeasurable.test.ts).
//
// Must-fail at the parent: the cutover imports behavioral-verification.js, calls runBehavioralVerification and
// reads meta["verification_spec"]; the module exists.
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CUTOVER = join(ROOT, "src", "resolvers", "vessel-mitosis-cutover.ts");
// Comments may name the retired mechanism; the wiring is what must be gone.
const code = (): string => readFileSync(CUTOVER, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("retired verification_spec reader (must-fail at the parent)", () => {
  it("the cutover no longer imports or calls the behavioral-verification path", () => {
    const src = code();
    expect(src).not.toMatch(/behavioral-verification(\.js)?["']/);
    expect(src).not.toMatch(/runBehavioralVerification/);
  });
  it("the cutover no longer reads classification_metadata.verification_spec", () => {
    expect(code()).not.toMatch(/verification_spec/);
  });
  it("the reader module is gone, so nothing can wire it back by import alone", () => {
    expect(existsSync(join(ROOT, "src", "resolvers", "behavioral-verification.ts"))).toBe(false);
  });
});
