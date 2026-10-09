// A STAGED EDIT BUILT ON A STALE BASE NEVER OVERWRITES NEWER COMMITTED WORK (check-first).
//
// Regression class A of the landing cutover: a cutover lands content that was built on an older
// base over work committed AFTER that base, and the commit silently reverts it. Observed four
// times (6ab8271 reverted a0ff3d3; 21179d8 deleted 51e30de; 98bc2b5 reverted afc7d6d; 2dbb4a6
// reverted 14 lines). The cutover copies each staged file WHOLESALE into the push clone, so any
// line that changed in that file after the staged base is reverted by the copy.
//
// The hole this pins: the commit-tree freshness check exempts a push clone that is "clean at its
// own HEAD" (cloneIsCleanAtHead), reasoning that a clean clone has nothing uncommitted to lose.
// But a clean clone at a NEWER HEAD has committed work to lose: when the clone has fast-forwarded
// to N while the staged edit was computed against B, the exemption compares nothing against HEAD
// and the stale copy lands over N. The existing commit-tree tests use a non-git clone directory,
// so `git show HEAD:<file>` fails there and the exemption is never exercised; these use a real
// clone of a real bare origin.
//
// A second route to the same revert: the check reads the clone BEFORE the cutover's clean-slate
// fetch + `reset --hard origin/dev`, so a clone still at B passes, is moved to N, and the copy lands
// over N. And the reset was handed staged_base_sha — a 12-char FILE-CONTENT hash, not a revision.
// The 08-29 control pins the other side: a base matching NO committed version of the file is a
// staging artefact (the 09-24 deadlock class) and must still proceed.
//
// WHY THE RUNTIME TREE LAGS AT B (do not "fix" the fixture by moving it to N): in production the
// primary freshness gate reads the deployed runtime tree (MITOSIS_RUNTIME_DIR/<vessel>), which
// trails the push clone by a pull-sync cycle — that lag is how every instance above passed the
// primary gate. If the runtime tree were also at N the primary gate would refuse and the
// must-fail would go green for a reason unrelated to the exemption.
//
// Drives the REAL resolveVesselMitosisCutover through its git-aware path, with baseRoot and
// hostRepoRoot derived from MITOSIS_DIRECT_PUSH / MITOSIS_RUNTIME_DIR / MITOSIS_PUSH_CLONE_DIR the
// way the running vessel derives them. Hermetic: temp dirs, a temp bare origin, no push
// (skip_push), no restart, and the gap-store read / suite run injected through the cutover's own
// test seam. The pre-cutover suite is NOT switched off by env (that kill switch is being removed):
// its network goes through the shared cutover fetch guard, where discovery names a fixture shell
// answering with a passing bun run. So every fixture here is MEASURED (suite ran=true), and a
// refusal can only be for the reason each test names: the MUST-FAILs assert the specific
// refuse_class the stale-base fix uses (stale_base_superseded), never a bare "refused", so they
// cannot pass as no_measurement_available or any other refusal. Any unstubbed URL fails the test.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, routeFleetUnreachable, routeShell, BUN_PASSING, BUN_NO_TESTS, type FetchGuard, routeFixtureGapStore, FIXTURE_GAP_STORE, restoreCutoverFetch } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";

const { resolveVesselMitosisCutover, __setOwnCheckDepsForTests } = cutoverMod;

const ENV_KEYS = [
  "WORKSPACE_ROOT",
  "MITOSIS_CUTOVER_SKIP_SYSTEMCTL",
  "MITOSIS_DIRECT_PUSH",
  "MITOSIS_RUNTIME_DIR",
  "MITOSIS_PUSH_CLONE_DIR",
  "MITOSIS_HOST_SYNC_MODE",
  "MITOSIS_HOST_REPO_ROOT",
  "MITOSIS_SKIP_CLONE_RESET",
  "MITOSIS_STAGED_MAX_AGE_MS",
  "PUSH_POLICY_PATH",
  "SUBSTRATE_REPO_OWNER",
  "CUTOVER_PRECHECK_SUITE",
  "MAINTENANCE_LEASE_PATH",
  "GAP_STORE_ENDPOINT",
] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let guard: FetchGuard;
let fsGuard: FsGuard;
// Backstop: whatever happened in this file, the next file in the same bun process gets the real
// fs and fetch (bun's mock.restore() does not undo mock.module; see cutover-fs-guard.ts).
afterAll(() => {
  restoreCutoverFsModules();
  restoreCutoverFetch();
});
/** Pre-cutover suite runs: shell calls made before the cutover's own commit exists in the push clone. */
let precheckRuns = 0;

