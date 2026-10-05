// A SCOPE CHANGE MADE BY THE CRITERION IS NOT DRIFT; ANY OTHER EDIT STILL IS (REALIGNMENT §7 step 9, ruling 3).
//
// autonomy_scope_pinned (pool_record_pin) compares each node's live autonomyScope to the operator-seeded value. The
// accepted evaluator (scope-earn-in.ts) now changes that record by the adopted criterion, writing it with the pool's
// evaluator attestation plus an append-only autonomyScopeChange record. The pin must accept exactly that change (the
// change records chain from the pinned set to the live set, and the live record carries the evaluator attestation)
// and must keep filing a divergence for every other edit, attested or not. Otherwise the first criterion change
// files a gap and an operator re-pin, an operator record edit, resets the exit metric.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = mkdtempSync(join(tmpdir(), "scope-change-pin-"));
const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { evaluateSelfFactRow, __setPoolPinDepsForTests } = sfr;

type Row = Record<string, unknown>;
const NODE = "c951b44f4a99";
const A = "repos/development-vessel/src/resolvers/fixture-earn-a.ts";
const B = "repos/development-vessel/src/resolvers/fixture-earn-b.ts";
const CORE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const PINNED = [CORE, A, B, "scripts/substrate/"];
const row: sfr.SelfFactRow = {
  id: "autonomy_scope_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: CORE,
  must_fail: "a planted path and class must be reported", pool_shape: "autonomyScope",
  expected_by_node: { [NODE]: { excluded_paths: PINNED, require_falsifier_classes: ["class2"] } } as never, nodes: [NODE],
};
const EVAL = { by: "evaluator", evaluator: "scope_earn_in_apply", key_id: null, at: "2026-10-05T12:00:00Z" };
const rec = (paths: string[], attested?: Row) => ({ id: "autonomy-scope", updated_at: "2026-10-05T12:00:00Z", body: { excluded_paths: paths, require_falsifier_classes: ["class2"] }, ...(attested ? { attested } : {}) });
const change = (seq: number, prior: string[], after: string[], by = "scope_earn_in_apply") => ({ body: { applied_by: by, seq, prior_excluded_paths: prior, excluded_paths_after: after } });

let live: Row | null = null;
let changes: Array<{ body?: unknown }> = [];
async function judge() {
  const prev = process.env["SUBSTRATE_NAME"];
  process.env["SUBSTRATE_NAME"] = NODE;
  __setPoolPinDepsForTests({ readNewest: async () => live as never, readChanges: async () => changes } as never);
  try {
    const r = await evaluateSelfFactRow(row);
    return { r, real: (r?.divergences ?? []).filter((d) => !d.canary), canaries: (r?.divergences ?? []).filter((d) => d.canary) };
  } finally {
    if (prev === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = prev;
  }
}
afterEach(() => { __setPoolPinDepsForTests(null); live = null; changes = []; });

describe("autonomy_scope_pinned accepts the criterion's changes and nothing else (must-fail at base)", () => {
  it("an evaluator-attested change with a matching change-record chain files nothing; the canary still fires", async () => {
    live = rec([CORE, "scripts/substrate/"], EVAL);
    changes = [change(1, PINNED, [CORE, B, "scripts/substrate/"]), change(2, [CORE, B, "scripts/substrate/"], [CORE, "scripts/substrate/"])];
    const { r, real, canaries } = await judge();
    expect(real).toEqual([]);
    expect(canaries.length).toBe(1);
    expect(String(r?.note)).toContain("2 evaluator change(s) accepted");
  });
});

describe("autonomy_scope_pinned still files every other edit (controls: green at base, reddened when the pin ignores the attestation)", () => {

  it("the same content written without the evaluator attestation (an unattested record edit) is divergence", async () => {
    live = rec([CORE, "scripts/substrate/"]);
    changes = [change(1, PINNED, [CORE, B, "scripts/substrate/"]), change(2, [CORE, B, "scripts/substrate/"], [CORE, "scripts/substrate/"])];
    const { real } = await judge();
    expect(real.map((d) => d.key)).toEqual([`${NODE}-mismatch`]);
  });

  it("an operator-attested edit is divergence too (the pin is the operator's record; re-pin it in the row)", async () => {
    live = rec([CORE, "scripts/substrate/"], { by: "operator", key_id: "k", at: "x" });
    changes = [change(1, PINNED, [CORE, "scripts/substrate/"])];
    expect((await judge()).real.map((d) => d.key)).toEqual([`${NODE}-mismatch`]);
  });

  it("an evaluator-attested record that went past its change records, or a broken chain, is divergence", async () => {
    // Live set has a path removed that no change record accounts for.
    live = rec([CORE], EVAL);
    changes = [change(1, PINNED, [CORE, B, "scripts/substrate/"])];
    expect((await judge()).real.length).toBe(1);
    // Chain broken: the second record's prior is not the first record's after.
    live = rec([CORE, "scripts/substrate/"], EVAL);
    changes = [change(1, PINNED, [CORE, B, "scripts/substrate/"]), change(2, [CORE, A, "scripts/substrate/"], [CORE, "scripts/substrate/"])];
    expect((await judge()).real.length).toBe(1);
    // Records written by someone else do not count.
    changes = [change(1, PINNED, [CORE, "scripts/substrate/"], "someone_else")];
    expect((await judge()).real.length).toBe(1);
  });

  it("control: the record at its pinned value reads clean with no change records", async () => {
    live = rec(PINNED);
    expect((await judge()).real).toEqual([]);
  });
});
