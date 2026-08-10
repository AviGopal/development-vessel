// Pins the rollback's restore check (task #36).
//
// THE FAILURE THIS EXISTS FOR, measured 2026-08-10: the rollback loop logged
// "restored 1/1 live file(s)" over a discovery-vessel/src/index.ts left at
// **2,449 bytes against 23,746** in its clone — every import, the Hono server,
// the auth middleware and the resolver wiring gone. The unit reported healthy
// only because it had not restarted since (uptime 143,366s). The next restart
// would have booted a fragment and taken the fleet's routing fixed point down,
// hours after the compose that caused it.
//
// The loop trusted the write tool's `ok` flag. That is the tool's SELF-REPORT:
// a partial or truncated write returns ok:true. Only reading the bytes back and
// comparing them is evidence about the file.
import { describe, expect, test } from "bun:test";
import { rollbackRestoreIsVerified } from "../../src/resolvers/feature-compose";

const ORIGINAL = "import { Hono } from 'hono'\nexport const app = new Hono()\n";

describe("rollbackRestoreIsVerified", () => {
  test("accepts a byte-identical restore", () => {
    expect(rollbackRestoreIsVerified(ORIGINAL, ORIGINAL)).toBe(true);
  });

  test("REJECTS a truncated restore — the exact discovery-vessel failure", () => {
    // 2,449 of 23,746 bytes: a prefix that still parses as a file and still
    // returned ok:true from the writer.
    expect(rollbackRestoreIsVerified(ORIGINAL, ORIGINAL.slice(0, 20))).toBe(false);
  });

  test("REJECTS an empty restore", () => {
    // The most dangerous shape: a vessel whose source is present but empty
    // starts and crash-loops on a missing entrypoint.
    expect(rollbackRestoreIsVerified(ORIGINAL, "")).toBe(false);
  });

  test("REJECTS an unreadable file rather than assuming success", () => {
    // fs_read returning no content must not read as "restored" — absent
    // evidence is not evidence of restoration.
    expect(rollbackRestoreIsVerified(ORIGINAL, undefined)).toBe(false);
    expect(rollbackRestoreIsVerified(ORIGINAL, null)).toBe(false);
    expect(rollbackRestoreIsVerified(ORIGINAL, { content: ORIGINAL })).toBe(false);
  });

  test("REJECTS content that differs by a single byte", () => {
    // A restore that leaves ANY of the compose's edit behind poisons the next
    // compose's baseline (POISONED BASELINE), so equality must be exact.
    expect(rollbackRestoreIsVerified(ORIGINAL, ORIGINAL + " ")).toBe(false);
  });

  test("an empty original is legitimately restored by empty content", () => {
    // Guard against over-correcting into "empty is always failure": a file that
    // was empty before the compose is correctly restored to empty.
    expect(rollbackRestoreIsVerified("", "")).toBe(true);
  });
});
