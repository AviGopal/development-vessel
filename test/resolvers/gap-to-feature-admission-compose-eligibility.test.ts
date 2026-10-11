// THE AUTO-PICK ADMITS ONLY WHAT THE COMPOSE NUDGE WOULD NUDGE FOR.
//
// admitActionableGaps' actionable-only gate excluded a gap only when it had NEITHER an edit site NOR a class1/class2
// falsifier: a sited gap with falsifier none was admitted (1661 of the 1961 open rows that passed this gate on the
// live store, 2026-10-03), an armed gap with no edit site was admitted, and nothing at that gate read status. The
// compose nudge (gap-write path and drain observer) admits only open + armed + sited + not held. Admission now asks
// the same predicate (gap-to-feature composeEligibilitySkipReason), so a nudge never fires for a gap the picker
// cannot take and the two cannot drift.
//
// Exemptions, each for its stated reason only: an orphan / unreachable-producer gap is not compose (author_producer's
// one mint); a typecheck-class gap has tsc as its check (and the phantom-typecheck retirement downstream); a recommit
// gap carrying source_gap_id inherits its SITE after selection, so only the site is waived and it must still be armed,
// open and unheld. The last test pins that the fresh-orphan route is untouched.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { admitActionableGaps } from "../../src/resolvers/gap-to-feature.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
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

