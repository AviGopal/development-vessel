// AN EMPTY PREDICATE IS NOT A MEASURABLE ONE, SO A LANDED ROW CARRYING IT IS NOT RE-PICKED (research KNOWN-WRONG 12,
// the W5 class; ledger finding agf_nyql2vatzhn1).
//
// pickSkipPending skips a landed row awaiting its verdict (pending_outcome_verification holds a sha) when it carries no
// measurable predicate: another compose would edit the fix's fresh lines before anything measured it. "Measurable" was
// `typeof x === 'string'`, and the store carries "" forward to mean cleared (verify_shape is blanked, not deleted), so
// a landed row whose predicate was "" or whitespace read as measurable, fell through the skip and was re-picked.
// A predicate field now counts only as a non-empty trimmed string. pickCandidate's walk is driven with injected
// hooks, so the landed row ranks first and the walk must pass it.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "pick-skip-empty-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
const { pickSkipPending, pickCandidate } = await import("../../src/judge/gap-admission.js");
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

type Row = Record<string, unknown>;
const LANDED = "abcdef1234567";
const row = (id: string, meta: Row): Row => ({ id, category: "systematic_failure", status: "open", summary: `pick-skip probe ${id}`, classification_metadata: meta });
const skip = (g: Row): boolean => pickSkipPending(g, [g], new Map());
/** One pick over `rows`, ranked by the injected score (first row highest). Returns the picked id and skipped count. */
function pick(rows: Row[]): { picked: string; skipped: number } {
  let skipped = -1;
  const score = new Map(rows.map((r, i) => [String(r.id), 0.9 - i * 0.1] as [string, number]));
  const chosen = pickCandidate(rows, {
    lineageIndex: new Map(),
    score: (g) => score.get(String(g.id)) ?? 0,
    rerank: () => {},
    onPicked: (p) => { skipped = p.skippedPending; },
    ask: (async () => ({ shape: "uiQuestionWriteResult", body: { ok: true } })) as never,
  });
  return { picked: String(chosen?.id ?? ""), skipped };
}

describe("a landed row's empty predicate is not measurable", () => {
  for (const [field, empty] of [["expected_literal", ""], ["hardcoded_url", "   "], ["verify_shape", ""], ["evidence_resolve", " \t"]] as const) {
    it(`MUST-FAIL a landed row whose only predicate is ${field}=${JSON.stringify(empty)} is skipped`, () => {
      expect(skip(row(`ps-empty-${field}`, { falsifier: "class1", pending_outcome_verification: LANDED, [field]: empty }))).toBe(true);
    });
  }

  it("MUST-FAIL the walk passes a landed empty-predicate row that ranks first and picks the next candidate", () => {
    const landed = row("ps-walk-landed", { falsifier: "class1", pending_outcome_verification: LANDED, expected_literal: "" });
    const next = row("ps-walk-next", { falsifier: "class1" });
    expect(pick([landed, next])).toEqual({ picked: "ps-walk-next", skipped: 1 });
  });

  it("CONTROL a landed row with a real predicate is not skipped by the stamp, and a row not landed is not skipped", () => {
    expect(skip(row("ps-real-literal", { falsifier: "class1", pending_outcome_verification: LANDED, hardcoded_url: "http://pick-skip-real-literal" }))).toBe(false);
    expect(skip(row("ps-not-landed", { falsifier: "class1", expected_literal: "" }))).toBe(false);
    const real = row("ps-walk-real", { falsifier: "class1", pending_outcome_verification: LANDED, hardcoded_url: "http://pick-skip-real-literal" });
    expect(pick([real, row("ps-walk-other", { falsifier: "class1" })])).toEqual({ picked: "ps-walk-real", skipped: 0 });
  });
});
