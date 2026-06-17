import { describe, it, expect, afterAll } from "bun:test";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(tmpdir(), `dev-vessel-gaplife-${Date.now()}`);
const gapsPath = join(root, "gaps.json");
const proposalsDir = join(root, "proposals");
const OLD = new Date(Date.now() - 100 * 3_600_000).toISOString(); // 100h ago
const NOW = new Date().toISOString();

function seed(gaps: any[], failedSentinels: string[] = []) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(proposalsDir, { recursive: true });
  mkdirSync(join(proposalsDir, ".applied"), { recursive: true });
  writeFileSync(gapsPath, JSON.stringify(gaps));
  for (const s of failedSentinels) writeFileSync(join(proposalsDir, ".applied", `${s}-report.json`), JSON.stringify({ outcome_shape: "structuredError" }));
}
const call = () => resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath, proposalsDir, staleHours: 48, dry_run: true }) as Promise<{ body: any }>;
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gap_lifecycle_scan resolver", () => {
  it("flags a churned gap: open + stale + a failed-apply sentinel", async () => {
    seed([{ id: "gap:stuck-1", category: "architectural_pattern", status: "open", updated_at: OLD }], ["gap-stuck-1"]);
    const r = await call();
    expect(r.body.open).toBe(1);
    expect(r.body.stale_open).toBe(1);
    expect(r.body.churned).toBe(1);
  });

  it("does NOT flag a fresh open gap as stale", async () => {
    seed([{ id: "gap:fresh-1", category: "other", status: "open", updated_at: NOW }]);
    const r = await call();
    expect(r.body.stale_open).toBe(0);
    expect(r.body.churned).toBe(0);
  });

  it("counts stale-open but not churned when no failed sentinel exists", async () => {
    seed([{ id: "gap:old-undrafted", category: "activity_lifecycle", status: "open", updated_at: OLD }]);
    const r = await call();
    expect(r.body.stale_open).toBe(1);
    expect(r.body.churned).toBe(0);
  });

  it("ignores closed gaps", async () => {
    seed([{ id: "gap:done", category: "other", status: "closed", updated_at: OLD }]);
    const r = await call();
    expect(r.body.open).toBe(0);
    expect(r.body.stale_open).toBe(0);
  });
});
