// ONE LLM FAILOVER CALL ENDS INSIDE ITS DEADLINE, A THIRD OF THE COMPOSE CEILING (2026-10-30).
//
// llmCallWithFailover tried every endpoint for 3 rounds with no overall bound. In a repair call one endpoint took about
// 2 min per failing attempt and ran again each round while the others failed fast; with the compose's other calls the
// attempt outlived pull-sync's compose ceiling and was killed by a lossy restart. Expected now:
//   - a slow-failing endpoint among fast-failing ones: the call fails cleanly within the deadline (the must-fail);
//   - an endpoint that never answers among fast-failing ones: the same (must-fail);
//   - CONTROL: a fast endpoint succeeds on the first try; fast failures followed by a quick success succeed; a slow
//     endpoint that answers inside the deadline is still accepted.
// The ceiling is COMPOSE_CEILING_MS, the name and default pull-sync reads; each case runs in a CHILD process with it set
// small (6 s, so the deadline is 2 s), because compose-slots freezes it at module load and this file's process shares
// that module with the rest of the suite. Fetch is stubbed in the child; every endpoint is localhost and the key a dummy.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedChildEnv } from "./isolated-gap-store-run.js";

const FC = join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts");
const VESSEL = join(import.meta.dir, "..", "..");
const ROOT = mkdtempSync(join(tmpdir(), "llm-failover-deadline-"));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

const CEILING_MS = 6_000;
const DEADLINE_MS = CEILING_MS / 3;
const SLACK_MS = 1_000; // scheduling slack under nice 19
const CUTOFF_MS = 3 * DEADLINE_MS; // the child stops waiting here; the old loop's 3 slow rounds + 6 s of backoff run past it
const SLOW = "http://localhost:18110/resolve";
const FAST = [1, 2, 3, 4, 5].map((i) => `http://localhost:1820${i}/resolve`);

type Behaviour = { kind: "fail" } | { kind: "ok" } | { kind: "slow_fail"; ms: number } | { kind: "slow_ok"; ms: number } | { kind: "never" };
type ChildOut = { settled: boolean; result?: string; error?: string; elapsed_ms: number; calls: string[] };

/** One failover over `endpoints` in a fresh child; each URL behaves as `plan` says (unlisted: fail fast with 502). */
function failoverInChild(endpoints: string[], plan: Record<string, Behaviour>): ChildOut {
  const code = [
    `const calls = [];`,
    `console.log = () => {}; console.warn = () => {}; console.error = () => {};`,
    `const plan = ${JSON.stringify(plan)};`,
    `const fail = () => new Response("bad gateway (test)", { status: 502 });`,
    `const ok = () => Response.json({ content: "OK", resolved: true });`,
    `const after = (ms, make, signal) => new Promise((res, rej) => {`,
    `  const t = ms === null ? null : setTimeout(() => res(make()), ms);`,
    `  signal?.addEventListener("abort", () => { if (t) clearTimeout(t); rej(signal.reason ?? new Error("aborted")); });`,
    `});`,
    `globalThis.fetch = async (input, init) => {`,
    `  const url = typeof input === "string" ? input : String(input?.url ?? input);`,
    `  calls.push(url);`,
    `  const b = plan[url] ?? { kind: "fail" };`,
    `  if (b.kind === "ok") return ok();`,
    `  if (b.kind === "fail") return fail();`,
    `  if (b.kind === "slow_fail") return after(b.ms, fail, init?.signal);`,
    `  if (b.kind === "slow_ok") return after(b.ms, ok, init?.signal);`,
    `  return after(null, fail, init?.signal);`,
    `};`,
    `const fc = await import(${JSON.stringify(FC)});`,
    `const t0 = Date.now();`,
    `const p = fc.llmCallWithFailover(${JSON.stringify(endpoints)}, "prompt", "auto").then((v) => ({ settled: true, result: v }), (e) => ({ settled: true, error: String(e?.message ?? e) }));`,
    `const out = await Promise.race([p, new Promise((r) => setTimeout(() => r({ settled: false }), ${CUTOFF_MS}))]);`,
    `out.elapsed_ms = Date.now() - t0; out.calls = calls;`,
    `process.stdout.write("CHILD_RESULT " + JSON.stringify(out) + "\\n");`,
    `process.exit(0);`,
  ].join("\n");
  const env = isolatedChildEnv(ROOT, { METABOB_API_KEY: "dummy-key-failover-deadline", COMPOSE_CEILING_MS: String(CEILING_MS), NODE_ENV: "test", TZ: "UTC" });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: VESSEL, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const stdout = new TextDecoder().decode(p.stdout);
  const line = stdout.split("\n").find((l) => l.startsWith("CHILD_RESULT "));
  if (!line) throw new Error(`child printed no result (exit ${p.exitCode}): ${new TextDecoder().decode(p.stderr).slice(-600)}`);
  return JSON.parse(line.slice("CHILD_RESULT ".length)) as ChildOut;
}

describe("feature-compose llmCallWithFailover: one overall deadline under the compose ceiling", () => {
  it("[MUST-FAIL] a slow-failing endpoint among fast-failing ones: the call fails cleanly within the deadline", () => {
    const r = failoverInChild([SLOW, ...FAST], { [SLOW]: { kind: "slow_fail", ms: 800 } });
    expect(r.settled).toBe(true);
    expect(r.result).toBeUndefined();
    expect(typeof r.error).toBe("string");
    expect(r.elapsed_ms).toBeLessThanOrEqual(DEADLINE_MS + SLACK_MS);
  }, 60_000);

  it("[MUST-FAIL] an endpoint that never answers among fast-failing ones: the call fails cleanly within the deadline", () => {
    const r = failoverInChild([SLOW, ...FAST], { [SLOW]: { kind: "never" } });
    expect(r.settled).toBe(true);
    expect(typeof r.error).toBe("string");
    expect(r.elapsed_ms).toBeLessThanOrEqual(DEADLINE_MS + SLACK_MS);
  }, 60_000);

  it("[CONTROL] a fast endpoint succeeds on the first try", () => {
    const r = failoverInChild([FAST[0]!, SLOW], { [FAST[0]!]: { kind: "ok" } });
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([FAST[0]!]);
  }, 60_000);

  it("[CONTROL] fast failures followed by a quick success still succeed", () => {
    const r = failoverInChild([FAST[0]!, FAST[1]!, FAST[2]!], { [FAST[2]!]: { kind: "ok" } });
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([FAST[0]!, FAST[1]!, FAST[2]!]);
  }, 60_000);

  it("[CONTROL] a slow endpoint that answers inside the deadline is still accepted", () => {
    const r = failoverInChild([SLOW, ...FAST], { [SLOW]: { kind: "slow_ok", ms: 800 } });
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([SLOW]);
  }, 60_000);
});
