// check-landing-restart: whether dv's self-cutover restarts dv for a check-only staging, as a masked variant.
//
// A check-only staging (every staged file an out-of-suite test/checks/<name>.check.ts) changes no file the running
// process loaded, yet the self-cutover restarted dv for it, closing admission for the quiesce wait. Variant-1 skips that
// restart when the runtime is current (no file under src/, nor package.json or bun.lock, newer than the process) and no
// restart is owed; variant-0 restarts as before. The decision is read only for a check-only staging. Its credit is
// settled by the next compose request on this node within 17 min: admitted -> reached, refused -> not reached.
//
// The [MUST-FAIL] cases fail at the parent (the exports do not exist there). The [CONTROL] cases pin variant-0.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = "../../src/resolvers/vessel-mitosis-cutover.ts";
const ACT = "development-vessel:check-landing-restart";
const P = `[${ACT}]`;
const T0 = Date.now() - (Date.now() % 1000);
const SHA = "a".repeat(40);
const RUNTIME_SHA = "b".repeat(40);
const CHECK = "test/checks/some-gap.check.ts";

type Trace = Record<string, unknown>;
let dir = "";
let lines: string[] = [];
let traces: Trace[] = [];
let reads = 0;
const origLog = console.log, origWarn = console.warn;

function mask(variant: unknown, activity = ACT) {
  return { id: `mask-${String(variant)}`, body: { activity_id: activity, active_variant: variant, from: new Date(T0 - 60_000).toISOString(), until: new Date(T0 + 7 * 86_400_000).toISOString(), by: "operator:test", reason: "test" } };
}
/** A runtime tree whose files are all older than the process (started at T0), so it is current. */
function runtimeTree(): string {
  const root = join(dir, "runtime");
  mkdirSync(join(root, "src", "resolvers"), { recursive: true });
  mkdirSync(join(root, "test", "checks"), { recursive: true });
  for (const f of ["package.json", "bun.lock", "src/index.ts", "src/resolvers/a.ts", CHECK]) {
    writeFileSync(join(root, f), "x\n");
    utimesSync(join(root, f), (T0 - 60_000) / 1000, (T0 - 60_000) / 1000);
  }
  // The check the landing just mirrored is newer than the process: it is under test/, so it does not count.
  utimesSync(join(root, CHECK), (T0 + 30_000) / 1000, (T0 + 30_000) / 1000);
  return root;
}
async function load(over: Record<string, unknown> = {}, masks: unknown[] | (() => unknown[]) = [mask(1)]) {
  const m = await import(MOD);
  m.__setCheckLandingRestartDepsForTests({
    readMasks: () => { reads += 1; return typeof masks === "function" ? (masks as () => unknown[])() : masks; },
    postTrace: async (t: Trace) => { traces.push(t); return 200; },
    nowMs: () => T0 + 60_000,
    procStartMs: () => T0,
    pendingFile: join(dir, "pending.json"),
    restartOwed: () => null,
    runtimeSha: async () => RUNTIME_SHA,
    ...over,
  });
  return m;
}
const decide = (m: any, stagedFiles: string[], runtimeRoot: string) =>
  m.checkLandingRestartDecision({ stagedFiles, newSha: SHA, vesselName: "development-vessel", runtimeRoot, hostRepoRoot: dir, gitCmd: "git" });
