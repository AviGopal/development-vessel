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
const { impulsesRouter } = await import("../../src/routes/impulses.js");
const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { evaluateSelfFactRow, __setPoolPinDepsForTests, thisNode } = sfr;

const IDENTITY = "http://identity.test:8101";
const ADMIN_KEY = "admin-key-fixture";
const FLEET_KEY = "fleet-key-fixture";
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
  identityMode = "up";
  installIdentity();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["IDENTITY_VESSEL_URL"];
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
