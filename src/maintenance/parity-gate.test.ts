/**
 * The parity gate's safety property, unit-proven (openspec
 * 2026-07-15-vessel-maintenance-parity-gate, Phase 1):
 *
 *   a pure move PASSes; ANY deviation — body edit, rename, rebinding,
 *   surface change, new diagnostic, test edit — FAILs. The gate can only BLOCK.
 *
 * All fixtures run on ts-morph's in-memory filesystem: no disk, no git, no
 * subprocess — the gate's verdict is a pure function of the two worlds.
 */

import { describe, expect, test } from "bun:test";
import { Project, ts } from "ts-morph";
import { captureBaseline, verifyParity, type ParityBaseline } from "./parity-gate";

const UTIL = `export function join(a: string, b: string): string { return a + " " + b; }\n`;

const BOX_BEFORE = `import { join } from "./util";

/** Public API. */
export function greet(name: string): string {
  return hail(name);
}

function hail(name: string): string {
  return join("hi", name);
}

export const VERSION = 1;
`;

const BOX_AFTER_PURE = `import { hail } from "./box.helpers";

/** Public API. */
export function greet(name: string): string {
  return hail(name);
}

export const VERSION = 1;
`;

const HELPERS_PURE = `import { join } from "./util";

export function hail(name: string): string {
  return join("hi", name);
}
`;

const BOX_TEST = `import { greet } from "./box";
export const smoke = greet("x");
`;

function makeProject(): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
    },
  });
  project.createSourceFile("/src/util.ts", UTIL);
  project.createSourceFile("/src/box.ts", BOX_BEFORE);
  project.createSourceFile("/src/box.test.ts", BOX_TEST);
  return project;
}

/** Capture baseline, then apply an after-state mutation, then run the gate. */
async function gateAfter(
  mutate: (project: Project) => void,
  opts: { target?: string; runTests?: () => Promise<{ passed: boolean; detail?: string }> } = {},
) {
  const project = makeProject();
  const baseline: ParityBaseline = captureBaseline(project, "/src/box.ts");
  mutate(project);
  return verifyParity(project, baseline, opts.target ?? "/src/box.helpers.ts", {
    runTests: opts.runTests,
  });
}

function applyPureMove(project: Project): void {
  project.getSourceFileOrThrow("/src/box.ts").replaceWithText(BOX_AFTER_PURE);
  project.createSourceFile("/src/box.helpers.ts", HELPERS_PURE);
}

/**
 * Each case builds an in-memory ts-morph Project and runs a full type-check, which
 * costs seconds, not milliseconds — the suite as a whole takes roughly a minute.
 * bun's default per-test timeout is 5000ms, so under load these cases lose a race
 * they were never meant to be in: measured runs failed 4, 1, 3, 0, 0 and 2 cases,
 * a different set each time, and EVERY failure was a timeout rather than a failed
 * assertion. The pre-cutover gate then reports whichever cases lost as regressions
 * INTRODUCED by the patch under test, blocking unrelated landings. The work is
 * inherently slow; the timeout, not the suite, was wrong.
 */
const PARITY_GATE_TEST_TIMEOUT_MS = 60_000;