const decisionLines = () => lines.filter((l) => l.startsWith(`${P} decision `));
const pending = () => (existsSync(join(dir, "pending.json")) ? JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) : null);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clr-"));
  lines = []; traces = []; reads = 0;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
});
afterEach(async () => {
  console.log = origLog; console.warn = origWarn;
  (await import(MOD)).__setCheckLandingRestartDepsForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("check-landing-restart decision", () => {
  test("[MUST-FAIL] variant-1 skips the restart for a check-only staging on a current runtime: one line, one trace, one pending", async () => {
    const m = await load();
    const r = await decide(m, [CHECK], runtimeTree());
    await flush();
    expect(r).toEqual({ skip: true, variant: 1 });
    expect(reads).toBe(1);
    const d = decisionLines();
    expect(d.length).toBe(1);
    expect(d[0]).toContain(`variant=1 (mask mask-1 [`);
    expect(d[0]).toContain(` reason=check_only_skip restart=false landed_sha=${SHA} runtime_sha=${RUNTIME_SHA} staged=1 check_only=true stale=none owed=none in_flight_oldest_ms=`);
    expect(d[0]).toMatch(/ node=\S+ at=/);
    expect(traces.length).toBe(1);
    expect(traces[0]!["template_id"]).toBe(`${ACT}-v1`);
    expect(traces[0]!["output_shapes"]).toEqual(["checkLandingRestart"]);
    expect((traces[0]!["metadata"] as any).checkLandingRestart).toMatchObject({ variant: 1, reason: "check_only_skip", restart: false, landed_sha: SHA, runtime_sha: RUNTIME_SHA, stale: null, owed: null });
    const p = pending();
    expect(p.length).toBe(1);
    expect(p[0]).toMatchObject({ variant: 1, restartTaken: false, procStartMs: T0, decidedAtMs: T0 + 60_000 });
  });

  test("[MUST-FAIL] a staging that touches src (alone or with a check) is not decided: no mask read, no line, the restart goes on", async () => {
    const m = await load();
    const root = runtimeTree();
    for (const staged of [["src/resolvers/a.ts"], [CHECK, "src/resolvers/a.ts"], ["test/resolvers/a.test.ts"], []]) {
      expect(await decide(m, staged, root)).toBeNull();
    }
    await flush();
    expect(reads).toBe(0);
    expect(lines.filter((l) => l.includes(P)).length).toBe(0);
    expect(traces.length).toBe(0);
    expect(pending()).toBeNull();
  });

  test("[MUST-FAIL] variant-1 restarts when the runtime is stale or a restart is owed, and names why", async () => {
    // A src file newer than the process.
    let m = await load();
    let root = runtimeTree();
    utimesSync(join(root, "src/resolvers/a.ts"), (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    expect(await decide(m, [CHECK], root)).toEqual({ skip: false, variant: 1 });
    expect(decisionLines().at(-1)).toContain(" reason=stale_runtime restart=true ");
    expect(decisionLines().at(-1)).toContain(" stale=src/resolvers/a.ts ");
    // package.json newer than the process.
    rmSync(root, { recursive: true, force: true });
    root = runtimeTree();
    utimesSync(join(root, "package.json"), (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    expect(await decide(m, [CHECK], root)).toEqual({ skip: false, variant: 1 });
    expect(decisionLines().at(-1)).toContain(" stale=package.json ");
    // A runtime tree with no src cannot be read: stale.
    expect(await decide(m, [CHECK], join(dir, "nowhere"))).toEqual({ skip: false, variant: 1 });
    expect(decisionLines().at(-1)).toContain(" stale=(unreadable: ");
    // A self-restart already owed.
    m = await load({ restartOwed: () => "mitosis-self-restart-x-development-vessel.timer" });
    expect(await decide(m, [CHECK], runtimeTree())).toEqual({ skip: false, variant: 1 });
    expect(decisionLines().at(-1)).toContain(" reason=restart_owed restart=true ");
    expect(decisionLines().at(-1)).toContain(" owed=mitosis-self-restart-x-development-vessel.timer ");
  });

  test("[CONTROL] variant-0 restarts as before: no mask in force, a mask naming 0 or an unknown variant, or an unreadable pool", async () => {
    const root = runtimeTree();
    const cases: Array<[string, unknown[] | (() => unknown[]), string]> = [
      ["none", [], "no mask in force: variant-0"],
      ["other activity", [mask(1, "development-vessel:compose-caller-cut")], "no mask in force: variant-0"],
      ["v0", [mask(0)], "mask mask-0 ["],
      ["unknown", [mask(7)], "names unknown variant 7: variant-0"],
      ["unreadable", () => { throw new Error("pool down"); }, "mask_unread (pool down): variant-0"],
    ];
    for (const [, masks, why] of cases) {
      lines = []; reads = 0;
      const m = await load({}, masks);
      expect(await decide(m, [CHECK], root)).toEqual({ skip: false, variant: 0 });
      expect(reads).toBe(1);
      const d = decisionLines();
      expect(d.length).toBe(1);
      expect(d[0]).toContain(why);
      expect(d[0]).toContain(" reason=variant0_restart restart=true ");
    }
    // The unreadable pool is logged once as mask_unread, never retried within the decision.
    expect(lines.filter((l) => l === `${P} mask_unread (pool down): variant-0`).length).toBe(1);
    expect(lines.filter((l) => l === `${P} pool_read shape=activityVariantMask ok=false`).length).toBe(1);
  });
});

describe("check-landing-restart credit (the next compose request on this node)", () => {
  test("[MUST-FAIL] admitted settles every pending decision reached, once, naming what settled it", async () => {
    const m = await load();
    const root = runtimeTree();
    await decide(m, [CHECK], root);
    await decide(m, [CHECK], root);
    await flush();
    traces = [];
    expect(m.settleCheckLandingRestart(true, "admitted", "slot-1")).toBe(2);
    await flush();
    expect(traces.length).toBe(2);
    for (const t of traces) {
      expect(t["template_id"]).toBe(`${ACT}-credit`);
      expect(t["success"]).toBe(true);
      expect(t["tags"]).toContain("reached:true");
      expect((t["metadata"] as any).settled_by).toBe("slot-1");
      expect((t["composition_chain"] as string[])[0]).toMatch(/^check-landing-restart-a{12}-/);
    }
    expect(pending()).toEqual([]);
    expect(m.settleCheckLandingRestart(true, "admitted", "slot-2")).toBe(0);
  });

  test("[MUST-FAIL] a refusal (BUSY, or the drain's 503) settles not reached; past 17 min a decision is ungraded", async () => {
    let now = T0 + 60_000;
    const m = await load({ nowMs: () => now });
    const root = runtimeTree();
    await decide(m, [CHECK], root);
    await flush(); traces = [];
    expect(m.settleCheckLandingRestart(false, "drain_503", "drain-refusal-1")).toBe(1);
    await flush();
    expect(traces[0]!["success"]).toBe(false);
    expect(traces[0]!["tags"]).toContain("reached:false");
    expect((traces[0]!["failure_mode"] as any).reason).toContain("(drain_503)");
    await decide(m, [CHECK], root);
    await flush(); traces = [];
    now += 17 * 60_000 + 1;
    expect(m.settleCheckLandingRestart(true, "admitted", "slot-3")).toBe(0);
    await flush();
    expect(traces.length).toBe(0);
    expect(lines.filter((l) => l.startsWith(`${P} ungraded `) && l.endsWith(": no compose request within 17 min")).length).toBe(1);
  });

  test("[MUST-FAIL] a decision that restarted survives its own restart; a skip, or a second restart, leaves it ungraded", async () => {
    const root = runtimeTree();
    // variant-0 decides (restart taken); the next process starts a minute later and settles it.
    let m = await load({}, [mask(0)]);
    await decide(m, [CHECK], root);
    m = await load({ procStartMs: () => T0 + 120_000, nowMs: () => T0 + 180_000 }, [mask(0)]);
    await flush(); traces = [];
    expect(m.settleCheckLandingRestart(false, "refused_busy", "slot-4")).toBe(1);
    // variant-1 skipped; a restart came anyway: not this decision's, so ungraded.
    m = await load({}, [mask(1)]);
    await decide(m, [CHECK], root);
    m = await load({ procStartMs: () => T0 + 120_000, nowMs: () => T0 + 180_000 });
    expect(m.settleCheckLandingRestart(true, "admitted", "slot-5")).toBe(0);
    expect(lines.filter((l) => l.startsWith(`${P} ungraded `) && l.endsWith("the unit restarted in its window, not by this decision")).length).toBe(1);
    // variant-0 decided, but the next process started past the quiesce wait plus its margin: not its own restart.
    const { CUTOVER_QUIESCE_MAX_MS } = await import("../../src/compose-slots.ts");
    m = await load({}, [mask(0)]);
    await decide(m, [CHECK], root);
    const late = T0 + 60_000 + CUTOVER_QUIESCE_MAX_MS + 2 * 60_000 + 1000;
    m = await load({ procStartMs: () => late, nowMs: () => late + 1000 });
    expect(m.settleCheckLandingRestart(true, "admitted", "slot-6")).toBe(0);
    expect(lines.filter((l) => l.startsWith(`${P} ungraded `) && l.endsWith("the unit restarted in its window, not by this decision")).length).toBe(2);
    expect(pending()).toEqual([]);
  });

  test("[MUST-FAIL] the step-10 self-cutover branch decides before probing systemd, and a skip schedules nothing", async () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "vessel-mitosis-cutover.ts"), "utf8");
    const at = src.indexOf("if (isSelfCutover) {");
    const branch = src.slice(at, src.indexOf("const sysdRun", at));
    const call = branch.indexOf("const checkLanding = await checkLandingRestartDecision({ stagedFiles, newSha, vesselName: vessel_name, runtimeRoot: baseRoot, hostRepoRoot, gitCmd });");
    expect(call).toBeGreaterThan(0);
    expect(branch.indexOf('if (checkLanding?.skip !== true && process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] !== "1") {')).toBeGreaterThan(call);
    // The skip is the first branch; the rest of the chain is the parent's, unchanged.
    expect(branch).toContain('if (checkLanding?.skip === true) {\n        operations.push({ op: `deferred self-restart ${unit}`, status: "skipped",');
    expect(branch).toContain('} else if (alreadyScheduled) {\n        operations.push({ op: `deferred self-restart ${unit}`, status: "ok", detail: `(already scheduled as ${tsUnit})` });\n      } else if (process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] === "1") {');
    expect(src.split("checkLandingRestartDecision(").length - 1).toBe(2); // its definition and this one call
  });
});
