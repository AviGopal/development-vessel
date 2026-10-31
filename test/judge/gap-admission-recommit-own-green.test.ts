// A recommit inherits its lineage's own-green exclusion. The auto-pick excludes a gap whose own check was found GREEN
// on the parent (own_check_green_on_parent, OWN_GREEN_ADMISSION_TTL_MS), but read it only on the gap's own row. A
// recommit-<id>-<cls> child carries its source's own check, so it was admitted inside the root's window and refused at
// compose for the same green. Admission now walks the child's lineage for a fresh marker.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-rcg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR };
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
writeFileSync(join(ROOT, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
writeFileSync(join(ROOT, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
mkdirSync(join(ROOT, "proposals"), { recursive: true });

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

const modAdmission = await import("../../src/judge/gap-admission.js") as Record<string, unknown>;
const modPolicy = await import("../../src/judge/gap-policy.js") as Record<string, unknown>;
const elig = await import("../../src/judge/gap-eligibility.js") as Record<string, unknown>;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }> }>;
const TTL = elig.OWN_GREEN_ADMISSION_TTL_MS as number;

const runner = (_v: string) => ({ ran: true, clean: false });
const CHECK = { resolver: "test_suite", input: { vessel: "goal-host-vessel", test_file: "test/checks/rcg-root.check.ts" } };
function gap(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary: "fix the thing", status: "open",
    classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:1", falsifier: "class2", evidence_resolve: CHECK, ...meta },
  };
}
const ROOT_ID = "rcg-root-aaaaaaaa";
const green = (agoMs = 60_000) => ({ own_check_green_on_parent: { at: new Date(Date.now() - agoMs).toISOString(), reason: "the gap's own check is already GREEN on the parent tree" } });
const child = (id: string, src: string) => gap(id, { re_commit: true, source_gap_id: src, root_gap_id: ROOT_ID, failure_class: "verify_failed" });
async function admit(gs: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const r = await admitActionableGaps(gs, { typecheckRunner: runner, ...extra });
  return { admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}

describe("a recommit child inherits its lineage's own_check_green_on_parent exclusion", () => {
  it("[MUST-FAIL] a recommit and a recommit-recommit of a root excluded as own_check_green_on_parent are not admitted", async () => {
    const root = gap(ROOT_ID, green());
    const c1 = child(`recommit-${ROOT_ID}-verify_failed`, ROOT_ID);
    const c2 = child(`recommit-recommit-${ROOT_ID}-verify_failed-verify_failed`, String(c1.id));
    const { admittedIds, reasonOf } = await admit([root, c1, c2]);
    expect(reasonOf(ROOT_ID)).toBe("own_check_green_on_parent");
    expect(admittedIds).not.toContain(c1.id);
    expect(admittedIds).not.toContain(c2.id);
    expect(reasonOf(String(c1.id))).toBe(`own_check_green_on_parent(lineage ${ROOT_ID})`);
    expect(reasonOf(String(c2.id))).toMatch(/^own_check_green_on_parent\(lineage /);
  });

  it("the ancestor is found in the whole-store lineage index when the candidate set does not carry it", async () => {
    const root = gap(ROOT_ID, green());
    const c1 = child(`recommit-${ROOT_ID}-verify_failed`, ROOT_ID);
    const { admittedIds, reasonOf } = await admit([c1], { lineageIndex: new Map([[ROOT_ID, root]]) });
    expect(admittedIds).not.toContain(c1.id);
    expect(reasonOf(String(c1.id))).toBe(`own_check_green_on_parent(lineage ${ROOT_ID})`);
  });

  it("CONTROL: a recommit whose parent is excluded for a DIFFERENT reason is admitted as today", async () => {
    const root = gap(ROOT_ID, { disposition: "needs_information" });
    const c1 = child(`recommit-${ROOT_ID}-verify_failed`, ROOT_ID);
    const { admittedIds, reasonOf } = await admit([root, c1]);
    expect(reasonOf(ROOT_ID)).toBe("disposition(needs_information)");
    expect(admittedIds).toContain(c1.id);
  });

  it("CONTROL: an ancestor marker older than the TTL does not exclude the recommit", async () => {
    const root = gap(ROOT_ID, green(TTL + 60_000));
    const c1 = child(`recommit-${ROOT_ID}-verify_failed`, ROOT_ID);
    const { admittedIds } = await admit([root, c1]);
    expect(admittedIds).toContain(ROOT_ID);
    expect(admittedIds).toContain(c1.id);
  });

  it("CONTROL: a non-recommit row is unchanged (admitted plain; excluded on its own fresh marker; a -narrowed child keeps its own read)", async () => {
    const plain = gap("rcg-plain-bbbbbbbb", {});
    const own = gap("rcg-own-cccccccc", green());
    const root = gap(ROOT_ID, green());
    const narrowed = gap(`${ROOT_ID}-narrowed`, { parent_gap_id: ROOT_ID });
    const { admittedIds, reasonOf } = await admit([plain, own, root, narrowed]);
    expect(admittedIds).toContain(plain.id);
    expect(reasonOf(String(own.id))).toBe("own_check_green_on_parent");
    expect(admittedIds).toContain(narrowed.id);
  });
});
