// I4a: LEARNING CREDIT IS WRITTEN THROUGH TO THE GAP-STORE HOLDER: journaled, replayed, idempotent, and referenced.
// The class posterior, the close-oracle calibration and the detector credit were written to node-local files, so each
// node learned only from its own composes (qa ruling 2026-10-16: write-through, not inference; same call sites and
// decisions, only the storage moves). Pinned here:
//   EQUIVALENCE: a credit moves the holder's table exactly as the former local writer moved the local file.
//   NO LOSS: a holder outage leaves the credit pending; the next credit replays it; nothing doubles.
//   IDEMPOTENT: the same credit twice is one increment (a duplicate the second time).
//   REFERENCED (G4): sha: present in a holder clone -> applied; absent and origin/dev has NOT moved since the event ->
//   unresolved (retried); absent although origin/dev moved after the event -> refused. decision: in the gap's ledger ->
//   applied, else refused. Recency is git's reflog of refs/remotes/origin/dev, never a file mtime.
//   UNREFERENCED: a call site with no reference journals the credit as unreferenced and credits nothing (never invented).
//   ATTEMPT: a compose failure without a pick references its own failed_attempts bump, so no failure is dropped.
//   RELAND: two re-land escalations of one gap (a restart re-firing the in-memory dedup) are ONE false close.
// Driven through a temp gap store, temp table/journal files and a temp vessel clone; the holder for the outage case is
// this process with GAP_STORE_ENDPOINT unset, reached through a fetch stub.
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "learning-credit-wt-"));
const KEYS = ["WORKSPACE_ROOT", "GAP_STORE_ENDPOINT", "GAP_CLASS_POSTERIOR_PATH", "CLOSE_ORACLE_CALIB_PATH", "DETECTOR_CLOSURE_LEDGER_PATH", "LEARNING_CREDIT_JOURNAL_PATH", "VESSELS_CLONE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env["WORKSPACE_ROOT"] = join(ROOT, "ws"); mkdirSync(process.env["WORKSPACE_ROOT"], { recursive: true });
isolateLearnedStateInProcess(process.env["WORKSPACE_ROOT"]); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones"); mkdirSync(process.env["VESSELS_CLONE_ROOT"], { recursive: true });
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];
const tbl = (n: string) => join(ROOT, `${n}.json`);
process.env["GAP_CLASS_POSTERIOR_PATH"] = tbl("class");
process.env["CLOSE_ORACLE_CALIB_PATH"] = tbl("oracle");
process.env["DETECTOR_CLOSURE_LEDGER_PATH"] = tbl("detector");
// The journal lives beside the learned tables (no location of its own).
const JOURNAL = join(ROOT, "learning-credit-journal.json");

const sg = await import("../../src/resolvers/substrate-gap.js");
const lc = await import("../../src/judge/learning-credit.js");
const credit = await import("../../src/judge/gap-attempt-credit.js");
const { isWritePointerType } = await import("../../src/lib/caller-credential.js");
const RUN = Math.random().toString(36).slice(2, 8);
const warn = spyOn(console, "warn").mockImplementation(() => {});
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch; warn.mockRestore();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
const read = (n: string): Record<string, any> => { try { return JSON.parse(readFileSync(tbl(n), "utf8")); } catch { return {}; } };
const journal = (): Array<Record<string, any>> => { try { return JSON.parse(readFileSync(JOURNAL, "utf8")); } catch { return []; } };
function resetTables(): void { for (const n of ["class", "oracle", "detector"]) { rmSync(tbl(n), { force: true }); rmSync(`${tbl(n)}.applied.json`, { force: true }); } rmSync(JOURNAL, { force: true }); try { rmSync(join(ROOT, "holder"), { recursive: true, force: true }); mkdirSync(join(ROOT, "holder"), { recursive: true }); } catch { /* temp */ } }
const HOLDER = "http://holder.test/v2/impulses/resolve";
/** This process as a NON-holder whose holder is the in-process door (applyCreditAtHolder), reached through a fetch stub;
 *  `up()` false = the holder is down. */
