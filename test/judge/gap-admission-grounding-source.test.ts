// WHAT GROUNDS AN ADMITTED GAP. Admission admits a sited gap only when it names an existing repos/<vessel>/….(ts|tsx) file
// (citedExistingFile); one that names none is deferred as no_groundable_target. A live row whose edit_site is a real
// file followed by a note ("repos/llm-resolver-vessel/src/index.ts (policy handler outcome recording)") failed the
// extension test and read as naming none. The note after the first file token is cut; a directory, or a file that does
// not exist, still grounds nothing.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-ground-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT, PROPOSALS_DIR: process.env.PROPOSALS_DIR, GAP_STORE_ENDPOINT: process.env.GAP_STORE_ENDPOINT };
const STORE = "http://127.0.0.1:9/v2/impulses/resolve";
process.env.GAP_STORE_ENDPOINT = STORE;
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.VESSELS_CLONE_ROOT = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
for (const f of ["llm-resolver-vessel/src/index.ts", "activity-api/src/lib/posterior-update.ts", "activity-api/src/lib/failure-class.ts", "goal-host-vessel/src/index.ts"]) {
  mkdirSync(join(ROOT, f, ".."), { recursive: true });
  writeFileSync(join(ROOT, f), "export const x = 1;\n");
}
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
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0 } });
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap_write") return Response.json({ shape: "substrateGap", body: { written: true } });
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
const citedExistingFile = modAdmission.citedExistingFile as (g: Record<string, unknown>) => string | null;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }> }>;

