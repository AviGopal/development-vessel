// interventionRefused_write: a refusal record names its writer, and only that writer may rewrite it.
//
// interventionRefused rows are the substrate's own refusal history (the S3 push-away count reads them). The
// write took any service key, spread an unvalidated `refusal` into the store, and replaced an existing record
// whenever the id matched, so any key holder could rewrite a genuine refusal; a missing `refusal` crashed the
// resolver with a 500 ("incoming.refused_at"). Now:
//   - the route stamps written_by from the credential its write gate validated (never the pointer);
//   - an existing id is rewritten only by the same identified principal (403 otherwise);
//   - a malformed refusal is a 400 with the reason.
// identity-vessel is stood in for by globalThis.fetch with fixture keys; the store is a real file under a temp
// root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `intervention-refused-principal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
const savedRoot = process.env["WORKSPACE_ROOT"];

// A query-string instance of the route module (test/observers/topology-chain.test.ts replaces
// routes/impulses.js process-wide with a stub; see pool-trust-root.test.ts).
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"intervention-refused-principal"}`);

const IDENTITY = "http://127.0.0.1:59107";
const KEY_A = "key-a-fixture";
const KEY_B = "key-b-fixture";
const KEY_NO_ID = "key-noid-fixture";

const originalFetch = globalThis.fetch;
function installIdentity(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      // Both keys are ordinary read/write service keys of the same user: only the key id tells them apart.
      if (key === KEY_A) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "ka", scopes: ["read", "write"] } });
      if (key === KEY_B) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "kb", scopes: ["read", "write"] } });
      if (key === KEY_NO_ID) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

let warnSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  process.env["WORKSPACE_ROOT"] = ROOT;
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  installIdentity();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["IDENTITY_VESSEL_URL"];
  if (savedRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = savedRoot;
  warnSpy?.mockRestore();
});
afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const post = (key: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
  body: JSON.stringify({ impulse: pointer }),
});
const refusal = (id: string, basis: string, extra: Record<string, unknown> = {}) => ({
  type: "interventionRefused_write",
  refusal: { id, proposed_change: { source: "operator", description: "rewrite the oracle consumer" }, refusal_basis: basis, substrate_priors_cited: [], strictness: "standard", ...extra },
});
const stored = (): Array<Record<string, unknown>> => {
  try { return JSON.parse(readFileSync(join(ROOT, "refusals", "refusals.json"), "utf-8")); } catch { return []; }
};
const byId = (id: string) => stored().find((r) => r["id"] === id);

describe("interventionRefused_write: a foreign principal cannot overwrite an existing refusal", () => {
  it("MUST-FAIL (e): key B reusing key A's refusal id is refused 403 and the stored record is unchanged", async () => {
    const created = await post(KEY_A, refusal("refusal-e1", "genuine: cited evidence contradicts the change"));
    expect(created.status).toBe(200);
    expect(byId("refusal-e1")?.["written_by"]).toBe("key_id:ka");

    const forged = await post(KEY_B, refusal("refusal-e1", "forged: nothing was refused"));
    expect(forged.status).toBe(403);
    const body = await forged.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("intervention_refused_foreign_overwrite");
    expect(byId("refusal-e1")?.["refusal_basis"]).toBe("genuine: cited evidence contradicts the change");
    expect(byId("refusal-e1")?.["written_by"]).toBe("key_id:ka");
  });

  it("MUST-FAIL (e): a record with no recorded writer (the evaluator's own, or pre-existing) cannot be rewritten through the shape", async () => {
    mkdirSync(join(ROOT, "refusals"), { recursive: true });
    const legacy = { id: "refusal-legacy", proposed_change: { source: "operator" }, refusal_basis: "evaluator REFUSE", substrate_priors_cited: [], refused_at: "2026-10-01T00:00:00.000Z", strictness: "standard" };
    writeFileSync(join(ROOT, "refusals", "refusals.json"), JSON.stringify([...stored().filter((r) => r["id"] !== "refusal-legacy"), legacy]));
    const res = await post(KEY_A, refusal("refusal-legacy", "rewritten"));
    expect(res.status).toBe(403);
    expect(byId("refusal-legacy")?.["refusal_basis"]).toBe("evaluator REFUSE");
  });

  it("MUST-FAIL (e): a caller whose credential identity names no key id cannot overwrite (two such callers cannot be told apart)", async () => {
    expect((await post(KEY_NO_ID, refusal("refusal-noid", "first"))).status).toBe(200);
    expect((await post(KEY_NO_ID, refusal("refusal-noid", "second"))).status).toBe(403);
    expect(byId("refusal-noid")?.["refusal_basis"]).toBe("first");
  });

  it("a caller-supplied written_by is overwritten with the validated principal", async () => {
    expect((await post(KEY_B, refusal("refusal-wb", "b's own", { written_by: "key_id:ka" }))).status).toBe(200);
    expect(byId("refusal-wb")?.["written_by"]).toBe("key_id:kb");
    // so key A cannot then claim it
    expect((await post(KEY_A, refusal("refusal-wb", "a's rewrite"))).status).toBe(403);
  });

  it("CONTROL: the same principal may rewrite its own record, and a new id is created by any authenticated writer", async () => {
    expect((await post(KEY_A, refusal("refusal-own", "v1"))).status).toBe(200);
    const again = await post(KEY_A, refusal("refusal-own", "v2"));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { body: { action: string } }).body.action).toBe("updated");
    expect(byId("refusal-own")?.["refusal_basis"]).toBe("v2");
    expect((await post(KEY_B, refusal("refusal-new-b", "b"))).status).toBe(200);
  });

  it("CONTROL: an unauthenticated write is still refused 401 by the write gate", async () => {
    expect((await post(null, refusal("refusal-anon", "x"))).status).toBe(401);
    expect(byId("refusal-anon")).toBeUndefined();
  });
});

describe("interventionRefused_write: a malformed refusal is a 400 with a reason, not a 500", () => {
  it("MUST-FAIL (e): a missing refusal is a 400 naming the problem", async () => {
    const res = await post(KEY_A, { type: "interventionRefused_write" });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("refusal must be an object");
    expect(body.error).not.toContain("refused_at");
  });

  it("MUST-FAIL (e): a non-object refusal, or one without an id, is a 400", async () => {
    for (const [r, why] of [["just text", "refusal must be an object"], [[1, 2], "refusal must be an object"], [{ proposed_change: {}, refusal_basis: "x" }, "refusal.id"], [{ id: "r-x", refusal_basis: "x" }, "refusal.proposed_change"]] as const) {
      const res = await post(KEY_A, { type: "interventionRefused_write", refusal: r });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(why);
    }
  });
});