// The real holder is ANOTHER node, with its own process and its own table files: the stand-in holder is a SEPARATE bun
// process (a fresh module registry and env) that applies the credit to HDIR. In-process, swapping this process's table
// env during the apply raced the caller's own fire-and-forget local write.
const HDIR = join(ROOT, "holder"); mkdirSync(HDIR, { recursive: true });
const readH = (n: string): Record<string, any> => { try { return JSON.parse(readFileSync(join(HDIR, `${n}.json`), "utf8")); } catch { return {}; } };
const HOLDER_SCRIPT = join(ROOT, "holder-apply.ts");
writeFileSync(HOLDER_SCRIPT, `const lc = await import(${JSON.stringify(join(import.meta.dir, "..", "..", "src", "judge", "learning-credit.js"))});
const ptr = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify(await lc.applyCreditAtHolder(ptr)));
process.exit(0);
`);
// The holder is ONE process: requests reach it one at a time here (its in-process concurrency is pinned separately below).
let holderQueue: Promise<unknown> = Promise.resolve();
function asNonHolder(up: () => boolean = () => true): void {
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const run = holderQueue.then(() => holderCall(u, init, up));
    holderQueue = run.catch(() => undefined);
    return run;
  }) as unknown as typeof fetch;
}
async function holderCall(_u: unknown, init: RequestInit | undefined, up: () => boolean): Promise<Response> {
  {
    if (!up()) throw new TypeError("Unable to connect");
    const ptr = JSON.parse(String(init?.body ?? "{}")).impulse.pointer;
    // The holder reads the gap store THIS process's gap module actually writes (its root is fixed when substrate-gap.js is
    // first loaded, and in a whole-suite run an earlier file loads it first): the fixture gaps' references (decision:,
    // attempt:) are then visible to the holder exactly as a real holder sees its own store.
    const holderRoot = (sg as { gapStoreRootForTest: () => string }).gapStoreRootForTest();
    // Never point a holder at a real store: the root must be a scratch (tmpdir) store, as substrate-gap.test.ts requires.
    if (!(sg as { isScratchGapStoreRoot: (r: string) => boolean }).isScratchGapStoreRoot(holderRoot)) throw new Error(`stand-in holder refused: gap store root ${holderRoot} is not a scratch store`);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), WORKSPACE_ROOT: holderRoot, GAP_CLASS_POSTERIOR_PATH: join(HDIR, "class.json"), CLOSE_ORACLE_CALIB_PATH: join(HDIR, "oracle.json"), DETECTOR_CLOSURE_LEDGER_PATH: join(HDIR, "detector.json") };
    delete env["GAP_STORE_ENDPOINT"];
    const p = Bun.spawn([process.execPath, HOLDER_SCRIPT], { stdin: new Blob([JSON.stringify(ptr)]), stdout: "pipe", stderr: "ignore", env });
    const out = await new Response(p.stdout).text(); await p.exited;
    return Response.json({ shape: "gapLearningCreditResult", body: JSON.parse(out || "null") });
  }
}

const git = (dir: string, ...args: string[]): string => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.logAllRefUpdates=true", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
};
const CLONE = join(process.env["VESSELS_CLONE_ROOT"]!, "development-vessel");
mkdirSync(CLONE, { recursive: true });
git(CLONE, "init", "-q");
writeFileSync(join(CLONE, "f.txt"), "x\n"); git(CLONE, "add", "f.txt"); git(CLONE, "commit", "-q", "-m", "landed");
const SHA = git(CLONE, "rev-parse", "HEAD");
// origin/dev moved (a fetch) NOW: the reflog records the time.
git(CLONE, "update-ref", "refs/remotes/origin/dev", SHA);
const FAKE = "0123456789abcdef0123456789abcdef01234567";

const GAP = `lc-gap-${RUN}`;
await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: GAP, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `learning credit fixture ${RUN}`, classification_metadata: { approach_decisions: [{ decision_id: "dec-known" }] } } } as never);
await (sg as any).__settleBirthEvaluationsForTests?.();

const GAP2 = `lc-gap2-${RUN}`;
await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: GAP2, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `learning credit fixture two ${RUN}`, classification_metadata: { failed_attempts: 2 } } } as never);
await (sg as any).__settleBirthEvaluationsForTests?.();
const verdict = await import("../../src/judge/gap-landing-verdict.js");
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const credit1 = (o: Partial<Record<string, any>> = {}) => ({ table: "class_posteriors", key: "X", outcome: "landed", gap_id: GAP, event_id: `sha:${SHA}`, created_at: at(60_000), ...o }) as any;

beforeEach(() => { resetTables(); delete process.env["GAP_STORE_ENDPOINT"]; globalThis.fetch = originalFetch; });

