// substrateNodes is a TRUST ROOT: gap-to-feature's policy reads accept a peer node's producers only when the
// local substrateNodes record lists it. So:
//   1. it is written only with an operator credential (identity resolves the key with the "admin" scope).
//      The fleet key and the cockpit key are read/write only; a federated peer reaching dev-vessel through
//      the libp2p ingress arrives with the transport's fleet key, through discovery with its own key.
//   2. self_fact_reconcile's pool_record_pin row measures the record against the operator-seeded value
//      every tick, so a write that got past (1) by any other door is a filed divergence.
// identity-vessel is stood in for by globalThis.fetch; the pool store is a real file under a temp root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
// These tests exercise the ungated rows path (origin/dev); a gated node reads the gate-fed copy instead.
useUngatedRowsSource();

const ROOT = join(tmpdir(), `pool-trust-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;

const pool = await import("../../src/resolvers/pool-impulse.js");
const { resolvePoolImpulse, resolvePoolImpulseWrite, operatorCredential } = pool;
// A query-string instance of the route module: test/observers/topology-chain.test.ts replaces
// routes/impulses.js process-wide with mock.module (never undone), whose stub answers writes 200 without
// reaching the store; the plain specifier would hand this file that stub in a full run.
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"pool-trust-root"}`);
const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { evaluateSelfFactRow, __setPoolPinDepsForTests, thisNode } = sfr;

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59105";
const ADMIN_KEY = "admin-key-fixture";
const FLEET_KEY = "fleet-key-fixture";
// This process's own key (METABOB_API_KEY): authenticated locally as node-self, scopes ["node"], no admin.
const NODE_KEY = "node-key-fixture";
const N1 = "http://host.containers.internal:18100";
const N2 = "http://host.containers.internal:26100";
const ROGUE = "http://syzygy.host:18100";

const originalFetch = globalThis.fetch;
let identityMode: "up" | "down" = "up";
function installIdentity(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      if (identityMode === "down") throw new TypeError("Unable to connect");
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      if (key === ADMIN_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k1", scopes: ["read", "write", "admin"] } });
      if (key === FLEET_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k2", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

const nodesNow = () => resolvePoolImpulse({ type: "poolImpulse", shape: "substrateNodes" }).body.impulses;
let warnSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
  identityMode = "up";
  installIdentity();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["IDENTITY_VESSEL_URL"];
  delete process.env["METABOB_API_KEY"];
  warnSpy?.mockRestore();
  __setPoolPinDepsForTests(null);
});
afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const seed = { type: "poolImpulse_write", id: "substrate-nodes", shape: "substrateNodes", status: "open" as const, body: { discovery_endpoints: [N1, N2] } };

describe("the store's one writer refuses a trust-root write without an operator credential", () => {
  it("no credential (an in-process caller) is refused and nothing is stored", () => {
    const r = resolvePoolImpulseWrite({ ...seed, id: "sn-inproc" });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("operator_credential_required");
    expect(nodesNow().some((i) => i.id === "sn-inproc")).toBe(false);
  });

  it("an operator credential writes; then a non-operator cannot retire or rewrite it by id alone (shape omitted)", () => {
    expect(resolvePoolImpulseWrite(seed, { operator: true }).body.ok).toBe(true);
    const retire = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "substrate-nodes", status: "retired" });
    expect(retire.body.ok).toBe(false);
    const reshape = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "substrate-nodes", shape: "harmless", body: {} }, { operator: false });
    expect(reshape.body.ok).toBe(false);
    const still = nodesNow().find((i) => i.id === "substrate-nodes");
    expect((still?.body as { discovery_endpoints: string[] }).discovery_endpoints).toEqual([N1, N2]);
  });

  it("an ordinary pool write is unaffected (positive control through the same writer)", () => {
    const r = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "plain-1", shape: "timeShapedRhythm", body: { x: 1 } });
    expect(r.body.ok).toBe(true);
  });

  it("the autonomy scope and the spend envelope are trust roots too: refused without an operator, written with one", () => {
    for (const shape of ["autonomyScope", "spendEnvelope"]) {
      const w = { type: "poolImpulse_write", id: `tr-${shape}`, shape, status: "open" as const, body: { excluded_paths: [] } };
      const refused = resolvePoolImpulseWrite(w);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toContain("operator_credential_required");
      expect(resolvePoolImpulseWrite(w, { operator: true }).body.ok).toBe(true);
    }
  });
});

