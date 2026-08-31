import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { verifyGapCondition } from "../../src/resolvers/gap-to-feature.js";

// Class 1 can only say "this bad literal is still in the file". It cannot say "this good
// guard is missing" — and that missing polarity is why automated predicate derivation has
// failed twice on this fleet (be26a6b, reverted by 8a5223c for manufacturing re-lands).
//
// The proof is a real autonomous repair. local-tools-vessel 4d0c600 (Substrate Autonomous,
// FAVORABLE, pushed) fixed groupBounded by INSERTING a guard:
//     ( sleep t;                    __killtree $__cpid; kill -9 -$__cpid )
//  -> ( sleep t; kill -0 $__cpid && __killtree $__cpid; kill -9 -$__cpid )
// grep -c -F on both trees: the defect literal `kill -9 -$__cpid 2>/dev/null` occurs ONCE at
// 4d0c600^ and ONCE at 4d0c600. The fix was ADDITIVE, so the cited literal SURVIVED it. A
// Class-1 predicate would still read 'present' after the correct fix.
//
// verifyGapCondition resolves paths under MITOSIS_RUNTIME_DIR. These tests point it at a
// temp tree so the REAL predicate runs; without that every path fails to resolve, every
// verdict is 'unknown', and the assertions below would pass on nothing.
const DEFECT = 'kill -9 -$__cpid 2>/dev/null';
const GUARD = 'kill -0 $__cpid && __killtree';
let root: string;

const gap = (meta: Record<string, unknown>) => ({
  id: "groupbounded-fix-not-propagated-to-sibling-shell-exec-sites",
  summary: "guard missing before __killtree",
  classification_metadata: { edit_site: "repos/local-tools-vessel/src/index.ts", ...meta },
});

const writeVessel = (body: string) => {
  const dir = join(root, "local-tools-vessel", "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), body, "utf8");
};

/**
 * Set MITOSIS_RUNTIME_DIR for the duration of ONE synchronous call and restore it
 * immediately.
 *
 * NOT beforeAll/afterAll: bun shares a process across test files, so mutating the env for a
 * whole file LEAKS into siblings. The first version of this test did exactly that and broke
 * gap-to-feature-pending-land-sweep.test.ts — 3 failures that vanished when this file was run
 * alone. verifyGapCondition is synchronous, so there is no await between set and restore and
 * no other test can observe the change.
 */
const withRuntimeRoot = <T>(fn: () => T): T => {
  const prev = process.env["MITOSIS_RUNTIME_DIR"];
  process.env["MITOSIS_RUNTIME_DIR"] = root;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env["MITOSIS_RUNTIME_DIR"];
    else process.env["MITOSIS_RUNTIME_DIR"] = prev;
  }
};

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "polarity-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("Class 1b — expected_literal (inverse polarity)", () => {
  it("reads PRESENT (defect live) when the guard is missing", () => {
    writeVessel(`const c = \`( sleep 5; __killtree $__cpid; ${DEFECT} )\`;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ expected_literal: GUARD })))).toBe("present");
  });

  it("reads ABSENT (fixed) once the guard is added — the case Class 1 cannot express", () => {
    // The real 4d0c600 shape: guard inserted, defect literal STILL THERE.
    writeVessel(`const c = \`( sleep 5; ${GUARD} $__cpid; ${DEFECT} )\`;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ expected_literal: GUARD })))).toBe("absent");
  });

  it("demonstrates the Class-1 failure it exists to fix", () => {
    // Same post-fix file, but predicated on the DEFECT literal: still 'present', so the gap
    // could never close. This is the assertion that justifies the new class.
    writeVessel(`const c = \`( sleep 5; ${GUARD} $__cpid; ${DEFECT} )\`;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ hardcoded_url: DEFECT })))).toBe("present");
  });

  it("NEVER overrides an existing Class-1 predicate — strictly additive", () => {
    // The regression guard. Both fields set: Class 1 must win, so no gap carrying a
    // hardcoded_url today can change verdict when this class ships.
    writeVessel(`const c = \`( sleep 5; ${GUARD} $__cpid; ${DEFECT} )\`;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ hardcoded_url: DEFECT, expected_literal: GUARD })))).toBe("present");
  });

  it("treats an EMPTY hardcoded_url as absent, so a retired predicate lets 1b through", () => {
    // Metadata cannot be deleted (substrate-gap.ts:522-524 carries omitted keys forward), so
    // "" is the only way to retire a bad predicate. It must not block 1b.
    writeVessel(`const c = \`( sleep 5; ${GUARD} $__cpid; ${DEFECT} )\`;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ hardcoded_url: "", expected_literal: GUARD })))).toBe("absent");
  });

  it("returns unknown when the cited file does not exist — no false close", () => {
    expect(withRuntimeRoot(() => verifyGapCondition({
      id: "x".repeat(12),
      classification_metadata: { edit_site: "repos/nope-vessel/src/index.ts", expected_literal: GUARD },
    }))).toBe("unknown");
  });

  it("ignores an empty expected_literal rather than matching everything", () => {
    // includes("") is always true; an empty value must NOT read as 'absent'/fixed.
    writeVessel(`const c = 1;\n`);
    expect(withRuntimeRoot(() => verifyGapCondition(gap({ expected_literal: "" })))).not.toBe("absent");
  });
});
