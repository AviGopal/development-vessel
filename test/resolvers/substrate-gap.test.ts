import { describe, it, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, existsSync } from "fs";

// IMPORTANT: set WORKSPACE_ROOT BEFORE importing the resolver — config.ts
// snapshots the env var at module-load. Top-level statements run before any
// describe/beforeAll, so setting here is the only way to inject test workspace.
const testWorkspace = join(tmpdir(), `dev-vessel-substrate-gap-test-${Date.now()}`);
try {
  rmSync(testWorkspace, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.env["WORKSPACE_ROOT"] = testWorkspace;
// Without this, every open-gap write below shells out to the REAL `systemctl start
// gap-compose.service` against whatever systemd this test process can reach — see
// the comment above the skipComposeTrigger check in substrate-gap.ts. Must be set
// before import, same as WORKSPACE_ROOT above.
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const { resolveSubstrateGap, resolveSubstrateGapWrite } = await import(
  "../../src/resolvers/substrate-gap.js"
);

describe("substrateGap resolver", () => {
  it("write creates a gap with default status=open", async () => {
    const result = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: "gap-001",
        category: "conversation_only",
        source: "operator_narration",
        summary: "test gap",
        detected_at: "2026-05-27T23:00:00Z",
        status: "open",
      },
    });
    expect(result.shape).toBe("substrateGapWriteResult");
    expect((result.body as { id: string }).id).toBe("gap-001");
    expect((result.body as { action: string }).action).toBe("created");
  });

  it("read returns the previously written gap", async () => {
    const result = await resolveSubstrateGap({ type: "substrateGap", id: "gap-001" });
    expect(result.shape).toBe("substrateGap");
    const body = result.body as { gaps: Array<{ id: string; status: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.gaps[0]!.id).toBe("gap-001");
    expect(body.gaps[0]!.status).toBe("open");
  });

  it("write is idempotent on id — second write updates", async () => {
    const result = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: "gap-001",
        category: "conversation_only",
        source: "operator_narration",
        summary: "updated summary",
        detected_at: "2026-05-27T23:00:00Z",
        status: "closed",
      },
    });
    expect((result.body as { action: string }).action).toBe("updated");

    const read = await resolveSubstrateGap({ type: "substrateGap", id: "gap-001" });
    const body = read.body as { gaps: Array<{ summary: string; status: string }> };
    expect(body.gaps[0]!.summary).toBe("updated summary");
    expect(body.gaps[0]!.status).toBe("closed");
  });

  it("read filters by category", async () => {
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id: "gap-missing-concept",
        category: "missing_concept",
        source: "substrate_detected",
        summary: "novel shape with no resolver",
        detected_at: "2026-05-27T23:00:00Z",
        status: "open",
      },
    });

    const conv = await resolveSubstrateGap({
      type: "substrateGap",
      category: "conversation_only",
    });
    const concept = await resolveSubstrateGap({
      type: "substrateGap",
      category: "missing_concept",
    });
    expect((conv.body as { total: number }).total).toBe(1);
    expect((concept.body as { total: number }).total).toBe(1);
  });

  it("read filters by status (only open by default not enforced — explicit filter)", async () => {
    const open = await resolveSubstrateGap({ type: "substrateGap", status: "open" });
    const closed = await resolveSubstrateGap({ type: "substrateGap", status: "closed" });
    expect((open.body as { total: number }).total).toBe(1);
    expect((closed.body as { total: number }).total).toBe(1);
  });

  // Pins defensive hardening added 2026-08-30: workspaceRoot() now captures
  // WORKSPACE_ROOT once at module load instead of re-reading it on every call,
  // so a runtime mutation of that env var from elsewhere in the process can no
  // longer redirect gap reads/writes mid-lifetime. This is a precaution, not a
  // fix for an observed incident — the investigation that prompted it turned
  // out to be a misdiagnosis (an operator probe checked a stale fossil path,
  // not the live store, which had been persisting correctly all along; see
  // the comment above workspaceRoot()). This test simulates the hypothetical
  // the hardening guards against: mutate the env var AFTER the module has
  // already loaded, then verify a write still lands in the module-load-time
  // workspace, not the mutated one.
  it("is immune to process.env.WORKSPACE_ROOT changing after module load", async () => {
    const decoyRoot = join(tmpdir(), `decoy-workspace-${Date.now()}`);
    const original = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = decoyRoot;
    try {
      const write = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: "post-mutation-probe",
          category: "conversation_only",
          source: "operator_narration",
          summary: "must land in the original workspace, not the decoy",
          detected_at: "2026-08-30T00:00:00Z",
          status: "open",
        },
      });
      expect((write.body as { action: string }).action).toBe("created");

      const read = await resolveSubstrateGap({ type: "substrateGap", id: "post-mutation-probe" });
      expect((read.body as { total: number }).total).toBe(1);

      // The decoy path must never have been created — proves the write went
      // to the original module-load-time workspace, not the mutated one.
      expect(existsSync(join(decoyRoot, "gaps", "gaps.json"))).toBe(false);
    } finally {
      process.env["WORKSPACE_ROOT"] = original;
    }
  });

  // Pins the fix for a real production side effect (2026-08-30): writing an open
  // gap through this resolver unconditionally shells out to `systemctl start
  // gap-compose.service` and self-fetches a compose nudge — neither gated behind
  // a test seam. This file itself creates several open gaps per run, so every
  // `bun test` pass that includes this file — including the one compose's own
  // verify pipeline runs on every candidate fix — could start another
  // gap-compose.service tick against the live system. SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER
  // (set at the top of this file, before import) suppresses that; this test proves
  // the suppression actually reaches Bun.spawn, and that flipping it off restores
  // the original trigger behavior (the guard doesn't silently disable production).
  it("does not spawn systemctl when SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER=1, but does when unset", async () => {
    const realSpawn = Bun.spawn;
    const realFetch = globalThis.fetch;
    const spawnCalls: unknown[][] = [];
    const fakeExited = Promise.resolve(0);
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      spawnCalls.push(args);
      return { exited: fakeExited } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    // The "guard off" branch below also reaches the second production side effect
    // in this same code block — a self-fetch nudge to THIS vessel's own live HTTP
    // surface (http://127.0.0.1:8090 by default). Left real, this test would
    // recreate, on every run, exactly the production side effect it exists to
    // prove is suppressed. Stub it to a no-op response.
    (globalThis as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
    const g = globalThis as { __gapComposeLastTrigger?: number; __composeDrainInflight?: boolean };
    const savedTrigger = g.__gapComposeLastTrigger;
    const savedInflight = g.__composeDrainInflight;
    try {
      // Guard ON (the default for this whole file): no spawn.
      g.__gapComposeLastTrigger = undefined;
      g.__composeDrainInflight = false;
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: "compose-trigger-guard-on-probe",
          category: "conversation_only",
          source: "operator_narration",
          summary: "must not start gap-compose.service while the test guard is on",
          detected_at: "2026-08-30T00:00:00Z",
          status: "open",
        },
      });
      expect(spawnCalls.length).toBe(0);

      // Guard OFF: the real production path fires (against the fake Bun.spawn, so
      // still nothing real launches), proving the guard is additive, not a
      // standing disable of the trigger.
      process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "0";
      g.__gapComposeLastTrigger = undefined;
      g.__composeDrainInflight = false;
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: "compose-trigger-guard-off-probe",
          category: "conversation_only",
          source: "operator_narration",
          summary: "must start gap-compose.service when the test guard is off",
          detected_at: "2026-08-30T00:00:01Z",
          status: "open",
        },
      });
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0]?.[0]).toEqual(["systemctl", "start", "gap-compose.service"]);
    } finally {
      process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
      g.__gapComposeLastTrigger = savedTrigger;
      g.__composeDrainInflight = savedInflight;
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = realSpawn;
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
  });
});