describe("operatorCredential: identity decides, and only the admin scope is an operator", () => {
  it("admin scope → operator", async () => expect((await operatorCredential(`ApiKey ${ADMIN_KEY}`)).operator).toBe(true));
  it("the fleet key (read/write) is not", async () => expect(await operatorCredential(`ApiKey ${FLEET_KEY}`)).toMatchObject({ operator: false, why: "credential lacks the admin scope" }));
  it("an unknown key is not", async () => expect((await operatorCredential("ApiKey nope")).operator).toBe(false));
  it("no header is not", async () => expect((await operatorCredential(undefined)).operator).toBe(false));
  it("identity unreachable fails closed", async () => {
    identityMode = "down";
    expect((await operatorCredential(`ApiKey ${ADMIN_KEY}`)).operator).toBe(false);
  });
  it("identity URL unset fails closed", async () => {
    delete process.env["IDENTITY_VESSEL_URL"];
    expect((await operatorCredential(`ApiKey ${ADMIN_KEY}`)).operator).toBe(false);
  });
});

describe("the HTTP route (the door a peer and the lane both use)", () => {
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });

  it("the fleet key (what the libp2p ingress and the autonomous lane carry) gets 403 and changes nothing", async () => {
    const before = JSON.stringify(nodesNow());
    const res = await post(`ApiKey ${FLEET_KEY}`, { ...seed, id: "sn-peer", body: { discovery_endpoints: [ROGUE] } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
    expect(JSON.stringify(nodesNow())).toBe(before);
  });

  // No credential at all is now refused one step earlier, by the route's write gate (every write
  // needs an authenticated caller; see resolve-route-write-auth.test.ts), so it is 401, not 403.
  it("no credential gets 401 from the write gate; the deprecated bare body form is gated the same way", async () => {
    expect((await post(null, { ...seed, id: "sn-anon" })).status).toBe(401);
    const bare = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, id: "sn-bare" }) });
    expect(bare.status).toBe(401);
    expect(nodesNow().some((i) => i.id === "sn-anon" || i.id === "sn-bare")).toBe(false);
  });

  it("an admin credential writes", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, { ...seed, id: "sn-op" });
    expect(res.status).toBe(200);
    expect(nodesNow().some((i) => i.id === "sn-op")).toBe(true);
  });

  it("an operator re-seed that loses a compare-and-set race gets the ordinary envelope (conflict), not a 403", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, { ...seed, id: "sn-op", if_updated_at: "1999-01-01T00:00:00Z" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; body: { ok: boolean; conflict?: boolean } };
    expect(j.success).toBe(true);
    expect(j.body).toMatchObject({ ok: false, conflict: true });
  });

  it("a non-trust-root write through the same route needs an authenticated caller but no operator", async () => {
    const res = await post(`ApiKey ${FLEET_KEY}`, { type: "poolImpulse_write", id: "plain-2", shape: "timeShapedRhythm", body: {} });
    expect(res.status).toBe(200);
    expect((await post(null, { type: "poolImpulse_write", id: "plain-3", shape: "timeShapedRhythm", body: {} })).status).toBe(401);
  });
});

// calibrationWindow: a blind-calibration sample list (which dispatches are graded, under which seed, where the
// labels go). Whoever writes it chooses what the calibration measures, so the node's own key (the autonomous
// lane: node-self, scopes ["node"]) must not be able to write it; only an operator (admin) can.
describe("calibrationWindow is a trust-root pool shape", () => {
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });
  const cw = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "poolImpulse_write", id, shape: "calibrationWindow", status: "open",
    body: { window_id: id, sample_draw_id: "d1", seed: 7, dispatch_ids: ["a", "b"], declared_at: "2026-10-03T00:00:00Z", closes_at: "2026-10-10T00:00:00Z", label_sink: "calibrationLabel" },
    ...extra,
  });
  const cwRow = (id: string) => resolvePoolImpulse({ type: "poolImpulse", shape: "calibrationWindow", id }).body.impulses[0];

  it("MUST-FAIL: a node-self (node-scoped) key's calibrationWindow write is refused (403) and nothing is stored", async () => {
    const res = await post(`ApiKey ${NODE_KEY}`, cw("cw-node"));
    expect(res.status).toBe(403);
    expect(cwRow("cw-node")).toBeUndefined();
  });

  it("an admin write succeeds", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, cw("cw-admin"));
    expect(res.status).toBe(200);
    expect(cwRow("cw-admin")).toBeDefined();
  });

  it("MUST-FAIL: an update by id (shape omitted) of an existing calibrationWindow with the node key is refused; the row is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, cw("cw-upd"))).status).toBe(200);
    const before = JSON.stringify(cwRow("cw-upd"));
    const res = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "cw-upd", body: { dispatch_ids: ["planted"] } });
    expect(res.status).toBe(403);
    const retire = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "cw-upd", status: "retired" });
    expect(retire.status).toBe(403);
    expect(JSON.stringify(cwRow("cw-upd"))).toBe(before);
  });

  it("control: a non-trust-root write with the node key still succeeds", async () => {
    const res = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "plain-node", shape: "timeShapedRhythm", body: { x: 1 } });
    expect(res.status).toBe(200);
    expect(resolvePoolImpulse({ type: "poolImpulse", id: "plain-node" }).body.impulses).toHaveLength(1);
  });
});

