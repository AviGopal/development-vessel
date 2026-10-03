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
// WHY THE RUNTIME TREE LAGS AT B (do not "fix" the fixture by moving it to N): in production the
// primary freshness gate reads the deployed runtime tree (MITOSIS_RUNTIME_DIR/<vessel>), which
// trails the push clone by a pull-sync cycle — that lag is how every instance above passed the
// primary gate. If the runtime tree were also at N the primary gate would refuse and the
// must-fail would go green for a reason unrelated to the exemption.
//
// Drives the REAL resolveVesselMitosisCutover through its git-aware path, with baseRoot and
// hostRepoRoot derived from MITOSIS_DIRECT_PUSH / MITOSIS_RUNTIME_DIR / MITOSIS_PUSH_CLONE_DIR the
// way the running vessel derives them. Hermetic: temp dirs, a temp bare origin, no push
// (skip_push), no restart, the precutover suite gate off, and the gap-store read / suite run
// injected through the cutover's own test seam.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  process.env["CUTOVER_PRECHECK_SUITE"] = "0";
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
});

afterEach(async () => {
  __setOwnCheckDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
});

type Newer = "none" | "same_file" | "unrelated_file";

/**
 * Bare origin with base commit B; the live push clone at MITOSIS_PUSH_CLONE_DIR/<vessel>; a staged
 * mitosis of F computed against B; optionally a newer commit N pushed by another writer and
 * fast-forwarded into the live clone, which is left clean at HEAD.
 */
async function setup(newer: Newer) {
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

  // The runtime tree lags at B (see the header: this is how the primary gate passes).
  const runtime = join(ws, "runtime", VESSEL);
  await put(runtime, F, F_AT_B);
  await put(runtime, G, G_AT_B);

  // The staged mitosis: only F, computed against B.
  const mitosisRoot = join(ws, "vessels", `${VESSEL}-${MVID}`);
  await put(mitosisRoot, F, F_STAGED);

  let shaN = shaB;
  if (newer !== "none") {
    const other = join(ws, "other-writer");
    git(ws, "clone", "-q", "-b", "dev", origin, other);
    gitIdentity(other);
    if (newer === "same_file") await put(other, F, F_AT_N);
    else await put(other, G, G_AT_N);
    git(other, "add", ".");
    git(other, "commit", "-m", `N: newer work on ${newer === "same_file" ? F : G}`);
    git(other, "push", "origin", "dev");
    shaN = git(other, "rev-parse", "HEAD");
    git(clone, "pull", "-q", "--ff-only", "origin", "dev");
  }
  // The precondition the exemption keys on: the clone is clean and sits at origin/dev's HEAD.
  expect(git(clone, "status", "--porcelain")).toBe("");
  expect(git(clone, "rev-parse", "HEAD")).toBe(shaN);
  expect(git(clone, "rev-parse", "origin/dev")).toBe(shaN);

  const pointer = {
    type: "vessel_mitosis_cutover" as const,
    vessel_name: VESSEL,
    base_version_id: "v1",
    mitosis_version_id: MVID,
    mitosis_root: mitosisRoot,
    staged_base_sha: sha12(F_AT_B),
    staged_base_shas: { [F]: sha12(F_AT_B) },
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
  });

  it("CONTROL: a staged edit whose base equals the clone's HEAD lands", async () => {
    const s = await setup("none");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaB);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
  });

  it("CONTROL: a newer commit touching only an unrelated file does not block, and survives the landing", async () => {
    const s = await setup("unrelated_file");
    const r = await resolveVesselMitosisCutover(s.pointer as never);
    expect(r.shape).toBe("cutoverApplied");
    expect(git(s.clone, "rev-parse", "HEAD~1")).toBe(s.shaN);
    expect(git(s.clone, "show", `HEAD:${F}`) + "\n").toBe(F_STAGED);
    expect(git(s.clone, "show", `HEAD:${G}`) + "\n").toBe(G_AT_N);
  });
});