const HEAD = "c".repeat(40);
const runner = (_v: string) => ({ ran: true, clean: false });
function gap(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary: "a caller fault is graded as a model failure", status: "open", detected_at: "2026-01-01T00:00:00Z",
    classification_metadata: { falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "llm-resolver-vessel", test_file: "src/x.test.ts", only_tests: ["x > y"] }, zero_field: "requested_not_passing" }, ...meta },
  };
}
// A plainly sited sibling in every pass, so admission's fail-open (nothing groundable: admit the ungroundable) never
// decides a row under test.
const SIBLING = () => gap("ground-sibling", { edit_site: "repos/goal-host-vessel/src/index.ts:1" });
async function admit(gs: Record<string, unknown>[]) {
  const r = await admitActionableGaps([...gs, SIBLING()], { typecheckRunner: runner, baseShaOf: () => HEAD });
  return { r, admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}

const PAREN = "repos/llm-resolver-vessel/src/index.ts (policy handler outcome recording)";
const DIR = "repos/activity-api/src (computeDeltas, failureClassOf, propagateCreditAlongChain)";

describe("an edit_site naming a real file followed by a note grounds the gap", () => {
  it("MUST-FAIL a trailing parenthetical after the file token is cut: citedExistingFile names the file", () => {
    expect(citedExistingFile(gap("ground-paren", { edit_site: PAREN }))).toBe("repos/llm-resolver-vessel/src/index.ts");
  });

  it("MUST-FAIL the parenthetical row is admitted, not deferred as no_groundable_target", async () => {
    const { admittedIds, reasonOf } = await admit([gap("ground-paren-adm", { edit_site: PAREN })]);
    expect(reasonOf("ground-paren-adm")).toBeUndefined();
    expect(admittedIds).toContain("ground-paren-adm");
  });

  it("trailing prose after a colon is cut too, and today's :line / :symbol strip still applies", () => {
    expect(citedExistingFile(gap("ground-prose", { edit_site: "repos/llm-resolver-vessel/src/index.ts: where the outcome is recorded" }))).toBe("repos/llm-resolver-vessel/src/index.ts");
    expect(citedExistingFile(gap("ground-line", { edit_site: "repos/llm-resolver-vessel/src/index.ts:42" }))).toBe("repos/llm-resolver-vessel/src/index.ts");
    expect(citedExistingFile(gap("ground-sym", { edit_site: "repos/llm-resolver-vessel/src/index.ts:recordArmOutcome (the record branch)" }))).toBe("repos/llm-resolver-vessel/src/index.ts");
  });
});

describe("CONTROLS: the cut grounds nothing that is not an existing file", () => {
  it("CONTROL a directory with a parenthetical is still not grounded, and is deferred as no_groundable_target", async () => {
    expect(citedExistingFile(gap("ground-dir", { edit_site: DIR }))).toBeNull();
    const { admittedIds, reasonOf } = await admit([gap("ground-dir-adm", { edit_site: DIR })]);
    expect(admittedIds).not.toContain("ground-dir-adm");
    expect(reasonOf("ground-dir-adm")).toBe("no_groundable_target");
    expect(admittedIds).toContain("ground-sibling");
  });

  it("CONTROL a nonexistent .ts followed by a note is still refused", async () => {
    expect(citedExistingFile(gap("ground-missing", { edit_site: "repos/llm-resolver-vessel/src/missing.ts (policy handler)" }))).toBeNull();
    const { reasonOf } = await admit([gap("ground-missing-adm", { edit_site: "repos/llm-resolver-vessel/src/missing.ts (policy handler)" })]);
    expect(reasonOf("ground-missing-adm")).toBe("no_groundable_target");
  });

  it("CONTROL a file token that only starts like .ts (index.ts.bak) does not ground", () => {
    writeFileSync(join(ROOT, "llm-resolver-vessel/src/index.ts.bak"), "x\n");
    expect(citedExistingFile(gap("ground-bak", { edit_site: "repos/llm-resolver-vessel/src/index.ts.bak (old copy)" }))).toBeNull();
  });
});

// A gap whose edit_site names no file (a directory with function names) but whose own check's baseline, measured at the
// vessel's current origin/dev, is a code-reachable red: its call_path names the files the failing tests run through.
// One of them existing grounds the gap, and the pass record says so (grounded_by). Only a red_code_reachable reading
// counts, only an existing file on it, and only when the edit_site does not ground the gap by itself.
const g2f = await import("../../src/resolvers/gap-to-feature.js") as Record<string, unknown>;
const admitWithSource = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }>; groundedBy?: Record<string, string> }>;
const CF_TF = "src/lib/caller-fault-abstains.test.ts";
const CF_TITLES = ["MUST-FAIL — the caller fault is classified and attributed to the calling step > failureClassOf names malformed_request, at the task that sent the request"];
const CALL_PATH = [{ path: "repos/activity-api/src/lib/posterior-update.ts", fn: "computeDeltas", line: 743 }, { path: "repos/activity-api/src/lib/failure-class.ts", fn: "failureClassOf", line: 151 }];
const reading = (verdict: string, call_path: unknown[] = CALL_PATH, base_sha = HEAD) => ({
  gap_id: "credit-writers", vessel: "activity-api", test_file: CF_TF, only_tests: CF_TITLES, base_sha, verdict, red: [], failing: [], expect_count: 2,
  call_path, call_path_source: "static", env_signals: [], env_policy: "policy", dispatch_id: "disp-cw", measured_at: "2026-01-01T00:00:00Z",
});
function creditRow(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary: "credit writers grade caller-fault outcomes at leaf and ancestors", status: "open", detected_at: "2026-01-01T00:00:00Z",
    classification_metadata: { edit_site: DIR, falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "activity-api", test_file: CF_TF, only_tests: CF_TITLES }, zero_field: "requested_not_passing" }, ...meta },
  };
}
async function admitSourced(gs: Record<string, unknown>[], head: string = HEAD) {
  const r = await admitWithSource([...gs, SIBLING()], { typecheckRunner: runner, baseShaOf: () => head });
  return { r, admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason, by: (id: string) => r.groundedBy?.[id] };
}

