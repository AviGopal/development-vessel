// CONDITIONAL GAP WRITE (expect_status). A read-modify-write caller (bumpFailedAttempts, recordLineageSpend)
// reads the row, awaits, and writes it back as open. If the sweep or the verifier closes the gap in
// between, an unconditional write REOPENS it, and a closed->open transition fires the event-driven
// compose pickup: a failure bump (or a spend record) would buy a fresh compose of a closed gap.
// `expect_status` is checked under the store lock against the row with the exact id; on a mismatch the
// write is a no-op. Driven through the real store under a temp WORKSPACE_ROOT.
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-expect-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;
// Never shell the real gap-compose trigger from a test (see substrate-gap.test.ts).
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const { resolveSubstrateGap, resolveSubstrateGapWrite } = await import("../../src/resolvers/substrate-gap.js");
const g2f = (await import("../../src/resolvers/gap-to-feature.js")) as Record<string, any>;

const base = (id: string, status: "open" | "closed", meta: Record<string, unknown> = {}) => ({
  id, category: "operator_request", source: "human_reported", summary: `race fixture ${id}`, detected_at: "2026-10-02T10:00:00Z",
  classification_metadata: meta, status,
});
async function row(id: string): Promise<Record<string, any> | undefined> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 5 } as never);
  return ((r.body as { gaps?: Array<Record<string, any>> }).gaps ?? []).find((g) => g.id === id);
}

describe("substrateGap_write expect_status", () => {
  it("a stale open write to a row closed since the read is a no-op: it stays closed, is not reopened, metadata untouched", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("race-closed", "open", { failed_attempts: 2 }) } as never);
    const staleCopy = await row("race-closed");
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...base("race-closed", "closed", { ...staleCopy!.classification_metadata, closed_reason: "already_resolved" }) } } as never);
    const r = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      expect_status: "open",
      gap: base("race-closed", "open", { ...staleCopy!.classification_metadata, failed_attempts: 3 }),
    } as never);
    expect((r.body as { action?: string; skip_reason?: string }).skip_reason).toBe("status_precondition_failed");
    const after = await row("race-closed");
    expect(after!.status).toBe("closed");
    expect(after!.reopen_count ?? 0).toBe(0);
    expect(after!.classification_metadata.failed_attempts).toBe(2);
  });

  it("control: the same stale write WITHOUT expect_status reopens the row (the hazard)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("race-control", "open") } as never);
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("race-control", "closed", { closed_reason: "already_resolved" }) } as never);
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("race-control", "open", { failed_attempts: 1 }) } as never);
    const after = await row("race-control");
    expect(after!.status).toBe("open");
    expect(after!.reopen_count).toBe(1);
  });

  it("never creates a row: an expect_status write for an absent id is skipped", async () => {
    const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: base("race-absent", "open") } as never);
    expect((r.body as { skip_reason?: string }).skip_reason).toBe("status_precondition_failed");
    expect(await row("race-absent")).toBeUndefined();
  });

  it("applies normally when the stored status matches", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("race-open", "open", { failed_attempts: 1 }) } as never);
    const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: base("race-open", "open", { failed_attempts: 2 }) } as never);
    expect((r.body as { action?: string }).action).toBe("updated");
    expect((await row("race-open"))!.classification_metadata.failed_attempts).toBe(2);
  });
});

describe("recordLineageSpend writes a ledger patch, conditionally", () => {
  it("charges an open row: ledger appended, every other metadata key kept", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("spend-open", "open", { failed_attempts: 4, other_writer_key: "kept" }) } as never);
    await g2f.recordLineageSpend("spend-open", { llm_usage: { cost_usd: 0.3 } }, false);
    const after = await row("spend-open");
    expect(after!.status).toBe("open");
    expect(after!.classification_metadata.spend_ledger.map((e: { usd: number }) => e.usd)).toEqual([0.3]);
    expect(after!.classification_metadata.failed_attempts).toBe(4);
    expect(after!.classification_metadata.other_writer_key).toBe("kept");
  });

  it("a close racing the spend record leaves the row closed (never reopened)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("spend-race", "open") } as never);
    await Promise.all([
      g2f.recordLineageSpend("spend-race", { llm_usage: { cost_usd: 0.4 } }, false),
      resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("spend-race", "closed", { closed_reason: "landed_verified" }) } as never),
    ]);
    const after = await row("spend-race");
    expect(after!.status).toBe("closed");
    expect(after!.reopen_count ?? 0).toBe(0);
  });

  it("a close racing a failed-attempt bump leaves the row closed (never reopened)", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("bump-race", "open", { failed_attempts: 1 }) } as never);
    const picked = await row("bump-race");
    await Promise.all([
      g2f.bumpFailedAttempts(picked),
      resolveSubstrateGapWrite({ type: "substrateGap_write", gap: base("bump-race", "closed", { closed_reason: "landed_verified" }) } as never),
    ]);
    const after = await row("bump-race");
    expect(after!.status).toBe("closed");
    expect(after!.reopen_count ?? 0).toBe(0);
  });

  it("both read-modify-write sites send the precondition", () => {
    const src = readFileSync(new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url), "utf8");
    const bump = src.slice(src.indexOf("export async function bumpFailedAttempts"), src.indexOf("shouldNarrowForChronicFailure(fa, meta0)"));
    expect(bump).toContain('expect_status: "open"');
    const rec = src.slice(src.indexOf("export async function recordLineageSpend"));
    expect(rec.slice(0, rec.indexOf("\n}\n"))).toContain('expect_status: "open"');
  });
});
