// A DEFERRED CUTOVER IS A NON-ATTEMPT, NOT A REFUSAL (CHANGE-30a: ONE definition of "deferred").
//
// A cutover can DEFER: the gap store was unreadable at its landing-lease gate, or the change window was held. It
// returns {refused, deferred:true, preserve_pending:true}, meaning "the staged tree is kept and retried". The retry
// vehicle for a feature_compose is its PARK (written before every cutover, resumed by the next compose for the gap).
// But feature_compose read every un-pushed landing as UNFAVORABLE: it charged the drafter, wrote a compose lesson on
// the gap for an environment condition, and (through goal-host and check-supply) started the 24 h backoff that let
// the park expire. resumeParkedLanding hard-coded the same: pushed ? FAVORABLE : UNFAVORABLE.
//
//   [MUST-FAIL] a resumed park whose cutover DEFERS is a non-attempt: verdict BUSY (never UNFAVORABLE, never
//               FAVORABLE), failure_kind environment, the refuse_class named, and the park still on disk.
//   [CONTROL]   a resumed park whose cutover is genuinely REFUSED is UNFAVORABLE, park kept (as before).
//   [CONTROL]   a resumed park whose cutover PUSHED is FAVORABLE and the park is consumed (as before).
//   [MUST-FAIL] the one flip: pushed -> the draft's verdict; deferred -> BUSY; refused -> UNFAVORABLE.
//   [MUST-FAIL] wiring: the fresh compose's landing flip, its report and the resume all take their verdict from it.
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// feature-compose captures RUNTIME_ROOT / REPO_ROOT at module load, and in a whole-suite run an earlier
// file may already have frozen them to the live /vessels: the helper gives this file its own temp root
// regardless of load order, and refuses to run (before any write) when it cannot.
const { root: ROOT } = await isolateRuntimeRoot("fc-deferred-landing", { who: "feature-compose-deferred-landing.test.ts" });

const realCutover = await import("../../src/resolvers/vessel-mitosis-cutover.js");
// A BY-VALUE copy for the restore below: the namespace object is a live binding, so once the module is mocked
// `realCutover.resolveVesselMitosisCutover` reads the FAKE too, and restoring with it restores the mock.
const REAL_CUTOVER = { ...realCutover };
let cutoverCalls: Array<Record<string, unknown>> = [];
let nextCutoverBody: Record<string, unknown> = {};
mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async (p: Record<string, unknown>) => {
    cutoverCalls.push(p);
    return { shape: "vesselMitosisCutoverResult", body: nextCutoverBody };
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
  // mock.restore() does not undo mock.module, and the gate runs the whole suite in ONE process: without this, every
  // later file that imports the cutover got the fake above (cutoverApplied, no gate, no git), which turned all 27
  // real-cutover tests of cutover-autonomy-scope red wherever this file sorted first (measured on the hub, 2026-10-14).
  mock.module("../../src/resolvers/vessel-mitosis-cutover.js", () => REAL_CUTOVER);
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

const VERDICT = (r: unknown) => ((r as { body?: Record<string, unknown> } | null)?.body ?? {}) as Record<string, unknown>;
const DEFERRED = { applied: false, refused: true, deferred: true, preserve_pending: true, refuse_class: "gap_store_unavailable", refusal_reason: "landing-lease gate: gap store answered structuredError; deferring" };
const REFUSED = { applied: false, refused: true, refuse_class: "own_check_failed", refusal_reason: "own check still red" };
const PUSHED = { applied: true, push_status: "pushed", new_git_sha: "f".repeat(40) };

describe("a deferred cutover is a non-attempt, not a refusal", () => {
  it("[MUST-FAIL] a resumed park whose cutover DEFERS: BUSY, failure_kind environment, refuse_class named, park kept", async () => {
    nextCutoverBody = DEFERRED;
    const s = await setup({ newer: false, base_content: F_AT_B });
    const r = VERDICT(await resumeParkedLanding!(s.pointer, s.park, TOOLS));
    expect(cutoverCalls.length).toBe(1);
    expect(r["verdict"]).toBe("BUSY");
    expect(r["failure_kind"]).toBe("environment");
    expect(r["refuse_class"]).toBe("gap_store_unavailable");
    expect(r["parked"]).toBe(true);
    expect(await exists(s.parkPath)).toBe(true);
    // the system's ONE non-attempt definition reads it as a non-attempt
    const { isNonAttemptComposeResult } = await import("../../src/judge/gap-eligibility.js");
    expect(isNonAttemptComposeResult(r)).toBe(true);
  });

  it("[CONTROL] a resumed park whose cutover is REFUSED is UNFAVORABLE, park kept", async () => {
    nextCutoverBody = REFUSED;
    const s = await setup({ newer: false, base_content: F_AT_B });
    const r = VERDICT(await resumeParkedLanding!(s.pointer, s.park, TOOLS));
    expect(r["verdict"]).toBe("UNFAVORABLE");
    expect(r["failure_kind"]).toBeUndefined();
    expect(await exists(s.parkPath)).toBe(true);
  });

  it("[CONTROL] a resumed park whose cutover PUSHED is FAVORABLE and the park is consumed", async () => {
    nextCutoverBody = PUSHED;
    const s = await setup({ newer: false, base_content: F_AT_B });
    const r = VERDICT(await resumeParkedLanding!(s.pointer, s.park, TOOLS));
    expect(r["verdict"]).toBe("FAVORABLE");
    expect(await exists(s.parkPath)).toBe(false);
  });

  it("[MUST-FAIL] the one flip: pushed keeps the draft's verdict; deferred is BUSY; refused is UNFAVORABLE", () => {
    const f = (fc as unknown as { landingVerdictFromCutovers?: (v: string, r: unknown[]) => string }).landingVerdictFromCutovers;
    expect(typeof f).toBe("function");
    expect(f!("FAVORABLE", [PUSHED])).toBe("FAVORABLE");
    expect(f!("FAVORABLE", [DEFERRED])).toBe("BUSY");
    expect(f!("FAVORABLE", [REFUSED])).toBe("UNFAVORABLE");
    expect(f!("FAVORABLE", [REFUSED, DEFERRED])).toBe("BUSY");
    expect(f!("FAVORABLE", [DEFERRED, PUSHED])).toBe("FAVORABLE");
    expect(f!("FAVORABLE", [{ deferred: true, reason: "change_window lease held" }])).toBe("BUSY"); // cutoverDeferred
    expect(f!("UNFAVORABLE", [])).toBe("UNFAVORABLE"); // no cutover ran: nothing to flip
  });

  it("[MUST-FAIL] wiring: the landing flip, the report and the resume all use the one definition", async () => {
    const text = await readFile(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    const uses = text.split("landingVerdictFromCutovers(").length - 1;
    expect(uses).toBeGreaterThanOrEqual(4); // its definition + the flip + the report + the resume
    // no site decides a landing from push status alone any more
    expect(text).not.toMatch(/verdict: pushed \? "FAVORABLE" : "UNFAVORABLE"/);
    expect(text).not.toMatch(/allCutoversRefused \? "UNFAVORABLE"/);
  });
});
