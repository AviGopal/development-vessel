// OPERATOR HOLD ON patch_with_tools LIVE-TREE WRITES (operatorHold pwt-live-tree-writes).
//
// patch_with_tools edits the LIVE /vessels trees. Twice the edited code ran in production
// (pull-sync reads authoring markers from a directory pwt no longer writes to, so it restarted
// vessels mid-edit). The hold is one operator-attested pool record read at pwt entry, before the
// authoring marker and before any tool call, and it FAILS CLOSED: absent, unreadable, active, or an
// unattested lift all read held. Only an operator-attested active:false lifts it. A compose
// worktree and a test sandbox are not live trees and stay writable while held.
//
// Every fixture lives in this file's own mkdtemp sandbox. The live-tree root is INJECTED as a
// sandbox directory, so no test reads or writes /vessels or /workspace. fetch is replaced for the
// whole file: a call to a non-loopback origin fails the test, and every call is counted.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";
import { resolvePoolImpulseWrite, __setPoolFileForTests, attestationSig } from "../../src/resolvers/pool-impulse.js";
import * as g2f from "../../src/resolvers/gap-to-feature.js";

// Loaded leniently so the behavioural tests below fail on BEHAVIOUR (not on a missing module) at a
// base that has no hold at all.
const holdMod: Record<string, unknown> = await import("../../src/lib/operator-hold.js").catch(() => ({}));
const setZones = (z: unknown): void => { (holdMod.__setLiveTreeZonesForTests as ((z: unknown) => void) | undefined)?.(z); };
const resetHoldLog = (): void => { (holdMod.__resetOperatorHoldLogForTests as (() => void) | undefined)?.(); };

const HOLD_ID = "pwt-live-tree-writes";
const SCOPE = "patch_with_tools:live_tree_writes";
const NODE_KEY = "test-node-key-pwt-hold";
const ORIGINAL = "export function live(): number {\n  return 1;\n}\n";
const SUB = "src/resolvers/existing.ts";

const originalFetch = globalThis.fetch;
const priorKey = process.env["METABOB_API_KEY"];
let base: string, live: string, compose: string, ws: string, poolFile: string;
let calls: { tools: number; llm: number; other: number; offOrigin: string[] };

function holdBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    hold_id: HOLD_ID, scope: SCOPE, active: true, harm: true,
    by: "operator:test", at: now.toISOString(),
    reason: "pwt edits LIVE /vessels trees",
    evidence: ["gap-a", "gap-b"],
    lift: "pwt writes an isolated compose worktree by default",
    review_by: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    ...over,
  };
}
const operatorWrite = (body: Record<string, unknown>) =>
  resolvePoolImpulseWrite({ type: "poolImpulse_write", id: HOLD_ID, shape: "operatorHold", body, source: "test" }, { operator: true, key_id: "test-admin" });
