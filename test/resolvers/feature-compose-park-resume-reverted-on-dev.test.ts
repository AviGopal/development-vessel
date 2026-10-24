// A RESUME NEVER RE-LANDS A PROPOSAL ALREADY REVERTED ON DEV.
//
// A park outlives a landing whose push was not read as pushed. Once that landing is reverted on dev, the park's
// recorded base is the live file again, so the resume's base check passes and the resume re-lands the reverted
// change under the same Attempt-Id (seen live: a resume re-applied a change after its revert had landed).
// The resume now refuses with reason "proposal_reverted_on_dev" when the park's own landing (its Attempt-Id
// trailer; with no attempt id, its `apply <gap>-compose-report via` subject) is on HEAD and every file it touched
// reads at HEAD as it did before it.
// ROOT CAUSE: the resume's freshness test drops a park only when its base has MOVED since parked_at. A revert
// restores exactly the parked base, so reverting a parked landing is what re-arms its resume.
// MUST-FAIL: park -> land -> revert restores the base -> resume is refused "proposal_reverted_on_dev" and never
//            reaches the cutover; and ANY landing (pushed or host_sync_pending) deletes the park.
// CONTROL: a park whose proposal never landed resumes and lands on the base committed at HEAD; a park whose cutover
//          did not land is kept.
//
// Fixture and seams as feature-compose-park-resume-null-base.test.ts: an isolated runtime root, a recorded
// cutover, a real bare origin and push clone, and no network.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures RUNTIME_ROOT / REPO_ROOT at module load, and in a whole-suite run an earlier
// file may already have frozen them to the live /vessels: the helper gives this file its own temp root
// regardless of load order, and refuses to run (before any write) when it cannot.
const { root: ROOT } = await isolateRuntimeRoot("fc-park-reverted", { who: "feature-compose-park-resume-reverted-on-dev.test.ts" });

const realCutover = await import("../../src/resolvers/vessel-mitosis-cutover.js");
// A BY-VALUE copy for the restore below: the namespace object is a live binding, so once the module is mocked
// `realCutover.resolveVesselMitosisCutover` reads the FAKE too, and restoring with it restores the mock.
const REAL_CUTOVER = { ...realCutover };
let cutoverCalls: Array<Record<string, unknown>> = [];
const PUSHED = { applied: true, push_status: "pushed", new_git_sha: "f".repeat(40) };
let nextCutoverBody: Record<string, unknown> = PUSHED;
mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async (p: Record<string, unknown>) => {
    cutoverCalls.push(p);
    return { shape: "cutoverApplied", body: nextCutoverBody };
  },
}));
const fc = await import("../../src/resolvers/feature-compose.js");
const resumeParkedLanding = (fc as unknown as { resumeParkedLanding?: (...a: unknown[]) => Promise<unknown> }).resumeParkedLanding;

const VESSEL = "development-vessel";
const F = "src/resolvers/target.ts";
const F_AT_B = "// target module\nexport const alpha = 1;\nexport const beta = 2;\n";
const F_PARKED = "// target module\nexport const alpha = 1;\nexport const beta = 3;\n";
const TOOLS = "http://tools.fixture/resolve";
const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let shellCommands: string[] = [];

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
  ws = await mkdtemp();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  // The park_stale lesson reads and writes the gap row. Forward the store to a URL this file answers
  // as unavailable: without it the real resolver writes the store under the WORKSPACE_ROOT captured
  // at module load, which on a substrate node is the live store.
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  cutoverCalls = [];
  nextCutoverBody = PUSHED;
  shellCommands = [];
  // The resume's typecheck goes through the tools shell: answer it as a pass. Every other request
  // (gap store, concept-db) is answered unavailable, which the resume already tolerates.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (url === TOOLS) {
      let body: Record<string, any> = {};
      try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
      shellCommands.push(String(body?.impulse?.pointer?.command ?? ""));
      return Response.json({ stdout: "TC_EXIT=0\n" });
    }
    return new Response("unavailable (test)", { status: 503 });
  }) as unknown as typeof fetch;
});
async function mkdtemp(): Promise<string> {
  const d = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(d, { recursive: true });
  return d;
}

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
});
afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restore();
  // mock.restore() does not undo mock.module, and the gate runs the whole suite in ONE process: without this, every
  // later file that imports the cutover got the fake above (cutoverApplied, no gate, no git), which turned all 27
  // real-cutover tests of cutover-autonomy-scope red wherever this file sorted first (measured on the hub, 2026-10-14).
  mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => REAL_CUTOVER);
  await rm(ROOT, { recursive: true, force: true });
});

async function setup(opts: { land: boolean; revert: boolean; attempt_id: string | null }) {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);
  const seed = join(ws, "seed");
  await put(seed, "README.md", "seed\n");
  await put(seed, F, F_AT_B);
  git(ws, "init", "-b", "dev", seed);
  gitIdentity(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  const gapId = "gap-park-reverted";
  // PARKED FIRST, on base B: the order the live sequence had (park -> land -> revert restores the base -> resume).
  const park = {
    gap_id: gapId,
    compose_id: `${VESSEL}-fc-test`,
    vessel: VESSEL,
    files: [{ path: F, content: F_PARKED, base_content: F_AT_B }],
    verify: { typecheck: true, shape_dispatch: true, tests: true },
    judge: { addresses: true, reason: null },
    parked_at: new Date().toISOString(),
    reason: "pre-cutover",
    attempt_id: opts.attempt_id,
  };
  await fc.writeParkedLanding(park as never);
  let landing: string | null = null;
  if (opts.land) {
    await put(seed, F, F_PARKED);
    git(seed, "add", ".");
    git(seed, "commit", "-m", `substrate-authored: apply ${gapId}-compose-report via mitosis cutover${opts.attempt_id ? `\n\nAttempt-Id: ${opts.attempt_id}` : ""}`);
    landing = git(seed, "rev-parse", "HEAD");
    if (opts.revert) git(seed, "revert", "--no-edit", "HEAD");
  }
  git(seed, "push", "-u", "origin", "dev");
  const clone = join(ws, "git", "vessels", VESSEL);
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, clone);
  const pointer = { type: "feature_compose", land: true, skip_push: true, gap: { id: gapId } };
  return { clone, park, pointer, landing, parkPath: fc.parkedLandingPath(gapId) };
}
const exists = (p: string) => readFile(p).then(() => true, () => false);
type Report = { body?: Record<string, unknown> } | null;