// scriptRunnerAllowlist: which repo scripts local-tools-vessel's script runner may execute WITH the fleet
// credential injected, each pinned to an approved git blob hash. A write here is a grant to run code with
// METABOB_API_KEY, so the node's own key (the autonomous lane) must not create or change one; only an
// operator (admin) can, and the runner accepts only rows carrying the server's operator attestation.
describe("scriptRunnerAllowlist is a trust-root pool shape", () => {
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });
  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "poolImpulse_write", id, shape: "scriptRunnerAllowlist", status: "open",
    body: { script_id: id, path: "validation/scripts/run-weekly-harness.sh", blob_sha: "0".repeat(40), args_schema: [], timeout_s: 600, max_output_bytes: 65536 },
    ...extra,
  });
  const row = (id: string) => resolvePoolImpulse({ type: "poolImpulse", shape: "scriptRunnerAllowlist", id }).body.impulses[0];

  it("MUST-FAIL: a node-self (node-scoped) key's scriptRunnerAllowlist write is refused (403) and nothing is stored", async () => {
    const res = await post(`ApiKey ${NODE_KEY}`, entry("sra-node"));
    expect(res.status).toBe(403);
    expect(row("sra-node")).toBeUndefined();
  });

  it("MUST-FAIL: an update by id (shape omitted) of an approved entry with the node key is refused; the pinned hash is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, entry("sra-upd"))).status).toBe(200);
    const before = JSON.stringify(row("sra-upd"));
    const res = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "sra-upd", body: { script_id: "sra-upd", path: "x.sh", blob_sha: "f".repeat(40) } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(row("sra-upd"))).toBe(before);
  });

  it("an admin write succeeds and is stamped attested.by = operator (what the runner requires)", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, entry("sra-admin"));
    expect(res.status).toBe(200);
    const r = row("sra-admin") as unknown as { attested?: { by: string } } | undefined;
    expect(r?.attested?.by).toBe("operator");
  });
});

