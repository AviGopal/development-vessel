// A PARKED LANDING IS READ FROM DISK BY GAP ID, VALIDATED, AND SHELL-QUOTED (security, check-first).
//
// feature_compose resumes a parked landing before drafting. Three defects in that path:
//   - the park came from the pointer (`resume_from`) when one was supplied, so a caller chose the
//     vessel name, the file paths and the file contents the resume writes and typechecks;
//   - nothing checked the park's vessel name or file paths before the resume wrote the files into
//     the live tree, so a path could leave the vessel directory;
//   - the resume's typecheck and staging cleanup ran through the tools shell (bash -c) with the
//     vessel path inside JSON.stringify, i.e. double quotes, in which the shell still expands.
// The fix reads the park only from disk by the pointer's gap id, validates it before any I/O
// (stage park_invalid: the bad park is deleted and the compose redrafts, as park_stale does), and
// single-quotes the two resume shell commands.
//
// The tools shell is a recorder: no command sent to it is ever run. The one real shell call in this
// file is the quoting check, and its payload names a path inside this file's own temp directory.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures RUNTIME_ROOT / REPO_ROOT at module load, and in a whole-suite run an earlier
// file may already have frozen them to the live /vessels: the helper gives this file its own temp root
// regardless of load order, and refuses to run (before any write) when it cannot.
const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-park-untrusted", { who: "feature-compose-park-resume-untrusted.test.ts" });

const realCutover = await import("../../src/resolvers/vessel-mitosis-cutover.js");
let cutoverCalls: Array<Record<string, unknown>> = [];
mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async (p: Record<string, unknown>) => {
    cutoverCalls.push(p);
    return { shape: "cutoverApplied", body: { applied: true, push_status: "pushed", new_git_sha: "f".repeat(40) } };
  },
}));
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const VESSEL = "development-vessel";
const F = "src/resolvers/target.ts";
const F_AT_B = "// target module\nexport const alpha = 1;\n";
const F_PARKED = "// target module\nexport const alpha = 2; // DISK_PARK_MARKER\n";
const SUPPLIED = "// target module\nexport const alpha = 3; // SUPPLIED_PARK_MARKER\n";
const TOOLS = "http://tools.fixture/resolve";
const LLM = "http://llm.fixture/resolve";
const IGNORED_LINE = "[feature-compose] resume_from in the pointer ignored; the park is read from disk by gap id";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ENV_KEYS = ["MITOSIS_PUSH_CLONE_DIR", "PARKED_LANDINGS_DIR", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "COMPOSE_WS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let ws: string;
let shellCommands: string[] = [];
let logs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}
/** Every regular file under dir (relative paths); [] when dir is absent. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const abs = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out;
}
/** Files under ROOT whose content carries the marker. */
function filesWith(marker: string): string[] {
  return filesUnder(ROOT).filter((r) => {
    try { return readFileSync(join(ROOT, r), "utf8").includes(marker); } catch { return false; }
  });
}

