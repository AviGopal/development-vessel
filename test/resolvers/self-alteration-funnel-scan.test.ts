import { describe, it, expect, afterAll } from "bun:test";
import { resolveSelfAlterationFunnelScan } from "../../src/resolvers/self-alteration-funnel-scan.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(tmpdir(), `dev-vessel-funnel-${Date.now()}`);
const proposalsDir = join(root, "proposals");
const vesselsRoot = join(root, "vessels");
const appliedLog = join(root, "mitosis-applied.jsonl");

function reset() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(proposalsDir, { recursive: true });
  mkdirSync(join(proposalsDir, ".applied"), { recursive: true });
  mkdirSync(vesselsRoot, { recursive: true });
}

function call() {
  return resolveSelfAlterationFunnelScan({
    type: "self_alteration_funnel_scan",
    proposalsDir, vesselsRoot, appliedLog,
    dry_run: true, // no network emit
  }) as Promise<{ body: any }>;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("self_alteration_funnel_scan resolver", () => {
  it("flags throughput_zero stuck at APPLY when proposals authored but nothing staged/landed", async () => {
    reset();
    for (let i = 0; i < 6; i++) writeFileSync(join(proposalsDir, `proposal-fix-${i}.json`), "{}");
    const r = await call();
    expect(r.body.funnel).toEqual({ authored: 6, staged: 0, landed: 0, pushed: 0 });
    const f = r.body.findings.find((x: any) => x.subtype === "self_alteration_throughput_zero");
    expect(f).toBeTruthy();
    expect(f.metadata.stuck_stage).toBe("apply");
    expect(f.metadata.cited_evidence[0]).toContain("apply-proposal-as-patch");
  });

  it("localizes throughput_zero to EVALUATE/CUTOVER when staged but not landed", async () => {
    reset();
    for (let i = 0; i < 6; i++) writeFileSync(join(proposalsDir, `proposal-fix-${i}.json`), "{}");
    mkdirSync(join(vesselsRoot, "some-vessel-mitosis-2026-06-17T00-00-00-000Z"), { recursive: true });
    const r = await call();
    expect(r.body.funnel.staged).toBe(1);
    const f = r.body.findings.find((x: any) => x.subtype === "self_alteration_throughput_zero");
    expect(f.metadata.stuck_stage).toBe("evaluate_or_cutover");
  });

  it("does NOT flag throughput_zero on a healthy pipeline (authored + staged + landed)", async () => {
    reset();
    for (let i = 0; i < 6; i++) writeFileSync(join(proposalsDir, `proposal-fix-${i}.json`), "{}");
    mkdirSync(join(vesselsRoot, "v-mitosis-2026-06-17T00-00-00-000Z"), { recursive: true });
    writeFileSync(appliedLog, JSON.stringify({ body: { applied_at: new Date().toISOString(), push_status: "pushed" } }) + "\n");
    const r = await call();
    expect(r.body.funnel.staged).toBe(1);
    expect(r.body.funnel.landed).toBe(1);
    expect(r.body.findings.find((x: any) => x.subtype === "self_alteration_throughput_zero")).toBeUndefined();
  });

  it("flags stale_proposal_backlog when backlog is large and mostly stale", async () => {
    reset();
    for (let i = 0; i < 80; i++) writeFileSync(join(proposalsDir, `mitosis_freshness_violation-x-${i}-report.json`), "{}");
    for (let i = 0; i < 40; i++) writeFileSync(join(proposalsDir, `proposal-real-${i}.json`), "{}");
    const r = await call();
    const f = r.body.findings.find((x: any) => x.subtype === "stale_proposal_backlog");
    expect(f).toBeTruthy();
    expect(r.body.backlog_size).toBe(120);
    expect(r.body.stale_backlog).toBe(80);
  });
});
