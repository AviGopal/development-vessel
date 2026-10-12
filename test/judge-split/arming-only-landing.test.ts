// AN ARMING-ONLY LANDING IS NOT A FIX LANDING.
//
// A landing whose diff only adds the gap's own check (the supply's test/checks/<gap>.check.ts, red by design) ARMS the
// gap: the fix is composed against that check afterwards. Treated as a fix landing it deadlocked and then punished the
// gap: the cutover stamped it pending_outcome_verification, the picker skipped a landed-awaiting-verification gap with
// no string predicate (and a pending_verification disposition held it from admission), and the next pending-land sweep
// read the check 'present' (red by design) and falsified the landing: regressed_by, an UNFAVORABLE settlement and a
// class-posterior miss, a hold that outlives the arming.
//
// MUST-FAILS (synthetic fixtures; no network, no live store):
//   (a) STAMP SITE: the real stampPendingLand, through the cutover's own-check deps seam, writes nothing for an
//       arming-only landing and the row stays compose-eligible; a MIXED landing (the check plus a src change) is
//       stamped as before (control), and so is a caller that names no files (control).
//   (b) PICKER: the row an arming-only landing leaves behind is not skipped by pickSkipPending; the row a fix landing
//       leaves behind still is (control).
//   (c) SWEEP BACKSTOP: the REAL sweep, in a fresh process on a temp store, temp vessel clone and temp attempt ledger,
//       every test_suite check reading red: a row stamped by an arming-only landing (held pending_verification, or
//       stamp-only) is NOT falsified (no regressed_by, no UNFAVORABLE, no #2 settlement, no posterior miss) and its
//       stamp and hold are released; a mixed (fix) landing reading 'present' is still falsified (control).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import * as supplyMod from "../../src/resolvers/check-supply-admission.js";
import { composeEligibilitySkipReason } from "../../src/judge/gap-eligibility.js";
import { pickSkipPending } from "../../src/judge/gap-admission.js";

type Row = Record<string, unknown>;
type Deps = { readGap?: (p: Row) => Promise<unknown>; writeGap?: (p: Row) => Promise<unknown>; ask?: (p: Row) => Promise<unknown> };
const cut = cutoverMod as unknown as {
  __setOwnCheckDepsForTests?: (d: Deps | null) => void;
  stampPendingLand?: (a: Record<string, unknown>) => Promise<void>;
};
const supply = supplyMod as unknown as { checkSupplyCheckPath: (id: string) => string; armingOnlyLanding?: unknown };

const VESSEL = "development-vessel";
const SHA = "89abcdef0123456789abcdef0123456789abcdef";

/** An armed class2 gap whose own check is the supply's out-of-suite check file. */
function armedRow(id: string, extra: Row = {}): Row {
  return {
    id, status: "open", category: "missing_capability", source: "substrate_detected", summary: "fixture: armed gap",
    detected_at: "2026-10-01T00:00:00.000Z",
    classification_metadata: {
      falsifier: "class2", edit_site: `repos/${VESSEL}/src/resolvers/fixture-target.ts`,
      evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: supply.checkSupplyCheckPath(id) }, zero_field: "requested_not_passing" },
      ...extra,
    },
  };
}

