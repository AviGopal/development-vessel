// NO VALUE DERIVED FROM THE PRESENTED KEY IN ANY AUDIT LINE, ROUTE STAMP OR ROW (check-first, 2026-10-03).
//
// Standing constraint (qa): a hash, digest or prefix of a secret is linkable across logs and, for a
// low-entropy or leaked key, a confirm-oracle. The gap-write audit stamped key:sha256:<12 hex> of the
// presented API key into _route_caller and the [gap-audit] line.
//
// CONTRACT: the route stamps the identity that VALIDATED the request when an auth result carries one
// (key id or name; authenticated:<scope> when it carries only a scope), else "unauthenticated", plus the
// socket remote address. This resolve route has no caller authentication yet, so today every request is
// stamped unauthenticated. No [gap-audit] line, no other log line, no _route_caller, and no stored or
// forwarded row contains the key, its sha256 or sha1 hex, or any prefix of either of 8+ characters.
//
// SEAM: the real impulsesRouter (query-string import past topology-chain's module mock); GAP_STORE_ENDPOINT
// points at a stub holder that records every forwarded pointer.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-audit-no-key-derivative-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-audit-no-key-derivative"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const HOLDER = "http://holder.fixture.invalid/v2/impulses/resolve";
const SECRET = "sk-fixture-another-SECRET-4d1e88b2";
const AT = "2026-10-03T10:00:00.000Z";
const OPEN = { id: "audit-nokey-fixture-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the holder stores", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };
const realFetch = globalThis.fetch;

/** Every forbidden needle: the key itself and each 8+ char prefix of its sha256 and sha1 hex. */
function forbidden(): string[] {
  const out = [SECRET];
  for (const alg of ["sha256", "sha1"]) {
    const hex = createHash(alg).update(SECRET).digest("hex");
    for (let n = 8; n <= hex.length; n++) out.push(hex.slice(0, n));
  }
  return out;
}
const leaks = (text: string): string[] => { const t = text.toLowerCase(); return forbidden().filter((n) => t.includes(n.toLowerCase())); };

let lines: string[] = [];
let forwarded: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
let savedEndpoint: string | undefined;
const post = (pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `ApiKey ${SECRET}`, "x-dv-remote-addr": "10.9.8.7" },
  body: JSON.stringify({ impulse: { pointer } }),
});

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  lines = []; forwarded = [];
  for (const m of ["log", "warn", "error", "info"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== HOLDER) return Response.json({ ok: true });
    forwarded.push(String(init?.body ?? ""));
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

describe("the gap-write audit carries no value derived from the presented key", () => {
  it("[MUST-FAIL] no audit line, log line or forwarded pointer contains the key or a sha256 or sha1 prefix of it", async () => {
    await post({ type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } });
    const audit = lines.filter((l) => l.includes("[gap-audit]"));
    expect(audit).toHaveLength(1);
    for (const l of lines) expect(leaks(l)).toEqual([]);
    expect(forwarded.length).toBeGreaterThan(0);
    for (const f of forwarded) expect(leaks(f)).toEqual([]);
  });

  it("[MUST-FAIL] the route stamps unauthenticated, since this route has no caller authentication", async () => {
    await post({ type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } });
    const write = forwarded.map((f) => JSON.parse(f)?.impulse?.pointer).find((p) => p?.type === "substrateGap_write");
    expect(write?._route_caller).toEqual({ auth: "unauthenticated", remote: "10.9.8.7" });
    const audit = lines.find((l) => l.includes("[gap-audit]"))!;
    expect(audit).toContain("caller=unauthenticated");
  });

  it("[CONTROL] the audit line carries the socket remote address", async () => {
    await post({ type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } });
    expect(lines.find((l) => l.includes("[gap-audit]"))).toContain("remote=10.9.8.7");
  });

  it("[CONTRACT] an auth result names the validating key id or name, or only its scope, and never the key", async () => {
    const { callerAuthLabel } = await import("../../src/routes/caller-identity.js");
    expect(callerAuthLabel(undefined)).toBe("unauthenticated");
    expect(callerAuthLabel({ authenticated: false })).toBe("unauthenticated");
    expect(callerAuthLabel({ authenticated: true, key_id: "key_42" })).toBe("authenticated:key_id:key_42");
    expect(callerAuthLabel({ authenticated: true, key_name: "cockpit" })).toBe("authenticated:key_name:cockpit");
    expect(callerAuthLabel({ authenticated: true, scopes: ["read", "write"] })).toBe("authenticated:read,write");
    expect(callerAuthLabel({ authenticated: true })).toBe("authenticated");
  });
});
