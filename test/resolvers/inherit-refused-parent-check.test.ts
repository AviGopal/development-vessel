// A child is not handed a check its parent's supply refused.
//
// inheritableParentCheck (substrate-gap.ts) gives a -narrowed or recommit- child its parent's trusted class-2 test_suite
// check. It did so even when the parent's own check supply had REFUSED that very check (check_supply.state arm_refused,
// e.g. check_satisfied_by_gutting, judged_inputs.check_sha256 the refused content): the child, which carries no ledger
// of its own, then armed on the refused check. While the refusal stands on today's landed check (the arm pass would not
// judge it again), the child now inherits nothing and gets its own check from the supply. A refusal of content that has
// since changed is the supply's to judge again: the child inherits as before.
//
//   [MUST-FAIL] a parent arm_refused on file F at the sha F holds at origin/dev: inheritableParentCheck gives nothing.
//   [MUST-FAIL] the same parent narrowed (narrowedChildRecord, checks "inherit"): the child has no evidence_resolve.
//   [CONTROL]   a parent whose supply ARMED the check: inherited as today.
//   [CONTROL]   a parent refused at a DIFFERENT sha than F's landed content: inherited (the supply re-judges it).
//   [CONTROL]   a parent with no check_supply ledger: inherited.
//   [CONTROL]   a parent refused on ANOTHER file: inherited.
// Both must-fails drive existing exports with their BASE signatures; no new seam.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landCheck } from "./landed-check.fixture.js";
import { class2PredicateKey, inheritableParentCheck } from "../../src/resolvers/substrate-gap.js";
import { narrowedChildRecord } from "../../src/judge/gap-attempt-credit.js";

const ROOT = join(tmpdir(), `inherit-refused-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const VESSEL = "development-vessel";
const SITE = `repos/${VESSEL}/src/resolvers/fixture-site.ts`;
const CHECK_REL = "test/checks/fixture-refused.check.ts";
const CHECK_SRC = 'import { it, expect } from "bun:test";\nit("fixture > reads the site", () => { expect(1).toBe(1); });\n';
const SHA = createHash("sha256").update(CHECK_SRC).digest("hex");
const CHECK = { shape: "test_suite", input: { vessel: VESSEL, test_file: CHECK_REL, only_tests: ["fixture > reads the site"] }, zero_field: "requested_not_passing" };
const savedClones = process.env["VESSELS_CLONE_ROOT"];

const parentMeta = (checkSupply?: Record<string, unknown>): Record<string, unknown> => ({
  falsifier: "class2", edit_site: SITE, evidence_resolve: CHECK, predicate_birth_verdict: "present",
  predicate_birth_key: class2PredicateKey({ evidence_resolve: CHECK }),
  ...(checkSupply ? { check_supply: checkSupply } : {}),
});
const refused = (sha: string, testFile = CHECK_REL): Record<string, unknown> => ({
  state: "arm_refused", reason: "check_satisfied_by_gutting: a fix that removes the behaviour turns it green",
  test_file: testFile, vessel: VESSEL, judged_inputs: { region: "", edit_site: SITE, check_sha256: sha },
});
const narrowed = (meta: Record<string, unknown>): Record<string, unknown> =>
  narrowedChildRecord({ id: "fixture-parent", category: "systematic_failure", source: "human_reported", summary: "fixture parent", status: "open", classification_metadata: meta }, meta,
    { id: "fixture-parent-narrowed", checks: "inherit", summaryTail: "", extra: {} }).classification_metadata as Record<string, unknown>;

beforeAll(() => {
  const clone = join(CLONES, VESSEL);
  mkdirSync(join(clone, "test", "checks"), { recursive: true });
  writeFileSync(join(clone, CHECK_REL), CHECK_SRC);
  landCheck(clone, CHECK_REL);
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
});
afterAll(() => {
  if (savedClones === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = savedClones;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("inheritableParentCheck: not a check the parent's supply refused", () => {
  it("[MUST-FAIL] a parent arm_refused on F at F's landed sha gives the child no check", () => {
    const got = inheritableParentCheck(parentMeta(refused(SHA)), SITE);
    expect(got["evidence_resolve"]).toBeUndefined();
    expect(got).toEqual({});
  });
  it("[MUST-FAIL] narrowed from that parent: the child is born with no evidence_resolve on F", () => {
    const cm = narrowed(parentMeta(refused(SHA)));
    expect(cm["evidence_resolve"]).toBeUndefined();
    expect(cm["predicate_source"]).toBeUndefined();
    expect(cm["parent_gap_id"]).toBe("fixture-parent");
  });
  it("control: a parent whose supply armed the check is inherited as today", () => {
    const meta = parentMeta({ state: "armed", test_file: CHECK_REL, vessel: VESSEL });
    expect(inheritableParentCheck(meta, SITE)["evidence_resolve"]).toEqual(CHECK);
    expect(narrowed(meta)["evidence_resolve"]).toEqual(CHECK);
  });
  it("control: a parent refused at a different sha than F's landed content is inherited", () => {
    const meta = parentMeta(refused("0".repeat(64)));
    expect(inheritableParentCheck(meta, SITE)["evidence_resolve"]).toEqual(CHECK);
    expect(narrowed(meta)["evidence_resolve"]).toEqual(CHECK);
  });
  it("control: a parent with no check_supply ledger is inherited", () => {
    expect(inheritableParentCheck(parentMeta(), SITE)["evidence_resolve"]).toEqual(CHECK);
    expect(narrowed(parentMeta())["evidence_resolve"]).toEqual(CHECK);
  });
  it("control: a parent refused on another file is inherited", () => {
    expect(inheritableParentCheck(parentMeta(refused(SHA, "test/checks/other.check.ts")), SITE)["evidence_resolve"]).toEqual(CHECK);
  });
});