describe("arming-only landing: the stamp site and the picker", () => {
  let writes: Row[];
  let asks: Row[];
  let dir: string;
  const savedClone = process.env["MITOSIS_PUSH_CLONE_DIR"];
  beforeEach(() => {
    writes = []; asks = [];
    dir = mkdtempSync(join(tmpdir(), "arming-only-stamp-"));
    delete process.env["MITOSIS_PUSH_CLONE_DIR"];
  });
  afterEach(() => {
    cut.__setOwnCheckDepsForTests?.(null);
    if (savedClone === undefined) delete process.env["MITOSIS_PUSH_CLONE_DIR"]; else process.env["MITOSIS_PUSH_CLONE_DIR"] = savedClone;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real pending-land stamp on `row` for a landing that changed `files`; returns the row as the store would hold it after. */
  async function stampWith(row: Row, files: string[] | undefined): Promise<Row> {
    expect(typeof cut.stampPendingLand).toBe("function");
    cut.__setOwnCheckDepsForTests?.({
      readGap: async () => ({ shape: "substrateGap", body: { gaps: [row] } }),
      writeGap: async (p) => { writes.push(p); return { shape: "substrateGapWriteResult", body: { id: row.id, action: "updated" } }; },
      ask: async (p) => { asks.push(p); return { shape: "uiQuestion_write", body: { ok: true } }; },
    });
    await cut.stampPendingLand!({
      gapId: row.id, newSha: SHA, appliedAt: "2026-10-12T00:00:00.000Z", vessel_name: VESSEL,
      hostRepoRoot: join(dir, "no-such-repo"), gitCmd: "git", landedUnverifiedReason: null,
      ...(files ? { stagedFiles: files } : {}),
    });
    return writes.length > 0 ? (writes.at(-1)!["gap"] as Row) : row;
  }
  const metaOf = (r: Row) => (r["classification_metadata"] ?? {}) as Row;

  it("the predicate exists (closed, check-supply-admission)", () => {
    expect(typeof supply.armingOnlyLanding).toBe("function");
  });

  it("MUST-FAIL (a): an arming-only landing is not pending-stamped; the gap stays open and compose-eligible", async () => {
    const row = armedRow("fixture-arming-gap");
    const after = await stampWith(row, [supply.checkSupplyCheckPath("fixture-arming-gap")]);
    expect({ writes: writes.length, pending: metaOf(after)["pending_outcome_verification"] ?? null, asks: asks.length }).toEqual({ writes: 0, pending: null, asks: 0 });
    expect(composeEligibilitySkipReason(after)).toBeNull();
  });

  it("MUST-FAIL (a): the same holds for the check named in any vessel-root form (repos/<vessel>/...)", async () => {
    const row = armedRow("fixture-arming-gap-2");
    await stampWith(row, [`repos/${VESSEL}/${supply.checkSupplyCheckPath("fixture-arming-gap-2")}`]);
    expect(writes.length).toBe(0);
  });

  it("CONTROL (a): a mixed landing (the check plus a src change) is stamped pending as before", async () => {
    const row = armedRow("fixture-mixed-gap");
    const after = await stampWith(row, [supply.checkSupplyCheckPath("fixture-mixed-gap"), "src/resolvers/fixture-target.ts"]);
    expect({ writes: writes.length, pending: metaOf(after)["pending_outcome_verification"] }).toEqual({ writes: 1, pending: SHA });
  });

  it("CONTROL (a): another gap's check is not this gap's own check: stamped", async () => {
    const row = armedRow("fixture-other-gap");
    const after = await stampWith(row, [supply.checkSupplyCheckPath("fixture-someone-else")]);
    expect(metaOf(after)["pending_outcome_verification"]).toBe(SHA);
  });

  it("MUST-FAIL (a): the out-of-suite check its evidence_resolve names (another test/checks/*.check.ts) is its own check too", async () => {
    const row = armedRow("fixture-named-check-gap");
    const meta = row["classification_metadata"] as Row;
    meta["evidence_resolve"] = { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: `repos/${VESSEL}/test/checks/fixture-shared.check.ts` }, zero_field: "requested_not_passing" };
    await stampWith(row, ["test/checks/fixture-shared.check.ts"]);
    expect(writes.length).toBe(0);
  });

  it("CONTROL (a): an in-suite test_file is not an arming check: a landing editing only it is stamped as before", async () => {
    const row = armedRow("fixture-in-suite-gap");
    const meta = row["classification_metadata"] as Row;
    meta["evidence_resolve"] = { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: "test/resolvers/fixture-target.test.ts" }, zero_field: "requested_not_passing" };
    const after = await stampWith(row, ["test/resolvers/fixture-target.test.ts"]);
    expect(metaOf(after)["pending_outcome_verification"]).toBe(SHA);
  });

  it("CONTROL (a): a caller that names no changed files is stamped as before", async () => {
    const row = armedRow("fixture-unnamed-gap");
    const after = await stampWith(row, undefined);
    expect(metaOf(after)["pending_outcome_verification"]).toBe(SHA);
  });

  it("MUST-FAIL (b): the picker does not skip the gap an arming-only landing leaves behind", async () => {
    const row = armedRow("fixture-pick-gap");
    const after = await stampWith(row, [supply.checkSupplyCheckPath("fixture-pick-gap")]);
    expect(pickSkipPending(after, [after], new Map())).toBe(false);
  });

  it("CONTROL (b): the gap a fix landing leaves behind is still skipped while its verdict is pending", async () => {
    const row = armedRow("fixture-pick-fix-gap");
    const after = await stampWith(row, ["src/resolvers/fixture-target.ts"]);
    expect(pickSkipPending(after, [after], new Map())).toBe(true);
  });
});

