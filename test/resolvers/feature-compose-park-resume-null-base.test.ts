// A PARKED LANDING WITH NO RECORDED BASE NEVER RESUMES OVER NEWER COMMITTED WORK (check-first).
//
// feature_compose parks a verified patch BEFORE its cutover, with base_content = the live file as it
// was before the land-time sync. That snapshot is only taken for an isolated compose, so an
// un-isolated park records base_content: null for a file that exists. resumeParkedLanding then:
//   - skips its staleness check for that file (base_content === null reads as "net-new"), and
//   - hands the cutover staged_base_sha = hash(base_content ?? content), i.e. the hash of the
//     PATCHED content, which no commit holds.
// The cutover's stale-base guard reads a base matching no commit as a staging artefact (the 08-29
// control) and proceeds, so the park's whole-file copy lands over any commit made to the file
// since it was parked. The resume is the edit site; the guard's artefact rule stays as it is.
//
// The resume is driven directly (exported as a test seam); the cutover it calls is replaced by a
// recorder, so what is pinned is whether the resume reaches the cutover, and with what base. The
// push clone is a real clone of a real bare origin. No network: every fetch is answered here.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures RUNTIME_ROOT / REPO_ROOT at module load, and in a whole-suite run an earlier
// file may already have frozen them to the live /vessels: the helper gives this file its own temp root
// regardless of load order, and refuses to run (before any write) when it cannot.
const { root: ROOT } = await isolateRuntimeRoot("fc-park-resume", { who: "feature-compose-park-resume-null-base.test.ts" });

const realCutover = await import("../../src/resolvers/vessel-mitosis-cutover.js");
let cutoverCalls: Array<Record<string, unknown>> = [];
mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async (p: Record<string, unknown>) => {
    cutoverCalls.push(p);
    return { shape: "cutoverApplied", body: { applied: true, push_status: "pushed", new_git_sha: "f".repeat(40) } };
  },
}));
const fc = await import("../../src/resolvers/feature-compose.js");
const resumeParkedLanding = (fc as unknown as { resumeParkedLanding?: (...a: unknown[]) => Promise<unknown> }).resumeParkedLanding;

const VESSEL = "development-vessel";
const F = "src/resolvers/target.ts";
const F_AT_B = "// target module\nexport const alpha = 1;\nexport const beta = 2;\n";
const F_PARKED = "// target module\nexport const alpha = 1;\nexport const beta = 3;\n";
const NEWER_LINE = "export const newerCommittedWork = true;";
const F_AT_N = `${F_AT_B}${NEWER_LINE}\n`;
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
  await rm(ROOT, { recursive: true, force: true });
});

/**
 * Origin with B; the push clone at MITOSIS_PUSH_CLONE_DIR/<vessel>; optionally a newer commit N to F
 * pulled into the clone; a park for F built on B with the given base_content.
 */
async function setup(opts: { newer: boolean; base_content: string | null; fileAtB?: boolean }) {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);
  const seed = join(ws, "seed");
  await put(seed, "README.md", "seed\n");
  if (opts.fileAtB !== false) await put(seed, F, F_AT_B);
  git(ws, "init", "-b", "dev", seed);
  gitIdentity(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "dev");
  const clone = join(ws, "git", "vessels", VESSEL);
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, clone);
  if (opts.newer) {
    await put(seed, F, F_AT_N);
    git(seed, "add", ".");
    git(seed, "commit", "-m", "N: newer work on F\n\nGap: gap-newer");
    git(seed, "push", "origin", "dev");
    git(clone, "pull", "-q", "--ff-only", "origin", "dev");
  }
  const gapId = "gap-park-resume";
  const park = {
    gap_id: gapId,
    compose_id: `${VESSEL}-fc-test`,
    vessel: VESSEL,
    files: [{ path: F, content: F_PARKED, base_content: opts.base_content }],
    verify: { typecheck: true, shape_dispatch: true, tests: true },
    judge: { addresses: true, reason: null },
    parked_at: new Date().toISOString(),
    reason: "pre-cutover",
    attempt_id: null,
  };
  await fc.writeParkedLanding(park as never);
  const pointer = { type: "feature_compose", land: true, skip_push: true, gap: { id: gapId } };
  return { clone, park, pointer, parkPath: fc.parkedLandingPath(gapId) };
}
const exists = (p: string) => readFile(p).then(() => true, () => false);

describe("parked landing resume: a park with no recorded base never lands over newer committed work", () => {
  it("the resume is reachable as a test seam", () => {
    expect(typeof resumeParkedLanding).toBe("function");
  });

  it("MUST-FAIL: an un-isolated park (base_content null) resumed after a newer commit to the same file does not reach the cutover", async () => {
    const s = await setup({ newer: true, base_content: null });
    const r = await resumeParkedLanding!(s.pointer, s.park, TOOLS);
    // The damage, named: a cutover call here carries the PATCHED hash as its base, which the
    // stale-base guard reads as a staging artefact and lands over N.
    expect({
      cutover_called: cutoverCalls.length > 0,
      staged_base_sha: cutoverCalls[0]?.["staged_base_sha"] ?? null,
    }).toEqual({ cutover_called: false, staged_base_sha: null });
    expect(r).toBeNull(); // park_stale: the caller redrafts against the current base
    expect(await exists(s.parkPath)).toBe(false);
    expect(git(s.clone, "show", `HEAD:${F}`)).toContain(NEWER_LINE);
    expect(await exists(join(process.env["MITOSIS_RUNTIME_DIR"]!, VESSEL, F))).toBe(false); // the live tree was never written
  });

  it("CONTROL: a park whose base is the committed version, with no newer commit, resumes and lands with that base", async () => {
    const s = await setup({ newer: false, base_content: F_AT_B });
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as { body?: Record<string, unknown> } | null;
    expect(r?.body?.["ok"]).toBe(true);
    expect(cutoverCalls.length).toBe(1);
    expect(cutoverCalls[0]!["staged_base_sha"]).toBe(sha12(F_AT_B));
    expect(cutoverCalls[0]!["staged_files"]).toEqual([F]);
    expect(await exists(s.parkPath)).toBe(false); // landed: the park is consumed
  });

  it("CONTROL: a net-new park (base_content null, file absent from the clone) still resumes and lands", async () => {
    const s = await setup({ newer: false, base_content: null, fileAtB: false });
    const r = (await resumeParkedLanding!(s.pointer, s.park, TOOLS)) as { body?: Record<string, unknown> } | null;
    expect(r?.body?.["ok"]).toBe(true);
    expect(cutoverCalls.length).toBe(1);
    expect(cutoverCalls[0]!["staged_files"]).toEqual([F]);
  });

  it("CONTROL: a park with a recorded base that a newer commit superseded is park_stale (unchanged)", async () => {
    const s = await setup({ newer: true, base_content: F_AT_B });
    const r = await resumeParkedLanding!(s.pointer, s.park, TOOLS);
    expect(r).toBeNull();
    expect(cutoverCalls.length).toBe(0);
    expect(await exists(s.parkPath)).toBe(false);
  });
});
