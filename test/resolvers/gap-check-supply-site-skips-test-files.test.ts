// CHECK-SUPPLY NEVER SITES A FAILING-TEST ROW ON ITS OWN TEST FILE.
//
// checkSupplySite returned the first src/…/*.ts its summary named that exists in the vessel clone. A failing-test row's
// summary names its failing test, so in a vessel whose tests live under src/ (src/jobs/x.n1.test.ts,
// src/validators/__tests__/email.test.ts) the TEST FILE became the site: localizeForSupply persisted it
// (check_supply_site), the falsifier was re-stamped unresolvable edit_site_is_own_check, and the row was refused on every
// pass. Its own check's fresh red reading already named the src file on its call path. Expected, through the existing
// gap-check-supply tick in dry-run (temp gap store, a git clone fixture whose origin/dev the reading was taken at,
// stubbed fetch, a "present" birth judge), plus checkSupplySite directly:
//   - [MUST-FAIL] summary names src/jobs/x.n1.test.ts (it exists) and the fresh red reading's call_path names
//     src/jobs/x.ts: localized to repos/<v>/src/jobs/x.ts by own_check_call_path, never the test file;
//   - [MUST-FAIL] a __tests__/ path and a .spec.ts path named in a summary are skipped too (checkSupplySite: null);
//   - CONTROL: a summary naming a non-test src file is sited to it exactly as before (check_supply_site);
//   - a summary naming only a test file, with no reading, gets no site (skipped no_site), never the test (the row's
//     control; red at the parent too, which sites the test file).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-testsite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// The shaped policies are read from this file's own temp checkout, never the live super clone.
process.env["SUPER_REPO_DIR"] = join(ROOT, "policy-super");
mkdirSync(join(ROOT, "policy-super", ".git"), { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const TEST_FILE = "src/jobs/x.n1.test.ts";
const SRC = "src/jobs/x.ts";
const OTHER = "src/jobs/y.ts";
const TITLES = ["x classifier > labels the track"];
const FILES: Record<string, string> = {
  [SRC]: "export function classify(n: number): string { return n > 1 ? 'a' : 'b'; }\n",
  [OTHER]: "export const y = 1;\n",
  [TEST_FILE]: "import { test, expect } from 'bun:test';\nimport { classify } from './x';\ntest('labels the track', () => { expect(classify(2)).toBe('b'); });\n",
  "src/validators/__tests__/helpers.ts": "export const h = 1;\n",
  "src/validators/email.spec.ts": "export const s = 1;\n",
};
const git = (...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", join(CLONES, VESSEL), ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
let HEAD = "";
let rhythms: Row[] = [];
// max_per_tick 10: a dry-run tick writes nothing, so an earlier case's row stays a candidate; each case's row is reached.
const dueRhythm = (): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3 },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const [rel, text] of Object.entries(FILES)) for (const base of [CLONES, RUNTIME]) {
    mkdirSync(join(base, VESSEL, rel, ".."), { recursive: true });
    writeFileSync(join(base, VESSEL, rel), text);
  }
  // The clone's origin/dev is the sha the reading was taken at, so the reading is fresh.
  git("init", "-q");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "add", "-A");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  HEAD = git("rev-parse", "origin/dev");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}` }, { status: 202 });
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"], require_falsifier_classes: ["class2"] } }], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    // The localizer's own scope read (gap-policy autonomyScope) needs a poolImpulse producer; it is this same stub.
    const cap = body?.pointer ?? imp?.pointer;
    if (cap?.type === "vesselCapability") return Response.json({ content: { vessels: cap.shape === "poolImpulse" ? [{ vesselId: "development-vessel-local", endpoint: "http://pool.gcs-testsite", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }] : [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); restoreCutoverExecModules(); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { rhythms = [dueRhythm()]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation" } } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}
const CHECK = { shape: "test_suite", input: { vessel: VESSEL, test_file: TEST_FILE, only_tests: TITLES } };
const reading = () => ({
  gap_id: "x", vessel: VESSEL, test_file: TEST_FILE, only_tests: TITLES, base_sha: HEAD, verdict: "red_code_reachable", red: TITLES, failing: [], expect_count: 1,
  call_path: [{ path: `repos/${VESSEL}/${SRC}`, fn: "classify", line: 1 }], call_path_source: "static", env_signals: [], env_policy: "policy", dispatch_id: "d", measured_at: "2026-01-01T00:00:00Z",
});
/** Seed one open, armed (class2), siteless failing-test row, optionally carrying a fresh red own-check reading. */
async function seed(id: string, summary: string, withReading: boolean): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2026-10-01T00:00:00Z", summary,
    classification_metadata: { evidence_resolve: CHECK, ...(withReading ? { own_check_baseline: reading() } : {}) } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function dryTick(): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: Date.now(), dry_run: true } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
const localizedOf = (body: Row, id: string) => ((body["localized"] as Row[] | undefined) ?? []).find((x) => x["id"] === id) ?? null;
const skippedOf = (body: Row, id: string) => ((body["skipped"] as Row[] | undefined) ?? []).find((x) => x["id"] === id) ?? null;

describe("gap-check-supply sites a failing-test row on its code, never on its own test file", () => {
  it("[MUST-FAIL] summary names the existing src/…/x.n1.test.ts, the fresh red reading's call path names src/…/x.ts: sited on x.ts by own_check_call_path", async () => {
    await closeAllOpen();
    const id = T("gcs-ts-main");
    await seed(id, `fixture ${RUN}: failing test repos/${VESSEL}/${TEST_FILE} (${TITLES[0]})`, true);
    const body = await dryTick();
    expect(localizedOf(body, id)).toEqual({ id, edit_site: `repos/${VESSEL}/${SRC}`, method: "own_check_call_path" });
  });

  it("[MUST-FAIL] a __tests__/ path and a .spec.ts path named in a summary are skipped too", () => {
    const row = (summary: string): Row => ({ id: `gcs-ts-unit-${RUN}`, summary, classification_metadata: {} });
    expect(supply.checkSupplySite(row(`see repos/${VESSEL}/src/validators/__tests__/helpers.ts`), VESSEL)).toBeNull();
    expect(supply.checkSupplySite(row(`see repos/${VESSEL}/src/validators/email.spec.ts`), VESSEL)).toBeNull();
    expect(supply.checkSupplySite(row(`see repos/${VESSEL}/${TEST_FILE}`), VESSEL)).toBeNull();
    // the scan goes on past a test file to the next named src file
    expect(supply.checkSupplySite(row(`see repos/${VESSEL}/${TEST_FILE} and repos/${VESSEL}/${OTHER}`), VESSEL)).toBe(`repos/${VESSEL}/${OTHER}`);
  });

  it("[CONTROL] a summary naming a non-test src file is sited to it exactly as before (check_supply_site)", async () => {
    await closeAllOpen();
    const id = T("gcs-ts-src");
    await seed(id, `fixture ${RUN}: repos/${VESSEL}/${OTHER} returns 1; it must return 2`, false);
    const body = await dryTick();
    expect(localizedOf(body, id)).toEqual({ id, edit_site: `repos/${VESSEL}/${OTHER}`, method: "check_supply_site" });
  });

  it("[MUST-FAIL] only a test file named and no reading: no site (skipped no_site), never the test (the row's control; the parent sites the test file here)", async () => {
    await closeAllOpen();
    const id = T("gcs-ts-noread");
    await seed(id, `fixture ${RUN}: failing test repos/${VESSEL}/${TEST_FILE}`, false);
    const body = await dryTick();
    expect(localizedOf(body, id)).toBeNull();
    expect(String(skippedOf(body, id)?.["reason"] ?? "")).toStartWith("no_site:");
  });
});