// SERVER-SIDE ATTESTATION. StandingImpulse.source is caller-supplied and proves nothing, so a reader (the
// human surface) could not tell an operator-written trust-root row from any other. The store's one writer
// stamps `attested` (outside body) on a trust-root write it accepted with an operator credential, and no
// caller can supply one: a caller's `attested`, top-level or inside body, is never stored as given.
describe("attested: the server stamps operator trust-root writes; callers cannot forge it", () => {
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });
  const forged = { by: "operator", key_id: "forged", at: "1999-01-01T00:00:00.000Z" };
  const rowOf = (id: string) => resolvePoolImpulse({ type: "poolImpulse", id }).body.impulses[0] as (Record<string, unknown> & { body: Record<string, unknown> }) | undefined;

  it("MUST-FAIL: an admin trust-root write is read back with attested {by:'operator', key_id, at}", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-admin", shape: "calibrationWindow", body: { window_id: "w1", dispatch_ids: ["a"] } });
    expect(res.status).toBe(200);
    const row = rowOf("att-admin");
    const att = row?.["attested"] as { by: string; key_id: string | null; at: string } | undefined;
    expect(att?.by).toBe("operator");
    expect(att?.key_id).toBe("k1");
    expect(Number.isNaN(Date.parse(String(att?.at)))).toBe(false);
    expect(att?.at).toBe(row?.["updated_at"] as string);
    // through the route's read door too
    const read = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { type: "poolImpulse", id: "att-admin" } }) });
    const j = (await read.json()) as { body: { impulses: Array<{ attested?: { by: string } }> } };
    expect(j.body.impulses[0]?.attested?.by).toBe("operator");
  });

  it("MUST-FAIL: a node-key NON-trust-root write that supplies attested (top-level and in body) is stored without it", async () => {
    const res = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "att-node", shape: "timeShapedRhythm", attested: forged, body: { x: 1, attested: forged } });
    expect(res.status).toBe(200);
    const row = rowOf("att-node");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("attested");
    expect(row!.body).not.toHaveProperty("attested");
    expect(row!.body["x"]).toBe(1);
  });

  it("an in-process non-trust-root write (no credential) with a forged attested is stored without it", () => {
    expect(resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "att-inproc", shape: "timeShapedRhythm", body: { y: 2, attested: forged } }).body.ok).toBe(true);
    const row = rowOf("att-inproc");
    expect(row).not.toHaveProperty("attested");
    expect(row!.body).not.toHaveProperty("attested");
  });

  it("MUST-FAIL: a caller-supplied attested on an admin trust-root write is overwritten by the server's stamp", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-forge-admin", shape: "calibrationWindow", attested: { by: "forged", key_id: "x", at: "1999-01-01T00:00:00.000Z" }, body: { window_id: "w2", attested: { by: "forged" } } });
    expect(res.status).toBe(200);
    const row = rowOf("att-forge-admin");
    const att = row?.["attested"] as { by: string; key_id: string | null; at: string };
    expect(att).toEqual({ by: "operator", key_id: "k1", at: row!["updated_at"] as string, sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row!.body).not.toHaveProperty("attested");
  });

  // The human surface reads calibration windows with exactly this request and takes `attested` from the ROW
  // (a sibling of body), ignoring any body-level one. Pin that location through the real route.
  it("the surface's read: {impulse:{pointer:{type:'poolImpulse', shape:'calibrationWindow', status:'open'}}} returns body.impulses[] rows with attested beside body, never inside it", async () => {
    const cwBody = { window_id: "w-surface", sample_draw_id: "d9", seed: 42, dispatch_ids: ["x", "y"], declared_at: "2026-10-03T00:00:00Z", closes_at: "2026-10-10T00:00:00Z", label_sink: "calibrationLabel" };
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-surface", shape: "calibrationWindow", status: "open", attested: forged, body: { ...cwBody, attested: forged } })).status).toBe(200);
    const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse", shape: "calibrationWindow", status: "open" } } }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { body: { impulses: Array<Record<string, unknown> & { body: Record<string, unknown> }> } };
    expect(Array.isArray(j.body.impulses)).toBe(true);
    const row = j.body.impulses.find((r) => r["id"] === "att-surface");
    expect(row).toBeDefined();
    expect(row!["shape"]).toBe("calibrationWindow");
    expect(row!["status"]).toBe("open");
    expect(row!.body).toEqual(cwBody);
    expect(row!.body).not.toHaveProperty("attested");
    expect(row!["attested"]).toEqual({ by: "operator", key_id: "k1", at: row!["updated_at"] as string, sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("an admin UPDATE by id (shape omitted) of a trust-root row re-stamps it at the update's time", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-restamp", shape: "calibrationWindow", body: { window_id: "w3" } })).status).toBe(200);
    await Bun.sleep(5);
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-restamp", attested: forged, body: { window_id: "w3", closes_at: "2026-11-01T00:00:00Z" } })).status).toBe(200);
    const row = rowOf("att-restamp");
    expect(row!["attested"]).toEqual({ by: "operator", key_id: "k1", at: row!["updated_at"] as string, sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row!["shape"]).toBe("calibrationWindow");
  });

  it("a node-key body update of a plain row cannot plant attested into the stored row or body", async () => {
    await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "att-plain-upd", shape: "timeShapedRhythm", body: { z: 1 } });
    await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "att-plain-upd", attested: forged, body: { z: 2, attested: forged } });
    const row = rowOf("att-plain-upd");
    expect(row).not.toHaveProperty("attested");
    expect(row!.body).toEqual({ z: 2 });
  });
});

