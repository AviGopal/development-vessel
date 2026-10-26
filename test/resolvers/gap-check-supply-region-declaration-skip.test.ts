// A TOKEN ANCHOR'S DECLARATION OCCURRENCES ARE SKIPPED, NOT DISQUALIFYING (qa, 2026-10-24). A name's own declaration
// (its function, const or type) is not the code that uses it: replacing a declaration breaks its references and
// measures nothing, and nulling the whole anchor for it left 40d50487's and 84460a91's rows with no region. Now only a
// token's non-declaration occurrences count toward 1 to 5, and only those are replaced, together. A text anchor keeps
// the rule (an observed output inside a declaration is no region). A row with no region records why on region_gate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-declskip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SELF_RESOLVE_ENDPOINT"] = "http://self.test/v2/impulses/resolve";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");

const CDB = { vessel: "fixture-cdb", siteRel: "src/routes/impulses.ts" };
const RIBO = { vessel: "fixture-ribo", siteRel: "src/replay-observer.ts" };
const TREES: Record<string, Record<string, string>> = {
  [CDB.vessel]: { [CDB.siteRel]: fixture("concept-db-impulses.extract-78b70967.ts.txt"), "src/routes/hono-standin.ts": fixture("concept-db-hono-standin.ts.txt") },
  [RIBO.vessel]: { [RIBO.siteRel]: fixture("ribosome-replay-observer.44abf5e.ts.txt") },
};
// The rows' own evidence (their summaries, cut where the anchor the check goal was built on has been said).
const CDB_SUMMARY = "concept-db advertised concept_delete_write without serving it (step 1(c) un-advertises it, together with retire and supersede). Implementing it is a NEW write capability. It handles concept_delete_write by returning 401 without a JWT (the same rule as REST DELETE /concepts/:id), 400 without concept_id, and otherwise calling the org-scoped deleteConcept. | STILL ADVERTISED. SUPPORTED_SHAPES (src/routes/impulses.ts ~:63-80) still lists concept_delete_write, concept_retire_write and concept_supersede_write. The resolver case at ~:713-717 throws \"not yet implemented\" for all three.";
const RIBO_SUMMARY = "Repair needed (judge calibration on the learning plane): ribosome's replay-observer (ribosome-vessel src/replay-observer.ts ~232-238, `buildRelevancePayload`: execution_succeeded = judgement.score >= 0.5 on SUCCESSFUL traces it re-judges) wrote 22,511 impulse-relevance rows, 97.7% of them at 0.0, i.e. the replay judge scores < 0.5 on nearly every successful execution it re-judges.";
const RIBO_REGION = "if (needed.length === 0) return true";
// The row's control: the fixed behaviour (an authenticated delete for the caller's org succeeds), through the request
// that reaches the region; replacing the stub's throw moves it (500 to 200).
const CHECK_REACHES = `import { describe, it, expect } from "bun:test";\nimport * as mod from "../../src/routes/impulses";\n\ndescribe("impulse shape: concept_delete_write", () => {\n  it("an authenticated delete for the caller's org succeeds", async () => {\n    const req = new Request("http://localhost/resolve", {\n      method: "POST",\n      headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" },\n      body: JSON.stringify({ pointer: { type: "concept_delete_write", concept_id: "concept_any_id" } }),\n    });\n    const res = await mod.impulses.fetch(req);\n    expect(res.status).toBe(200);\n  });\n});\n`;

// THROWS UNDER THE MUTANT: red on the stub's message (an assertion), but with the throw replaced the body has no
// message and the check throws instead of asserting, so the region mutant run measures nothing.
const CHECK_THROWS_UNDER_MUTANT = CHECK_REACHES.replace("an authenticated delete for the caller's org succeeds", "an authenticated delete answers with no error message").replace("expect(res.status).toBe(200);", "const body: any = await res.json();\n    expect(body.message.length).toBe(0);");
// libp2p-federation-transport 84460a91's row (the-federation-egress-hop-has-no-deadline-…), its evidence as the live row carries it.
const FED_SUMMARY = "From code: an egress resolve over the overlay has no deadline of its own. scripts/substrate/federation-relay/federation-transport-server.ts resolveOverLibp2p (~753-758) calls resolveViaLibp2p and falls back to resolveViaHttp with no timeout or abort signal, and the library's dial and stream path sets none either (repos/libp2p-federation-transport/src/index.ts ~144-150). The effective bound is whatever each caller happens to set: 240 s for the goal-host proxy, 60 s for the floor tool, 30 s for replication, 20 s for the surface, and none at all for the human-surface passthrough (repos/human-surface-vessel/src/routes/proxy.ts ~646). The transport's own inbound limit (FTS ~504, 120 s) is not coupled to the walk budget either. Effect: a blackholed peer or a stalled stream holds a caller for its own arbitrary bound; on the passthrough it can hang indefinitely; and the time cost of a dead route differs by caller, so it cannot be learned. This is a law-1 constant-by-omission. Expected: one shaped egress deadline, read at use time (for example a field on the existing fedIngressAuthPolicy record or a tuning parameter), applied to the libp2p and HTTP fallback paths, with the inbound limit derived from walkBudget.iter_timeout_ms rather than a literal. A timed-out egress returns a named timeout class, not a generic failure. Fix kind: code, because this is transport plumbing; the deadline value itself becomes a shape. Falsifier: must-fail: an egress resolve to a stub peer that accepts the stream and never answers returns a named egress_timeout within the shaped deadline plus a small slack. Today it waits for the caller's abort, or forever on the passthrough. Control: a peer that answers within the deadline returns its answer unchanged.";
const FED_SPEC = "must-fail: egress to a stub peer that never answers returns a named egress_timeout within the shaped deadline (today waits for caller abort or forever); control: an answering peer is unchanged";
const FED_REGION = "resolveOverLibp2p";
const logs: string[] = [];
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

