import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { admitActionableGaps, resolveGapToFeature, __resetPolicyReadsForTests } from "../../src/resolvers/gap-to-feature.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

// MITOSIS_DIRECT_PUSH=0 stops LANDING (the cutover's kill switch, push-policy landingsStopped),
// but admission never asked it: a node with landings stopped kept auto-picking, ran the typecheck
// admission pass, paid for an LLM draft and wrote compose worktrees, only to be refused at
// cutover. These pin that admission asks the same predicate first, and that only the auto-pick
// lane is affected.

const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
const originalFetch = globalThis.fetch;
const originalSwitch = process.env["MITOSIS_DIRECT_PUSH"];
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const policy = explicitOpenPolicy(init?.body ? JSON.parse(String(init.body)) : {});
    if (policy) return policy;
    throw new TypeError("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
});
afterAll(() => { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); });
afterEach(() => {
  if (originalSwitch === undefined) delete process.env["MITOSIS_DIRECT_PUSH"];
  else process.env["MITOSIS_DIRECT_PUSH"] = originalSwitch;
});

// Point citedExistingFile at this checkout so the real groundable predicate runs (see the
// groundable-admission test for why).
process.env["MITOSIS_RUNTIME_DIR"] = new URL("../../", import.meta.url).pathname.replace(/\/$/, "") + "/..";

const gap = (id: string) => ({
  id,
  category: "systematic_failure",
  summary: `gap ${id}`,
  classification_metadata: { falsifier: "class2", edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts" },
});

/** Run `fn` while capturing console.log lines. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { return { result: await fn(), lines }; } finally { console.log = orig; }
}

// A runner that records every call: a stopped pass must not shell a typecheck at all.
const countingRunner = () => {
  const calls: string[] = [];
  const runner = (vessel: string) => { calls.push(vessel); return { ran: true, clean: true }; };
  return { calls, runner };
};

describe("admitActionableGaps — landings stopped", () => {
  it("admits nothing and reports landings_stopped for every candidate when MITOSIS_DIRECT_PUSH=0", async () => {
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const { calls, runner } = countingRunner();
    const { result, lines } = await captureLog(() => admitActionableGaps([gap("a"), gap("b"), gap("c")], { typecheckRunner: runner }));
    expect(result.admitted).toEqual([]);
    expect(result.excluded).toEqual([
      { id: "a", reason: "landings_stopped" },
      { id: "b", reason: "landings_stopped" },
      { id: "c", reason: "landings_stopped" },
    ]);
    expect(calls).toEqual([]);
    // One line per pass, not one per gap.
    expect(lines.filter((l) => l.includes("landings_stopped")).length).toBe(1);
  });

  it("control: with MITOSIS_DIRECT_PUSH=1 admission behaves as before", async () => {
    process.env["MITOSIS_DIRECT_PUSH"] = "1";
    const { result, lines } = await captureLog(() => admitActionableGaps([gap("a"), gap("b")]));
    expect(result.admitted.map((g) => String(g.id)).sort()).toEqual(["a", "b"]);
    expect(result.excluded.some((e) => e.reason === "landings_stopped")).toBe(false);
    expect(lines.some((l) => l.includes("landings_stopped"))).toBe(false);
  });

  it("control: with the switch unset (the cutover's own default) admission behaves as before", async () => {
    delete process.env["MITOSIS_DIRECT_PUSH"];
    const r = await admitActionableGaps([gap("a")]);
    expect(r.admitted.map((g) => String(g.id))).toEqual(["a"]);
  });
});

describe("gap_to_feature — landings stopped gates only the auto-pick lane", () => {
  it("an autonomous auto-pick (no gap_id) is excluded at admission with landings_stopped", async () => {
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const { result, lines } = await captureLog(() => resolveGapToFeature({ type: "gapToFeature" } as never));
    const body = result.body as { stage?: string; error?: string };
    expect(body.stage).toBe("select");
    expect(body.error).toBe("no matching open gap");
    expect(lines.filter((l) => l.includes("auto-pick admission: landings_stopped")).length).toBe(1);
  });

  it("an operator-directed (targeted) dispatch never reaches the landings_stopped exclusion", async () => {
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
    const { result, lines } = await captureLog(() =>
      resolveGapToFeature({ type: "gapToFeature", gap_id: "no-such-gap-landings-stopped", directed: true } as never));
    const body = result.body as { stage?: string; error?: string };
    // It ends on its own terms (the gap does not exist), not on the auto-pick exclusion.
    expect(body.error).toBe("no matching open gap");
    expect(lines.some((l) => l.includes("landings_stopped"))).toBe(false);
    expect(lines.some((l) => l.includes("auto-pick admission"))).toBe(false);
  });
});
