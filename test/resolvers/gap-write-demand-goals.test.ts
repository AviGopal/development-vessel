// demand_goals HAS TWO WRITERS (src/lib/demand-goals.ts):
//   1. goal-host fileCapabilityGap rewrites the WHOLE array as goal-text strings and derives
//      demand_count from it (its 2-goal minting floor); its reader keeps strings only.
//   2. the goal-reach seam appends `{source:"goal_reach", goal_hash, dispatch_id, origin}` linkage.
// The store must (a) apply appends against the STORED array under its lock, so concurrent attaches
// keep both, and (b) never let writer 1's string-only rewrite erase writer 2's linkage, while leaving
// writer 1's strings and demand_count exactly as it sent them. Driven through the real store under a
// temp WORKSPACE_ROOT (fresh module instance, same isolation as substrate-gap.test.ts).
import { afterAll, describe, expect, it } from "bun:test";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Gap writes here must not reach the live event bus (test/resolvers/stub-gap-event-publish.ts).
const gapEventPublishStub = stubGapEventPublish();
afterAll(() => gapEventPublishStub.restore());

const ROOT = join(tmpdir(), `gap-write-demand-goals-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const mod = await import(`../../src/resolvers/substrate-gap.js?${"gap-demand-goals"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) throw new Error("refusing to run against a non-temp gap store");
const { resolveSubstrateGap, resolveSubstrateGapWrite } = mod;

const link = (dispatch_id: string, goal_hash = "1a2b3c4d") => ({ source: "goal_reach", goal_hash, dispatch_id, origin: "autonomous" });
/** Exactly the row goal-host fileCapabilityGap writes (goal-host-vessel src/index.ts, origin/dev acf4922). */
const capabilityGap = (id: string, demandGoals: string[]) => ({
  id, category: "missing_capability", source: "substrate_detected", status: demandGoals.length >= 2 ? "open" : "closed",
  summary: `Capability gap: the goal-walk needs a producer for shape "${id}"`, detected_at: "2026-10-02T10:00:00Z",
  classification_metadata: { kind: "capability_gap", missing_shape: id, demand_goals: demandGoals, demand_count: demandGoals.length },
});
/** goal-host's reader of the same field, verbatim: `dg.filter((x): x is string => typeof x === "string")`. */
const goalHostReader = (dg: unknown): string[] => (Array.isArray(dg) ? dg.filter((x): x is string => typeof x === "string") : []);

async function row(id: string): Promise<Record<string, any> | undefined> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 5 } as never);
  return ((r.body as { gaps?: Array<Record<string, any>> }).gaps ?? []).find((g) => g.id === id);
}
/** How an attacher writes: it re-sends the row's identity fields (an open gap must carry its summary)
 *  with NO classification_metadata of its own, plus the append, guarded by the status it read. */
async function attach(id: string, entries: unknown[], expect_status = "open") {
  const r = await row(id);
  return resolveSubstrateGapWrite({
    type: "substrateGap_write", expect_status, demand_goals_append: entries,
    gap: { id, category: r?.category ?? "missing_capability", source: r?.source ?? "substrate_detected", status: expect_status, summary: r?.summary ?? "", detected_at: r?.detected_at ?? "2026-10-02T10:00:00Z" },
  } as never);
}

describe("substrateGap_write demand_goals — two writers", () => {
  it("two concurrent attaches to one gap keep BOTH (merged under the store lock, not read-modify-write)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeA", ["goal one", "goal two"]) } as never);
    await Promise.all([attach("shapeA", [link("d1")]), attach("shapeA", [link("d2", "5e6f7a8b")])]);
    const dg = (await row("shapeA"))!.classification_metadata.demand_goals as unknown[];
    expect(dg).toContainEqual(link("d1"));
    expect(dg).toContainEqual(link("d2", "5e6f7a8b"));
    expect(goalHostReader(dg)).toEqual(["goal one", "goal two"]);
  });

  it("an attach is idempotent on (goal_hash, dispatch_id)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeB", ["goal one", "goal two"]) } as never);
    await attach("shapeB", [link("d1")]);
    await attach("shapeB", [link("d1")]);
    const dg = (await row("shapeB"))!.classification_metadata.demand_goals as unknown[];
    expect(dg.filter((x) => typeof x === "object")).toHaveLength(1);
  });

  it("goal-host's string-only rewrite keeps its strings and demand_count byte-identical AND does not erase linkage", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeC", ["goal one", "goal two"]) } as never);
    await attach("shapeC", [link("d1")]);
    // fileCapabilityGap re-emits with a third goal: it read strings only, so it sends strings only.
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeC", ["goal one", "goal two", "goal three"]) } as never);
    const meta = (await row("shapeC"))!.classification_metadata;
    expect(goalHostReader(meta.demand_goals)).toEqual(["goal one", "goal two", "goal three"]);
    expect(meta.demand_count).toBe(3);
    expect(meta.demand_goals).toContainEqual(link("d1"));
  });

  it("the existing consumer's view is unchanged by a goal_reach attach (strings, count, floor)", async () => {
    // A single-goal row (below goal-host's 2-goal floor), held open so an attach can reach it.
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...capabilityGap("shapeD", ["only goal"]), status: "open" } } as never);
    const before = (await row("shapeD"))!.classification_metadata;
    await attach("shapeD", [link("d1")]);
    const after = (await row("shapeD"))!.classification_metadata;
    expect(after.demand_goals).toContainEqual(link("d1"));
    expect(goalHostReader(after.demand_goals)).toEqual(goalHostReader(before.demand_goals));
    expect(after.demand_count).toBe(before.demand_count);
    expect(goalHostReader(after.demand_goals).length >= 2).toBe(false); // a linkage entry is not a second demanding goal
  });

  it("expect_status guards the attach: no linkage is added to a gap closed since it was read", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeE", ["goal one", "goal two"]) } as never);
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...capabilityGap("shapeE", ["goal one", "goal two"]), status: "closed", classification_metadata: { closed_reason: "producer_now_exists", closed_by: "gap_lifecycle_scan" } } } as never);
    const r = await resolveSubstrateGapWrite({
      type: "substrateGap_write", expect_status: "open", demand_goals_append: [link("d1")],
      gap: { id: "shapeE", category: "missing_capability", source: "substrate_detected", status: "open", summary: "stale read", detected_at: "2026-10-02T10:00:00Z" },
    } as never);
    expect((r.body as { skip_reason?: string }).skip_reason).toBe("status_precondition_failed");
    const after = (await row("shapeE"))!;
    expect(after.status).toBe("closed");
    expect((after.classification_metadata.demand_goals as unknown[]).some((x) => typeof x === "object")).toBe(false);
  });

  it("only structured goal_reach entries are appended; strings and foreign objects in an append are dropped", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeF", ["goal one", "goal two"]) } as never);
    await attach("shapeF", ["sneaky goal text", { goal_hash: "x", dispatch_id: "y" }, link("d1")]);
    const dg = (await row("shapeF"))!.classification_metadata.demand_goals as unknown[];
    expect(goalHostReader(dg)).toEqual(["goal one", "goal two"]);
    expect(dg.filter((x) => typeof x === "object")).toEqual([link("d1")]);
  });

  it("control: with no goal_reach entries anywhere, a rewrite stores demand_goals exactly as sent (behaviour unchanged)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeG", ["goal one", "goal two"]) } as never);
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: capabilityGap("shapeG", ["goal two", "goal three"]) } as never);
    expect((await row("shapeG"))!.classification_metadata.demand_goals).toEqual(["goal two", "goal three"]);
  });
});