/** A row placed in the store file directly, bypassing the writer: the only way an unattested or forged operatorHold row can exist. */
function plantRow(body: Record<string, unknown>, attested?: Record<string, unknown>): void {
  const at = new Date().toISOString();
  writeFileSync(poolFile, JSON.stringify([{ id: HOLD_ID, shape: "operatorHold", body, source: "planted", status: "open", injected_at: at, updated_at: at, ...(attested ? { attested } : {}) }]));
}
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** The scripted fetch: discovery, the model policy, the LLM and local-tools, all on loopback, all counted. */
function stubFetch(llmActions: string[]): typeof fetch {
  let turn = 0;
  return (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") { calls.offOrigin.push(url); throw new Error(`network guard: ${url} is not a stub origin`); }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url.includes("/resolve") && body?.pointer?.type === "vesselCapability") {
      const role = body.pointer.shape === "llmCompletion" || body.pointer.shape === "llm_completion" ? "llm" : "tools";
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://127.0.0.1:9", resolve_endpoint: `http://127.0.0.1:9/${role}`, health_score: 1 }] } }), { status: 200 });
    }
    if (url.endsWith("/llm") && body?.type === "llmModelPolicy") return new Response(JSON.stringify({ body: { arms: [{ model: "qwen/qwen3-32b" }] } }), { status: 200 });
    if (url.endsWith("/llm")) {
      calls.llm++;
      const content = llmActions[Math.min(turn++, llmActions.length - 1)] ?? '{"action":"fail","reason":"out of script"}';
      return new Response(JSON.stringify({ content }), { status: 200 });
    }
    if (url.endsWith("/tools")) {
      calls.tools++;
      return new Response(JSON.stringify({ ok: true, matches: [{ line: 2, text: "  return 1;" }] }), { status: 200 });
    }
    calls.other++;
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const pwt = (over: Record<string, unknown> = {}) => resolvePatchWithTools({
  type: "patch_with_tools",
  proposal_text: "make live() return 2",
  target_file: `repos/demo-vessel/${SUB}`,
  vessels_root: live,
  workspace_root: ws,
  max_attempts: 1,
  max_iterations: 2,
  ...over,
} as never);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pwt-hold-")));
  live = join(base, "live-vessels");
  compose = join(base, "compose");
  ws = join(base, "ws");
  poolFile = join(base, "pool", "standing.json");
  for (const root of [live, join(compose, "c1")]) {
    mkdirSync(join(root, "demo-vessel", "src", "resolvers"), { recursive: true });
    writeFileSync(join(root, "demo-vessel", SUB), ORIGINAL);
  }
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(base, "pool"), { recursive: true });
  __setPoolFileForTests(poolFile);
  // The sandbox `live-vessels` IS the runtime (live) zone for these tests; `compose` is the compose zone.
  setZones({ supers: [], clones: join(base, "no-clones"), runtime: live, compose });
  resetHoldLog();
  process.env["METABOB_API_KEY"] = NODE_KEY;
  calls = { tools: 0, llm: 0, other: 0, offOrigin: [] };
  globalThis.fetch = stubFetch([
    JSON.stringify({ action: "call_tool", tool: "code_search", args: { path: join(live, "demo-vessel", SUB), pattern: "return 1" } }),
    JSON.stringify({ action: "fail", reason: "test script ends here" }),
  ]);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setPoolFileForTests(null);
  setZones(null);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});
