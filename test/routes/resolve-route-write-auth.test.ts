// THE RESOLVE ROUTE AUTHENTICATES WRITES (check-first, 2026-10-03).
//
// Measured: POST /v2/impulses/resolve performed no caller authentication, and the hub publishes it
// on an all-interfaces host port. Any caller that could reach the port could open, close or reject
// gaps (substrateGap_write), write memory and pool records, and drive the file, git and unit
// primitives. The gap writer is the channel through which a test-name shell injection previously
// reached a root shell. POST /resolvers/execute dispatches through the same table and was a
// second unauthenticated door to the same writers.
//
// CONTRACT pinned here:
//   - A write-type pointer (any `*_write` shape, plus the mutating primitives the route serves)
//     arriving at either door without a credential identity-vessel authenticates is refused 401,
//     and nothing reaches the writer.
//   - A forged key (identity says no) is refused 401.
//   - Identity unreachable for a key it has not validated is refused 401: writes fail CLOSED.
//   - Controls: an authenticated write is accepted and lands; a READ (substrateGap) behaves as it
//     did, unauthenticated. Reads are a separate decision and this contract does not change them.
//
// SEAMS. identity-vessel is stood in for by globalThis.fetch, as in pool-trust-root.test.ts. The
// gap store is the GAP_STORE_ENDPOINT forward: with it set, the gap resolvers forward the pointer
// before touching any local file, so "the store is unchanged" is measured as "the fixture store
// received nothing" and no test grades whichever store root another suite froze first. Any other
// network call is recorded as a violation and fails the test.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