// ── (c) the real sweep in a fresh process ───────────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "arming-only-sweep-"));
const CLONES = join(ROOT, "clones");
const BIN = join(ROOT, "bin");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const LEDGER = join(ROOT, "ledger");
const POSTERIOR = join(ROOT, "gap-class-posteriors.json");
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;
const LEDGER_MOD = new URL("../../src/resolvers/attempt-ledger.ts", import.meta.url).pathname;
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
// arm-held: stamped and held pending_verification; arm-stamp: stamp only; fix-ctl: the check plus a src change.
const KEYS = ["arm-held", "arm-stamp", "fix-ctl"] as const;
const gapId = (k: string) => `fixture-sweep-${k}`;
const attempt = (k: string) => `att-fixture-${k}`;
const shas: Record<string, string> = {};
let ready = false;

beforeAll(() => {
  const repo = join(CLONES, VESSEL);
  mkdirSync(join(repo, "test", "checks"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "lane@example.com");
  git(repo, "config", "user.name", "Lane Fixture");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  for (const k of KEYS) {
    writeFileSync(join(repo, supplyMod.checkSupplyCheckPath(gapId(k))), `// the gap's own check, red by design (${k})\n`);
    if (k === "fix-ctl") writeFileSync(join(repo, "src", "fixture-target.ts"), "export const fixed = false;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `substrate-authored: ${k}\n\nGap: ${gapId(k)}\n\nAttempt-Id: ${attempt(k)}\n`);
    shas[k] = git(repo, "rev-parse", "HEAD");
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const rows = KEYS.map((k) => {
    const r = armedRow(gapId(k), {
      pending_outcome_verification: shas[k], pending_set_at: now,
      ...(k === "arm-stamp" ? {} : { disposition: "pending_verification" }),
    });
    return { ...r, category: `fixture_cat_${k.replace(/-/g, "_")}`, created_at: now, updated_at: now };
  });
  writeFileSync(GAPS_PATH, JSON.stringify(rows));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep once, in a fresh process bound to ROOT. Every test_suite check reads red (one requested test failing). */
function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  return new Response(JSON.stringify({ body: { ran: true, requested_not_passing: 1 } }), { status: 200 });`,
    `});`,
    `const ledger = await import(${JSON.stringify(LEDGER_MOD)});`,
    ...KEYS.map((k) => `ledger.appendRecord("attemptIntent", ${JSON.stringify(attempt(k))}, { attempt_id: ${JSON.stringify(attempt(k))}, route: "feature_compose", repo: "fixture", touched_files: [], gap_id: ${JSON.stringify(gapId(k))}, directed: false });`),
    `const glv = await import(${JSON.stringify(GLV)});`,
    `glv.__setAutoRevertDepsForTests({ unitStartedAt: () => 4_000_000_000, tuning: async () => null });`,
    `const __askHuman = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `const r = await glv.sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP_DONE " + JSON.stringify(r));`,
  ].join("\n");
  const env: Record<string, string> = {
    HOME: ROOT, PATH: BIN, WORKSPACE_ROOT: ROOT, VESSELS_CLONE_ROOT: CLONES, ATTEMPT_LEDGER_DIR: LEDGER,
    GAP_CLASS_POSTERIOR_PATH: POSTERIOR,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1", NODE_ENV: "test", TZ: "UTC",
  };
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr) };
}

