// "CHANGED" IS THE FAILURE SIGNATURE (qa ruling, 2026-10-24). The edit-site and region gates call a mutant run changed
// when the named tests turn green, or when a named test's failure SIGNATURE moves: its failing assertion (the matcher's
// error line and message), the Expected and Received values it printed, and where it failed (the first stack frame's
// file name, line and column, read when that frame is in the check). Same pass/fail with a different signature is a
// change; the same signature is not. Pinned on mutationGateVerdict with run reports shaped as test_suite returns them
// (red_reason from retry-evidence classifyCheckRun).
import { describe, expect, it } from "bun:test";

const supply = await import("../../src/resolvers/gap-check-supply.js");
type Row = Record<string, unknown>;
const T = "the gate refusal is logged";
const NAME = `suite > ${T}`;
const report = (f: { error?: string; expected?: string; received?: string; file?: string; line?: number; col?: number } | "green", mutated = true): Row => f === "green"
  ? { ran: true, requested_not_passing: 0, ...(mutated ? { mutation: { kind: "edit", applied: true } } : {}), red_reason: { ran: true, pass: 1, unhandled: false, unhandled_cause: null, unhandled_error: null, failures: [], compared: [] } }
  : { ran: true, requested_not_passing: 1, ...(mutated ? { mutation: { kind: "edit", applied: true } } : {}),
      red_reason: { ran: true, pass: 0, unhandled: false, unhandled_cause: null, unhandled_error: null,
        failures: [{ name: NAME, cls: "assertion", error: f.error ?? "error: expect(received).toBe(expected)" }],
        compared: [{ name: NAME, file: f.file ?? "/tmp/test-suite-base-x/test/checks/g.check.ts", line: f.line ?? 40, col: f.col ?? 18, expected: f.expected ?? "1", received: f.received ?? "0" }] } };
const mutant = { operator: "replace_statement" as const, start: 0, end: 1, original: "x", replacement: "y", line: 1 };
const verdict = (base: Row, run: Row) => supply.mutationGateVerdict(base, [{ mutant, report: run }], [T]);
const BASE = report({}, false);

describe("mutationGateVerdict compares the failure signature", () => {
  it("[MUST-FAIL] the same assertion failing at another line of the check is a change (location is in the signature)", () => {
    expect(verdict(BASE, report({ line: 33, col: 5 }))).toEqual({ measured: 1, changed: 1, unmeasured: 0 });
  });
  it("[CONTROL] the identical signature is no change, whatever tree path the run took", () => {
    expect(verdict(BASE, report({ file: "/tmp/test-suite-base-y/test/checks/g.check.ts" }))).toEqual({ measured: 1, changed: 0, unmeasured: 0 });
  });
  it("[CONTROL] a different Received, Expected or error message is a change; green is a change", () => {
    expect(verdict(BASE, report({ received: "2" })).changed).toBe(1);
    expect(verdict(BASE, report({ expected: "\"arm_refused\"" })).changed).toBe(1);
    expect(verdict(BASE, report({ error: "error: expect(received).toEqual(expected)" })).changed).toBe(1);
    expect(verdict(BASE, report("green")).changed).toBe(1);
  });
  it("[CONTROL] a frame outside the check (the mutated site moving lines) is not read", () => {
    const inSite = (line: number) => report({ file: "/tmp/w/src/resolvers/gap-check-supply.ts", line });
    expect(verdict(inSite(100) as Row & { mutation?: unknown }, inSite(104)).changed).toBe(0);
  });
});
