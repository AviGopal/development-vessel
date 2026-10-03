// EVERY ADMITTED COMPOSE ATTEMPT IS ON THE LEDGER, NOT ONLY LANDINGS (gap: the-causal-attempt-ledger-records-only-
// landings-so-failed-attempts-have-no-ledger-entry). The causal attempt ledger got an attemptIntent only when a
// compose reached its cutover, so a compose that failed (stage decompose, "plan had no ops"; a verify failure; a
// terminal refusal) left no record at all, and the ledger could not say how many attempts a gap cost or how they
// ended. Now a pick writes an attemptIntent under its decision id, and the attempt's end writes an attemptOutcome
// (landed / failed with stage + class / refused) under the same key, on the node that ran it. A killed attempt
// cannot write its own end, so it stays intent-only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "g2f-ledger-"));
const saved = process.env["ATTEMPT_LEDGER_DIR"];
process.env["ATTEMPT_LEDGER_DIR"] = DIR;
const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as unknown as Record<string, unknown>;
const { readRecords } = await import("../../src/resolvers/attempt-ledger.js");
type Row = Record<string, unknown>;
type Intent = (attemptId: string, gap: Row) => void;
type End = (attemptId: string, gap: Row, result: { shape: string; body: unknown } | null, err?: unknown) => void;

beforeAll(() => { process.env["ATTEMPT_LEDGER_DIR"] = DIR; });
afterAll(() => {
  if (saved !== undefined) process.env["ATTEMPT_LEDGER_DIR"] = saved; else delete process.env["ATTEMPT_LEDGER_DIR"];
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* temp */ }
});

const gap = (id: string): Row => ({ id, category: "systematic_failure", classification_metadata: { edit_site: "repos/activity-api/src/a.ts", directed: false } });

describe("gap-to-feature writes the attempt ledger for every admitted compose", () => {
  it("a compose that fails at stage decompose ('plan had no ops') has an intent and an outcome carrying stage and class", () => {
    expect(typeof g2f["recordPickIntent"]).toBe("function");
    expect(typeof g2f["recordAttemptEnd"]).toBe("function");
    const id = `dec-test-${Math.random().toString(36).slice(2, 8)}`;
    (g2f["recordPickIntent"] as Intent)(id, gap("g-decompose"));
    const report = { shape: "gapToFeatureReport", body: { ok: false, gap_id: "g-decompose", verdict: "decompose", landed: false, compose: { ok: false, stage: "decompose", error: "plan had no ops" } } };
    (g2f["recordAttemptEnd"] as End)(id, gap("g-decompose"), report);
    const intent = readRecords("attemptIntent", { key: id })[0]?.record as Row | undefined;
    expect(intent?.["gap_id"]).toBe("g-decompose");
    expect(intent?.["attempt_id"]).toBe(id);
    expect(typeof intent?.["node"]).toBe("string");
    const out = readRecords("attemptOutcome", { key: id })[0]?.record as Row | undefined;
    expect(out?.["outcome"]).toBe("failed");
    expect(out?.["landed"]).toBe(false);
    expect(out?.["stage"]).toBe("decompose");
    expect(out?.["class"]).toBe("plan had no ops");
    expect(out?.["gap_id"]).toBe("g-decompose");
  });

  it("a landed compose records outcome landed with its commit; a terminal refusal records refused", () => {
    expect(typeof g2f["recordAttemptEnd"]).toBe("function");
    const a = `dec-land-${Math.random().toString(36).slice(2, 8)}`;
    (g2f["recordAttemptEnd"] as End)(a, gap("g-land"), { shape: "gapToFeatureReport", body: { ok: true, landed: true, landed_commit: "abc1234", compose: { ok: true, verdict: "FAVORABLE" } } });
    const la = readRecords("attemptOutcome", { key: a })[0]?.record as Row | undefined;
    expect(la?.["outcome"]).toBe("landed");
    expect(la?.["commit"]).toBe("abc1234");
    const b = `dec-ref-${Math.random().toString(36).slice(2, 8)}`;
    (g2f["recordAttemptEnd"] as End)(b, gap("g-ref"), { shape: "gapToFeatureReport", body: { ok: false, landed: false, compose: { ok: false, verdict: "UNFAVORABLE", failure_kind: "terminal_refusal", terminal_refusal: "the gap is already CLOSED in the store" } } });
    const rb = readRecords("attemptOutcome", { key: b })[0]?.record as Row | undefined;
    expect(rb?.["outcome"]).toBe("refused");
    expect(rb?.["class"]).toBe("terminal_refusal");
  });
});
