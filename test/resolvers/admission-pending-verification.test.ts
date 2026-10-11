// A landed-but-unverified gap is not compose work (2026-09-30, compose2 lane 03:30-15:30 UTC: 35 of 75
// picks went to gaps whose own autonomous commit had already landed; each re-draft spent LLM budget on
// fixed code until the envelope ran out). markPendingVerification stamps disposition "pending_verification"
// and its docstring promised the picker would skip the gap, but admission excluded only the parking
// dispositions. Admission now excludes it, and re-admits it once the landing is known not to have fixed
// it: regressed_by recorded, a BEHAVIORAL VERIFICATION FAILED summary, or the sweep's own not-resolved
// verdict, which lifts the disposition to "" so the gap cannot stay parked forever.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-pv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
// Both are restored in afterAll: later files in the run read MITOSIS_RUNTIME_DIR as the vessel runtime.
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR };
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
writeFileSync(join(ROOT, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
writeFileSync(join(ROOT, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
mkdirSync(join(ROOT, "proposals"), { recursive: true });

// The policy reads (autonomyScope, spendEnvelope) fail closed when they cannot be read or hold no record, so this
// fixture answers them as a read that SUCCEEDS and finds the explicit open records (unrestricted, uncapped).
const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return explicitOpenPolicy(body) ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  (modPolicy as { __resetPolicyReadsForTests: () => void }).__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const mod = await import("../../src/resolvers/gap-to-feature.js") as Record<string, unknown>;
const modAdmission = await import("../../src/judge/gap-admission.js") as Record<string, unknown>;
const modLanding = await import("../../src/judge/gap-landing-verdict.js") as Record<string, unknown>;
const modPolicy = await import("../../src/judge/gap-policy.js") as Record<string, unknown>;
const elig = await import("../../src/judge/gap-eligibility.js") as Record<string, unknown>;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }> }>;
const isAwaitingLandVerification = elig.isAwaitingLandVerification as (g: Record<string, unknown>) => boolean;
const liftLandVerificationHold = elig.liftLandVerificationHold as (m: Record<string, unknown>) => Record<string, unknown> | null;
const landVerdictIsMeasured = elig.landVerdictIsMeasured as (m: Record<string, unknown>) => boolean;
const releasedRow = modLanding.releasedRow as (fresh: Record<string, unknown> | null, why: string, revertedSha?: string) => Record<string, unknown> | null;

const runner = (_v: string) => ({ ran: true, clean: false });
function gap(id: string, meta: Record<string, unknown>, summary = "fix the thing"): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary, status: "open",
    // Armed (class2): admission takes only open + armed + sited + unheld gaps (composeEligibilitySkipReason).
    classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:1", falsifier: "class2", ...meta },
  };
}
async function admit(gs: Record<string, unknown>[]) {
  const r = await admitActionableGaps(gs, { typecheckRunner: runner });
  return { admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}

describe("admission excludes a landed gap awaiting verification", () => {
  it("a pending_verification gap with no regression marker is excluded as disposition(pending_verification)", async () => {
    const g = gap("pv-plain-aaaaaaaa", { disposition: "pending_verification", pending_outcome_verification: "abcdef1234567" });
    expect(isAwaitingLandVerification(g)).toBe(true);
    const { admittedIds, reasonOf } = await admit([g]);
    expect(admittedIds).not.toContain(g.id);
    expect(reasonOf(String(g.id))).toBe("disposition(pending_verification)");
  });

  it("re-admits it when regressed_by is recorded", async () => {
    const g = gap("pv-regressed-bbbbbbbb", { disposition: "pending_verification", regressed_by: { sha: "abcdef1", revert_sha: null, verdict: "present" } });
    expect(isAwaitingLandVerification(g)).toBe(false);
    const { admittedIds } = await admit([g]);
    expect(admittedIds).toContain(g.id);
  });

  it("re-admits it when its summary says BEHAVIORAL VERIFICATION FAILED", async () => {
    const g = gap("pv-behavioral-cccccccc", { disposition: "pending_verification" }, "fix the thing — BEHAVIORAL VERIFICATION FAILED: regressed_by abcdef1");
    expect(isAwaitingLandVerification(g)).toBe(false);
    const { admittedIds } = await admit([g]);
    expect(admittedIds).toContain(g.id);
  });

  it("a gap with disposition \"\" or none is unaffected (positive control through the same path)", async () => {
    const cleared = gap("pv-cleared-dddddddd", { disposition: "" });
    const absent = gap("pv-absent-eeeeeeee", {});
    expect(isAwaitingLandVerification(cleared)).toBe(false);
    expect(isAwaitingLandVerification(absent)).toBe(false);
    const { admittedIds } = await admit([cleared, absent]);
    expect(admittedIds).toContain(cleared.id);
    expect(admittedIds).toContain(absent.id);
  });

  it("a null regressed_by is not a regression marker", () => {
    expect(isAwaitingLandVerification(gap("pv-null-ffffffff", { disposition: "pending_verification", regressed_by: null }))).toBe(true);
  });
});

describe("the sweep's not-resolved verdict lifts the hold, so the gap is re-admitted", () => {
  it("lifting clears disposition to the empty string (the store carries omitted keys forward) and keeps the rest", () => {
    const meta = { disposition: "pending_verification", pending_outcome_verification: "abcdef1234567", edit_site: "repos/goal-host-vessel/src/index.ts" };
    const lifted = liftLandVerificationHold(meta);
    expect(lifted).not.toBeNull();
    expect(lifted!.disposition).toBe("");
    expect(lifted!.pending_outcome_verification).toBe("abcdef1234567");
    expect(isAwaitingLandVerification({ id: "x", summary: "s", classification_metadata: lifted! })).toBe(false);
  });

  it("nothing to lift for parking, cleared or absent dispositions (so the sweep writes once, not every tick)", () => {
    for (const d of ["needs_information", "needs_info", "awaiting_operator_review", ""]) expect(liftLandVerificationHold({ disposition: d })).toBeNull();
    expect(liftLandVerificationHold({})).toBeNull();
  });

  it("a 'present' verdict counts as a not-resolved measurement only for a gap with a measurement predicate", () => {
    expect(landVerdictIsMeasured({ edit_site: "repos/v/src/a.ts:3", hardcoded_url: "http://x" })).toBe(true);
    expect(landVerdictIsMeasured({ file_path: "repos/v/src/a.ts", expected_literal: "foo" })).toBe(true);
    expect(landVerdictIsMeasured({ evidence_resolve: { shape: "s", zero_field: "n" } })).toBe(true);
    expect(landVerdictIsMeasured({ verify_shape: "s" })).toBe(true);
    // class-3 provenance: 'present' means re-landed >= 2 times, which is churn for a human, not a retry signal
    expect(landVerdictIsMeasured({ edit_site: "repos/v/src/a.ts" })).toBe(false);
    expect(landVerdictIsMeasured({ hardcoded_url: "http://x" })).toBe(false);
    // "" is how a predicate is retired (nonEmptyStr): the verifier falls through to provenance
    expect(landVerdictIsMeasured({ edit_site: "repos/v/src/a.ts", hardcoded_url: "" })).toBe(false);
  });

  // The sweep branches call git/systemctl and the gap store, so their wiring is pinned by source position
  // (precedent: drafter-tool-closure.test.ts).
  // The sweep moved to the closed gap-landing-verdict module (gap-to-feature judge split); admission stays in the residue.
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/gap-to-feature.ts"), "utf8") + "\n" + readFileSync(join(import.meta.dir, "../../src/judge/gap-landing-verdict.ts"), "utf8") + "\n" + readFileSync(join(import.meta.dir, "../../src/judge/gap-admission.ts"), "utf8");
  const windowOf = (startAnchor: string, endAnchor: string): string => {
    const s = src.indexOf(startAnchor);
    expect(s).toBeGreaterThan(-1);
    const e = src.indexOf(endAnchor, s);
    expect(e).toBeGreaterThan(s);
    return src.slice(s, e);
  };

  it("the REVERTED branch releases the hold before it continues, and passes the reverted sha", () => {
    const w = windowOf("if (operatorReverted || shaWasRevertedInAnyClone(sha))", "continue;");
    expect(w).toMatch(/releaseUnresolvedLanding\(g, `[^`]*`, sha\)/);
  });

  it("the measured-'present' branch releases the hold once the landing is running here", () => {
    const w = windowOf('if (falsified === "recorded")', "escalateRelandToHuman(");
    expect(w).toContain("releaseUnresolvedLanding(");
    expect(w).toContain("landVerdictIsMeasured(");
    expect(w).toContain("landedCommitRunningHere(sha)");
  });

  it("the measured-'present' release passes no reverted sha, so its stamp is left alone", () => {
    const w = windowOf('if (falsified === "recorded")', "escalateRelandToHuman(");
    expect(w).toMatch(/releaseUnresolvedLanding\(g, `[^`]*`\)/);
  });

  it("the release decides on a FRESH read of the gap, before any write", () => {
    const w = windowOf("async function releaseUnresolvedLanding(", "\n}\n");
    const read = w.indexOf("releasedRow(await readGapFresh(id)");
    const guard = w.indexOf("if (!row) return;");
    const write = w.indexOf("resolveSubstrateGapWrite(");
    expect(read).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(guard);
    expect(w).toContain("gap: row }");
  });

  it("admission tests the predicate and names the reason", () => {
    const w = windowOf("if (isParkingDisposition(meta.disposition))", "greenOnParentFresh(meta)");
    expect(w).toContain("isAwaitingLandVerification(g)");
    expect(w).toContain('"disposition(pending_verification)"');
  });
});

describe("the release acts on the gap as the store holds it now (releasedRow)", () => {
  const fresh = (status: string, meta: Record<string, unknown>): Record<string, unknown> => ({
    id: "pv-fresh-gggggggg", category: "systematic_failure", source: "substrate_detected", summary: "s", detected_at: "2026-09-01T00:00:00Z",
    status, reopen_count: 3, first_detected_at: "2026-08-01T00:00:00Z",
    classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts", pending_outcome_verification: "abcdef1234567", ...meta },
  });

  it("a row CLOSED since the sweep read it is not written (no reopen)", () => {
    expect(releasedRow(fresh("closed", { disposition: "pending_verification" }), "why")).toBeNull();
  });

  it("a row that became awaiting_operator_review or needs_information is not written (human hold kept)", () => {
    expect(releasedRow(fresh("open", { disposition: "awaiting_operator_review" }), "why")).toBeNull();
    expect(releasedRow(fresh("open", { disposition: "needs_information" }), "why")).toBeNull();
    expect(releasedRow(fresh("open", { disposition: "" }), "why")).toBeNull();
    expect(releasedRow(null, "why")).toBeNull();
  });

  it("the written row is the whole fresh row: top-level keys survive unchanged", () => {
    const f = fresh("open", { disposition: "pending_verification", failure_lessons: [{ class: "x" }] });
    const row = releasedRow(f, "measured present")!;
    expect(row).not.toBeNull();
    expect(row.status).toBe("open");
    expect(row.reopen_count).toBe(3);
    expect(row.first_detected_at).toBe("2026-08-01T00:00:00Z");
    expect(row.detected_at).toBe("2026-09-01T00:00:00Z");
    const m = row.classification_metadata as Record<string, unknown>;
    expect(m.disposition).toBe("");
    expect(m.pending_note).toBe("released: measured present");
    expect(m.failure_lessons).toEqual([{ class: "x" }]);
    expect(isAwaitingLandVerification(row)).toBe(false);
  });

  it("a REVERTED release clears the pending stamp and records reverted_landing", () => {
    const row = releasedRow(fresh("open", { disposition: "pending_verification" }), "reverted", "abcdef1234567")!;
    const m = row.classification_metadata as Record<string, unknown>;
    expect(m.pending_outcome_verification).toBe("");
    expect(m.reverted_landing).toBe("abcdef1234567");
    expect(m.disposition).toBe("");
  });

  it("a measured-present release (no reverted sha) leaves the stamp as is", () => {
    const row = releasedRow(fresh("open", { disposition: "pending_verification" }), "measured present")!;
    const m = row.classification_metadata as Record<string, unknown>;
    expect(m.pending_outcome_verification).toBe("abcdef1234567");
    expect("reverted_landing" in m).toBe(false);
  });
});
