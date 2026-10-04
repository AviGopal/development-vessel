// THE ADMISSION MARKER SELF-EXPIRES.
//
// pull-sync closes this vessel's admission for long-running work with a marker file
// (/workspace/quiesce/development-vessel) and removes it after the restart, or from its EXIT
// trap. An EXIT trap does not run on SIGKILL: a tick systemd killed at TimeoutStartSec left the
// marker behind, and quiesced() (mtime < QUIESCE_MAX_MS, 20 min) kept refusing composes for up to
// 20 minutes with no converger alive. pull-sync now writes expires_at into the marker (tick start
// + the unit's TimeoutStartSec; now + 20 min for a hold it carries across ticks), so a past-expiry
// marker must read as ABSENT. The 20-min mtime bound stays as a backstop, and a marker without
// expires_at (an older pull-sync, or vessel-mitosis-cutover's `: >`) keeps today's rule.
//
// WHAT THE FIX MUST ADD: src/lib/quiesce-marker.ts exporting
//   markerQuiesced(path: string, maxMs: number, nowMs?: number): boolean
// and src/index.ts's quiesced() must decide through it.
//
// The fixtures are the exact lines pull-sync's quiesce_mark prints (only expires_at differs).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Quiesced = (path: string, maxMs: number, nowMs?: number) => boolean;
const mod = (await import("../../src/lib/quiesce-marker").catch(() => ({}))) as { markerQuiesced?: Quiesced };
const markerQuiesced = mod.markerQuiesced;

const dir = mkdtempSync(join(tmpdir(), "dv-quiesce-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const MAX_MS = 20 * 60_000;
let n = 0;
/** Write a marker; `ageMs` sets its mtime that far in the past. */
function marker(content: string, ageMs = 0): string {
  const p = join(dir, `m${n++}`);
  writeFileSync(p, content);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}
// Verbatim quiesce_mark output (pull-sync), a tick hold whose expiry has passed.
const EXPIRED = '{"written_by":"pull-sync","pid":296504,"hold":"tick","expires_at":"2025-10-04T00:15:00Z"}\n';
const isoNoMs = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const unexpired = (hold: "tick" | "carry", inMs: number) =>
  `{"written_by":"pull-sync","pid":296504,"hold":"${hold}","expires_at":"${isoNoMs(Date.now() + inMs)}"}\n`;

describe("admission marker: expires_at", () => {
  test("markerQuiesced is exported by src/lib/quiesce-marker.ts", () => {
    expect(typeof markerQuiesced).toBe("function");
  });

  test("MUST-FAIL: a fresh marker whose expires_at has passed ADMITS (reads as absent)", () => {
    expect(typeof markerQuiesced).toBe("function");
    expect(markerQuiesced!(marker(EXPIRED), MAX_MS)).toBe(false);
  });

  test("src/index.ts quiesced() decides through markerQuiesced", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "index.ts"), "utf8");
    const at = src.indexOf("function quiesced(");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(/markerQuiesced\s*\(\s*QUIESCE_MARKER\s*,\s*QUIESCE_MAX_MS/.test(body)).toBe(true);
  });
});

describe("admission marker: controls", () => {
  test("an unexpired marker refuses (tick hold and carried hold)", () => {
    if (typeof markerQuiesced !== "function") return; // vacuous until the lib exists; the must-fail above is red
    expect(markerQuiesced(marker(unexpired("tick", 5 * 60_000)), MAX_MS)).toBe(true);
    expect(markerQuiesced(marker(unexpired("carry", 19 * 60_000)), MAX_MS)).toBe(true);
  });

  test("a legacy marker without expires_at follows the staleness rule", () => {
    if (typeof markerQuiesced !== "function") return;
    expect(markerQuiesced(marker(""), MAX_MS)).toBe(true); // `: >` from an older pull-sync or the cutover
    expect(markerQuiesced(marker("", 21 * 60_000), MAX_MS)).toBe(false);
    expect(markerQuiesced(marker('{"written_by":"pull-sync"}\n'), MAX_MS)).toBe(true);
    expect(markerQuiesced(marker('{"expires_at":"not a date"}\n'), MAX_MS)).toBe(true); // unparseable -> legacy rule
  });

  test("the 20-min mtime bound stays a backstop even when expires_at is in the future", () => {
    if (typeof markerQuiesced !== "function") return;
    expect(markerQuiesced(marker(unexpired("carry", 60 * 60_000), 21 * 60_000), MAX_MS)).toBe(false);
  });

  test("no marker admits", () => {
    if (typeof markerQuiesced !== "function") return;
    expect(markerQuiesced(join(dir, "absent"), MAX_MS)).toBe(false);
  });
});