describe("the holder's apply: equivalence, idempotency, references", () => {
  it("[MUST-FAIL] EQUIVALENCE: a landed credit moves the class posterior as the local writer did (Beta(1,1) -> alpha 2)", async () => {
    expect((await lc.applyCreditAtHolder(credit1())).status).toBe("applied");
    expect(read("class")["X"]).toEqual({ alpha: 2, beta: 1 });
    expect((await lc.applyCreditAtHolder(credit1({ key: "Y", outcome: "failed" }))).status).toBe("applied");
    expect(read("class")["Y"]).toEqual({ alpha: 1, beta: 2 });
  });

  it("[MUST-FAIL] IDEMPOTENT: the same credit twice is one increment", async () => {
    await lc.applyCreditAtHolder(credit1());
    expect((await lc.applyCreditAtHolder(credit1())).status).toBe("duplicate");
    expect(read("class")["X"]).toEqual({ alpha: 2, beta: 1 });
  });

  it("[MUST-FAIL] RELAND: two re-land escalations of one gap (a restart) are ONE false close", async () => {
    const c = { table: "close_oracle", key: "landed_commit", outcome: "false_close", gap_id: GAP, event_id: `reland:${GAP}`, created_at: at(1000) } as any;
    await lc.applyCreditAtHolder(c); await lc.applyCreditAtHolder({ ...c, created_at: at(10) });
    expect(read("oracle")["landed_commit"]).toEqual({ closes: 0, false_closes: 1 });
  });

  it("[CONTROL] a decision in the gap's ledger applies; a fabricated one is refused, the table unchanged", async () => {
    expect((await lc.applyCreditAtHolder(credit1({ outcome: "failed", event_id: "decision:dec-known" }))).status).toBe("applied");
    const r = await lc.applyCreditAtHolder(credit1({ key: "Z", outcome: "failed", event_id: "decision:dec-fabricated" }));
    expect(r.status).toBe("refused");
    expect(read("class")["Z"]).toBeUndefined();
  });

  it("[CONTROL] a sha absent from the clone although origin/dev moved after the event is refused", async () => {
    expect((await lc.applyCreditAtHolder(credit1({ event_id: `sha:${FAKE}`, created_at: at(60_000) }))).status).toBe("refused");
  });

  it("[MUST-FAIL] a sha the holder has not fetched yet (origin/dev not moved since the event) is UNRESOLVED, then applied once fetched", async () => {
    const future = credit1({ event_id: `sha:${FAKE}`, created_at: new Date(Date.now() + 120_000).toISOString() });
    expect((await lc.applyCreditAtHolder(future)).status).toBe("unresolved");
    // the holder fetches: the commit arrives in the clone
    writeFileSync(join(CLONE, "g.txt"), "y\n"); git(CLONE, "add", "g.txt"); git(CLONE, "commit", "-q", "-m", "pushed later");
    const later = git(CLONE, "rev-parse", "HEAD");
    expect((await lc.applyCreditAtHolder({ ...future, event_id: `sha:${later}` })).status).toBe("applied");
  });

  it("[CONTROL] an mtime-touched FETCH_HEAD with no real fetch does not flip UNRESOLVED to REFUSED", async () => {
    writeFileSync(join(CLONE, ".git", "FETCH_HEAD"), ""); utimesSync(join(CLONE, ".git", "FETCH_HEAD"), new Date(Date.now() + 600_000), new Date(Date.now() + 600_000));
    const future = credit1({ event_id: `sha:${FAKE}`, created_at: new Date(Date.now() + 120_000).toISOString() });
    expect((await lc.applyCreditAtHolder(future)).status).toBe("unresolved");
  });

  it("[MUST-FAIL] a compose failure with NO decision credits beta once, keyed by its own bump (attempt:<gap>#n); a replay does not double-count", async () => {
    const c = { table: "class_posteriors", key: "F", outcome: "failed", gap_id: GAP2, event_id: `attempt:${GAP2}#2`, created_at: at(1000) } as any;
    expect((await lc.applyCreditAtHolder(c)).status).toBe("applied");
    expect((await lc.applyCreditAtHolder(c)).status).toBe("duplicate");
    expect(read("class")["F"]).toEqual({ alpha: 1, beta: 2 });
  });

  it("[MUST-FAIL] the holder's own concurrency: six credits applied at once in the holder process each apply exactly once", async () => {
    const keys = ["C1", "C2", "C3", "C4", "C5", "C6"];
    const res = await Promise.all(keys.map((k) => lc.applyCreditAtHolder(credit1({ key: k }))));
    expect(res.every((r) => r.status === "applied")).toBe(true);
    for (const k of keys) expect(read("class")[k]).toEqual({ alpha: 2, beta: 1 });
    const again = await Promise.all(keys.map((k) => lc.applyCreditAtHolder(credit1({ key: k }))));
    expect(again.every((r) => r.status === "duplicate")).toBe(true);
  });

  it("[CONTROL] an attempt whose bump is not visible yet is unresolved; one naming another gap is refused", async () => {
    expect((await lc.applyCreditAtHolder({ table: "class_posteriors", key: "F", outcome: "failed", gap_id: GAP2, event_id: `attempt:${GAP2}#3`, created_at: at(1000) } as any)).status).toBe("unresolved");
    expect((await lc.applyCreditAtHolder({ table: "class_posteriors", key: "F", outcome: "failed", gap_id: GAP2, event_id: `attempt:${GAP}#1`, created_at: at(1000) } as any)).status).toBe("refused");
  });

  it("[UNIT] failureEventId: the pick's decision when there is one, else the bump's own value, else null", () => {
    expect(verdict.failureEventId({ id: "g" }, "dec-1", { failed_attempts: 4 })).toBe("decision:dec-1");
    expect(verdict.failureEventId({ id: "g" }, undefined, { failed_attempts: 4 })).toBe("attempt:g#4");
    expect(verdict.failureEventId({ id: "g" }, undefined, {})).toBeNull();
  });

  it("[HELD-OUT] the detector credit and the operator_engaged column follow the same path", async () => {
    await lc.applyCreditAtHolder({ table: "detector_credit", key: "D", outcome: "closure", gap_id: GAP, event_id: `sha:${SHA}`, created_at: at(1000) } as any);
    await lc.applyCreditAtHolder({ table: "close_oracle", key: "landed_commit", outcome: "operator_engaged", gap_id: GAP, event_id: `engagement:reland-needs-human-${GAP}`, created_at: at(1000) } as any);
    expect(read("detector")["D"]?.closures).toBe(1);
    expect(read("oracle")["landed_commit"]?.operator_engaged).toBe(1);
  });
});