beforeEach(async () => {
  ws = join(ROOT, `case-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(ws, { recursive: true });
  await rm(RUNTIME, { recursive: true, force: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["MITOSIS_PUSH_CLONE_DIR"] = join(ws, "git", "vessels");
  process.env["PARKED_LANDINGS_DIR"] = join(ws, "parked");
  process.env["GAP_STORE_ENDPOINT"] = "http://gap-store.fixture/resolve";
  process.env["COMPOSE_SLOT_DIR"] = join(ws, "slots");
  process.env["COMPOSE_WS_DIR"] = join(ws, "compose-ws");
  cutoverCalls = [];
  shellCommands = [];
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { /* empty */ }
    if (url === TOOLS) {
      shellCommands.push(String(body?.impulse?.pointer?.command ?? ""));
      return Response.json({ stdout: "TC_EXIT=0\n" });
    }
    if (url === LLM) return new Response("unavailable (test)", { status: 503 });
    if (body?.pointer?.type === "vesselCapability") {
      const shape = String(body.pointer.shape ?? "");
      if (shape === "shellResult") return Response.json({ content: { vessels: [{ endpoint: "http://tools.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      if (shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } });
      return Response.json({ content: { vessels: [] } });
    }
    // The gap store holds no row for the fixture gaps: no hold, no admission, no lease. Writes are acknowledged.
    if (url.startsWith("http://gap-store.fixture")) {
      const t = String(body?.impulse?.pointer?.type ?? "");
      if (t === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [] } });
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "noop" } });
    }
    return new Response("unavailable (test)", { status: 503 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(ws, { recursive: true, force: true });
  await rm(RUNTIME, { recursive: true, force: true });
});
afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.log = ORIGINAL_LOG;
  mock.restore();
  await rm(ROOT, { recursive: true, force: true });
});

/** A real bare origin with F at B and the push clone of it; optionally a park on disk. */
async function setup(opts: { gapId: string; disk?: { vessel?: string; files: Array<{ path: string; content: string; base_content: string | null }> } | null }) {
  const origin = join(ws, "origin.git");
  git(ws, "init", "--bare", "-b", "dev", origin);
  const seed = join(ws, "seed");
  await put(seed, "README.md", "seed\n");
  await put(seed, F, F_AT_B);
  git(ws, "init", "-b", "dev", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "commit.gpgsign", "false");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "B: base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "dev");
  await mkdir(join(ws, "git", "vessels"), { recursive: true });
  git(ws, "clone", "-q", "-b", "dev", origin, join(ws, "git", "vessels", VESSEL));
  if (opts.disk) await fc.writeParkedLanding(park(opts.gapId, opts.disk.vessel ?? VESSEL, opts.disk.files));
  return { parkPath: fc.parkedLandingPath(opts.gapId) as string };
}
function park(gapId: string, vessel: string, files: Array<{ path: string; content: string; base_content: string | null }>) {
  return {
    gap_id: gapId,
    compose_id: `${VESSEL}-fc-test`,
    vessel,
    files,
    verify: { typecheck: true, shape_dispatch: true, tests: true },
    judge: { addresses: true, reason: null },
    parked_at: new Date().toISOString(),
    reason: "pre-cutover",
    attempt_id: null,
  };
}
function entryPointer(gapId: string, extra: Record<string, unknown> = {}) {
  return { type: "feature_compose", spec: "fixture spec", land: true, skip_push: true, directed: true, gap: { id: gapId }, ...extra };
}
const exists = (p: string) => readFile(p).then(() => true, () => false);

describe("shq: a single-quoted shell word", () => {
  it("MUST-FAIL: bash reads a command substitution inside shq(...) literally", async () => {
    expect(typeof fc.shq).toBe("function");
    const box = join(ROOT, `quote-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(box, { recursive: true }); // the payload's target dir exists, so an expansion WOULD create Y
    const payload = `$(touch ${box}/Y)`;
    const r = spawnSync("bash", ["-c", `echo ${fc.shq(payload)}`], { encoding: "utf8" });
    expect(r.stdout).toBe(`${payload}\n`);
    expect(existsSync(join(box, "Y"))).toBe(false);
    const q = spawnSync("bash", ["-c", `printf %s ${fc.shq("it's a 'quoted' word")}`], { encoding: "utf8" });
    expect(q.stdout).toBe("it's a 'quoted' word");
  });
});

