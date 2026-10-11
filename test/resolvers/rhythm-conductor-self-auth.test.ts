// rhythm_conductor_tick CALLS THIS VESSEL OVER HTTP, and this vessel's resolve route refuses every write that
// does not carry an ApiKey (src/routes/impulses.ts refuseUnauthenticatedWrite: isWritePointerType, then
// identityCredential). The tick's write-backs (settleRhythm's poolImpulse_write, the structural-break
// substrateGap_write) went out with only a Content-Type, so on a live node every one was refused 401
// ("REFUSED unauthenticated poolImpulse_write: no ApiKey credential presented") and swallowed by the
// best-effort fetch: rhythms never settled, and nothing said so.
//
// The stub below stands in for this vessel's own route and runs the gate's real decision functions on each
// request, with identity unreachable (IDENTITY_VESSEL_URL unset) so only the node's own key can pass. The
// node key reaches the self endpoint and nowhere else: a caller-supplied registry endpoint gets no key.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRhythmConductorTick } from "../../src/resolvers/rhythm-conductor-tick.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { identityCredential, isWritePointerType, __resetCredentialCacheForTests } from "../../src/lib/caller-credential.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const NODE_KEY = "rhythm-self-auth-test-node-key";
// The module reads its self endpoint at import; mirror that read so the test follows a deployment's override.
const SELF_RESOLVE_URL = `${process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090"}/v2/impulses/resolve`;

const originalFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["METABOB_API_KEY", "IDENTITY_VESSEL_URL"]) saved[k] = process.env[k];
  process.env["METABOB_API_KEY"] = NODE_KEY;
  delete process.env["IDENTITY_VESSEL_URL"];
  __resetCredentialCacheForTests();
  __resetPolicyReadsForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetCredentialCacheForTests();
  __resetPolicyReadsForTests();
});

type Seen = { url: string; type: string; authorization: string | null; status: number };

const DUE_GAP_CLOSING = {
  id: "rhythm-gap-closing",
  shape: "timeShapedRhythm",
  body: { axis: "gap", axis_code: 3, family: "gap-closing", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 },
};

/** A stand-in for this vessel's resolve route (at `selfUrl`) that applies the write gate to every request. */
function gatedVessel(selfUrl: string, seen: Seen[], opts: { registryFails?: boolean } = {}): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Discovery names one pool producer; the spend envelope read succeeds with an explicit uncapped record.
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (url.startsWith("http://pool.fixture") && body?.impulse?.shape === "spendEnvelope") return openPolicyAnswer("spendEnvelope");
    if (url !== selfUrl) return new Response("not found", { status: 404 });

    const type = String(body?.impulse?.type ?? body?.impulse?.pointer?.type ?? "");
    const authorization = new Headers(init?.headers).get("authorization");
    const record = (status: number): void => void seen.push({ url, type, authorization, status });
    if (isWritePointerType(type)) {
      const cred = await identityCredential(authorization ?? undefined);
      if (!cred.authenticated) {
        record(401);
        return Response.json({ success: false, error: `caller_credential_required: ${type} is a write; ${cred.why}` }, { status: 401 });
      }
    }
    record(200);
    if (type === "poolImpulse" && body.impulse.shape === "timeShapedRhythm") {
      if (opts.registryFails) return new Response("registry down", { status: 500 });
      return Response.json({ body: { impulses: [DUE_GAP_CLOSING], count: 1 } });
    }
    if (type === "poolImpulse") return Response.json({ body: { impulses: [], count: 0 } });
    return Response.json({ body: { ok: true } });
  }) as unknown as typeof fetch;
}

function queueFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), "rct-auth-")), "queue.json");
  writeFileSync(p, JSON.stringify({ tasks: [], lastUpdated: 0 }));
  return p;
}

describe("rhythm_conductor_tick self-calls carry the node key", () => {
  it("settleRhythm's poolImpulse_write to this vessel carries the node key and is NOT refused by the write gate", async () => {
    const seen: Seen[] = [];
    globalThis.fetch = gatedVessel(SELF_RESOLVE_URL, seen);

    const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, queue_path: queueFile() });
    expect((r.body as any).enqueued.map((e: any) => e.family)).toEqual(["gap-closing"]); // the fire happened

    const settles = seen.filter((s) => s.type === "poolImpulse_write");
    expect(settles.length).toBeGreaterThan(0);
    for (const s of settles) {
      expect(s.authorization).toBe(`ApiKey ${NODE_KEY}`);
      expect(s.status).toBe(200);
    }
  });

  it("the structural-break substrateGap_write to this vessel carries the node key and is NOT refused", async () => {
    const seen: Seen[] = [];
    globalThis.fetch = gatedVessel(SELF_RESOLVE_URL, seen, { registryFails: true });

    const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, queue_path: queueFile() });
    expect((r.body as any).structural_break).toBe("registry_empty");

    const gapWrites = seen.filter((s) => s.type === "substrateGap_write");
    expect(gapWrites.length).toBe(1);
    expect(gapWrites[0]!.authorization).toBe(`ApiKey ${NODE_KEY}`);
    expect(gapWrites[0]!.status).toBe(200);
  });

  it("every request the tick sends to this vessel carries the node key, reads included", async () => {
    const seen: Seen[] = [];
    globalThis.fetch = gatedVessel(SELF_RESOLVE_URL, seen);
    await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, queue_path: queueFile() });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((s) => s.authorization !== `ApiKey ${NODE_KEY}`).map((s) => s.type)).toEqual([]);
  });

  it("MUST-FAIL GUARD: a caller-supplied registry endpoint never receives the node key", async () => {
    const elsewhere = "http://caller-supplied.example/v2/impulses/resolve";
    const seen: Seen[] = [];
    globalThis.fetch = gatedVessel(elsewhere, seen);

    await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", bucket_load: 0, queue_path: queueFile(), registry_endpoint: elsewhere });
    // The tick did talk to that endpoint (read and settle), and sent it no credential at all.
    expect(seen.some((s) => s.type === "poolImpulse_write")).toBe(true);
    expect(seen.filter((s) => s.authorization !== null).map((s) => `${s.type}:${s.authorization === null ? "" : "has-auth"}`)).toEqual([]);
  });
});
