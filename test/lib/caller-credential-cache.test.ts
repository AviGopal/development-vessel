// THE CREDENTIAL CACHE IS INTERNAL AND BOUNDED (check-first, 2026-10-03).
//
// lib/caller-credential.ts keeps successful identity validations in memory, keyed by a SHA-256 of
// the presented key, so the write gate does not ask identity on every request. That cache was
// accepted on four conditions, pinned here:
//   1. The digest never leaves process memory: no log line, no response body (refusals included),
//      no /health or /metrics body carries the key, its SHA-256 or SHA-1, or any 8+ char prefix of
//      either. This vessel serves no /metrics route and its /health handler (src/index.ts) is built
//      without the credential module, which keeps its cache private and exports no accessor;
//      index.ts cannot be imported in a test (it starts the server and the observers), so that
//      half is pinned on the source and the module's runtime exports.
//   2. Bounded: entries live at most the TTL (60 s) and the map holds at most
//      CREDENTIAL_CACHE_MAX_ENTRIES, evicting the oldest validation first. Negative answers are
//      never cached.
//   3. Revocation lag is at most the TTL: a key identity revokes is still accepted from cache
//      inside the TTL and refused after it.
// identity-vessel is a globalThis.fetch stub that counts its calls; the count is how "cached" and
// "evicted" are observed without any accessor that could expose a digest.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cc = await import("../../src/lib/caller-credential.js");
const { identityCredential, __resetCredentialCacheForTests } = cc;
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"credential-cache-isolated"}`);

const SRC = join(import.meta.dir, "..", "..", "src");
const IDENTITY = "http://identity.credential-cache.test:8101";
const GAP_STORE = "http://gapstore.credential-cache.test:8090/v2/impulses/resolve";
const KNOWN_KEY = "credential-cache-known-test-key-0123456789";

const originalFetch = globalThis.fetch;
let identityMode: "up" | "down" | "error" = "up";
let revoked = new Set<string>();
let identityCalls: string[] = [];
let violations: string[] = [];
let captured: string[] = [];

function installStubs(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = (() => { try { return JSON.parse(String(init?.body ?? "{}")); } catch { return {}; } })();
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = String(body?.impulse?.pointer?.apiKey ?? "");
      identityCalls.push(key);
      if (identityMode === "down") throw new TypeError("Unable to connect");
      if (identityMode === "error") return new Response("boom", { status: 500 });
      if (key.startsWith("credential-cache-") && !key.includes("forged") && !revoked.has(key)) {
        return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k", scopes: ["read", "write"] } });
      }
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u === GAP_STORE) return Response.json({ shape: "substrateGap_write", body: { ok: true } });
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

const saved: Record<string, string | undefined> = {};
const spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "GAP_STORE_ENDPOINT", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["GAP_STORE_ENDPOINT"] = GAP_STORE;
  delete process.env["METABOB_API_KEY"];
  identityMode = "up";
  revoked = new Set();
  identityCalls = [];
  violations = [];
  captured = [];
  __resetCredentialCacheForTests();
  installStubs();
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { captured.push(a.map(String).join(" ")); }));
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  while (spies.length) spies.pop()!.mockRestore();
  expect(violations).toEqual([]);
});

/** Every string that would identify the key: the key, its sha256 and sha1 hex, and each 8+ char prefix of the digests. */
function forbiddenFor(key: string): string[] {
  const out = [key];
  for (const alg of ["sha256", "sha1"]) {
    const hex = createHash(alg).update(key).digest("hex");
    for (let n = 8; n <= hex.length; n++) out.push(hex.slice(0, n));
  }
  return out;
}
function leaks(text: string, key: string): string[] {
  const t = text.toLowerCase();
  return forbiddenFor(key).filter((f) => t.includes(f.toLowerCase())).slice(0, 3);
}
const gap = (id: string) => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `credential-cache fixture ${id}`, detected_at: "2026-10-03T00:00:00Z" });
const post = (auth: string, path = "/v2/impulses/resolve", body: unknown = { impulse: { pointer: { type: "substrateGap_write", gap: gap("cc") } } }) =>
  impulsesRouter.request(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) });

describe("credential cache condition 1: the digest never leaves process memory", () => {
  it("credential-cache no log line and no response body carries the key or any digest prefix of it", async () => {
    // Positive control on the detector itself: a planted digest prefix and the raw key are found.
    expect(leaks(`cache ${createHash("sha256").update(KNOWN_KEY).digest("hex").slice(0, 8)}`, KNOWN_KEY).length).toBeGreaterThan(0);
    expect(leaks(`sha1 ${createHash("sha1").update(KNOWN_KEY).digest("hex").slice(0, 12)}`, KNOWN_KEY).length).toBeGreaterThan(0);
    const bodies: string[] = [];
    const collect = async (r: Response) => { bodies.push(await r.text()); };
    await collect(await post(`ApiKey ${KNOWN_KEY}`));
    await collect(await post(`ApiKey ${KNOWN_KEY}`));
    await collect(await post(`ApiKey ${KNOWN_KEY}`, "/resolvers/execute", { resolver: "substrateGap_write", config: { gap: gap("cc-x") } }));
    const forged = "credential-cache-forged-test-key-9876543210";
    await collect(await post(`ApiKey ${forged}`));
    identityMode = "error";
    __resetCredentialCacheForTests();
    await collect(await post(`ApiKey ${KNOWN_KEY}`));
    identityMode = "down";
    await collect(await post(`ApiKey ${KNOWN_KEY}`));
    expect(bodies.length).toBe(6);
    for (const key of [KNOWN_KEY, forged]) {
      expect(leaks(captured.join("\n"), key)).toEqual([]);
      expect(leaks(bodies.join("\n"), key)).toEqual([]);
    }
  });

  it("credential-cache the module keeps its cache private and its exports carry no digest after validating", async () => {
    await identityCredential(`ApiKey ${KNOWN_KEY}`);
    const exported = Object.keys(cc).sort();
    expect(exported).toEqual(["CREDENTIAL_CACHE_MAX_ENTRIES", "CREDENTIAL_VALIDATION_TTL_MS", "MUTATING_PRIMITIVES", "__resetCredentialCacheForTests", "identityCredential", "isWritePointerType"]);
    const snapshot = JSON.stringify(Object.fromEntries(Object.entries(cc).map(([k, v]) => [k, v instanceof Set ? [...v] : typeof v === "function" ? "fn" : v])));
    expect(leaks(snapshot, KNOWN_KEY)).toEqual([]);
    const source = readFileSync(join(SRC, "lib", "caller-credential.ts"), "utf8");
    // In-memory only: the module imports nothing that persists, logs remotely or traces.
    expect([...source.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1])).toEqual(["node:crypto"]);
  });

  it("credential-cache the vessel serves no metrics route and its health handler does not touch the credential module", async () => {
    expect((await impulsesRouter.request("/metrics")).status).toBe(404);
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(index.includes('"/metrics"')).toBe(false);
    expect(index.includes("caller-credential")).toBe(false);
  });
});

describe("credential cache condition 2: bounded by TTL and entry count, negatives never cached", () => {
  it("credential-cache a refused key is asked of identity every time and never cached", async () => {
    const forged = "credential-cache-forged-twice";
    expect((await identityCredential(`ApiKey ${forged}`)).authenticated).toBe(false);
    expect((await identityCredential(`ApiKey ${forged}`)).authenticated).toBe(false);
    expect(identityCalls.filter((k) => k === forged).length).toBe(2);
  });

  it("credential-cache an identity outage is not cached: the next call asks again", async () => {
    identityMode = "down";
    expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(false);
    identityMode = "up";
    expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(true);
    expect(identityCalls.length).toBe(2);
  });

  it("credential-cache the TTL is 60 s and a positive answer is reused inside it", async () => {
    expect(cc.CREDENTIAL_VALIDATION_TTL_MS).toBe(60_000);
    await identityCredential(`ApiKey ${KNOWN_KEY}`);
    await identityCredential(`ApiKey ${KNOWN_KEY}`);
    expect(identityCalls.length).toBe(1);
  });

  it("credential-cache past the entry cap the oldest validation is evicted first", async () => {
    const max = cc.CREDENTIAL_CACHE_MAX_ENTRIES as number;
    expect(Number.isInteger(max) && max > 0).toBe(true);
    const keyN = (i: number) => `credential-cache-evict-${i}`;
    for (let i = 0; i <= max; i++) expect((await identityCredential(`ApiKey ${keyN(i)}`)).authenticated).toBe(true);
    expect(identityCalls.length).toBe(max + 1);
    identityCalls = [];
    // The newest max entries are still cached; the very first one was evicted to make room.
    await identityCredential(`ApiKey ${keyN(max)}`);
    await identityCredential(`ApiKey ${keyN(1)}`);
    expect(identityCalls).toEqual([]);
    await identityCredential(`ApiKey ${keyN(0)}`);
    expect(identityCalls).toEqual([keyN(0)]);
  });
});

describe("credential cache condition 3: revocation lag is at most the TTL", () => {
  it("credential-cache a revoked key is accepted from cache inside the TTL and refused after it", async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(true);
      revoked.add(KNOWN_KEY);
      now += 59_999;
      expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(true);
      now += 1;
      expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(false);
      now += 1;
      expect((await identityCredential(`ApiKey ${KNOWN_KEY}`)).authenticated).toBe(false);
      expect(identityCalls.length).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });
});