// TRUST-ROOT MEMBERSHIP IS NOT EDITABLE IN PLACE. A row's shape decides whether it is a trust root, so an
// update by id may not move a row out of a trust-root shape (that would drop it from the gate and keep its
// id) nor into one (that would turn an ordinary row, written by anyone, into a trust root). The node key is
// refused by the credential check (403); an operator gets 409: retire the row and create a new one.
describe("a trust-root row's shape cannot change in place, in either direction", () => {
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });
  const rowOf = (id: string) => resolvePoolImpulse({ type: "poolImpulse", id }).body.impulses[0] as (Record<string, unknown> & { body: Record<string, unknown> }) | undefined;

  it("MUST-FAIL (A): an admin update that changes a calibrationWindow row's shape is 409 trust_root_shape_immutable; the row is unchanged and still attested", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "imm-cw", shape: "calibrationWindow", body: { window_id: "w-imm" } })).status).toBe(200);
    const before = JSON.stringify(rowOf("imm-cw"));
    const res = await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "imm-cw", shape: "timeShapedRhythm", body: { x: 1 } });
    expect(res.status).toBe(409);
    const j = (await res.json()) as { success: boolean; error?: string; body?: { ok: boolean; error?: string; hint?: string } };
    expect(j.success).toBe(false);
    expect(String(j.error)).toContain("trust_root_shape_immutable");
    expect(j.body?.hint).toContain("retire");
    expect(JSON.stringify(rowOf("imm-cw"))).toBe(before);
    expect(rowOf("imm-cw")!["shape"]).toBe("calibrationWindow");
    expect((rowOf("imm-cw")!["attested"] as { by: string }).by).toBe("operator");
  });

  it("MUST-FAIL (A, in process): the store writer itself refuses the reshape even with operator auth", () => {
    expect(resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "imm-sn", shape: "substrateNodes", body: { discovery_endpoints: [N1] } }, { operator: true }).body.ok).toBe(true);
    const r = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "imm-sn", shape: "autonomyScope" }, { operator: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("trust_root_shape_immutable");
    expect(rowOf("imm-sn")!["shape"]).toBe("substrateNodes");
  });

  it("control (A): an admin update keeping the same trust-root shape succeeds and re-stamps", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "imm-same", shape: "calibrationWindow", body: { window_id: "w-same" } })).status).toBe(200);
    const first = (rowOf("imm-same")!["attested"] as { at: string }).at;
    await Bun.sleep(5);
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "imm-same", shape: "calibrationWindow", body: { window_id: "w-same", seed: 3 } })).status).toBe(200);
    const row = rowOf("imm-same")!;
    expect(row.body).toEqual({ window_id: "w-same", seed: 3 });
    expect(row["attested"]).toEqual({ by: "operator", key_id: "k1", at: row["updated_at"] as string, sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((row["attested"] as { at: string }).at).not.toBe(first);
  });

  it("MUST-FAIL (B): a node-key update by id that names shape calibrationWindow on an ordinary row is refused (403); the row is unchanged", async () => {
    expect((await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "promo-node", shape: "timeShapedRhythm", body: { r: 1 } })).status).toBe(200);
    const before = JSON.stringify(rowOf("promo-node"));
    const res = await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "promo-node", shape: "calibrationWindow", body: { window_id: "planted" } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(rowOf("promo-node"))).toBe(before);
  });

  it("MUST-FAIL (B): an ADMIN promotion of an ordinary row into a trust-root shape is 409 too (create a new trust-root row instead); the row is unchanged", async () => {
    expect((await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "promo-admin", shape: "timeShapedRhythm", body: { r: 2 } })).status).toBe(200);
    const before = JSON.stringify(rowOf("promo-admin"));
    const res = await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "promo-admin", shape: "calibrationWindow", body: { window_id: "promoted" } });
    expect(res.status).toBe(409);
    expect(String(((await res.json()) as { error?: string }).error)).toContain("trust_root_shape_immutable");
    expect(JSON.stringify(rowOf("promo-admin"))).toBe(before);
    expect(rowOf("promo-admin")).not.toHaveProperty("attested");
  });

  it("control: an admin CREATE of a new trust-root row (fresh id) still succeeds, and an ordinary row may change between ordinary shapes", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "promo-fresh", shape: "calibrationWindow", body: { window_id: "fresh" } })).status).toBe(200);
    expect((await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "plain-reshape", shape: "timeShapedRhythm", body: {} })).status).toBe(200);
    expect((await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "plain-reshape", shape: "someOtherShape", body: {} })).status).toBe(200);
    expect(rowOf("plain-reshape")!["shape"]).toBe("someOtherShape");
  });
});

