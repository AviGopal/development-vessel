// A PARENT'S CHECK-SUPPLY REFUSAL DOES NOT ARM ITS DERIVED ROW.
//
// The supply's check path is per gap id, truncated (checkSupplyCheckPath), so a -narrowed child (or a recommit) runs
// its parent's check file. The supply refused that file on the parent (check_supply.state arm_refused, judged at sha
// S); the child carries class2 evidence on the same file and no check_supply ledger of its own, so it was armed and the
// auto-pick took it, grounding the drafter on the refused check. The pick now builds every open row's refusals once per
// pass (refusedSupplyChecks, from the whole open read) and the child on a refused file is not armed.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { admitActionableGaps } from "../../src/judge/gap-admission.js";
import { composeEligibilitySkipReason } from "../../src/judge/gap-eligibility.js";
import { checkSupplyCheckPath } from "../../src/resolvers/check-supply-admission.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    throw new TypeError("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
});
afterAll(() => { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); });

// Hermetic vessel tree, as gap-to-feature-admission-compose-eligibility.test.ts: the edit site exists in the runtime
// fixture and the clone root is an empty dir.
const FIXTURE = mkdtempSync(join(tmpdir(), "admission-refused-check-"));
const SAVED_ENV = { runtime: process.env["MITOSIS_RUNTIME_DIR"], clones: process.env["VESSELS_CLONE_ROOT"] };
process.env["MITOSIS_RUNTIME_DIR"] = join(FIXTURE, "runtime");
process.env["VESSELS_CLONE_ROOT"] = join(FIXTURE, "clones");
mkdirSync(join(FIXTURE, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
writeFileSync(join(FIXTURE, "runtime", "development-vessel", "src", "resolvers", "some-module.ts"), "export const fixture = 1;\n");
mkdirSync(join(FIXTURE, "clones"), { recursive: true });
afterAll(() => {
  for (const [k, v] of [["MITOSIS_RUNTIME_DIR", SAVED_ENV.runtime], ["VESSELS_CLONE_ROOT", SAVED_ENV.clones]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(FIXTURE, { recursive: true, force: true });
});

const SITE = "repos/development-vessel/src/resolvers/some-module.ts";
// Long enough that the parent and its -narrowed child slug to ONE check path (the premise of the defect).
const PARENT = "a-fixture-check-judged-at-head-by-a-defect-that-is-never-re-judged-and-the-next-attempt-loses-it";
const CHILD = `${PARENT}-narrowed`;
const F = checkSupplyCheckPath(PARENT);
const G = "test/checks/an-unrelated-fixture-check.check.ts";
const S = "526115cd22c67c633272b5967abf79ef66be1ef26ea6cc5a7b06838e001da533";

const evidenceOn = (file: string) => ({ shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: file, only_tests: ["a title"] }, zero_field: "requested_not_passing" });
const row = (id: string, meta: Record<string, unknown>) => ({ id, category: "systematic_failure", status: "open", summary: `refused-check lineage probe ${id}`, classification_metadata: meta });
const parent = (ledger: Record<string, unknown>) => row(PARENT, {
  falsifier: "class2", edit_site: SITE, evidence_resolve: evidenceOn(F),
  check_supply: { test_file: F, vessel: "development-vessel", reason: "check_satisfied_by_gutting: a fix that removes the behaviour passes it", judged_inputs: { region: "", edit_site: SITE, check_sha256: S }, ...ledger },
});
const child = () => row(CHILD, { falsifier: "class2", edit_site: SITE, evidence_resolve: evidenceOn(F) });
const admit = async (gaps: Array<Record<string, unknown>>, index?: Array<Record<string, unknown>>) => {
  const r = await admitActionableGaps(gaps, index ? { lineageIndex: new Map(index.map((g) => [String(g.id), g])) } : undefined);
  return { ids: r.admitted.map((g) => String(g.id)), excluded: r.excluded };
};

describe("auto-pick admission: another open row's arm refusal of the same check file", () => {
  it("premise: the parent and its -narrowed child resolve to one check path", () => {
    expect(checkSupplyCheckPath(CHILD)).toBe(F);
  });

  it("[MUST-FAIL] the live pair: parent arm_refused on F at sha S, -narrowed child class2 on F with no ledger: the child is not admitted", async () => {
    const p = parent({ state: "arm_refused" }); const c = child();
    const { ids, excluded } = await admit([p, c], [p, c]);
    expect(ids).not.toContain(CHILD);
    expect(excluded.find((e) => e.id === CHILD)?.reason ?? "").toContain(`check_supply_refused(${F} by ${PARENT} @526115cd22c6)`);
  });

  it("[MUST-FAIL] the parent filtered out of the candidates (a pick brake) still un-arms the child through the whole open read", async () => {
    const p = parent({ state: "arm_refused" }); const c = child();
    const { ids } = await admit([c], [p, c]);
    expect(ids).not.toContain(CHILD);
  });

  it("CONTROL: once the supply re-judges the parent's changed check and writes armed, the child is admitted", async () => {
    const p = parent({ state: "armed" }); const c = child();
    const { ids } = await admit([p, c], [p, c]);
    expect(ids).toContain(CHILD);
  });

  it("CONTROL: a CLOSED refusing parent (only open rows build the set) leaves the child armed", async () => {
    const p = { ...parent({ state: "arm_refused" }), status: "closed" }; const c = child();
    const { ids } = await admit([c], [p, c]);
    expect(ids).toContain(CHILD);
  });

  it("CONTROL: an unrelated row on another file is admitted beside the refused pair", async () => {
    const p = parent({ state: "arm_refused" }); const c = child();
    const other = row("an-unrelated-fixture-row", { falsifier: "class2", edit_site: SITE, evidence_resolve: evidenceOn(G) });
    const { ids } = await admit([p, c, other], [p, c, other]);
    expect(ids).toContain("an-unrelated-fixture-row");
    expect(ids).not.toContain(CHILD);
  });

  it("CONTROL: with no refusing row in the open read the child is admitted, as today", async () => {
    const c = child();
    expect((await admit([c], [c])).ids).toContain(CHILD);
    expect((await admit([c])).ids).toContain(CHILD);
  });

  it("CONTROL: the predicate itself is unchanged: the child alone reads armed", () => {
    expect(composeEligibilitySkipReason(child())).toBeNull();
  });

  it("a refusal record with no judged sha still un-arms the child (fail safe) and says so", async () => {
    const p = parent({ state: "arm_refused", judged_inputs: undefined }); const c = child();
    const { ids, excluded } = await admit([p, c], [p, c]);
    expect(ids).not.toContain(CHILD);
    expect(excluded.find((e) => e.id === CHILD)?.reason ?? "").toContain("no judged sha");
  });
});