describe("a code-reachable own-check baseline's call path grounds a gap its edit_site does not", () => {
  it("MUST-FAIL the credit-writers row shape is admitted, not deferred as no_groundable_target", async () => {
    const { admittedIds, reasonOf } = await admitSourced([creditRow("ground-cw", { own_check_baseline: reading("red_code_reachable") })]);
    expect(reasonOf("ground-cw")).toBeUndefined();
    expect(admittedIds).toContain("ground-cw");
  });

  it("MUST-FAIL the admission result and the pass record name own_check_baseline_call_path; a sited sibling names edit_site", async () => {
    const { r, by } = await admitSourced([creditRow("ground-cw-rec", { own_check_baseline: reading("red_code_reachable") })]);
    expect(by("ground-cw-rec")).toBe("own_check_baseline_call_path");
    expect(by("ground-sibling")).toBe("edit_site");
    const body = (g2f.admissionPassBody as (p: unknown) => Record<string, any>)({ node: "n", candidates: 2, admitted: r.admitted, excluded: r.excluded, floored: [], groundedBy: r.groundedBy });
    const entry = (id: string) => (body.admitted as Array<{ id: string; grounded_by?: string }>).find((a) => a.id === id);
    expect(entry("ground-cw-rec")?.grounded_by).toBe("own_check_baseline_call_path");
    expect(entry("ground-sibling")?.grounded_by).toBe("edit_site");
  });

  it("an edit_site that grounds by itself is grounded by it, whatever the reading", async () => {
    const { by } = await admitSourced([creditRow("ground-cw-site", { edit_site: "repos/activity-api/src/lib/failure-class.ts", own_check_baseline: reading("red_code_reachable") })]);
    expect(by("ground-cw-site")).toBe("edit_site");
  });
});

describe("CONTROLS: nothing else on a reading grounds a gap", () => {
  it("CONTROL a call_path naming only a nonexistent file does not ground", async () => {
    const { admittedIds, reasonOf } = await admitSourced([creditRow("ground-cw-missing", { own_check_baseline: reading("red_code_reachable", [{ path: "repos/activity-api/src/lib/missing.ts", fn: "computeDeltas", line: 1 }]) })]);
    expect(admittedIds).not.toContain("ground-cw-missing");
    expect(reasonOf("ground-cw-missing")).toBe("no_groundable_target");
  });

  it("CONTROL a green_at_parent reading with a call_path does not ground (admission excludes it on the reading)", async () => {
    const { admittedIds, reasonOf, by } = await admitSourced([creditRow("ground-cw-green", { own_check_baseline: reading("green_at_parent") })]);
    expect(admittedIds).not.toContain("ground-cw-green");
    expect(reasonOf("ground-cw-green")).toBe(`own_check_baseline_green_at_parent(${HEAD.slice(0, 12)})`);
    expect(by("ground-cw-green")).toBeUndefined();
  });

  it("CONTROL an unrunnable reading with a call_path, and a code-reachable one at another sha, do not ground", async () => {
    const un = await admitSourced([creditRow("ground-cw-unrun", { own_check_baseline: reading("unrunnable") })]);
    expect(un.reasonOf("ground-cw-unrun")).toBe("no_groundable_target");
    const moved = await admitSourced([creditRow("ground-cw-moved", { own_check_baseline: reading("red_code_reachable") })], "d".repeat(40));
    expect(moved.reasonOf("ground-cw-moved")).toBe("no_groundable_target");
  });

  it("CONTROL a row with no reading is unchanged: deferred as no_groundable_target, grounded by nothing", async () => {
    const { reasonOf, by } = await admitSourced([creditRow("ground-cw-none", {})]);
    expect(reasonOf("ground-cw-none")).toBe("no_groundable_target");
    expect(by("ground-cw-none")).toBeUndefined();
  });
});