afterAll(() => { if (priorKey === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = priorKey; });

function expectHeldUntouched(r: { shape: string; body: unknown }, targetSha: string): void {
  const b = r.body as Record<string, unknown>;
  expect(r.shape).toBe("structuredError");
  expect(b.stage).toBe("live_tree_writes_held");
  expect(b.verdict).toBe("REFUSED");
  expect(b.hold_id).toBe(HOLD_ID);
  expect(typeof b.why).toBe("string");
  expect(sha(join(live, "demo-vessel", SUB))).toBe(targetSha);
  // No authoring marker, no pending record, nothing at all under the workspace root.
  expect(existsSync(join(ws, "authoring-inflight"))).toBe(false);
  expect(readdirSync(ws)).toEqual([]);
  expect(calls.tools).toBe(0);
  expect(calls.llm).toBe(0);
  expect(calls.offOrigin).toEqual([]);
}

describe("pwt live-tree hold: fails closed", () => {
  it("t1: hold record ABSENT -> refused at entry (live_tree_writes_held), target unchanged, no marker, no tool call", async () => {
    const before = sha(join(live, "demo-vessel", SUB));
    const r = await pwt();
    expectHeldUntouched(r, before);
    expect(String((r.body as Record<string, unknown>).why)).toContain("absent");
  });

  it("t2: hold record active:true -> refused the same way", async () => {
    expect(operatorWrite(holdBody({ active: true })).body.ok).toBe(true);
    const before = sha(join(live, "demo-vessel", SUB));
    const r = await pwt();
    expectHeldUntouched(r, before);
    expect(String((r.body as Record<string, unknown>).reason ?? "")).toContain("LIVE");
  });

  it("t3: an UNATTESTED active:false is not a lift -> still refused", async () => {
    plantRow(holdBody({ active: false }));
    const before = sha(join(live, "demo-vessel", SUB));
    expectHeldUntouched(await pwt(), before);
  });

  it("t3b: a FORGED operator stamp (bad sig) and an evaluator stamp are not lifts", async () => {
    const before = sha(join(live, "demo-vessel", SUB));
    plantRow(holdBody({ active: false }), { by: "operator", key_id: "x", at: new Date().toISOString(), sig: "0".repeat(64) });
    expectHeldUntouched(await pwt(), before);
    // An evaluator stamp correctly signed under the node key is still not an operator lift.
    const at = new Date().toISOString();
    const body = holdBody({ active: false });
    const row = { id: HOLD_ID, shape: "operatorHold", status: "open", body };
    plantRow(body, { by: "evaluator", evaluator: "scope_earn_in_apply", key_id: null, at, sig: attestationSig(NODE_KEY, row, null, at) });
    expectHeldUntouched(await pwt(), before);
  });

  it("t3c: an operator-attested lift whose node key is gone cannot be verified -> held", async () => {
    expect(operatorWrite(holdBody({ active: false })).body.ok).toBe(true);
    delete process.env["METABOB_API_KEY"];
    const before = sha(join(live, "demo-vessel", SUB));
    expectHeldUntouched(await pwt(), before);
  });
});

describe("operatorHold write validation", () => {
  it("t4: a write missing fields is REFUSED with the list of missing fields", () => {
    const r = operatorWrite({ hold_id: HOLD_ID, active: true });
    const b = r.body as Record<string, unknown>;
    expect(b.ok).toBe(false);
    expect(String(b.error)).toStartWith("operator_hold_invalid");
    const missing = b.missing as string[];
    for (const f of ["scope", "by", "at", "reason", "evidence", "lift", "review_by", "harm"]) expect(missing).toContain(f);
    expect(missing).not.toContain("active");
    expect(existsSync(poolFile) ? readFileSync(poolFile, "utf8") : "[]").not.toContain(HOLD_ID);
  });

  it("t4b: hold_id must equal the row id; empty evidence and non-ISO dates are refused", () => {
    const b = operatorWrite(holdBody({ hold_id: "other", evidence: [], at: "yesterday", active: "yes" })).body as Record<string, unknown>;
    expect(b.ok).toBe(false);
    expect(b.missing as string[]).toEqual(expect.arrayContaining(["hold_id", "evidence", "at", "active"]));
  });

  it("t4c: operatorHold is a trust-root shape: a write without an operator credential is refused", () => {
    const r = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: HOLD_ID, shape: "operatorHold", body: holdBody() }, { operator: false, why: "test" });
    expect(r.body.ok).toBe(false);
    expect(String(r.body.error)).toStartWith("operator_credential_required");
    // ...and the scope-earn-in evaluator grant does not extend to it.
    const e = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: HOLD_ID, shape: "operatorHold", body: holdBody({ active: false }) }, { operator: false, evaluator: "scope_earn_in_apply" });
    expect(e.body.ok).toBe(false);
  });

  it("the initial hold record the operator script writes passes validation and is stamped", () => {
    const now = new Date();
    const body = {
      hold_id: HOLD_ID, scope: SCOPE, active: true, harm: true,
      by: "operator:avi (ac8b0aad) per user ruling 2026-10-09", at: now.toISOString(),
      reason: "pwt edits LIVE /vessels trees.",
      evidence: [
        "pull-sync-reads-authoring-markers-from-a-directory-patch-with-tools-stopped-writing-to-so-it-restarts-vessels-mid-edit",
        "patch-with-tools-between-attempt-and-gate-reject-rollbacks-do-not-verify-the-restored-sha",
        "patch-with-tools-restores-never-log-success-so-rollback-is-provable-only-by-inference",
      ],
      lift: "pwt writes an isolated compose worktree by default, OR every restore path verifies sha == the pre-edit snapshot and logs success, fails loud otherwise; AND the authoring marker is visible to pull-sync's reader; AND the watchdog retry is idempotent",
      review_by: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    };
    expect(operatorWrite(body).body.ok).toBe(true);
    const rows = JSON.parse(readFileSync(poolFile, "utf8")) as Array<{ id: string; attested?: { by: string; sig?: string } }>;
    expect(rows.find((x) => x.id === HOLD_ID)?.attested?.by).toBe("operator");
    expect(typeof rows.find((x) => x.id === HOLD_ID)?.attested?.sig).toBe("string");
  });
});

