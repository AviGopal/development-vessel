// THE NODE'S OWN KEY AUTHENTICATES WITHOUT IDENTITY (check-first, 2026-10-03).
//
// Availability (qa R1). The write gate asks identity-vessel about every key. On a node whose identity is
// remote (a spoke whose IDENTITY_VESSEL_URL is the hub's) an identity outage refuses the node's OWN writes,
// so its self-maintenance gaps, pool rhythms and memory notes 401 exactly when something is wrong.
//
// CONTRACT pinned here:
//   - The presented key is compared in constant time against this process's METABOB_API_KEY. A match is
//     {authenticated:true, scopes:["node"], keyId:"node-self"} and identity is NOT asked (identity up or
//     down; a fetch counter proves no call).
//   - Every other key still goes to identity, and still fails closed (401) when identity is unreachable,
//     including a key of the same length as the node key. With METABOB_API_KEY unset nothing is node-self.
//   - The [gap-audit] line names a node-self write distinctly: caller=authenticated:node-self.
//   - Identity unreachable is logged LOUDLY ("[caller-credential] IDENTITY UNREACHABLE"), at most once per
//     60 s window, and no log line carries the key or any 8+ char sha256 or sha1 prefix of it.
//
// SEAM: identity-vessel and the gap-store holder are globalThis.fetch stubs that count calls; the identity
// URL is a loopback literal; Date.now is stubbed for the log window. The real impulsesRouter is imported
// past topology-chain's module mock.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `caller-credential-node-self-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"node-self"}`);
const cc = await import("../../src/lib/caller-credential.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { identityCredential, __resetCredentialCacheForTests } = cc;

const IDENTITY = "http://127.0.0.1:59101";
const HOLDER = "http://127.0.0.1:59090/v2/impulses/resolve";
const NODE_KEY = "mb-node-self-fixture-key-3c9e51d7a0";
const SAME_LENGTH_OTHER = "mb-node-self-fixture-key-3c9e51d7a1";
const OTHER_KEY = "mb-other-valid-looking-key";
const AT = "2026-10-03T10:00:00.000Z";
const OPEN = { id: "node-self-fixture-gap", category: "systematic_failure", source: "human_reported", summary: "an open gap the holder stores", detected_at: AT, status: "open", classification_metadata: {}, created_at: AT, updated_at: AT };

const realFetch = globalThis.fetch;
let identityMode: "up" | "down" = "up";
let identityCalls = 0;
let storeWrites: Array<Record<string, any>> = [];
let lines: string[] = [];
let violations: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityMode = "up"; identityCalls = 0; storeWrites = []; lines = []; violations = [];
  __resetCredentialCacheForTests();
  for (const m of ["log", "warn", "error", "info", "debug"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      identityCalls++;
      if (identityMode === "down") throw new TypeError("Unable to connect");
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      if (key === OTHER_KEY || key === SAME_LENGTH_OTHER) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u === HOLDER) {
      const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
      if (p.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: p.id === OPEN.id ? [OPEN] : [], total: 1 } });
      storeWrites.push(p);
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
  headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}`, "x-dv-remote-addr": "127.0.0.1" },
  body: JSON.stringify({ impulse: { pointer: markedClose } }),
});
const loud = (): string[] => lines.filter((l) => l.includes("[caller-credential] IDENTITY UNREACHABLE"));

describe("node-self: the node own key authenticates without identity", () => {
  it("node-self MUST-FAIL identity down and the node own key: the write is accepted and audited as node-self", async () => {
    identityMode = "down";
    const res = await post(NODE_KEY);
    expect(res.status).toBe(200);
    expect(storeWrites.map((w) => w.gap?.id)).toEqual([OPEN.id]);
    const audit = lines.filter((l) => l.includes("[gap-audit]"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain("caller=authenticated:node-self");
    expect(identityCalls).toBe(0);
    for (const l of lines) expect(leaks(l, NODE_KEY)).toEqual([]);
  });

  it("node-self MUST-FAIL identity up and the node own key: node-self locally, identity never asked", async () => {
    const cred = await identityCredential(`ApiKey ${NODE_KEY}`);
    expect(cred).toEqual({ authenticated: true, scopes: ["node"], keyId: "node-self" });
    const again = await identityCredential(`ApiKey ${NODE_KEY}`, { cache: false });
    expect(again.keyId).toBe("node-self");
    expect(identityCalls).toBe(0);
  });

  it("node-self control identity down and any other valid-looking key is refused 401", async () => {
    identityMode = "down";
    expect((await post(OTHER_KEY)).status).toBe(401);
    expect((await post(SAME_LENGTH_OTHER)).status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("node-self control identity up and another key still goes to identity", async () => {
    const res = await post(OTHER_KEY);
    expect(res.status).toBe(200);
    expect(identityCalls).toBe(1);
    expect(lines.find((l) => l.includes("[gap-audit]"))).toContain("caller=authenticated:read,write");
  });

  it("node-self control with METABOB_API_KEY unset no key is node-self", async () => {
    delete process.env["METABOB_API_KEY"];
    identityMode = "down";
    expect((await post(NODE_KEY)).status).toBe(401);
    expect(identityCalls).toBe(1);
  });

  it("node-self MUST-FAIL identity unreachable is logged loudly at most once per 60 s window and without key material", async () => {
    let now = 5_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      identityMode = "down";
      await post(OTHER_KEY);
      await post(OTHER_KEY);
      now += 30_000;
      await post(OTHER_KEY);
      expect(loud()).toHaveLength(1);
      now += 30_001;
      await post(OTHER_KEY);
      expect(loud()).toHaveLength(2);
      for (const l of lines) { expect(leaks(l, OTHER_KEY)).toEqual([]); expect(leaks(l, NODE_KEY)).toEqual([]); }
    } finally {
      clock.mockRestore();
    }
  });
});