describe("self_fact_reconcile pool_record_pin: the record must equal the operator-seeded value", () => {
  const row = (pinned: Record<string, string[]> | undefined): sfr.SelfFactRow => ({
    id: "substrate_nodes_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/pool-impulse.ts",
    must_fail: "a planted endpoint must be reported", pool_shape: "substrateNodes", body_field: "discovery_endpoints", expected_by_node: pinned,
  });
  const me = () => thisNode();
  const stub = (rec: { id?: string; updated_at?: string; body?: unknown } | null) => __setPoolPinDepsForTests({ readNewest: async () => rec });
  const real = (r: sfr.SelfFactResult | null) => (r?.divergences ?? []).filter((d) => !d.canary);

  it("MUST-FAIL: a record carrying an endpoint the operator did not seed is a mismatch divergence", async () => {
    stub({ id: "substrate-nodes", updated_at: "2026-10-01T00:00:00Z", body: { discovery_endpoints: [N1, N2, ROGUE] } });
    const r = await evaluateSelfFactRow(row({ [me()]: [N1, N2] }));
    expect(r?.source_read).toBe(true);
    const d = real(r);
    expect(d.map((x) => x.key)).toEqual([`${me()}-mismatch`]);
    expect(d[0]!.detail).toContain(ROGUE);
  });

  it("a removed node is a mismatch too", async () => {
    stub({ id: "substrate-nodes", body: { discovery_endpoints: [N1] } });
    const d = real(await evaluateSelfFactRow(row({ [me()]: [N1, N2] })));
    expect(d.map((x) => x.key)).toEqual([`${me()}-mismatch`]);
  });

  it("a missing record is a divergence", async () => {
    stub(null);
    const d = real(await evaluateSelfFactRow(row({ [me()]: [N1, N2] })));
    expect(d.map((x) => x.key)).toEqual([`${me()}-missing`]);
  });

  it("control: the seeded value (order and trailing slash aside) reads clean, and the canary is reported", async () => {
    stub({ id: "substrate-nodes", body: { discovery_endpoints: [`${N2}/`, N1] } });
    const r = await evaluateSelfFactRow(row({ [me()]: [N1, N2] }));
    expect(real(r)).toEqual([]);
    expect(r?.divergences.some((d) => d.canary)).toBe(true);
  });

  // A trust root this node HOLDS with no pinned value for this node is unguarded: that is a finding, never a quiet
  // skip (node1 lost both pins to a hostname change on 2026-10-04 and nothing said so for a day).
  it("MUST-FAIL: a node holding the record with no pinned value is an UNPINNED divergence, and the canary is reported", async () => {
    stub({ id: "substrate-nodes", body: { discovery_endpoints: [ROGUE] } });
    const r = await evaluateSelfFactRow(row({ "some-other-node": [N1] }));
    expect(r?.source_read).toBe(true);
    const d = real(r);
    expect(d.map((x) => x.key)).toEqual([`${me()}-unpinned`]);
    expect(d[0]!.detail).toContain("some-other-node");
    expect(r?.divergences.some((x) => x.canary)).toBe(true);
  });

  it("control: a node holding NO record of the shape and no pinned value is not judged (unobserved), never clean", async () => {
    stub(null);
    const r = await evaluateSelfFactRow(row({ "some-other-node": [N1] }));
    expect(r?.source_read).toBe(false);
  });

  // Runs the resolver over one row naming only "other-node" (a row about another substrate's nodes in this
  // fleet-shared file), with this node's pool store holding `held` for the row's shape.
  async function runForeignRow(dir: string, held: { id?: string; body?: unknown } | null) {
    const { resolveSelfFactReconcile } = sfr;
    stub(held);
    const prev = process.env["SUPER_REPO_ROOT"];
    const repo = join(ROOT, dir);
    mkdirSync(join(repo, "scripts", "substrate"), { recursive: true });
    const rows = { rows: [{ ...row({ "other-node": [N1] }), nodes: ["other-node"] }] };
    await Bun.write(join(repo, "scripts", "substrate", "self-facts.json"), JSON.stringify(rows));
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "rows"]); g(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    process.env["SUPER_REPO_ROOT"] = repo;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      return (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false })).body as { rows_checked: string[]; unobserved_rows: string[]; divergences: Array<{ key: string }> };
    } finally {
      logSpy.mockRestore();
      if (prev === undefined) delete process.env["SUPER_REPO_ROOT"]; else process.env["SUPER_REPO_ROOT"] = prev;
    }
  }

  it("a row naming other nodes is SKIPPED on a node that holds no such record: the run stays observed (not turned unobserved by a foreign row)", async () => {
    const r = await runForeignRow("super-foreign-none", null);
    expect(r.rows_checked).toEqual([]);
    expect(r.unobserved_rows).toEqual([]);
  });

  it("MUST-FAIL: a trust-root pin row that does not list this node still runs here when this node HOLDS the record, and reports it unpinned", async () => {
    const r = await runForeignRow("super-foreign-held", { id: "substrate-nodes", body: { discovery_endpoints: [ROGUE] } });
    expect(r.rows_checked).toEqual(["substrate_nodes_pinned"]);
    expect(r.unobserved_rows).toEqual([]);
    expect(r.divergences.map((d) => d.key)).toEqual([`${me()}-unpinned`]);
  });

  it("through the real pool store: an operator-seeded record matches; a later non-operator rewrite is refused, so it still matches", async () => {
    __setPoolPinDepsForTests(null);
    resolvePoolImpulseWrite({ ...seed, id: "substrate-nodes", body: { discovery_endpoints: [N1, N2] } }, { operator: true });
    resolvePoolImpulseWrite({ ...seed, id: "substrate-nodes", body: { discovery_endpoints: [N1, N2, ROGUE] } });
    const r = await evaluateSelfFactRow(row({ [me()]: [N1, N2] }));
    expect(real(r)).toEqual([]);
  });
});

