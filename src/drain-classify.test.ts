// Pins WHICH requests the drain waits for.
//
// A first version counted EVERY request. Measured immediately on the live vessel:
// steady state is 3-5 concurrent requests (health polls, registry reads, short
// resolves), so "0 in flight" is unreachable — the drain burned its full 240s
// budget every time and then killed the compose anyway. A gate that holds the
// door but never lets go is the same outage with a longer preamble.
//
// The predicate is duplicated here rather than exported, because importing
// index.ts starts an HTTP server. If it changes there it must change here.
import { describe, test, expect } from "bun:test";

const LONG_RUNNING = /(feature_compose|patch_with_tools|apply_proposal_as_patch|vessel_mitosis)/i;

describe("drain classification — counts only work worth waiting for", () => {
  test("the drafting surfaces are counted", () => {
    for (const shape of ["feature_compose", "patch_with_tools", "apply_proposal_as_patch", "vessel_mitosis_cutover"]) {
      expect(LONG_RUNNING.test(JSON.stringify({ pointer: { type: shape } }))).toBe(true);
    }
  });

  test("short traffic is NOT counted — this is why 0 was unreachable", () => {
    for (const body of [
      '{"pointer":{"type":"memoryNote"}}',
      '{"pointer":{"type":"substrateGap"}}',
      '{"pointer":{"type":"vesselCapability","shape":"shellResult"}}',
      "",
    ]) {
      expect(LONG_RUNNING.test(body)).toBe(false);
    }
  });

  test("a health poll is never counted", () => {
    // GET /health carries no body at all; the wrapper only inspects POSTs.
    expect(LONG_RUNNING.test("")).toBe(false);
  });

  test("matching is case-insensitive and substring-tolerant", () => {
    // The shape may arrive nested, quoted, or differently cased.
    expect(LONG_RUNNING.test('{"type":"FEATURE_COMPOSE"}')).toBe(true);
    expect(LONG_RUNNING.test('{"a":{"b":{"type":"patch_with_tools"}}}')).toBe(true);
  });

  test("an unrelated shape whose name merely contains 'compose' is not matched", () => {
    // Guard against over-matching: only the named surfaces block a restart.
    expect(LONG_RUNNING.test('{"type":"compose_topology_tick"}')).toBe(false);
    expect(LONG_RUNNING.test('{"type":"composition_graph"}')).toBe(false);
  });
});