// A query-string instance of the route module: test/observers/topology-chain.test.ts replaces
// routes/impulses.js process-wide with a resolveDispatch stub (bun mock.module is never restored),
// which would answer every write 200 without reaching the store and blind the controls below.
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"write-auth-isolated"}`);

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59107";
const GAP_STORE = "http://gapstore.write-auth.test:8090/v2/impulses/resolve";
const VALID_KEY = "write-auth-valid-key-fixture";
const UNSEEN_VALID_KEY = "write-auth-unseen-valid-key-fixture";
const FORGED_KEY = "write-auth-forged-key-fixture";

const originalFetch = globalThis.fetch;
let identityMode: "up" | "down" = "up";
let storeWrites: Array<Record<string, any>> = [];
let storeReads: Array<Record<string, any>> = [];
let violations: string[] = [];

function installStubs(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = (() => { try { return JSON.parse(String(init?.body ?? "{}")); } catch { return {}; } })();
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      if (identityMode === "down") throw new TypeError("Unable to connect");
      const key = body?.impulse?.pointer?.apiKey;
      if (key === VALID_KEY || key === UNSEEN_VALID_KEY) {
        return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k", scopes: ["read", "write"] } });
      }
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u === GAP_STORE) {
      const pointer = body?.impulse?.pointer ?? {};
      if (String(pointer.type ?? "").endsWith("_write")) {
        storeWrites.push(pointer);
        return Response.json({ shape: "substrateGap_write", body: { ok: true, id: pointer?.gap?.id ?? null } });
      }
      storeReads.push(pointer);
      return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0 } });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

let savedIdentity: string | undefined;
let savedStore: string | undefined;
let savedKey: string | undefined;
let warnSpy: ReturnType<typeof spyOn> | null = null;
let logSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  savedIdentity = process.env["IDENTITY_VESSEL_URL"];
  savedStore = process.env["GAP_STORE_ENDPOINT"];
  savedKey = process.env["METABOB_API_KEY"];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["GAP_STORE_ENDPOINT"] = GAP_STORE;
  // The forwarder attaches the vessel's own key; keep it out so the fixture sees only the pointer.
  delete process.env["METABOB_API_KEY"];
  identityMode = "up";
  storeWrites = [];
  storeReads = [];
  violations = [];
  installStubs();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("IDENTITY_VESSEL_URL", savedIdentity);
  restore("GAP_STORE_ENDPOINT", savedStore);
  restore("METABOB_API_KEY", savedKey);
  warnSpy?.mockRestore();
  logSpy?.mockRestore();
  expect(violations).toEqual([]);
});

const gap = (id: string) => ({ id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `write-auth fixture ${id}`, detected_at: "2026-10-03T00:00:00Z" });
const post = (auth: string | null, body: unknown) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify(body),
});
const execute = (auth: string | null, body: unknown) => impulsesRouter.request("/resolvers/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify(body),
});

describe("write-auth MUST-FAIL at base: unauthenticated writes are refused and land nothing", () => {
  it("write-auth an unauthenticated substrateGap_write in the nested form is refused 401 and the store receives nothing", async () => {
    const res = await post(null, { impulse: { pointer: { type: "substrateGap_write", gap: gap("write-auth-anon-nested") } } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth an unauthenticated substrateGap_write in the impulse-as-pointer and bare forms is refused 401", async () => {
    const asPointer = await post(null, { impulse: { type: "substrateGap_write", gap: gap("write-auth-anon-impulse") } });
    expect(asPointer.status).toBe(401);
    const bare = await post(null, { type: "substrateGap_write", gap: gap("write-auth-anon-bare") });
    expect(bare.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth a close of an existing gap without a credential is refused 401", async () => {
    const res = await post(null, { impulse: { pointer: { type: "substrateGap_write", gap: { ...gap("write-auth-anon-close"), status: "closed" } } } });
    expect(res.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth a forged key that identity rejects is refused 401 and the store receives nothing", async () => {
    const res = await post(`ApiKey ${FORGED_KEY}`, { impulse: { pointer: { type: "substrateGap_write", gap: gap("write-auth-forged") } } });
    expect(res.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth a non-ApiKey Authorization scheme is refused 401", async () => {
    const res = await post(`Bearer ${VALID_KEY}`, { impulse: { pointer: { type: "substrateGap_write", gap: gap("write-auth-bearer") } } });
    expect(res.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth identity unreachable for a key it has not validated fails closed with 401", async () => {
    identityMode = "down";
    const res = await post(`ApiKey ${UNSEEN_VALID_KEY}`, { impulse: { pointer: { type: "substrateGap_write", gap: gap("write-auth-identity-down") } } });
    expect(res.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth the resolvers execute door refuses an unauthenticated substrateGap_write with 401", async () => {
    const res = await execute(null, { resolver: "substrateGap_write", config: { gap: gap("write-auth-anon-execute") } });
    expect(res.status).toBe(401);
    expect(storeWrites).toEqual([]);
  });

  it("write-auth the gated set covers the write family and the mutating primitives", async () => {
    let mod: { isWritePointerType?: (t: string) => boolean } = {};
    try { mod = await import("../../src/lib/caller-credential.js"); } catch { /* absent at base */ }
    expect(typeof mod.isWritePointerType).toBe("function");
    const gated = mod.isWritePointerType!;
    for (const t of ["substrateGap_write", "memoryNote_write", "poolImpulse_write", "concept_write", "maintenanceLease_write", "uiPanel_write",
      "fs_write", "fs_edit", "git_add", "git_commit", "git_push", "git_branch_create", "gh_pr_create", "gh_pr_merge", "gh_repo_create",
      "patch_with_tools", "apply_proposal_as_patch", "systemd_restart", "pull_cutover", "surrealdb_import", "activate_substrate_script",
      "vessel_mitosis_cutover", "http_fetch"]) {
      expect(`${t}:${gated(t)}`).toBe(`${t}:true`);
    }
    for (const t of ["substrateGap", "memoryNote", "poolImpulse", "fs_read", "git_status", "git_log", "registry_query_like_read"]) {
      expect(`${t}:${gated(t)}`).toBe(`${t}:false`);
    }
  });
});

describe("write-auth controls, green at base and after the fix", () => {
  it("write-auth control an authenticated substrateGap_write is accepted and lands in the store", async () => {
    const res = await post(`ApiKey ${VALID_KEY}`, { impulse: { pointer: { type: "substrateGap_write", gap: gap("write-auth-authed") } } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(storeWrites.map((w) => w.gap?.id)).toEqual(["write-auth-authed"]);
  });

  it("write-auth control an authenticated write through the resolvers execute door lands", async () => {
    const res = await execute(`ApiKey ${VALID_KEY}`, { resolver: "substrateGap_write", config: { gap: gap("write-auth-authed-execute") } });
    expect(res.status).toBe(200);
    expect(storeWrites.map((w) => w.gap?.id)).toEqual(["write-auth-authed-execute"]);
  });

  it("write-auth control an unauthenticated substrateGap read is answered as before and reads are not gated", async () => {
    const res = await post(null, { impulse: { pointer: { type: "substrateGap", status: "open", limit: 5 } } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean; shape: string }).shape).toBe("substrateGap");
    expect(storeReads.length).toBe(1);
    expect(storeWrites).toEqual([]);
  });
});
