// THE SHAPE/DISPATCH AGREEMENT OF THIS TREE, IN THE SUITE. `bun run lint` chains the shared shape-dispatch check
// (scripts/check-shape-dispatch.ts -> packages/shape-dispatch-check/check.ts), and feature_compose's verify runs it on
// every draft and requires exit 0 (feature-compose.ts shapeDispatchOk, no parent baseline). Nothing in `bun test` ran it
// over the vessel's own tree, so an orphan case that landed by hand (gapLearningCredit_write, 10-17) failed every
// compose's verify while the suite stayed green. This runs the same checker over this tree and fails on any
// disagreement: a dispatch case with no advertised shape (and no `// @shape-dispatch:private`), or the reverse.
//
// The checker is found where its two callers look: walking up from this vessel (a super-repo checkout's packages/),
// then the deployed runtime copy feature_compose's verify runs (/vessels/packages). Neither found is a FAILURE, never
// a skip: a gate that silently does not run reads as passing.
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const VESSEL_ROOT = resolve(import.meta.dir, "..", "..");
const REL = join("packages", "shape-dispatch-check", "check.ts");

function findChecker(): string | null {
  let dir = VESSEL_ROOT;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, REL);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const deployed = join("/vessels", REL); // feature-compose.ts SHARED_DISPATCH_CHECK
  return existsSync(deployed) ? deployed : null;
}

describe("this vessel's advertised shapes and its dispatch cases agree", () => {
  it("[MUST-FAIL] the shared shape-dispatch check exits 0 over this tree (no orphan case, no undispatched shape)", () => {
    const checker = findChecker();
    expect(checker, `packages/shape-dispatch-check not found above ${VESSEL_ROOT} or under /vessels: the check did not run`).not.toBeNull();
    const proc = Bun.spawnSync([process.execPath, checker!, VESSEL_ROOT], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode, `shape-dispatch check output:\n${out}`).toBe(0);
    expect(out).toContain("all agree");
  });
});
