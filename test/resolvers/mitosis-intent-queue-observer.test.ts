import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMitosisIntentQueueObserver } from "../../src/resolvers/mitosis-intent-queue-observer.js";

const root = join(tmpdir(), `dev-vessel-mitosis-queue-${Date.now()}`);

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  const intents = [
    {
      intent_id: "i1",
      vessel_name: "v",
      proposal_id: "p1",
      emitted_at: "2026-06-04T10:00:00.000Z",
    },
    {
      intent_id: "i2",
      vessel_name: "v",
      proposal_id: "p2",
      emitted_at: "2026-06-04T11:00:00.000Z",
    },
    {
      intent_id: "i3",
      vessel_name: "v",
      proposal_id: "p3",
      emitted_at: "2026-06-04T12:00:00.000Z",
    },
  ];
  writeFileSync(
    join(root, "mitosis-applied-host-sync.jsonl"),
    intents.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const results = [
    { intent_id: "i1", push_status: "pushed" },
    { intent_id: "i2", push_status: "rejected_scope_creep" },
  ];
  writeFileSync(
    join(root, "mitosis-applied-host-sync-results.jsonl"),
    results.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
});

describe("mitosis_intent_queue_observer", () => {
  it("aggregates pushed / rejected / pending counts", async () => {
    const result = await resolveMitosisIntentQueueObserver({
      type: "mitosis_intent_queue_observer",
      workspaceRoot: root,
    });
    expect(result.shape).toBe("mitosisIntentQueueState");
    const body = result.body as {
      total_intents: number;
      pending_count: number;
      pushed_count: number;
      rejected_count_by_reason: Record<string, number>;
      oldest_pending_iso: string | null;
    };
    expect(body.total_intents).toBe(3);
    expect(body.pushed_count).toBe(1);
    expect(body.pending_count).toBe(1);
    expect(body.rejected_count_by_reason["rejected_scope_creep"]).toBe(1);
    expect(body.oldest_pending_iso).toBe("2026-06-04T12:00:00.000Z");
  });

  it("returns recent intents up to limit", async () => {
    const result = await resolveMitosisIntentQueueObserver({
      type: "mitosis_intent_queue_observer",
      workspaceRoot: root,
      recentLimit: 2,
    });
    const body = result.body as { recent_intents: Array<{ intent_id: string | null }> };
    expect(body.recent_intents.length).toBe(2);
  });

  it("degrades to zeros when JSONL files are absent", async () => {
    const result = await resolveMitosisIntentQueueObserver({
      type: "mitosis_intent_queue_observer",
      workspaceRoot: join(tmpdir(), `nonexistent-dir-${Date.now()}`),
    });
    const body = result.body as {
      total_intents: number;
      total_results: number;
      pending_count: number;
    };
    expect(body.total_intents).toBe(0);
    expect(body.total_results).toBe(0);
    expect(body.pending_count).toBe(0);
  });
});
