// A LANDED REGRESSION IS NOT WRITTEN INTO THE NEXT LANDING'S BASELINE (vessel-mitosis-cutover.ts
// postLandBaselineKeepDecision). The cases live in cutover-post-land-baseline-keep.cases.ts and run in their own process
// with a temp WORKSPACE_ROOT (runCasesIsolated): a post-land suite that finds a test newly failing files a gap, and the
// gap store's root is the one captured when substrate-gap first loaded. One named test per case.
import { describe, it, expect } from "bun:test";
import { runCasesIsolated } from "./isolated-gap-store-run.js";

const rows = runCasesIsolated("./test/resolvers/cutover-post-land-baseline-keep.cases.ts");
describe("post-land-baseline-keep (isolated gap store)", () => {
  for (const r of rows) it(r.name, () => { if (!r.ok) console.error(r.detail); expect(r.ok).toBe(true); });
});
