// feature_compose AND gap_to_feature ARE GATED, AND `directed` IS DERIVED AT THE DOOR (operator security review,
// 2026-10-19; row development-vessel-resolve-route-does-not-authenticate-feature-compose-or-gap-to-feature).
//
// Measured: neither shape is a `*_write` or a mutating primitive, so the resolve route authenticated neither. Any caller
// that reached the published port started a compose, and could put directed:true on the pointer itself, which buys the
// directed capacity lane, skips the spend envelope and the isolation scope check, and applies spec edits verbatim.
//
// CONTRACT pinned here (identity and every other call are globalThis.fetch stubs; any unexpected call fails the test):
//   - An unkeyed or forged feature_compose / gap_to_feature is refused 401 with the named caller_credential_required
//     reason at both doors, and nothing is dispatched.
//   - A keyed non-operator (or the node's own key) with pointer directed:true runs UNDIRECTED: the field is stripped
//     before dispatch and one directed_claim_stripped line names why. Observed through the feature_compose case's own
//     missing-input refusal, which lists the pointer keys it was handed.
//   - Controls: goal-host's keyed dispatch (no directed claim) passes the door and reaches the compose case unchanged;
//     an operator:direct credential (as Authorization, or forwarded as X-Operator-Authorization) keeps directed:true.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

const { impulsesRouter, stripUnauthorizedDirectedClaim, DIRECTED_CLAIM_SHAPES } = await import(`../../src/routes/impulses.js?${"compose-door-auth-isolated"}`);
const { isWritePointerType } = await import("../../src/lib/caller-credential.js");
const { __mintOperatorDirectGrantForTests } = await import("../../src/lib/operator-direct.js");

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59133";
const PLAIN_KEY = "compose-door-plain-key-fixture";
const OPERATOR_KEY = "compose-door-operator-key-fixture";
const FORGED_KEY = "compose-door-forged-key-fixture";
const NODE_KEY = "compose-door-node-key-fixture";

const originalFetch = globalThis.fetch;
let identityCalls = 0;
let violations: string[] = [];
let warned: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityCalls = 0;
  violations = [];
  warned = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      identityCalls++;
      const key = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
      const scopes = key === PLAIN_KEY ? ["read", "write"] : key === OPERATOR_KEY ? ["read", "write", "operator:direct"] : null;
      if (!scopes) return Response.json({ success: false, error: "invalid" }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: `kid-${key.split("-")[2]}`, scopes } });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
  spies.push(spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(" ")); }));
  for (const m of ["log", "info"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(violations).toEqual([]);
});

const resolve = (pointer: Record<string, unknown>, headers: Record<string, string> = {}) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ impulse: { pointer } }),
});
const execute = (resolver: string, config: Record<string, unknown>, headers: Record<string, string> = {}) => impulsesRouter.request("/resolvers/execute", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ resolver, config }),
});
// No spec: the feature_compose case refuses before any slot claim and names the keys it was handed (offered_keys).
const SPECLESS = { type: "feature_compose", directed: true, verify_vessels: ["repos/fixture-vessel"] };
const offeredKeys = async (r: Response): Promise<string[]> => {
  const j = (await r.json()) as { body?: { offered_keys?: string[] } };
  return j.body?.offered_keys ?? [];
};

describe("feature_compose and gap_to_feature are gated like writes", () => {
  it("compose-door both shapes are write-type pointers and directed-claim shapes", () => {
    for (const t of ["feature_compose", "gap_to_feature"]) {
      expect(isWritePointerType(t)).toBe(true);
      expect(DIRECTED_CLAIM_SHAPES.has(t)).toBe(true);
    }
  });

  for (const t of ["feature_compose", "gap_to_feature"]) {
    it(`compose-door an unkeyed ${t} is refused 401 by name at the resolve door and nothing is dispatched`, async () => {
      const r = await resolve({ type: t, spec: "compose-door fixture spec", directed: true });
      expect(r.status).toBe(401);
      expect(await r.text()).toContain(`caller_credential_required: ${t} is a write`);
      expect(warned.some((l) => l.includes(`REFUSED unauthenticated ${t}`))).toBe(true);
    });
    it(`compose-door an unkeyed or forged ${t} is refused 401 at the execute door`, async () => {
      expect((await execute(t, { spec: "compose-door fixture spec" })).status).toBe(401);
      expect((await execute(t, { spec: "compose-door fixture spec" }, { Authorization: `ApiKey ${FORGED_KEY}` })).status).toBe(401);
    });
  }
});

