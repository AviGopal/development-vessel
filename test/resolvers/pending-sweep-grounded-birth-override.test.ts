// A FIX THAT LANDED BEFORE ITS CHECK WAS BORN. A class-2 check is born by reading it on the tree of the day. When the
// fix landed first (an operator build that lands a fix with its own must-fail test, and a check armed on that test
// afterwards; or a re-arm after the fix went live), the check reads green at birth, the row is predicate_suspect, and
// the pending-land sweep refused it BEFORE the independent landing verdict that re-runs the check at the landing's
// parent and at the landed sha. Such a gap could never be closed by the system.
//
// Now: when the birth tree already holds the landing (git ancestry, not timestamps), the absent birth is what the
// landing explains, and the sweep's own grounded re-run in this pass (red at the parent, green at the landed sha)
// decides the close, written with close_basis "grounded_rerun". Nothing else overrides a suspect birth.
//
// Through the REAL sweep in a fresh process on a temp store and a temp vessel clone (the independent-landing-verdict
// harness: fetch stubbed per test_file and base_ref, so the default pinned runner is exercised):
//   MUST-FAIL  mf:       the check's test is committed first, the fix (src only) next, the check born absent on a
//                        later HEAD; red at the fix's parent, green at the fix => closed landed_verified, close_basis
//                        grounded_rerun.
//   CONTROL a  ctla:     born absent on the landing's PARENT (the landing is not in the birth tree) => stays suspect,
//                        and the re-run is not even taken.
//   CONTROL    nobirth:  born absent with no birth tree recorded => stays suspect (fail closed).
//   CONTROL    green:    re-run green at the parent as well (not red there) => not closed (released as a
//                        non-discriminating check, as any row is; its re-run is recorded).
//   CONTROL    redred:   re-run red at the landed sha => not closed.
//   CONTROL    partial:  the landing is stamped landed_unverified, so no re-run is taken => not closed.
//   CONTROL    trusted:  born present: closes as before, close_basis "absent" (the bases stay distinct).
//   CONTROL b  opclose:  an operator-written close is not counted by the verified-close counters (the holder's
//                        expectation calibration, AUTONOMOUS_CLOSE_REASONS, REALLY_FIXED_REASONS, reach attribution);
//                        the grounded close is (a must-fail case).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "./isolated-gap-store-run.js";
import * as g2fLanding from "../../src/judge/gap-landing-verdict.js";
import { class2PredicateKey } from "../../src/resolvers/substrate-gap.js";
import { AUTONOMOUS_CLOSE_REASONS, attributeReach } from "../../src/resolvers/goal-reach-tick.js";
import { REALLY_FIXED_REASONS } from "../../src/resolvers/detector-yield-registry.js";

