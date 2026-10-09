// A TEST THAT CAN REACH THE RUNTIME ROOT TAKES ITS OWN TEMP ROOT (class detector, qa-ordered).
//
// shape-vocabulary.ts freezes RUNTIME_ROOT / REPO_ROOT / SUPER_REPO_ROOT at module load (perf-canary-resolve
// freezes its own RUNTIME_ROOT the same way), and a `bun test` process shares one module registry. A test file
// that sets MITOSIS_RUNTIME_DIR before importing feature-compose is isolated only when it happens to load the
// module first; in a whole-suite run (pull-sync's gate, feature_compose's verify step, the test_suite resolver)
// an earlier importer freezes the live /vessels, and the park-resume tests wrote their fixtures into
// /vessels/development-vessel on the nodes. test/helpers/runtime-root.ts isolates a file regardless of order.
//
// The class, as a static predicate over every test file in the vessel:
//   it loads a module that freezes a runtime root at load (directly, by import specifier), AND
//   it either tries to steer that root (assigns MITOSIS_RUNTIME_DIR / MITOSIS_REPO_ROOT / MITOSIS_SUPER_REPO_DIR)
//   or drives a feature_compose entry that writes under it (resolveFeatureCompose / resumeParkedLanding /
//   writeParkedLanding),
//   AND it does not call isolateRuntimeRoot from the helper.
// A file in the class that is not isolated must be either fixed or listed in ALLOWED with the reason it cannot
// write through a frozen root. Each allowance was checked by running the file in a sandbox whose /vessels is a
// writable temp trap, both alone and after a loader that froze /vessels: nothing landed in the trap.
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assertRuntimeRootIsolated, isUnderTmp } from "./helpers/runtime-root.js";
import { tmpdir } from "node:os";

const VESSEL = join(import.meta.dir, "..");

/** Modules that capture a runtime root when they load. */
const LOAD_TIME_ROOT_MODULES = ["feature-compose", "shape-vocabulary", "perf-canary-resolve"];
const LOADS = new RegExp(`["'\`/](${LOAD_TIME_ROOT_MODULES.join("|")})(\\.js|\\.ts)?["'\`?]`);
const STEERS = /process\.env(\.|\[["'])MITOSIS_(RUNTIME_DIR|REPO_ROOT|SUPER_REPO_DIR)\b/;
const DRIVES = /\b(resolveFeatureCompose|resumeParkedLanding|writeParkedLanding)\s*!?\s*\(/;
const ISOLATED = /\bisolateRuntimeRoot\s*\(/;

/** Files in the class that are not isolated, with the reason each cannot write through a frozen root. */
const ALLOWED: Record<string, string> = {
  "test/resolvers/compose-admission.test.ts":
    "protected judge test (autonomy-scope excluded): it must not import the lane-editable test/helpers/runtime-root.ts until that helper is an evaluator file (scope-earn-in EVALUATOR_FILES + autonomy-scope), as test/helpers/ungated-rows-source.ts is; it drives only admission refusals (trap run: nothing landed under /vessels, alone or after a /vessels loader)",
  "test/resolvers/retry-evidence.test.ts":
    "imports only pure feature-compose helpers statically and steers MITOSIS_RUNTIME_DIR per test for gap-to-feature's specFromGap, which reads it at call time; drives no feature_compose write (trap run: nothing landed under /vessels, alone or after a /vessels loader)",
};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git" || n === "dist") continue;
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) testFiles(abs, out);
    else if (n.endsWith(".test.ts")) out.push(relative(VESSEL, abs));
  }
  return out;
}

/** The source without whole-line comments: a comment that names an entry point drives nothing. */
const code = (src: string): string => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function inClass(src: string): boolean {
  const c = code(src);
  return LOADS.test(c) && (STEERS.test(c) || DRIVES.test(c));
}

describe("runtime-root isolation: the class detector", () => {
  const files = [...testFiles(join(VESSEL, "test")), ...testFiles(join(VESSEL, "src"))].sort();

  it("MUST-FAIL: every test file that loads a load-time root module and steers or drives it isolates its root", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(join(VESSEL, f), "utf8");
      return inClass(src) && !ISOLATED.test(src) && !(f in ALLOWED);
    });
    expect(offenders).toEqual([]);
  });

  it("every allowance names a file that is still in the class and still not isolated", () => {
    const stale = Object.keys(ALLOWED).filter((f) => {
      let src: string;
      try { src = readFileSync(join(VESSEL, f), "utf8"); } catch { return true; }
      return !inClass(src) || ISOLATED.test(src);
    });
    expect(stale).toEqual([]);
  });

  it("CONTROL: the predicate sees the pattern that wrote /vessels on the nodes, and the helper call clears it", () => {
    const leaky = `process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;\nconst fc = await import("../../src/resolvers/feature-compose.js");\nawait fc.resolveFeatureCompose(p);\n`;
    expect(inClass(leaky)).toBe(true);
    expect(ISOLATED.test(leaky)).toBe(false);
    const fixed = `const { runtime } = await isolateRuntimeRoot("x");\n${leaky}`;
    expect(ISOLATED.test(fixed)).toBe(true);
    expect(inClass(`import { shq } from "../../src/resolvers/feature-compose.js";\nshq("a");\n`)).toBe(false);
  });
});

describe("runtime-root isolation: the guard", () => {
  const t = join(tmpdir(), "rr-guard-fixture", "runtime");

  it("MUST-FAIL: refuses an effective root of /vessels", () => {
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: "/vessels", REPO_ROOT: "/vessels" }, { RUNTIME_ROOT: t, REPO_ROOT: t })).toThrow(/refusing to run against a real runtime root/);
  });

  it("MUST-FAIL: refuses an effective root that is another file's temp root (load order froze it)", () => {
    const other = join(tmpdir(), "another-file", "runtime");
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: other, REPO_ROOT: other }, { RUNTIME_ROOT: t, REPO_ROOT: t })).toThrow(/refusing/);
  });

  it("MUST-FAIL: refuses an expected root that is not under the OS temp dir", () => {
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: "/vessels", REPO_ROOT: "/vessels" }, { RUNTIME_ROOT: "/vessels", REPO_ROOT: "/vessels" })).toThrow(/refusing/);
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: "/workspace/x", REPO_ROOT: t }, { RUNTIME_ROOT: "/workspace/x", REPO_ROOT: t })).toThrow(/refusing/);
    expect(isUnderTmp(tmpdir())).toBe(false);
    expect(isUnderTmp(join(tmpdir(), "..", "vessels"))).toBe(false);
  });

  it("refuses a SUPER_REPO_ROOT left on the live super-repo", () => {
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: t, REPO_ROOT: t, SUPER_REPO_ROOT: "/workspace/git/super-repo" }, { RUNTIME_ROOT: t, REPO_ROOT: t, SUPER_REPO_ROOT: join(t, "..", "sr") })).toThrow(/SUPER_REPO_ROOT/);
  });

  it("CONTROL: accepts the file's own temp root", () => {
    expect(() => assertRuntimeRootIsolated({ RUNTIME_ROOT: t, REPO_ROOT: t }, { RUNTIME_ROOT: t, REPO_ROOT: t })).not.toThrow();
  });
});
