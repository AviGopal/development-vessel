// Per-resolver test for the PENDING-LAND VERIFICATION SWEEP in gap-to-feature.
//
// §12.6 step 1 (2026-08-14) — the close-oracle refuses to close on PROVENANCE alone. The sweep
// closes a pending gap ONLY on a positively-MEASURED 'absent' (a Class-1 literal or Class-2
// resolver-behaviour predicate observed the condition gone). A single landing with NO measurement
// predicate is 'pending' — landed but unverified (the inert-diff / bafd83d hole) — and is HELD OPEN
// (escalated to a human), NOT closed green on the commit count. An unlanded pending sha and an
// ordinary gap are untouched.
//
// The gap store is pointed at a tmp WORKSPACE_ROOT, the clone tree at a tmp VESSELS_CLONE_ROOT, and
// the close-oracle calibration at a tmp file (so the test never reads/mutates the host's live calib).
// Real git, no network (fetch mocked).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `pending-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
process.env.WORKSPACE_ROOT = ROOT;
process.env.VESSELS_CLONE_ROOT = CLONES;
process.env.EXPECTATION_CALIB_PATH = join(ROOT, "expectation-calibration.json");
process.env.CLOSE_ORACLE_CALIB_PATH = join(ROOT, "close-oracle-calibration.json");

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

let measuredSha = "";
let inertSha = "";

// Silence the best-effort pool/event emissions AND stand in for the Class-2 self-resolve:
// an empty {} body carries no defect signature, so verifyGapConditionAsync reads it as 'absent'
// (healthy) — a clean MEASURED-resolved verdict for the measurable gap.
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const repo = join(CLONES, "development-vessel");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "f.txt"), "measured\n");
  git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", "a fix that a predicate can verify");
  measuredSha = git(repo, "rev-parse", "HEAD");
  // A SINGLE landing that NAMES the inert gap — provenance only, no measurement predicate.
  writeFileSync(join(repo, "g.txt"), "inert\n");
  git(repo, "add", "g.txt");
  git(repo, "commit", "-q", "-m", "substrate-authored: apply gap-pending-inert-compose-report via mitosis cutover");
  inertSha = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now };
  writeFileSync(GAPS_PATH, JSON.stringify([
    // (1) MEASURABLE: a Class-2 predicate measures the condition gone => CLOSES as landed_verified.
    { ...base, id: "gap-pending-measured", category: "systematic_failure", summary: "landed, and a predicate can verify it", status: "open", classification_metadata: { pending_outcome_verification: measuredSha, pending_set_at: now, evidence_resolve: { shape: "health_probe" } } },
    // (2) INERT: a single landing names the gap, but NOTHING can measure resolution => HELD PENDING.
    //     This is the inert-diff (bafd83d) refusal: provenance is not measurement, so no close.
    { ...base, id: "gap-pending-inert", category: "systematic_failure", summary: "landed once, unverifiable — the inert-diff hole", status: "open", classification_metadata: { pending_outcome_verification: inertSha, pending_set_at: now } },
    // (3) UNLANDED: pending sha never reached a clone => stays open (retry next tick).
    { ...base, id: "gap-pending-unlanded", category: "systematic_failure", summary: "pending sha never reached a clone", status: "open", classification_metadata: { pending_outcome_verification: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", pending_set_at: now } },
    // (4) ORDINARY: no pending marker => untouched by the sweep.
    { ...base, id: "gap-ordinary-open", category: "systematic_failure", summary: "open gap without pending marker", status: "open", classification_metadata: {} },
  ]));
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("sweepPendingLandVerifications — close on MEASUREMENT, abstain on provenance (§12.6)", () => {
  it("closes only the MEASURED-resolved gap; HOLDS the inert single-landing pending; leaves unlanded + ordinary open", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    const result = await sweepPendingLandVerifications();
    expect(result.checked).toBe(3); // the three gaps carrying a pending marker
    expect(result.closed).toBe(1);  // ONLY the measurable one

    const gaps = JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>;
    const byId = new Map(gaps.map((g) => [g.id, g]));

    // (1) measured-resolved => closed as landed_verified
    const measured = byId.get("gap-pending-measured") as Record<string, unknown>;
    expect(measured.status).toBe("closed");
    expect((measured.classification_metadata as Record<string, unknown>).closed_reason).toBe("landed_verified");

    // (2) THE B1 PROOF: an inert single landing is NOT closed — it is held pending verification.
    const inert = byId.get("gap-pending-inert") as Record<string, unknown>;
    expect(inert.status).toBe("open");
    expect((inert.classification_metadata as Record<string, unknown>).disposition).toBe("pending_verification");

    // (3) + (4) untouched
    expect((byId.get("gap-pending-unlanded") as Record<string, unknown>).status).toBe("open");
    expect((byId.get("gap-ordinary-open") as Record<string, unknown>).status).toBe("open");
  });

  it("records a MEASURED close-verdict (not a landed_commit one) so provenance never fakes success", async () => {
    const calib = JSON.parse(readFileSync(join(ROOT, "close-oracle-calibration.json"), "utf8")) as Record<string, { closes: number; false_closes: number }>;
    expect(calib.measured?.closes).toBeGreaterThanOrEqual(1);
    // landed_commit must NOT have accrued a success from the inert gap's commit count.
    expect(calib.landed_commit?.closes ?? 0).toBe(0);
  });

  it("is idempotent for the closed gap: a second sweep does not re-close it", async () => {
    const { sweepPendingLandVerifications } = await import("../../src/resolvers/gap-to-feature.js");
    const result = await sweepPendingLandVerifications();
    // the measured gap is now closed (gone from the open set); the inert gap is still held pending
    // (still checked, still not closed).
    expect(result.closed).toBe(0);
  });
});
