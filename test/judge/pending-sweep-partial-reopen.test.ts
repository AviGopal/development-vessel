// A TERMINAL PARTIAL CLOSE IS RE-OPENED FOR A VERDICT (row a-landed-partial-close-over-semantic-dissent-is-terminal-so-
// an-unverified-landing-escapes-every-verifier-and-inflates-the-gap-close-rate; qa option 3). A landing closed
// landed_partial under the lane's own semantic dissent was terminal: the pending-land sweep reads open rows only, so the
// live instance (a goal-host landing over a gamed check, closed landed_partial with close_basis absent) was never
// verified or falsified.
//
// MUST-FAIL: that row (closed landed_partial, close_basis absent, stamped, its dissent bound to the landing) is re-opened
// by the sweep as pending verification, with a partial_reopen marker naming the landing and the prior close, and on the
// next pass it is NOT re-closed landed_partial by the same dissent (nor released as stale by its own re-open).
// CONTROLS: a FRESH dissent landing still closes landed_partial (ruling (a), unchanged); a closed row whose close is not a
// landing-verification close (verified_by_operator_review), and a landed_verified row with no unverified marker, are
// not re-opened. Also pinned: a needs_predicate decision older than the row's reopened_at no longer stands.
//
// Runs the REAL sweep twice in fresh processes on a temp store (WORKSPACE_ROOT) and a temp clone; real git; fetch stubbed.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "../resolvers/isolated-gap-store-run.js";
import { gapCheckIdentity } from "../../src/resolvers/feature-compose.js";
import * as glv from "../../src/judge/gap-landing-verdict.js";

const ROOT = join(tmpdir(), `pending-sweep-partial-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;
const CHECK = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/own.test.ts", only_tests: ["own"] }, zero_field: "requested_not_passing" } };
const REOPEN = "rp-terminal-partial";
const FRESH = "rp-fresh-dissent";
const OPERATOR = "rp-operator-reviewed";
const CLEAN_VERIFIED = "rp-clean-verified";
const shas: Record<string, string> = {};

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(join(repo, "test"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  // Test-only commits are "running" without a restart; a root commit has no diff-tree, so landings sit on top of one.
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "root");
  for (const [id, f] of [[REOPEN, "a"], [FRESH, "b"], [OPERATOR, "c"], [CLEAN_VERIFIED, "d"]] as const) {
    writeFileSync(join(repo, "test", `${f}.test.ts`), `// ${f}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `landing for ${f}`);
    shas[id] = git(repo, "rev-parse", "HEAD");
  }
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3_600_000).toISOString();
  const base = { source: "substrate_detected", category: "cat_rp", detected_at: earlier, created_at: earlier, updated_at: earlier };
  const dissent = (sha: string, child: string) => ({ reason: "the patch matches the reported misbehaviour rather than fixing it", gate_verdict: { addresses: false }, at: earlier, landed_sha: sha, own_check: gapCheckIdentity(CHECK), child_gap_id: child, later_outcome: null });
  const closed = (id: string, reason: string, extra: Record<string, unknown>) => ({
    ...base, id, summary: id, status: "closed", closed_at: earlier,
    classification_metadata: { ...CHECK, pending_outcome_verification: shas[id], pending_set_at: earlier, closed_reason: reason, close_basis: "absent", landed_sha: shas[id], closed_at: earlier, ...extra },
  });
  writeFileSync(GAPS_PATH, JSON.stringify([
    closed(REOPEN, "landed_partial", { landed_unverified: true, landed_unverified_sha: shas[REOPEN], landed_unverified_reason: "semantic_dissent: landed over the semantic gate's addresses:false; post-land by-effect check required", semantic_dissent: [dissent(shas[REOPEN]!, `${REOPEN}-dissent-narrowed`)] }),
    { ...base, id: FRESH, summary: FRESH, status: "open", detected_at: now, created_at: now, updated_at: now, classification_metadata: { ...CHECK, pending_outcome_verification: shas[FRESH], pending_set_at: now, semantic_dissent: [dissent(shas[FRESH]!, `${FRESH}-dissent-narrowed`)] } },
    closed(OPERATOR, "verified_by_operator_review", { landed_unverified: true }),
    closed(CLEAN_VERIFIED, "landed_verified", {}),
  ]));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    // The own check reads green at HEAD and at every pinned tree: each landing's check reads 'absent'.
    `globalThis.fetch = (async () => new Response(JSON.stringify({ body: { ran: true, requested_not_passing: 0 } }), { status: 200 }));`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    `const ask = async (p) => { console.log("ASK " + String(p.id)); return { shape: "uiQuestion" }; };`,
    `const r = await sweepPendingLandVerifications({ ask });`,
    `await new Promise((res) => setTimeout(res, 50));`,
    `console.log("SWEEP_RESULT " + JSON.stringify(r));`,
  ].join("\n");
  const env: Record<string, string> = isolatedChildEnv(ROOT, {
    HOME: ROOT, VESSELS_CLONE_ROOT: CLONES,
    EXPECTATION_CALIB_PATH: join(ROOT, "expectation-calibration.json"),
    CLOSE_ORACLE_CALIB_PATH: join(ROOT, "close-oracle-calibration.json"),
    NODE_ENV: "test", TZ: "UTC",
  });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { exit: p.exitCode ?? -1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}