describe("arming-only landing: the pending-land sweep never falsifies it (backstop for rows stamped before the stamp-site judgement)", () => {
  let run: ReturnType<typeof sweepInIsolation> | null = null;
  let byId = new Map<unknown, Row>();
  const runOnce = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = sweepInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Row[]).map((g) => [g.id, g]));
    return run;
  };
  const view = (k: string) => {
    const g = byId.get(gapId(k))!;
    const m = (g.classification_metadata ?? {}) as Row;
    return {
      status: g.status, regressed: m.regressed_by !== undefined && m.regressed_by !== null,
      unfavorable: JSON.stringify(g).includes("UNFAVORABLE"),
      pending: m.pending_outcome_verification ?? null, disposition: m.disposition ?? null,
      released: (m.pending_released as { reason?: unknown } | undefined)?.reason ?? null,
    };
  };
  const settlements = (k: string): number => {
    const f = join(LEDGER, "attemptSettlement.jsonl");
    if (!existsSync(f)) return 0;
    return readFileSync(f, "utf8").split("\n").filter((l) => l.includes(`"${attempt(k)}#2"`)).length;
  };
  const posteriorMisses = (): number => {
    if (!existsSync(POSTERIOR)) return 0;
    const p = JSON.parse(readFileSync(POSTERIOR, "utf8")) as Record<string, { beta: number }>;
    return Object.values(p).reduce((n, r) => n + (r.beta - 1), 0);
  };

  it("the real sweep ran", () => {
    const r = runOnce();
    expect({ exit: r.exit, ran: r.out.includes("SWEEP_DONE ") }, r.out.slice(-3000)).toEqual({ exit: 0, ran: true });
  });

  it("MUST-FAIL (c): an arming-only landing reading 'present' is not falsified: no regressed_by, no UNFAVORABLE, no #2 settlement", () => {
    const r = runOnce();
    for (const k of ["arm-held", "arm-stamp"]) {
      const v = view(k);
      expect({ k, regressed: v.regressed, unfavorable: v.unfavorable, settlements: settlements(k) }, r.out.slice(-3000)).toEqual({ k, regressed: false, unfavorable: false, settlements: 0 });
    }
  });

  it("MUST-FAIL (c): its stamp and pending_verification hold are released, the gap stays open, and the release names the reason", () => {
    const r = runOnce();
    const released = { status: "open", regressed: false, unfavorable: false, pending: "", released: "arming_only_landing" };
    expect({ held: { ...view("arm-held"), disposition: undefined }, stamp: { ...view("arm-stamp"), disposition: undefined } }, r.out.slice(-3000))
      .toEqual({ held: { ...released, disposition: undefined }, stamp: { ...released, disposition: undefined } });
    expect(view("arm-held").disposition === "pending_verification").toBe(false);
    expect(view("arm-stamp").disposition === "pending_verification").toBe(false);
  });

  it("CONTROL (c): a fix landing (the check plus a src change) reading 'present' is still falsified, with its settlement and one posterior miss", () => {
    const r = runOnce();
    const v = view("fix-ctl");
    expect({ regressed: v.regressed, settlements: settlements("fix-ctl") }, r.out.slice(-3000)).toEqual({ regressed: true, settlements: 1 });
    expect(r.out.includes(`FALSIFIED autonomous landing gap=${gapId("fix-ctl")}`)).toBe(true);
  });

  it("MUST-FAIL (c): the only class-posterior miss is the control's", () => {
    const r = runOnce();
    expect(posteriorMisses(), r.out.slice(-2000)).toBe(1);
  });
});
