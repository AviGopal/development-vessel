// A GAP IS ARMED ONLY ON A CHECK THAT HAS LANDED.
//
// The arm tick (gap-check-supply.ts, 2. ARM) armed a dispatched gap whenever its test file EXISTED in the vessel clone's
// work tree. A test-writing compose's refused cutover left its staged check there untracked, the next tick armed the
// gap on it, the mirror's next refresh removed the file, and the gap stayed armed on a check no tree holds: every later
// fix draft ran a missing file and was unjudged (81 of 99 armed own-check runs on one node, 2026-10-26). The arm now
// reads the check at the clone's origin/dev (landedCheckSource), and each pass un-arms this node's armed check-supply
// rows whose check is not there, but only when origin/dev is current (it contains this node's gated sha for the vessel,
// originDevCurrent): a stale ref, or no marker, decides nothing.
//
// Hermetic: a temp bare origin and a clone of it at VESSELS_CLONE_ROOT/<vessel>; the gap store, the rhythm and the
// check runs are the in-process fixtures the other tick tests use. Fixture gap text from a five-word draw
// (radiation java shelf setup jot).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-landed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ORIGIN = join(ROOT, "origin.git");
const ENV_KEYS = ["SUBSTRATE_NAME", "WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
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
const elig = await import("../../src/judge/gap-eligibility.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");
const { WORKSPACE_ROOT } = await import("../../src/config.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const CLONE = join(CLONES, VESSEL);
const H = `import { expect, test } from "bun:test";\n`;
const NODE = `landed-node-${RUN}`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: CLONE, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  // The bare origin and the clone the mirror keeps (origin/dev is its remote-tracking ref).
  mkdirSync(CLONES, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "dev", ORIGIN]);
  Bun.spawnSync(["git", "clone", "-q", ORIGIN, CLONE]);
  for (const d of ["src", "test/checks", "node_modules"]) mkdirSync(join(CLONE, d), { recursive: true });
  mkdirSync(join(RUNTIME, VESSEL, "src"), { recursive: true });
  for (const base of [CLONE, join(RUNTIME, VESSEL)]) writeFileSync(join(base, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(CLONE, ".gitignore"), "node_modules\n");
  git("checkout", "-q", "-b", "dev");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: the site");
  git("push", "-q", "origin", "dev");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      const r = await resolveTestSuite(imp.pointer);
      return Response.json({ shape: r.shape, body: { ...((r.body ?? {}) as Row) } });
    }
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${CLONE}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: CLONE, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      return Response.json({ stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = () => {};
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

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
async function stored(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
async function seed(id: string, extra: Row = {}): Promise<void> {
  const summary = `fixture ${id}: the radiation shelf setup jot in repos/${VESSEL}/src/widget.ts \`widget\` returns 1 where the java reading needs 2`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { ...extra } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  process.env["SUBSTRATE_NAME"] = NODE;
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    await sg.__settleBirthEvaluationsForTests();
    return r.body as Row;
  } finally { delete process.env["SUBSTRATE_NAME"]; }
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
/** The check the goal writes, in the clone's work tree only (what a refused cutover leaves behind). */
const writeCheck = (id: string, title: string): void =>
  writeFileSync(join(CLONE, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${title}", () => { expect(mod.widget).toBe(2); });\n`);
/** The check landed: committed and pushed, so origin/dev holds it. */
const land = (id: string): void => { git("add", "--", checkPathOf(id)); git("commit", "-q", "-m", `check ${id}`); git("push", "-q", "origin", "dev"); };
/** The check taken off dev (and so off the clone, as the mirror's refresh does). */
const unland = (id: string): void => { git("rm", "-q", "--", checkPathOf(id)); git("commit", "-q", "-m", `drop ${id}`); git("push", "-q", "origin", "dev"); };
/** This node's pull-sync gate marker for the vessel (<workspace>/.pull-sync/<vessel>.gated-sha), or none. */
const MARKER = join(WORKSPACE_ROOT, ".pull-sync", `${VESSEL}.gated-sha`);
const setGated = (sha: string | null): void => {
  if (!WORKSPACE_ROOT.startsWith(tmpdir()) && !WORKSPACE_ROOT.startsWith("/tmp/")) throw new Error(`workspace root ${WORKSPACE_ROOT} is not a temp dir`);
  if (sha === null) { rmSync(MARKER, { force: true }); return; }
  mkdirSync(join(WORKSPACE_ROOT, ".pull-sync"), { recursive: true });
  writeFileSync(MARKER, `${sha}\n`);
};
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** A row armed by this node on a landed check, then the check taken off dev. */
async function armedThenUnlanded(prefix: string): Promise<string> {
  const id = T(prefix);
  await seed(id);
  await tick(later()); // dispatch
  writeCheck(id, `jot the radiation shelf ${id}`);
  land(id);
  await tick(later()); // armed
  const row = await stored(id);
  expect(ledgerOf(row)["state"]).toBe("armed");
  expect(elig.composeEligibilitySkipReason(row!)).toBeNull();
  unland(id);
  return id;
}

describe("the arm reads the check at origin/dev, not the work tree", () => {
  it("[MUST-FAIL] a check only in the clone's work tree (untracked, absent at origin/dev) does not arm its gap", async () => {
    const id = T("landed-untracked");
    await seed(id);
    await tick(later()); // dispatch
    expect(ledgerOf(await stored(id))["state"]).toBe("goal_dispatched");
    writeCheck(id, `java shelf setup ${id}`);
    const body = await tick(later());
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("goal_dispatched");
    expect(elig.composeEligibilitySkipReason(row!)).toBe("unarmed");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    const why = ((body["not_armed"] ?? []) as Array<{ id: string; reason: string }>).find((n) => n.id === id)?.reason ?? "";
    expect(why).toContain("check_not_landed");
    unlinkSync(join(CLONE, checkPathOf(id)));
  });

  it("[CONTROL] the same check, once landed on origin/dev, arms as before", async () => {
    const id = T("landed-control");
    await seed(id);
    await tick(later()); // dispatch
    writeCheck(id, `radiation setup jot ${id}`);
    land(id);
    await tick(later());
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(elig.composeEligibilitySkipReason(row!)).toBeNull();
    expect((metaOf(row)["evidence_resolve"] as { input?: Row } | undefined)?.input?.["test_file"]).toBe(checkPathOf(id));
  });

  it("[MUST-FAIL] an untracked edit cannot add a title: the titles are read from the landed blob", async () => {
    const id = T("landed-titles");
    await seed(id);
    await tick(later()); // dispatch
    const landedTitle = `java radiation landed ${id}`;
    writeCheck(id, landedTitle);
    land(id);
    // The work tree now carries an extra, unlanded title.
    writeFileSync(join(CLONE, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${landedTitle}", () => { expect(mod.widget).toBe(2); });\ntest("unlanded shelf ${id}", () => { expect(mod.widget).toBe(2); });\n`);
    await tick(later());
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("armed");
    const only = ((metaOf(row)["evidence_resolve"] as { input?: Row } | undefined)?.input?.["only_tests"] ?? []) as string[];
    expect(only).toEqual([landedTitle]);
    git("checkout", "-q", "--", checkPathOf(id));
  });
});

describe("an arm on a check that is not at origin/dev is taken back", () => {
  it("[MUST-FAIL] this node's armed gap whose check is no longer at origin/dev is un-armed, with the reason recorded", async () => {
    const id = await armedThenUnlanded("landed-unarm");
    setGated(git("rev-parse", "origin/dev")); // origin/dev is current: it holds what the gate verified
    await tick(later());
    const row = await stored(id);
    const led = ledgerOf(row);
    expect(led["state"]).toBe("arm_refused");
    expect(String(led["reason"] ?? "")).toContain("check_not_landed");
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    expect(elig.composeEligibilitySkipReason(row!)).toBe("unarmed");
  });

  it("[MUST-FAIL] a STALE origin/dev (behind the gated sha, which holds the check) takes no arm back", async () => {
    const id = T("landed-stale");
    await seed(id);
    await tick(later()); // dispatch
    writeCheck(id, `stale shelf radiation ${id}`);
    land(id);
    await tick(later()); // armed
    expect(ledgerOf(await stored(id))["state"]).toBe("armed");
    const landedAt = git("rev-parse", "origin/dev");
    setGated(landedAt);
    // The clone's ref falls behind the landing (the mirror did not move it): the check reads absent there.
    git("update-ref", "refs/remotes/origin/dev", `${landedAt}~1`);
    try {
      await tick(later());
      const row = await stored(id);
      expect(ledgerOf(row)["state"]).toBe("armed");
      expect(elig.composeEligibilitySkipReason(row!)).toBeNull();
    } finally { git("update-ref", "refs/remotes/origin/dev", landedAt); }
  });

  it("[MUST-FAIL] a missing gated-sha marker decides nothing: the arm stays", async () => {
    const id = await armedThenUnlanded("landed-nomarker");
    setGated(null);
    await tick(later());
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(elig.composeEligibilitySkipReason(row!)).toBeNull();
  });

  it("[CONTROL] another node's arm is left alone (its clone may hold a landing this one has not pulled)", async () => {
    const id = await armedThenUnlanded("landed-other-node");
    const row = structuredClone((await stored(id))!);
    const meta = metaOf(row);
    meta["check_supply"] = { ...ledgerOf(row), armed_by_node: `other-node-${RUN}` };
    row["classification_metadata"] = meta;
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: row } as never);
    expect(w.shape).not.toBe("structuredError");
    await sg.__settleBirthEvaluationsForTests();
    setGated(git("rev-parse", "origin/dev"));
    await tick(later());
    const after = await stored(id);
    expect(ledgerOf(after)["state"]).toBe("armed");
    expect(elig.composeEligibilitySkipReason(after!)).toBeNull();
  });

  it("[CONTROL] a landed armed check stays armed across passes", async () => {
    const id = T("landed-stays");
    await seed(id);
    await tick(later());
    writeCheck(id, `shelf jot stays ${id}`);
    land(id);
    await tick(later());
    await tick(later());
    const row = await stored(id);
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(elig.composeEligibilitySkipReason(row!)).toBeNull();
  });

  it("[CONTROL] a class1 (literal) gap is not on this path: the pass leaves its falsifier and eligibility unchanged", async () => {
    const id = T("landed-class1");
    await seed(id, { edit_site: `repos/${VESSEL}/src/widget.ts`, expected_literal: `JAVA_SHELF_SETUP_${RUN}` });
    const before = await stored(id);
    const fBefore = metaOf(before)["falsifier"];
    const eBefore = elig.composeEligibilitySkipReason(before!);
    await tick(later());
    const after = await stored(id);
    expect(metaOf(after)["falsifier"]).toEqual(fBefore);
    expect(elig.composeEligibilitySkipReason(after!)).toBe(eBefore);
    expect(ledgerOf(after)["state"]).not.toBe("arm_refused");
  });
});
