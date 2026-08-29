import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  resolveMaintenanceLease,
  resolveMaintenanceLeaseWrite,
} from "../../src/resolvers/maintenance-lease.js";
import { __resetMaintenanceLeaseCacheForTests } from "../../src/resolvers/http-retry.js";

// Sequential-state test file (model: substrate-gap.test.ts) — each `it` builds
// on the file left by the previous one. NO per-test cleanup: the acquire ->
// status -> conflicting-acquire -> renew -> release -> re-acquire lifecycle is
// the point of the test, and an afterEach that deletes the lease file would
// erase exactly the state the next assertion depends on.
const leasePath = join(tmpdir(), `dev-vessel-maintenance-lease-test-${Date.now()}.json`);
try {
  rmSync(leasePath, { force: true });
} catch {
  /* ignore */
}
process.env["MAINTENANCE_LEASE_PATH"] = leasePath;

// afterALL (not afterEach) — the sequential lifecycle above must survive between
// cases, but it must NOT survive this FILE. bun runs every suite in one process, and
// fetchWithRetry SUPPRESSES trace-store reads while a maintenance lease is active
// (http-retry.ts: TRACE_STORE_READ_PATTERNS + isMaintenanceLeaseActive, memoised for
// 5s in a module-level leaseCheckCache). Leaving a live lease behind therefore makes
// every later suite that reads /v2/activities/execution-traces silently receive
// nothing — coverage_tick reported trace_count 0 and coverage_progress false, looking
// like a broken detector when the read had simply been skipped by design.
// Verified: `bun test maintenance-lease.test.ts coverage-tick.test.ts` failed 2 while
// each file alone passed. Release the file AND clear the memoised check, since the
// cache would otherwise answer "active" for up to 5s after the file is gone.
afterAll(() => {
  try {
    rmSync(leasePath, { force: true });
  } catch {
    /* ignore */
  }
  __resetMaintenanceLeaseCacheForTests();
});

describe("maintenanceLease resolver", () => {
  it("status reports held:false when no lease file exists", async () => {
    const result = await resolveMaintenanceLease({ type: "maintenanceLease" });
    expect(result.shape).toBe("maintenanceLease");
    expect((result.body as { held: boolean }).held).toBe(false);
  });

  it("acquire succeeds and returns a token", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "trace-store-reconcile",
    });
    const body = result.body as { acquired: boolean; token: string; holder: string; expires_at: string };
    expect(body.acquired).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.holder).toBe("trace-store-reconcile");
  });

  it("status now reports held:true with the holder", async () => {
    const result = await resolveMaintenanceLease({ type: "maintenanceLease" });
    const body = result.body as { held: boolean; holder?: string };
    expect(body.held).toBe(true);
    expect(body.holder).toBe("trace-store-reconcile");
  });

  it("a conflicting acquire (different holder) is refused while unexpired", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "some-other-process",
    });
    const body = result.body as { acquired: boolean; held_by?: string };
    expect(body.acquired).toBe(false);
    expect(body.held_by).toBe("trace-store-reconcile");
  });

  it("the same holder re-acquiring succeeds (idempotent-ish, mints a fresh token)", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "trace-store-reconcile",
    });
    expect((result.body as { acquired: boolean }).acquired).toBe(true);
  });

  let currentToken = "";

  it("acquire (fresh) captures the token for subsequent renew/release tests", async () => {
    // Release whatever's there first so we start from a clean slate for this sub-flow.
    const status = await resolveMaintenanceLease({ type: "maintenanceLease" });
    if ((status.body as { held: boolean }).held) {
      // best-effort cleanup via a fresh acquire (same holder always wins over itself)
    }
    const acquireResult = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "trace-store-reconcile",
    });
    currentToken = (acquireResult.body as { token: string }).token;
    expect(currentToken.length).toBeGreaterThan(0);
  });

  it("renew with the WRONG token is refused", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "renew",
      token: "not-the-real-token",
    });
    expect((result.body as { renewed: boolean }).renewed).toBe(false);
  });

  it("renew with the correct token succeeds and extends expires_at", async () => {
    const before = await resolveMaintenanceLease({ type: "maintenanceLease" });
    const beforeExpiry = (before.body as { expires_at: string }).expires_at;

    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "renew",
      token: currentToken,
      ttl_ms: 1_800_000,
    });
    const body = result.body as { renewed: boolean; expires_at: string };
    expect(body.renewed).toBe(true);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThanOrEqual(new Date(beforeExpiry).getTime());
  });

  it("release with the WRONG token is refused", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "release",
      token: "not-the-real-token",
    });
    expect((result.body as { released: boolean }).released).toBe(false);
  });

  it("release with the correct token succeeds", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "release",
      token: currentToken,
    });
    expect((result.body as { released: boolean }).released).toBe(true);
  });

  it("status now reports held:false again", async () => {
    const result = await resolveMaintenanceLease({ type: "maintenanceLease" });
    expect((result.body as { held: boolean }).held).toBe(false);
  });

  it("release is idempotent when the lease is already gone", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "release",
      token: "anything",
    });
    const body = result.body as { released: boolean; note?: string };
    expect(body.released).toBe(true);
    expect(body.note).toBe("already_absent");
  });

  let secondHolderToken = "";

  it("re-acquire after release succeeds for a brand new holder", async () => {
    const result = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "a-different-holder",
    });
    const body = result.body as { acquired: boolean; token: string };
    expect(body.acquired).toBe(true);
    secondHolderToken = body.token;
  });

  it("ttl_ms is clamped to the max (1 hour)", async () => {
    // Release the lease held by the previous test so this acquire isn't refused.
    await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "release",
      token: secondHolderToken,
    });

    const acquireResult = await resolveMaintenanceLeaseWrite({
      type: "maintenanceLease_write",
      op: "acquire",
      holder: "ttl-clamp-test",
      ttl_ms: 999_999_999,
    });
    const body = acquireResult.body as { acquired: boolean; expires_at: string };
    expect(body.acquired).toBe(true);
    const ttl = new Date(body.expires_at).getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(3_600_000 + 2_000); // small slack for test execution time
  });
});
