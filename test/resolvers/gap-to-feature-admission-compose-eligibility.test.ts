// THE AUTO-PICK ADMITS ONLY WHAT THE COMPOSE NUDGE WOULD NUDGE FOR.
//
// admitActionableGaps' actionable-only gate excluded a gap only when it had NEITHER an edit site NOR a class1/class2
// falsifier: a sited gap with falsifier none was admitted (1661 of the 1961 open rows that passed this gate on the
// live store, 2026-10-03), an armed gap with no edit site was admitted, and nothing at that gate read status. The
// compose nudge (gap-write path and drain observer) admits only open + armed + sited + not held. Admission now asks
// the same predicate (gap-to-feature composeEligibilitySkipReason), so a nudge never fires for a gap the picker
// cannot take and the two cannot drift.
//
// Routes that are not compose keep their existing exemption: an orphan / unreachable-producer gap (author_producer's
// one mint), a recommit gap carrying source_gap_id (inherits its site after selection), a typecheck-class gap
// (tsc is its check). The last test pins that the fresh-orphan route is untouched.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { admitActionableGaps, __resetPolicyReadsForTests } from "../../src/resolvers/gap-to-feature.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

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

// citedExistingFile resolves under MITOSIS_RUNTIME_DIR: point it at this checkout's parent so the control's edit site
// exists on disk (as gap-to-feature-groundable-admission.test.ts does), or the control is deferred as ungroundable.
process.env["MITOSIS_RUNTIME_DIR"] = new URL("../../", import.meta.url).pathname.replace(/\/$/, "") + "/..";

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

  it("route carve-out unchanged: a fresh orphaned-capability gap (no site, unarmed) keeps its one author_producer shot", async () => {
    const { ids } = await admittedIds([{ id: "orphaned-capability-elig-probe", category: "orphaned_capability", status: "open", summary: "orphan probe", classification_metadata: { shape: "someShape", falsifier: "none" } }]);
    expect(ids).toEqual(["orphaned-capability-elig-probe"]);
  });
});