const VESSEL = "development-vessel";
const MVID = "mitosis-2026-10-02T00-00-00-000Z";
const F = "src/resolvers/target.ts";
const G = "src/resolvers/unrelated.ts";

// B: the base the staged edit was computed against.
const F_AT_B = "// target module\nexport const alpha = 1;\nexport const beta = 2;\n";
// The staged edit, built on B: changes beta.
const F_STAGED = "// target module\nexport const alpha = 1;\nexport const beta = 3;\n";
// N: newer committed work on the same file, landed after B.
const NEWER_LINE = "export const newerCommittedWork = true;";
const F_AT_N = `${F_AT_B}${NEWER_LINE}\n`;
const G_AT_B = "// unrelated module\nexport const gamma = 1;\n";
const G_AT_N = "// unrelated module\nexport const gamma = 1;\nexport const gammaNewer = true;\n";

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
function gitIdentity(cwd: string): void {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "cutover-stale-base-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["MITOSIS_CUTOVER_SKIP_SYSTEMCTL"] = "1";
  process.env["PUSH_POLICY_PATH"] = join(ws, "no-push-policy.json");
  // The production layout: the primary freshness gate reads the runtime tree, the commit lands in
  // the push clone.
  process.env["MITOSIS_DIRECT_PUSH"] = "1";
  process.env["MITOSIS_RUNTIME_DIR"] = join(ws, "runtime");
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  const fail = (what: string) => async () => { throw new Error(`${what} must not be reached from this test`); };
  __setOwnCheckDepsForTests({
    readGap: async () => ({ shape: "substrateGap", body: { gaps: [] } }),
    writeGap: fail("gap write"),
    runSuite: fail("test_suite run"),
  });
  guard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // never the module-load-captured store
  routeFixtureGapStore(guard);
  routeFleetUnreachable(guard);
  precheckRuns = 0;
  // The measurement: the pre-cutover suite runs and passes.
  // Only the PRE-cutover call (landing clone still at its baseline commit) answers ran=true. Once
  // the cutover's commit exists, the post-land suite gets a no-summary answer (ran=false): a
  // post-land ran=true writes /workspace/post-land-baseline/<vessel>.json (an absolute path), and on
  // a substrate node that would replace the real baseline with this fixture's empty failure list.
  routeShell(guard, () => {
    const r = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: join(ws, "git", "vessels", VESSEL), encoding: "utf8" });
    if (String(r.stdout).startsWith("substrate-authored")) return BUN_NO_TESTS;
    precheckRuns++;
    return BUN_PASSING;
  });
});

afterEach(async () => {
  const violations = guard.restore();
  const fsViolations = fsGuard.restore();
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  expect(violations).toEqual([]);               // last, so a violation never skips the cleanup above
  expect(fsViolations).toEqual([]);
});

// none: no newer commit. same_file / unrelated_file: N is pushed and the clone fast-forwards to it.
// same_file_unpulled: N (to F) is pushed but the clone has NOT fetched it yet — it still sits at B
// when the commit-tree check reads it, and only the cutover's own fetch + reset brings it to N.
// same_file_reverted: N (to F) is followed by R, an operator revert that restores F to exactly B's
// content; the clone fast-forwards to R. F has newer COMMITS but no newer CONTENT.
type Newer = "none" | "same_file" | "unrelated_file" | "same_file_unpulled" | "same_file_reverted";

// The 08-29 shape: the staging leg recorded its base from a runtime tree that a previous attempt
// had transiently patched, so staged_base_sha is the hash of content NO commit ever held.
const F_PATCHED_NEVER_COMMITTED = "// target module\nexport const alpha = 1;\nexport const beta = 2; // transient patch\n";

/** A git_cmd that records each argv (one line per call, args joined by US) then runs real git. */
async function recordingGit(): Promise<{ cmd: string; calls: () => Promise<string[][]> }> {
  const log = join(ws, "git-argv.log");
  const cmd = join(ws, "recording-git.sh");
  await writeFile(cmd, `#!/bin/sh\n{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}\nexec git "$@"\n`);
  await chmod(cmd, 0o755);
  return {
    cmd,
    calls: async () => {
      let raw = "";
      try { raw = await readFile(log, "utf8"); } catch { /* no calls */ }
      return raw.split("\n").filter(Boolean).map((l) => l.split("\u001f").filter((a, i, all) => i < all.length - 1 || a !== ""));
    },
  };
}

