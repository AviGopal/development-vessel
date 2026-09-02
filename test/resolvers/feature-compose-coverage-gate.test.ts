import { describe, it, expect } from "bun:test";
import { cjsInEsmRefusal } from "../../src/resolvers/feature-compose.js";

// Pins the COVERAGE-ROUTED REFUSAL gate (2026-09-02).
//
// WHY THIS EXISTS, measured not theorised. The substrate autonomously authored,
// gated (verdict=FAVORABLE), typecheck-verified, ran 829 passing tests, LANDED and
// PUSHED commit 776391aa0fc2 to origin/dev with no operator hands — and the change
// was inert:
//
//     if (_reachVerdict) {
//       try { exports.substrateGap.emit(...); } catch {}
//     }
//
// `exports.substrateGap.emit` exists nowhere in the repo, and goal-host-vessel is
// `"type": "module"` — so `exports` is UNDEFINED at runtime. Every invocation throws
// ReferenceError straight into a bare `catch {}`. It emits nothing, forever.
//
// It passed because `repos/goal-host-vessel/src/index.ts` has NO TEST FILE, which
// feature-compose ITSELF warned about during that very compose:
//
//     "[fc-coverage] TARGET HAS NO TEST FILE: <path> — every gate below this point
//      READS the diff; only a test RUNS it. A FAVORABLE verdict here means the
//      change was reviewed, never executed."
//
// Correct warning, right moment, and NOTHING GATED ON IT. This gate makes that
// warning load-bearing. It follows the rule already stated for the shape-vocabulary
// gate in the same file: a name crossing a boundary is only checkable by RESOLVING
// it, never by reading it. In an ESM module `exports` resolves to nothing — that is
// decidable statically, with no network and no LLM.
//
// SCOPE — deliberately the narrowest high-value case. CJS accessors (`exports.x`,
// `module.exports`) ADDED to an ESM vessel. That is unconditionally a bug: it cannot
// work, so refusing it can never block a legitimate change. It is NOT a general
// unresolved-identifier checker; that needs scope analysis and would false-positive.

const LANDED_INERT_DIFF = `### repos/goal-host-vessel/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1082,7 +1082,14 @@ function deliverReachVerdict(
+      if (_reachVerdict) {
+        try { exports.substrateGap.emit(
+          \`\${_reachId}::missing-row-for-reached-verdict\`,
+          { category: "extraction_eligibility" }
+        ); } catch {}
+      }
+      return; }`;

const MODULE_EXPORTS_DIFF = `### repos/development-vessel/src/x.ts
+module.exports = { a: 1 };`;

// The ESM keyword `export` must NEVER trip this gate.
const LEGITIMATE_ESM_DIFF = `### repos/development-vessel/src/x.ts
+export const FOO = 1;
+export function bar(): number { return 2; }
+export { baz } from "./baz.js";
+export default class Q {}`;

// A diff-header line begins with '+++' and is not added code.
const HEADER_ONLY_DIFF = `### repos/development-vessel/src/x.ts
--- a/src/exports.ts
+++ b/src/exports.ts
@@ -1 +1 @@
+const n = 1;`;

// Removed CJS is a FIX, not a defect — only ADDED lines count.
const REMOVAL_DIFF = `### repos/development-vessel/src/x.ts
-module.exports = { a: 1 };
-exports.foo = 1;
+export const foo = 1;`;

// `exports` as a substring of another identifier must not match.
const SUBSTRING_DIFF = `### repos/development-vessel/src/x.ts
+const myexports = collectExports();
+const shapeExports.length = 0;`;

describe("cjsInEsmRefusal — the coverage-routed refusal gate", () => {
  it("REFUSES the exact diff that landed inert as 776391aa0fc2", () => {
    const r = cjsInEsmRefusal(LANDED_INERT_DIFF);
    expect(r).not.toBeNull();
    expect(r).toContain("exports");
  });

  it("REFUSES an added module.exports", () => {
    expect(cjsInEsmRefusal(MODULE_EXPORTS_DIFF)).not.toBeNull();
  });

  it("ALLOWS ESM export syntax — the load-bearing false-positive case", () => {
    expect(cjsInEsmRefusal(LEGITIMATE_ESM_DIFF)).toBeNull();
  });

  it("ALLOWS a '+++' diff header naming a file called exports.ts", () => {
    expect(cjsInEsmRefusal(HEADER_ONLY_DIFF)).toBeNull();
  });

  it("ALLOWS removal of CJS (that is the repair, not the defect)", () => {
    expect(cjsInEsmRefusal(REMOVAL_DIFF)).toBeNull();
  });

  it("ALLOWS 'exports' appearing inside a longer identifier", () => {
    expect(cjsInEsmRefusal(SUBSTRING_DIFF)).toBeNull();
  });

  it("ALLOWS an empty or non-diff input (fail open, never block on nothing)", () => {
    expect(cjsInEsmRefusal("")).toBeNull();
    expect(cjsInEsmRefusal("no diff here at all")).toBeNull();
  });
});
