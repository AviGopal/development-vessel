// THE GAP-DRAIN OBSERVER DISPATCHES ONLY REMEDY TYPES IT IS ALLOWED TO (check-first).
//
// handleGapWritten POSTed {type: remedy.impulse_type} to this vessel's own resolve route, carrying the
// node key (lib/self-auth.ts), with the type taken straight from gap data. A gap is data any writer can
// shape, so a gap whose remedy names fs_write, fs_edit or any other *_write would have that write
// executed with the node's own credential. The observer must refuse every type not on an explicit
// allowlist, say so with the gap id, and still dispatch an allowlisted remedy.
//
// ISOLATION: WORKSPACE_ROOT points at a scratch dir before import (recordDrain appends pool/drain-log.jsonl
// there); fetch is stubbed, so nothing reaches the network.
import { afterAll, beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "gap-drain-allowlist-"));
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = SCRATCH;
const { GapDrainObserver } = await import("../../src/services/gap-drain-observer.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
type Obs = { handleEvent: (e: { type: string; data: unknown }) => Promise<void> };
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });

const realFetch = globalThis.fetch;
let types: string[] = [];
let lines: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const g = globalThis as unknown as { __drainBackoff?: Map<string, unknown>; __drainInflight?: Set<string> };

beforeEach(() => {
  types = []; lines = [];
  g.__drainBackoff = new Map(); g.__drainInflight = new Set();
  for (const m of ["log", "warn", "error"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const imp = (JSON.parse(String(init?.body ?? "{}")).impulse ?? {}) as Record<string, unknown>;
    types.push(String(imp["type"]));
    if (imp["type"] === "maintenanceLease") return Response.json({ success: true, body: { held: false } });
    return Response.json({ success: true, body: {} });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; while (spies.length) spies.pop()!.mockRestore(); });

const written = (id: string, impulseType: string) => ({
  type: "devvessel.gap.written",
  data: { gap_id: id, category: "allowlist_probe", route: "dispatchable", remedy: { impulse_type: impulseType }, status: "open" },
});

describe("gap-drain remedy allowlist", () => {
  for (const bad of ["fs_write", "fs_edit", "substrateGap_write"]) {
    test(`[MUST-FAIL] a remedy of type ${bad} is not dispatched, and the refusal names the gap`, async () => {
      await (new GapDrainObserver() as unknown as Obs).handleEvent(written(`allowlist-probe-${bad}`, bad));
      expect(types).not.toContain(bad);
      expect(lines.some((l) => l.includes("REFUSED") && l.includes(`allowlist-probe-${bad}`) && l.includes(bad))).toBe(true);
    });
  }

  test("[CONTROL] an allowlisted remedy (gap_to_feature) is still dispatched", async () => {
    await (new GapDrainObserver() as unknown as Obs).handleEvent(written("allowlist-probe-ok", "gap_to_feature"));
    expect(types).toContain("gap_to_feature");
  });
});
