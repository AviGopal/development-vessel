// A TIGHTENING HOLD MUST NOT BLOCK THE REPAIR OF ITS OWN REGRESSION (scope earn-in, qa ruling 10-05).
//
// The evaluator adds a file with an open, unreverted regression to autonomyScope excluded_paths with a TTL hold
// (tightening_holds). Measured live 10-05: the hold on goal-target-inference.ts (regressed by 39bef90c) also made
// ineligible the gaps whose job is to repair that regression. The hold now carries the regression's lineage
// (lineage_roots: the evidence gap ids; lineage_checks: their own test_suite checks), and admission plus the compose
// floor exempt a gap in that lineage: the evidence gap, its -narrowed / -step-N / -cN / recommit- descendants
// (parent_gap_id / root_gap_id / source_gap_id), and any gap whose own check names a regressing check. An unrelated
// gap on the same file is still refused autonomy_scope, a hold with no lineage exempts nothing, and only the held
// entry is exempted.
//
// Driven through the real scope reader and the real admission: discovery through the vessel's own seam
// (__setDiscoveryForTests), the pool through globalThis.fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `scope-hold-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fAdmission = await import("../../src/judge/gap-admission.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { __setDiscoveryForTests, __resetDiscoveryForTests } = await import("../../src/config.js");
const { admitActionableGaps } = g2fAdmission;
const { autonomyScope, autonomyScopeFloor, __resetPolicyReadsForTests } = g2fPolicy;

type Row = Record<string, unknown>;
const originalFetch = globalThis.fetch;
const POOL = "http://node-a:18090/v2/impulses/resolve";
let poolRecords: Row[] = [];
function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      const vessels = [{ vesselId: "development-vessel-local", endpoint: "http://node-a:18090", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
    }
    if (url === POOL && body?.impulse?.type === "poolImpulse") return Response.json({ body: { impulses: poolRecords.filter((r) => r["shape"] === body.impulse.shape) } });
    return Response.json({});
  }) as unknown as typeof fetch;
}

