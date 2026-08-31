import { describe, it, expect } from "bun:test";
import { derivePredicateLiteral, extractCandidateLiterals, countOccurrences, MIN_LITERAL_LEN } from "../src/gap-predicate.js";

// A gap with no measurable predicate can never close, even when its fix lands. Verified
// on the live fleet 2026-08-31: 569881d landed FAVORABLE and deployed, and all five gaps in
// its lineage stayed open, because sweepPendingLandVerifications closes only on a MEASURED
// 'absent' and a prose-only gap yields 'pending'. Measured population: 410 open gaps, 164
// citing a file, exactly ONE carrying a predicate — hand-written.
//
// These pin the rule that makes "no predicate" the safe default. A wrong predicate is worse
// than none: it either closes a gap whose defect is still live, or pins one open forever.
describe("derivePredicateLiteral", () => {
  it("derives a backticked literal that appears EXACTLY ONCE", () => {
    const summary = "The cap is frozen at module load: `const SLOT_DIR = process.env.COMPOSE_SLOT_DIR` is read once.";
    const file = "import x from 'y';\nconst SLOT_DIR = process.env.COMPOSE_SLOT_DIR ?? '/tmp';\nexport {};";
    expect(derivePredicateLiteral(summary, file)).toBe("const SLOT_DIR = process.env.COMPOSE_SLOT_DIR");
  });

  it("REFUSES a literal that appears twice — it cannot discriminate a fix", () => {
    // The oracle closes when the literal goes absent. Two matches cannot distinguish "fixed"
    // from "one of two similar sites fixed", so the gap would close on a half-repair.
    const summary = "the call `await callTool(endpoint)` is wrong";
    const file = "await callTool(endpoint);\nif (x) { await callTool(endpoint); }";
    expect(derivePredicateLiteral(summary, file)).toBeNull();
  });

  it("REFUSES a literal absent from the file — it would close instantly on an untouched defect", () => {
    const summary = "the guard `if (slot.mtime < now - SLOT_STALE_MS)` is inverted";
    const file = "if (now - st.mtimeMs > SLOT_STALE_MS) { reap(); }";
    expect(derivePredicateLiteral(summary, file)).toBeNull();
  });

  it("REFUSES short generic literals even when unique", () => {
    // "return null" would match a thousand files and teaches the oracle nothing.
    const summary = "it should `return null` here";
    const file = "function f() { return null; }";
    expect(derivePredicateLiteral(summary, file)).toBeNull();
  });

  it("prefers the LONGEST unique candidate — the most specific one", () => {
    const summary = "both `process.env.COMPOSE_SLOT_DIR` and `const SLOT_DIR = process.env.COMPOSE_SLOT_DIR ?? x` appear";
    const file = "const SLOT_DIR = process.env.COMPOSE_SLOT_DIR ?? x;";
    expect(derivePredicateLiteral(summary, file)).toBe("const SLOT_DIR = process.env.COMPOSE_SLOT_DIR ?? x");
  });

  it("returns null for a prose-only summary — the common case must stay safe", () => {
    const summary = "The picker starves on one gap family and the history of attempts does not mitigate this.";
    const file = "const anything = 1;";
    expect(derivePredicateLiteral(summary, file)).toBeNull();
  });

  it("is null-safe on empty or missing input", () => {
    expect(derivePredicateLiteral("", "abc")).toBeNull();
    expect(derivePredicateLiteral("`something long here`", "")).toBeNull();
    expect(derivePredicateLiteral(undefined as unknown as string, "abc")).toBeNull();
  });
});

describe("extractCandidateLiterals", () => {
  it("takes backticks, double and single quotes, longest first", () => {
    const out = extractCandidateLiterals("see `alpha_beta_gamma_delta` and \"epsilon_zeta_eta\" and 'theta_iota_kappa'");
    expect(out[0]).toBe("alpha_beta_gamma_delta");
    expect(out).toContain("epsilon_zeta_eta");
    expect(out).toContain("theta_iota_kappa");
  });

  it("drops prose sentences that merely happen to be quoted", () => {
    // A quoted sentence ending in a period is almost never code.
    const out = extractCandidateLiterals('the detector said "the picker is starving badly."');
    expect(out).not.toContain("the picker is starving badly.");
  });

  it("dedupes and enforces the minimum length", () => {
    const out = extractCandidateLiterals("`abcdefghijklm` `abcdefghijklm` `short`");
    expect(out.filter((s) => s === "abcdefghijklm")).toHaveLength(1);
    expect(out).not.toContain("short");
    expect(MIN_LITERAL_LEN).toBeGreaterThan(4);
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping plain substrings, matching the oracle's own test", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "zzz")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});