/**
 * Bare origin with base commit B; the live push clone at MITOSIS_PUSH_CLONE_DIR/<vessel>; a staged
 * mitosis of F computed against B; optionally a newer commit N pushed by another writer and
 * fast-forwarded into the live clone, which is left clean at HEAD.
 */
async function setup(newer: Newer, opts: { base?: "committed_B" | "uncommitted_patch"; newerGap?: string } = {}) {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);

  const seed = join(ws, "seed");
  await put(seed, F, F_AT_B);
  await put(seed, G, G_AT_B);
  git(ws, "init", "-b", "dev", seed);
  gitIdentity(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "dev");
  const shaB = git(seed, "rev-parse", "HEAD");

  const clone = join(ws, "git", "vessels", VESSEL);
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, clone);
  gitIdentity(clone);

  // The runtime tree lags at B (see the header: this is how the primary gate passes). In the 08-29
  // shape it holds the transient patch the staging leg hashed as its base.
  const baseContent = opts.base === "uncommitted_patch" ? F_PATCHED_NEVER_COMMITTED : F_AT_B;
  const runtime = join(ws, "runtime", VESSEL);
  await put(runtime, F, baseContent);
  await put(runtime, G, G_AT_B);

  // The staged mitosis: only F, computed against B.
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await put(mitosisRoot, F, F_STAGED);

  let shaN = shaB;
  if (newer !== "none") {
    const other = join(ws, "other-writer");
    git(ws, "clone", "-q", "-b", "dev", origin, other);
    gitIdentity(other);
    if (newer !== "unrelated_file") await put(other, F, F_AT_N);
    else await put(other, G, G_AT_N);
    git(other, "add", ".");
    git(other, "commit", "-m", `N: newer work on ${newer === "unrelated_file" ? G : F}${opts.newerGap ? `\n\nGap: ${opts.newerGap}` : ""}`);
    if (newer === "same_file_reverted") {
      await put(other, F, F_AT_B);
      git(other, "add", ".");
      git(other, "commit", "-m", "R: revert N; F is B's content again");
    }
    git(other, "push", "origin", "dev");
    shaN = git(other, "rev-parse", "HEAD");
    if (newer !== "same_file_unpulled") git(clone, "pull", "-q", "--ff-only", "origin", "dev");
  }
  // The precondition the exemption keys on: the clone is clean and sits at its origin/dev ref —
  // N when it has pulled, still B when N has not been fetched yet.
  const cloneAt = newer === "same_file_unpulled" ? shaB : shaN;
  expect(git(clone, "status", "--porcelain")).toBe("");
  expect(git(clone, "rev-parse", "HEAD")).toBe(cloneAt);
  expect(git(clone, "rev-parse", "origin/dev")).toBe(cloneAt);

  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: mitosisRoot,
    staged_base_sha: sha12(baseContent),
    staged_base_shas: { [F]: sha12(baseContent) },
    staged_files: [F],
    pending_pointer_path: join(ws, "mitosis-pending.json"),
    applied_log_path: join(ws, "mitosis-applied.jsonl"),
    evaluation_evidence: {
      verdict: "FAVORABLE",
      verdict_reason: "static_checks_pass",
      base_success_rate: 1,
      mitosis_success_rate: 1,
      cited_trace_ids: [],
      cited_check_names: ["bun run typecheck"],
    },
    // No gap/proposal provenance: `adhoc` lands without one, so no post-land gap-store read or
    // stamp is attempted (that store is not under this test's temp root). The freshness checks this
    // file is about run before provenance is consulted.
    adhoc: true,
    skip_push: true,
    skip_restart: true,
  };
  return { clone, shaB, shaN, pointer };
}

