// THE MODULES THE CHECK IMPORTS ARE GROUNDED (gap grounding-omits-the-modules-the-check-imports, check-first).
//
// Measured 2026-10-03: the checks of two stuck gap families need a second file changed. goal-target-needs.test.ts
// imports goal-target-inference.ts AND goal-intent.ts; the llm_completion_dispatch contract check imports
// resolver-schema.ts (through a dynamic import) beside the dispatch resolver. The compose's targets were the gap's
// edit_site plus repos/ paths its spec names, so the second module was neither shown with a window nor editable:
// the file-scope gate dropped any edit to it as off-target, and the check could not turn green from one file.
//
// Expected:
//   - before planning, the own check's relative imports that resolve into the vessel's src/ (static and dynamic
//     imports; never test helpers, never packages) become target files with their own windows, after the
//     existing targets so the edit_site stays first;
//   - bounded in count by the relocation hint's cap (RELOCATION_HINT_MAX_FILES), modules the named tests use first;
//   - an AUTONOMOUS compose consults the autonomy scope: an imported module the scope excludes is not a target, it
//     is shown READ-ONLY (one target window, PER_FILE_SLICE) with a note naming the scope entry; an unreadable
//     scope excludes every import the same way (fail closed, said); a DIRECTED compose never consults the scope.
//
// Seams: ownCheckImportedModules, partitionOwnCheckImports and ownCheckImportsBlock (feature-compose), reached as
// optional exports so their absence reads as a red assertion. The compose itself is not driven end to end.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(tmpdir(), `own-check-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONE = join(ROOT, "clone");
const prevClone = process.env["VESSELS_CLONE_ROOT"];
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = `oci-fixture-${RUN}-vessel`;
const repo = (rel: string): string => `repos/${VESSEL}/${rel}`;
// feature-compose RELOCATION_HINT_MAX_FILES and PER_FILE_SLICE.
const MAX_FILES = 3;
const TARGET_WINDOW = 6000;
const CHECK = "test/two-file.test.ts";
const NAMED = "two-file check > needs the intent module and the inference module";