// SIGNED ATTESTATION. A reader on another vessel (local-tools-vessel's script runner) gets rows over HTTP from
// whatever producer discovery lists as "local", and discovery stamps ANY authenticated plain registration
// "local": a rogue poolImpulse producer could serve rows with a forged `attested` (key ids are not secret).
// So the stamp carries `sig`: HMAC-SHA256 under this node's own key (METABOB_API_KEY, which only this node's
// vessels hold; a spoke's is hub-issued per spoke, a root's is minted at random) over the exact row content.
// A peer's development-vessel signs with ITS key and fails verification here. The wire format is pinned
// below with an independent implementation, because local-tools-vessel recomputes it.
describe("attested.sig: the stamp is signed under this node's key over the stored row", () => {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  };
  const expectedSig = (key: string, r: Record<string, unknown>) => {
    const a = r["attested"] as { key_id: string | null; at: string };
    return createHmac("sha256", key).update(["substrate-pool-attestation/v1", r["id"], r["shape"], r["status"], canon(r["body"]), a.key_id ?? "", a.at].join("\n")).digest("hex");
  };
  const post = (auth: string | null, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ impulse: pointer }),
  });
  const rowOf = (id: string) => resolvePoolImpulse({ type: "poolImpulse", id }).body.impulses[0] as unknown as Record<string, unknown> | undefined;
  const body = { z_last: 1, script_id: "sig-a", path: "validation/scripts/x.sh", blob_sha: "a".repeat(40), args_schema: [{ name: "m", type: "string", enum: ["q"] }], nested: { b: 2, a: 1 } };

  it("MUST-FAIL: an admin trust-root write carries sig = HMAC(node key, v1 | id | shape | status | canonical(body) | key_id | at)", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "sig-a", shape: "scriptRunnerAllowlist", status: "open", body })).status).toBe(200);
    const r = rowOf("sig-a")!;
    const sig = (r["attested"] as { sig?: string }).sig;
    expect(sig).toBe(expectedSig(NODE_KEY, r));
    // a different key (a peer node's) gives a different signature
    expect(sig).not.toBe(expectedSig("some-peer-node-key", r));
  });

  it("MUST-FAIL: the signature covers the body: an admin body change re-signs, and the old sig no longer matches", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "sig-b", shape: "scriptRunnerAllowlist", status: "open", body })).status).toBe(200);
    const first = rowOf("sig-b")!;
    const firstSig = (first["attested"] as { sig: string }).sig;
    await Bun.sleep(5);
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "sig-b", body: { ...body, blob_sha: "b".repeat(40) } })).status).toBe(200);
    const second = rowOf("sig-b")!;
    expect((second["attested"] as { sig: string }).sig).toBe(expectedSig(NODE_KEY, second));
    expect((second["attested"] as { sig: string }).sig).not.toBe(firstSig);
    // the old stamp's sig does not verify over the new body
    expect(expectedSig(NODE_KEY, { ...second, attested: first["attested"] })).not.toBe(firstSig);
  });

  it("the key is read at write time; with no node key the row is stamped without sig and the store warns (readers then refuse it)", async () => {
    delete process.env["METABOB_API_KEY"];
    const r = resolvePoolImpulseWrite({ type: "poolImpulse_write", id: "sig-nokey", shape: "scriptRunnerAllowlist", status: "open", body }, { operator: true, key_id: "k1" });
    expect(r.body.ok).toBe(true);
    const row = rowOf("sig-nokey")!;
    expect((row["attested"] as { by: string }).by).toBe("operator");
    expect(row["attested"]).not.toHaveProperty("sig");
    expect(warnSpy!.mock.calls.some((c) => String(c[0]).includes("unsigned"))).toBe(true);
  });

  it("a non-trust-root write carries no attestation and so no sig (control)", async () => {
    expect((await post(`ApiKey ${NODE_KEY}`, { type: "poolImpulse_write", id: "sig-plain", shape: "timeShapedRhythm", body: { x: 1 } })).status).toBe(200);
    expect(rowOf("sig-plain")).not.toHaveProperty("attested");
  });
});

