// A run's record is read from the goal-host that ran it. A shared gap's dispatch ids come from every node; reading them
// all from this node's goal-host skipped other nodes' runs as "unreadable here" (432/day on one node, 101 on another,
// 2026-10-16). Restores 7861c76e's origin read, which producer-dispatch's readRun (1eaff12d) did not take.
import { describe, expect, test } from "bun:test";
import { runOriginBase } from "../../src/resolvers/goal-reach-tick";

describe("runOriginBase", () => {
  test("a tally entry's node (a goal-host resolve URL) maps to that goal-host's base", async () => {
    expect(await runOriginBase({ node: "http://sibling:8210/v2/impulses/resolve" }, async () => "http://own:8210")).toBe("http://sibling:8210");
    expect(await runOriginBase({ node: "http://sibling:8210/resolve" }, async () => "http://own:8210")).toBe("http://sibling:8210");
  });
  test("[CONTROL] an entry with no node falls back to this node's own goal-host", async () => {
    expect(await runOriginBase({ node: null }, async () => "http://own:8210")).toBe("http://own:8210");
    expect(await runOriginBase(undefined, async () => "http://own:8210")).toBe("http://own:8210");
  });
});
