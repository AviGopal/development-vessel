// A VESSEL-RELATIVE EDIT SITE READS WITH THE VESSEL ITS OWN ROW RECORDS. attempt-register's attempt_consequence rows were
// born with the attempt's first touched file as given ("src/index.ts"), so no reader could tell which vessel's file it
// was: admission's grounding (citedExistingFile) found no repos/<vessel>/ file, the autonomy-scope match compared a bare
// path against repo paths, and check-supply skipped the row as no_vessel. editSitePath now takes the row's metadata as
// context and prefixes such a site with the vessel the row records, and only that one: a row that records no vessel is
// read exactly as before (nothing is guessed from a basename). The writer now records the vessel and the prefixed path.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `edit-site-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT, PROPOSALS_DIR: process.env.PROPOSALS_DIR, GAP_STORE_ENDPOINT: process.env.GAP_STORE_ENDPOINT };
const STORE = "http://127.0.0.1:9/v2/impulses/resolve";
process.env.GAP_STORE_ENDPOINT = STORE;
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.VESSELS_CLONE_ROOT = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
for (const f of ["goal-host-vessel/src/index.ts", "goal-host-vessel/src/goal-file-resolution.ts", "activity-api/src/lib/failure-class.ts"]) {
  mkdirSync(join(ROOT, f, ".."), { recursive: true });
  writeFileSync(join(ROOT, f), "export const x = 1;\n");
}
mkdirSync(join(ROOT, "proposals"), { recursive: true });

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0 } });
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap_write") return Response.json({ shape: "substrateGap", body: { written: true } });
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("{}", { status: 200 });
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
const modAttempt = await import("../../src/resolvers/attempt-register.js") as Record<string, unknown>;
const editSitePath = modPolicy.editSitePath as (s: string, ctx?: { vessel?: unknown } | null) => string;
const autonomyScopeExcludes = modPolicy.autonomyScopeExcludes as (s: unknown, p: string, ctx?: { vessel?: unknown } | null) => string | null;
const citedExistingFile = modAdmission.citedExistingFile as (g: Record<string, unknown>) => string | null;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }>; groundedBy?: Record<string, string> }>;
const setScopeDeps = modPolicy.__setAutonomyScopeDepsForTests as (d: unknown) => void;

const HEAD = "c".repeat(40);
const runner = (_v: string) => ({ ran: true, clean: false });
function row(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id, category: "attempt_consequence", source: "substrate_detected", status: "open", detected_at: "2026-01-01T00:00:00Z",
    summary: "Attempt att-x landed abc and broke: a check. The landing's own gap was never recorded, so this gap carries the consequence to address.",
    classification_metadata: { attempt_id: "att-x", falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "goal-host-vessel", test_file: "test/x.test.ts", only_tests: ["x > y"] }, zero_field: "requested_not_passing" }, ...meta },
  };
}
const SIBLING = () => row("ctx-sibling", { edit_site: "repos/activity-api/src/lib/failure-class.ts" });
const OPEN = { excluded: [] as string[], readable: true, reason: "fixture scope", exceptions: [] };
const SCOPE = { excluded: ["repos/goal-host-vessel/src/goal-file-resolution.ts"], readable: true, reason: "fixture scope", exceptions: [] };
async function admit(gs: Record<string, unknown>[], scope: Record<string, unknown> = OPEN) {
  setScopeDeps({ live: async () => scope, boundS: () => 0, now: Date.now });
  try {
    const r = await admitActionableGaps([...gs, SIBLING()], { typecheckRunner: runner, baseShaOf: () => HEAD });
    return { admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason, by: (id: string) => r.groundedBy?.[id] };
  } finally { setScopeDeps(null); }
}

