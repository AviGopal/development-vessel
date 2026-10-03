// THE WRITE GATES RUN BEFORE A GAP WRITE IS FORWARDED (check-first, 2026-10-03).
//
// A node with GAP_STORE_ENDPOINT set does not hold the gap store: resolveSubstrateGapWrite forwarded the
// pointer to the holder as its FIRST statement, before every gate (metadata type, placeholders, hold, close
// and reject evidence). The holder runs this resolver too, so its own gates still apply when it runs the
// same build; a holder on an older build applies none of them, and the forwarding node never looked.
//
// CONTRACT: with GAP_STORE_ENDPOINT set, the forwarding node runs the stateless gates locally, reads the
// stored row by id from the holder, runs the row-dependent gates (placeholders with the stored-value
// exemption, operator_hold, close/reject evidence) against it, and forwards only a write that passes. A
// holder that cannot be read fails closed (the forward would fail too). The stub below is the holder.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-gates-forward-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-write-gates-forward"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGapWrite } = sg;

const HOLDER = "http://holder.fixture.invalid/v2/impulses/resolve";
const AT = "2026-10-03T10:00:00.000Z";
const realFetch = globalThis.fetch;
const OPEN = { id: "forward-fixture-open-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the holder stores", detected_at: AT, status: "open", classification_metadata: { severity: "high" }, created_at: AT, updated_at: AT };
const HELD = { ...OPEN, id: "forward-fixture-held-gap", classification_metadata: { operator_hold: true } };
const holderRows = [OPEN, HELD];
let writesSeen: Array<Record<string, any>> = [];
let readsSeen = 0;
let holderDown = false;
let savedEndpoint: string | undefined;
const write = (pointer: Record<string, unknown>) => resolveSubstrateGapWrite({ type: "substrateGap_write", ...pointer } as never, { vocabulary: null } as never) as Promise<{ shape: string; body: Record<string, unknown> }>;

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  writesSeen = []; readsSeen = 0; holderDown = false;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== HOLDER) return Response.json({ ok: true });
    if (holderDown) throw new Error("connect ECONNREFUSED");
    const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
    if (p.type === "substrateGap") { readsSeen++; return Response.json({ shape: "substrateGap", body: { gaps: holderRows.filter((g) => g.id === p.id), total: 1 } }); }
    if (p.type === "substrateGap_write") { writesSeen.push(p); return Response.json({ shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "updated" } }); }
    return Response.json({ shape: "structuredError", body: { detail: "unexpected" } });
  }) as unknown as typeof fetch;
});
afterEach(() => { if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint; });
afterAll(() => { globalThis.fetch = realFetch; });

describe("substrateGap_write runs its gates before forwarding to the gap-store holder", () => {
  it("[MUST-FAIL] a placeholder close is refused locally and never forwarded", async () => {
    const r = await write({ gap: { ...OPEN, summary: "{{goal.summary}}", status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "fixture" } } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("no_unrendered_placeholders");
    expect(writesSeen).toHaveLength(0);
  });

  it("[MUST-FAIL] a non-object classification_metadata is refused locally and never forwarded", async () => {
    const r = await write({ gap: { ...OPEN, classification_metadata: "{{goal.classification_metadata}}" } });
    expect(r.shape).toBe("structuredError");
    expect(writesSeen).toHaveLength(0);
  });

  it("[MUST-FAIL] a close with no evidence is refused against the holder's stored row and never forwarded", async () => {
    const r = await write({ gap: { ...OPEN, status: "closed", classification_metadata: {} } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("close_needs_evidence");
    expect(readsSeen).toBe(1);
    expect(writesSeen).toHaveLength(0);
  });

  it("[MUST-FAIL] a reject of a gap the holder stores as held is refused and never forwarded", async () => {
    const r = await write({ gap: { ...HELD, status: "rejected", classification_metadata: { rejected_reason: "x", closed_by: "fixture" } } });
    expect(r.shape).toBe("structuredError");
    expect(r.body["rule"]).toBe("operator_hold");
    expect(writesSeen).toHaveLength(0);
  });

  it("[CONTRACT] when the holder cannot be read the write fails closed and is not forwarded", async () => {
    holderDown = true;
    const r = await write({ gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "fixture" } } });
    expect(r.shape).toBe("structuredError");
    expect(writesSeen).toHaveLength(0);
  });

  it("[CONTROL] a valid close is forwarded to the holder unchanged and its answer returned", async () => {
    const r = await write({ gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "fixture" } } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(writesSeen).toHaveLength(1);
    expect(writesSeen[0]!.gap.id).toBe(OPEN.id);
    expect(writesSeen[0]!.gap.classification_metadata.closed_reason).toBe("condition_gone");
  });

  it("[CONTROL] a valid open write for a new id is forwarded", async () => {
    const r = await write({ gap: { ...OPEN, id: "forward-fixture-new-gap", summary: "a new finding" } });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(writesSeen).toHaveLength(1);
  });
});
