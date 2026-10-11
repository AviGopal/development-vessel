// CHECK-FIRST, END TO END THROUGH THE REAL PENDING-LAND SWEEP: a landing made under the lane's own semantic
// dissent closes `landed_partial`, the verified-landing credit does not move, and the sweep's own check (the
// one the gate doubted) does not settle the dissent as passed. A landing with no dissent is the control.
// Companion to feature-compose-dissent-partial.test.ts (the seams).
//
// ISOLATION: the gap store's root is frozen by whichever module imports config.ts first (substrate-gap.ts
// gapStoreRootForTest), so in a multi-file `bun test` run this file cannot choose its store. The sweep therefore
// runs in a FRESH `bun` process whose WORKSPACE_ROOT, VESSELS_CLONE_ROOT and calibration paths are this file's
// temp dir; it can never read or write a real store. Real git; no network (fetch stubbed in the child).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gapCheckIdentity } from "../../src/resolvers/feature-compose.js";

const ROOT = join(tmpdir(), `sweep-landed-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const CALIB = join(ROOT, "expectation-calibration.json");
const GTF = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url).pathname;
const UIW = new URL("../../src/resolvers/ui-write-passthrough.ts", import.meta.url).pathname;
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

// A pinnable own check, so the control's close can carry the sweep's own independent verdict.
const CHECK = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/own.test.ts", only_tests: ["own"] }, zero_field: "requested_not_passing" } };
let partialSha = "";
let verifiedSha = "";
beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  // Test-only commits are "running" without a restart (landedCommitRunningHere), so the close is decided here.
  // A root commit has no diff-tree, so the landings sit on top of one.
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  writeFileSync(join(repo, "test", "a.test.ts"), "// a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "landed under a 2/2 semantic dissent");
  partialSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "test", "b.test.ts"), "// b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "landed with the gate's agreement");
  verifiedSha = git(repo, "rev-parse", "HEAD");

  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", detected_at: now, created_at: now, updated_at: now, status: "open" };
  const dissent = { reason: "2/2 refuters: the key is named but nothing reads it", gate_verdict: { addresses: false, on_live_path: false }, at: now, landed_sha: partialSha, own_check: gapCheckIdentity(CHECK), child_gap_id: "sweep-partial-dissent-narrowed", later_outcome: null };
  writeFileSync(GAPS_PATH, JSON.stringify([
    { ...base, id: "sweep-partial", category: "cat_partial", summary: "landed under dissent", classification_metadata: { ...CHECK, pending_outcome_verification: partialSha, pending_set_at: now, semantic_dissent: [dissent] } },
    { ...base, id: "sweep-verified", category: "cat_verified", summary: "landed with the gate", classification_metadata: { ...CHECK, pending_outcome_verification: verifiedSha, pending_set_at: now } },
  ]));
  writeFileSync(CALIB, JSON.stringify({}));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

/** Run the real sweep once in a fresh process bound to ROOT. The own check reads green at HEAD and at every pinned
 *  tree but the verified landing's parent (partialSha), where it is red: that landing flips it. */
function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    `const PARENT = ${JSON.stringify(partialSha)};`,
    `globalThis.fetch = (async (_u, init) => { let b = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch {} const ref = b?.impulse?.pointer?.base_ref; return new Response(JSON.stringify({ body: { ran: true, requested_not_passing: ref === PARENT ? 1 : 0 } }), { status: 200 }); });`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    `const __askHuman = async (p) => (await import(${JSON.stringify(UIW)})).resolveUiWritePassthrough(p);`,
    `const r = await sweepPendingLandVerifications({ ask: __askHuman });`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
  ].join("\n");
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? ROOT, PATH: process.env.PATH ?? "",
    WORKSPACE_ROOT: ROOT, VESSELS_CLONE_ROOT: CLONES, EXPECTATION_CALIB_PATH: CALIB,
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1", NODE_ENV: "test", TZ: "UTC",
  };
  const p = Bun.spawnSync(["bun", "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

describe("the pending-land sweep: a landing under semantic dissent is partial", () => {
  it("MUST-FAIL: the dissent landing closes landed_partial, the sweep's same own check leaves its dissent unsettled, and the verified-landing credit does not count it; the no-dissent CONTROL closes landed_verified and is credited", () => {
    const run = sweepInIsolation();
    expect({ exit: run.exit, ran: run.out.includes("SWEEP_RESULT ") }, run.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    const byId = new Map((JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).map((g) => [g.id, g]));
    const p = byId.get("sweep-partial")!;
    const v = byId.get("sweep-verified")!;
    const pm = p.classification_metadata as Record<string, unknown>;
    const vm = v.classification_metadata as Record<string, unknown>;
    const calib = JSON.parse(readFileSync(CALIB, "utf8")) as Record<string, { attempts: number; lands: number }>;
    expect({
      partial: [p.status, pm.closed_reason],
      partial_dissent_outcome: (pm.semantic_dissent as Array<Record<string, unknown>>)[0]!.later_outcome,
      verified: [v.status, vm.closed_reason],
      verified_credit: calib.cat_verified?.lands ?? 0,
      partial_credit: calib.cat_partial?.lands ?? 0,
    }, run.out.slice(-2000)).toEqual({
      partial: ["closed", "landed_partial"],
      partial_dissent_outcome: null,
      verified: ["closed", "landed_verified"],
      verified_credit: 1,
      partial_credit: 0,
    });
  });
});
