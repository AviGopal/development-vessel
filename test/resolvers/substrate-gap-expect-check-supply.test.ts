// A CONDITIONAL WRITE ON THE CHECK-SUPPLY LEDGER (expect_check_supply, 2026-10-23).
//
// The gap store's only conditional write compared the row's status (expect_status). Two nodes' supplies dispatched one
// row (10-21 19:10-19:11Z, lifecycle-expiry-closes-armed-gaps-...): compose2 sent its goal and recorded dispatch
// 8545c2bc; node1, which had read the row before that record, wrote its own intent and then its BUSY non-attempt over
// it, so the ledger named node1's refused dispatch and compose2's live compose was orphaned.
//
// THE CONTRACT: a write carrying expect_check_supply { state, dispatch_id, last_dispatch_at } is applied only if the
// stored ledger still has exactly those (absent or empty = null), checked under the store lock; otherwise nothing is
// written and the answer is a typed no-op (check_supply_precondition_failed). On a node that forwards its store the
// pointer goes through gateThenForward unchanged and the holder decides. CONTROL: a write whose expectation matches is
// applied; a write without expect_check_supply behaves exactly as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `sg-expect-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const HOLDER = "http://holder.expect-cs.test/v2/impulses/resolve";
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const originalFetch = globalThis.fetch;
let forwarded: Row[] = [];
let gapStore: { restore: () => Promise<void> } | null = null;

async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try { return await fn(); } finally { if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was; }
}
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  mkdirSync(join(sg.gapStoreRootForTest(), "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (url !== HOLDER) return Response.json({ body: { impulses: [] } });
    const p = (JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {}) as Row;
    if (p["type"] === "substrateGap_write") forwarded.push(p);
    const r = await asHolder(async () => (p["type"] === "substrateGap" ? sg.resolveSubstrateGap(p as never) : sg.resolveSubstrateGapWrite(p as never)));
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    return Response.json(r);
  }) as unknown as typeof fetch;
});
afterAll(async () => {
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { forwarded = []; delete process.env["GAP_STORE_ENDPOINT"]; });

const SUMMARY = `expect-cs fixture ${RUN}: an armed check is measuring a gap the lifecycle expiry closes as expired`;
const gapOf = (id: string, cs: Row): Row => ({ id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary: SUMMARY, classification_metadata: { check_supply: cs } });
async function write(id: string, cs: Row, expectCs?: Row): Promise<{ shape: string; body: Row }> {
  const r = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: gapOf(id, cs), ...(expectCs ? { expect_check_supply: expectCs } : {}) } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r as never;
}
async function ledger(id: string): Promise<Row> {
  const r = await asHolder(() => sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never));
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  return ((row?.["classification_metadata"] as Row | undefined)?.["check_supply"] ?? {}) as Row;
}
// The instance's ledgers: the row as both nodes read it, the winner's sent record, the loser's intent and non-attempt.
const READ: Row = { state: "dispatch_failed", attempts: 1, dispatch_id: "d-earlier", dispatch_node: "substrate", last_dispatch_at: "2026-10-21T15:00:00.000Z" };
const WINNER: Row = { state: "goal_dispatched", attempts: 2, dispatch_id: "8545c2bc", dispatch_node: "compose2", last_dispatch_at: "2026-10-21T19:10:54.000Z", goal: "Write ONE failing test" };
const LOSER_INTENT: Row = { state: "send_pending", attempts: 2, dispatch_id: null, dispatch_node: "substrate", last_dispatch_at: "2026-10-21T19:11:30.000Z" };
const LOSER_BUSY: Row = { ...LOSER_INTENT, state: "non_attempt", dispatch_id: "ca933d6b", attempts: 1, reason: "send not taken (non-attempt): BUSY" };
const expectOf = (l: Row): Row => ({ state: l["state"] ?? null, dispatch_id: l["dispatch_id"] ?? null, last_dispatch_at: l["last_dispatch_at"] ?? null });

describe("expect_check_supply: the stored ledger must be the one the writer read", () => {
  it("[MUST-FAIL] the losing node's intent, expecting the row as it read it, is refused after the winner recorded its dispatch, and the winner's id stays", async () => {
    const id = `sg-expect-cs-intent-${RUN}`;
    await write(id, READ);
    await write(id, WINNER, expectOf(READ)); // the winner read the same row and wrote first
    const r = await write(id, LOSER_INTENT, expectOf(READ));
    expect(r.shape).toBe("structuredError");
    expect(r.body["skip_reason"]).toBe("check_supply_precondition_failed");
    expect((await ledger(id))["dispatch_id"]).toBe("8545c2bc");
  });

  it("[MUST-FAIL] the losing node's BUSY non-attempt, expecting its own intent, is refused once the winner's record is stored", async () => {
    const id = `sg-expect-cs-busy-${RUN}`;
    await write(id, READ);
    await write(id, WINNER);
    const r = await write(id, LOSER_BUSY, expectOf(LOSER_INTENT));
    expect(r.shape).toBe("structuredError");
    expect(r.body["skip_reason"]).toBe("check_supply_precondition_failed");
    expect((await ledger(id))).toMatchObject({ state: "goal_dispatched", dispatch_id: "8545c2bc", dispatch_node: "compose2" });
  });

  it("[MUST-FAIL] on a node that forwards its store the pointer is forwarded unchanged, and the holder refuses it", async () => {
    const id = `sg-expect-cs-fwd-${RUN}`;
    await write(id, READ);
    await write(id, WINNER);
    process.env["GAP_STORE_ENDPOINT"] = HOLDER;
    const r = await write(id, LOSER_BUSY, expectOf(LOSER_INTENT));
    expect(forwarded.some((p) => JSON.stringify(p["expect_check_supply"]) === JSON.stringify(expectOf(LOSER_INTENT)))).toBe(true);
    expect(r.shape).toBe("structuredError");
    expect(r.body["skip_reason"]).toBe("check_supply_precondition_failed");
    expect((await ledger(id))["dispatch_id"]).toBe("8545c2bc");
  });

  it("[CONTROL] a lone node's BUSY non-attempt, expecting its own intent as stored, is recorded", async () => {
    const id = `sg-expect-cs-lone-${RUN}`;
    await write(id, READ);
    expect((await write(id, LOSER_INTENT, expectOf(READ))).shape).toBe("substrateGapWriteResult");
    expect((await write(id, LOSER_BUSY, expectOf(LOSER_INTENT))).shape).toBe("substrateGapWriteResult");
    expect((await ledger(id))).toMatchObject({ state: "non_attempt", dispatch_id: "ca933d6b" });
  });

  it("[CONTROL] a write without expect_check_supply behaves as before: it is applied over whatever is stored", async () => {
    const id = `sg-expect-cs-plain-${RUN}`;
    await write(id, READ);
    await write(id, WINNER);
    expect((await write(id, LOSER_BUSY)).shape).toBe("substrateGapWriteResult");
    expect((await ledger(id))["dispatch_id"]).toBe("ca933d6b");
  });

  it("[CONTROL] an expectation of an absent ledger (all null) matches a row with none", async () => {
    const id = `sg-expect-cs-none-${RUN}`;
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...gapOf(id, {}), classification_metadata: {} } } as never);
    expect((await write(id, LOSER_INTENT, { state: null, dispatch_id: null, last_dispatch_at: null })).shape).toBe("substrateGapWriteResult");
  });
});