describe("cutover class A: a stale-base staged edit never overwrites newer committed work", () => {
  it("MUST-FAIL: refuses a staged edit built on B when the clean clone's HEAD carries a newer commit to the same file", async () => {
    const s = await setup("same_file");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = (r.body ?? {}) as Record<string, unknown>;
    const headF = git(s.clone, "show", `HEAD:${F}`);
    // The damage, named: the newer committed line must survive in the commit tree.
    expect({ head_still_has_newer_work: headF.includes(NEWER_LINE), head: git(s.clone, "rev-parse", "HEAD") })
      .toEqual({ head_still_has_newer_work: true, head: s.shaN });
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refused"]).toBe(true);
    expect(body["refuse_class"]).toBe("stale_base_superseded");
  });

  it("MUST-FAIL 2: refuses a staged edit built on B when the clone still reads B at the check but the cutover's own fetch + reset brings it to a newer commit to the same file", async () => {
    // Second route to the same revert: the commit-tree check reads the clone BEFORE the clean-slate
    // fetch + `reset --hard origin/dev`, so a clone not yet at N passes it, then is moved to N, and
    // the wholesale copy of the B-based file lands over N.
    const s = await setup("same_file_unpulled");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = (r.body ?? {}) as Record<string, unknown>;
    // Whatever HEAD the clone ends on, its F must still carry N's line, and no new commit may sit on N.
    const headF = git(s.clone, "show", `HEAD:${F}`);
    const landedOnN = git(s.clone, "rev-list", "--count", `${s.shaN}..HEAD`);
    expect({ head_still_has_newer_work: headF.includes(NEWER_LINE), commits_on_top_of_N: landedOnN })
      .toEqual({ head_still_has_newer_work: true, commits_on_top_of_N: "0" });
    expect(r.shape).toBe("vesselMitosisCutoverResult");
    expect(body["refused"]).toBe(true);
    expect(body["refuse_class"]).toBe("stale_base_superseded");
  });

  it("MUST-FAIL 3: never hands the 12-char staged file-content hash to git as a revision", async () => {
    // staged_base_sha is sha256(file bytes).slice(0,12) — not a commit. Passing it to git as a
    // revision (`reset --hard <contentHash>`) can only fail and fall back, or, if it ever prefixes a
    // real object, reset the clone to an arbitrary commit. Observed through the pointer's own
    // git_cmd seam, on a landing that proceeds (so the reset step is certainly reached).
    const s = await setup("none");
    const rec = await recordingGit();
    const r = await resolveVesselMitosisCutover({ ...s.pointer, git_cmd: rec.cmd } as never);
    expect(r.shape).toBe("cutoverApplied");
    const calls = await rec.calls();
    // Positive control: the seam saw the clean-slate reset at all.
    expect(calls.some((a) => a[0] === "reset" && a.includes("--hard"))).toBe(true);
    const contentHash = s.pointer.staged_base_sha;
    expect(calls.filter((a) => a.includes(contentHash)).map((a) => a.join(" "))).toEqual([]);
  });

  it("CONTROL (08-29): a staged base hashing to uncommitted patched content proceeds on a clean clone with no newer commit to the file", async () => {
    // Guards against over-correcting into the 09-24 staged_base_sha deadlock: a base matching NO
    // commit is a staging artefact, not drift, and must not be refused.
    const s = await setup("none", { base: "uncommitted_patch" });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(((r.body ?? {}) as Record<string, unknown>)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckRuns).toBeGreaterThan(0);
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaB);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
  });

  it("CONTROL: a staged edit whose base equals the clone's HEAD lands", async () => {
    const s = await setup("none");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckRuns).toBeGreaterThan(0);
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaB);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
  });

  it("CONTROL: a newer commit touching only an unrelated file does not block, and survives the landing", async () => {
    const s = await setup("unrelated_file");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckRuns).toBeGreaterThan(0);
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaN);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
    expect(git(s.clone, "show", `HEAD:${G}`) + "\n").toBe(G_AT_N);
  });

  it("CONTROL: a revert that restored the file to the staged base's content lands (the guard compares content, not commit identity)", async () => {
    // Newer COMMITS touched F (N, then the revert R), but HEAD's F is byte-identical to the staged
    // base, so the wholesale copy reverts nothing. A guard keyed on "any commit to F after the base
    // commit" would refuse this; one keyed on content must not.
    const s = await setup("same_file_reverted");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(String(((r.body ?? {}) as Record<string, unknown>)["refusal_reason"] ?? "")).toBe("");
    expect(r.shape).toBe("cutoverApplied");
    expect(precheckRuns).toBeGreaterThan(0);
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaN);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
  });

  it("MUST-FAIL (recoverability): the stale-base refusal names the intervening commit and the gap from its Gap: trailer", async () => {
    const s = await setup("same_file", { newerGap: "gap-newer-work-on-target" });
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    const body = (r.body ?? {}) as Record<string, unknown>;
    expect(body["refuse_class"]).toBe("stale_base_superseded");
    expect(String(body["refusal_reason"] ?? "")).toContain(s.shaN);
    expect(body["newer_commits"]).toEqual([{ file: F, sha: s.shaN, gap: "gap-newer-work-on-target" }]);
  });
});
