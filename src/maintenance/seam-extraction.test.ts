/** Round-trip: propose (deterministic) → apply (mechanical) → verify-parity PASS. */
import { describe, expect, test } from "bun:test";
import { Project, ts } from "ts-morph";
import { captureBaseline, verifyParity } from "./parity-gate";
import { applySeamExtraction, proposeSeamExtraction } from "./seam-extraction";

const LOOSE_BAG = `import { readFileSync } from "node:fs";

export function handlerA(x: string): string {
  return helpA(x) + "!";
}

function helpA(x: string): string {
  return x.toUpperCase();
}

export function handlerB(n: number): number {
  return helpB(n) * 2;
}

function helpB(n: number): number {
  return n + 1;
}

export const CONFIG = { retries: 3 };
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
  project.createSourceFile("/src/routes/bag.ts", LOOSE_BAG);
  return project;
}

/**
 * Same reason as PARITY_GATE_TEST_TIMEOUT_MS in parity-gate.test.ts, and these are the same
 * work: the two async cases below call verifyParity, which builds a ts-morph Project and runs a
 * full type-check — measured at 8-9s here, against bun's 5000ms default. They failed as TIMEOUTS,
 * never on an assertion, and the set that lost the race varied run to run.
 *
 * That is not cosmetic: the pre-cutover gate reads a red test as a regression INTRODUCED by the
 * patch under test, so these timeouts block unrelated landings. parity-gate was given this
 * treatment when the problem was diagnosed there; its sibling was missed. The work is inherently
 * slow — the timeout was wrong, not the suite.
 *
 * The synchronous case needs no extension and does not get one, so a genuine hang there still
 * fails fast.
 */
const SEAM_EXTRACTION_TEST_TIMEOUT_MS = 60_000;

describe("seam extraction round-trip", () => {
  test("propose finds a closed cluster; apply + gate = PASS", async () => {
    const project = makeProject();
    const seam = proposeSeamExtraction(project, "/src/routes/bag.ts", { minLines: 4, maxShare: 0.6 });
    expect(seam).not.toBeNull();
    // cluster is private-dependency closed: a handler always drags its helper
    for (const s of seam!.symbols) {
      expect(["handlerA", "helpA", "handlerB", "helpB"]).toContain(s);
    }
    const baseline = captureBaseline(project, "/src/routes/bag.ts");
    applySeamExtraction(project, seam!);
    const v = await verifyParity(project, baseline, seam!.targetModule);
    expect(v.failReason).toBeUndefined();
    expect(v.verdict).toBeTrue();
  }, SEAM_EXTRACTION_TEST_TIMEOUT_MS);

  test("apply refuses a non-sibling target (relative-import safety)", () => {
    const project = makeProject();
    expect(() =>
      applySeamExtraction(project, {
        file: "/src/routes/bag.ts",
        symbols: ["helpA"],
        targetModule: "/src/other/bag.helpers.ts",
        rationale: "x",
      }),
    ).toThrow(/SIBLING/);
  });

  test("explicit seam: moving an exported handler + its private helper PASSes", async () => {
    const project = makeProject();
    const baseline = captureBaseline(project, "/src/routes/bag.ts");
    applySeamExtraction(project, {
      file: "/src/routes/bag.ts",
      symbols: ["handlerB", "helpB"],
      targetModule: "/src/routes/bag.handler-b.ts",
      rationale: "cohesive pair",
    });
    const v = await verifyParity(project, baseline, "/src/routes/bag.handler-b.ts");
    expect(v.failReason).toBeUndefined();
    expect(v.verdict).toBeTrue();
  }, SEAM_EXTRACTION_TEST_TIMEOUT_MS);
});