const ROOT = join(tmpdir(), `pending-sweep-grounded-birth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const REPO = join(CLONES, "development-vessel");
const BIN = join(ROOT, "bin");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const CALIB = join(ROOT, "expectation-calibration.json");
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;
const SG = new URL("../../src/resolvers/substrate-gap.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
function commit(file: string, body: string, msg: string): string {
  const abs = join(REPO, file);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", msg);
  return git(REPO, "rev-parse", "HEAD");
}
const check = (k: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: `test/${k}.check.ts`, only_tests: [`gbo ${k}`] }, zero_field: "requested_not_passing" } });
const KEYS = ["mf", "ctla", "nobirth", "green", "redred", "partial", "trusted"] as const;
type Key = typeof KEYS[number];
const L: Record<string, { sha: string; parent: string }> = {};
let HEAD = "";
let ready = false;

beforeAll(() => {
  mkdirSync(join(REPO, "test"), { recursive: true });
  mkdirSync(BIN, { recursive: true });
  symlinkSync(Bun.which("git")!, join(BIN, "git"));
  symlinkSync(process.execPath, join(BIN, "bun"));
  git(REPO, "init", "-q");
  git(REPO, "config", "user.email", "test@test");
  git(REPO, "config", "user.name", "test");
  commit("README.md", "root\n", "root");
  for (const k of KEYS) {
    // The operator pattern: the must-fail test first (red), then the fix in src only, so the landing does not touch
    // its own instrument (the sweep's self-authored guard and the re-run's instrument guard stay as they are).
    commit(`test/${k}.check.ts`, `// gbo ${k}: red until src/${k}.ts is fixed\n`, `test: ${k} must-fail`);
    const parent = git(REPO, "rev-parse", "HEAD");
    const sha = commit(`src/${k}.ts`, `export const fixed_${k} = true;\n`, `fix: ${k}`);
    L[k] = { sha, parent };
  }
  HEAD = commit("NOTES.md", "a later unrelated commit: the check is armed after this\n", "later");
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const birth = (k: Key): Record<string, unknown> => {
    const c = check(k);
    const key = class2PredicateKey(c);
    if (k === "trusted") return { predicate_birth_verdict: "present", predicate_birth_key: key, predicate_birth_at: now, predicate_birth_sha: L[k]!.parent };
    if (k === "nobirth") return { predicate_birth_verdict: "absent", predicate_birth_key: key, predicate_birth_at: now };
    // ctla: born on the landing's parent, so the landing is NOT in the birth tree. Every other row: born on HEAD.
    const at = k === "ctla" ? L[k]!.parent : HEAD;
    return { predicate_birth_verdict: "absent", predicate_birth_key: key, predicate_birth_at: now, predicate_birth_sha: at, predicate_birth_queued_sha: at };
  };
  const rows: Array<Record<string, unknown>> = KEYS.map((k) => ({
    id: `gbo-${k}`, category: `gbo_cat_${k}`, source: "human_reported", summary: `grounded birth override ${k}`,
    detected_at: now, created_at: now, updated_at: now, status: "open",
    classification_metadata: {
      ...check(k), falsifier: "class2", edit_site: `repos/development-vessel/src/${k}.ts`,
      pending_outcome_verification: L[k]!.sha, pending_set_at: now, disposition: "pending_verification",
      ...birth(k),
      ...(k === "partial" ? { landed_unverified: true, landed_unverified_sha: L[k]!.sha } : {}),
    },
  }));
  rows.push({ id: "gbo-opclose", category: "gbo_cat_opclose", source: "human_reported", summary: "an operator closes this one by hand", detected_at: now, created_at: now, updated_at: now, status: "open", classification_metadata: {} });
  writeFileSync(GAPS_PATH, JSON.stringify(rows));
  writeFileSync(CALIB, JSON.stringify({}));
  ready = true;
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** The real sweep once, then an operator-written close, in a fresh process bound to ROOT. */
function runInIsolation(): { exit: number; out: string } {
  const code = [
    `const T = ${JSON.stringify(L)};`,
    `const HEAD = ${JSON.stringify(HEAD)};`,
    `globalThis.fetch = (async (_u, init) => {`,
    `  let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {}`,
    `  const p = b?.impulse?.pointer ?? {};`,
    `  if (p.type !== "test_suite") return new Response("{}", { status: 404 });`,
    `  const k = (String(p.test_file ?? "").match(/test\\/([a-z]+)\\.check\\.ts/) ?? [])[1] ?? "";`,
    `  const ref = typeof p.base_ref === "string" ? p.base_ref : "";`,
    // HEAD reads green for every row. Pinned: red at its own landing's parent, except green (never red) and
    // redred (red at the landed sha as well).
    `  const t = T[k];`,
    `  const red = !!t && ref !== "" && k !== "green" && (ref === t.parent || (k === "redred" && ref === t.sha));`,
    `  return new Response(JSON.stringify({ body: { ran: true, requested_not_passing: red ? 1 : 0 } }), { status: 200 });`,
    `});`,
    `const glv = await import(${JSON.stringify(GLV)});`,
    // The fix touches src/, so it is "running" only when the vessel serves it: pull-sync's last-good pin names HEAD.
    `glv.__setAutoRevertDepsForTests({ unitLoadState: () => "not-found", lastGood: () => HEAD });`,
    `const __askHuman = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `const r = await glv.sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
    `const sg = await import(${JSON.stringify(SG)});`,
    `const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", operator: "operator:gbo-test", gap: { id: "gbo-opclose", category: "gbo_cat_opclose", source: "human_reported", summary: "an operator closes this one by hand", status: "closed", classification_metadata: { closed_reason: "verified_by_operator_review", closed_by: "operator:gbo-test", resolution: "closed by an operator measurement" } } });`,
    `console.log("OPCLOSE " + JSON.stringify({ shape: w?.shape ?? null, action: w?.body?.action ?? null }));`,
  ].join("\n");
  const env: Record<string, string> = isolatedChildEnv(ROOT, {
    HOME: ROOT, PATH: BIN, VESSELS_CLONE_ROOT: CLONES, EXPECTATION_CALIB_PATH: CALIB,
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    NODE_ENV: "test", TZ: "UTC",
  });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + "\n" + new TextDecoder().decode(p.stderr) };
}

