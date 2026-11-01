// THE OWN-CHECK BASELINE MEASURES HONEST-ORIGIN ROWS FIRST (gap-check-supply.ts dispatchOwnCheckBaselines): of the rows
// with an unmeasured own check, those that are system-born by the autonomy judge's origin predicate (operator-acts.ts
// isSystemBornLineage, over the store read the tick holds) are measured before the rest; each group keeps its order,
// and the per-tick bound is unchanged.
//   MUST-FAIL  given a mixed list (free text, no source, an operator row, then a system-born row), the system-born row
//              is measured first;
//   MUST-FAIL  a substrate_detected child of a source-less parent in the store read is not honest: the root-honest row
//              is measured first;
//   CONTROL    an all-honest list keeps its order.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-baseline-honest-first-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ONE = join(ROOT, "one"), TWO = join(ROOT, "two");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const HEAD = "f".repeat(40);
beforeAll(() => {
  for (const [d, n] of [[ONE, 1], [TWO, 2]] as const) {
    mkdirSync(join(d, ".git"), { recursive: true });
    mkdirSync(join(d, "policies"), { recursive: true });
    writeFileSync(join(d, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: n }));
  }
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

type Row = Record<string, unknown>;
const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" } };
const row = (id: string, source: string | undefined, meta: Row = {}): Row => ({ id, status: "open", category: "systematic_failure", ...(source === undefined ? {} : { source }), summary: "s", classification_metadata: { ...check, ...meta } });
async function tick(open: Row[], env: string, byId?: Map<string, Row>) {
  let n = 0;
  const sent = await supply.dispatchOwnCheckBaselines(open as never, {
    node: "node-a", nowIso: "2026-01-01T00:00:00Z", env: { SUPER_REPO_DIR: env },
    write: async () => ({ shape: "substrateGap", body: {} }),
    send: (async () => { n += 1; return { shape: "goalDispatchResult", body: { dispatch_id: `disp-${n}` } }; }) as never,
    headOf: () => HEAD,
    executionIdOf: async () => null,
    ...(byId ? { byId } : {}),
  } as never);
  return sent.map((s) => s.id);
}

describe("own-check baselines measure honest-origin rows first", () => {
  it("MUST-FAIL: in a mixed list the system-born row is measured first", async () => {
    const rows = [row("text-row", "development vessel"), row("nosrc-row", undefined), row("op-row", "operator:qa"), row("sys-row", "substrate_detected")];
    expect(await tick(rows, ONE)).toEqual(["sys-row"]);
  });
  it("MUST-FAIL: a child of a source-less parent in the store read is not honest", async () => {
    const child = row("linked-child", "substrate_detected", { parent_gap_id: "nosrc-parent" }), sys = row("sys-row", "substrate_detected");
    const store = new Map<string, Row>([["nosrc-parent", { id: "nosrc-parent", status: "closed", classification_metadata: {} }], ["linked-child", child], ["sys-row", sys]]);
    expect(await tick([child, sys], ONE, store)).toEqual(["sys-row"]);
  });
  it("CONTROL: an all-honest list keeps its order", async () => {
    const rows = [row("sys-a", "substrate_detected"), row("sys-b", "substrate_detected"), row("sys-c", "goal_deficiency_recognition")];
    expect(await tick(rows, TWO)).toEqual(["sys-a", "sys-b"]);
  });
});
