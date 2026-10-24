import { expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply.js";

// DEFECT REPRO: dispatchVerdict writes a failure reason solely from AGE (title_grace_ms)
// without checking the file content, while declaredTestTitles would see a new title.
// This test asserts the correct behavior (no failure when a new title exists) and thus FAILS today.

test("check-supply records 'no new test title' from age alone while its reader sees one", () => {
  const measuredTitle = "check-supply-admits-recommit-draft-failure-gaps-whose-summary-describes-a-discarded-draft-not-a-defect-at-he";
  const src = `
    import { test } from "bun:test";
    test("${measuredTitle}", () => {});
  `;
  const titles = mod.declaredTestTitles(src);
  // Sanity: the arm-reader sees the title we just added.
  expect(titles.includes(measuredTitle)).toBe(true);

  const now = Date.now();
  const bounds: mod.OutcomeBounds = {
    stale_ms: 24 * 60 * 60_000,
    timeout_ms: 15 * 60_000,
    title_grace_ms: 2 * 60 * 60_000, // 2 h — matches the observed reason text
    foreign_stale_ms: 24 * 60 * 60_000,
  };

  // Shape a ledger old enough to exceed title_grace_ms, with local ownership, so
  // dispatchVerdict evaluates the TERMINAL+reached branch and blames missing titles.
  const ledger = {
    placed_by: "self-node",
    dispatch_id: "d-1",
    test_file: "repos/development-vessel/test/checks/" + measuredTitle + ".check.ts",
    last_dispatch_at: now - (bounds.title_grace_ms + 1_000), // make AGE > title_grace_ms
    owning_node: "self-node", // ensure local, avoid foreign-owner branches
  } as unknown as mod.Ledger;

  // Try several likely terminal statuses; any one that hits the terminal+reached path
  // will exhibit the defect. The test expects NONE to report the age-only title miss
  // when the reader can see a new title — so this should fail today.
  const statuses = ["succeeded", "completed", "failed"]; // typical terminal statuses
  const withNoTitleReason = statuses
    .map((status) => mod.dispatchVerdict(ledger, { http: 200, status, reached: true }, now, bounds, "self-node"))
    .filter((v) => v.kind === "failed" && typeof (v as { reason?: string }).reason === "string" && ((v as { reason?: string }).reason ?? "").includes("reached, but no new test title appeared"));

  // EXPECTED (correct) behavior: since a new title exists, dispatchVerdict should NOT
  // claim no new title based only on AGE. The current code DOES, so this assertion FAILS.
  expect(withNoTitleReason.length).toBe(0);
});