describe("the caller's side: journal, outage, replay, unreferenced", () => {
  it("[MUST-FAIL] NO LOSS: holder down for one credit, then up: after replay the holder's table equals the no-outage run", async () => {
    let up = false;
    asNonHolder(() => up);
    await lc.creditLearning({ table: "class_posteriors", key: "X", outcome: "landed", gap_id: GAP, event_id: `sha:${SHA}` });
    expect(readH("class")["X"]).toBeUndefined();
    expect(read("class")["X"]).toEqual({ alpha: 2, beta: 1 }); // the local copy is written whatever the holder does
    expect(journal().filter((r) => r.state === "pending").length).toBe(1);
    up = true;
    await lc.creditLearning({ table: "class_posteriors", key: "X", outcome: "failed", gap_id: GAP, event_id: "decision:dec-known" });
    expect(readH("class")["X"]).toEqual({ alpha: 2, beta: 2 });
    expect(journal().filter((r) => r.state === "pending").length).toBe(0);
    await lc.replayLearningJournal();
    expect(readH("class")["X"]).toEqual({ alpha: 2, beta: 2 });
    expect(read("class")["X"]).toEqual({ alpha: 2, beta: 2 });
  });

  it("[MUST-FAIL] CONCURRENT credits (several fired at once, as a decision's arm and terms are): every one applied exactly once", async () => {
    asNonHolder();
    const keys = ["K1", "K2", "K3", "K4", "K5", "K6"];
    await Promise.all(keys.map((k) => lc.creditLearning({ table: "class_posteriors", key: k, outcome: "landed", gap_id: GAP, event_id: `sha:${SHA}` })));
    await lc.replayLearningJournal();
    for (const k of keys) expect(readH("class")[k]).toEqual({ alpha: 2, beta: 1 });
    for (const k of keys) expect(read("class")[k]).toEqual({ alpha: 2, beta: 1 }); // each local copy, once
    expect(journal().filter((r) => r.state === "pending").length).toBe(0);
    await lc.replayLearningJournal();
    for (const k of keys) expect(readH("class")[k]).toEqual({ alpha: 2, beta: 1 });
    // Six credits reach the stand-in holder one at a time, and each is a fresh bun process importing this module graph
    // (~0.9 s each, 5.5 s measured at load < 8): the default 5 s is the fixture's cost, not the code's.
  }, 30_000);

  it("[CONTROL] UNREFERENCED: a call site with no reference journals it and credits nothing AT THE HOLDER (its local write is made, as before)", async () => {
    asNonHolder();
    await lc.creditLearning({ table: "class_posteriors", key: "U", outcome: "failed", gap_id: GAP, event_id: null });
    expect(readH("class")["U"]).toBeUndefined();
    expect(read("class")["U"]).toEqual({ alpha: 1, beta: 2 });
    expect(journal().some((r) => r.state === "unreferenced" && r.key === "U")).toBe(true);
  });

  it("[WIRING] updateClassPosterior with a reference, on a non-holder, writes through (the holder's table moves)", async () => {
    asNonHolder();
    credit.updateClassPosterior("W", true, { gap_id: GAP, event_id: `sha:${SHA}` });
    await lc.replayLearningJournal();
    await new Promise((r) => setTimeout(r, 50));
    expect(readH("class")["W"]).toEqual({ alpha: 2, beta: 1 });
    expect(read("class")["W"]).toEqual({ alpha: 2, beta: 1 }); // and its pinned local write, once
  });

  it("[CONTROL] the write is a `_write` shape, so the route's credential gate applies (unauthenticated -> 401)", () => {
    expect(isWritePointerType("gapLearningCredit_write")).toBe(true);
    const route = readFileSync(join(import.meta.dir, "..", "..", "src", "routes", "impulses.ts"), "utf8");
    expect(route).toContain('case "gapLearningCredit_write": {');
    expect(route).toMatch(/refuseUnauthenticatedWrite\(c, pointerType, pointer\)/);
  });
});