// posteriorReplayAuthorization: the operator's go for activity-api's β-leak replay writes. activity-api trusts the
// attested_verified verdict that THIS node's poolImpulse read adds (it never holds the attestation key), so the
// verdict must be false for anything but an operator stamp that verifies under this node's key.
describe("posteriorReplayAuthorization is a trust-root pool shape, and the pool read reports attested_verified", () => {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const FILE = join(ROOT, "replay-auth-pool.json");
  const body = { node: "local-dev-spoke", list_sha256: "a".repeat(64), eligibility_sha256: "b".repeat(64), by: "operator:avi", at: "2026-10-10T00:00:00Z", reason: "test", review_by: "2026-10-17T00:00:00Z" };
  const w = { type: "poolImpulse_write", id: "pra-1", shape: "posteriorReplayAuthorization", status: "open" as const, body };
  const read = async () => {
    const res = await impulsesRouter.request("/v2/impulses/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "posteriorReplayAuthorization", status: "open" } }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { body: { impulses: Array<Record<string, unknown>> } };
    return new Map(j.body.impulses.map((r) => [String(r["id"]), r]));
  };
  // The writer's signature, recomputed here independently (as in the attested.sig describe above).
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  };
  const sigUnder = (key: string, id: string, at: string) => createHmac("sha256", key).update(["substrate-pool-attestation/v1", id, "posteriorReplayAuthorization", "open", canon(body), "k1", at].join("\n")).digest("hex");
  const row = (id: string, attested: Record<string, unknown> | undefined) => ({ id, shape: "posteriorReplayAuthorization", body, source: "x", status: "open", injected_at: body.at, updated_at: body.at, ...(attested ? { attested } : {}) });

  beforeEach(() => { pool.__setPoolFileForTests(FILE); writeFileSync(FILE, "[]"); });
  afterEach(() => pool.__setPoolFileForTests(null));

  it("MUST-FAIL: a write without an operator credential is refused and nothing is stored", () => {
    for (const auth of [undefined, { operator: false }, { operator: false, evaluator: "scope_earn_in_apply" }]) {
      const r = resolvePoolImpulseWrite(w, auth);
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toContain("operator_credential_required");
    }
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "posteriorReplayAuthorization" }).body.count).toBe(0);
  });

  it("MUST-FAIL: forged, unsigned, peer-signed and unattested rows read attested_verified:false through the route", async () => {
    writeFileSync(FILE, JSON.stringify([
      row("pra-forged", { by: "operator", key_id: "k1", at: body.at, sig: "f".repeat(64) }),
      row("pra-unsigned", { by: "operator", key_id: "k1", at: body.at }),
      row("pra-peer", { by: "operator", key_id: "k1", at: body.at, sig: sigUnder("some-peer-node-key", "pra-peer", body.at) }),
      row("pra-evaluator", { by: "evaluator", evaluator: "scope_earn_in_apply", key_id: null, at: body.at, sig: sigUnder(NODE_KEY, "pra-evaluator", body.at) }),
      row("pra-none", undefined),
      // positive control in the same file: this node's key, the writer's exact string
      row("pra-good", { by: "operator", key_id: "k1", at: body.at, sig: sigUnder(NODE_KEY, "pra-good", body.at) }),
    ]));
    const rows = await read();
    for (const id of ["pra-forged", "pra-unsigned", "pra-peer", "pra-evaluator", "pra-none"]) expect([id, rows.get(id)?.["attested_verified"]]).toEqual([id, false]);
    expect(rows.get("pra-good")?.["attested_verified"]).toBe(true);
  });

  it("control: an operator write through the store's one writer reads back attested_verified:true", async () => {
    expect(resolvePoolImpulseWrite(w, { operator: true, key_id: "k1" }).body.ok).toBe(true);
    const r = (await read()).get("pra-1");
    expect(r?.["attested"]).toMatchObject({ by: "operator", key_id: "k1" });
    expect(r?.["attested_verified"]).toBe(true);
    // ...and false once this node's key is not the one it was signed under
    process.env["METABOB_API_KEY"] = "a-different-node-key";
    expect((await read()).get("pra-1")?.["attested_verified"]).toBe(false);
  });
});
