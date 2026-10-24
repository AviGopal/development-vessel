// ONE LIFECYCLE EVENT PER EXECUTION ACROSS activity-api's VERDICT RE-EMIT (qa condition 3b for aa 05d0da38, the same
// treatment as autocomplete-concept-writer bf068d73). The re-emit is an execution_completed carrying `reached` and
// `verdict: true`, sent when POST /reach persists an execution's first verdict; this observer acts on the completion
// (probe dispatch, harness re-score, topology chain), so the re-emit would act on it a second time.
// MUST-FAIL: a completion and its verdict re-emit for one execution_id -> exactly one normalised event.
// CONTROL: distinct execution ids -> one each; the lifecycle.execution.succeeded bus form is unchanged.
import { describe, it, expect } from "bun:test";
import * as rco from "../../src/observers/registry-change-observer.js";

type N = (parsed: Record<string, unknown>) => Record<string, unknown> | null;
const exported = (rco as unknown as { normalizeLifecycleMessage?: N }).normalizeLifecycleMessage;
// At a tree without normalizeLifecycleMessage, the handler's own decision there: every execution_completed normalised.
const parentNormalise: N = (p) => {
  const d = (p["data"] ?? {}) as Record<string, unknown>;
  if (p["type"] === "execution_completed") return { type: "lifecycle:execution:succeeded", activity_template_id: d["activity_id"], execution_id: d["execution_id"] };
  if (p["type"] === "lifecycle.execution.succeeded") return { type: "lifecycle:execution:succeeded", activity_template_id: d["templateId"], execution_id: d["executionId"] };
  return p;
};
const normalise: N = exported ?? parentNormalise;
const completed = (id: string, extra: Record<string, unknown> = {}) => ({ type: "execution_completed", data: { activity_id: "development-vessel:harness-run-matrix", execution_id: id, success: true, ...extra } });
const acted = (msgs: Array<Record<string, unknown>>) => msgs.map((m) => normalise(m)).filter((e) => e !== null && e["type"] === "lifecycle:execution:succeeded");

describe("registry-change-observer: one event per execution across the verdict re-emit", () => {
  it("MUST-FAIL: a completion and its verdict re-emit for one execution_id -> exactly one normalised event", () => {
    expect(acted([completed("exec-1"), completed("exec-1", { reached: true, verdict: true })]).length).toBe(1);
  });
  it("CONTROL: distinct ids -> one each; the bus form normalises as before", () => {
    expect(acted([completed("exec-a"), completed("exec-b")]).map((e) => e!["execution_id"])).toEqual(["exec-a", "exec-b"]);
    expect(normalise({ type: "lifecycle.execution.succeeded", data: { templateId: "t", executionId: "exec-c" } })).toMatchObject({ type: "lifecycle:execution:succeeded", activity_template_id: "t", execution_id: "exec-c" });
  });
});