describe("on the holder, a credit is the local write it always was (qa ruling 2026-10-17)", () => {
  it("[MUST-FAIL] the holder's own credit moves its table once, in place: no journal, no applied set, no reference check", async () => {
    await lc.creditLearning({ table: "close_oracle", key: "measured", outcome: "close", gap_id: "no-such-gap", event_id: "sha:" + FAKE });
    expect(read("oracle")["measured"]).toEqual({ closes: 1, false_closes: 0 });
    expect(journal()).toEqual([]);
    expect(() => readFileSync(`${tbl("oracle")}.applied.json`, "utf8")).toThrow();
  });
  it("[MUST-FAIL] updateClassPosterior on the holder is the pinned local write (Beta(1,1) -> alpha 2), with or without a reference", async () => {
    credit.updateClassPosterior("H", true, { gap_id: "no-such-gap", event_id: null });
    credit.updateClassPosterior("H2", false);
    expect(read("class")["H"]).toEqual({ alpha: 2, beta: 1 });
    expect(read("class")["H2"]).toEqual({ alpha: 1, beta: 2 });
    expect(journal()).toEqual([]);
  });
  it("[MUST-FAIL] a replay on the holder, or with nothing pending, writes nothing (a replay runs on READ paths)", async () => {
    await lc.replayLearningJournal();
    expect(journal()).toEqual([]);
    asNonHolder();
    await lc.replayLearningJournal();
    expect(() => readFileSync(JOURNAL, "utf8")).toThrow();
  });
  it("[CONTROL] the same credit on a NON-holder is journaled and written through, referenced", async () => {
    asNonHolder();
    await lc.creditLearning({ table: "close_oracle", key: "measured", outcome: "close", gap_id: GAP, event_id: `sha:${SHA}` });
    expect(readH("oracle")["measured"]).toEqual({ closes: 1, false_closes: 0 });
    expect(read("oracle")["measured"]).toEqual({ closes: 1, false_closes: 0 });
    expect(journal().some((r) => r.key === "measured" && r.state === "acked")).toBe(true);
  });
  it("[MUST-FAIL] HOLDER IDEMPOTENCY (qa condition 1): the same credit written through twice, then replayed after an outage, is applied ONCE at the holder", async () => {
    let up = false;
    asNonHolder(() => up);
    const c = { table: "class_posteriors" as const, key: "I", outcome: "landed" as const, gap_id: GAP, event_id: `sha:${SHA}` };
    await lc.writeThroughLearning(c);
    await lc.writeThroughLearning(c);
    expect(readH("class")["I"]).toBeUndefined();
    up = true;
    await lc.replayLearningJournal();
    await lc.replayLearningJournal();
    expect(readH("class")["I"]).toEqual({ alpha: 2, beta: 1 });
  });
});
