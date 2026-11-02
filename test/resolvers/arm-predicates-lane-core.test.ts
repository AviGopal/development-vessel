// THE TEST-WRITING VERIFY READS THE ARM STEP'S PREDICATES FROM LANE CORE (user ruling, arm pre-check option i).
//
// The arm pre-check runs the arm step's own predicates at the test-writing verify (feature-compose.ts, an evaluator
// file): the static rules (check_call_misses_region, check_no_control) and the edit-site / region mutant gates. They
// were read by a dynamic import of gap-check-supply.ts, a lane-editable module, so a lane landing there could loosen
// the verify's judge by import (class: the verdict path imports lane-editable modules). They now live, unchanged, in
// check-supply-admission.ts (lane core, an evaluator file); gap-check-supply.ts re-exports them, so its importers are
// unchanged. This file fails when that stops being true:
//   - [MUST-FAIL] feature-compose.ts has no runtime import (static, re-export or dynamic) of gap-check-supply.ts;
//   - [MUST-FAIL] every predicate the verify reads is DECLARED in check-supply-admission.ts (not re-exported into it);
//   - [MUST-FAIL] the verify's two arm helpers read them through the static check-supply-admission namespace import;
//   - [MUST-FAIL] gap-check-supply.ts's exports of them are the same bindings (its importers see the lane-core code);
//   - [PIN] the runtime-import closure of check-supply-admission.ts reaches no lane-editable module beyond the qa-reviewed
//     debt the evaluator closure already records (evaluator-grant-scan KNOWN_UNGUARDED); a new one reddens.
// Every scanner has a positive control on synthetic source.
import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FC = "src/resolvers/feature-compose.ts";
const CSA = "src/resolvers/check-supply-admission.ts";
const GCS = "src/resolvers/gap-check-supply.ts";
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** The predicates the verify reads (feature-compose testWritingArmStaticRefusal / testWritingArmMutantRefusal). */
const VERIFY_READS = [
  "CHECK_MISSES_REGION_STAGE", "checkMissesRegionRefusal", "CHECK_NO_CONTROL_STAGE", "CHECK_NO_CONTROL_REASON", "noControlRefusal",
  "splitRedGreen", "declaredTestTitles", "configEditSite", "regionGateApplies", "editSiteMutationGateAt", "regionMutantGateAt",
];
/** The ones moved from gap-check-supply.ts, which still exports them (by re-export). */
const MOVED_EXPORTS = VERIFY_READS.filter((n) => n !== "configEditSite").concat(["siteRegionSource", "mutationGateVerdict", "REGION_RED_UNCHANGED_STAGE", "explainedTextRegion", "allOccurrencesMutant", "falsifiableAnchors", "anchorOccurrences", "commentFreeSource", "TOKEN_ANCHOR_MAX"]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}
/** Runtime import specifiers (relative): static, re-export, side-effect and dynamic; type-only erased. */
function runtimeImports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|[;\n])\s*(import|export)\s+([^;"'`]*?)\s*from\s*["'](\.[^"']+)["']/g)) {
    const clause = m[2]!.trim();
    if (/^type\b/.test(clause)) continue;
    const braces = clause.match(/^\{([^}]*)\}$/);
    if (braces && braces[1]!.split(",").map((x) => x.trim()).filter(Boolean).every((x) => /^type\s/.test(x))) continue;
    out.push(m[3]!);
  }
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*["'](\.[^"']+)["']/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g)) out.push(m[1]!);
  return out;
}
function resolveSpec(fromRel: string, spec: string): string | null {
  const base = join(ROOT, fromRel, "..", spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    try { if (statSync(c).isFile()) return relative(ROOT, c); } catch { /* next */ }
  }
  return null;
}
/** A top-level declaration (not an import or re-export) of `name` in the source. */
const declares = (src: string, name: string): boolean =>
  new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`, "m").test(stripComments(src));
function closure(root: string): string[] {
  const seen = new Set([root]);
  const q = [root];
  while (q.length) {
    const f = q.shift()!;
    for (const spec of runtimeImports(read(f))) {
      const r = resolveSpec(f, spec);
      if (r && r.startsWith("src/") && !seen.has(r)) { seen.add(r); q.push(r); }
    }
  }
  return [...seen];
}
function evaluatorFiles(): Set<string> {
  const block = read("src/resolvers/scope-earn-in.ts").match(/export const EVALUATOR_FILES[^=]*=\s*\[([\s\S]*?)\];/);
  return new Set(block ? [...block[1]!.matchAll(/"repos\/development-vessel\/([^"]+)"/g)].map((m) => m[1]!) : []);
}

describe("the scanners (positive controls)", () => {
  it("runtimeImports sees static, re-export, side-effect and dynamic forms and ignores type-only", () => {
    expect(runtimeImports(`import { a } from "./x.js";\nexport { b } from "./y.js";\nconst m = await import("./z.js");\nimport "./s.js";\n// import("./c.js")`).sort()).toEqual(["./s.js", "./x.js", "./y.js", "./z.js"]);
    expect(runtimeImports(`import type { A } from "./t.js";\nexport type { B } from "./u.js";`)).toEqual([]);
  });
  it("declares sees a declaration and not a re-export or an import", () => {
    expect(declares(`export function f() {}\nexport const G = 1;`, "f")).toBe(true);
    expect(declares(`export { f } from "./x.js";\nimport { g } from "./y.js";`, "f")).toBe(false);
  });
});