describe("controls", () => {
  it("c1: an operator-attested active:false lifts the hold -> today's behaviour (proceeds to the tool calls)", async () => {
    expect(operatorWrite(holdBody({ active: false })).body.ok).toBe(true);
    const r = await pwt();
    expect((r.body as Record<string, unknown>).stage).not.toBe("live_tree_writes_held");
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.offOrigin).toEqual([]);
    expect(readFileSync(join(live, "demo-vessel", SUB), "utf8")).toBe(ORIGINAL);
  });

  it("c2: a compose-worktree vessels_root is ALLOWED while held", async () => {
    // Hold absent (default held) — the compose zone is not a live tree.
    globalThis.fetch = stubFetch([
      JSON.stringify({ action: "call_tool", tool: "code_search", args: { path: join(compose, "c1", "demo-vessel", SUB), pattern: "return 1" } }),
      JSON.stringify({ action: "fail", reason: "test script ends here" }),
    ]);
    const r = await pwt({ vessels_root: join(compose, "c1") });
    expect((r.body as Record<string, unknown>).stage).not.toBe("live_tree_writes_held");
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.offOrigin).toEqual([]);
  });
});

describe("t5: a held refusal through the gap-to-feature grading path", () => {
  it("is an infrastructure refusal (no class-posterior beta)", () => {
    expect(g2f.isInfraRefusalBody({ stage: "live_tree_writes_held", verdict: "REFUSED" })).toBe(true);
  });

  it("changes neither failed_attempts nor the class posterior; stamps pwt_escalation_held and does NOT consume the one-shot; escalates for real once lifted", async () => {
    const escalate = (g2f as Record<string, unknown>).escalateApplyFailureToPwt as undefined | ((...a: unknown[]) => Promise<Record<string, unknown>>);
    expect(typeof escalate).toBe("function");
    const posterior: Array<[string, boolean]> = [];
    const bumps: unknown[] = [];
    const closes: unknown[] = [];
    const metaWrites: Array<Record<string, unknown>> = [];
    const pwtCalls: Array<Record<string, unknown>> = [];
    // The stored gap row: persistGapMeta merges into it, and each "tick" picks a fresh copy of it, as the picker does.
    const row: Record<string, unknown> = { id: "demo-gap-1", category: "bug", source: "detector", summary: "s", status: "open", classification_metadata: { edit_site: `repos/demo-vessel/${SUB}` } };
    const pick = (): Record<string, unknown> => JSON.parse(JSON.stringify(row));
    const deps = {
      // The real resolver, pointed at the sandbox live tree (the call site passes MITOSIS_RUNTIME_DIR ?? /vessels).
      resolvePwt: (p: Record<string, unknown>) => { pwtCalls.push(p); return resolvePatchWithTools({ ...p, vessels_root: live, workspace_root: ws, max_attempts: 1, max_iterations: 2 } as never); },
      updateClassPosterior: (cls: string, landed: boolean) => { posterior.push([cls, landed]); },
      bumpFailedAttempts: async (g: unknown) => { bumps.push(g); },
      closeLandedGap: async (g: unknown) => { closes.push(g); return { closed: true }; },
      persistGapMeta: async (_g: unknown, patch: Record<string, unknown>) => {
        metaWrites.push(patch);
        row.classification_metadata = { ...(row.classification_metadata as Record<string, unknown>), ...patch };
      },
      // holdStillHeld left to the real reader (readOperatorHold over the sandbox pool store).
    };
    const withRealHoldReader = { ...deps, holdStillHeld: (id: string) => (holdMod.readOperatorHold as (id: string) => { held: boolean })(id).held };
    const applyFailure = { ok: false, apply_failed: true, op_count: 1, rolled_back: true, verdict: "UNFAVORABLE" };

    // Tick 1 — hold record ABSENT: pwt is called, refuses at entry, and the refusal is not graded.
    const out = await escalate!(pick(), applyFailure, "make live() return 2", { predicted: false, p: 0.2 }, withRealHoldReader);
    expect(pwtCalls.length).toBe(1);
    expect(out.held).toBe(true);
    expect(out.landed).toBe(false);
    expect(posterior).toEqual([]);
    expect(bumps).toEqual([]);
    expect(closes).toEqual([]);
    expect(metaWrites.length).toBe(1);
    const meta1 = row.classification_metadata as Record<string, unknown>;
    expect(meta1.pwt_escalated).toBeUndefined();
    expect((meta1.pwt_escalation_held as Record<string, unknown>).hold_id).toBe(HOLD_ID);
    expect((meta1.pwt_escalation_held as Record<string, unknown>).stage).toBe("live_tree_writes_held");
    expect(typeof (meta1.pwt_escalation_held as Record<string, unknown>).at).toBe("string");
    expect(calls.tools).toBe(0);
    expect(readdirSync(ws)).toEqual([]);

    // Tick 2 — still held: the stamp rate-limits; pwt is NOT called, and the compose's apply failure is graded as
    // it would be with no escalation (one posterior beta, one bump).
    const out2 = await escalate!(pick(), applyFailure, "make live() return 2", { predicted: false, p: 0.2 }, withRealHoldReader);
    expect(out2.skipped_held).toBe(true);
    expect(pwtCalls.length).toBe(1);
    expect(posterior.length).toBe(1);
    expect(bumps.length).toBe(1);

    // Tick 3 — the operator lifts the hold (attested active:false): the next apply failure ESCALATES for real and
    // pwt reaches the (stubbed) tools.
    expect(operatorWrite(holdBody({ active: false })).body.ok).toBe(true);
    globalThis.fetch = stubFetch([
      JSON.stringify({ action: "call_tool", tool: "code_search", args: { path: join(live, "demo-vessel", SUB), pattern: "return 1" } }),
      JSON.stringify({ action: "fail", reason: "test script ends here" }),
    ]);
    const out3 = await escalate!(pick(), applyFailure, "make live() return 2", { predicted: false, p: 0.2 }, withRealHoldReader);
    expect(out3.escalated).toBe(true);
    expect(out3.held).toBe(false);
    expect(out3.skipped_held).toBe(false);
    expect(pwtCalls.length).toBe(2);
    expect(calls.tools).toBeGreaterThan(0);
    expect(calls.offOrigin).toEqual([]);
    expect(readFileSync(join(live, "demo-vessel", SUB), "utf8")).toBe(ORIGINAL);
  });

  it("control: a genuine (non-held) pwt failure still bumps and still records the class posterior", async () => {
    const escalate = (g2f as Record<string, unknown>).escalateApplyFailureToPwt as undefined | ((...a: unknown[]) => Promise<Record<string, unknown>>);
    expect(typeof escalate).toBe("function");
    const posterior: Array<[string, boolean]> = [];
    const bumps: unknown[] = [];
    const gap = { id: "demo-gap-2", category: "bug", source: "detector", summary: "s", classification_metadata: { edit_site: `repos/demo-vessel/${SUB}` } };
    const out = await escalate!(gap, { ok: false, apply_failed: true, verdict: "UNFAVORABLE" }, "spec", { predicted: false, p: 0.2 }, {
      resolvePwt: async () => ({ shape: "structuredError", body: { resolver: "patch_with_tools", detail: "LLM declared done without making any edit" } }),
      updateClassPosterior: (cls: string, landed: boolean) => { posterior.push([cls, landed]); },
      bumpFailedAttempts: async (g: unknown) => { bumps.push(g); },
      closeLandedGap: async () => ({ closed: true }),
      persistGapMeta: async () => { /* not expected */ },
      holdStillHeld: () => { throw new Error("not expected: no hold stamp on this gap"); },
    });
    expect(out.held).toBe(false);
    expect(posterior.length).toBe(1);
    expect(posterior[0]![1]).toBe(false);
    expect(bumps.length).toBe(1);
  });
});