describe("a vessel-relative edit_site reads with the vessel its row records", () => {
  it("MUST-FAIL editSitePath with the row's vessel names repos/<vessel>/<path>", () => {
    expect(editSitePath("src/index.ts", { vessel: "goal-host-vessel" })).toBe("repos/goal-host-vessel/src/index.ts");
    expect(editSitePath("test/a.test.ts:12", { vessel: "goal-host-vessel" })).toBe("repos/goal-host-vessel/test/a.test.ts");
  });

  it("MUST-FAIL admission grounds the row on the prefixed file (citedExistingFile), not no_groundable_target", async () => {
    const g = row("ctx-ground", { edit_site: "src/index.ts", vessel: "goal-host-vessel" });
    expect(citedExistingFile(g)).toBe("repos/goal-host-vessel/src/index.ts");
    const { admittedIds, reasonOf, by } = await admit([g]);
    expect(reasonOf("ctx-ground")).toBeUndefined();
    expect(admittedIds).toContain("ctx-ground");
    expect(by("ctx-ground")).toBe("edit_site");
  });

  it("MUST-FAIL a prefixed site under an EXCLUDED scope entry is refused by scope: the prefix lets no excluded file through", async () => {
    expect(autonomyScopeExcludes(SCOPE, "src/goal-file-resolution.ts", { vessel: "goal-host-vessel" })).toBe("repos/goal-host-vessel/src/goal-file-resolution.ts");
    const { admittedIds, reasonOf } = await admit([row("ctx-excluded", { edit_site: "src/goal-file-resolution.ts", vessel: "goal-host-vessel" })], SCOPE);
    expect(admittedIds).not.toContain("ctx-excluded");
    expect(reasonOf("ctx-excluded")).toBe("autonomy_scope(repos/goal-host-vessel/src/goal-file-resolution.ts)");
  });

  it("MUST-FAIL check-supply's landable band reads the prefixed site against the scope", async () => {
    const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown>;
    const landableBandOf = supply.landableBandOf as (r: Record<string, unknown>, byId: ReadonlyMap<string, Record<string, unknown>>, s: unknown) => number;
    const ex = row("ctx-band-ex", { edit_site: "src/goal-file-resolution.ts", vessel: "goal-host-vessel" });
    const ok = row("ctx-band-ok", { edit_site: "src/index.ts", vessel: "goal-host-vessel" });
    const byId = new Map([[String(ex.id), ex], [String(ok.id), ok]]);
    expect(landableBandOf(ex, byId, SCOPE)).toBe(1);
    expect(landableBandOf(ok, byId, SCOPE)).toBe(0);
  });

  it("MUST-FAIL the writer records the vessel and the prefixed path (attemptConsequenceSite)", () => {
    const site = modAttempt.attemptConsequenceSite as (i: Record<string, unknown>) => { edit_site?: string; vessel?: string };
    expect(typeof site).toBe("function");
    expect(site({ repo: "/workspace/git/vessels/goal-host-vessel", touched_files: ["src/index.ts", "src/b.ts"] })).toEqual({ edit_site: "repos/goal-host-vessel/src/index.ts", vessel: "goal-host-vessel" });
    expect(site({ repo: "/workspace/repos/goal-host-vessel/", touched_files: ["src/fixtures/a.json"] })).toEqual({ edit_site: "repos/goal-host-vessel/src/fixtures/a.json", vessel: "goal-host-vessel" });
    // A repo path is kept as given, and with no repo nothing is prefixed (no vessel is guessed).
    expect(site({ repo: "/workspace/git/vessels/goal-host-vessel", touched_files: ["repos/goal-host-vessel/src/index.ts"] })).toEqual({ edit_site: "repos/goal-host-vessel/src/index.ts", vessel: "goal-host-vessel" });
    expect(site({ touched_files: ["src/index.ts"] })).toEqual({ edit_site: "src/index.ts" });
  });
});

describe("CONTROLS: no recorded vessel, no prefix; every reader without context unchanged", () => {
  it("CONTROL the same row with no recorded vessel stays unprefixed and grounds nothing", async () => {
    expect(editSitePath("src/index.ts", {})).toBe("src/index.ts");
    expect(editSitePath("src/index.ts", null)).toBe("src/index.ts");
    expect(editSitePath("src/index.ts", { vessel: "../x" })).toBe("src/index.ts");
    const g = row("ctx-none", { edit_site: "src/index.ts" });
    expect(citedExistingFile(g)).toBeNull();
    const { admittedIds, reasonOf } = await admit([g]);
    expect(admittedIds).not.toContain("ctx-none");
    expect(reasonOf("ctx-none")).toBe("no_groundable_target");
  });

  it("CONTROL an already repo-relative site is unchanged by the context, and no-context reads are as before", () => {
    for (const s of ["repos/activity-api/src/lib/failure-class.ts", "repos/activity-api/src/lib/failure-class.ts:42", "scripts/substrate/substrate-pull-sync.sh", "repos/activity-api/src (computeDeltas)"]) {
      expect(editSitePath(s, { vessel: "goal-host-vessel" })).toBe(editSitePath(s));
    }
    expect(editSitePath("src/index.ts")).toBe("src/index.ts");
    expect(editSitePath("goal-host-vessel/src/index.ts")).toBe("repos/goal-host-vessel/src/index.ts");
    expect(autonomyScopeExcludes(SCOPE, "src/goal-file-resolution.ts")).toBeNull();
    expect(autonomyScopeExcludes(SCOPE, "repos/goal-host-vessel/src/goal-file-resolution.ts")).toBe("repos/goal-host-vessel/src/goal-file-resolution.ts");
  });
});