describe("the verify's arm predicates come from lane core", () => {
  it("[MUST-FAIL] feature-compose.ts has no runtime import of gap-check-supply.ts", () => {
    const hits = runtimeImports(read(FC)).map((s) => resolveSpec(FC, s)).filter((r) => r === GCS);
    expect(hits).toEqual([]);
  });
  it("[MUST-FAIL] every predicate the verify reads is declared in check-supply-admission.ts", () => {
    const csa = read(CSA);
    expect(VERIFY_READS.filter((n) => !declares(csa, n))).toEqual([]);
  });
  it("[MUST-FAIL] the verify's arm helpers read them through the static check-supply-admission import", () => {
    const fc = stripComments(read(FC));
    expect(fc).toMatch(/^import \* as armPredicates from "\.\/check-supply-admission\.js";$/m);
    for (const fn of ["testWritingArmStaticRefusal", "testWritingArmMutantRefusal"]) {
      const at = fc.indexOf(`export async function ${fn}(`);
      expect(at, fn).toBeGreaterThan(0);
      const body = fc.slice(at, fc.indexOf("\n}\n", at));
      expect(body, fn).toContain("const supply = armPredicates;");
      expect(body, fn).not.toMatch(/import\(\s*["'`]\.\/gap-check-supply/);
    }
  });
  it("[MUST-FAIL] gap-check-supply.ts's exports of the moved predicates are the lane-core bindings", async () => {
    const gcs = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, unknown>;
    const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, unknown>;
    const notSame = MOVED_EXPORTS.filter((n) => csa[n] === undefined || gcs[n] !== csa[n]);
    expect(notSame).toEqual([]);
    expect(MOVED_EXPORTS.filter((n) => declares(read(GCS), n))).toEqual([]);
  });
  it("[PIN] check-supply-admission's runtime closure reaches no lane-editable module beyond the reviewed debt", () => {
    const ev = evaluatorFiles();
    expect(ev.has(CSA)).toBe(true);
    // Not evaluator files but operator-excluded (autonomyScope excluded_paths; judge-modules-closed EXCLUDED_SRC_MIRROR).
    const EXCLUDED_NOT_EVALUATOR = ["src/config.ts", "src/resolvers/substrate-gap.ts", "src/resolvers/staged-mitosis-gate.ts"];
    // The lane-editable modules the evaluator closure already reaches, each reviewed by qa (evaluator-grant-scan
    // KNOWN_UNGUARDED: notice path / plumbing / arming / telemetry; none decides a verdict).
    const REVIEWED_DEBT = ["src/compose-slots.ts", "src/lib/demand-goals.ts", "src/lib/region-literal.ts", "src/resolvers/boredom-enqueue.ts", "src/resolvers/ui-write-passthrough.ts", "src/services/gap-drain-observer.ts", "src/shape-vocabulary.ts"];
    const outside = closure(CSA).filter((f) => !ev.has(f) && !EXCLUDED_NOT_EVALUATOR.includes(f)).sort();
    expect(outside).toEqual([...REVIEWED_DEBT].sort());
    expect(outside).not.toContain(GCS);
  });
});
