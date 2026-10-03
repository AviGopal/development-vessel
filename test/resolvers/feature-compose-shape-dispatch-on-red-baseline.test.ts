// SHAPE-DISPATCH IS CHECKED ON A RED TYPECHECK BASELINE (gap
// on-a-red-typecheck-baseline-the-shape-dispatch-check-is-skipped-and-reads-as-passed, check-first).
//
// The baseline-delta typecheck gate (typecheckVerdict) lets a draft through when the untouched baseline already
// fails tsc and the draft adds no new error. In exactly that case the verify command printed
// "SKIPPED_TYPECHECK_FAILED" for shape-dispatch and no SD_EXIT, and the parse `sd ? ... : 0` read the missing
// value as PASSED: every draft that lands because of the relaxation landed with shape-dispatch unchecked, a
// fail-open gate (qa).
//
// Expected (qa ruling): the verify command runs the shape-dispatch block whatever the typecheck result (bun runs
// TypeScript without typechecking, so the check means something on a red baseline); a MISSING SD_EXIT parses as
// null, not 0; and null is not ok when the typecheck passed only through the relaxation. A strict clean-baseline
// draft is unchanged.
//
// Seams: composeVerifyCommand, shapeDispatchExit and shapeDispatchOk (feature-compose), reached as optional exports
// so their absence reads as a red assertion; typecheckVerdict gains `relaxed`. The command is asserted by running
// it under sh with stub `bun` and `timeout` executables on PATH, so its control flow is observed, not grepped.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const ROOT = join(tmpdir(), `sd-red-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const VESSEL = join(ROOT, "vessel");
const BIN = join(ROOT, "bin");
const CHECK = join(ROOT, "shape-dispatch-check.ts");
const BASE_ERR = "src/config.ts: error TS2305: Module has no exported member DiscoveryLookup.";

beforeAll(() => {
  mkdirSync(join(VESSEL, "src", "routes"), { recursive: true });
  mkdirSync(join(VESSEL, "node_modules"), { recursive: true });
  writeFileSync(join(VESSEL, "src", "config.ts"), "export {};\n");
  writeFileSync(join(VESSEL, "src", "routes", "impulses.ts"), "export {};\n");
  writeFileSync(CHECK, "// stub path; the stub bun below answers for it\n");
  mkdirSync(BIN, { recursive: true });
  // Stub bun: the typecheck fails (a red baseline), the shape-dispatch check prints a marker and exits 3, tests pass.
  writeFileSync(join(BIN, "bun"), [
    "#!/bin/sh",
    'case "$1" in',
    '  run) echo "src/config.ts(18,15): error TS2305: stub"; exit 2 ;;',
    '  install) exit 0 ;;',
    '  test) echo " 1 pass"; exit 0 ;;',
    '  *) echo "SHAPE_DISPATCH_STUB_RAN"; exit 3 ;;',
    "esac",
    "",
  ].join("\n"));
  writeFileSync(join(BIN, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(join(BIN, "bun"), 0o755);
  chmodSync(join(BIN, "timeout"), 0o755);
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const relaxedTc = () => {
  const v = fc.typecheckVerdict({ tcExit: 2, curTs: new Set([BASE_ERR]), baseTs: new Set([BASE_ERR]), touched: ["src/widget.ts"] });
  expect(v.ok).toBe(true);
  expect(v.relaxed).toBe(true);
  return v;
};
const strictTc = () => {
  const v = fc.typecheckVerdict({ tcExit: 0, curTs: new Set<string>(), baseTs: new Set<string>(), touched: [] });
  expect(v.ok).toBe(true);
  expect(v.relaxed).toBe(false);
  return v;
};
const sdOk = (raw: string, tc: { relaxed: boolean }): boolean => {
  expect(typeof fc.shapeDispatchExit).toBe("function");
  expect(typeof fc.shapeDispatchOk).toBe("function");
  return fc.shapeDispatchOk(fc.shapeDispatchExit(raw), tc) as boolean;
};

describe("shape-dispatch on a red typecheck baseline", () => {
  it("MUST-FAIL a relaxed draft whose verify output carries no SD_EXIT is not ok", () => {
    expect(sdOk("== typecheck ==\nTC_EXIT=2\n== shape-dispatch ==\nSKIPPED_TYPECHECK_FAILED\n", relaxedTc())).toBe(false);
  });

  it("MUST-FAIL a missing SD_EXIT parses as null, not as a pass", () => {
    expect(typeof fc.shapeDispatchExit).toBe("function");
    expect(fc.shapeDispatchExit("TC_EXIT=2\nSKIPPED_TYPECHECK_FAILED\n")).toBeNull();
    expect(fc.shapeDispatchExit("SD_EXIT=0\n")).toBe(0);
    expect(fc.shapeDispatchExit("SD_EXIT=1\n")).toBe(1);
  });

  it("MUST-FAIL the built verify command runs shape-dispatch even when typecheck failed", async () => {
    expect(typeof fc.composeVerifyCommand).toBe("function");
    const cmd = fc.composeVerifyCommand(VESSEL, CHECK) as string;
    const p = Bun.spawn(["sh", "-c", cmd], { env: { PATH: `${BIN}:/usr/bin:/bin`, HOME: ROOT }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain("TC_EXIT=2");
    expect(out).toContain("SHAPE_DISPATCH_STUB_RAN");
    expect(out).toContain("SD_EXIT=3");
    expect(fc.shapeDispatchExit(out)).toBe(3);
    expect(fc.shapeDispatchOk(fc.shapeDispatchExit(out), { relaxed: true })).toBe(false);
  });

  it("CONTROL a relaxed draft with SD_EXIT=0 is ok", () => {
    expect(sdOk("TC_EXIT=2\n== shape-dispatch ==\nSD_EXIT=0\n", relaxedTc())).toBe(true);
  });

  it("CONTROL a strict clean-baseline draft is unchanged: SD_EXIT=0 passes, a non-zero exit refuses, and a missing marker still reads as before", () => {
    const tc = strictTc();
    expect(sdOk("TC_EXIT=0\nSD_EXIT=0\n", tc)).toBe(true);
    expect(sdOk("TC_EXIT=0\nSD_EXIT=1\n", tc)).toBe(false);
    expect(sdOk("TC_EXIT=0\n", tc)).toBe(true);
  });
});