// HERMETIC VESSEL TREE. citedExistingFile and structuredTscErrorOf resolve a repos/<vessel>/... path through
// repoPathExists: MITOSIS_RUNTIME_DIR (default /vessels), then VESSELS_CLONE_ROOT (default /workspace/git/vessels).
// Both are read at call time, so pointing them at a temp fixture here grades the same cases in a container, in a
// checkout and in a bare `git archive` export: the cited file exists in the runtime fixture, the "missing" file
// exists nowhere, and the clone root is an empty dir so no real tree can answer for either.
const FIXTURE = mkdtempSync(join(tmpdir(), "admission-eligibility-"));
const SAVED_ENV = { runtime: process.env["MITOSIS_RUNTIME_DIR"], clones: process.env["VESSELS_CLONE_ROOT"] };
process.env["MITOSIS_RUNTIME_DIR"] = join(FIXTURE, "runtime");
process.env["VESSELS_CLONE_ROOT"] = join(FIXTURE, "clones");
mkdirSync(join(FIXTURE, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
writeFileSync(join(FIXTURE, "runtime", "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const fixture = 1;\n");
mkdirSync(join(FIXTURE, "clones"), { recursive: true });
afterAll(() => {
  for (const [k, v] of [["MITOSIS_RUNTIME_DIR", SAVED_ENV.runtime], ["VESSELS_CLONE_ROOT", SAVED_ENV.clones]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(FIXTURE, { recursive: true, force: true });
});

const SITE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const gap = (id: string, meta: Record<string, unknown>, status = "open") => ({
  id, category: "systematic_failure", status, summary: `admission eligibility probe ${id}`, classification_metadata: meta,
});
const admittedIds = async (gaps: Array<Record<string, unknown>>) => {
  const r = await admitActionableGaps(gaps);
  return { ids: r.admitted.map((g) => String(g.id)), excluded: r.excluded };
};

describe("admitActionableGaps — one eligibility predicate with the compose nudge", () => {
  it("CONTROL: an open class2 gap with an existing edit site is admitted", async () => {
    const { ids } = await admittedIds([gap("elig-armed-sited", { falsifier: "class2", edit_site: SITE })]);
    expect(ids).toEqual(["elig-armed-sited"]);
  });

  it("an unarmed (falsifier none) gap with an edit site is not admitted; reason needs_information", async () => {
    const { ids, excluded } = await admittedIds([
      gap("elig-unarmed-sited", { falsifier: "none", edit_site: SITE }),
      gap("elig-armed-sited-2", { falsifier: "class1", edit_site: SITE }),
    ]);
    expect(ids).not.toContain("elig-unarmed-sited");
    expect(excluded.find((e) => e.id === "elig-unarmed-sited")?.reason ?? "").toContain("needs_information(falsifier=none");
  });

  it("an armed gap with no edit site is not admitted, not even by the starved-lane fail-open", async () => {
    const { ids, excluded } = await admittedIds([gap("elig-armed-siteless", { falsifier: "class2" })]);
    expect(ids).toEqual([]);
    expect(excluded.find((e) => e.id === "elig-armed-siteless")?.reason ?? "").toContain("no_edit_site");
  });

  it("a closed armed gap with an edit site is not admitted", async () => {
    const { ids, excluded } = await admittedIds([gap("elig-closed", { falsifier: "class2", edit_site: SITE }, "closed")]);
    expect(ids).toEqual([]);
    expect(excluded.find((e) => e.id === "elig-closed")?.reason ?? "").toContain("not_open");
  });

  it("a held armed sited gap is not admitted (operator_hold, parking disposition, awaiting its verdict)", async () => {
    const { ids, excluded } = await admittedIds([
      gap("elig-hold", { falsifier: "class2", edit_site: SITE, operator_hold: true }),
      gap("elig-parked", { falsifier: "class2", edit_site: SITE, disposition: "needs_information" }),
      gap("elig-pending", { falsifier: "class2", edit_site: SITE, disposition: "pending_verification" }),
    ]);
    expect(ids).toEqual([]);
    const reason = (id: string) => excluded.find((e) => e.id === id)?.reason;
    expect(reason("elig-hold")).toBe("operator_hold");
    expect(reason("elig-parked")).toBe("disposition(needs_information)");
    expect(reason("elig-pending")).toBe("disposition(pending_verification)");
  });

  it("an armed falsifier written as {class} counts as armed, as the nudge reads it", async () => {
    const { ids } = await admittedIds([gap("elig-object-falsifier", { falsifier: { class: "class2" }, edit_site: SITE })]);
    expect(ids).toEqual(["elig-object-falsifier"]);
  });

  it("a recommit child (source_gap_id) is held to the same predicate: unarmed and sited is not admitted", async () => {
    // Measured 2026-10-03: 452 open recommit children were sited and unarmed, and the old gate admitted every one.
    // The recommit exemption's reason is the SITE (inherited after selection), so only the site is waived.
    const { ids } = await admittedIds([gap("recommit-elig-unarmed", { falsifier: "none", edit_site: SITE, source_gap_id: "elig-parent" })]);
    expect(ids).toEqual([]);
  });

  it("a recommit child (source_gap_id) that is armed but siteless keeps its route: its site is inherited after selection", async () => {
    const { ids } = await admittedIds([gap("recommit-elig-armed-siteless", { falsifier: "class2", source_gap_id: "elig-parent" })]);
    expect(ids).toEqual(["recommit-elig-armed-siteless"]);
  });

  it("route carve-out unchanged: a fresh orphaned-capability gap (no site, unarmed) keeps its one author_producer shot", async () => {
    const { ids } = await admittedIds([{ id: "orphaned-capability-elig-probe", category: "orphaned_capability", status: "open", summary: "orphan probe", classification_metadata: { shape: "someShape", falsifier: "none" } }]);
    expect(ids).toEqual(["orphaned-capability-elig-probe"]);
  });
});

// THE TYPECHECK EXEMPTION NEEDS A STRUCTURED TSC ERROR. typecheckClassOf matched any TSxxxx token in a gap's id or
// summary, so a failure lesson or a narrative mentioning a TS code exempted the gap from the eligibility predicate:
// 225 live open gaps passed this gate on that exemption alone (2026-10-03). The exemption now requires
// classification_metadata.tsc_error {code: "TSnnnn", file} whose file exists in the vessel tree grounding reads
// (MITOSIS_RUNTIME_DIR), and nothing else. The typecheck runner is injected so no real tsc runs.
describe("admitActionableGaps — the typecheck exemption requires a structured tsc error", () => {
  const stillErrors = () => ({ ran: true, clean: false });
  const admitTc = async (gaps: Array<Record<string, unknown>>) => {
    const r = await admitActionableGaps(gaps, { typecheckRunner: stillErrors });
    return { ids: r.admitted.map((g) => String(g.id)), excluded: r.excluded };
  };

  it("a summary that mentions TS2345 with no structured tsc error is held to the predicate (unarmed, sited: excluded)", async () => {
    const g = { id: "tc-substring-sited", category: "systematic_failure", status: "open", summary: `TS2345 at ${SITE}:10`, classification_metadata: { falsifier: "none", edit_site: SITE } };
    const { ids, excluded } = await admitTc([g]);
    expect(ids).toEqual([]);
    expect(excluded.find((e) => e.id === "tc-substring-sited")?.reason ?? "").toContain("needs_information(falsifier=none");
  });

  it("an id carrying _ts2322_ with no structured tsc error is held to the predicate (unarmed, siteless: excluded)", async () => {
    const g = { id: "detect-unclassified_failure_development_vessel_src_index_l10_ts2322_variant", category: "systematic_failure", status: "open", summary: "recurring failure", classification_metadata: { falsifier: "none" } };
    const { ids } = await admitTc([g]);
    expect(ids).toEqual([]);
  });

  it("CONTROL: a structured tsc_error at an existing file is exempt (unarmed, no edit_site, still erroring: admitted)", async () => {
    const g = { id: "tc-structured", category: "typecheck_error", status: "open", summary: "a compile error", classification_metadata: { falsifier: "none", tsc_error: { code: "TS2345", file: SITE, line: 10 } } };
    const { ids } = await admitTc([g]);
    expect(ids).toEqual(["tc-structured"]);
  });

  it("a structured tsc_error whose file does not exist is not exempt", async () => {
    const g = { id: "tc-structured-missing-file", category: "typecheck_error", status: "open", summary: "a compile error", classification_metadata: { falsifier: "none", tsc_error: { code: "TS2345", file: "repos/development-vessel/src/no-such-file.ts" } } };
    const { ids } = await admitTc([g]);
    expect(ids).toEqual([]);
  });

  it("a structured tsc_error whose code is not a TS code is not exempt", async () => {
    const g = { id: "tc-structured-bad-code", category: "typecheck_error", status: "open", summary: "a compile error", classification_metadata: { falsifier: "none", tsc_error: { code: "2345", file: SITE } } };
    const { ids } = await admitTc([g]);
    expect(ids).toEqual([]);
  });
});