// THE SAME RULE FOR THE SCOPE MATCH. A free-text site naming a lane-core file ("<excluded file> (a note)") never equalled
// the excluded entry, so it passed the autonomy-scope check; once the grounding read the file through the note, such a
// row was admitted as lane work. The scope match now also reads the file the site names (gap-policy editSitePath, the
// one rule citedExistingFile uses). Tightening only: what the match refused before it still refuses, by the same entry.
// A code-reachable call path grounds only when the scope admits every existing file on it: the red tests run through
// each one, so one excluded file (first or later) refuses the row by scope, whatever in-scope file follows.
const autonomyScopeExcludes = modPolicy.autonomyScopeExcludes as (s: unknown, p: string) => string | null;
const editSitePath = modPolicy.editSitePath as ((s: string) => string) | undefined;
const EXCLUDED = ["repos/llm-resolver-vessel/src/index.ts", "repos/activity-api/src/lib/posterior-update.ts", "repos/goal-host-vessel/test/ratchet/"];
const SCOPE = { excluded: EXCLUDED, readable: true, reason: "fixture scope", exceptions: [] };
const setScopeDeps = modPolicy.__setAutonomyScopeDepsForTests as (d: unknown) => void;
async function admitUnderScope(gs: Record<string, unknown>[], scope: Record<string, unknown> = SCOPE) {
  setScopeDeps({ live: async () => scope, boundS: () => 0, now: Date.now });
  try { return await admitSourced(gs); } finally { setScopeDeps(null); }
}

describe("the autonomy-scope match reads the file a free-text site names", () => {
  it("MUST-FAIL '<excluded file> (prose)' is refused by the entry it names", () => {
    expect(autonomyScopeExcludes(SCOPE, PAREN)).toBe("repos/llm-resolver-vessel/src/index.ts");
    expect(autonomyScopeExcludes(SCOPE, "repos/llm-resolver-vessel/src/index.ts: where the outcome is recorded")).toBe("repos/llm-resolver-vessel/src/index.ts");
  });

  it("MUST-FAIL admission refuses the paren row by scope, not admitting it as lane work", async () => {
    const { admittedIds, reasonOf } = await admitUnderScope([gap("scope-paren-adm", { edit_site: PAREN })]);
    expect(admittedIds).not.toContain("scope-paren-adm");
    expect(reasonOf("scope-paren-adm")).toBe("autonomy_scope(repos/llm-resolver-vessel/src/index.ts)");
  });

  it("CONTROL a call path whose only existing files are excluded is refused by scope, as before", async () => {
    const lane = await admitUnderScope([creditRow("scope-cw-lane", { own_check_baseline: reading("red_code_reachable", [CALL_PATH[0]!]) })]);
    expect(lane.admittedIds).not.toContain("scope-cw-lane");
    expect(lane.reasonOf("scope-cw-lane")).toBe("autonomy_scope(own_check_baseline call_path repos/activity-api/src/lib/posterior-update.ts)");
  });

  // The live credit-writers shape: its edit_site names a directory, and its red check runs through posterior-update.ts
  // (excluded) and then failure-class.ts (in scope). Grounding it on failure-class.ts admitted a fix the lane cannot land.
  it("MUST-FAIL the credit-writers shape (first call-path file excluded, a later one in scope) is refused by scope, not admitted", async () => {
    const mixed = await admitUnderScope([creditRow("scope-cw-mixed", { own_check_baseline: reading("red_code_reachable") })]);
    expect(mixed.admittedIds).not.toContain("scope-cw-mixed");
    expect(mixed.by("scope-cw-mixed")).toBeUndefined();
    expect(mixed.reasonOf("scope-cw-mixed")).toBe("autonomy_scope(own_check_baseline call_path repos/activity-api/src/lib/posterior-update.ts)");
    const pick = (modAdmission.ownCheckCallPathFile as (b: unknown, x?: (p: string) => string | null) => { file: string | null } | string | null)(reading("red_code_reachable"), (p) => autonomyScopeExcludes(SCOPE, p));
    expect(typeof pick === "object" && pick !== null ? pick.file : pick).toBeNull();
  });

  it("MUST-FAIL an excluded file LATER on the call path refuses it too: the red tests run through it", async () => {
    const later = await admitUnderScope([creditRow("scope-cw-later", { own_check_baseline: reading("red_code_reachable", [CALL_PATH[1]!, CALL_PATH[0]!]) })]);
    expect(later.admittedIds).not.toContain("scope-cw-later");
    expect(later.reasonOf("scope-cw-later")).toBe("autonomy_scope(own_check_baseline call_path repos/activity-api/src/lib/posterior-update.ts)");
  });

  it("CONTROL a call path whose existing files are all in scope still grounds, on its first file", async () => {
    const open = await admitUnderScope([creditRow("scope-cw-open", { own_check_baseline: reading("red_code_reachable", [CALL_PATH[1]!, { path: "repos/activity-api/src/lib/missing.ts", fn: "f", line: 1 }]) })]);
    expect(open.admittedIds).toContain("scope-cw-open");
    expect(open.by("scope-cw-open")).toBe("own_check_baseline_call_path");
    const pick = (modAdmission.ownCheckCallPathFile as (b: unknown, x?: (p: string) => string | null) => { file: string | null })(reading("red_code_reachable", [CALL_PATH[1]!]), (p) => autonomyScopeExcludes(SCOPE, p));
    expect(pick.file).toBe("repos/activity-api/src/lib/failure-class.ts");
  });

  it("CONTROL a row grounded by its own in-scope bare edit_site is unchanged, whatever its call path names", async () => {
    const site = await admitUnderScope([creditRow("scope-cw-site", { edit_site: "repos/activity-api/src/lib/failure-class.ts", own_check_baseline: reading("red_code_reachable") })]);
    expect(site.admittedIds).toContain("scope-cw-site");
    expect(site.by("scope-cw-site")).toBe("edit_site");
  });

  it("one exported normaliser: the scope match and citedExistingFile read the same file from a site", () => {
    expect(typeof editSitePath).toBe("function");
    for (const s of [PAREN, "repos/llm-resolver-vessel/src/index.ts:42", "/vessels/llm-resolver-vessel/src/index.ts (note)"]) {
      expect(editSitePath!(s)).toBe("repos/llm-resolver-vessel/src/index.ts");
      expect(citedExistingFile(gap("scope-norm", { edit_site: s }))).toBe(editSitePath!(s));
    }
    expect(editSitePath!(DIR)).toBe(DIR);
  });
});

