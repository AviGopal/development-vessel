// gap_falsify v2, the birth half (REALIGNMENT §2.3 "the falsifier fails on the current tree";
// contained-self-development 8.5). A class-2 check is RUN once when a write adds or changes it, through the one
// judge (evaluateGapCheck), and its verdict is stamped beside it. Only a check that reads 'present' on the unfixed
// tree has seen the defect; anything else is predicate_suspect: not admissible, and its 'absent' closes nothing.
//
// Driven through the real write seam, the real judge and the real admission, with globalThis.fetch standing in
// for the vessel's own resolve endpoint (the test_suite answer) and for discovery. No source-text assertions.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `gf2-birth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, predicateSuspect, class2PredicateKey, gapStoreRootForTest } = sg;
const { evaluateGapCheck, admitActionableGaps, __resetPolicyReadsForTests, sweepPendingLandVerifications, closeLandedGap } = g2f;
const { __setBirthJudgeForTests, birthTreeMoved, BIRTH_REEVAL_PER_TICK } = sg;

const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
// Named tests and whether they pass on "the current tree". A name not listed does not exist (never passes).
const tree: Record<string, "pass" | "fail"> = { "widget counts rejected frames": "fail", "widget already passes": "pass" };
let selfResolveCalls = 0;
let selfResolveMode: "answer" | "http500" = "answer";

const stubFetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // discovery (the ias client): a pool producer that holds the explicit open policy records.
    if (body?.pointer?.type === "vesselCapability") {
      const vessels = [{ vesselId: "dv", endpoint: "http://pool.test", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    const p = body?.impulse?.pointer;
    if (p?.type === "test_suite") {
      selfResolveCalls++;
      if (selfResolveMode === "http500") return new Response("boom", { status: 500 });
      const only = (p.only_tests ?? []) as string[];
      const notPassing = only.filter((t) => tree[t] !== "pass").length;
      return Response.json({ shape: "test_suite", body: { ran: true, total: only.length, pass: only.length - notPassing, fail: notPassing, requested_not_passing: notPassing } });
    }
    if (p?.type === "birth_probe") return Response.json({ shape: "birth_probe", body: { defects: 0 } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
function install(): void { globalThis.fetch = stubFetch; }
// THE BIRTH JUDGE IS INJECTED ON EVERY WRITE (qa C1): the real judge, on the stub transport, so a write here
// can never resolve against the live vessel even if the global fetch were restored underneath it.
const stubTransportJudge = (g: Record<string, unknown>) => evaluateGapCheck(g, { fetchImpl: stubFetch });

const testSuiteCheck = (name: string) => ({
  evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: [name], timeout_ms: 180000 }, zero_field: "requested_not_passing" },
});
async function write(id: string, meta: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<void> {
  const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id} for the birth tests`, detected_at: new Date().toISOString(), classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...meta } } } as never, { vocabulary: null, birthJudge: stubTransportJudge, ...opts } as never);
  expect(res.shape).not.toBe("structuredError");
}
async function row(id: string): Promise<Record<string, unknown>> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error("row not found: " + id);
  return g;
}
const metaOf = (g: Record<string, unknown>) => (g.classification_metadata ?? {}) as Record<string, unknown>;
async function admissionReason(g: Record<string, unknown>): Promise<string | null> {
  const { excluded, admitted } = await admitActionableGaps([g]);
  const ex = excluded.find((e) => e.id === g.id);
  if (ex) return ex.reason;
  return admitted.some((a) => a.id === g.id) ? null : "not admitted";
}

// Leave the shared gap store as this file found it (test/resolvers/gap-store-snapshot.ts).
let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  for (const k of ["VESSELS_CLONE_ROOT", "SUBSTRATE_PUSH_VESSELS", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "no-clones"); // no clones: every vessel counts as owned here
  mkdirSync(join(ROOT, "no-clones"), { recursive: true });
  install();
  __resetPolicyReadsForTests();
});
afterEach(() => { selfResolveMode = "answer"; });
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("birth evaluation at the substrateGap_write seam", () => {
  it("a class-2 test_suite check whose named test FAILS on the tree is stamped present, and is admissible", async () => {
    const id = `gf2-birth-red-${RUN}`;
    await write(id, testSuiteCheck("widget counts rejected frames"));
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("pending"); // decided at the write, run after it
    await __settleBirthEvaluationsForTests();
    const g = await row(id);
    expect(metaOf(g).falsifier).toBe("class2");
    expect(metaOf(g).predicate_birth_verdict).toBe("present");
    expect(metaOf(g).predicate_birth_key).toBe(class2PredicateKey(metaOf(g)));
    expect(predicateSuspect(metaOf(g))).toBeNull();
    const reason = await admissionReason(g);
    expect(String(reason ?? "")).not.toContain("predicate_suspect");
  });

  it("the same check naming a test that PASSES (an inverted predicate) is stamped absent and is NOT admissible", async () => {
    const id = `gf2-birth-inverted-${RUN}`;
    await write(id, testSuiteCheck("widget already passes"));
    await __settleBirthEvaluationsForTests();
    const g = await row(id);
    expect(metaOf(g).predicate_birth_verdict).toBe("absent");
    expect(await admissionReason(g)).toContain("predicate_suspect");
  });

  it("an unresolvable check is stamped unknown and is NOT admissible", async () => {
    const id = `gf2-birth-unknown-${RUN}`;
    selfResolveMode = "http500";
    await write(id, testSuiteCheck("widget counts rejected frames"));
    await __settleBirthEvaluationsForTests();
    const g = await row(id);
    expect(metaOf(g).predicate_birth_verdict).toBe("unknown");
    expect(await admissionReason(g)).toContain("predicate_suspect");
  });

  it("a check that times out is stamped unknown", async () => {
    const id = `gf2-birth-timeout-${RUN}`;
    await write(id, testSuiteCheck("widget counts rejected frames"), { birthJudge: (g: Record<string, unknown>) => evaluateGapCheck(g, { timeoutMs: 5, fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("timed out", "TimeoutError"))))) as unknown as typeof fetch }) });
    await __settleBirthEvaluationsForTests();
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("unknown");
  });

  it("a writer cannot forge a birth verdict: a new check carrying predicate_birth_verdict present is evaluated anyway", async () => {
    const id = `gf2-birth-forged-${RUN}`;
    const check = testSuiteCheck("widget already passes");
    await write(id, { ...check, predicate_birth_verdict: "present", predicate_birth_at: new Date().toISOString(), predicate_birth_key: class2PredicateKey(check) });
    await __settleBirthEvaluationsForTests();
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("absent");
  });

  it("a re-emission of the SAME check is not evaluated again; a changed check is", async () => {
    const id = `gf2-birth-reemit-${RUN}`;
    await write(id, testSuiteCheck("widget counts rejected frames"));
    await __settleBirthEvaluationsForTests();
    const before = selfResolveCalls;
    await write(id, {}); // a detector re-emission with predicate-free metadata: the store carries the check forward
    await write(id, testSuiteCheck("widget counts rejected frames"));
    await __settleBirthEvaluationsForTests();
    expect(selfResolveCalls).toBe(before);
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
    await write(id, testSuiteCheck("widget already passes"));
    await __settleBirthEvaluationsForTests();
    expect(selfResolveCalls).toBe(before + 1);
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("absent");
  });

  it("a trusted in-process verdict for the exact check is honoured without a second evaluation; for another check it is not", async () => {
    const id = `gf2-birth-trusted-${RUN}`;
    const check = testSuiteCheck("widget counts rejected frames");
    const before = selfResolveCalls;
    await write(id, check, { birthVerdict: { predicate_key: class2PredicateKey(check), verdict: "present" } });
    await __settleBirthEvaluationsForTests();
    expect(selfResolveCalls).toBe(before);
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
    const id2 = `gf2-birth-trusted-mismatch-${RUN}`;
    await write(id2, testSuiteCheck("widget already passes"), { birthVerdict: { predicate_key: class2PredicateKey(check), verdict: "present" } });
    await __settleBirthEvaluationsForTests();
    expect(metaOf(await row(id2)).predicate_birth_verdict).toBe("absent");
  });

  it("a row that already carried the same check before birth stamps is not re-judged by a re-emission (not a birth)", async () => {
    const id = `gf2-birth-legacy-${RUN}`;
    const check = testSuiteCheck("widget already passes"); // would read absent if it were evaluated now
    const gapsPath = join(gapStoreRootForTest(), "gaps", "gaps.json");
    mkdirSync(join(gapStoreRootForTest(), "gaps"), { recursive: true });
    const existing = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, "utf8")) as unknown[] : [];
    const now = new Date().toISOString();
    writeFileSync(gapsPath, JSON.stringify([...existing, { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id} for the birth tests`, detected_at: now, created_at: now, updated_at: now, classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...check, falsifier: "class2" } }]));
    const before = selfResolveCalls;
    await write(id, check);
    await __settleBirthEvaluationsForTests();
    expect(selfResolveCalls).toBe(before);
    expect(metaOf(await row(id)).predicate_birth_verdict).toBeUndefined();
    await write(id, testSuiteCheck("widget counts rejected frames")); // a CHANGED check is a birth
    await __settleBirthEvaluationsForTests();
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
  });

  it("rows written before birth stamps are unaffected (no verdict: not suspect)", () => {
    expect(predicateSuspect({ falsifier: "class2", evidence_resolve: { shape: "x", zero_field: "n" } })).toBeNull();
    expect(predicateSuspect({ falsifier: "none" })).toBeNull();
  });
});

