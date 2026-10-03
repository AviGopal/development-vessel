// NO CLEARTEXT KEYS TO A PUBLIC IDENTITY (check-first, 2026-10-03).
//
// qa R2. identityCredential POSTs the presented API key to IDENTITY_VESSEL_URL. Measured live: one spoke's
// IDENTITY_VESSEL_URL is http://<public IP>:18101, so every caller's key crossed the internet in cleartext.
//
// CONTRACT pinned here:
//   - The key is sent only when the identity URL is https, OR its host is loopback/private: 127.0.0.0/8,
//     ::1, localhost, RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), IPv6 ULA
//     (fc00::/7), or a hostname that RESOLVES (dns lookup, all:true) ONLY to such addresses.
//   - Anything else over http (a public literal, a hostname resolving to any public address, a hostname
//     that does not resolve) makes NO fetch: identity is treated as unreachable, a loud line names the
//     identity host (never the key), and a write with any key but the node's own is refused 401. The node's
//     own key still writes (R1).
//
// SEAM: globalThis.fetch counts every call to any /v1/auth/resolve and authenticates any key; dns.promises
// .lookup is stubbed per case, so no test touches real DNS or the network.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import dns from "node:dns";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `caller-credential-cleartext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"cleartext"}`);
const cc = await import("../../src/lib/caller-credential.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { identityCredential, __resetCredentialCacheForTests } = cc;

const HOLDER = "http://127.0.0.1:59091/v2/impulses/resolve";
const NODE_KEY = "mb-cleartext-node-key-fixture-0b7d";
const OTHER_KEY = "mb-cleartext-other-key-fixture-91aa";

const realFetch = globalThis.fetch;
let identityFetches: string[] = [];
let storeWrites: Array<Record<string, any>> = [];
let lines: string[] = [];
let violations: string[] = [];
let dnsAnswers: Record<string, Array<{ address: string; family: number }> | "fail"> = {};
let dnsCalls: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityFetches = []; storeWrites = []; lines = []; violations = []; dnsAnswers = {}; dnsCalls = [];
  __resetCredentialCacheForTests();
  for (const m of ["log", "warn", "error", "info", "debug"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  spies.push(spyOn(dns.promises, "lookup").mockImplementation((async (host: string) => {
    dnsCalls.push(host);
    const a = dnsAnswers[host];
    if (!a || a === "fail") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  }) as never));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.endsWith("/v1/auth/resolve")) {
      identityFetches.push(u);
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", scopes: ["read", "write"] } });
    }
    if (u === HOLDER) {
      const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
      if (!String(p.type ?? "").endsWith("_write")) return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0 } });
      storeWrites.push(p);
      return Response.json({ shape: "substrateGapWriteResult", body: { id: p.gap?.id, action: "created" } });
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
const ask = async (identity: string) => { process.env["IDENTITY_VESSEL_URL"] = identity; __resetCredentialCacheForTests(); return identityCredential(`ApiKey ${OTHER_KEY}`); };
const gapWrite = (key: string, id: string) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
  body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `cleartext fixture ${id}`, detected_at: "2026-10-03T00:00:00Z" } } } }),
});

describe("cleartext MUST-FAIL: no key is sent over http to a public identity", () => {
  it("cleartext a public IP literal over http makes zero fetches and a non-node write is refused 401", async () => {
    process.env["IDENTITY_VESSEL_URL"] = "http://104.236.0.175:18101";
    const res = await gapWrite(OTHER_KEY, "cleartext-public-literal");
    expect(res.status).toBe(401);
    expect(identityFetches).toEqual([]);
    expect(storeWrites).toEqual([]);
    const loud = lines.filter((l) => l.includes("[caller-credential]") && l.includes("104.236.0.175"));
    expect(loud.length).toBeGreaterThan(0);
    for (const l of lines) expect(leaks(l, OTHER_KEY)).toEqual([]);
  });

  it("cleartext control the node own key still writes when identity is a public http URL", async () => {
    process.env["IDENTITY_VESSEL_URL"] = "http://104.236.0.175:18101";
    expect((await gapWrite(NODE_KEY, "cleartext-node-self")).status).toBe(200);
    expect(identityFetches).toEqual([]);
    expect(storeWrites.map((w) => w.gap?.id)).toEqual(["cleartext-node-self"]);
  });

  it("cleartext the 172.16/12 boundary holds: 172.32.0.1 over http is public, zero fetches", async () => {
    expect((await ask("http://172.32.0.1:18101")).authenticated).toBe(false);
    expect(identityFetches).toEqual([]);
  });

  it("cleartext a hostname resolving to a public address makes zero fetches", async () => {
    dnsAnswers["identity.public.fixture"] = [{ address: "104.236.0.175", family: 4 }];
    expect((await ask("http://identity.public.fixture:18101")).authenticated).toBe(false);
    expect(identityFetches).toEqual([]);
  });

  it("cleartext a hostname resolving to private and public addresses makes zero fetches", async () => {
    dnsAnswers["identity.mixed.fixture"] = [{ address: "10.0.0.5", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    expect((await ask("http://identity.mixed.fixture:18101")).authenticated).toBe(false);
    expect(identityFetches).toEqual([]);
  });

  it("cleartext a hostname that does not resolve makes zero fetches", async () => {
    dnsAnswers["identity.nxdomain.fixture"] = "fail";
    expect((await ask("http://identity.nxdomain.fixture:18101")).authenticated).toBe(false);
    expect(identityFetches).toEqual([]);
  });
});

describe("cleartext controls: https anywhere, and http to loopback or private hosts, still ask identity", () => {
  for (const url of [
    "http://127.0.0.1:18101", "http://127.9.9.9:18101", "http://localhost:18101", "http://[::1]:18101",
    "http://10.1.2.3:18101", "http://172.16.0.1:18101", "http://172.31.255.254:18101", "http://192.168.1.4:18101",
    "http://169.254.10.10:18101", "http://[fd00::1]:18101", "http://[fe80::1]:18101",
    "https://104.236.0.175:18101", "https://identity.public.fixture:18101",
  ]) {
    it(`cleartext control ${url.replace(/[[\]]/g, "")} makes the identity fetch`, async () => {
      dnsAnswers["identity.public.fixture"] = [{ address: "104.236.0.175", family: 4 }];
      expect((await ask(url)).authenticated).toBe(true);
      expect(identityFetches).toEqual([`${url}/v1/auth/resolve`]);
    });
  }

  it("cleartext control a hostname resolving only to private addresses such as host.containers.internal makes the fetch", async () => {
    dnsAnswers["host.containers.internal"] = [{ address: "10.0.2.2", family: 4 }];
    dnsAnswers["identity.ula.fixture"] = [{ address: "fd12:3456::7", family: 6 }, { address: "192.168.7.7", family: 4 }];
    expect((await ask("http://host.containers.internal:18101")).authenticated).toBe(true);
    expect((await ask("http://identity.ula.fixture:18101")).authenticated).toBe(true);
    expect(identityFetches.length).toBe(2);
  });
});
