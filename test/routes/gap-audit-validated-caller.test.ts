// THE GAP-WRITE AUDIT NAMES THE CALLER THE WRITE GATE VALIDATED (check-first, 2026-10-03).
//
// gapseam's [gap-audit] line labels its caller with callerAuthLabel(auth result) (routes/caller-identity.ts),
// but the route passed no auth result, so even after the write gate (lib/caller-credential.ts) validated the
// caller through identity-vessel, every operator-marked gap write was audited caller=unauthenticated.
//
// CONTRACT: an authenticated substrateGap_write carrying the operator marker yields a [gap-audit] line whose
// caller is the identity the gate validated: the key id when identity's answer carries one, else the
// scopes. Never "unauthenticated", and no log line, response body or forwarded pointer contains the key, its
// sha256 or sha1 hex, or any prefix of either of 8+ characters.
//
// SEAM: the real impulsesRouter (query-string import past topology-chain's module mock); identity-vessel
// and the gap-store holder (GAP_STORE_ENDPOINT) are globalThis.fetch stubs; any other call fails the test.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-audit-validated-caller-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-audit-validated-caller"}`);
const { __resetCredentialCacheForTests } = await import("../../src/lib/caller-credential.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59106";
const HOLDER = "http://holder.validated-caller.invalid/v2/impulses/resolve";
const SCOPED_KEY = "sk-fixture-validated-caller-scoped-5e21";
const KEYED_KEY = "sk-fixture-validated-caller-keyed-77c0";
const AT = "2026-10-03T10:00:00.000Z";
const OPEN = { id: "validated-caller-fixture-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the holder stores", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };

const realFetch = globalThis.fetch;
let lines: string[] = [];
let forwarded: string[] = [];
let violations: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  delete process.env["METABOB_API_KEY"];
  lines = []; forwarded = []; violations = [];
  __resetCredentialCacheForTests();
  for (const m of ["log", "warn", "error", "info", "debug"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      if (key === SCOPED_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", scopes: ["read", "write"] } });
      if (key === KEYED_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "key_fixture42", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u === HOLDER) {
      forwarded.push(String(init?.body ?? ""));
      const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
      if (p.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: p.id === OPEN.id ? [OPEN] : [], total: 1 } });
      return Response.json({ shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "updated" } });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(violations).toEqual([]);
});

function forbidden(key: string): string[] {
  const out = [key];
  for (const alg of ["sha256", "sha1"]) {
    const hex = createHash(alg).update(key).digest("hex");
    for (let n = 8; n <= hex.length; n++) out.push(hex.slice(0, n));
  }
  return out;
}
const leaks = (text: string, key: string): string[] => { const t = text.toLowerCase(); return forbidden(key).filter((n) => t.includes(n.toLowerCase())).slice(0, 3); };

const markedClose = { type: "substrateGap_write", operator: "operator:avi", gap: { ...OPEN, status: "closed", classification_metadata: { closed_reason: "superseded_by_landing" } } };
const post = (key: string) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}`, "x-dv-remote-addr": "10.4.5.6" },
  body: JSON.stringify({ impulse: { pointer: markedClose } }),
});

describe("gap-audit names the caller the write gate validated", () => {
  it("validated-caller MUST-FAIL an authenticated marked gap write is audited with its scopes, not unauthenticated, and leaks no key material", async () => {
    // Positive control on the leak detector: a planted 8-char sha256 prefix is found.
    expect(leaks(`x ${createHash("sha256").update(SCOPED_KEY).digest("hex").slice(0, 8)}`, SCOPED_KEY).length).toBeGreaterThan(0);
    const res = await post(SCOPED_KEY);
    expect(res.status).toBe(200);
    const body = await res.text();
    const audit = lines.filter((l) => l.includes("[gap-audit]"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).not.toContain("caller=unauthenticated");
    expect(audit[0]).toContain("caller=authenticated:read,write");
    for (const text of [...lines, body, ...forwarded]) expect(leaks(text, SCOPED_KEY)).toEqual([]);
  });

  it("validated-caller MUST-FAIL when identity answers with a key id the audit names that id and leaks no key material", async () => {
    await post(KEYED_KEY);
    const audit = lines.filter((l) => l.includes("[gap-audit]"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain("caller=authenticated:key_id:key_fixture42");
    const write = forwarded.map((f) => JSON.parse(f)?.impulse?.pointer).find((p) => p?.type === "substrateGap_write");
    expect(write?._route_caller).toEqual({ auth: "authenticated:key_id:key_fixture42", remote: "10.4.5.6" });
    for (const text of [...lines, ...forwarded]) expect(leaks(text, KEYED_KEY)).toEqual([]);
  });

  it("validated-caller control an unauthenticated marked gap write never reaches the audit or the holder", async () => {
    const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: markedClose } }) });
    expect(res.status).toBe(401);
    expect(lines.filter((l) => l.includes("[gap-audit]"))).toHaveLength(0);
    expect(forwarded).toEqual([]);
  });
});
