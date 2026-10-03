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
    expect(att).toEqual({ by: "operator", key_id: "k1", at: row!["updated_at"] as string });
    expect(row!.body).not.toHaveProperty("attested");
  });

  it("an admin UPDATE by id (shape omitted) of a trust-root row re-stamps it at the update's time", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-restamp", shape: "calibrationWindow", body: { window_id: "w3" } })).status).toBe(200);
    await Bun.sleep(5);
    expect((await post(`ApiKey ${ADMIN_KEY}`, { type: "poolImpulse_write", id: "att-restamp", attested: forged, body: { window_id: "w3", closes_at: "2026-11-01T00:00:00Z" } })).status).toBe(200);
    const row = rowOf("att-restamp");
    expect(row!["attested"]).toEqual({ by: "operator", key_id: "k1", at: row!["updated_at"] as string });
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

  it("a node with no pinned value is not judged (unobserved), never clean", async () => {
    stub({ id: "substrate-nodes", body: { discovery_endpoints: [ROGUE] } });
    const r = await evaluateSelfFactRow(row({ "some-other-node": [N1] }));
    expect(r?.source_read).toBe(false);
  });

  it("a row naming other nodes is SKIPPED on this node: the run stays observed (not turned unobserved by a foreign row)", async () => {
    const { resolveSelfFactReconcile } = sfr;
    const prev = process.env["SUPER_REPO_ROOT"];
    const repo = join(ROOT, "super");
    mkdirSync(join(repo, "scripts", "substrate"), { recursive: true });
    const rows = { rows: [{ ...row({ "other-node": [N1] }), nodes: ["other-node"] }] };
    await Bun.write(join(repo, "scripts", "substrate", "self-facts.json"), JSON.stringify(rows));
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "rows"]); g(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    process.env["SUPER_REPO_ROOT"] = repo;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const r = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false })).body as { rows_checked: string[]; unobserved_rows: string[] };
      expect(r.rows_checked).toEqual([]);
      expect(r.unobserved_rows).toEqual([]);
    } finally {
      logSpy.mockRestore();
      if (prev === undefined) delete process.env["SUPER_REPO_ROOT"]; else process.env["SUPER_REPO_ROOT"] = prev;
    }
  });

  it("through the real pool store: an operator-seeded record matches; a later non-operator rewrite is refused, so it still matches", async () => {
    __setPoolPinDepsForTests(null);
    resolvePoolImpulseWrite({ ...seed, id: "substrate-nodes", body: { discovery_endpoints: [N1, N2] } }, { operator: true });
    resolvePoolImpulseWrite({ ...seed, id: "substrate-nodes", body: { discovery_endpoints: [N1, N2, ROGUE] } });
    const r = await evaluateSelfFactRow(row({ [me()]: [N1, N2] }));
    expect(real(r)).toEqual([]);
  });
});
