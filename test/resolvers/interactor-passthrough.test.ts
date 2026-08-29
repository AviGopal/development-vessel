// Per-resolver test for the interactor_* write passthrough (R8.1).
//
// The load-bearing behaviour here is a REFUSAL. uiFeedback_write was reachable as a generic
// floor satisfier, so a goal-walk with no better path "reached" by writing its payload into
// the operator-feedback channel — boredom's own comment describes it as "writing more
// feedback rather than changing the panel". Measured 2026-08-28: the durable log held 48
// records and ZERO carried panel_id; every one was goal-walk payload. The operator-feedback
// corpus contained no operator feedback.
//
// These tests pin both halves: the refusal that makes the shape non-satisfying, and the
// scoping that keeps the other interactor channels unconstrained.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInteractorWrite } from "../../src/resolvers/interactor-passthrough.js";

let root: string;
let originalWS: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "interactor-"));
  originalWS = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = root;
});

afterEach(async () => {
  if (originalWS === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = originalWS;
  await rm(root, { recursive: true, force: true });
});

describe("uiFeedback_write — operator-origin contract", () => {
  it("accepts a real panel answer and appends it to the durable log", async () => {
    const r = await resolveInteractorWrite({
      type: "uiFeedback_write",
      panel_id: "needs-human-some-gap",
      value: "REDEFINE: the sensor only tests one side.",
      kind: "answer",
    });
    expect(r.shape).toBe("uiFeedback_write");
    expect((r.body as { ok: boolean; logged: boolean }).ok).toBe(true);
    expect((r.body as { logged: boolean }).logged).toBe(true);
    const log = await readFile(join(root, "interactor-log", "uiFeedback_write.jsonl"), "utf8");
    expect(log).toContain("needs-human-some-gap");
  });

  it("refuses a write with no panel_id — the floor-satisfier path", async () => {
    const r = await resolveInteractorWrite({ type: "uiFeedback_write", value: "something" });
    expect(r.shape).toBe("structuredError");
    expect(String((r.body as { detail: string }).detail)).toContain("panel_id");
  });

  it("refuses the exact goal-payload shape found in the live log", async () => {
    // Verbatim shape of the 48 polluting records: dispatch text under `goal`, no panel_id.
    const r = await resolveInteractorWrite({
      type: "uiFeedback_write",
      goal: "investigate and decompose gap reach-history-weekly-counter-inflated: in repos/activity-api",
      dispatch_id: "540a5bdd-8543-41e8-af3e-929c0fdc5ba7",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("does not write anything to the log when it refuses", async () => {
    // A refusal that still appended would leave the corpus polluted while reporting clean.
    await resolveInteractorWrite({ type: "uiFeedback_write", goal: "some goal text" });
    await expect(readFile(join(root, "interactor-log", "uiFeedback_write.jsonl"), "utf8")).rejects.toThrow();
  });

  it("treats a blank or non-string panel_id as absent", async () => {
    for (const bad of ["", "   ", 42, null, undefined, {}]) {
      const r = await resolveInteractorWrite({ type: "uiFeedback_write", panel_id: bad, value: "x" });
      expect(r.shape).toBe("structuredError");
    }
  });
});

describe("other interactor channels stay unconstrained", () => {
  // Scoping guard. These are append-only observation channels with no panel semantics;
  // requiring panel_id on them would break real producers to fix a different shape's bug.
  it("accepts interactorEvent_write and interactorAssertion_write without a panel_id", async () => {
    for (const type of ["interactorEvent_write", "interactorAssertion_write", "interactorDismiss_write"] as const) {
      const r = await resolveInteractorWrite({ type, detail: "observation" });
      expect(r.shape).toBe(type);
      expect((r.body as { ok: boolean }).ok).toBe(true);
    }
  });
});