const CORE = "repos/goal-host-vessel/src/index.ts";
const HELD = "repos/goal-host-vessel/src/goal-target-inference.ts";
const HELD_BARE = "repos/goal-host-vessel/src/goal-target-inference-bare.ts";
const ROOT_GAP = "goal-target-inference-rewrote-a-repo-relative-path";
const CHECK = { file: "test/goal-target-inference.test.ts", title: "keeps a repo-relative path as given" };
const scopeRecord = () => ({
  shape: "autonomyScope", updated_at: "2026-10-05T17:26:00Z",
  body: {
    excluded_paths: [CORE, HELD, HELD_BARE],
    tightening_holds: [
      { path: HELD, expires_at: "2026-10-08T17:26:00Z", by: "scope_earn_in_apply", lineage_roots: [ROOT_GAP], lineage_checks: [`${CHECK.file}|${CHECK.title}`] },
      // A hold whose evidence named no gap: it exempts nothing.
      { path: HELD_BARE, expires_at: "2026-10-08T17:26:00Z", by: "scope_earn_in_apply", lineage_roots: [], lineage_checks: [] },
    ],
  },
  attested: { by: "evaluator", evaluator: "scope_earn_in_apply", key_id: null, at: "2026-10-05T17:26:00Z" },
});
const gap = (id: string, site: string, meta: Row = {}): Row => ({
  id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id}`,
  classification_metadata: { edit_site: site, falsifier: "class1", ...meta },
});
const ownCheck = (title: string, file = CHECK.file): Row => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/goal-host-vessel", test_file: file, only_tests: [title] } } });

let logSpy: ReturnType<typeof spyOn> | null = null;
beforeAll(() => { mkdirSync(ROOT, { recursive: true }); });
beforeEach(() => {
  setSystemTime(new Date("2026-10-05T18:00:00Z"));
  __resetPolicyReadsForTests();
  // The pool producer, through the vessel's own discovery seam (independent of the loaded ias-executor-ts dist).
  __setDiscoveryForTests({
    lookup: async (shape: string) => ({ ok: true, shape, cached: false, producers: [{ id: "development-vessel-local", resolveEndpoint: POOL, origin: "local" }] }),
    describe: (r: { shape?: string }) => `${String(r.shape)} fixture producer`,
    failureBackoffMs: 2_000,
  } as never);
  poolRecords = [scopeRecord()];
  install();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = originalFetch; setSystemTime(); logSpy?.mockRestore(); logSpy = null; __resetDiscoveryForTests(); });
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

async function admit(cands: Row[]): Promise<{ scopeRefused: string[]; reasons: Record<string, string> }> {
  const { excluded } = await admitActionableGaps(cands, { typecheckRunner: () => ({ ran: false, clean: false }) });
  const reasons = Object.fromEntries(excluded.map((e) => [e.id, e.reason]));
  return { scopeRefused: excluded.filter((e) => e.reason.startsWith("autonomy_scope")).map((e) => e.id).sort(), reasons };
}

describe("a tightening hold exempts its own regression's lineage (must-fail at base)", () => {
  it("the evidence gap and its narrowed, step, -cN and recommit descendants stay eligible under the hold", async () => {
    const lineage = [
      gap(ROOT_GAP, HELD),
      gap(`${ROOT_GAP}-narrowed`, HELD, { parent_gap_id: ROOT_GAP }),
      gap(`${ROOT_GAP}-step-2`, HELD, { parent_gap_id: ROOT_GAP }),
      gap(`${ROOT_GAP}-c3`, HELD),
      gap(`recommit-${ROOT_GAP}-verify_failed`, HELD, { re_commit: true, source_gap_id: ROOT_GAP }),
      gap("route-edit-a1b2c3d4", HELD, { root_gap_id: ROOT_GAP }),
    ];
    const { scopeRefused } = await admit(lineage);
    expect(scopeRefused).toEqual([]);
  });

  it("a gap whose own check names the regressing check stays eligible, whatever its id", async () => {
    const { scopeRefused } = await admit([gap("unrelated-looking-id", HELD, ownCheck(CHECK.title))]);
    expect(scopeRefused).toEqual([]);
  });

  it("the compose floor does not withhold a lineage repair on the held file, and still withholds anything else", async () => {
    const scope = await autonomyScope();
    expect(scope.readable).toBe(true);
    expect(autonomyScopeFloor(scope, [HELD], gap(`${ROOT_GAP}-narrowed`, HELD, { parent_gap_id: ROOT_GAP })).hits).toEqual([]);
    expect(autonomyScopeFloor(scope, [HELD, CORE], gap(ROOT_GAP, HELD)).hits).toEqual([CORE]);
    expect(autonomyScopeFloor(scope, [HELD], gap("other-gap", HELD)).hits).toEqual([HELD]);
  });
});

describe("the hold still holds everything else (controls: green at base)", () => {
  it("an unrelated gap on the same file is refused autonomy_scope", async () => {
    const { reasons } = await admit([gap("some-other-defect-in-inference", HELD, ownCheck("an unrelated test"))]);
    expect(reasons["some-other-defect-in-inference"]).toBe(`autonomy_scope(${HELD})`);
  });

  it("a hold with no evidence gap exempts nothing, even a gap of the same lineage name", async () => {
    const { reasons } = await admit([gap(ROOT_GAP, HELD_BARE), gap(`${ROOT_GAP}-narrowed`, HELD_BARE, { parent_gap_id: ROOT_GAP })]);
    expect(reasons[ROOT_GAP]).toBe(`autonomy_scope(${HELD_BARE})`);
    expect(reasons[`${ROOT_GAP}-narrowed`]).toBe(`autonomy_scope(${HELD_BARE})`);
  });

  it("a lineage gap on a path excluded by a plain (non-hold) entry is still refused", async () => {
    const { reasons } = await admit([gap(ROOT_GAP, CORE)]);
    expect(reasons[ROOT_GAP]).toBe(`autonomy_scope(${CORE})`);
  });
});
