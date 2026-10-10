// An operator-direct grant exists only when identity validates the OPERATOR'S OWN forwarded credential with
// "operator:direct" (or "admin", interim). Fixture keys; identity is stood in for by globalThis.fetch.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import {
  operatorDirectGrant,
  runWithOperatorDirectGrant,
  currentOperatorDirectGrant,
  isOperatorDirectCredential,
  OPERATOR_AUTHORIZATION_HEADER,
} from "../../src/lib/operator-direct.js";
import { __resetCredentialCacheForTests } from "../../src/lib/caller-credential.js";

const IDENTITY = "http://127.0.0.1:59131";
const NODE_KEY = "node-key-fixture";
const KEYS: Record<string, { keyId: string; scopes: string[] }> = {
  "rw": { keyId: "k-rw", scopes: ["read", "write"] },
  "opd": { keyId: "k-opd", scopes: ["read", "write", "operator:direct"] },
  "adm": { keyId: "k-adm", scopes: ["read", "write", "admin"] },
  "ver": { keyId: "k-ver", scopes: ["read", "write", "verdict:human"] },
};
let identityDown = false;
let asked = 0;
const originalFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
let warnSpy: ReturnType<typeof spyOn> | null = null;
let errSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityDown = false;
  asked = 0;
  __resetCredentialCacheForTests();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u !== `${IDENTITY}/v1/auth/resolve`) throw new TypeError("unexpected network call in test: " + u);
    asked++;
    if (identityDown) throw new TypeError("Unable to connect");
    const k = KEYS[JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey];
    return k ? Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", role: "user", ...k } }) : Response.json({ success: false }, { status: 401 });
  }) as unknown as typeof fetch;
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  warnSpy?.mockRestore();
  errSpy?.mockRestore();
});

describe("operatorDirectGrant: only the operator-direct scope (or admin) grants", () => {
  it("operator:direct and admin keys grant, bound to the gap and naming the key", async () => {
    expect((await operatorDirectGrant("ApiKey opd", { gap_id: "g1" })).grant).toEqual({ key_id: "k-opd", gap_id: "g1" });
    expect((await operatorDirectGrant("ApiKey adm", { gap_id: "g1" })).grant).toEqual({ key_id: "k-adm", gap_id: "g1" });
  });

  it("a read/write key, a verdict:human key, this node's own key, an unknown key and no header do not", async () => {
    for (const h of ["ApiKey rw", "ApiKey ver", `ApiKey ${NODE_KEY}`, "ApiKey nope", "Bearer x.y.z", "", undefined]) {
      expect((await operatorDirectGrant(h, { gap_id: "g1" })).grant).toBeNull();
    }
  });

  it("identity is asked fresh every time and an unreachable identity grants nothing (fail closed)", async () => {
    await operatorDirectGrant("ApiKey opd", { gap_id: "g" });
    await operatorDirectGrant("ApiKey opd", { gap_id: "g" });
    expect(asked).toBe(2);
    identityDown = true;
    expect((await operatorDirectGrant("ApiKey opd", { gap_id: "g" })).grant).toBeNull();
  });

  it("isOperatorDirectCredential reads scopes only", () => {
    expect(isOperatorDirectCredential({ authenticated: true, scopes: ["operator:direct"] })).toBe(true);
    expect(isOperatorDirectCredential({ authenticated: true, scopes: ["read", "write"] })).toBe(false);
    expect(isOperatorDirectCredential({ authenticated: false, scopes: ["admin"] })).toBe(false);
  });
});

describe("the grant travels only as a context this module minted", () => {
  it("no context, no grant; inside runWithOperatorDirectGrant, the grant", async () => {
    expect(currentOperatorDirectGrant()).toBeNull();
    const { grant } = await operatorDirectGrant("ApiKey opd", { gap_id: "g2" });
    const seen = await runWithOperatorDirectGrant(grant!, async () => { await new Promise((r) => setTimeout(r, 1)); return currentOperatorDirectGrant(); });
    expect(seen).toBe(grant);
    expect(currentOperatorDirectGrant()).toBeNull();
  });

  it("a look-alike object (what JSON could carry) is not a grant", () => {
    const fake = { key_id: "k-opd", gap_id: "g2" };
    expect(runWithOperatorDirectGrant(fake as never, () => currentOperatorDirectGrant())).toBeNull();
  });
});

describe("wiring", () => {
  it("the resolve route grants a feature_compose from the forwarded header and runs it under the grant", () => {
    const src = readFileSync(new URL("../../src/routes/impulses.ts", import.meta.url), "utf8");
    expect(src).toContain('if (pointerType === "feature_compose") {\n    const opAuth = c.req.header(OPERATOR_AUTHORIZATION_HEADER);');
    expect(src).toContain("operatorGrant ? await runWithOperatorDirectGrant(operatorGrant, dispatchOnce) : await dispatchOnce()");
    // the header goal-host sends (goal-host src/operator-credential.ts)
    expect(OPERATOR_AUTHORIZATION_HEADER).toBe("X-Operator-Authorization");
  });

  it("feature_compose still registers its attempt from inside the dispatch (so the context reaches registerAttempt)", () => {
    const fc = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(fc).toContain('route: "feature_compose",');
    expect(fc).toContain("directed: (pointer as { directed?: boolean }).directed === true,");
  });
});
