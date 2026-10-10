// A DRAINING OR QUIESCED GOAL-HOST IS NOT A FAILED ATTEMPT (caller audit of goal-host's 503 refusals). The
// trace-store-reconcile route POSTs goal-host /run-goal and read `dispatched = res.ok`, so a 503 answering
// {error:"quiesced", retryable:true} or {draining:true} fell into bumpFailedAttempts: failed_attempts, the
// calibration miss and an exemption spent, and at >= 3 a narrowed child, for a dispatch that never ran. Such a
// 503 now leaves the gap untouched for the next tick; any other non-ok answer still bumps.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as unknown as Record<string, unknown>;
type Pred = (status: number, text: string) => boolean;
const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");

describe("a goal-host 503 that says retryable/draining/quiesced is not a failed attempt", () => {
  it("[MUST-FAIL] 503 {error:'quiesced', retryable:true} and 503 {draining:true} are retryable refusals", () => {
    const p = g2f["isRetryableDispatchRefusal"] as Pred | undefined;
    expect(typeof p).toBe("function");
    expect(p!(503, JSON.stringify({ error: "quiesced", retryable: true }))).toBe(true);
    expect(p!(503, JSON.stringify({ draining: true }))).toBe(true);
    expect(p!(503, JSON.stringify({ error: "goal-host is draining" }))).toBe(true);
  });
  it("[CONTROL] a real failure is not: a 500, a 503 that does not say so, a 400 that says retryable, an unparseable body", () => {
    const p = g2f["isRetryableDispatchRefusal"] as Pred | undefined;
    expect(typeof p).toBe("function");
    expect(p!(500, JSON.stringify({ error: "boom" }))).toBe(false);
    expect(p!(503, JSON.stringify({ error: "upstream unavailable" }))).toBe(false);
    expect(p!(400, JSON.stringify({ retryable: true }))).toBe(false);
    expect(p!(503, "<html>Service Unavailable</html>")).toBe(false);
  });
  it("the trace-store-reconcile route consults it before bumping, and still bumps a real failure", () => {
    const i = SRC.indexOf("const dispatched = res.ok;");
    expect(i).toBeGreaterThan(0);
    const branch = SRC.slice(i, SRC.indexOf('dispatch_status: res.status', i));
    expect(branch).toMatch(/\} else if \(isRetryableDispatchRefusal\(res\.status, text\)\) \{[\s\S]*?\} else \{\s*await bumpFailedAttempts\(gap, \{ decisionId: attempt\.id \}\);/);
  });
});
