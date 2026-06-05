import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppliedProposalSentinelObserver } from "../../src/resolvers/applied-proposal-sentinel-observer.js";

const root = join(tmpdir(), `dev-vessel-applied-sentinel-${Date.now()}`);

beforeAll(() => {
  const dir = join(root, "proposals", ".applied");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auto-001-report.json"), "");
  writeFileSync(join(dir, "auto-002-report.json"), "");
  writeFileSync(join(dir, "auto-003-report.json"), "");
});

describe("applied_proposal_sentinel_observer", () => {
  it("returns appliedProposalSentinelState with counts and recent entries", async () => {
    const result = await resolveAppliedProposalSentinelObserver({
      type: "applied_proposal_sentinel_observer",
      workspaceRoot: root,
    });
    expect(result.shape).toBe("appliedProposalSentinelState");
    const body = result.body as {
      applied_count: number;
      recent_applied: Array<{ name: string; applied_at_iso: string }>;
      sentinel_dir_present: boolean;
      last_applied_name: string | null;
    };
    expect(body.applied_count).toBe(3);
    expect(body.sentinel_dir_present).toBe(true);
    expect(body.recent_applied.length).toBe(3);
    expect(body.last_applied_name).not.toBeNull();
  });

  it("honors recentLimit", async () => {
    const result = await resolveAppliedProposalSentinelObserver({
      type: "applied_proposal_sentinel_observer",
      workspaceRoot: root,
      recentLimit: 1,
    });
    const body = result.body as { recent_applied: unknown[] };
    expect(body.recent_applied.length).toBe(1);
  });

  it("degrades gracefully when sentinel dir is absent", async () => {
    const result = await resolveAppliedProposalSentinelObserver({
      type: "applied_proposal_sentinel_observer",
      workspaceRoot: join(tmpdir(), `missing-root-${Date.now()}`),
    });
    const body = result.body as {
      applied_count: number;
      sentinel_dir_present: boolean;
      last_applied_iso: string | null;
    };
    expect(body.applied_count).toBe(0);
    expect(body.sentinel_dir_present).toBe(false);
    expect(body.last_applied_iso).toBeNull();
  });
});
