// THE OWN-CHECK BASELINE TRIGGER READS THE POLICIES DIRECTORY THE TEST NAMES, NOT THE LIVE ONE.
//
// supplyPass calls dispatchOwnCheckBaselines with no env, so the policy (ownCheckEnvironmentPolicy) is read through
// process.env: signal-window.ts shapedPolicyPath takes the first git checkout among SUPER_REPO_DIR,
// MITOSIS_SUPER_REPO_DIR and the hard-coded live clone (write-containment.ts containmentZones). Here a fake "live"
// checkout holding a live-shaped policy (own_check_baseline_per_tick > 0) stands in that later place, as
// MITOSIS_SUPER_REPO_DIR, so the order is the same on every host:
//   - pointed at a temp checkout with no policy, the trigger reads the temp path (defaults, bound 0) and sends nothing;
//   - pointed at a temp checkout holding that policy, it reads it and sends (the isolation is real, not inert);
//   - pointed nowhere, it reads the fake live policy and sends: the hazard the tick tests now set SUPER_REPO_DIR against.
// Every case shows the path the reader resolved, through the same no-env read the tick makes.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-policy-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const EMPTY = join(ROOT, "temp-empty"), TEMP = join(ROOT, "temp-with-policy"), LIVE = join(ROOT, "fake-live");
const ENV_KEYS = ["SUPER_REPO_DIR", "MITOSIS_SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const supply = await import("../../src/resolvers/gap-check-supply.js");
const { readOwnCheckEnvPolicy, OWN_CHECK_ENV_POLICY_NAME } = await import("../../src/resolvers/own-check-baseline.js");
const HEAD = "e".repeat(40);
const POLICY = JSON.stringify({ own_check_baseline_per_tick: 2 });

beforeAll(() => {
  for (const d of [EMPTY, TEMP, LIVE]) mkdirSync(join(d, ".git"), { recursive: true });
  for (const d of [TEMP, LIVE]) { mkdirSync(join(d, "policies"), { recursive: true }); writeFileSync(join(d, "policies", `${OWN_CHECK_ENV_POLICY_NAME}.json`), POLICY); }
});
afterEach(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const policyAt = (dir: string) => join(realpathSync(dir), "policies", `${OWN_CHECK_ENV_POLICY_NAME}.json`);
const row = { id: "g-iso", status: "open", category: "systematic_failure", source: "substrate_detected", summary: "s",
  classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" } } };

/** One trigger pass exactly as supplyPass makes it (no env), with the goal send, the head and the row write injected. */
async function pass() {
  const sends: Array<Record<string, unknown>> = [];
  const sent = await supply.dispatchOwnCheckBaselines([row] as never, {
    node: "node-a", nowIso: "2026-01-01T00:00:00Z",
    write: async () => ({ shape: "substrateGap", body: {} }),
    send: (async (p: Record<string, unknown>) => { sends.push(p); return { shape: "goalDispatchResult", body: { dispatch_id: `disp-${sends.length}` } }; }) as never,
    headOf: () => HEAD,
    executionIdOf: async () => null,
  });
  return { sent, sends, read: await readOwnCheckEnvPolicy() };
}

describe("the own-check baseline trigger reads the policies directory the test names", () => {
  it("CONTROL pointed at a temp checkout, a live-shaped policy in the fake live checkout dispatches no baseline", async () => {
    process.env["SUPER_REPO_DIR"] = EMPTY;
    process.env["MITOSIS_SUPER_REPO_DIR"] = LIVE;
    const { sent, sends, read } = await pass();
    expect(read.path).toBe(policyAt(EMPTY));
    expect(read.ok && read.source).toBe("default");
    expect(read.ok && read.policy.own_check_baseline_per_tick).toBe(0);
    expect(sent).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("POSITIVE CONTROL pointed at a temp checkout holding that policy, the trigger reads it and dispatches", async () => {
    process.env["SUPER_REPO_DIR"] = TEMP;
    process.env["MITOSIS_SUPER_REPO_DIR"] = LIVE;
    const { sent, sends, read } = await pass();
    expect(read.path).toBe(policyAt(TEMP));
    expect(read.ok && read.source).toBe("policy");
    expect(read.ok && read.policy.own_check_baseline_per_tick).toBe(2);
    expect(sent).toEqual([{ id: "g-iso", base_sha: HEAD, dispatch_id: "disp-1" }]);
    expect(sends[0]!["target_template_id"]).toBe("development-vessel:own-check-baseline");
  });

  it("HAZARD pointed nowhere, the trigger reads the next checkout in the order (here the fake live one) and dispatches", async () => {
    delete process.env["SUPER_REPO_DIR"];
    process.env["MITOSIS_SUPER_REPO_DIR"] = LIVE;
    const { sent, read } = await pass();
    expect(read.path).toBe(policyAt(LIVE));
    expect(read.ok && read.source).toBe("policy");
    expect(sent.map((s) => s.id)).toEqual(["g-iso"]);
  });
});
