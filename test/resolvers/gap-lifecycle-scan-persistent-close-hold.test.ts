// gap_lifecycle_scan's persistent_compose_failure close skips a row whose landing or check is still in flight
// (research known-wrong KW13, the W5 class; REALIGNMENT §2.2, law 7).
//
// The close fired on failure_lessons.length >= 8 alone, so a row with a landed fix awaiting measurement
// (pending_outcome_verification), a live landing lease or a live own armed check was closed "persistent compose
// failure", discarding the one verdict that would be honest.
//
// HERMETIC, like gap-lifecycle-scan-armed-expiry.test.ts: temp gaps.json + proposals dir, WORKSPACE_ROOT at the temp
// dir, GAP_STORE_ENDPOINT unset (this process is the holder), and a fetch spy that answers every write.
// MUST-FAIL: a row with 8 failure lessons and a pending landing / a live landing lease / a live own arm is NOT closed.
// CONTROL: the same row with nothing in flight (and one with a lapsed lease) is still closed persistent_compose_failure.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";

type Gap = { id: string; classification_metadata?: Record<string, any> } & Record<string, any>;

const DEV = "http://dev-vessel.fixture.invalid/v2/impulses/resolve";
let ws = "";
let priorRoot: string | undefined;
let priorStoreEndpoint: string | undefined;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "gls-persistent-hold-"));
  priorRoot = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
  priorStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  if (priorRoot === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = priorRoot;
  if (priorStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = priorStoreEndpoint;
  rmSync(ws, { recursive: true, force: true });
});

describe("gap-lifecycle-scan: the persistent-compose-failure close waits for a pending landing, a lease or a live arm", () => {
  const H = 3_600_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const lessons = Array.from({ length: 8 }, (_, i) => ({ at: iso((10 - i) * H), class: "verify_failed", reason: `attempt ${i}` }));

  // A fresh (not stale) open row with saturated failure lessons: only the persistent close can touch it.
  function row(id: string, meta: Record<string, unknown>): Gap {
    return {
      id,
      category: "systematic_failure",
      source: "substrate_detected",
      status: "open",
      summary: `fixture row ${id}`,
      created_at: iso(2 * H),
      updated_at: iso(1 * H),
      classification_metadata: { failed_attempts: 8, failure_lessons: lessons, edit_site: "repos/development-vessel/src/resolvers/fixture.ts", ...meta },
    };
  }

  async function persistentClosed(gaps: Gap[]): Promise<string[]> {
    mkdirSync(join(ws, "gaps"), { recursive: true });
    mkdirSync(join(ws, "proposals", ".applied"), { recursive: true });
    const gapsPath = join(ws, "gaps", "gaps.json");
    writeFileSync(gapsPath, JSON.stringify(gaps));
    const writes: Gap[] = [];
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      const ptr = b?.impulse?.pointer ?? {};
      if (ptr.type === "substrateGap_write" && ptr.gap) writes.push(ptr.gap);
      return new Response(JSON.stringify({ shape: "ok", body: {} }), { status: 200 });
    }) as unknown as typeof fetch);
    await resolveGapLifecycleScan({
      type: "gap_lifecycle_scan",
      gapsPath,
      proposalsDir: join(ws, "proposals"),
      staleHours: 48,
      autoClose: true,
      falsify: false,
      devVesselImpulsesUrl: DEV,
    } as never);
    return writes
      .filter((w) => w.status === "closed" && w.classification_metadata?.closed_reason === "persistent_compose_failure")
      .map((w) => w.id)
      .sort();
  }

  it("MUST-FAIL: a pending landing, a live landing lease and a live own arm each keep the row from the persistent close", async () => {
    const closed = await persistentClosed([
      row("pending-landing", { pending_outcome_verification: "abcdef1234567", pending_set_at: iso(H) }),
      row("pending-disposition", { disposition: "pending_verification" }),
      row("leased", { landing_lease: { holder: "node-a", attempt: "x", acquired_at: iso(0.1 * H), until: new Date(Date.now() + H).toISOString() } }),
      row("armed", { check_supply: { state: "armed", armed_at: iso(3 * H), red_at_head: true, test_file: "test/checks/fixture.check.ts", vessel: "development-vessel", mode: "check_file" } }),
      row("idle", {}),
    ]);
    expect(closed).toEqual(["idle"]);
  });

  it("CONTROL: with nothing in flight (no landing, a lapsed lease, an unarmed ledger) the persistent close still fires", async () => {
    const closed = await persistentClosed([
      row("idle", {}),
      row("lapsed-lease", { landing_lease: { holder: "node-a", attempt: "x", acquired_at: iso(3 * H), until: iso(2 * H) } }),
      row("unarmed", { check_supply: { state: "unarmed" } }),
      row("short-pending", { pending_outcome_verification: "" }),
    ]);
    expect(closed).toEqual(["idle", "lapsed-lease", "short-pending", "unarmed"]);
  });
});
