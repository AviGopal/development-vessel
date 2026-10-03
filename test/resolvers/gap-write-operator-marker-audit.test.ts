// EVERY OPERATOR-MARKED GAP WRITE IS AUDITED WITH ITS CALLER (check-first, 2026-10-03).
//
// The operator marker (pointer-level operator: "operator:<id>") is an explicitness marker, not
// authentication: any writer that sends it gets operator latitude (release a hold, rewrite a closed
// verdict, close a held gap). So every write carrying it must leave a line saying WHO sent it.
//
// CONTRACT: a substrateGap_write carrying the marker emits one "[gap-audit]" line with the gap id, the
// transition (stored status -> written status), the marker, the outcome, and the caller identity the HTTP
// route has: a non-reversible fingerprint of the presented API key (key:sha256:<12 hex>, never the key)
// and the remote address (the x-dv-remote-addr header the server wrapper stamps, after removing any
// inbound copy). A client cannot supply its own identity: the route overwrites _route_caller. No log line
// of any kind contains the key. An in-process write is audited as caller=in-process. A write without the
// marker emits no audit line.
//
// SEAM: the real impulsesRouter; GAP_STORE_ENDPOINT points at a stub holder so the shared module's store
// is never touched. The index.ts wrapper (Bun.serve on import) cannot run under test, so the header stamp
// there is pinned by source inspection, the weaker check.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-write-marker-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { impulsesRouter } = await import("../../src/routes/impulses.js");
const { resolveSubstrateGapWrite } = await import("../../src/resolvers/substrate-gap.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const HOLDER = "http://holder.fixture.invalid/v2/impulses/resolve";
const SECRET = "sk-fixture-SECRET-key-value-7f3a9c";
const FP = "key:sha256:" + createHash("sha256").update(SECRET).digest("hex").slice(0, 12);
const AT = "2026-10-03T10:00:00.000Z";
const OPEN = { id: "audit-fixture-open-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the holder stores", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };
const realFetch = globalThis.fetch;
let lines: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
let savedEndpoint: string | undefined;

const post = (pointer: Record<string, unknown>, headers: Record<string, string> = {}) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ impulse: { pointer } }),
});
const audit = (): string[] => lines.filter((l) => l.includes("[gap-audit]"));

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  lines = [];
  for (const m of ["log", "warn", "error", "info"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== HOLDER) return Response.json({ ok: true });
    const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
    if (p.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: p.id === OPEN.id ? [OPEN] : [], total: 1 } });
    return Response.json({ shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "updated" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("operator-marked gap writes are audited with the caller identity", () => {
  it("[MUST-FAIL] a marked close through the route logs gap, transition, marker, key fingerprint and remote address", async () => {
    const res = await post(
      { type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } },
      { Authorization: `ApiKey ${SECRET}`, "x-dv-remote-addr": "10.1.2.3" },
    );
    expect(res.status).toBe(200);
    const a = audit();
    expect(a).toHaveLength(1);
    expect(a[0]).toContain(`gap=${OPEN.id}`);
    expect(a[0]).toContain("transition=open->closed");
    expect(a[0]).toContain("marker=operator:avi");
    expect(a[0]).toContain(`caller=${FP}`);
    expect(a[0]).toContain("remote=10.1.2.3");
  });

  it("[MUST-FAIL] no log line of any kind contains the API key value", async () => {
    await post(
      { type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } },
      { Authorization: `ApiKey ${SECRET}` },
    );
    expect(audit().length).toBeGreaterThan(0);
    for (const l of lines) expect(l.includes(SECRET)).toBe(false);
  });

  it("[MUST-FAIL] a client-supplied _route_caller is overwritten by the route", async () => {
    await post(
      { type: "substrateGap_write", operator: "operator:avi", _route_caller: { key_fp: "key:sha256:forged", remote: "1.1.1.1" }, gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } },
      { Authorization: `ApiKey ${SECRET}`, "x-dv-remote-addr": "10.1.2.3" },
    );
    const a = audit();
    expect(a).toHaveLength(1);
    expect(a[0]).not.toContain("forged");
    expect(a[0]).not.toContain("1.1.1.1");
    expect(a[0]).toContain(`caller=${FP}`);
  });

  it("[MUST-FAIL] a marked write refused by a gate is audited too, with its outcome", async () => {
    await post(
      { type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: {} } },
      { Authorization: `ApiKey ${SECRET}` },
    );
    const a = audit();
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("outcome=structuredError:close_needs_evidence");
  });

  it("[MUST-FAIL] an in-process marked write is audited as caller=in-process", async () => {
    await resolveSubstrateGapWrite({ type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } } as never);
    const a = audit();
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("caller=in-process");
  });

  it("[MUST-FAIL] the server wrapper stamps x-dv-remote-addr from the socket after deleting any inbound copy", async () => {
    const src = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text();
    const i = src.indexOf('headers.delete("x-dv-remote-addr")');
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf('headers.set("x-dv-remote-addr"', i);
    expect(j).toBeGreaterThan(i);
    expect(src.slice(i, j + 200)).toContain("requestIP");
  });

  it("[CONTROL] a write without the marker emits no audit line", async () => {
    await post({ type: "substrateGap_write", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "condition_gone", closed_by: "fixture" } } }, { Authorization: `ApiKey ${SECRET}` });
    expect(audit()).toHaveLength(0);
  });
});
