// activityVariantMask is a TRUST-ROOT pool shape: it chooses which variant of an activity runs and when (the reach-grade
// activity's variant at every grade, learning-credit.ts reachGradeVariant; discovery's peer-set source). A row any
// authenticated key could write would let the autonomous lane, or a peer, pick the variant of its own grading, so only an
// operator credential (identity resolves the key with the "admin" scope) writes it, and the row reads back
// attested_verified by operator.
//
// MUST-FAIL at the parent: there activityVariantMask is an ordinary pool shape, so the fleet key and the node key write
// it (200) and an operator's variant-0 window is replaced.
// identity-vessel is stood in for by globalThis.fetch; the pool store is a real file under a temp root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
useUngatedRowsSource();

const ROOT = join(tmpdir(), `pool-activity-variant-mask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;

const pool = await import("../../src/resolvers/pool-impulse.js");
const { resolvePoolImpulse } = pool;
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"pool-activity-variant-mask"}`);

const IDENTITY = "http://127.0.0.1:59107";
const ADMIN_KEY = "admin-key-fixture";
const FLEET_KEY = "fleet-key-fixture";
const NODE_KEY = "node-key-fixture";
const FILE = join(ROOT, "activity-variant-mask-pool.json");

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
// The mask as the operator writes it: one row per activity, the explicit baseline window first.
const ID = "mask-reach-grade";
const DAY = 86_400_000;
const write = (active_variant: number) => ({
  type: "poolImpulse_write", shape: "activityVariantMask", id: ID, status: "open", source: "operator",
  body: { activity_id: "development-vessel:reach-grade", active_variant, from: new Date(Date.now() - DAY).toISOString(), until: new Date(Date.now() + DAY).toISOString(), reason: "baseline window", lift: "research opens window A", by: "operator" },
});
const readRow = async () => {
  const res = await post(null, { pointer: { type: "poolImpulse", shape: "activityVariantMask", status: "open", limit: 1 } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { body: { impulses: Array<Record<string, unknown>> } }).body.impulses[0];
};
const variantOf = (row: Record<string, unknown> | undefined) => (row?.["body"] as { active_variant?: number } | undefined)?.active_variant;

describe("activityVariantMask is written by an operator only", () => {
  it("is a member of TRUST_ROOT_POOL_SHAPES", () => {
    expect(pool.TRUST_ROOT_POOL_SHAPES.has("activityVariantMask")).toBe(true);
  });

  it("an admin write succeeds and reads back attested_verified by operator", async () => {
    const res = await post(`ApiKey ${ADMIN_KEY}`, write(0));
    expect(res.status).toBe(200);
    const row = await readRow();
    expect(variantOf(row)).toBe(0);
    expect(row?.["attested_verified"]).toBe(true);
    expect((row?.["attested"] as { by?: string })?.by).toBe("operator");
  });

  it("MUST-FAIL: a non-admin key (read,write) switching the variant is refused 403 and the variant is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write(0))).status).toBe(200);
    const before = JSON.stringify(resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask" }).body.impulses);
    expect((await post(`ApiKey ${FLEET_KEY}`, write(1))).status).toBe(403);
    expect(JSON.stringify(resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask" }).body.impulses)).toBe(before);
    expect(variantOf(await readRow())).toBe(0);
  });

  it("MUST-FAIL: the node's own key (every vessel on the node holds it) is refused 403 and the variant is unchanged", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write(0))).status).toBe(200);
    expect((await post(`ApiKey ${NODE_KEY}`, write(1))).status).toBe(403);
    expect(variantOf(await readRow())).toBe(0);
  });

  it("MUST-FAIL: a non-admin first write (no row yet) is refused and nothing is stored", async () => {
    expect((await post(`ApiKey ${FLEET_KEY}`, write(1))).status).toBe(403);
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask" }).body.count).toBe(0);
  });

  it("no credential is refused (401) and nothing is stored", async () => {
    expect((await post(null, write(1))).status).toBe(401);
    expect(resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask" }).body.count).toBe(0);
  });

  it("the window switch: an admin write of variant-1 over variant-0 succeeds", async () => {
    expect((await post(`ApiKey ${ADMIN_KEY}`, write(0))).status).toBe(200);
    expect((await post(`ApiKey ${ADMIN_KEY}`, write(1))).status).toBe(200);
    expect(variantOf(await readRow())).toBe(1);
  });
});

describe("controls: nothing else changes", () => {
  it("another pool shape written with a non-admin key is still accepted", async () => {
    const res = await post(`ApiKey ${FLEET_KEY}`, { type: "poolImpulse_write", id: "plain-1", shape: "timeShapedRhythm", status: "open", body: { x: 1 } });
    expect(res.status).toBe(200);
    expect(resolvePoolImpulse({ type: "poolImpulse", id: "plain-1" }).body.impulses).toHaveLength(1);
  });
});