describe("parked landing resume: the vessel name and file paths are validated before any I/O", () => {
  it("MUST-FAIL (direct): a park whose vessel carries a command substitution sends no shell command and writes nothing", async () => {
    const box = join(ROOT, `inject-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(box, { recursive: true });
    const gapId = "gap-park-hostile-vessel";
    await setup({ gapId });
    const hostile = park(gapId, `$(touch ${box}/X)`, [{ path: F, content: SUPPLIED, base_content: null }]);
    const r = await fc.resumeParkedLanding(entryPointer(gapId), hostile, TOOLS);
    expect({ shell: shellCommands, cutover: cutoverCalls.length, runtime: filesUnder(RUNTIME) }).toEqual({ shell: [], cutover: 0, runtime: [] });
    expect(r).toBeNull(); // refused like park_stale: the caller redrafts
    expect(logs.some((l) => l.includes("park_invalid"))).toBe(true);
    expect(existsSync(join(box, "X"))).toBe(false);
  });

  for (const [label, bad] of [["a '..' segment", "../escape.ts"], ["a leading '/'", "/abs-escape.ts"], ["a backslash", "src\\resolvers\\target.ts"]] as const) {
    it(`MUST-FAIL: an on-disk park with ${label} in a file path is refused as park_invalid before any write, and deleted`, async () => {
      const gapId = `gap-park-bad-path-${label.replace(/[^a-z]/g, "")}`;
      const s = await setup({ gapId, disk: { files: [{ path: bad, content: SUPPLIED, base_content: null }] } });
      const r = await fc.resolveFeatureCompose(entryPointer(gapId));
      expect({ cutover: cutoverCalls.length, runtime: filesUnder(RUNTIME), marked: filesWith("SUPPLIED_PARK_MARKER") }).toEqual({ cutover: 0, runtime: [], marked: [] });
      expect(shellCommands.some((c) => c.includes("bunx tsc"))).toBe(false);
      expect(logs.some((l) => l.includes("park_invalid"))).toBe(true);
      expect(await exists(s.parkPath)).toBe(false);
      expect((r.body as Record<string, unknown>)["resumed_from"]).toBeUndefined();
    });
  }
});

describe("feature_compose: the park is read from disk by gap id; resume_from in the pointer is ignored", () => {
  it("MUST-FAIL (entry): a resume_from with a command-substitution vessel reaches no shell and writes nothing", async () => {
    const box = join(ROOT, `inject-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(box, { recursive: true });
    const gapId = "gap-entry-hostile-vessel";
    await setup({ gapId });
    const payload = `touch ${box}/X`;
    const hostile = park(gapId, `$(${payload})`, [{ path: F, content: SUPPLIED, base_content: null }]);
    await fc.resolveFeatureCompose(entryPointer(gapId, { resume_from: hostile }));
    expect({ payload_sent: shellCommands.filter((c) => c.includes(payload)), cutover: cutoverCalls.length, runtime: filesUnder(RUNTIME), marked: filesWith("SUPPLIED_PARK_MARKER") }).toEqual({ payload_sent: [], cutover: 0, runtime: [], marked: [] });
    expect(logs).toContain(IGNORED_LINE);
    expect(existsSync(join(box, "X"))).toBe(false);
  });

  it("MUST-FAIL: a valid-shaped resume_from that differs from the disk park: the DISK park lands, the supplied content is never written", async () => {
    const gapId = "gap-entry-supplied-vs-disk";
    await setup({ gapId, disk: { files: [{ path: F, content: F_PARKED, base_content: F_AT_B }] } });
    const supplied = park(gapId, VESSEL, [{ path: F, content: SUPPLIED, base_content: F_AT_B }]);
    const r = await fc.resolveFeatureCompose(entryPointer(gapId, { resume_from: supplied }));
    expect(filesWith("SUPPLIED_PARK_MARKER")).toEqual([]);
    expect(cutoverCalls.length).toBe(1);
    expect(readFileSync(join(RUNTIME, VESSEL, F), "utf8")).toBe(F_PARKED);
    expect((r.body as Record<string, unknown>)["resumed_from"]).toBe(`${VESSEL}-fc-test`);
    expect(logs).toContain(IGNORED_LINE);
  });

  it("MUST-FAIL: a valid-shaped resume_from with NO park on disk does not resume: nothing supplied is written", async () => {
    const gapId = "gap-entry-supplied-no-disk";
    await setup({ gapId });
    const supplied = park(gapId, VESSEL, [{ path: F, content: SUPPLIED, base_content: F_AT_B }]);
    const r = await fc.resolveFeatureCompose(entryPointer(gapId, { resume_from: supplied }));
    expect({ marked: filesWith("SUPPLIED_PARK_MARKER"), cutover: cutoverCalls.length, tsc: shellCommands.some((c) => c.includes("bunx tsc")) }).toEqual({ marked: [], cutover: 0, tsc: false });
    expect((r.body as Record<string, unknown>)["resumed_from"]).toBeUndefined();
  });

  it("CONTROL: a legitimate on-disk park resumes through the entry and reaches the cutover with its files", async () => {
    const gapId = "gap-entry-legit-park";
    const s = await setup({ gapId, disk: { files: [{ path: F, content: F_PARKED, base_content: F_AT_B }] } });
    const r = await fc.resolveFeatureCompose(entryPointer(gapId));
    expect((r.body as Record<string, unknown>)["ok"]).toBe(true);
    expect((r.body as Record<string, unknown>)["resumed_from"]).toBe(`${VESSEL}-fc-test`);
    expect(cutoverCalls.length).toBe(1);
    expect(cutoverCalls[0]!["staged_files"]).toEqual([F]);
    expect(readFileSync(join(RUNTIME, VESSEL, F), "utf8")).toBe(F_PARKED);
    expect(shellCommands.some((c) => c.includes("bunx tsc"))).toBe(true);
    expect(await exists(s.parkPath)).toBe(false);
    expect(logs).not.toContain(IGNORED_LINE);
  });

  it("CONTROL: no park on disk and no resume_from takes the normal compose path", async () => {
    const gapId = "gap-entry-no-park";
    await setup({ gapId });
    const r = await fc.resolveFeatureCompose(entryPointer(gapId));
    expect({ cutover: cutoverCalls.length, tsc: shellCommands.some((c) => c.includes("bunx tsc")), resumed: (r.body as Record<string, unknown>)["resumed_from"] }).toEqual({ cutover: 0, tsc: false, resumed: undefined });
    // The compose went on past the resume block to drafting: with no target path in the fixture spec the
    // drafting path's own grounding refusal answers (no LLM call is made).
    expect((r.body as Record<string, unknown>)["stage"]).toBe("scope");
    expect(String((r.body as Record<string, unknown>)["error"])).toContain("ungrounded decompose refused");
  });
});
