/**
 * goal-reach-tick seed template — the shape contract the caller and the grader rely on.
 * One task resolving goal_reach_tick; declared output goalReachTickResult, which is the shape the
 * resolver returns (light-dispatch grades reach as "every declared output shape produced", so a
 * declared shape the resolver never emits would be a permanent beta); selectable by boredom; and
 * registered in SEED_TEMPLATES like gap-lifecycle-tick.
 */
import { describe, expect, it } from "bun:test";
import { GOAL_REACH_TICK_TEMPLATE } from "../../src/seed/goal-reach-tick.js";
import { SEED_TEMPLATES } from "../../src/seed/index.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";

describe("template contract — development-vessel:goal-reach-tick", () => {
  it("one task resolving goal_reach_tick, output goalReachTickResult, selectable by boredom", () => {
    const t = GOAL_REACH_TICK_TEMPLATE;
    expect(t.id).toBe("development-vessel:goal-reach-tick");
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0]!.resolver).toBe("goal_reach_tick");
    expect((t.tasks[0]!.config as Record<string, unknown>)["type"]).toBe("goal_reach_tick");
    expect(t.outputShapes).toEqual(["goalReachTickResult"]);
    expect(t.tasks[0]!.outputShapes).toEqual(["goalReachTickResult"]);
    expect(t.tags).toContain("boredom_target_template");
    expect(t.inputShapes).toEqual([]);
  });
  it("is registered in SEED_TEMPLATES and its resolver is an advertised shape", () => {
    expect(SEED_TEMPLATES.map((x) => x.id)).toContain("development-vessel:goal-reach-tick");
    expect(DISCOVERY_SHAPES).toContain("goal_reach_tick");
  });
  it("carries metadata.seed_version >= 1, so the version-bumped upsert delivers it to a populated catalogue", () => {
    // Without it the seeder skips this template on every non-empty catalogue (seed_version 0 is
    // "never opted in"), and the live registry answered "Template not found" for its id.
    const v = Number((GOAL_REACH_TICK_TEMPLATE as { metadata?: { seed_version?: unknown } }).metadata?.seed_version ?? 0);
    expect(v).toBeGreaterThanOrEqual(1);
  });
});
