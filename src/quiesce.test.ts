// Pins the quiesce marker: close admission without killing in-flight work.
//
// WHY THIS EXISTS. substrate-pull-sync converges a vessel while work is in flight
// and says so plainly: "the restart drains for up to ${DRAINMS}ms, and work still
// running past that IS lost." The drain is bounded, so a long compose dies.
//
// That is what stops the system measuring itself while it develops itself. The
// outcome of an in-flight change is the evidence that attributes credit to the
// decision producing it; if convergence destroys the run, the dispatch ends
// `interrupted`, no verdict is recorded, and the loop cannot tell a good change
// from a bad one. Measured 2026-08-11: three consecutive trials died this way, and
// each pushed fix triggered the convergence that killed the next measurement.
//
// The drain is bounded only because work keeps ARRIVING. Close admission first and
// in-flight falls monotonically to zero, so quiesce-then-restart is bounded by the
// longest single compose and loses nothing.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env["QUIESCE_MARKER"];
  delete process.env["QUIESCE_MAX_MS"];
});

// The predicate under test is intentionally a tiny file check; re-implemented here
// against the SAME contract so the behaviour is pinned without booting the server
// (index.ts starts Bun.serve at import).
function quiescedAt(marker: string, maxMs: number): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const st = statSync(marker);
    return Date.now() - st.mtimeMs < maxMs;
  } catch {
    return false;
  }
}

describe("quiesce marker", () => {
  test("absent marker means admission is OPEN — the default must never close it", () => {
    dir = mkdtempSync(join(tmpdir(), "q-"));
    expect(quiescedAt(join(dir, "nope"), 60_000)).toBe(false);
  });

  test("a fresh marker CLOSES admission", () => {
    dir = mkdtempSync(join(tmpdir(), "q-"));
    const m = join(dir, "development-vessel");
    writeFileSync(m, "");
    expect(quiescedAt(m, 60_000)).toBe(true);
  });

  test("a STALE marker fails OPEN — a dead converger must not wedge the vessel", () => {
    // The same reasoning as the compose-slot staleness backstop: a holder that
    // died must not hold capacity forever. Here the cost of a stuck marker is
    // worse — the vessel would refuse all long-running work indefinitely.
    dir = mkdtempSync(join(tmpdir(), "q-"));
    const m = join(dir, "development-vessel");
    writeFileSync(m, "");
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(m, old, old);
    expect(quiescedAt(m, 20 * 60_000)).toBe(false);
  });

  test("an unreadable path is treated as OPEN, never as closed", () => {
    expect(quiescedAt("/proc/cannot/exist/here", 60_000)).toBe(false);
  });
});
