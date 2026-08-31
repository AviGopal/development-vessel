import { describe, it, expect } from "bun:test";
import {
  gapBackoffMs,
  gapIsBackedOff,
  GAP_BACKOFF_BASE_MS,
  GAP_BACKOFF_MAX_MS,
} from "../../src/resolvers/gap-to-feature.js";

// Pins the per-gap brake that hopeless() structurally cannot apply.
//
// hopeless() is category-grain and requires `r.lands !== 0` to return false, so a
// category that has EVER landed can never seal — however many attempts one member
// accumulates. Measured 2026-08-31 across 425 open gaps: 678 failed attempts,
// median 0, p90 4, max 58. That max is `route-edit-e32a5778`, category
// `edit_intent_route`, which lands routinely and is therefore unsealable. It landed a
// commit at 19:44, was never recorded as landed, and was composing again at 19:53.
//
// The property under test is RATE, not eligibility: no gap is ever removed from
// selection, because a hard ceiling is irreversible without an operator and silently
// abandons real work, while a wrong backoff only costs time.

const meta = (m: Record<string, unknown>) => ({ id: "g", classification_metadata: m });
const NOW = Date.parse("2026-08-31T20:00:00.000Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

describe("gapBackoffMs", () => {
  it("does not penalise a gap that has never failed, or failed once", () => {
    // One failure is almost no evidence that a gap is unfixable. Slowing it would tax
    // the common case to punish the rare one.
    expect(gapBackoffMs(0)).toBe(0);
    expect(gapBackoffMs(1)).toBe(0);
  });

  it("doubles per failure from the second onward", () => {
    expect(gapBackoffMs(2)).toBe(GAP_BACKOFF_BASE_MS * 2);
    expect(gapBackoffMs(3)).toBe(GAP_BACKOFF_BASE_MS * 4);
    expect(gapBackoffMs(4)).toBe(GAP_BACKOFF_BASE_MS * 8);
  });

  it("caps at 24h so a runaway decays to daily, never to never", () => {
    expect(gapBackoffMs(58)).toBe(GAP_BACKOFF_MAX_MS);
    expect(gapBackoffMs(1_000_000)).toBe(GAP_BACKOFF_MAX_MS);
    // The clamp is on the EXPONENT, not just the result: an unclamped 2**58 is finite
    // but absurd, and 2**1e6 is Infinity — Math.min(cap, Infinity) is the cap, but
    // Math.min(cap, NaN) is NaN, which would compare false everywhere and silently
    // disable the brake.
    expect(Number.isFinite(gapBackoffMs(1_000_000))).toBe(true);
  });

  it("never yields NaN or a negative wait from junk input", () => {
    // failed_attempts is read from a store this code does not own. A NaN wait compares
    // false against every elapsed time, turning the brake off without a trace; a
    // negative one would back off forever.
    for (const junk of [NaN, -5, Infinity, -Infinity]) {
      const w = gapBackoffMs(junk as number);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("gapIsBackedOff", () => {
  it("holds a repeatedly-failing gap until its wait elapses, then releases it", () => {
    const g = meta({ failed_attempts: 4, last_failed_at: agoMs(GAP_BACKOFF_BASE_MS * 8 - 1000) });
    expect(gapIsBackedOff(g, NOW)).toBe(true);
    const older = meta({ failed_attempts: 4, last_failed_at: agoMs(GAP_BACKOFF_BASE_MS * 8 + 1000) });
    expect(gapIsBackedOff(older, NOW)).toBe(false);
  });

  it("still releases the 58-attempt runaway after a day — a brake, not a seal", () => {
    const g = meta({ failed_attempts: 58, last_failed_at: agoMs(GAP_BACKOFF_MAX_MS + 60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(false);
  });

  it("FAILS OPEN with no metadata, no timestamp, or an unparseable one", () => {
    // Most gaps in the store carry no such metadata. Excluding on absence would empty
    // the candidate pool and stop gap work entirely — the failure mode that looks like
    // a calm, healthy system.
    expect(gapIsBackedOff({ id: "g" }, NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9 }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9, last_failed_at: "not-a-date" }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9, last_failed_at: null }), NOW)).toBe(false);
  });

  it("FAILS OPEN on a future timestamp rather than waiting forever", () => {
    // Clock skew between the writer and this reader must not be able to park a gap
    // permanently.
    const g = meta({ failed_attempts: 9, last_failed_at: agoMs(-60 * 60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(false);
  });

  it("never holds a gap at failed_attempts <= 1, whatever the timestamp", () => {
    expect(gapIsBackedOff(meta({ failed_attempts: 1, last_failed_at: agoMs(0) }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 0, last_failed_at: agoMs(0) }), NOW)).toBe(false);
  });

  it("reads the DURABLE metadata, so a vessel restart cannot reset the brake", () => {
    // The in-process gapComposeLastAttemptAt map is cleared on every restart, and
    // mitosis cutovers restart this vessel several times a day. A backoff built on it
    // would zero out exactly when a runaway gap is at its worst. Nothing in this
    // function reads process state — the same gap object gives the same answer in a
    // freshly-started process.
    const g = meta({ failed_attempts: 30, last_failed_at: agoMs(60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(true);
  });
});

// ─────────── LINEAGE GRAIN: the escape the per-gap version left open ───────────
//
// Measured in the first hour after per-gap backoff deployed: it worked exactly as built —
// route-edit-e32a5778 (failed_attempts 80) stopped being picked — and the lane moved
// straight to recommit-route-edit-630abe48-anchor_not_found (fa 4) and
// recommit-recommit-...-syntax_break (fa 2). Three generations of one defect, each
// individually under the threshold, together a lineage that has failed ten times.
// Across the open store: 29 recommit-* gaps, NONE above fa 4, plus 15 *-narrowed.
//
// A backoff keyed on a gap id is routed around by minting a new id for the same defect,
// which is precisely what recommit and narrowing do — narrowing explicitly resets
// failed_attempts to 0 so the child re-enters at normal priority.
import { lineageBackoffState } from "../../src/resolvers/gap-to-feature.js";

const g = (id: string, m: Record<string, unknown>) => ({ id, classification_metadata: m });
const index = (...rows: Array<Record<string, unknown>>) =>
  new Map(rows.map((r) => [String(r.id), r]));

describe("lineageBackoffState", () => {
  const root = g("route-edit-630abe48", { failed_attempts: 4, last_failed_at: agoMs(9 * 3600_000) });
  const kid = g("recommit-route-edit-630abe48-anchor_not_found", {
    failed_attempts: 4, last_failed_at: agoMs(60_000), source_gap_id: "route-edit-630abe48",
  });
  const grandkid = g("recommit-recommit-route-edit-630abe48-anchor_not_found-syntax_break", {
    failed_attempts: 2, last_failed_at: agoMs(30_000),
    source_gap_id: "recommit-route-edit-630abe48-anchor_not_found",
  });
  const byId = index(root, kid, grandkid);

  it("sums failed attempts across the whole lineage", () => {
    expect(lineageBackoffState(grandkid, byId).attempts).toBe(10);
    expect(lineageBackoffState(kid, byId).attempts).toBe(8);
    expect(lineageBackoffState(root, byId).attempts).toBe(4);
  });

  it("follows parent_gap_id as well as source_gap_id", () => {
    // Narrowing writes parent_gap_id; recommit writes source_gap_id. Both are structural,
    // so neither needs the gap id to be parsed as a string.
    const narrowed = g("x-narrowed", { failed_attempts: 1, parent_gap_id: "route-edit-630abe48" });
    expect(lineageBackoffState(narrowed, index(root, narrowed)).attempts).toBe(5);
  });

  it("takes the MOST RECENT failure in the lineage — the part that closes the escape", () => {
    // A freshly minted child has failed_attempts 0 and NO last_failed_at of its own. Judged
    // on itself it fails open and is instantly eligible, which is the whole escape.
    const fresh = g("recommit-fresh", { failed_attempts: 0, source_gap_id: "recommit-route-edit-630abe48-anchor_not_found" });
    const st = lineageBackoffState(fresh, index(root, kid, fresh));
    expect(st.attempts).toBe(8);
    expect(st.lastFailedAtMs).toBe(Date.parse(agoMs(60_000)));
    // ...and it is therefore HELD, where the per-gap version let it straight through.
    expect(gapIsBackedOff(fresh, NOW, st)).toBe(true);
    expect(gapIsBackedOff(fresh, NOW)).toBe(false);
  });

  it("stops at a missing ancestor, yielding LESS backoff — the safe direction", () => {
    // A closed ancestor is absent from the open-gap read. Guessing would be worse than
    // under-counting: under-counting only means the gap is tried sooner.
    const orphan = g("kid", { failed_attempts: 3, last_failed_at: agoMs(0), source_gap_id: "gone" });
    expect(lineageBackoffState(orphan, index(orphan)).attempts).toBe(3);
  });

  it("terminates on a cycle instead of hanging in the selection hot path", () => {
    const a = g("a", { failed_attempts: 1, source_gap_id: "b" });
    const b = g("b", { failed_attempts: 1, source_gap_id: "a" });
    expect(lineageBackoffState(a, index(a, b)).attempts).toBe(2);
  });

  it("bounds the walk by maxDepth", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      g(`n${i}`, { failed_attempts: 1, ...(i < 19 ? { source_gap_id: `n${i + 1}` } : {}) }));
    expect(lineageBackoffState(rows[0]!, index(...rows), 3).attempts).toBeLessThanOrEqual(4);
  });

  it("reports depth 0 for a gap that is its own root", () => {
    expect(lineageBackoffState(root, byId).depth).toBe(0);
    expect(lineageBackoffState(grandkid, byId).depth).toBe(2);
  });
});