const CHECK_SRC = [
  'import { describe, expect, it } from "bun:test";',
  'import { tmpdir } from "node:os";',
  'import { inferTarget } from "../src/inference";',
  'import { isEditIntent } from "../src/intent.js";',
  'import { laneCoreThing } from "../src/core/lane";',
  'import { fixtureHelper } from "./helpers/fixture";',
  'const { SCHEMA_SHAPES } = await import("../src/schema.js");',
  "",
  'describe("two-file check", () => {',
  '  it("needs the intent module and the inference module", () => {',
  "    expect(isEditIntent(\"x\")).toBe(false);",
  "    expect(inferTarget(\"x\")).toBe(\"y\");",
  "  });",
  '  it("an unnamed neighbour", () => {',
  "    expect(laneCoreThing).toBe(1); expect(SCHEMA_SHAPES).toBeDefined(); expect(fixtureHelper).toBeDefined(); expect(tmpdir).toBeDefined();",
  "  });",
  "});",
  "",
].join("\n");
const put = (rel: string, text: string): void => {
  const abs = join(CLONE, VESSEL, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const ctx = () => ({ vessel: VESSEL, test_file: CHECK, only_tests: [NAMED], source: CHECK_SRC });
const imported = (): string[] => {
  expect(typeof fc.ownCheckImportedModules).toBe("function");
  return fc.ownCheckImportedModules(ctx()) as string[];
};
const partition = (imports: string[], targets: string[], excludes: ((p: string) => string | null) | null) => {
  expect(typeof fc.partitionOwnCheckImports).toBe("function");
  return fc.partitionOwnCheckImports(imports, targets, excludes) as { targets: string[]; readonly: Array<{ path: string; why: string }> };
};

beforeAll(() => {
  process.env["VESSELS_CLONE_ROOT"] = CLONE;
  put("src/inference.ts", "export function inferTarget(g: string): string { return g; }\n");
  put("src/intent.ts", "export function isEditIntent(g: string): boolean { return !!g; }\n");
  put("src/core/lane.ts", "export const laneCoreThing = 1; // laneCoreSentinelIdentifier\n");
  put("src/schema.ts", "export const SCHEMA_SHAPES = {};\n");
  put("test/helpers/fixture.ts", "export const fixtureHelper = 1;\n");
  put(CHECK, CHECK_SRC);
});
afterAll(() => {
  if (prevClone === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = prevClone;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the imported src modules of the own check", () => {
  it("MUST-FAIL a check importing two src modules yields both, modules of the named test first", () => {
    const got = imported();
    expect(got.slice(0, 2).sort()).toEqual([repo("src/inference.ts"), repo("src/intent.ts")]);
  });

  it("MUST-FAIL the imports become target files after the existing targets, and are bounded by the relocation cap", () => {
    const got = imported();
    expect(got.length).toBeLessThanOrEqual(MAX_FILES);
    const p = partition(got, [repo("src/inference.ts")], null);
    expect(p.targets).toContain(repo("src/intent.ts"));
    expect(p.targets).not.toContain(repo("src/inference.ts"));
    expect(p.readonly).toEqual([]);
  });

  it("MUST-FAIL a module the check reaches through a dynamic import is found, and the modules the named test uses come first", () => {
    expect(typeof fc.ownCheckImportedModules).toBe("function");
    const got = fc.ownCheckImportedModules({ ...ctx(), only_tests: ["two-file check > an unnamed neighbour"] }) as string[];
    expect(got.slice(0, 2).sort()).toEqual([repo("src/core/lane.ts"), repo("src/schema.ts")]);
  });

  it("CONTROL a test helper and a package import are never targets", () => {
    const got = imported();
    expect(got.some((f) => f.includes("/test/"))).toBe(false);
    expect(got.some((f) => f.includes("node:") || f.includes("bun:"))).toBe(false);
  });
});

describe("the autonomy scope decides which imports a compose may edit", () => {
  const imports = [repo("src/intent.ts"), repo("src/core/lane.ts")];
  const excludesCore = (p: string): string | null => (p.includes("/src/core/") ? `repos/${VESSEL}/src/core/` : null);

  it("CONTROL an excluded import is not a target but is visible read-only with a note naming the scope entry", () => {
    const p = partition(imports, [], excludesCore);
    expect(p.targets).toEqual([repo("src/intent.ts")]);
    expect(p.readonly).toEqual([{ path: repo("src/core/lane.ts"), why: `repos/${VESSEL}/src/core/` }]);
    expect(typeof fc.ownCheckImportsBlock).toBe("function");
    const block = fc.ownCheckImportsBlock({ added: p.targets, readonly: p.readonly.map((r) => ({ ...r, content: "export const laneCoreThing = 1; // laneCoreSentinelIdentifier\n" })), focusHints: [] }) as string;
    expect(block).toContain(repo("src/intent.ts"));
    expect(block).toMatch(/may edit/i);
    expect(block).toContain(repo("src/core/lane.ts"));
    expect(block).toMatch(/read-only/i);
    expect(block).toContain(`repos/${VESSEL}/src/core/`);
    expect(block).toContain("laneCoreSentinelIdentifier");
  });

  it("CONTROL an unreadable scope makes every import read-only, and says why", () => {
    const p = partition(imports, [], () => "scope unreadable (no answer)");
    expect(p.targets).toEqual([]);
    expect(p.readonly.map((r) => r.path)).toEqual(imports);
    expect(p.readonly.every((r) => r.why.includes("unreadable"))).toBe(true);
  });

  it("CONTROL a directed compose never consults the scope: every import is a target", () => {
    expect(partition(imports, [], null).targets).toEqual(imports);
  });

  it("MUST-FAIL a read-only module is shown in one target window, however large it is", () => {
    expect(typeof fc.ownCheckImportsBlock).toBe("function");
    const big = `export const laneCoreThing = 1;\n${"// filler line for a large lane-core module\n".repeat(2000)}`;
    const block = fc.ownCheckImportsBlock({ added: [], readonly: [{ path: repo("src/core/lane.ts"), why: "x", content: big }], focusHints: [] }) as string;
    expect(block.length).toBeLessThanOrEqual(TARGET_WINDOW + 1000);
  });
});

describe("a read-only module is shown as the vessel clone holds it", () => {
  it("MUST-FAIL the clone copy wins over a stale runtime copy, and the runtime copy is the fallback", () => {
    expect(typeof fc.readOwnCheckModule).toBe("function");
    const runtime = join(ROOT, "runtime");
    const rel = "src/core/lane.ts";
    mkdirSync(join(runtime, VESSEL, "src", "core"), { recursive: true });
    writeFileSync(join(runtime, VESSEL, rel), "export const laneCoreThing = 0; // staleRuntimeOnlySentinel\n");
    const got = fc.readOwnCheckModule(repo(rel), CLONE, runtime) as string | null;
    expect(got).toContain("laneCoreSentinelIdentifier");
    expect(got).not.toContain("staleRuntimeOnlySentinel");
    const onlyRuntime = "src/core/runtime-only.ts";
    writeFileSync(join(runtime, VESSEL, onlyRuntime), "export const onlyInRuntime = 1;\n");
    expect(fc.readOwnCheckModule(repo(onlyRuntime), CLONE, runtime)).toContain("onlyInRuntime");
    expect(fc.readOwnCheckModule(repo("src/core/nowhere.ts"), CLONE, runtime)).toBeNull();
  });
});