describe("directed is derived at the door, never from the pointer", () => {
  it("compose-door a keyed non-operator's directed:true is stripped before dispatch and the strip is logged by name", async () => {
    const r = await resolve(SPECLESS, { Authorization: `ApiKey ${PLAIN_KEY}` });
    expect(r.status).not.toBe(401);
    const keys = await offeredKeys(r);
    expect(keys).toContain("verify_vessels");
    expect(keys).not.toContain("directed");
    expect(warned.some((l) => l.includes("directed_claim_stripped: feature_compose") && l.includes("credential lacks the operator:direct scope"))).toBe(true);
  });

  it("compose-door the same strip runs at the execute door", async () => {
    const r = await execute("feature_compose", { directed: true, verify_vessels: ["repos/fixture-vessel"] }, { Authorization: `ApiKey ${PLAIN_KEY}` });
    expect(r.status).not.toBe(401);
    expect(warned.some((l) => l.includes("directed_claim_stripped: feature_compose"))).toBe(true);
  });

  it("compose-door the node's own key never directs", async () => {
    const r = await resolve(SPECLESS, { Authorization: `ApiKey ${NODE_KEY}` });
    expect(await offeredKeys(r)).not.toContain("directed");
    expect(warned.some((l) => l.includes("directed_claim_stripped") && l.includes("the node's own key never directs"))).toBe(true);
  });

  it("compose-door a gap_to_feature directed claim is stripped the same way (helper)", async () => {
    const p: Record<string, unknown> = { type: "gap_to_feature", directed: true };
    const why = await stripUnauthorizedDirectedClaim("gap_to_feature", p, { operatorGrant: null, authorization: `ApiKey ${PLAIN_KEY}` });
    expect(why).toBe("credential lacks the operator:direct scope");
    expect("directed" in p).toBe(false);
  });

  it("compose-door control: goal-host's keyed dispatch with no directed claim passes the door unchanged", async () => {
    const r = await resolve({ type: "feature_compose", verify_vessels: ["repos/fixture-vessel"] }, { Authorization: `ApiKey ${PLAIN_KEY}` });
    expect(r.status).not.toBe(401);
    expect(await offeredKeys(r)).toEqual(["verify_vessels"]);
    expect(warned.some((l) => l.includes("directed_claim_stripped"))).toBe(false);
  });

  it("compose-door control: an operator:direct Authorization keeps directed:true", async () => {
    const r = await resolve(SPECLESS, { Authorization: `ApiKey ${OPERATOR_KEY}` });
    expect(await offeredKeys(r)).toContain("directed");
    expect(warned.some((l) => l.includes("directed_claim_stripped"))).toBe(false);
  });

  it("compose-door control: goal-host forwarding the operator's key as X-Operator-Authorization keeps directed:true", async () => {
    const r = await resolve(SPECLESS, { Authorization: `ApiKey ${PLAIN_KEY}`, "X-Operator-Authorization": `ApiKey ${OPERATOR_KEY}` });
    expect(await offeredKeys(r)).toContain("directed");
    expect(warned.some((l) => l.includes("directed_claim_stripped"))).toBe(false);
  });

  it("compose-door control: an existing grant keeps directed without asking identity; other shapes are untouched", async () => {
    const p: Record<string, unknown> = { type: "feature_compose", directed: true };
    expect(await stripUnauthorizedDirectedClaim("feature_compose", p, { operatorGrant: __mintOperatorDirectGrantForTests("k", null), authorization: undefined })).toBeNull();
    expect(p["directed"]).toBe(true);
    const q: Record<string, unknown> = { type: "dispatch_goal", directed: true };
    expect(await stripUnauthorizedDirectedClaim("dispatch_goal", q, { operatorGrant: null, authorization: undefined })).toBeNull();
    expect(q["directed"]).toBe(true);
    expect(identityCalls).toBe(0);
  });
});
