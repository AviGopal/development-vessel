import { test, expect } from "bun:test";
process.env.LLM_VESSEL_ENDPOINT ??= "http://127.0.0.1:65535";
import { detectZeroBehaviorDelta } from "../src/resolvers/feature-compose.js";

const cases: Array<[string,string,boolean]> = [
  // [name, diff, expectedInert]
  ["hollow shadowed empty block", '@@\n+  if (discoveredVia === "peer") {\n+    // Add logic\n+  }', true],
  ["comment-only add (no deletion)", '@@\n+  // handled upstream now', true],
  ["whitespace-only add", '@@\n+  \n+', true],
  ["LEGIT deletion + comment", '@@\n-  legacyFallback();\n+  // handled upstream', false],
  ["LEGIT deletion only", '@@\n-  doOldThing();', false],
  ["object property add", '@@\n+  retries: 3,', false],
  ["enum/case label add", '@@\n+  case "pending":', false],
  ["normal assignment edit", '@@\n+  const x = computeThing();', false],
  ["empty block BUT real behavior added too", '@@\n+  if (x) {}\n+  doThing();', false],
  ["real if with body", '@@\n+  if (ready) {\n+    start();\n+  }', false],
  // Tautological self-test: a NEW *.test.ts importing no real module (only bun:test) — inert.
  ["tautological new test (imports nothing real)", '### NEW FILE /v/src/foo.test.ts\n@@\n+import { test, expect } from "bun:test";\n+const classify = (r) => r.includes("x") ? "a" : "b";\n+test("t", () => { expect(classify("x")).toBe("a"); });', true],
  // A NEW *.test.ts that imports the real module under test — genuine, NOT inert.
  ["real new test (imports ./real-module)", '### NEW FILE /v/src/bar.test.ts\n@@\n+import { realFn } from "./real-module";\n+import { test, expect } from "bun:test";\n+test("t", () => { expect(realFn()).toBe(1); });', false],
];
for (const [name,diff,exp] of cases) {
  test(name, () => {
    const r = detectZeroBehaviorDelta(diff);
    expect(r.isInert).toBe(exp);
  });
}
