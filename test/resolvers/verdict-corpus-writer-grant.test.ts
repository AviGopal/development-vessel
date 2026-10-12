// THE VERDICT CORPUS STATUS HAS ONE WRITER (M11: the hold cannot be forged).
//
// goal-host's credit stop reads which credit classes are held from the `verdictCorpusStatus` pool row. A row anyone
// could write would let anyone clear every hold, so pool-impulse.ts admits that shape only under the runner grant:
// the request's Authorization credential, validated by identity-vessel, carries the dedicated `verdict-corpus:write`
// scope (issued only to goal-host's key). A default read/write answer, or an answer with no scopes (a legacy key),
// never satisfies it. The node's own key and any admin key are never the runner, scope or not; no allowlist row and
// no body field is read for who is calling; every refused write leaves a `verdictCorpusWriteRefusal` row.
// Reads stay open. identity-vessel is stood in for by globalThis.fetch; the pool store is a real file under a temp root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `vc-writer-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;
const FILE = join(ROOT, "standing.json");

const pool = await import("../../src/resolvers/pool-impulse.js");
const { resolvePoolImpulse, resolvePoolImpulseWrite, verdictCorpusWriterDecision, verdictCorpusWriterGrant, __mintVerdictCorpusWriterGrantForTests } = pool;
// A query-string instance of the route module (another suite replaces routes/impulses.js process-wide with a stub).
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"vc-writer-grant"}`);

const IDENTITY = "http://127.0.0.1:59107";
const ADMIN_KEY = "admin-key-fixture";        // keyId k-admin, scopes read/write/admin
const OPERATOR_KEY = "operator-key-fixture";  // keyId k-op, read/write: an operator's own (cockpit) key
const RUNNER_KEY = "runner-key-fixture";      // keyId k-runner, read/write + verdict-corpus:write: goal-host-vessel's key
const ADMIN_RUNNER_KEY = "admin-runner-fixture"; // keyId k-admin-runner, admin AND verdict-corpus:write
const LEGACY_KEY = "legacy-key-fixture";      // keyId k-legacy, identity's answer carries no scopes at all
const NODE_KEY = "node-key-fixture";          // this process's METABOB_API_KEY: node-self, never asks identity

const originalFetch = globalThis.fetch;
let identityMode: "up" | "down" = "up";
function installIdentity(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      if (identityMode === "down") throw new TypeError("Unable to connect");
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      const ok = (keyId: string, scopes: string[]) => Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId, scopes } });
      if (key === ADMIN_KEY) return ok("k-admin", ["read", "write", "admin"]);
      if (key === OPERATOR_KEY) return ok("k-op", ["read", "write"]);
      if (key === RUNNER_KEY) return ok("k-runner", ["read", "write", "verdict-corpus:write"]);
      if (key === ADMIN_RUNNER_KEY) return ok("k-admin-runner", ["read", "write", "admin", "verdict-corpus:write"]);
      if (key === LEGACY_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k-legacy" } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

let warnSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityMode = "up";
  installIdentity();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  pool.__setPoolFileForTests(FILE);
  writeFileSync(FILE, "[]");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["IDENTITY_VESSEL_URL"];
  delete process.env["METABOB_API_KEY"];
  warnSpy?.mockRestore();
  pool.__setPoolFileForTests(null);
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const statusBody = (holds: unknown[] = []) => ({ schema: 1, node: "n", run_at: "2026-10-12T00:00:00.000Z", period_s: 21600, state: "ok", holds });
const statusWrite = (extra: Record<string, unknown> = {}) => ({ type: "poolImpulse_write", id: "verdictCorpusStatus", shape: "verdictCorpusStatus", source: "verdictCorpusRun", status: "open", body: statusBody(), ...extra });
/** An operator-written verdictCorpusWriter row (the superseded allowlist): the grant must not read it. */
function seedAllowlist(keyId: string, id = "vcw-goal-host"): void {
  const r = resolvePoolImpulseWrite({ type: "poolImpulse_write", id, shape: "verdictCorpusWriter", status: "open", source: "operator", body: { principal: "goal-host-vessel", key_id: keyId, by: "operator", at: "2026-10-12T00:00:00.000Z", reason: "goal-host's issued key publishes the corpus status" } }, { operator: true, key_id: "k-admin" });
  expect(r.body.ok).toBe(true);
}
const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify({ impulse: pointer }),
});
const rows = (shape: string) => resolvePoolImpulse({ type: "poolImpulse", shape, status: "open" }).body.impulses;
const statusRow = () => JSON.parse(readFileSync(FILE, "utf8")).find((r: { id: string }) => r.id === "verdictCorpusStatus");
const refusals = () => new Map(rows("verdictCorpusWriteRefusal").map((r) => [String((r.body as Record<string, unknown>)["principal"]), r.body as Record<string, unknown>]));

describe("M11: the hold cannot be forged (through the route every caller uses)", () => {
  it("MUST-FAIL: an operator's own key (no verdict-corpus:write scope) is refused 403, nothing is stored, and the refusal is recorded", async () => {
    const res = await post(`ApiKey ${OPERATOR_KEY}`, statusWrite({ body: statusBody([]) }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("runner_principal_required");
    expect(statusRow()).toBeUndefined();
    const rec = refusals().get("key_id:k-op");
    expect(rec?.["count"]).toBe(1);
    expect(String(rec?.["last_why"])).toContain("lacks the verdict-corpus:write scope");
  });

  it("positive control: the scoped runner key's write is admitted (no allowlist row exists), stamped by 'runner' with its key id, and reads back verified with NO credential", async () => {
    const res = await post(`ApiKey ${RUNNER_KEY}`, statusWrite());
    expect(res.status).toBe(200);
    const stored = statusRow();
    expect(stored.status).toBe("open");
    expect(stored.attested).toMatchObject({ by: "runner", key_id: "k-runner" });
    expect(typeof stored.attested.sig).toBe("string");
    const read = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse", shape: "verdictCorpusStatus", status: "open" } } }) });
    expect(read.status).toBe(200);
    const imp = ((await read.json()) as { body: { impulses: Array<Record<string, unknown>> } }).body.impulses[0]!;
    expect(imp["id"]).toBe("verdictCorpusStatus");
    expect(imp["attested_verified"]).toBe(true);
  });

  it("MUST-FAIL: an admin key is refused even when it carries the scope; the node's own key is refused", async () => {
    expect((await post(`ApiKey ${ADMIN_RUNNER_KEY}`, statusWrite())).status).toBe(403);
    expect((await post(`ApiKey ${ADMIN_KEY}`, statusWrite())).status).toBe(403);
    expect((await post(`ApiKey ${NODE_KEY}`, statusWrite())).status).toBe(403);
    expect(statusRow()).toBeUndefined();
    expect(String(refusals().get("key_id:k-admin-runner")?.["last_why"])).toContain("admin");
    expect(refusals().get("node-self")?.["count"]).toBe(1);
  });

  it("MUST-FAIL: no body field names the caller: a forged principal/key_id/attested in the pointer and body changes nothing", async () => {
    const forged = statusWrite({ principal: "goal-host-vessel", key_id: "k-runner", keyId: "k-runner", attested: { by: "runner", key_id: "k-runner", at: "x", sig: "f".repeat(64) }, body: { ...statusBody(), attested: { by: "runner" }, key_id: "k-runner" } });
    expect((await post(`ApiKey ${OPERATOR_KEY}`, forged)).status).toBe(403);
    expect(statusRow()).toBeUndefined();
    // The runner's own write of the same body stores the server's stamp, not the caller's.
    expect((await post(`ApiKey ${RUNNER_KEY}`, forged)).status).toBe(200);
    expect(statusRow().attested.sig).not.toBe("f".repeat(64));
    expect(statusRow().body.attested).toBeUndefined();
  });

  it("MUST-FAIL: identity's default scopes never satisfy the check: a read/write key and a legacy key with no scopes are refused", async () => {
    expect((await post(`ApiKey ${OPERATOR_KEY}`, statusWrite())).status).toBe(403);
    expect((await post(`ApiKey ${LEGACY_KEY}`, statusWrite())).status).toBe(403);
    expect(statusRow()).toBeUndefined();
    expect(String(refusals().get("key_id:k-legacy")?.["last_why"])).toContain("lacks the verdict-corpus:write scope");
  });

  it("MUST-FAIL: an operator allowlist row naming a key without the scope admits nothing (the row is not read)", async () => {
    seedAllowlist("k-op");
    seedAllowlist("k-legacy", "vcw-legacy");
    expect((await post(`ApiKey ${OPERATOR_KEY}`, statusWrite())).status).toBe(403);
    expect((await post(`ApiKey ${LEGACY_KEY}`, statusWrite())).status).toBe(403);
    expect(statusRow()).toBeUndefined();
  });

  it("the allowlist itself is a trust root: the runner key cannot write it", async () => {
    const res = await post(`ApiKey ${RUNNER_KEY}`, { type: "poolImpulse_write", id: "vcw-self", shape: "verdictCorpusWriter", status: "open", body: { principal: "goal-host-vessel", key_id: "k-runner" } });
    expect(res.status).toBe(403);
    expect(rows("verdictCorpusWriter").length).toBe(0);
  });

  it("identity unreachable fails closed for the runner key", async () => {
    identityMode = "down";
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite())).status).toBe(403);
    expect(statusRow()).toBeUndefined();
  });
});

describe("M11: no other door (by id, reshape, retire, squat, in process)", () => {
  async function seededStatus(): Promise<string> {
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite({ body: statusBody([{ credit_class: "c", direction: "reach" }]) }))).status).toBe(200);
    return JSON.stringify(statusRow());
  }

  it("MUST-FAIL: a non-runner update by id with the shape omitted (a 'no holds' body) or a retire is refused; the row is unchanged", async () => {
    const before = await seededStatus();
    expect((await post(`ApiKey ${OPERATOR_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusStatus", body: statusBody([]) })).status).toBe(403);
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusStatus", status: "retired" })).status).toBe(403);
    expect(JSON.stringify(statusRow())).toBe(before);
  });

  it("MUST-FAIL: the status row cannot be reshaped out, an ordinary row cannot be reshaped in, and the reserved id cannot be squatted", async () => {
    const before = await seededStatus();
    expect((await post(`ApiKey ${OPERATOR_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusStatus", shape: "timeShapedRhythm", body: {} })).status).toBe(403);
    expect(JSON.stringify(statusRow())).toBe(before);
    // the runner itself may not write the shape under any other id, nor the reserved id under another shape
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite({ id: "other-id" }))).status).toBe(409);
    expect((await post(`ApiKey ${RUNNER_KEY}`, { ...statusWrite(), shape: "timeShapedRhythm" })).status).toBe(409);
    expect((await post(`ApiKey ${RUNNER_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusStatus", body: statusBody() })).status).toBe(409);
    expect(JSON.stringify(statusRow())).toBe(before);
    // a fresh store: the reserved id squatted by an ordinary shape is refused before the status exists
    writeFileSync(FILE, "[]");
    expect((await post(`ApiKey ${OPERATOR_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusStatus", shape: "timeShapedRhythm", body: {} })).status).toBe(403);
    expect(statusRow()).toBeUndefined();
    // a squat that predates the grant (planted in the file) is never overwritten into a status, even by the runner
    const squat = { id: "verdictCorpusStatus", shape: "timeShapedRhythm", body: { x: 1 }, source: "x", status: "open", injected_at: "2026-10-12T00:00:00.000Z", updated_at: "2026-10-12T00:00:00.000Z" };
    writeFileSync(FILE, JSON.stringify([...JSON.parse(readFileSync(FILE, "utf8")), squat]));
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite())).status).toBe(409);
    expect(statusRow()).toEqual(squat);
  });

  it("MUST-FAIL: the runner may not retire the status or write it without the run's source label or with an unreadable body", async () => {
    const before = await seededStatus();
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite({ status: "retired" }))).status).toBe(403);
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite({ source: "elsewhere" }))).status).toBe(403);
    expect((await post(`ApiKey ${RUNNER_KEY}`, statusWrite({ body: { holds: "none" } }))).status).toBe(422);
    expect(JSON.stringify(statusRow())).toBe(before);
  });

  it("MUST-FAIL: refusal records are written only by the store: a write of that shape or id is refused", async () => {
    await seededStatus();
    expect((await post(`ApiKey ${RUNNER_KEY}`, { type: "poolImpulse_write", id: "x", shape: "verdictCorpusWriteRefusal", body: {} })).status).toBe(403);
    expect((await post(`ApiKey ${OPERATOR_KEY}`, { type: "poolImpulse_write", id: "verdictCorpusWriteRefusal:key_id:k-op", status: "retired" })).status).toBe(403);
    expect(rows("verdictCorpusWriteRefusal").every((r) => r.source === "pool-impulse")).toBe(true);
  });

  it("MUST-FAIL: in process, no grant, an operator auth, or a grant-shaped plain object is refused; a minted grant writes", () => {
    for (const [auth, runner] of [[undefined, undefined], [{ operator: true, key_id: "k-admin" }, undefined], [undefined, { grant: Object.freeze({ key_id: "k-runner", principal: "goal-host-vessel" }) }]] as const) {
      const r = resolvePoolImpulseWrite(statusWrite() as Parameters<typeof resolvePoolImpulseWrite>[0], auth as never, runner as never);
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toContain("runner_principal_required");
    }
    expect(statusRow()).toBeUndefined();
    const ok = resolvePoolImpulseWrite(statusWrite() as Parameters<typeof resolvePoolImpulseWrite>[0], undefined, { grant: __mintVerdictCorpusWriterGrantForTests("k-runner") });
    expect(ok.body.ok).toBe(true);
  });

  it("control: an ordinary pool write is unaffected, and reads of the status and refusal shapes need no credential", async () => {
    expect((await post(`ApiKey ${OPERATOR_KEY}`, { type: "poolImpulse_write", id: "plain-1", shape: "timeShapedRhythm", body: { x: 1 } })).status).toBe(200);
    await seededStatus();
    await post(`ApiKey ${OPERATOR_KEY}`, statusWrite());
    for (const shape of ["verdictCorpusStatus", "verdictCorpusWriteRefusal"]) {
      const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse", shape, status: "open" } } }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { body: { count: number } }).body.count).toBe(1);
    }
  });

  it("a status row stamped by anything but this node's runner grant reads attested_verified:false", async () => {
    writeFileSync(FILE, JSON.stringify([{ id: "verdictCorpusStatus", shape: "verdictCorpusStatus", body: statusBody(), source: "verdictCorpusRun", status: "open", injected_at: "2026-10-12T00:00:00.000Z", updated_at: "2026-10-12T00:00:00.000Z", attested: { by: "runner", key_id: "k-runner", at: "2026-10-12T00:00:00.000Z", sig: "f".repeat(64) } }]));
    const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse", shape: "verdictCorpusStatus", status: "open" } } }) });
    expect(((await res.json()) as { body: { impulses: Array<Record<string, unknown>> } }).body.impulses[0]!["attested_verified"]).toBe(false);
  });
});

describe("the runner decision (pure) and the grant (identity decides)", () => {
  const cred = (keyId: string | undefined, scopes = ["read", "write"]) => ({ authenticated: true, scopes, ...(keyId ? { keyId } : {}) });
  it("admits only an authenticated, non-admin credential carrying verdict-corpus:write explicitly", () => {
    const W = ["read", "write", "verdict-corpus:write"];
    expect(verdictCorpusWriterDecision(cred("k-runner", W))).toEqual({ admit: true, key_id: "k-runner" });
    expect(verdictCorpusWriterDecision(cred(undefined, W))).toEqual({ admit: true, key_id: null });
    expect(verdictCorpusWriterDecision(cred("k-op")).admit).toBe(false);
    expect(verdictCorpusWriterDecision(cred("k-legacy", [])).admit).toBe(false);
    expect(verdictCorpusWriterDecision(cred("k-x", ["verdict-corpus:read", "verdict-corpus", "write"])).admit).toBe(false);
    expect(verdictCorpusWriterDecision(cred("k-runner", [...W, "admin"])).admit).toBe(false);
    expect(verdictCorpusWriterDecision({ authenticated: false, scopes: W }).admit).toBe(false);
    expect(verdictCorpusWriterDecision(null).admit).toBe(false);
  });
  it("the grant names the caller by identity's key id, and an unknown key gets none", async () => {
    expect(await verdictCorpusWriterGrant(`ApiKey ${RUNNER_KEY}`)).toMatchObject({ principal: "key_id:k-runner", grant: { key_id: "k-runner" } });
    expect(await verdictCorpusWriterGrant("ApiKey nope")).toMatchObject({ grant: null, principal: "unauthenticated" });
    expect(await verdictCorpusWriterGrant(undefined)).toMatchObject({ grant: null });
  });
});