describe("parity gate — the safety property", () => {
  test("a pure move PASSes all four checks", async () => {
    const v = await gateAfter(applyPureMove);
    expect(v.failReason).toBeUndefined();
    expect(v.surfaceParity).toBeTrue();
    expect(v.typeParity).toBeTrue();
    expect(v.testParity).toBeTrue();
    expect(v.astEquivalent).toBeTrue();
    expect(v.verdict).toBeTrue();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("move + body edit of the moved fn FAILs astEquivalent", async () => {
    const v = await gateAfter((p) => {
      p.getSourceFileOrThrow("/src/box.ts").replaceWithText(BOX_AFTER_PURE);
      p.createSourceFile(
        "/src/box.helpers.ts",
        HELPERS_PURE.replace(`join("hi", name)`, `join("hello", name)`),
      );
    });
    expect(v.astEquivalent).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("astEquivalent");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("move + rename of the moved fn FAILs", async () => {
    const v = await gateAfter((p) => {
      p.getSourceFileOrThrow("/src/box.ts").replaceWithText(
        BOX_AFTER_PURE.replace(/hail/g, "hails"),
      );
      p.createSourceFile("/src/box.helpers.ts", HELPERS_PURE.replace(/hail/g, "hails"));
    });
    expect(v.astEquivalent).toBeFalse();
    expect(v.verdict).toBeFalse();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("move that rebinds a free identifier FAILs the binding check", async () => {
    const v = await gateAfter((p) => {
      // Same-named, same-signature `join` from a DIFFERENT module: the decl
      // multiset is identical (imports are erased), only the binding differs.
      p.createSourceFile(
        "/src/util2.ts",
        `export function join(a: string, b: string): string { return b + " " + a; }\n`,
      );
      p.getSourceFileOrThrow("/src/box.ts").replaceWithText(BOX_AFTER_PURE);
      p.createSourceFile("/src/box.helpers.ts", HELPERS_PURE.replace(`"./util"`, `"./util2"`));
    });
    expect(v.astEquivalent).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("binding");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("export removed from the file FAILs surfaceParity", async () => {
    const v = await gateAfter((p) => {
      p.getSourceFileOrThrow("/src/box.ts").replaceWithText(
        BOX_AFTER_PURE.replace("export const VERSION", "const VERSION"),
      );
      p.createSourceFile("/src/box.helpers.ts", HELPERS_PURE);
    });
    expect(v.surfaceParity).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("surfaceParity");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("export added FAILs surfaceParity", async () => {
    const v = await gateAfter((p) => {
      p.getSourceFileOrThrow("/src/box.ts").replaceWithText(
        BOX_AFTER_PURE + `export const EXTRA = 2;\n`,
      );
      p.createSourceFile("/src/box.helpers.ts", HELPERS_PURE);
    });
    expect(v.surfaceParity).toBeFalse();
    expect(v.verdict).toBeFalse();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("a NEW compiler diagnostic FAILs typeParity", async () => {
    const v = await gateAfter((p) => {
      applyPureMove(p);
      p.getSourceFileOrThrow("/src/box.helpers.ts").addStatements(
        `const bad: number = "not a number";`,
      );
    });
    expect(v.typeParity).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("typeParity");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("pre-existing diagnostics do NOT fail typeParity (subset-or-equal)", async () => {
    const project = makeProject();
    // Plant a benign pre-existing error BEFORE the baseline.
    project.createSourceFile("/src/legacy.ts", `export const legacy: number = "oops";`);
    const baseline = captureBaseline(project, "/src/box.ts");
    applyPureMove(project);
    const v = await verifyParity(project, baseline, "/src/box.helpers.ts");
    expect(v.typeParity).toBeTrue();
    expect(v.verdict).toBeTrue();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("an edited test file FAILs testParity", async () => {
    const v = await gateAfter((p) => {
      applyPureMove(p);
      p.getSourceFileOrThrow("/src/box.test.ts").addStatements(`// nudge`);
    });
    expect(v.testParity).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("testParity");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("an added test file FAILs testParity", async () => {
    const v = await gateAfter((p) => {
      applyPureMove(p);
      p.createSourceFile("/src/sneaky.test.ts", `export const x = 1;`);
    });
    expect(v.testParity).toBeFalse();
    expect(v.verdict).toBeFalse();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("a failing suite FAILs testParity even when files are byte-identical", async () => {
    const v = await gateAfter(applyPureMove, {
      runTests: async () => ({ passed: false, detail: "1 test failed" }),
    });
    expect(v.testParity).toBeFalse();
    expect(v.verdict).toBeFalse();
    expect(v.failReason).toContain("suite failed");
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("missing target module FAILs (fail-safe: gate can only BLOCK)", async () => {
    const v = await gateAfter(applyPureMove, { target: "/src/does-not-exist.ts" });
    expect(v.astEquivalent).toBeFalse();
    expect(v.verdict).toBeFalse();
  }, PARITY_GATE_TEST_TIMEOUT_MS);

  test("a declaration smuggled into the target FAILs", async () => {
    const v = await gateAfter((p) => {
      applyPureMove(p);
      p.getSourceFileOrThrow("/src/box.helpers.ts").addStatements(
        `export function backdoor(): string { return "extra"; }`,
      );
    });
    expect(v.verdict).toBeFalse();
    // Fails surface (new export via shim would be caught there) or AST
    // (declaration appeared) — either way, blocked.
    expect(v.failReason).toBeDefined();
  }, PARITY_GATE_TEST_TIMEOUT_MS);
});
