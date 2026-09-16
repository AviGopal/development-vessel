// Pins the rollback's OWNERSHIP decision — "whose bytes are on disk?".
//
// THE FAILURE THIS EXISTS FOR, measured 2026-09-16 on substrate-live. The guard asked
// whether the file had changed since BEFORE the compose started:
//
//     if (currentContent !== original) { SKIP ROLLBACK }
//
// A compose that successfully applied its edit has guaranteed that inequality — that is
// what applying an edit means. So the skip fired on the ORDINARY path, not on a rare race,
// and rollback was dead for every applied edit from e76b88c (2026-09-10) onward. Two things
// made it invisible for six days: the log line blamed "another concurrent compose", so a
// structural failure read as an unlucky one; and `rolled_back` stayed true, so the trace
// reported a clean revert over a file still carrying a verified-bad edit.
//
// The damage compounds rather than repeating. The next compose reads the survivor as its
// baseline ("has uncommitted changes ... composing against them rather than discarding
// them"), so each failure builds on the last one's wreckage: 11 skipped rollbacks in one
// day on relevance-sink-vessel and FIVE progressively different parse errors in the same
// file (:140 Unterminated string literal, :167 TS1472, :177 Expected ")", :186 Unexpected :,
// :190 Expected "finally"). The typecheck gate caught every one of them. A gate whose
// rollback declines to run only produces opinions.
import { describe, expect, test } from "bun:test";
import { rollbackOwnership } from "../../src/resolvers/feature-compose";

const ORIGINAL = "export const PORT = 8255\n";
const OURS = "export const PORT = 8255\nexport const ok = true\n";
const THEIRS = "export const PORT = 9999\n";

describe("rollbackOwnership", () => {
  test("RESTORES when the bytes on disk are this compose's own edit — THE REGRESSION", () => {
    // The case the old guard got wrong. current !== original is exactly what a successful
    // edit produces, and the old code read that as "someone else touched it, keep out".
    expect(rollbackOwnership(ORIGINAL, OURS, OURS)).toBe("restore");
  });

  test("treats an already-restored file as a no-op, not a conflict", () => {
    // pull-sync / mirror-to-live can converge the tree before this block runs. Nothing to
    // do, and nothing wrong — this must not be counted against rolled_back.
    expect(rollbackOwnership(ORIGINAL, OURS, ORIGINAL)).toBe("already_restored");
  });

  test("REFUSES to overwrite a genuine third-party write", () => {
    // The case the old guard was written for, and the only one it should ever have caught.
    expect(rollbackOwnership(ORIGINAL, OURS, THEIRS)).toBe("conflict");
  });

  test("REFUSES when no post-edit snapshot was recorded — absent evidence is not ownership", () => {
    // An unreadable path leaves postEdit undefined. We cannot prove the bytes are ours, so
    // we must not overwrite them, even though they differ from the original.
    expect(rollbackOwnership(ORIGINAL, undefined, THEIRS)).toBe("conflict");
  });

  test("an unreadable current file is a conflict, never a restore", () => {
    // Mirrors rollbackRestoreIsVerified's discipline: absent evidence is not evidence.
    expect(rollbackOwnership(ORIGINAL, OURS, undefined)).toBe("conflict");
    expect(rollbackOwnership(ORIGINAL, OURS, null)).toBe("conflict");
    expect(rollbackOwnership(ORIGINAL, OURS, { content: OURS })).toBe("conflict");
  });

  test("a single byte of divergence from our edit is a conflict", () => {
    // If the file is not byte-identical to what we wrote, something else wrote after us.
    expect(rollbackOwnership(ORIGINAL, OURS, OURS + " ")).toBe("conflict");
  });

  test("an unrecorded post-edit on an already-restored file is still a no-op", () => {
    // Ordering guard: the already_restored branch must be decided before the postEdit
    // check, or a missing snapshot would mint a phantom conflict on a clean tree.
    expect(rollbackOwnership(ORIGINAL, undefined, ORIGINAL)).toBe("already_restored");
  });
});
