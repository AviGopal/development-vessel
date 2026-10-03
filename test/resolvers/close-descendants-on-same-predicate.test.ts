// Runs ./close-descendants-on-same-predicate.cases.ts in its own process with its own temp gap store (see isolated-gap-store-run.ts), so its
// cases run and report BY NAME in the full suite instead of tripping the temp-dir guard as one "(unnamed)".
import { describe, expect, it } from "bun:test";
import { runCasesIsolated } from "./isolated-gap-store-run";

const rows = runCasesIsolated("./test/resolvers/close-descendants-on-same-predicate.cases.ts");
describe("close-descendants-on-same-predicate (isolated gap store)", () => {
  for (const r of rows) it(r.name, () => { if (!r.ok) console.error(r.detail); expect(r.ok).toBe(true); });
});
