// daemonAuthPolicy is a TRUST-ROOT pool shape: the per-node mode (report/enforce) of the VesselDaemon
// mutating-shape gate (ias-executor-ts src/hosts/vessel-daemon.ts, user ruling 2026-10-20 "Report first,
// enforce by 20:00Z"). A row any authenticated key could write would let any caller switch its node's gate to
// report, so only an operator credential (identity resolves the key with the "admin" scope) writes it, and the
// daemon honours a row only when this node's read marks it attested_verified by operator.
//
// MUST-FAIL at the parent: there daemonAuthPolicy is an ordinary pool shape, so the fleet key and the node key
// write it (200) and an enforce row is flipped to report.
// identity-vessel is stood in for by globalThis.fetch; the pool store is a real file under a temp root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `pool-daemon-auth-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;

const pool = await import("../../src/resolvers/pool-impulse.js");
const { resolvePoolImpulse } = pool;
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"pool-daemon-auth-policy"}`);

const IDENTITY = "http://127.0.0.1:59106";
const ADMIN_KEY = "admin-key-fixture";
const FLEET_KEY = "fleet-key-fixture";
const NODE_KEY = "node-key-fixture";
const FILE = join(ROOT, "daemon-auth-policy-pool.json");

const originalFetch = globalThis.fetch;
function installIdentity(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      if (key === ADMIN_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k1", scopes: ["read", "write", "admin"] } });
      if (key === FLEET_KEY) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k2", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
}

let warnSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  process.env["METABOB_API_KEY"] = NODE_KEY;
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
afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const post = (auth: string | null, impulse: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify({ impulse }),
});
// The write and read exactly as the rollout makes them (one row per node, id = shape).
const write = (mode: string, shape = "daemonAuthPolicy") => ({ type: "poolImpulse_write", shape, id: shape, status: "open", source: "operator-rollout", body: { mode } });
const readRow = async (shape = "daemonAuthPolicy") => {
  const res = await post(null, { pointer: { type: "poolImpulse", shape, status: "open", limit: 1 } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { body: { impulses: Array<Record<string, unknown>> } }).body.impulses[0];
};

describe("daemonAuthPolicy is written by an operator only", () => {
  it("is a member of TRUST_ROOT_POOL_SHAPES", () => {
    expect(pool.TRUST_ROOT_POOL_SHAPES.has("daemonAuthPolicy")).toBe(true);
  });

  it("an admin write succeeds and reads back attested_verified by operator (what the daemon requires)", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, write("enforce"));
    expect(res.status).toBe(200);
    const row = await readRow();
    expect((row?.["body"] as { mode?: string })?.mode).toBe("enforce");
    expect(row?.["attested_verified"]).toBe(true);
    expect((row?.["attested"] as { by?: string })?.by).toBe("operator");
  });

  it("MUST-FAIL: a non-admin key (read,write) writing enforce→report is refused 403 and the mode is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write("enforce"))).status).toBe(200);
    const before = JSON.stringify(resolvePoolImpulse({ type: "poolImpulse", shape: "daemonAuthPolicy" }).body.impulses);
    const res = await post(`ApiKey ${FLEET_KEY}`, write("report"));
    expect(res.status).toBe(403);
    expect(JSON.stringify(resolvePoolImpulse({ type: "poolImpulse", shape: "daemonAuthPolicy" }).body.impulses)).toBe(before);
    expect(((await readRow())?.["body"] as { mode?: string })?.mode).toBe("enforce");
  });

  it("MUST-FAIL: the node's own key (node-self, every vessel on the node holds it) is refused 403 and the mode is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write("enforce"))).status).toBe(200);
    const res = await post(`ApiKey ${NODE_KEY}`, write("report"));
    expect(res.status).toBe(403);
    expect(((await readRow())?.["body"] as { mode?: string })?.mode).toBe("enforce");
  });

  it("MUST-FAIL: a non-admin first write (no row yet) is refused and nothing is stored", async () => {
    expect((await post(`ApiKey ${FLEET_KEY}`, write("report"))).status).toBe(403);
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "daemonAuthPolicy" }).body.count).toBe(0);
  });

  it("no credential is refused (401) and nothing is stored", async () => {
    expect((await post(null, write("report"))).status).toBe(401);
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "daemonAuthPolicy" }).body.count).toBe(0);
  });

  it("the revert path: an admin write of report over enforce succeeds", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write("enforce"))).status).toBe(200);
    expect((await post(`ApiKey ${ADMIN_KEY}`, write("report"))).status).toBe(200);
    expect(((await readRow())?.["body"] as { mode?: string })?.mode).toBe("report");
  });
});

describe("controls: nothing else changes", () => {
  it("fedIngressAuthPolicy was already operator-only: a non-admin write is 403 (green at the parent too)", async () => {
    expect((await post(`ApiKey ${FLEET_KEY}`, write("off", "fedIngressAuthPolicy"))).status).toBe(403);
    expect((await post(`ApiKey ${ADMIN_KEY}`, write("log", "fedIngressAuthPolicy"))).status).toBe(200);
  });

  it("another pool shape written with a non-admin key is still accepted", async () => {
    const res = await post(`ApiKey ${FLEET_KEY}`, { type: "poolImpulse_write", id: "plain-1", shape: "timeShapedRhythm", status: "open", body: { x: 1 } });
    expect(res.status).toBe(200);
    expect(resolvePoolImpulse({ type: "poolImpulse", id: "plain-1" }).body.impulses).toHaveLength(1);
  });
});
