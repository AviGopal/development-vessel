// A STAGED MITOSIS WHOSE GAP VERIFY FAILED IS NEVER CUT OVER ON TYPECHECK ALONE.
//
// Measured on node 1 (activity-api landing fb9a985): patch_with_tools staged a mitosis whose
// in-loop gate refused it (evaluate_refused:static_eval_unavailable); the same gap's attempt then
// FAILED its verify and the lane minted recommit-recommit-…-verify_failed-verify_failed. The staged
// root and its mitosis-pending.json survived ("change_window lease held — deferring cutover without
// rollback; preserving verified patch"), and the deferred mitosis-tick re-evaluated it with
// scripts=["typecheck"], cutover logged verdict=FAVORABLE cited_checks=["bun run typecheck"]
// cited_traces=0, and the change landed and pushed. The gap's class-2 test_suite check was never
// re-run against the tree that landed.
//
// These drive the REAL resolveVesselMitosisCutover through its git-aware path against a temp clone
// with a bare origin (no push, no restart, no live services): the gap store read and the test_suite
// run are the only stand-ins, injected through the cutover's own test seam. The whole-suite
// precutover gate (step 5d) is switched off so no live suite is ever started from here.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { resolveMaintenanceLeaseWrite } from "../../src/resolvers/maintenance-lease.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveVesselMitosisCutover } = cutoverMod;
type Deps = { readGap?: (p: Record<string, unknown>) => Promise<unknown>; writeGap?: (p: Record<string, unknown>) => Promise<unknown>; runSuite?: (p: Record<string, unknown>) => Promise<unknown> };
// Optional on purpose: on a tree without the seam the cutover runs its unpatched path, which is
// exactly the behaviour the RED tests below must expose (it lands).
const setDeps = (d: Deps | null): void => {
  (cutoverMod as unknown as { __setOwnCheckDepsForTests?: (d: Deps | null) => void }).__setOwnCheckDepsForTests?.(d);
};

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MITOSIS_CUTOVER_SKIP_SYSTEMCTL",
  "MITOSIS_DIRECT_PUSH",
  "MITOSIS_RUNTIME_DIR",
  "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE",
  "MITOSIS_HOST_REPO_ROOT",
  "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER",
  "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH",
  "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;

const VESSEL = "development-vessel";
const GAP = "gap-own-check-target";
const TEST_FILE = "test/resolvers/target.test.ts";
const OWN_TEST = "target > does what the gap asked";
const STAGED = "// patched by substrate\n";
const MVID = "mitosis-2026-10-02T23-30-03-248Z";

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "own-check-cut-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  process.env["CUTOVER_PRECHECK_SUITE"] = "0";
});