describe("parked landing resume: a proposal already reverted on dev is refused, never re-landed", () => {
  it("MUST-FAIL: park -> land -> revert restores the parked base -> resume (same Attempt-Id) is refused proposal_reverted_on_dev", async () => {
    const s = await setup({ land: true, revert: true, attempt_id: "att-landed-then-reverted" });
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as Report;
    expect({ cutover_called: cutoverCalls.length > 0, reason: r?.body?.["reason"] ?? null, ok: r?.body?.["ok"] ?? null })
      .toEqual({ cutover_called: false, reason: "proposal_reverted_on_dev", ok: false });
    expect(r?.body?.["landing_sha"]).toBe(s.landing);
    expect(await exists(s.parkPath)).toBe(false);
    expect(await exists(join(process.env["MITOSIS_RUNTIME_DIR"]!, VESSEL, F))).toBe(false); // the live tree was never written
    expect(git(s.clone, "show", `HEAD:${F}`)).toBe(F_AT_B.trim());
  });

  it("MUST-FAIL: a park with no attempt id whose proposal landed and was reverted is refused the same way", async () => {
    const s = await setup({ land: true, revert: true, attempt_id: null });
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as Report;
    expect({ cutover_called: cutoverCalls.length > 0, reason: r?.body?.["reason"] ?? null }).toEqual({ cutover_called: false, reason: "proposal_reverted_on_dev" });
  });

  it("CONTROL: a park whose proposal never landed resumes and lands on the base committed at HEAD", async () => {
    const s = await setup({ land: false, revert: false, attempt_id: "att-never-landed" });
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as Report;
    expect(r?.body?.["ok"]).toBe(true);
    expect(cutoverCalls.length).toBe(1);
    expect(cutoverCalls[0]!["staged_base_sha"]).toBe(sha12(F_AT_B));
    expect(cutoverCalls[0]!["attempt_id"]).toBe("att-never-landed");
    expect(await exists(s.parkPath)).toBe(false);
  });

  it("CONTROL: a landing of the same attempt that is NOT reverted is park_stale, as before (not this refusal)", async () => {
    const s = await setup({ land: true, revert: false, attempt_id: "att-landed" });
    const r = await resumeParkedLanding!(s.pointer, s.park, TOOLS);
    expect(r).toBeNull();
    expect(cutoverCalls.length).toBe(0);
  });
});

describe("parked landing: ANY successful land deletes the park, so a landed proposal never stays resumable", () => {
  it("MUST-FAIL: a resume whose cutover landed via host-sync (host_sync_pending + a sha) leaves no park", async () => {
    const s = await setup({ land: false, revert: false, attempt_id: "att-host-sync" });
    nextCutoverBody = { applied: true, push_status: "host_sync_pending", new_git_sha: "e".repeat(40) };
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as Report;
    expect(cutoverCalls.length).toBe(1);
    expect(await fc.readParkedLanding(s.park.gap_id)).toBeNull();
    expect(r?.body?.["parked"]).toBe(false);
  });

  it("MUST-FAIL: the fresh compose deletes its park right after a cutover that landed, on the one landed definition", async () => {
    const landedFn = (fc as unknown as { cutoverResultLanded?: (r: unknown) => boolean }).cutoverResultLanded;
    expect(typeof landedFn).toBe("function");
    expect(landedFn!({ push_status: "host_sync_pending", new_git_sha: "e".repeat(40) })).toBe(true);
    expect(landedFn!({ push_status: "pushed", new_git_sha: "f".repeat(40) })).toBe(true);
    expect(landedFn!({ push_status: "local_only", new_git_sha: "d".repeat(40) })).toBe(false);
    expect(landedFn!({ refused: true, deferred: true, preserve_pending: true })).toBe(false);
    const text = await readFile(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(text).toMatch(/cutovers\.push\(\{ vessel, result: cut\.body \}\);\s*\n\s*\/\/[^\n]*\n\s*if \(parkedAny && pointer\.gap\?\.id && cutoverResultLanded\(cut\.body\)\) await deleteParkedLanding/);
  });

  it("CONTROL: a resume whose cutover pushed leaves no park (as before)", async () => {
    const s = await setup({ land: false, revert: false, attempt_id: "att-pushed" });
    await resumeParkedLanding!(s.pointer, s.park, TOOLS);
    expect(await fc.readParkedLanding(s.park.gap_id)).toBeNull();
  });

  it("CONTROL: a park whose cutover failed (commit local only, not handed to host-sync) is kept", async () => {
    const s = await setup({ land: false, revert: false, attempt_id: "att-failed" });
    nextCutoverBody = { applied: true, push_status: "local_only", new_git_sha: "d".repeat(40) };
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as Report;
    expect(cutoverCalls.length).toBe(1);
    expect((await fc.readParkedLanding(s.park.gap_id))?.attempt_id).toBe("att-failed");
    expect(r?.body?.["parked"]).toBe(true);
  });
});
