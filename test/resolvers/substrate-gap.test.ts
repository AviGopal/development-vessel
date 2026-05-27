import { describe, it, expect } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";

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
});
