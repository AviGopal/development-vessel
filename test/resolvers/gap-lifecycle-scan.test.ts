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

// ONLY THE STORE HOLDER WRITES (2026-10-01): node 2 ran this scan from a stale local copy and its
// closures were forwarded to the hub, closing 104 live gaps in one run, 84 of them under 2 days old.
describe("gap_lifecycle_scan on a node whose gap store is held elsewhere", () => {
  const STALE = new Date(Date.now() - 400 * 3_600_000).toISOString();
  const many = () => Array.from({ length: 60 }, (_, i) => ({ id: `gap:stale-${i}`, category: "architectural_pattern", status: "open", created_at: STALE, updated_at: STALE }));
  async function writesWith(endpoint: string | undefined): Promise<{ writes: number; body: any }> {
    const saved = process.env["GAP_STORE_ENDPOINT"];
    const realFetch = globalThis.fetch;
    let writes = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.impulse?.pointer?.type === "substrateGap_write") writes++;
      return Response.json({ shape: "substrateGapWriteResult", body: { action: "updated" } });
    }) as unknown as typeof fetch;
    if (endpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = endpoint;
    try {
      seed(many());
      // the scan appends its funnel history under <WORKSPACE_ROOT>/gaps (a scratch root in tests)
      mkdirSync(join(process.env["WORKSPACE_ROOT"] ?? root, "gaps"), { recursive: true });
      const r = await resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath, proposalsDir, staleHours: 48, autoClose: true, maxClose: 25, falsify: false, devVesselImpulsesUrl: "http://store.test/v2/impulses/resolve" } as never) as { body: any };
      return { writes, body: r.body };
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = saved;
    }
  }
  it("writes nothing to the store (no close, no expiry, no backlog meta-gap) and says why", async () => {
    const r = await writesWith("http://holder.test/v2/impulses/resolve");
    expect(r.writes).toBe(0);
    expect(r.body.writes_skipped).toContain("GAP_STORE_ENDPOINT");
    expect(r.body.open).toBe(60);
  });
  it("positive control: the holder (no GAP_STORE_ENDPOINT) does write", async () => {
    const r = await writesWith(undefined);
    expect(r.writes).toBeGreaterThan(0);
    expect(r.body.writes_skipped).toBeNull();
  });
});
