// The admission typecheck runner does not block the event loop.
//
// WHY. defaultTypecheckRunner ran `bun run typecheck` through Bun.spawnSync, so the whole vessel stopped answering
// (/health included) for the length of each typecheck; serial batches of 59-76 s were measured, past the
// self-recovery probe's window, and the vessel was restarted. Pinned here:
//   - [MUST-FAIL] a 100 ms heartbeat keeps firing (max gap < 500 ms) while the runner waits on a slow `typecheck`
//     script (a `sleep 2` stand-in through the runner's existing seam, the vessel's own package.json script);
//   - [MUST-FAIL] admission awaits an async runner (a phantom typecheck gap is retired on its clean answer);
//   - [CONTROL] a real type error is still caught (clean:false), and the same project with the error fixed is clean.
// The runtime tree is a temp MITOSIS_RUNTIME_DIR (read at call time); no real vessel is typechecked.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-tc-async-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SAVED_ENV: Record<string, string | undefined> = {
  MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT,
};
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
mkdirSync(join(ROOT, "clones"), { recursive: true });
mkdirSync(join(ROOT, "proposals"), { recursive: true });

const TSC = join(import.meta.dir, "..", "..", "node_modules", "typescript", "bin", "tsc");
function fixtureVessel(name: string, typecheck: string, files: Record<string, string> = {}): void {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, scripts: { typecheck } }));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
}
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", skipLibCheck: true, types: [] }, include: ["src/**/*.ts"] });
fixtureVessel("slow-vessel", "sleep 2");
fixtureVessel("broken-vessel", `bun ${JSON.stringify(TSC)} --noEmit -p .`, { "tsconfig.json": TSCONFIG, "src/index.ts": "export const n: number = \"not a number\";\n" });
fixtureVessel("sound-vessel", `bun ${JSON.stringify(TSC)} --noEmit -p .`, { "tsconfig.json": TSCONFIG, "src/index.ts": "export const n: number = 1;\n" });
fixtureVessel("goal-host-vessel", "exit 0", { "src/index.ts": "export const x = 1;\n" });

const originalFetch = globalThis.fetch;
const modAdmission = await import("../../src/judge/gap-admission.js");
const modPolicy = await import("../../src/judge/gap-policy.js");
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  (modPolicy as { __resetPolicyReadsForTests: () => void }).__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const run = modAdmission.defaultTypecheckRunner as (v: string) => { ran: boolean; clean: boolean } | Promise<{ ran: boolean; clean: boolean }>;

describe("admission's default typecheck runner", () => {
  it("[MUST-FAIL] a 100 ms heartbeat keeps firing while a slow typecheck runs", async () => {
    let last = Date.now();
    let maxGap = 0;
    const beat = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 100);
    const t0 = Date.now();
    let r: { ran: boolean; clean: boolean };
    try { r = await run("slow-vessel"); } finally { clearInterval(beat); }
    maxGap = Math.max(maxGap, Date.now() - last);
    console.log(`[test] runner took ${Date.now() - t0} ms; heartbeat max gap ${maxGap} ms`);
    expect(r).toEqual({ ran: true, clean: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900); // positive control: the slow script really ran
    expect(maxGap).toBeLessThan(500);
  }, 30_000);

  it("[CONTROL] a real type error is still caught, and the fixed project is clean", async () => {
    expect(await run("broken-vessel")).toEqual({ ran: true, clean: false });
    expect(await run("sound-vessel")).toEqual({ ran: true, clean: true });
    expect(await run("no-such-vessel")).toEqual({ ran: false, clean: false });
  }, 60_000);

  it("[MUST-FAIL] admission awaits an async runner: a phantom typecheck gap is retired on its clean answer", async () => {
    const phantom = {
      id: "detect-unclassified_failure_recurring_typecheck_goal_host_vessel_src_index_l619_ts2322_variant",
      category: "systematic_failure", source: "substrate_detected", status: "open",
      summary: "TS2322 at repos/goal-host-vessel/src/index.ts:619",
      classification_metadata: { tsc_error: { code: "TS2322", file: "repos/goal-host-vessel/src/index.ts", line: 619 } },
    };
    const asyncClean = async (_v: string) => { await new Promise((r) => setTimeout(r, 5)); return { ran: true, clean: true }; };
    const { excluded } = await modAdmission.admitActionableGaps([phantom], { typecheckRunner: asyncClean as never });
    expect(excluded.find((e) => e.id === phantom.id)?.reason ?? "").toContain("typecheck_clean_phantom");
  }, 30_000);
});
