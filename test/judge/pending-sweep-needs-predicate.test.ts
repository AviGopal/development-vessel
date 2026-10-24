// A NO-PREDICATE LANDING REACHES A TERMINAL SWEEP DECISION (row the-pending-land-sweep-keeps-a-no-predicate-landing-
// pending-forever-so-most-landings-can-never-be-verified-or-graded). A single landing whose row carries no measurement
// predicate read 'pending' (or 'unknown') on every pass, was re-marked and re-asked, and kept a sweep slot forever: on
// one node 36 of 39 candidates were such rows and the sweep closed 0-1 per tick.
//
// MUST-FAIL: two no-predicate landings (one whose commit names the gap, reading 'pending'; one whose commit does not,
// reading 'unknown') are decided needs_predicate on the first pass: the decision names the landing, the row stays open
// and held pending_verification, and a human is asked for a check on its pending-verify-<gap> panel (NEEDS_PREDICATE in the question). On the second pass neither
// takes a slot (the tally counts them needs_predicate_held). At the parent both were re-checked on pass 2.
// CONTROL: a measurable landing (verify_shape) reading 'unknown' is not decided and is re-checked on pass 2, as today.
//
// Runs the REAL sweep twice in fresh processes on a temp store (WORKSPACE_ROOT) and a temp clone; fetch stubbed, asks
// captured, real git.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedChildEnv } from "../resolvers/isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `pending-sweep-needs-predicate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const GAPS_PATH = join(ROOT, "gaps", "gaps.json");
const GLV = new URL("../../src/judge/gap-landing-verdict.ts", import.meta.url).pathname;
const NP_PENDING = "gap-np-pending-single-landing";
const NP_UNKNOWN = "gap-np-unknown-single-landing";
const CONTROL = "gap-np-control-measurable";
const shas: Record<string, string> = {};

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@test");
  git(repo, "config", "user.name", "test");
  const commit = (file: string, msg: string): string => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", msg);
    return git(repo, "rev-parse", "HEAD");
  };
  shas[NP_PENDING] = commit("a.txt", `substrate-authored: apply ${NP_PENDING} via mitosis cutover`);
  shas[NP_UNKNOWN] = commit("b.txt", "an unrelated landing whose message names no gap");
  shas[CONTROL] = commit("c.txt", "a landing a predicate is meant to measure");
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  const now = new Date().toISOString();
  const base = { source: "substrate_detected", category: "systematic_failure", detected_at: now, created_at: now, updated_at: now, status: "open" };
  writeFileSync(GAPS_PATH, JSON.stringify([
    { ...base, id: NP_PENDING, summary: "landed once, no predicate", classification_metadata: { pending_outcome_verification: shas[NP_PENDING], pending_set_at: now, disposition: "pending_verification" } },
    { ...base, id: NP_UNKNOWN, summary: "landed once, no predicate, commit names no gap", classification_metadata: { pending_outcome_verification: shas[NP_UNKNOWN], pending_set_at: now, disposition: "pending_verification" } },
    { ...base, id: CONTROL, summary: "landed once, measurable by a shape", classification_metadata: { pending_outcome_verification: shas[CONTROL], pending_set_at: now, disposition: "pending_verification", verify_shape: "opaque_probe" } },
  ]));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

function sweepInIsolation(): { exit: number; out: string } {
  const code = [
    // A well-formed 200 that answers nothing about any defect: a measurable predicate reads 'unknown' on it.
    `globalThis.fetch = (async () => new Response(JSON.stringify({ body: { generated_at: "2026-10-24T00:00:00Z", patterns: [] } }), { status: 200 }));`,
    `const { sweepPendingLandVerifications } = await import(${JSON.stringify(GLV)});`,
    `const ask = async (p) => { console.log("ASK " + String(p.id) + (String(p.body ?? "").includes("NEEDS_PREDICATE:") ? " needs_predicate" : "")); return { shape: "uiQuestion" }; };`,
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
function tallyOf(out: string): { checked: number; tally: Record<string, number> } {
  const m = /\[gap-sweep\] checked=(\d+) closed=(\d+) (\{.*\})/.exec(out);
  return m ? { checked: Number(m[1]), tally: JSON.parse(m[3]!) as Record<string, number> } : { checked: -1, tally: {} };
}
function row(id: string): { status: unknown; disposition: unknown; needs_predicate_landed: unknown; pending: unknown } {
  const g = (JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Array<Record<string, unknown>>).find((r) => r.id === id)!;
  const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
  return { status: g.status, disposition: m.disposition, needs_predicate_landed: (m.needs_predicate as { landed?: unknown } | undefined)?.landed ?? null, pending: m.pending_outcome_verification };
}

describe("pending-land sweep: a no-predicate landing reaches a terminal decision", () => {
  it("MUST-FAIL: pass 1 decides both no-predicate landings needs_predicate (held open, a human asked for a check); pass 2 spends no slot on them. CONTROL: the measurable landing is not decided and is re-checked", () => {
    const one = sweepInIsolation();
    expect({ exit: one.exit, ran: one.out.includes("SWEEP_RESULT ") }, one.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    const t1 = tallyOf(one.out);
    expect({
      checked: t1.checked,
      decided: t1.tally.needs_predicate,
      np_pending: row(NP_PENDING),
      np_unknown: row(NP_UNKNOWN),
      control: row(CONTROL),
      asked: [NP_PENDING, NP_UNKNOWN, CONTROL].filter((id) => one.out.includes(`ASK pending-verify-${id} needs_predicate`)),
    }, one.out.slice(-2000)).toEqual({
      checked: 3,
      decided: 2,
      np_pending: { status: "open", disposition: "pending_verification", needs_predicate_landed: shas[NP_PENDING], pending: shas[NP_PENDING] },
      np_unknown: { status: "open", disposition: "pending_verification", needs_predicate_landed: shas[NP_UNKNOWN], pending: shas[NP_UNKNOWN] },
      control: { status: "open", disposition: "pending_verification", needs_predicate_landed: null, pending: shas[CONTROL] },
      asked: [NP_PENDING, NP_UNKNOWN],
    });
    const two = sweepInIsolation();
    expect({ exit: two.exit, ran: two.out.includes("SWEEP_RESULT ") }, two.out.slice(-2000)).toEqual({ exit: 0, ran: true });
    const t2 = tallyOf(two.out);
    expect({ checked: t2.checked, held: t2.tally.needs_predicate_held, decided: t2.tally.needs_predicate, control: row(CONTROL).needs_predicate_landed }, two.out.slice(-2000))
      .toEqual({ checked: 1, held: 2, decided: 0, control: null });
  });
});