describe("pending-land sweep: a grounded re-run closes a fix that landed before its check was born", () => {
  it("MUST-FAIL (unit): the predicate holds only for an 'absent' birth for this very check, on a recorded birth tree that holds the landing", () => {
    expect(ready).toBe(true);
    const c = check("mf");
    const key = class2PredicateKey(c);
    const at = (extra: Record<string, unknown>) => ({ ...c, predicate_birth_verdict: "absent", predicate_birth_key: key, predicate_birth_sha: HEAD, ...extra });
    const prev = process.env["VESSELS_CLONE_ROOT"];
    process.env["VESSELS_CLONE_ROOT"] = CLONES;
    try {
      expect(g2fLanding.birthAbsentExplainedByLanding(at({}), L.mf!.sha)).toEqual({ birth_sha: HEAD });
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_sha: L.mf!.parent }), L.mf!.sha)).toBeNull();
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_sha: undefined, predicate_birth_queued_sha: HEAD }), L.mf!.sha)).toEqual({ birth_sha: HEAD });
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_sha: undefined }), L.mf!.sha)).toBeNull();
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_verdict: "unknown" }), L.mf!.sha)).toBeNull();
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_key: "another check" }), L.mf!.sha)).toBeNull();
      expect(g2fLanding.birthAbsentExplainedByLanding(at({ predicate_birth_sha: "f".repeat(40) }), L.mf!.sha)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = prev;
    }
  });

  let run: ReturnType<typeof runInIsolation> | null = null;
  let byId = new Map<unknown, Record<string, unknown>>();
  const runOnce = () => {
    if (run) return run;
    expect(ready).toBe(true);
    run = runInIsolation();
    byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    return run;
  };
  const view = (k: string) => {
    const g = byId.get(`gbo-${k}`)!;
    const m = g.classification_metadata as Record<string, unknown>;
    const l = m.goal_verification_label as { grounded?: unknown } | undefined;
    return { status: g.status, closed_reason: m.closed_reason ?? null, close_basis: m.close_basis ?? null, label: l ? l.grounded : null };
  };
  const handsFor = (reason: string): boolean => {
    const rec = { first_failure_at: null, dispatches: [], linked_ever: ["g"], reached_at: null, reached_dispatch_id: null, redispatch_triggers: [] };
    return attributeReach(rec as never, [{ id: "g", source: "substrate_detected", status: "closed", closed_reason: reason } as never], []).attribution === "hands";
  };
  const suspectLine = (out: string, k: string) => out.includes(`gap gbo-${k} reads absent but is NOT closed: predicate_suspect`);

  it("the real sweep ran, and the operator close was written", () => {
    const r = runOnce();
    expect({ exit: r.exit, swept: r.out.includes("SWEEP_RESULT "), opclose: /OPCLOSE \{"shape":"[^"]+","action":"updated"\}/.test(r.out) }, r.out.slice(-3000)).toEqual({ exit: 0, swept: true, opclose: true });
  });

  it("MUST-FAIL: the fix that landed before its check's birth is closed by the system on its grounded re-run", () => {
    const r = runOnce();
    expect(view("mf"), r.out.slice(-3000)).toEqual({ status: "closed", closed_reason: "landed_verified", close_basis: "grounded_rerun", label: true });
    const m = byId.get("gbo-mf")!.classification_metadata as Record<string, unknown>;
    expect({ landed_sha: m.landed_sha, explained: m.birth_absent_explained, closed_by: m.closed_by ?? null })
      .toEqual({ landed_sha: L.mf!.sha, explained: { landed: L.mf!.sha, parent: L.mf!.parent, birth_sha: HEAD }, closed_by: null });
    expect(suspectLine(r.out, "mf")).toBe(false);
  });

  it("MUST-FAIL: the re-run is taken for every suspect row whose birth tree holds its landing (and judged honestly)", () => {
    const r = runOnce();
    // green: green at the parent too; redred: red at the landed sha. Both labels are ungrounded records of the re-run.
    expect({ green: view("green").label, redred: view("redred").label }, r.out.slice(-3000)).toEqual({ green: false, redred: false });
  });

  it("MUST-FAIL: the grounded close is counted as a verified, autonomous close", () => {
    runOnce();
    const grounded = String((byId.get("gbo-mf")!.classification_metadata as Record<string, unknown>).closed_reason);
    const calib = existsSync(CALIB) ? JSON.parse(readFileSync(CALIB, "utf8")) as Record<string, { attempts: number; lands: number }> : {};
    expect(calib["gbo_cat_mf"]?.lands ?? 0).toBe(1);
    expect({ autonomous: AUTONOMOUS_CLOSE_REASONS.has(grounded), really_fixed: REALLY_FIXED_REASONS.has(grounded), hands: handsFor(grounded) }).toEqual({ autonomous: true, really_fixed: true, hands: false });
  });

  it("CONTROL (a): born absent on a tree WITHOUT the landing stays suspect, and its re-run is not taken", () => {
    const r = runOnce();
    expect(view("ctla"), r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, close_basis: null, label: null });
    expect(suspectLine(r.out, "ctla")).toBe(true);
  });

  it("CONTROL: born absent with no birth tree recorded stays suspect (fail closed)", () => {
    const r = runOnce();
    expect(view("nobirth"), r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, close_basis: null, label: null });
    expect(suspectLine(r.out, "nobirth")).toBe(true);
  });

  it("CONTROL: a re-run NOT red at the parent does not close (released as a non-discriminating check)", () => {
    const r = runOnce();
    const { label: _l, ...v } = view("green");
    expect(v, r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, close_basis: null });
  });

  it("CONTROL: a re-run red at the landed sha does not close", () => {
    const r = runOnce();
    const { label: _l, ...v } = view("redred");
    expect(v, r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, close_basis: null });
  });

  it("CONTROL: a landing that takes no re-run (landed_unverified) does not override a suspect birth", () => {
    const r = runOnce();
    expect(view("partial"), r.out.slice(-3000)).toEqual({ status: "open", closed_reason: null, close_basis: null, label: null });
    expect(suspectLine(r.out, "partial")).toBe(true);
  });

  it("CONTROL: a check born present closes as before, on close_basis absent", () => {
    const r = runOnce();
    expect(view("trusted"), r.out.slice(-3000)).toEqual({ status: "closed", closed_reason: "landed_verified", close_basis: "absent", label: true });
  });

  it("CONTROL (b): an operator-written close is not counted as a verified close", () => {
    runOnce();
    const op = byId.get("gbo-opclose")!;
    const opReason = String((op.classification_metadata as Record<string, unknown>).closed_reason);
    expect({ status: op.status, reason: opReason }).toEqual({ status: "closed", reason: "verified_by_operator_review" });
    // The holder's expectation calibration: a verified landing credits its category, an operator close never does.
    const calib = existsSync(CALIB) ? JSON.parse(readFileSync(CALIB, "utf8")) as Record<string, unknown> : {};
    expect(calib["gbo_cat_opclose"] ?? null).toBeNull();
    // The close-reason counters: reach attribution's autonomous closes and the detector registry's real fixes.
    expect({ autonomous: AUTONOMOUS_CLOSE_REASONS.has(opReason), really_fixed: REALLY_FIXED_REASONS.has(opReason), hands: handsFor(opReason) }).toEqual({ autonomous: false, really_fixed: false, hands: true });
  });
});
