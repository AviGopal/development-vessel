import { describe, expect, it } from "bun:test";
import { joinDecisionOutcome } from "../../src/resolvers/gap-to-feature";

/**
 * AN OUTCOME JOINS ITS OWN DECISION, NEVER ANOTHER NODE'S (gap: join-decision-outcome-writes-a-compose-outcome-
 * onto-another-nodes-decision-entry). joinDecisionOutcome wrote onto the newest UNJOINED approach_decisions entry,
 * whoever created it: with two nodes picking the same gap, node B's compose outcome landed on node A's still-open
 * decision, A's later outcome was appended as an orphan, and B's own decision stayed unjoined forever. Each
 * decision entry now carries a decision_id and its node; an outcome joins by id, else only an entry its own node
 * (or a legacy entry with no node) made, else appends a joined entry of its own.
 */
type Entry = Record<string, unknown>;
const join3 = joinDecisionOutcome as unknown as (meta: Record<string, unknown>, outcome: Record<string, unknown>, ref?: { decision_id?: string; node?: string }) => void;

describe("joinDecisionOutcome joins by owner", () => {
  it("two unjoined entries from two nodes: node B's outcome marks B's entry and A's stays unjoined", () => {
    const meta: Record<string, unknown> = {
      approach_decisions: [
        { at: "2026-10-03T10:00:00.000Z", decision_id: "dec-b", node: "node-b", predicted_p: 0.5 },
        { at: "2026-10-03T10:00:05.000Z", decision_id: "dec-a", node: "node-a", predicted_p: 0.6 },
      ],
    };
    join3(meta, { landed: false }, { node: "node-b" });
    const decs = meta.approach_decisions as Entry[];
    expect(decs).toHaveLength(2);
    expect((decs[0]!.outcome as Entry | undefined)?.landed).toBe(false);
    expect("outcome" in decs[1]!).toBe(false);
  });

  it("joins by decision_id when given, even when another entry is newer", () => {
    const meta: Record<string, unknown> = {
      approach_decisions: [
        { at: "2026-10-03T10:00:00.000Z", decision_id: "dec-a", node: "node-a" },
        { at: "2026-10-03T10:00:05.000Z", decision_id: "dec-a2", node: "node-a" },
      ],
    };
    join3(meta, { landed: true, commit: "abc" }, { decision_id: "dec-a", node: "node-a" });
    const decs = meta.approach_decisions as Entry[];
    expect((decs[0]!.outcome as Entry | undefined)?.commit).toBe("abc");
    expect("outcome" in decs[1]!).toBe(false);
  });

  it("with no entry of its own, appends a joined entry carrying its node instead of writing onto another node's", () => {
    const meta: Record<string, unknown> = {
      approach_decisions: [{ at: "2026-10-03T10:00:00.000Z", decision_id: "dec-a", node: "node-a" }],
    };
    join3(meta, { landed: false }, { node: "node-b" });
    const decs = meta.approach_decisions as Entry[];
    expect(decs).toHaveLength(2);
    expect("outcome" in decs[0]!).toBe(false);
    expect(decs[1]!.node).toBe("node-b");
    expect((decs[1]!.outcome as Entry).landed).toBe(false);
  });
});