describe("CONTROLS: the scope match only tightens", () => {
  it("CONTROL a bare excluded path, a :line form and a path under an excluded directory are refused by the same entry as before", () => {
    expect(autonomyScopeExcludes(SCOPE, "repos/llm-resolver-vessel/src/index.ts")).toBe("repos/llm-resolver-vessel/src/index.ts");
    expect(autonomyScopeExcludes(SCOPE, "repos/llm-resolver-vessel/src/index.ts:12")).toBe("repos/llm-resolver-vessel/src/index.ts");
    expect(autonomyScopeExcludes(SCOPE, "repos/goal-host-vessel/test/ratchet/a.test.ts (a note)")).toBe("repos/goal-host-vessel/test/ratchet/");
  });

  it("CONTROL an in-scope 'path (prose)' passes the match and is admitted, grounded by its edit_site", async () => {
    expect(autonomyScopeExcludes(SCOPE, "repos/activity-api/src/lib/failure-class.ts (failureClassOf)")).toBeNull();
    const { admittedIds, by } = await admitUnderScope([gap("scope-in-adm", { edit_site: "repos/activity-api/src/lib/failure-class.ts (failureClassOf)" })]);
    expect(admittedIds).toContain("scope-in-adm");
    expect(by("scope-in-adm")).toBe("edit_site");
  });

  it("CONTROL a directory site with function names is not matched as a file, and an unreadable scope still excludes everything", () => {
    expect(autonomyScopeExcludes(SCOPE, DIR)).toBeNull();
    expect(autonomyScopeExcludes({ excluded: [], readable: false, reason: "down" }, "repos/activity-api/src/lib/failure-class.ts")).toBe("scope unreadable (down)");
  });
});
