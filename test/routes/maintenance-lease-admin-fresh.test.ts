// THE UNNAMED GLOBAL HOLD'S ADMIN IS ASKED FRESH (routes/impulses.ts leaseCallerStamp).
//
// The unnamed maintenance hold excludes every name and pauses the trace-store readers; node-self or an admin key takes
// it (resolvers/maintenance-lease.ts). The write gate validates a key through identityCredential's 60 s positive cache,
// so a key whose admin scope identity has revoked would keep taking the hold for up to that long. Revocation must
// bite at once on a coordination primitive: the admin determination asks identity again, with cache:false.
//
// SEAMS. identity-vessel is stood in for by globalThis.fetch (as in resolve-route-write-auth.test.ts); it answers the
// admin key with the admin scope until `revoked` is set, then with read/write only. The lease file is this file's
// own. Any other network call is recorded as a violation and fails the test.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { __resetCredentialCacheForTests } from "../../src/lib/caller-credential.js";
import { __resetMaintenanceLeaseCacheForTests } from "../../src/resolvers/http-retry.js";

const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"lease-admin-fresh"}`);

const dir = join(tmpdir(), `dev-vessel-lease-admin-fresh-${process.pid}-${Date.now()}`);
process.env["MAINTENANCE_LEASE_PATH"] = join(dir, "maintenance.json");

const IDENTITY = "http://127.0.0.1:59108";
const ADMIN_KEY = "lease-admin-fresh-admin-key-fixture";
const OTHER_ADMIN_KEY = "lease-admin-fresh-other-admin-key-fixture";

const originalFetch = globalThis.fetch;
let revoked = false;
let identityCalls = 0;
let violations: string[] = [];

function installStubs(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = (() => { try { return JSON.parse(String(init?.body ?? "{}")); } catch { return {}; } })();
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      identityCalls++;
      const key = body?.impulse?.pointer?.apiKey;
      if (key === ADMIN_KEY) {
        return Response.json({ success: true, data: { authenticated: true, keyId: "adminkey0001", scopes: revoked ? ["read", "write"] : ["read", "write", "admin"] } });
      }
      if (key === OTHER_ADMIN_KEY) {
        return Response.json({ success: true, data: { authenticated: true, keyId: "adminkey0002", scopes: ["read", "write", "admin"] } });
      }
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

let saved: Record<string, string | undefined> = {};
let warnSpy: ReturnType<typeof spyOn> | null = null;
let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  saved = { IDENTITY_VESSEL_URL: process.env["IDENTITY_VESSEL_URL"], METABOB_API_KEY: process.env["METABOB_API_KEY"] };
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  delete process.env["METABOB_API_KEY"]; // no key is node-self here
  revoked = false;
  identityCalls = 0;
  violations = [];
  __resetCredentialCacheForTests();
  installStubs();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  warnSpy?.mockRestore();
  logSpy?.mockRestore();
  __resetCredentialCacheForTests();
  expect(violations).toEqual([]);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetMaintenanceLeaseCacheForTests();
});

type Answer = { success?: boolean; body?: Record<string, unknown> };
const lease = async (key: string, pointer: Record<string, unknown>): Promise<Answer> =>
  (await (await impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { pointer: { type: "maintenanceLease_write", ...pointer } } }),
  })).json()) as Answer;

describe("the unnamed global hold: admin is asked fresh", () => {
  it("MUST-FAIL: an admin key whose admin scope is revoked is refused the unnamed hold, though its validation is cached", async () => {
    const first = await lease(ADMIN_KEY, { op: "acquire", holder: "manual-db-work", ttl_ms: 600_000 });
    expect(first.body?.["acquired"]).toBe(true);
    await lease(ADMIN_KEY, { op: "release", token: first.body?.["token"] });
    revoked = true; // identity now answers this key without the admin scope; the write gate still holds it cached
    const callsBefore = identityCalls;
    const r = await lease(ADMIN_KEY, { op: "acquire", holder: "manual-db-work", ttl_ms: 600_000 });
    if (r.body?.["token"]) await lease(OTHER_ADMIN_KEY, { op: "release", token: r.body["token"] });
    expect(r.body?.["acquired"]).not.toBe(true);
    expect(r.body?.["error"]).toBe("global_lease_requires_node_self_or_admin");
    expect(identityCalls).toBeGreaterThan(callsBefore);
  });

  it("CONTROL: a key that is admin now takes and releases the unnamed hold", async () => {
    const own = await lease(OTHER_ADMIN_KEY, { op: "acquire", holder: "manual-db-work", ttl_ms: 600_000 });
    expect(own.body?.["acquired"]).toBe(true);
    expect((await lease(OTHER_ADMIN_KEY, { op: "release", token: own.body?.["token"] })).body?.["released"]).toBe(true);
  });
});
