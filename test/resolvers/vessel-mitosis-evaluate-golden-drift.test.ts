// GOLDEN-DRIFT GATE tests for staticEvaluate.
//
// These prove the new stage that runs a vessel's self-contained "golden" drift
// test (e.g. goal-host-vessel's test/reach-routes-golden.test.ts) against the
// in-container clone with the STAGED src overlaid, so a drifted route-as-data
// selector cell is caught at the landing gate instead of serving hollow greens.
//
// The gate is exercised with a FAKE clone + a FAKE, minimal golden test (2 tests:
// one always-passing "harness runs" + one drift-sensitive assertion) so we can
// prove FAVORABLE (clean staged) / UNFAVORABLE (drifted staged) / SKIP (no golden
// test) / INCONCLUSIVE (cannot run) deterministically without the real 71-assertion
// suite. The real suite is validated by operator dispatch against the live clone.
import { describe, it, expect, afterEach } from "bun:test";
import { staticEvaluate } from "../../src/resolvers/vessel-mitosis-evaluate.js";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = Bun.which("bun") ?? process.execPath;

// A minimal golden test: imports the vessel entrypoint (relative — must resolve
// INTO the overlay) and asserts a value that the staged src controls. Two `it`s so
// a drift produces pass>0 AND fail>0 (the "assertions ran, some failed" = genuine
// drift signal), not pass==0 (which the gate treats as cannot-run/inconclusive).
const FAKE_GOLDEN = `import { describe, it, expect } from "bun:test";
const idx: any = await import("../src/index.ts");
describe("fake golden drift", () => {
  it("harness runs", () => { expect(1).toBe(1); });
  it("VALUE is 42 (drift-sensitive)", () => { expect(idx.VALUE).toBe(42); });
});
`;

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * Build a fake world:
 *   <root>/clone/<vessel>/{package.json, src/index.ts (VALUE=42), test/<golden>}
 *   <root>/live/<vessel>/{package.json, node_modules/, src/index.ts}  (baseRootForOverlay)
 *   <root>/mitosis/{src/index.ts}                                     (sparse staged tree)
 * `withNodeModules=false` omits the live node_modules to exercise the cannot-run path.
 * `withGoldenTest=false` omits the golden test to exercise SKIP.
 */
async function makeWorld(opts: {
  vessel: string;
  stagedValue: number;
  withGoldenTest?: boolean;
  withNodeModules?: boolean;
}): Promise<{ mitosisRoot: string; baseRoot: string; cloneRoot: string }> {
  const withGolden = opts.withGoldenTest ?? true;
  const withNm = opts.withNodeModules ?? true;
  const root = await mkdtemp(join(tmpdir(), "gdw-"));
  cleanups.push(root);

  const cloneRoot = join(root, "clone");
  const cloneDir = join(cloneRoot, opts.vessel);
  await mkdir(join(cloneDir, "src"), { recursive: true });
  await writeFile(join(cloneDir, "package.json"), JSON.stringify({ name: opts.vessel, scripts: {} }));
  await writeFile(join(cloneDir, "src", "index.ts"), "export const VALUE = 42;\n");
  if (withGolden) {
    await mkdir(join(cloneDir, "test"), { recursive: true });
    await writeFile(join(cloneDir, "test", "reach-routes-golden.test.ts"), FAKE_GOLDEN);
  }

  const baseRoot = join(root, "live", opts.vessel);
  await mkdir(join(baseRoot, "src"), { recursive: true });
  await writeFile(join(baseRoot, "package.json"), JSON.stringify({ name: opts.vessel, scripts: {} }));
  await writeFile(join(baseRoot, "src", "index.ts"), "export const VALUE = 42;\n");
  if (withNm) await mkdir(join(baseRoot, "node_modules"), { recursive: true });

  const mitosisRoot = join(root, `${opts.vessel}-mitosis-2026-07-30T00-00-00-000Z`);
  await mkdir(join(mitosisRoot, "src"), { recursive: true });
  await writeFile(join(mitosisRoot, "src", "index.ts"), `export const VALUE = ${opts.stagedValue};\n`);

  return { mitosisRoot, baseRoot, cloneRoot };
}

// scripts=[] isolates the golden stage (no typecheck/lint); skipTests=true skips the
// trailing overlay `bun test`. cloneRepoRoot points the gate at the fake clone.
const run = (w: { mitosisRoot: string; baseRoot: string; cloneRoot: string }) =>
  staticEvaluate(w.mitosisRoot, BUN, w.baseRoot, ["src/index.ts"], [], true, w.cloneRoot);

describe("staticEvaluate golden-drift gate", () => {
  it("(b) NORMAL LANDING NOT HALTED: clean staged src → FAVORABLE (ok:true)", async () => {
    const w = await makeWorld({ vessel: "goal-host-vessel", stagedValue: 42 });
    const ev = await staticEvaluate(w.mitosisRoot, BUN, w.baseRoot, ["src/index.ts"], [], true, w.cloneRoot);
    expect(ev.ok).toBe(true);
    expect(ev.reason).toBe("static_checks_pass");
    // the golden check is recorded in the evidence trail
    expect(ev.checks.some((c) => c.name.includes("golden-drift"))).toBe(true);
  }, 30_000);

  it("(c) DRIFT REJECTED: drifted staged src → UNFAVORABLE golden_drift_failed", async () => {
    const w = await makeWorld({ vessel: "goal-host-vessel", stagedValue: 99 });
    const ev = await run(w);
    expect(ev.ok).toBe(false);
    expect(ev.timed_out ?? false).toBe(false); // a real drift is terminal, never deferred
    expect(ev.reason).toContain("golden_drift_failed");
  }, 30_000);

  it("(d) OTHER VESSELS UNAFFECTED: no golden test in clone → SKIP → FAVORABLE", async () => {
    const w = await makeWorld({ vessel: "plain-vessel", stagedValue: 99, withGoldenTest: false });
    const ev = await run(w);
    expect(ev.ok).toBe(true); // drift value ignored — no golden test engages the gate
    expect(ev.reason).toBe("static_checks_pass");
    expect(ev.checks.some((c) => c.name.includes("golden-drift"))).toBe(false);
  }, 30_000);

  it("FAIL-CLOSED: golden test present but node_modules unresolvable → UNFAVORABLE golden_drift_inconclusive", async () => {
    const w = await makeWorld({ vessel: "goal-host-vessel", stagedValue: 42, withNodeModules: false });
    const ev = await run(w);
    expect(ev.ok).toBe(false);
    expect(ev.reason).toContain("golden_drift_inconclusive");
  }, 30_000);
});
