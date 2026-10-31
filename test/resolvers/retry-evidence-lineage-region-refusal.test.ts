// A PARENT'S REGION REFUSAL REACHES ITS RECOMMIT'S DRAFTER.
//
// A recommit gap links to its parent by source_gap_id / parent_gap_id, and hydrateComposeGap loads the parent's
// failure_lessons as lineage_lessons. Those reach the prompt only through attemptEvidenceBlock (feature-compose builds
// the lineage record from it), whose filter kept only lessons with an attempt record (edited_spans, own_check or stage).
// A region-scope refusal (region_repair_refused, region_too_narrow) is written with class and reason only, so it was
// dropped, and the recommit's drafter never saw why the parent's change was refused.
//
// Expected: a region_* lesson with no attempt record is shown in the block with its class and reason, after the staged
// records; a staged-only lesson set renders byte-identically to before; a lesson with neither a stage nor a region class
// is still dropped. Reached through the existing exports hydrateComposeGap and attemptEvidenceBlock, no new seam.
import { describe, expect, it } from "bun:test";
import { attemptEvidenceBlock, hydrateComposeGap, type GapRowReader } from "../../src/resolvers/retry-evidence.js";

const REPAIR_REASON = "[deterministic] region_repair_refused: repair op src/write-door.ts:382 outside the region's enclosing declaration writeDropLine; the change needs more than the gap's region, so the gap should be re-filed with a region that covers it".slice(0, 200);
const PLAN_REASON = "[deterministic] region_too_narrow: ops 1,3 outside the region's enclosing declaration handleWrite after one re-plan; the change needs more than the gap's region, so the gap should be re-filed with a region that covers it".slice(0, 200);
const repairRefused = { at: "2026-10-29T10:00:00.000Z", class: "region_repair_refused", reason: REPAIR_REASON, raw_excerpt: REPAIR_REASON };
const planRefused = { at: "2026-10-29T11:00:00.000Z", class: "region_too_narrow", reason: PLAN_REASON, raw_excerpt: PLAN_REASON };
const STAGED = [
  { at: "2026-10-29T08:00:00.000Z", class: "verify_failed", reason: "own check failed", stage: "verify", edited_spans: [{ path: "src/a.ts", start: 3, end: 5 }], no_effect_vs_parent: true },
  { at: "2026-10-29T09:00:00.000Z", class: "typecheck_failed", reason: "tsc", stage: "typecheck", edited_spans: [], own_check: { test_file: "test/a.test.ts", failing: [{ name: "a > b", expected: "Expected: 1", received: "Received: 2" }] } },
];
// attemptEvidenceBlock(STAGED) as it rendered before the change (captured from the code at the parent commit).
const STAGED_BLOCK = [
  "",
  "PRIOR ATTEMPT RECORD (measured on the previous drafts of THIS gap; data, not advice):",
  "- attempt 2026-10-29T08:00:00.000Z: failed at stage verify; class verify_failed; edited src/a.ts:3-5; effect vs parent: NO EFFECT (the own check failed identically on the parent)",
  "- attempt 2026-10-29T09:00:00.000Z: failed at stage typecheck; class typecheck_failed; edited (nothing applied); effect vs parent: not measured",
  "    own check test/a.test.ts (fail) a > b",
  "      Expected: 1",
  "      Received: 2",
  "REFUSED REGIONS (an edit op overlapping one of these is refused before it is written): src/a.ts:3-5",
].join("\n");

function store(rows: Array<Record<string, unknown>>): GapRowReader {
  return async (id) => rows.filter((r) => String(r.id) === id);
}

async function recommitLineageBlock(parentLessons: Array<Record<string, unknown>>): Promise<string> {
  const h = await hydrateComposeGap({ id: "recommit-gap" }, store([
    { id: "recommit-gap", status: "open", classification_metadata: { source_gap_id: "parent-gap" } },
    { id: "parent-gap", status: "open", classification_metadata: { failure_lessons: parentLessons } },
  ]));
  expect(h.lineage_lessons.length).toBe(parentLessons.length);
  return h.lineage_lessons.length > 0 ? attemptEvidenceBlock(h.lineage_lessons) : "";
}

describe("a parent gap's region refusal in its recommit's lineage block", () => {
  it("[MUST-FAIL] the parent's region_repair_refused lesson is shown with its class and reason", async () => {
    const block = await recommitLineageBlock([repairRefused]);
    expect(block).toContain("class region_repair_refused");
    expect(block).toContain(REPAIR_REASON);
  });

  it("[MUST-FAIL] a region_too_narrow lesson beside staged ones is shown after them; the staged lines are unchanged", async () => {
    const block = await recommitLineageBlock([STAGED[0]!, planRefused, STAGED[1]!]);
    expect(block).toContain(`- attempt ${planRefused.at}: refused by the region scope gate; class region_too_narrow; reason: ${PLAN_REASON}`);
    const staged = STAGED_BLOCK.split("\n").slice(0, -1).join("\n");
    expect(block.startsWith(staged)).toBe(true);
  });

  it("[CONTROL] a staged-only lesson set renders byte-identically to the parent commit", async () => {
    expect(await recommitLineageBlock(STAGED)).toBe(STAGED_BLOCK);
    expect(attemptEvidenceBlock(STAGED)).toBe(STAGED_BLOCK);
  });

  it("[CONTROL] a lesson with no class and no stage is still dropped; so is a non-region class with no attempt record", async () => {
    expect(await recommitLineageBlock([{ at: "2026-10-29T12:00:00.000Z", reason: "something failed" }])).toBe("");
    expect(await recommitLineageBlock([{ at: "2026-10-29T12:00:00.000Z", class: "compose_failed", reason: "something failed" }])).toBe("");
  });
});