describe("evaluateGapCheck — one judge, with the check's own budget", () => {
  it("passes the test_suite timeout_ms through (plus the resolver's own margin); other shapes keep 10 s", async () => {
    const seen: number[] = [];
    const spy = spyOn(AbortSignal, "timeout").mockImplementation(((ms: number) => { seen.push(ms); return new AbortController().signal; }) as never);
    try {
      const fetchImpl = (async () => Response.json({ body: { requested_not_passing: 1, defects: 1 } })) as unknown as typeof fetch;
      expect(await evaluateGapCheck({ id: "t1", classification_metadata: testSuiteCheck("widget counts rejected frames") }, { fetchImpl })).toBe("present");
      expect(await evaluateGapCheck({ id: "t2", classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/v", test_file: "a.test.ts", only_tests: ["x"] }, zero_field: "requested_not_passing" } } }, { fetchImpl })).toBe("present");
      expect(await evaluateGapCheck({ id: "t3", classification_metadata: { evidence_resolve: { shape: "birth_probe", zero_field: "defects" } } }, { fetchImpl })).toBe("present");
    } finally { spy.mockRestore(); }
    expect(seen).toEqual([180_000 + 60_000, 240_000 + 60_000, 10_000]);
  });
});

describe("closure: a check that never read present at birth closes nothing (8.5)", () => {
  const CLONES = join(ROOT, "clones");
  const git = (repo: string, ...args: string[]): string => {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  it("the pending-land sweep closes a landed gap whose check read present at birth, and NOT one whose check read absent at birth", async () => {
    const repo = join(CLONES, "fixture-vessel");
    mkdirSync(join(repo, "test"), { recursive: true });
    git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
    // Test-only commits count as running on landing (landedCommitRunningHere), so no systemd is consulted.
    // Each landing needs a parent: diff-tree names no files for a root commit.
    writeFileSync(join(repo, "README.md"), "fixture\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
    writeFileSync(join(repo, "test", "a.test.ts"), "// a\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "landing a");
    const shaSuspect = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "test", "b.test.ts"), "// b\n"); git(repo, "add", "."); git(repo, "commit", "-q", "-m", "landing b");
    const shaTrusted = git(repo, "rev-parse", "HEAD");
    // A pinnable own check that passes now (reads absent), so the sweep can take its independent verdict.
    const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: ["widget already passes"] }, zero_field: "requested_not_passing" } };
    const key = class2PredicateKey(check);
    const now = new Date().toISOString();
    const base = { category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: now, created_at: now, updated_at: now, summary: "a landed class-2 gap" };
    const gapsPath = join(gapStoreRootForTest(), "gaps", "gaps.json");
    mkdirSync(join(gapStoreRootForTest(), "gaps"), { recursive: true });
    const existing = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, "utf8")) as unknown[] : [];
    const idSuspect = `gf2-close-suspect-${RUN}`, idTrusted = `gf2-close-trusted-${RUN}`;
    writeFileSync(gapsPath, JSON.stringify([...existing,
      { ...base, id: idSuspect, classification_metadata: { ...check, falsifier: "class2", edit_site: "repos/fixture-vessel/src/widget.ts", pending_outcome_verification: shaSuspect, pending_set_at: now, predicate_birth_verdict: "absent", predicate_birth_key: key, predicate_birth_at: now } },
      { ...base, id: idTrusted, classification_metadata: { ...check, falsifier: "class2", edit_site: "repos/fixture-vessel/src/widget.ts", pending_outcome_verification: shaTrusted, pending_set_at: now, predicate_birth_verdict: "present", predicate_birth_key: key, predicate_birth_at: now } },
    ]));
    const prevClones = process.env["VESSELS_CLONE_ROOT"];
    process.env["VESSELS_CLONE_ROOT"] = CLONES;
    // The sweep also re-takes unknown birth verdicts (R1) through the override judge: inject it (C1).
    __setBirthJudgeForTests(stubTransportJudge);
    // Both landings flip their check at the pinned trees (red at parent, green at the landing): the independent
    // verdict grounds either, so the birth stamp is all that differs.
    g2f.__setPinnedCheckForTests({
      parentOf: (sha) => git(repo, "rev-parse", `${sha}^`),
      runAt: async (gap, ref) => (ref === git(repo, "rev-parse", `${String(((gap.classification_metadata ?? {}) as Record<string, unknown>).pending_outcome_verification)}^`) ? "present" : "absent"),
    });
    try { await sweepPendingLandVerifications(); await __settleBirthEvaluationsForTests(); } finally { process.env["VESSELS_CLONE_ROOT"] = prevClones; __setBirthJudgeForTests(null); g2f.__setPinnedCheckForTests(null); }
    expect(String((await row(idTrusted)).status)).toBe("closed"); // positive control through the same address
    expect(String((await row(idSuspect)).status)).toBe("open");
  });
});

