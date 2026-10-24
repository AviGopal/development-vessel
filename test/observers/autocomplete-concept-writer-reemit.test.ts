// ONE CONCEPT WRITE PER EXECUTION WHEN activity-api RE-EMITS execution_completed ON ITS FIRST VERDICT (qa condition 3b
// for aa 05d0da38). The re-emit carries `reached` and `verdict: true` and arrives when the verdict is persisted, minutes
// after the completion event and outside this writer's 60 s dedupe window, so it would be a second concept write per
// graded execution. The writer's intent is the completion (it reads no verdict), so the re-emit is skipped.
// MUST-FAIL: a completion event and its later verdict re-emit for one execution_id -> exactly one concept write.
// CONTROL: distinct execution ids -> one write each; a replay inside the window is still deduped.
import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as acw from "../../src/observers/autocomplete-concept-writer.js";

type W = (parsed: Record<string, unknown>) => unknown | null;
const exported = (acw as unknown as { writebackFor?: W }).writebackFor;
// At a tree without writebackFor, the same decision the message handler made there: the exported predicate and a
// 60 s window on template::execution.
const seen = new Map<string, number>();
const parentHandler: W = (p) => {
  const d = (p["data"] ?? {}) as Record<string, unknown>;
  const ev = { type: "lifecycle:execution:succeeded", activity_template_id: (d["activity_id"] as string) ?? (d["variant_id"] as string), execution_id: d["execution_id"] as string };
  if (p["type"] !== "execution_completed" || !acw.shouldWriteback(ev)) return null;
  const k = `${ev.activity_template_id}::${ev.execution_id}`;
  const last = seen.get(k);
  if (last !== undefined && Date.now() - last < 60_000) return null;
  seen.set(k, Date.now());
  return acw.buildConceptWritePointer(ev);
};
const writebackFor: W = exported ?? parentHandler;

let clock: ReturnType<typeof spyOn> | null = null;
let now = 1_800_000_000_000;
const at = (ms: number) => { now = ms; };
afterEach(() => { clock?.mockRestore(); clock = null; acw._resetWritebackDedupe(); seen.clear(); });
const completed = (id: string, extra: Record<string, unknown> = {}) => ({ type: "execution_completed", data: { activity_id: "vessel-mitosis-cutover", execution_id: id, success: true, ...extra } });

describe("autocomplete-concept-writer: one write per execution across the verdict re-emit", () => {
  it("MUST-FAIL: a completion and its verdict re-emit 5 minutes later for one execution -> exactly one write", () => {
    clock = spyOn(Date, "now").mockImplementation(() => now);
    at(1_800_000_000_000);
    const writes = [writebackFor(completed("exec-1")), (at(1_800_000_300_000), writebackFor(completed("exec-1", { reached: true, verdict: true })))].filter((w) => w !== null);
    expect(writes.length).toBe(1);
  });
  it("CONTROL: distinct execution ids -> one write each; a replay inside the window is deduped", () => {
    clock = spyOn(Date, "now").mockImplementation(() => now);
    at(1_800_000_000_000);
    const writes = [writebackFor(completed("exec-a")), writebackFor(completed("exec-b")), writebackFor(completed("exec-a"))].filter((w) => w !== null);
    expect(writes.length).toBe(2);
  });
});