function view(id: string): Record<string, unknown> {
  const g = (JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).find((r) => r.id === id)!;
  const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
  const r = (m.partial_reopen ?? null) as { by?: unknown; sha?: unknown; prior?: { closed_reason?: unknown; close_basis?: unknown } } | null;
  return { status: g.status, closed_reason: m.closed_reason ?? null, disposition: m.disposition ?? null, pending: m.pending_outcome_verification ?? null, reopen: r ? { by: r.by, sha: r.sha, prior: [r.prior?.closed_reason, r.prior?.close_basis] } : null };
}

describe("pending-land sweep: a terminal partial close is re-opened for a verdict", () => {
  it("MUST-FAIL: the landed_partial row is re-opened as pending verification and NOT re-closed landed_partial by the same dissent on the next pass. CONTROLS: a fresh dissent landing closes landed_partial; non-landing and clean landed_verified closes stay closed", () => {
    const one = sweepInIsolation();
    expect({ exit: one.exit, ran: one.out.includes("SWEEP_RESULT ") }, one.out.slice(-2500)).toEqual({ exit: 0, ran: true });
    const reopened = { status: "open", closed_reason: null, disposition: "pending_verification", pending: shas[REOPEN], reopen: { by: "gap-sweep", sha: shas[REOPEN], prior: ["landed_partial", "absent"] } };
    expect({ reopen: view(REOPEN), fresh: [view(FRESH).status, view(FRESH).closed_reason], operator: [view(OPERATOR).status, view(OPERATOR).closed_reason], clean: [view(CLEAN_VERIFIED).status, view(CLEAN_VERIFIED).closed_reason] }, one.out.slice(-2500)).toEqual({
      reopen: reopened,
      fresh: ["closed", "landed_partial"],
      operator: ["closed", "verified_by_operator_review"],
      clean: ["closed", "landed_verified"],
    });
    const two = sweepInIsolation();
    expect({ exit: two.exit, ran: two.out.includes("SWEEP_RESULT ") }, two.out.slice(-2500)).toEqual({ exit: 0, ran: true });
    expect(view(REOPEN), two.out.slice(-2500)).toEqual(reopened);
  });

  it("MUST-FAIL (guard): a needs_predicate decision is cleared by a later reopen of the row", () => {
    const decided = (glv as unknown as { needsPredicateDecided?: (m: Record<string, unknown>, reopenedAt?: unknown) => boolean }).needsPredicateDecided;
    expect(typeof decided).toBe("function");
    const meta = { pending_outcome_verification: "abcdef1234567", needs_predicate: { landed: "abcdef1234567", verdict: "pending", at: "2026-10-24T01:00:00.000Z" } };
    expect([decided!(meta), decided!(meta, "2026-10-24T00:00:00.000Z"), decided!(meta, "2026-10-24T02:00:00.000Z")]).toEqual([true, true, false]);
  });
});
