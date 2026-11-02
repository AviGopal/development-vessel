// A COMPOSE THAT DIES BECAUSE THE LLM PLANE DID NOT ANSWER IS A NON-ATTEMPT, NOT A FAILED ATTEMPT.
//
// When the draft (decompose) LLM call threw, feature-compose returned { ok:false, stage:"decompose", error } with no
// failure_kind. The grader's non-attempt predicates (isNonAttemptComposeResult, isInfraRefusalBody) did not recognise it,
// so an outage was charged to the gap it interrupted: failed_attempts +1, last_failed_at, a class-posterior miss. One
// such death took an honest recommit lineage to the recommit cap, which never decays. Expected, through a full
// resolveFeatureCompose run on the drafter-split harness (scripted LLM, every seam hermetic; this file only answers the
// planner's decompose prompt itself, in front of the harness router, and passes everything else through):
//   - the planner's LLM answers 502 on every round (the plane is down): the report carries failure_kind "environment",
//     which the EXISTING predicates already treat as a non-attempt, and the journal line says so (the must-fail);
//   - CONTROL: the planner's LLM refuses with a 400 (a decision, not an outage): reported exactly as before, no
//     failure_kind, still an attempt;
//   - CONTROL: the drafter answers with no ops (the harness's own plan): reported as before, still an attempt.
// The harness normalises the [fc-decompose-failed] tag to [fc-<ID>], so the journal line is matched by its text.
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";
import { isInfraRefusalBody, isNonAttemptComposeResult } from "../../src/judge/gap-eligibility.js";

const iso = await isolateRuntimeRoot("decompose-llm-plane", { superRepo: true, who: "test/resolvers/feature-compose-decompose-llm-plane.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(iso.root, iso.runtime);
afterAll(() => H.restore());

const NO_OPS = CORPUS.find((f) => f.name === "directed / no ops")!;
const PLANNER = "decomposing a feature specification"; // the harness's own key for the decompose prompt
let seq = 0;
/** One compose of the harness's no-ops fixture; with `plannerStatus`, the planner's LLM call answers that status. */
async function compose(plannerStatus: 502 | 400 | null): Promise<{ body: Record<string, any>; console: string[]; plannerCalls: number }> {
  H.install();
  const fc = await import(`../../src/resolvers/feature-compose.ts?decompose-llm-plane=${++seq}`);
  let plannerCalls = 0;
  const viaPlanner = {
    resolveFeatureCompose: async (p: unknown) => {
      const router = globalThis.fetch; // the harness's router, installed for this run
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        let prompt = "";
        try { prompt = String(JSON.parse(String(init?.body ?? "{}"))?.prompt ?? ""); } catch { /* not json */ }
        if (plannerStatus !== null && prompt.includes(PLANNER)) {
          plannerCalls++;
          return new Response(`planner fixture (${plannerStatus})`, { status: plannerStatus });
        }
        return router(input as never, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router; }
    },
  };
  let body: Record<string, any> = {};
  const rec = await H.run(viaPlanner, { ...NO_OPS, name: `decompose-llm-plane ${plannerStatus ?? "no_ops"}` }, (b) => { body = b; });
  return { body, console: rec.console, plannerCalls };
}

describe("feature-compose: a draft LLM call that throws because the LLM plane did not answer", () => {
  it("[MUST-FAIL] every round of the planner's LLM answers 502: the report is a non-attempt (failure_kind environment)", async () => {
    const { body, console: lines, plannerCalls } = await compose(502);
    expect(plannerCalls).toBe(3); // one endpoint, three rounds: the failover ran out on transient failures
    expect(body.ok).toBe(false);
    expect(body.stage).toBe("decompose");
    expect(String(body.error)).toContain("failed with status 502");
    expect(body.failure_kind).toBe("environment");
    expect(isNonAttemptComposeResult(body)).toBe(true);
    expect(isInfraRefusalBody(body)).toBe(true);
    expect(lines.some((l) => l.includes("draft LLM call threw") && l.includes("the LLM plane did not answer"))).toBe(true);
  }, 60_000);

  it("[CONTROL] the planner's LLM refuses with a 400: reported as before, still an attempt", async () => {
    const { body, console: lines, plannerCalls } = await compose(400);
    expect(plannerCalls).toBe(1); // a 4xx is a decision: no second round
    expect(body.stage).toBe("decompose");
    expect(String(body.error)).toContain("failed with status 400");
    expect(body.failure_kind).toBeUndefined();
    expect(isNonAttemptComposeResult(body)).toBe(false);
    expect(isInfraRefusalBody(body)).toBe(false);
    expect(lines.some((l) => l.includes("draft LLM call threw") && !l.includes("the LLM plane did not answer"))).toBe(true);
  }, 60_000);

  it("[CONTROL] the drafter answers with no ops: reported as before, still an attempt", async () => {
    const { body } = await compose(null);
    expect(body.stage).toBe("decompose");
    expect(body.failure_kind).toBeUndefined();
    expect(isNonAttemptComposeResult(body)).toBe(false);
  }, 60_000);
});