afterEach(async () => {
  setDeps(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  for (const r of extraRoots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function setup(): Promise<{ baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }> {
  const reposRoot = join(ws, "git", "super-repo", "repos");
  const baseRoot = join(reposRoot, VESSEL);
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-mitosis-2026-10-02T23-30-03-248Z`);
  await mkdir(join(baseRoot, "src", "resolvers"), { recursive: true });
  await mkdir(join(mitosisRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(baseRoot, "src", "index.ts"), "// base index\n");
  const live = "// original (live)\n";
  await writeFile(join(baseRoot, "src", "resolvers", "target.ts"), live);
  const baseSha = createHash("sha256").update(live).digest("hex").slice(0, 12);
  await writeFile(join(mitosisRoot, "src", "resolvers", "target.ts"), STAGED);
  const hostRepoRoot = join(ws, "host-repo");
  await mkdir(join(hostRepoRoot, "src", "resolvers"), { recursive: true });
  await writeFile(join(hostRepoRoot, "src", "resolvers", "target.ts"), "// original\n");
  spawnSync("git", ["init", "-b", "dev"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: hostRepoRoot });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: hostRepoRoot });
  spawnSync("git", ["add", "."], { cwd: hostRepoRoot });
  spawnSync("git", ["commit", "-m", "baseline"], { cwd: hostRepoRoot });
  const originRoot = join(ws, "host-origin.git");
  spawnSync("git", ["init", "--bare", "-b", "dev", originRoot]);
  spawnSync("git", ["remote", "add", "origin", originRoot], { cwd: hostRepoRoot });
  spawnSync("git", ["push", "-u", "origin", "dev"], { cwd: hostRepoRoot });
  // What patch_with_tools leaves behind: the shared queue lock naming this mitosis and its gap.
  const pendingPath = join(ws, "mitosis-pending.json");
  await writeFile(
    pendingPath,
    JSON.stringify({
      vessel_name: VESSEL,
      base_version_id: "v1",
      mitosis_version_id: MVID,
      mitosis_root: mitosisRoot,
      base_sha: baseSha,
      authored_by: "patch_with_tools",
      gap_id: GAP,
      proposal: GAP,
      staged_files: ["src/resolvers/target.ts"],
    }, null, 2),
  );
  return { baseRoot, mitosisRoot, hostRepoRoot, baseSha, pendingPath };
}

/** A second, independent fixture inside one test (fresh workspace root; the first is cleaned by afterEach too). */
async function setup2() {
  const prev = ws;
  ws = await mkdtemp(join(tmpdir(), "own-check-cut2-"));
  process.env["WORKSPACE_ROOT"] = ws;
  extraRoots.push(prev);
  return setup();
}
const extraRoots: string[] = [];

/** The pointer mitosis-tick builds for the deferred cutover: a static-only FAVORABLE citing typecheck alone. */
function deferredPointer(s: { baseRoot: string; mitosisRoot: string; hostRepoRoot: string; baseSha: string; pendingPath: string }) {
  return {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: s.mitosisRoot,
    base_root: s.baseRoot,
    host_repo_root: s.hostRepoRoot,
    staged_base_sha: s.baseSha,
    staged_files: ["src/resolvers/target.ts"],
    proposal_id: GAP,
    gap_id: GAP,
    pending_pointer_path: s.pendingPath,
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: {
      verdict: "FAVORABLE",
      verdict_reason: "static_checks_pass",
      base_success_rate: 1,
      mitosis_success_rate: 1,
      cited_trace_ids: [],
      cited_check_names: ["bun run typecheck"],
    },
    skip_push: true,
    skip_restart: true,
  };
}

const gapRow = {
  id: GAP,
  status: "open",
  category: "missing_capability",
  summary: "target does what the gap asked",
  classification_metadata: {
    falsifier: { class: "class2" },
    edit_site: `repos/${VESSEL}/src/resolvers/target.ts`,
    evidence_resolve: {
      shape: "test_suite",
      input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [OWN_TEST] },
      zero_field: "requested_not_passing",
    },
  },
};
const readGap = async (p: Record<string, unknown>) =>
  ({ shape: "substrateGap", body: { gaps: p["id"] === GAP ? [gapRow] : [] } });

function suiteBody(hostRepoRoot: string, over: Record<string, unknown>) {
  return { shape: "test_suite", body: { vessel: `repos/${VESSEL}`, verified_root: hostRepoRoot, ran: true, total: 1, pass: 1, fail: 0, skip: 0, requested_not_passing: 0, failingTests: [], ...over } };
}

async function headSubject(repo: string): Promise<string> {
  return spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("deferred cutover of a staged mitosis: the gap's own evidence, not typecheck alone", () => {
  it("(a) a staged mitosis whose gap verify FAILED is never cut over by the deferred path", async () => {
    const s = await setup();
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    // The record the lane leaves on the pending lock when the attempt's verify fails.
    const record = {
      unlandable: true,
      gap_id: `recommit-recommit-${GAP}-verify_failed`,
      pending_gap_id: GAP,
      mitosis_version_id: MVID,
      mitosis_root: s.mitosisRoot,
      failure_class: "verify_failed",
      reason: "the edited vessel must pass its own check after the change",
      at: new Date().toISOString(),
    };
    const pending = JSON.parse(await readFile(s.pendingPath, "utf8"));
    await writeFile(s.pendingPath, JSON.stringify({ ...pending, unlandable: record }));

    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refused"]).toBe(true);
    expect(body["refuse_class"]).toBe("staged_mitosis_unlandable");
    expect(String(body["refusal_reason"])).toContain("verify_failed");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    // The queue lock is released so the next staging is not blocked behind a tree that can never land.
    expect(await exists(s.pendingPath)).toBe(false);
  });

  it("(a') the lane's verify-failure writer marks the pending mitosis of the same gap lineage, and the cutover then refuses it", async () => {
    const s = await setup();
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const gate = await import("../../src/resolvers/staged-mitosis-gate.js");
    // The failing compose was for the recommit child (its own failure mints recommit-recommit-…):
    // the same defect on the same edit site as the gap the pending mitosis was staged for.
    const m = await gate.markOnComposeFailure(`recommit-${GAP}-verify_failed`, "verify_failed", "1 own test failing", s.pendingPath);
    expect(m.marked).toBe(true);
    expect(JSON.parse(await readFile(s.pendingPath, "utf8")).unlandable.failure_class).toBe("verify_failed");
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("staged_mitosis_unlandable");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });

  it("(b) a deferred cutover re-runs the gap's own class-2 check on the STAGED tree, cites it, and refuses when it fails", async () => {
    const s = await setup();
    const calls: Array<{ pointer: Record<string, unknown>; treeContent: string }> = [];
    setDeps({
      readGap,
      runSuite: async (p) => {
        calls.push({ pointer: p, treeContent: await readFile(join(s.hostRepoRoot, "src", "resolvers", "target.ts"), "utf8") });
        return suiteBody(s.hostRepoRoot, { pass: 0, fail: 1, requested_not_passing: 1, failingTests: [`(fail) ${OWN_TEST}`] });
      },
    });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(calls.length).toBe(1);
    expect(calls[0]!.pointer["test_file"]).toBe(TEST_FILE);
    expect(calls[0]!.pointer["only_tests"]).toEqual([OWN_TEST]);
    expect(calls[0]!.pointer["base_ref"]).toBeUndefined();          // the working tree, not a committed base
    expect(calls[0]!.treeContent).toBe(STAGED);                      // measured with the staged change in place
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refuse_class"]).toBe("own_check_failed");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    // The reason is recorded on the refusal, and the staged tree is discarded from the queue so no
    // later tick re-evaluates it on typecheck alone.
    expect(String(body["refusal_reason"])).toContain("1/1 requested test(s) not passing");
    expect(await exists(s.pendingPath)).toBe(false);
  });

  it("(b'') an unsubstituted template gap_id from mitosis-tick still finds the gap's own check through the pending file", async () => {
    const s = await setup();
    let asked: unknown = null;
    setDeps({
      readGap: async (p) => { asked = p["id"]; return readGap(p); },
      runSuite: async () => suiteBody(s.hostRepoRoot, { pass: 0, fail: 1, requested_not_passing: 1 }),
    });
    const r = await resolveVesselMitosisCutover({ ...deferredPointer(s), gap_id: "{{extract_gap_id_content}}" } as never);
    expect(asked).toBe(GAP);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_failed");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });

  it("(b') an own check that could not be measured refuses the landing instead of passing it", async () => {
    const s = await setup();
    setDeps({ readGap, runSuite: async () => ({ shape: "structuredError", body: { detail: "no shellResult producer in discovery" } }) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(body["refuse_class"]).toBe("own_check_unmeasurable");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    expect(String(body["refusal_reason"])).toContain("could not be measured");
  });

  it("(c) positive control: a staged patch whose verify passed still cuts over after a change_window deferral", async () => {
    const s = await setup();
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    // First tick: another holder has the change window → the cutover defers, preserving the patch.
    const acq = await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "acquire", name: "cutover", holder: "trace-store-reconcile", ttl_ms: 60_000 } as never);
    const token = (acq.body as { token?: string }).token;
    expect(typeof token).toBe("string");
    const first = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(first.shape).toBe("vesselMitosisCutoverResult");
    expect(String((first.body as Record<string, unknown>)["refusal_reason"])).toContain("change_window");
    expect(await exists(s.pendingPath)).toBe(true);
    await resolveMaintenanceLeaseWrite({ type: "maintenanceLease_write", op: "release", name: "cutover", token } as never);
    // Next tick: the window is free and the gap's own check passes on the staged tree → it lands.
    const second = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(second.shape).toBe("cutoverApplied");
    expect(await headSubject(s.hostRepoRoot)).not.toBe("baseline");
    expect(await readFile(join(s.hostRepoRoot, "src", "resolvers", "target.ts"), "utf8")).toBe(STAGED);
  });

  it("(c') the landing cites the own check it re-ran", async () => {
    const s = await setup();
    let ran = 0;
    setDeps({ readGap, runSuite: async () => { ran++; return suiteBody(s.hostRepoRoot, {}); } });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(ran).toBe(1);
    const ops = (r.body as { operations: Array<{ op: string; status: string; detail?: string }> }).operations;
    const own = ops.find((o) => o.op === "own_check");
    expect(own?.status).toBe("ok");
    expect(own?.detail ?? "").toContain(OWN_TEST);
  });

  it("(d) a SKIPPED own test is not a passing own test, even when requested_not_passing reads 0", async () => {
    const s = await setup();
    // requested_not_passing counts names by substring over (pass) lines, so a skipped requested test
    // can read 0 when another passing title contains it; the skip count is what says it did not run.
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, { pass: 1, skip: 1, requested_not_passing: 0 }) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_failed");
    expect(String((r.body as Record<string, unknown>)["refusal_reason"])).toContain("SKIPPED");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });

  it("(d') zero tests ran is not a pass", async () => {
    const s = await setup();
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, { total: 0, pass: 0, requested_not_passing: 0 }) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_failed");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });
});

describe("own-check gate: store outage, counters, unverified landings", () => {
  const counters = (): Record<string, number> =>
    ((cutoverMod as unknown as { getOwnCheckCounters?: () => Record<string, number> }).getOwnCheckCounters?.() ?? {});

  it("a gap-store OUTAGE defers the cutover (gap_store_unavailable), keeps the pending lock for the next tick, and does not land", async () => {
    const s = await setup();
    let ran = 0;
    setDeps({
      readGap: async () => { throw new Error("gaps.json could not be loaded or parsed"); },
      runSuite: async () => { ran++; return suiteBody(s.hostRepoRoot, {}); },
    });
    const before = counters()["gap_store_unavailable"] ?? 0;
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    const body = r.body as Record<string, unknown>;
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refuse_class"]).toBe("gap_store_unavailable");
    expect(body["deferred"]).toBe(true);
    expect(ran).toBe(0);
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    expect(await exists(s.pendingPath)).toBe(true);           // retried next tick, not discarded
    expect(counters()["gap_store_unavailable"]).toBe(before + 1);
  });

  it("an answer that is not a substrateGap read is an outage too, not 'no check'", async () => {
    const s = await setup();
    setDeps({ readGap: async () => ({ shape: "structuredError", body: { detail: "GAP_STORE_ENDPOINT unreachable" } }), runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("gap_store_unavailable");
    expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
  });

  it("own_check_failed and own_check_unmeasurable are counted separately", async () => {
    const s = await setup();
    const c0 = counters();
    setDeps({ readGap, runSuite: async () => suiteBody(s.hostRepoRoot, { pass: 0, fail: 1, requested_not_passing: 1 }) });
    await resolveVesselMitosisCutover(deferredPointer(s) as never);
    const s2 = await setup2();
    setDeps({ readGap, runSuite: async () => ({ shape: "structuredError", body: { detail: "no shell" } }) });
    await resolveVesselMitosisCutover(deferredPointer(s2) as never);
    const c1 = counters();
    expect(c1["own_check_failed"]).toBe((c0["own_check_failed"] ?? 0) + 1);
    expect(c1["own_check_unmeasurable"]).toBe((c0["own_check_unmeasurable"] ?? 0) + 1);
  });

  it("a typecheck-only landing (gap with no row, e.g. a synthesized pwt id) still lands but is stamped landed_unverified in its landing record", async () => {
    const s = await setup();
    let ran = 0;
    setDeps({ readGap: async () => ({ shape: "substrateGap", body: { gaps: [] } }), runSuite: async () => { ran++; return suiteBody(s.hostRepoRoot, {}); } });
    const before = counters()["landed_unverified"] ?? 0;
    const r = await resolveVesselMitosisCutover({ ...deferredPointer(s), gap_id: "pwt-development-vessel-target.ts-1a2b3c4d" } as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(ran).toBe(0);
    const body = r.body as Record<string, unknown>;
    expect(body["landed_unverified"]).toBe(true);
    expect(String(body["landed_unverified_reason"])).toContain("no gap row");
    expect(body["own_check_verified"]).toBeUndefined();
    // The durable landing record (mitosis-applied.jsonl) carries the same stamp.
    const line = JSON.parse((await readFile(join(ws, "mitosis-applied.jsonl"), "utf8")).trim().split("\n").pop()!);
    expect(line.body.landed_unverified).toBe(true);
    expect(counters()["landed_unverified"]).toBe(before + 1);
  });

  it("a gap whose row carries no test_suite check is landed_unverified too; a verified landing is not", async () => {
    const s = await setup();
    const noCheck = { ...gapRow, classification_metadata: { falsifier: "none" } };
    setDeps({ readGap: async () => ({ shape: "substrateGap", body: { gaps: [noCheck] } }), runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect((r.body as Record<string, unknown>)["landed_unverified"]).toBe(true);
    const s2 = await setup2();
    setDeps({ readGap, runSuite: async () => suiteBody(s2.hostRepoRoot, {}) });
    const v = await resolveVesselMitosisCutover(deferredPointer(s2) as never);
    expect(v.shape).toBe("cutoverApplied");
    expect((v.body as Record<string, unknown>)["landed_unverified"]).toBeUndefined();
    expect((v.body as Record<string, unknown>)["own_check_verified"]).toBe(true);
  });
});

describe("own check that cannot be measured: counted on the gap, and at N routed to check repair", () => {
  // An in-memory gap store with the real store's merge rule (omitted classification_metadata keys carry
  // forward; a key sent, even null, replaces) and its real falsifier classifier re-stamping on write.
  async function memStore(initial: Record<string, unknown>) {
    const { classifyFalsifier } = await import("../../src/resolvers/substrate-gap.js");
    const rows = new Map<string, Record<string, unknown>>([[String(initial["id"]), JSON.parse(JSON.stringify(initial))]]);
    const writes: Array<Record<string, unknown>> = [];
    return {
      rows,
      writes,
      readGap: async (p: Record<string, unknown>) => ({ shape: "substrateGap", body: { gaps: rows.has(String(p["id"])) ? [JSON.parse(JSON.stringify(rows.get(String(p["id"]))))] : [] } }),
      writeGap: async (p: Record<string, unknown>) => {
        const g = p["gap"] as Record<string, unknown>;
        writes.push(JSON.parse(JSON.stringify(g)));
        const ex = rows.get(String(g["id"])) ?? {};
        const inMeta = { ...((g["classification_metadata"] ?? {}) as Record<string, unknown>) };
        const exMeta = (ex["classification_metadata"] ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(exMeta)) if (!(k in inMeta)) inMeta[k] = exMeta[k];
        inMeta["falsifier"] = classifyFalsifier(inMeta).falsifier;
        rows.set(String(g["id"]), { ...ex, ...g, classification_metadata: inMeta });
        return { shape: "substrateGapWriteResult", body: { ok: true } };
      },
    };
  }
  const meta = (st: { rows: Map<string, Record<string, unknown>> }) => (st.rows.get(GAP)!["classification_metadata"] ?? {}) as Record<string, unknown>;
  const MISSING = "target > a test that was renamed away";
  const missingRow = {
    ...gapRow,
    classification_metadata: {
      ...gapRow.classification_metadata,
      falsifier: "class2",
      evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: TEST_FILE, only_tests: [MISSING] }, zero_field: "requested_not_passing" },
    },
  };

  // THE REAL test_suite RESOLVER, with only the network stood in: discovery names a shell producer, and the
  // shell answers with bun's actual output for a -t filter that matches no test (captured from bun 1.3.14).
  const originalFetch = globalThis.fetch;
  function bunNoMatchShell(hostRepoRoot: string): void {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [{ endpoint: "http://shell.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (url.startsWith("http://shell.fixture")) {
        return Response.json({ stdout: `VERIFIED_ROOT=${hostRepoRoot}\nVERIFIED_HEAD=abc1234\nbun test v1.3.14 (0d9b296a)\n\n${TEST_FILE}:\n\nerror: regex "${MISSING.replace(" > ", " ")}" matched 0 tests. Searched 1 file (skipping 1 test) [25.00ms]\n` });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
  }
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("a gap whose only_tests names a non-existent test, cut over twice, leaves own_check_unmeasurable_count=2 on the gap row", async () => {
    const st = await memStore(missingRow);
    for (let i = 1; i <= 2; i++) {
      const s = i === 1 ? await setup() : await setup2();
      bunNoMatchShell(s.hostRepoRoot);
      setDeps({ readGap: st.readGap, writeGap: st.writeGap });           // runSuite: the real resolveTestSuite
      const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
      expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_unmeasurable");
      expect(await headSubject(s.hostRepoRoot)).toBe("baseline");
    }
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(2);
    expect(String(meta(st)["own_check_last_reason"])).toContain("did not run");
    expect(typeof meta(st)["own_check_last_at"]).toBe("string");
    // Merge-style: only the bookkeeping keys were sent; the check itself is still the gap's.
    expect(Object.keys(st.writes[1]!["classification_metadata"] as object).sort()).toEqual(["own_check_last_at", "own_check_last_reason", "own_check_unmeasurable_count"]);
    expect(meta(st)["falsifier"]).toBe("class2");
  });

  it(`at N=3 the escalation is recorded and the gap is routed to check repair (gap_falsify), not recompose; a staged tree for it then refuses as under repair`, async () => {
    const { OWN_CHECK_UNMEASURABLE_ESCALATE_AT } = await import("../../src/resolvers/staged-mitosis-gate.js");
    const { isFalsifierSupplyCandidate } = await import("../../src/resolvers/gap-lifecycle-scan.js");
    expect(OWN_CHECK_UNMEASURABLE_ESCALATE_AT).toBe(3);
    const st = await memStore(missingRow);
    const supply = () => isFalsifierSupplyCandidate(st.rows.get(GAP)! as never, () => false, () => true);
    expect(supply()).toBe(false);                                       // a class2 gap is not in the re-derivation backlog
    let last: Record<string, unknown> = {};
    for (let i = 1; i <= 3; i++) {
      const s = i === 1 ? await setup() : await setup2();
      bunNoMatchShell(s.hostRepoRoot);
      setDeps({ readGap: st.readGap, writeGap: st.writeGap });
      last = (await resolveVesselMitosisCutover(deferredPointer(s) as never)).body as Record<string, unknown>;
    }
    expect(last["own_check_escalated"]).toBe(true);
    expect(String(last["refusal_reason"])).toContain("demoted for re-derivation");
    const m = meta(st);
    expect(m["own_check_unmeasurable_count"]).toBe(3);
    expect(m["evidence_resolve"]).toBeNull();
    expect(m["falsifier"]).toBe("none");                                // the store's classifier re-stamped it
    expect((m["own_check_broken"] as Record<string, unknown>)["evidence_resolve"]).toEqual(missingRow.classification_metadata.evidence_resolve);
    // The reader: gap_falsify's supply backlog now takes it (parent_check re-derivation), and contained
    // admission (require_falsifier_classes) no longer admits it to compose.
    expect(supply()).toBe(true);
    // The next cutover for this gap does not land typecheck-only while the check is in repair.
    const s4 = await setup2();
    let ran = 0;
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => { ran++; return suiteBody(s4.hostRepoRoot, {}); } });
    const next = await resolveVesselMitosisCutover(deferredPointer(s4) as never);
    expect((next.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_under_repair");
    expect(ran).toBe(0);
    expect(await headSubject(s4.hostRepoRoot)).toBe("baseline");
  });

  it("a measured FAIL resets the count", async () => {
    const st = await memStore(missingRow);
    for (let i = 1; i <= 2; i++) {
      const s = i === 1 ? await setup() : await setup2();
      bunNoMatchShell(s.hostRepoRoot);
      setDeps({ readGap: st.readGap, writeGap: st.writeGap });
      await resolveVesselMitosisCutover(deferredPointer(s) as never);
    }
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(2);
    globalThis.fetch = originalFetch;
    const s3 = await setup2();
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s3.hostRepoRoot, { pass: 0, fail: 1, requested_not_passing: 1 }) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s3) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_failed");
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(0);
    expect(meta(st)["evidence_resolve"]).not.toBeNull();
    // A later unmeasurable run starts the count again from 1, so N means N IN A ROW.
    const s4 = await setup2();
    bunNoMatchShell(s4.hostRepoRoot);
    setDeps({ readGap: st.readGap, writeGap: st.writeGap });
    await resolveVesselMitosisCutover(deferredPointer(s4) as never);
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(1);
  });

  it("a run that measured a DIFFERENT tree neither counts toward demotion nor resets the count", async () => {
    const st = await memStore({ ...gapRow, classification_metadata: { ...gapRow.classification_metadata, falsifier: "class2", own_check_unmeasurable_count: 2 } });
    const s = await setup();
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody("/somewhere/else", {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect((r.body as Record<string, unknown>)["refuse_class"]).toBe("own_check_unmeasurable");
    expect(st.writes.length).toBe(0);
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(2);
  });

  it("a measured PASS resets the count too (and the landing proceeds)", async () => {
    const st = await memStore({ ...gapRow, classification_metadata: { ...gapRow.classification_metadata, falsifier: "class2", own_check_unmeasurable_count: 2 } });
    const s = await setup();
    setDeps({ readGap: st.readGap, writeGap: st.writeGap, runSuite: async () => suiteBody(s.hostRepoRoot, {}) });
    const r = await resolveVesselMitosisCutover(deferredPointer(s) as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(meta(st)["own_check_unmeasurable_count"]).toBe(0);
  });
});

describe("staged-mitosis-gate primitives", () => {
  it("gapLineageRoot strips each recommit- prefix with its trailing failure class", async () => {
    const { gapLineageRoot, sameGapLineage } = await import("../../src/resolvers/staged-mitosis-gate.js");
    expect(gapLineageRoot("recommit-recommit-route-edit-e32a5778-verify_failed-verify_failed")).toBe("route-edit-e32a5778");
    expect(gapLineageRoot("recommit-route-edit-e32a5778-anchor_not_found")).toBe("route-edit-e32a5778");
    expect(gapLineageRoot("route-edit-e32a5778")).toBe("route-edit-e32a5778");
    expect(sameGapLineage("recommit-gap-a-verify_failed", "gap-a")).toBe(true);
    expect(sameGapLineage("recommit-gap-a-verify_failed", "gap-b")).toBe(false);
    expect(sameGapLineage("", "")).toBe(false);
  });

  it("markOnComposeFailure only marks for verify-stage classes and only the same lineage", async () => {
    const s = await setup();
    const { markOnComposeFailure } = await import("../../src/resolvers/staged-mitosis-gate.js");
    expect((await markOnComposeFailure(GAP, "anchor_not_found", "x", s.pendingPath)).marked).toBe(false);
    expect((await markOnComposeFailure("some-other-gap", "verify_failed", "x", s.pendingPath)).marked).toBe(false);
    expect(JSON.parse(await readFile(s.pendingPath, "utf8")).unlandable).toBeUndefined();
    const m = await markOnComposeFailure(GAP, "syntax_break", "TS1005", s.pendingPath);
    expect(m.marked).toBe(true);
    const pending = JSON.parse(await readFile(s.pendingPath, "utf8"));
    expect(pending.unlandable.failure_class).toBe("syntax_break");
    expect(pending.unlandable.reason).toBe("TS1005");
  });

  it("judgeOwnCheck: skip, no summary, zero passes and unreported counts are never a pass", async () => {
    const { judgeOwnCheck } = await import("../../src/resolvers/staged-mitosis-gate.js");
    const ok = { ran: true, pass: 1, fail: 0, skip: 0, requested_not_passing: 0 };
    expect(judgeOwnCheck(ok, ["t"]).pass).toBe(true);
    expect(judgeOwnCheck({ ...ok, skip: 1 }, ["t"])).toMatchObject({ pass: false, measured: true });
    expect(judgeOwnCheck({ ...ok, ran: false }, ["t"])).toMatchObject({ pass: false, measured: false });
    expect(judgeOwnCheck({ ...ok, pass: 0 }, ["t"])).toMatchObject({ pass: false, measured: true });
    expect(judgeOwnCheck({ ...ok, requested_not_passing: null }, ["t"])).toMatchObject({ pass: false, measured: true });
    expect(judgeOwnCheck({ ...ok, requested_not_passing: 1 }, ["t"]).pass).toBe(false);
    expect(judgeOwnCheck(null, ["t"])).toMatchObject({ pass: false, measured: false });
  });
});
