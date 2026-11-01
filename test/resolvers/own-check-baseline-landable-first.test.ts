// THE OWN-CHECK BASELINE MEASURES HONEST, LANDABLE ROWS FIRST (gap-check-supply.ts dispatchOwnCheckBaselines): three
// bands, each in its existing order: honest rows (isSystemBornLineage) the lane could land (an edit_site the live
// autonomy scope does not exclude, matched as the file it names, and no parking disposition), then
// the other honest rows, then the rest. Ordering only: nothing is dropped and the per-tick bound is unchanged.
//   MUST-FAIL  honest A (in-scope edit_site), B (edit_site under an excluded directory), C (awaiting_operator_review)
//              and a non-honest D, given as D, B, C, A: A is measured first;
//   MUST-FAIL  an honest, in-scope row parked needs_information is not promoted: given N, A, A is measured first;
//   CONTROL    every row is still a candidate (a bound of 4 measures all four);
//   CONTROL    an all-landable honest list keeps its order;
//   CONTROL    an unreadable scope promotes no row (the honest-first order stands).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-baseline-landable-first-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ONE = join(ROOT, "one"), TWO = join(ROOT, "two"), FOUR = join(ROOT, "four");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const HEAD = "f".repeat(40);
beforeAll(() => {
  for (const [d, n] of [[ONE, 1], [TWO, 2], [FOUR, 4]] as const) {
    mkdirSync(join(d, ".git"), { recursive: true });
    mkdirSync(join(d, "policies"), { recursive: true });
    writeFileSync(join(d, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: n }));
  }
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

type Row = Record<string, unknown>;
const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" } };
const row = (id: string, source: string, meta: Row = {}): Row => ({ id, status: "open", category: "systematic_failure", source, summary: "s", classification_metadata: { ...check, ...meta } });
const readable = { excluded: ["repos/fixture-vessel/src/core/"], readable: true, reason: "autonomyScope: 1 excluded path(s)" };
const unreadable = { excluded: [], readable: false, reason: "autonomyScope read HTTP 503" };
async function tick(open: Row[], env: string, scope: Row) {
  let n = 0;
  const sent = await supply.dispatchOwnCheckBaselines(open as never, {
    node: "node-a", nowIso: "2026-01-01T00:00:00Z", env: { SUPER_REPO_DIR: env },
    write: async () => ({ shape: "substrateGap", body: {} }),
    send: (async () => { n += 1; return { shape: "goalDispatchResult", body: { dispatch_id: `disp-${n}` } }; }) as never,
    headOf: () => HEAD,
    executionIdOf: async () => null,
    scope: async () => scope,
  } as never);
  return sent.map((s) => s.id);
}
const D = () => row("d-operator", "operator:qa", { edit_site: "repos/fixture-vessel/src/a.ts" });
const B = () => row("b-excluded", "substrate_detected", { edit_site: "repos/fixture-vessel/src/core/b.ts (the writer)" });
const C = () => row("c-review", "substrate_detected", { edit_site: "repos/fixture-vessel/src/c.ts", disposition: "awaiting_operator_review" });
const A = () => row("a-landable", "substrate_detected", { edit_site: "repos/fixture-vessel/src/a.ts" });

describe("own-check baselines measure honest, landable rows first", () => {
  it("MUST-FAIL: of honest rows, the one the lane could land is measured first", async () => {
    expect(await tick([D(), B(), C(), A()], ONE, readable)).toEqual(["a-landable"]);
  });
  it("MUST-FAIL: an honest, in-scope row parked needs_information is not promoted", async () => {
    const N = row("n-parked", "substrate_detected", { edit_site: "repos/fixture-vessel/src/n.ts", disposition: "needs_information" });
    expect(await tick([N, A()], ONE, readable)).toEqual(["a-landable"]);
  });
  it("CONTROL: nothing is dropped; a bound of 4 measures all four rows", async () => {
    expect((await tick([D(), B(), C(), A()], FOUR, readable)).sort()).toEqual(["a-landable", "b-excluded", "c-review", "d-operator"]);
  });
  it("CONTROL: an all-landable honest list keeps its order", async () => {
    const rows = ["x", "y", "z"].map((k) => row(`sys-${k}`, "substrate_detected", { edit_site: `repos/fixture-vessel/src/${k}.ts` }));
    expect(await tick(rows, TWO, readable)).toEqual(["sys-x", "sys-y"]);
  });
  it("CONTROL: an unreadable scope promotes no row", async () => {
    expect(await tick([B(), A()], ONE, unreadable)).toEqual(["b-excluded"]);
  });
});
