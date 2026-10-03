// Pins WHAT /health in_flight counts, separately from WHAT a drain refuses.
//
// THE DEFECT. src/index.ts uses ONE predicate, isLongRunningBody, for two jobs: refusing new
// long-running work while draining (503 + Retry-After) and counting requests toward
// in_flight. isLongRunningBody only knows LONG_RUNNING_TYPES (the drafting runs). But this
// vessel also serves llm_completion_dispatch (config.ts), a call that can take minutes, and it
// is invisible to in_flight. substrate-pull-sync reads in_flight before an OWED restart, so
// on 2026-09-30 at 16:11:17 it restarted development-vessel mid-call and killed a goal-host
// floor dispatch.
//
// The two jobs need DIFFERENT predicates. Counting must see llm_completion_dispatch, so a
// restart waits for it. Drain-refusal must NOT start refusing it: an llm call is short enough
// to finish inside the drain window, and refusing it would fail the floor dispatch the fix
// exists to protect.
//
// WHAT THE LANE MUST ADD for green: an exported `countsTowardInFlight(raw: string): boolean`
// in src/long-running.ts (true for every LONG_RUNNING_TYPES pointer and for
// llm_completion_dispatch, both envelope spellings, fail-closed like isLongRunningBody), and
// src/index.ts must count in_flight with it while keeping isLongRunningBody for the drain 503.
//
// THE COUNTER AND THE RECORD ARE ONE ADMISSION. /health publishes three in-flight numbers:
// in_flight (the counter), in_flight_oldest_ms and in_flight_last_progress_ms (both read from
// the per-request record src/lib/compose-progress.ts admits, which runs the handler under the
// record so stage stamps land on it). If the counter moves to countsTowardInFlight but the
// record stays under isLongRunningBody, an llm_completion_dispatch is counted yet has no age:
// pull-sync sees in_flight=1 with an oldest age that ignores it. So the record must be admitted
// (admitInFlight) in the same countsTowardInFlight block that increments the counter, once.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lr from "../src/long-running";

type Pred = (raw: string) => boolean;
const counts = (lr as unknown as { countsTowardInFlight?: Pred }).countsTowardInFlight;

const wrapped = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ impulse: { pointer: { type, ...extra } } });
const bare = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ pointer: { type, ...extra } });

const LLM_EXTRA = { prompt: "summarise the gap", model: "default", max_tokens: 2048 };

describe("in-flight counting: an llm_completion_dispatch call is in flight", () => {
  test("countsTowardInFlight counts llm_completion_dispatch in both envelope spellings", () => {
    expect(typeof counts).toBe("function");
    expect(counts!(wrapped("llm_completion_dispatch", LLM_EXTRA))).toBe(true);
    expect(counts!(bare("llm_completion_dispatch", LLM_EXTRA))).toBe(true);
  });

  test("src/index.ts admits the in-flight record in the same countsTowardInFlight block as the counter", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const at = src.search(/countsTowardInFlight\s*\(\s*raw\s*\)/);
    expect(at).toBeGreaterThanOrEqual(0);
    const block = src.slice(at, at + 1500);
    expect(block.includes("inFlightRequests++")).toBe(true);
    expect(/admitInFlight\s*\(/.test(block)).toBe(true);
    expect((src.match(/admitInFlight\s*\(/g) ?? []).length).toBe(1);
  });

  test("src/index.ts counts in_flight with countsTowardInFlight, not with the drain predicate", () => {
    // The predicate is only half the fix: /health reads the counter index.ts increments.
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(/countsTowardInFlight\s*\(\s*raw\s*\)/.test(src)).toBe(true);
  });
});

describe("in-flight counting: controls", () => {
  test("drain-refusal (isLongRunningBody) does NOT refuse llm_completion_dispatch", () => {
    expect(lr.isLongRunningBody(wrapped("llm_completion_dispatch", LLM_EXTRA))).toBe(false);
    expect(lr.isLongRunningBody(bare("llm_completion_dispatch", LLM_EXTRA))).toBe(false);
  });

  test("drain-refusal still refuses feature_compose and ignores memoryNote", () => {
    expect(lr.isLongRunningBody(wrapped("feature_compose"))).toBe(true);
    expect(lr.isLongRunningBody(bare("feature_compose"))).toBe(true);
    expect(lr.isLongRunningBody(wrapped("memoryNote", { title_prefix: "x" }))).toBe(false);
  });

  test("src/index.ts still refuses drain admission with isLongRunningBody", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(/isLongRunningBody\s*\(/.test(src)).toBe(true);
  });

  // Vacuous at HEAD (the function does not exist yet); binding once the lane adds it, so a
  // fix that counts everything, or drops the drafting runs, is caught.
  test("countsTowardInFlight (when present) still counts every long-running type and not a read shape", () => {
    if (typeof counts !== "function") return;
    for (const t of lr.LONG_RUNNING_TYPES) {
      expect(counts(wrapped(t))).toBe(true);
      expect(counts(bare(t))).toBe(true);
    }
    expect(counts(wrapped("memoryNote", { title_prefix: "x" }))).toBe(false);
    expect(counts(bare("memoryNote"))).toBe(false);
    // Prose that merely mentions an llm call is not one (the 9-vs-1 regression, for the new type).
    expect(counts(wrapped("memoryNote_write", { body: "llm_completion_dispatch notes" }))).toBe(false);
    expect(counts("not json")).toBe(false);
    expect(counts("")).toBe(false);
  });
});