// ─── qa conditions on v2 (C1, C2, C3', R1) ──────────────────────────────────
function seedRows(rows: Array<Record<string, unknown>>): void {
  const gapsPath = join(gapStoreRootForTest(), "gaps", "gaps.json");
  mkdirSync(join(gapStoreRootForTest(), "gaps"), { recursive: true });
  const existing = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, "utf8")) as unknown[] : [];
  writeFileSync(gapsPath, JSON.stringify([...existing, ...rows]));
}
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const gitIn = (repo: string, ...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};

describe("C1: no birth resolve leaves a test that injects the judge", () => {
  // Every write also publishes devvessel.gap.written to activity-api (/v2/events/publish), a pre-existing
  // fire-and-forget that predates birth evaluation; the guard counts every OTHER network call.
  it("a class-2 write with an injected judge makes ZERO birth network calls; with none, the default judge reaches fetch (positive control)", async () => {
    const urls: string[] = [];
    const thrower = (async (input: unknown) => { urls.push(typeof input === "string" ? input : String((input as { url?: string }).url ?? input)); throw new Error("network is forbidden in this test"); }) as unknown as typeof fetch;
    const birthCalls = (): number => urls.filter((u) => !u.endsWith("/v2/events/publish")).length;
    __setBirthJudgeForTests(null);
    globalThis.fetch = thrower;
    // The positive control below counts the gap-written publish, and a scratch-root store refuses that publish
    // unless a test opts in (substrate-gap.ts, gapEventPublishFromScratchAllowed). This file's store is always
    // scratch once nothing leaks a real root into the run, so opt in here; the thrower keeps it off any bus.
    sg.__allowGapEventPublishFromScratchForTests(true);
    try {
      const id = `gf2-guard-injected-${RUN}`;
      await write(id, testSuiteCheck("widget counts rejected frames"), { birthJudge: async () => "present" });
      await __settleBirthEvaluationsForTests();
      expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
      expect(urls.length).toBeGreaterThan(0); // the thrower is installed on the path the write takes
      expect(birthCalls()).toBe(0);
      // The same write with NO injected judge: the default judge resolves over the global fetch. The guard can
      // see a default-judge invocation, so its zero above is attributable.
      const id2 = `gf2-guard-default-${RUN}`;
      const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: id2, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id2} for the guard`, detected_at: new Date().toISOString(), classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...testSuiteCheck("widget counts rejected frames") } } } as never, { vocabulary: null } as never);
      expect(res.shape).not.toBe("structuredError");
      await __settleBirthEvaluationsForTests();
      expect(birthCalls()).toBeGreaterThan(0);
      expect(urls.some((u) => u.endsWith("/v2/impulses/resolve"))).toBe(true);
      expect(metaOf(await row(id2)).predicate_birth_verdict).toBe("unknown");
    } finally { sg.__allowGapEventPublishFromScratchForTests(false); install(); }
  });
});

describe("C2: closeLandedGap never closes on an absent from a suspect check", () => {
  it("a gap stamped absent at birth, landed, reading absent now, stays OPEN on predicate_suspect; the same gap stamped present passes that guard and is held for the sweep's independent verdict", async () => {
    const check = { evidence_resolve: { shape: "birth_probe", zero_field: "defects" } }; // reads 0 (absent) now
    const key = class2PredicateKey(check);
    const now = new Date().toISOString();
    const base = { category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: now, created_at: now, updated_at: now, summary: "a landed class-2 gap (closeLandedGap)" };
    const idSuspect = `gf2-cl-suspect-${RUN}`, idTrusted = `gf2-cl-trusted-${RUN}`;
    const meta = (verdict: string) => ({ ...check, falsifier: "class2", edit_site: "repos/fixture-vessel/src/widget.ts", predicate_birth_verdict: verdict, predicate_birth_key: key, predicate_birth_at: now });
    const land = { landed: true, commit_sha: "0123456789abcdef0123456789abcdef01234567", vessel: "fixture-vessel", push_status: "pushed" };
    seedRows([{ ...base, id: idSuspect, classification_metadata: meta("absent") }, { ...base, id: idTrusted, classification_metadata: meta("present") }]);
    const suspect = await closeLandedGap(await row(idSuspect), land as never);
    const trusted = await closeLandedGap(await row(idTrusted), land as never);
    await __settleBirthEvaluationsForTests();
    // Positive control through the same function, same inputs but the stamp: it passes the suspect guard and reaches
    // the close, which the cutover path never makes verified (independent landing verdict): held pending instead.
    expect(trusted.closed).toBe(false);
    expect(String(trusted.error)).toContain("awaiting independent verdict");
    expect(String((await row(idTrusted)).status)).toBe("open");
    expect(suspect.closed).toBe(false);
    expect(String(suspect.error)).toContain("predicate_suspect");
    expect(String((await row(idSuspect)).status)).toBe("open");
  });
});

describe("C3': the tree a birth verdict was taken on", () => {
  const SHA_CLONES = join(ROOT, "sha-clones");
  const repo = join(SHA_CLONES, "fixture-vessel");
  const OTHER = "1111111111111111111111111111111111111111"; // a sha no clone holds: the diff cannot run
  const head = (): string => gitIn(repo, "rev-parse", "HEAD");
  const commit = (file: string, text: string): string => { mkdirSync(join(repo, file, ".."), { recursive: true }); writeFileSync(join(repo, file), text); gitIn(repo, "add", "."); gitIn(repo, "commit", "-q", "-m", `touch ${file}`); return head(); };
  const withShaClones = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env["VESSELS_CLONE_ROOT"];
    process.env["VESSELS_CLONE_ROOT"] = SHA_CLONES;
    try { await fn(); } finally { process.env["VESSELS_CLONE_ROOT"] = prev; }
  };
  beforeAll(() => {
    mkdirSync(repo, { recursive: true });
    gitIn(repo, "init", "-q"); gitIn(repo, "config", "user.email", "t@t"); gitIn(repo, "config", "user.name", "t");
    // The check's dependent files: its test file (test/widget.test.ts) and the edit site (src/widget.ts).
    commit("README.md", "sha fixture\n"); commit("test/widget.test.ts", "// tests v1\n"); commit("src/widget.ts", "// widget v1\n");
  });

  it("the queued sha is recorded when the evaluation is SCHEDULED", async () => {
    const id = `gf2-sha-queued-${RUN}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await withShaClones(async () => {
      await write(id, testSuiteCheck("widget counts rejected frames"), { birthJudge: async () => { await gate; return "present"; } });
      const m = metaOf(await row(id));
      expect(m.predicate_birth_verdict).toBe("pending");
      expect(m.predicate_birth_queued_sha).toBe(head());
      release();
      await __settleBirthEvaluationsForTests();
    });
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
  });

  it("same sha + absent: stamped absent, with both shas, and suspect", async () => {
    const id = `gf2-sha-same-${RUN}`;
    const h = head();
    await withShaClones(async () => { await write(id, testSuiteCheck("widget already passes"), { detectedSha: h }); await __settleBirthEvaluationsForTests(); });
    const m = metaOf(await row(id));
    expect(m.predicate_birth_verdict).toBe("absent");
    expect(m.predicate_birth_sha).toBe(h);
    expect(m.predicate_birth_detected_sha).toBe(h);
    expect(predicateSuspect(m)).not.toBeNull();
  });

  it("HEAD moved since detection but the dependent files did not change + absent: stays absent (suspect)", async () => {
    const id = `gf2-sha-moved-unrelated-${RUN}`;
    const detected = head();
    const now = commit("README.md", "unrelated change\n");
    await withShaClones(async () => { await write(id, testSuiteCheck("widget already passes"), { detectedSha: detected }); await __settleBirthEvaluationsForTests(); });
    const m = metaOf(await row(id));
    expect(m.predicate_birth_verdict).toBe("absent");
    expect(m.predicate_birth_sha).toBe(now);
    expect(m.predicate_birth_tree_moved).toBeUndefined();
    expect(String(m.predicate_birth_tree_reason)).toContain("did not change");
    expect(predicateSuspect(m)).not.toBeNull();
  });

  it("the check's test file changed since detection + absent: unknown (tree moved), NOT suspect", async () => {
    const id = `gf2-sha-moved-${RUN}`;
    const detected = head();
    commit("test/widget.test.ts", "// tests v2\n");
    await withShaClones(async () => { await write(id, testSuiteCheck("widget already passes"), { detectedSha: detected }); await __settleBirthEvaluationsForTests(); });
    const g = await row(id);
    const m = metaOf(g);
    expect(m.predicate_birth_verdict).toBe("unknown");
    expect(m.predicate_birth_tree_moved).toBe(true);
    expect(String(m.predicate_birth_tree_reason)).toContain("test/widget.test.ts");
    expect(birthTreeMoved(m)).toBe(true);
    expect(predicateSuspect(m)).toBeNull();
    expect(String(await admissionReason(g) ?? "")).not.toContain("predicate_suspect");
  });

  it("with no detected sha the QUEUED sha is the base: the edit site changed between queue and eval + absent: unknown", async () => {
    const idBlock = `gf2-sha-block-${RUN}`, id = `gf2-sha-queued-moved-${RUN}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await withShaClones(async () => {
      await write(idBlock, testSuiteCheck("widget counts rejected frames"), { birthJudge: async () => { await gate; return "present"; } }); // holds the one-at-a-time chain
      await write(id, testSuiteCheck("widget already passes")); // queued on today's HEAD
      const queued = String(metaOf(await row(id)).predicate_birth_queued_sha);
      const now = commit("src/widget.ts", "// widget v2\n"); // the edit site changes while it waits
      release();
      await __settleBirthEvaluationsForTests();
      const m = metaOf(await row(id));
      expect(queued).not.toBe(now);
      expect(m.predicate_birth_sha).toBe(now);
      expect(m.predicate_birth_verdict).toBe("unknown");
      expect(String(m.predicate_birth_tree_reason)).toContain("queued");
      expect(String(m.predicate_birth_tree_reason)).toContain("src/widget.ts");
    });
  });

  it("the diff cannot run (a detection sha no clone holds) + absent: unknown, with the reason recorded", async () => {
    const id = `gf2-sha-difffail-${RUN}`;
    await withShaClones(async () => { await write(id, testSuiteCheck("widget already passes"), { detectedSha: OTHER }); await __settleBirthEvaluationsForTests(); });
    const m = metaOf(await row(id));
    expect(m.predicate_birth_verdict).toBe("unknown");
    expect(m.predicate_birth_tree_moved).toBe(true);
    expect(String(m.predicate_birth_tree_reason)).toContain("diff failed");
    expect(predicateSuspect(m)).toBeNull();
  });

  it("different sha + present stays present (a defect still there on a later tree was there at detection too)", async () => {
    const id = `gf2-sha-moved-present-${RUN}`;
    await withShaClones(async () => { await write(id, testSuiteCheck("widget counts rejected frames"), { detectedSha: OTHER }); await __settleBirthEvaluationsForTests(); });
    expect(metaOf(await row(id)).predicate_birth_verdict).toBe("present");
  });

  it("detection sha unknown, nothing moved since queueing: absent with the evaluated sha recorded; sha fields on the incoming write are not trusted", async () => {
    const id = `gf2-sha-nodetect-${RUN}`;
    await withShaClones(async () => {
      await write(id, { ...testSuiteCheck("widget already passes"), predicate_birth_detected_sha: OTHER, predicate_birth_sha: OTHER, predicate_birth_queued_sha: OTHER, predicate_birth_tree_moved: true });
      await __settleBirthEvaluationsForTests();
    });
    const m = metaOf(await row(id));
    expect(m.predicate_birth_verdict).toBe("absent");
    expect(m.predicate_birth_sha).toBe(head());
    expect(m.predicate_birth_queued_sha).toBe(head());
    expect(m.predicate_birth_detected_sha).toBeUndefined();
    expect(predicateSuspect(m)).not.toBeNull();
  });
});

describe("R1: the sweep re-takes unknown and dead-pending birth verdicts, bounded and oldest first", () => {
  it(`re-takes at most ${BIRTH_REEVAL_PER_TICK} per tick, oldest first; skips fresh pending, tree-moved unknown and closed rows; a write no longer re-takes`, async () => {
    const check = testSuiteCheck("widget counts rejected frames");
    const key = class2PredicateKey(check);
    const mk = (id: string, verdict: string, ago: number, extra: Record<string, unknown> = {}, status = "open") => ({
      id, category: "systematic_failure", source: "substrate_detected", status, summary: `gap ${id} for R1`, detected_at: isoAgo(ago), created_at: isoAgo(ago), updated_at: isoAgo(ago),
      classification_metadata: { edit_site: "repos/fixture-vessel/src/widget.ts", ...check, falsifier: "class2", predicate_birth_verdict: verdict, predicate_birth_key: key, predicate_birth_at: isoAgo(ago), ...extra },
    });
    const ids = { a: `gf2-r1-a-${RUN}`, b: `gf2-r1-b-${RUN}`, c: `gf2-r1-c-${RUN}`, d: `gf2-r1-d-${RUN}`, e: `gf2-r1-e-${RUN}`, f: `gf2-r1-f-${RUN}`, w: `gf2-r1-w-${RUN}` };
    seedRows([
      mk(ids.a, "unknown", 50 * 3600_000),             // oldest unknown: re-taken
      mk(ids.b, "pending", 40 * 3600_000),             // pending past the hour: re-taken
      mk(ids.c, "unknown", 30 * 3600_000),             // third oldest: waits for the next tick
      mk(ids.d, "pending", 10 * 60_000),               // pending, fresh: its evaluation may still be running
      mk(ids.e, "unknown", 90 * 3600_000, { predicate_birth_tree_moved: true, predicate_birth_tree_reason: "test/widget.test.ts changed" }), // tree moved: a re-take cannot resolve it
      mk(ids.f, "unknown", 95 * 3600_000, {}, "closed"),
      mk(ids.w, "unknown", 7 * 3600_000),              // written again below: the write carries it forward
    ]);
    const judged: string[] = [];
    __setBirthJudgeForTests(async (g) => { judged.push(String(g.id)); return "present"; });
    try {
      // The write path no longer re-takes (one retry path): the same check, written again, carries its unknown.
      const before = metaOf(await row(ids.w));
      await write(ids.w, check, { birthJudge: async (g: Record<string, unknown>) => { judged.push(String(g.id)); return "present"; } });
      await __settleBirthEvaluationsForTests();
      expect(metaOf(await row(ids.w)).predicate_birth_verdict).toBe("unknown");
      expect(metaOf(await row(ids.w)).predicate_birth_at).toBe(before.predicate_birth_at);
      expect(judged).toEqual([]);

      await sweepPendingLandVerifications();
      await __settleBirthEvaluationsForTests();
      expect(judged).toEqual([ids.a, ids.b]); // one at a time on the birth chain, oldest first
      expect(metaOf(await row(ids.a)).predicate_birth_verdict).toBe("present");
      expect(metaOf(await row(ids.b)).predicate_birth_verdict).toBe("present");
      expect(metaOf(await row(ids.c)).predicate_birth_verdict).toBe("unknown");
      expect(metaOf(await row(ids.d)).predicate_birth_verdict).toBe("pending");
      expect(metaOf(await row(ids.e)).predicate_birth_verdict).toBe("unknown");
      expect(metaOf(await row(ids.f)).predicate_birth_verdict).toBe("unknown");

      await sweepPendingLandVerifications();
      await __settleBirthEvaluationsForTests();
      expect(judged.slice(2)).toContain(ids.c);
      expect(judged).not.toContain(ids.d);
      expect(judged).not.toContain(ids.e);
      expect(judged).not.toContain(ids.f);
    } finally { __setBirthJudgeForTests(null); }
  });
});