const git = (vessel: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: join(CLONES, vessel), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const [vessel, tree] of Object.entries(TREES)) {
    for (const base of [join(CLONES, vessel), join(RUNTIME, vessel)]) {
      for (const d of ["test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
      for (const [rel, text] of Object.entries(tree)) { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); }
    }
    writeFileSync(join(CLONES, vessel, ".gitignore"), "node_modules\n");
    git(vessel, "init", "-q");
    git(vessel, "add", "-A");
    git(vessel, "commit", "-q", "-m", "fixture: the site");
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      const r = await resolveTestSuite(imp.pointer);
      return Response.json({ shape: r.shape, body: r.body });
    }
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      let vessel = CDB.vessel;
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='([^']*)'/, (_m, p: string) => { vessel = basename(p); return `ROOT='${join(CLONES, vessel)}'`; });
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, vessel), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      return Response.json({ stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const gateOf = (r: Row | undefined): Row => ((ledgerOf(r)["mutation_gate"] ?? {}) as Row);
async function seed(id: string, site: string, summary: string, region: string | null): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: site, ...(region ? { region } : {}) } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<void> {
  await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** Seed a gap, let the supply dispatch for it, land (and commit) `check` as its check file, and let the arm step judge it. */
async function landAndArm(prefix: string, at: { vessel: string; siteRel: string }, summary: string, region: string | null, check: string): Promise<{ id: string; row: Row }> {
  const id = T(prefix);
  const site = `repos/${at.vessel}/${at.siteRel}`;
  await seed(id, site, summary, region);
  await tick(later());
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), edit_site: site });
  writeFileSync(join(CLONES, at.vessel, checkPathOf(id)), check);
  git(at.vessel, "add", "-A");
  git(at.vessel, "commit", "-q", "-m", `check ${id}`);
  landCheck(join(CLONES, at.vessel), checkPathOf(id));
  await tick(later());
  return { id, row: (await storeRow(id))! };
}

const ev = (f: string) => JSON.parse(fixture(f)) as { summary: string; falsifier_spec: string | null; region: string | null };
const DV_SITE = fixture("gap-check-supply.bf88c790.ts.txt");
const DV_REL = "src/resolvers/gap-check-supply.ts";

describe("token anchors skip their declaration occurrences", () => {
  it("[MUST-FAIL] a token declared once and used once: the use is the region", () => {
    const src = "export const some_flag = 1;\nexport function h(): number {\n  return some_flag;\n}\n";
    const r = supply.derivedTextRegion(src, "src/h.ts", "h reads some_flag");
    expect(r).toMatchObject({ anchor: "some_flag", kind: "token", occurrences: 1 });
    expect(r!.mutant.original).toBe("return some_flag;");
  });
  it("[MUST-FAIL] arm_refused: its occurrences outside declarations (four) are one mutant", () => {
    const r = supply.derivedTextRegion(DV_SITE, DV_REL, "the arm_refused branch");
    expect(r).toMatchObject({ anchor: "arm_refused", kind: "token", occurrences: 4 });
    // The span runs from the first to the last replaced statement; a declaration between them is kept as it is.
    const inSpan = (t: string) => t.match(/arm_refused/g)?.length ?? 0;
    expect(inSpan(r!.mutant.original) - inSpan(r!.mutant.replacement)).toBe(4);
  });
  it("[PAIR] 84460a91: the gate applies (its literal is in another repo) and it is UNMEASURED, for an exact reason", () => {
    const e = ev("84460a91-row-evidence.json");
    const site = fixture("libp2p-federation-transport-index.84460a91.ts.txt");
    expect(supply.regionGateApplies({ region: e.region }, site)).toBe(true);
    const x = supply.explainedTextRegion(site, "src/index.ts", e.summary, e.falsifier_spec ?? "");
    expect(x.region).toBeNull();
    // Its only site identifiers occur once each, at their own declarations; it quotes no observed output.
    expect(x.why).toBe("token resolveViaLibp2p: 0 non-declaration occurrence(s) of 1; token resolveViaHttp: 0 non-declaration occurrence(s) of 1");
  });
  it("[PAIR] 40d50487: NOT GATED, because its literal region occurs in its own edit site (the ribosome control's class); a derived region would be the token test_file", () => {
    const e = ev("40d50487-row-evidence.json");
    expect(DV_SITE.split(String(e.region)).length - 1).toBe(1);
    expect(supply.regionGateApplies({ region: e.region }, DV_SITE)).toBe(false);
    expect(supply.derivedTextRegion(DV_SITE, DV_REL, e.summary, e.falsifier_spec ?? "")).toMatchObject({ anchor: "test_file", kind: "token", occurrences: 4 });
  });
  it("[CONTROL] end to end: a row whose evidence names only a declared-and-assigned name records unmeasured: no region WITH its reason", async () => {
    const { row } = await landAndArm("ds-noregion", RIBO, "the replay judge scores almost every successful trace it re-judges below one half (`buildRelevancePayload`)", null, fixture("44abf5e-replay-judge.check.ts.txt"));
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(gateOf(row)["region_gate"]).toEqual({ decided: "unmeasured: no region", why: "token buildRelevancePayload: 0 non-declaration occurrence(s) of 2" });
  }, 120_000);
});
