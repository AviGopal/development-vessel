// Per-resolver test for the ACTIONABILITY ADMISSION GATE added to gap-to-feature.
// Proves the auto-pick admission contract:
//   • an orphaned-capability gap with no producer and no cited file is EXCLUDED,
//   • a proposal-backed cited-file gap is ADMITTED (proven-landable path preserved),
//   • a metadata-cited existing-file gap is ADMITTED,
//   • a fresh provisionable orphan still gets its single auto-shot (mint path preserved),
//   • a typecheck-class gap is RETIRED (excluded) when the vessel's typecheck is clean,
//   • a typecheck-class gap whose error still errors is NOT excluded by the reality-check.
// Runtime + proposals dirs are pointed at a tmp fixture BEFORE importing the resolver
// (both are frozen into module-level consts at load), and the typecheck runner is injected
// so no real `tsc` (and no network) runs in the test.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `admit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const PROPOSALS = join(ROOT, "proposals");
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = PROPOSALS;
process.env.GAP_TYPECHECK_MAX_RUNS_PER_PASS = "8";

// Build the fixture vessel tree BEFORE the resolver module loads.
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
writeFileSync(join(ROOT, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
writeFileSync(join(ROOT, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
mkdirSync(join(ROOT, "identity-vessel", "src"), { recursive: true });
writeFileSync(join(ROOT, "identity-vessel", "src", "index.ts"), "export const y = 2;\n");
writeFileSync(join(ROOT, "identity-vessel", "package.json"), JSON.stringify({ name: "identity-vessel" }));
mkdirSync(PROPOSALS, { recursive: true });
writeFileSync(
  join(PROPOSALS, "operator-strategy-escalation-report.json"),
  JSON.stringify({ required_code_modifications: [{ file: "repos/goal-host-vessel/src/index.ts", description: "escalate" }] }),
);

// Silence the best-effort retire write (resolveSubstrateGapWrite) so it never hits the network.
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch; });
afterAll(() => { globalThis.fetch = originalFetch; try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const mod = await import("../../src/resolvers/gap-to-feature.js");
const { admitActionableGaps, typecheckClassOf, citedExistingFile, hasProposalReport } = mod;

// Typecheck runner: goal-host-vessel is CLEAN (phantom error already fixed); anything else errors.
const cleanRunner = (vessel: string) => ({ ran: true, clean: vessel === "goal-host-vessel" });
const stillErrorsRunner = (_vessel: string) => ({ ran: true, clean: false });

const ORPHAN_NO_PRODUCER = {
  id: "orphaned-capability-solicitationHeartbeat_write",
  category: "orphaned_capability",
  source: "substrate_detected",
  summary: "Author an activity that invokes resolver solicitationHeartbeat_write",
  status: "open",
  classification_metadata: { shape: "solicitationHeartbeat_write", failed_attempts: 2 },
};
const ORPHAN_NO_SHAPE = {
  id: "orphaned-capability-shapeClosureDemand",
  category: "orphaned_capability",
  source: "substrate_detected",
  summary: "resolver has no producer",
  status: "open",
  classification_metadata: { failed_attempts: 0 },
};
const ORPHAN_FRESH = {
  id: "orphaned-capability-recurringPatternConcept",
  category: "orphaned_capability",
  source: "substrate_detected",
  summary: "Author an activity that invokes resolver recurringPatternConcept",
  status: "open",
  classification_metadata: { shape: "recurringPatternConcept", failed_attempts: 0 },
};
const PROPOSAL_BACKED = {
  id: "operator-strategy-escalation",
  category: "decision_without_action",
  source: "substrate_detected",
  summary: "escalate operator strategy when repeated failure",
  status: "open",
  classification_metadata: {},
};
const CITED_FILE = {
  id: "surgical-fix-goal-host",
  category: "systematic_failure",
  source: "substrate_detected",
  summary: "fix the thing",
  status: "open",
  classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:12" },
};
const PHANTOM_TYPECHECK = {
  id: "detect-unclassified_failure_recurring_typecheck_goal_host_vessel_src_index_l619_ts2322_variant",
  category: "systematic_failure",
  source: "substrate_detected",
  summary: "TS2322 at repos/goal-host-vessel/src/index.ts:619",
  status: "open",
  classification_metadata: {},
};

const PHANTOM_IDENTITY = {
  id: "detect-unclassified_failure_identity_vessel_src_index_l10_ts2345_variant",
  category: "systematic_failure",
  source: "substrate_detected",
  summary: "TS2345 at repos/identity-vessel/src/index.ts:10",
  status: "open",
  classification_metadata: {},
};

describe("gap-to-feature actionability admission gate", () => {
  it("parses a typecheck-class gap's vessel + TS code from the underscore-delimited id", () => {
    const tc = typecheckClassOf(PHANTOM_TYPECHECK as unknown as Record<string, unknown>);
    expect(tc).not.toBeNull();
    expect(tc!.vessel).toBe("goal-host-vessel");
    expect(tc!.tsCode).toBe("TS2322");
  });

  it("recognizes cited + proposal-backed actionability helpers", () => {
    expect(citedExistingFile(CITED_FILE as unknown as Record<string, unknown>)).toBe("repos/goal-host-vessel/src/index.ts");
    expect(hasProposalReport("operator-strategy-escalation")).toBe(true);
    expect(hasProposalReport("no-such-gap")).toBe(false);
  });

  it("EXCLUDES a no-producer orphan and admits the proven-landable + fresh-orphan paths", async () => {
    const { admitted, excluded } = await admitActionableGaps(
      [ORPHAN_NO_PRODUCER, ORPHAN_NO_SHAPE, ORPHAN_FRESH, PROPOSAL_BACKED, CITED_FILE] as unknown as Record<string, unknown>[],
      { typecheckRunner: stillErrorsRunner },
    );
    const admittedIds = admitted.map((g) => String(g.id));
    const excludedIds = excluded.map((e) => e.id);

    // structurally-unclosable orphans excluded
    expect(excludedIds).toContain(ORPHAN_NO_PRODUCER.id);
    expect(excludedIds).toContain(ORPHAN_NO_SHAPE.id);
    expect(excluded.find((e) => e.id === ORPHAN_NO_PRODUCER.id)!.reason).toContain("orphan_no_producer");
    expect(excluded.find((e) => e.id === ORPHAN_NO_SHAPE.id)!.reason).toContain("orphan_missing_shape");

    // proven-landable path preserved
    expect(admittedIds).toContain(PROPOSAL_BACKED.id);
    expect(admittedIds).toContain(CITED_FILE.id);
    // mint-on-first-try preserved (fresh provisionable orphan gets its one shot)
    expect(admittedIds).toContain(ORPHAN_FRESH.id);
  });

  it("RETIRES a typecheck-class gap when the vessel typecheck is clean (phantom churn killed)", async () => {
    const { admitted, excluded } = await admitActionableGaps(
      [PHANTOM_TYPECHECK] as unknown as Record<string, unknown>[],
      { typecheckRunner: cleanRunner },
    );
    expect(admitted.map((g) => String(g.id))).not.toContain(PHANTOM_TYPECHECK.id);
    const ex = excluded.find((e) => e.id === PHANTOM_TYPECHECK.id);
    expect(ex).toBeDefined();
    expect(ex!.reason).toContain("typecheck_clean_phantom");
  });

  it("does NOT exclude a typecheck-class gap whose error still errors (reality-check negative)", async () => {
    const { admitted, excluded } = await admitActionableGaps(
      [PHANTOM_IDENTITY] as unknown as Record<string, unknown>[],
      { typecheckRunner: stillErrorsRunner },
    );
    // still-erroring typecheck gap is not retired; with no cited-file metadata it falls through to
    // the UNKNOWN-actionability admit (existing behavior preserved).
    expect(excluded.find((e) => e.id === PHANTOM_IDENTITY.id)).toBeUndefined();
    expect(admitted.map((g) => String(g.id))).toContain(PHANTOM_IDENTITY.id);
  });
});
