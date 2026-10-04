// Runs ./gap-drain-compose-nudge-eligibility.cases.ts in its own process with its own temp gap store (see
// ../resolvers/isolated-gap-store-run.ts), so its cases run and report BY NAME in the full suite instead of
// tripping the scratch-root guard as one "(unnamed)" once another file has frozen WORKSPACE_ROOT to the checkout.
import { describe, expect, it } from "bun:test";
import { runCasesIsolated } from "../resolvers/isolated-gap-store-run";

const rows = runCasesIsolated("./test/services/gap-drain-compose-nudge-eligibility.cases.ts");
describe("gap-drain compose-nudge eligibility (isolated gap store)", () => {
  for (const r of rows) it(r.name, () => { if (!r.ok) console.error(r.detail); expect(r.ok).toBe(true); });
});
