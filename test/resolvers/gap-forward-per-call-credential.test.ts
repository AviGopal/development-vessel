// A FORWARDED GAP-STORE CALL AUTHENTICATES PER CALL, AND NEVER SENDS A KEY IN CLEARTEXT (2026-10-22).
//
// CONTRACT (resolvers/substrate-gap.ts forwardToGapStore, lib/call-credential.ts, lib/caller-credential.ts):
//   - a held gap-store call this node's route received is forwarded with THAT caller's own credential, both the
//     gate read and the write, so the holder's identity decides about the caller;
//   - a write this node makes itself (no route call) is forwarded with the node key;
//   - any key goes only over https, or over http to a host shown private (the identity check, reused): otherwise
//     the call goes keyless, a read still answers, and a refused write is typed gap_store_cleartext_refused.
//
// SEAM: a fake holder and a stubbed identity, both on loopback (Bun.serve), and, for the hosts that must not get a
// key, a globalThis.fetch stub on reserved `.invalid` names (RFC 2606). A scratch store root; no live service.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";

const publishStub = stubGapEventPublish();
const ROOT = join(tmpdir(), `gap-forward-per-call-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED: Record<string, string | undefined> = {};
for (const k of ["WORKSPACE_ROOT", "GAP_STORE_ENDPOINT", "METABOB_API_KEY", "IDENTITY_VESSEL_URL"]) SAVED[k] = process.env[k];
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];
const gapMod = await import("../../src/resolvers/substrate-gap.js");
const cc = await import("../../src/lib/caller-credential.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-forward-per-call"}`);
if (SAVED["WORKSPACE_ROOT"] === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED["WORKSPACE_ROOT"];

const SUFFIX = Math.random().toString(36).slice(2, 8);
const NODE_KEY = `fixture-node-key-${SUFFIX}`;
const CALLER_KEY = `fixture-caller-key-${SUFFIX}`;
const AT = "2026-10-22T08:00:00.000Z";
const gap = (id: string) => ({ id, category: "systematic_failure", source: "substrate_detected", summary: `a fixture gap ${id} the holder stores`, detected_at: AT, status: "open", classification_metadata: {} });

type Seen = { type: string; auth: string | null };
let seen: Seen[] = [];
const holderAnswer = (type: string, id: unknown, authed: boolean): Response =>
  type === "substrateGap"
    ? Response.json({ success: true, shape: "substrateGap", body: { gaps: [], total: 0 } })
    : authed
      ? Response.json({ success: true, shape: "substrateGapWriteResult", body: { id, action: "created" } })
      : Response.json({ success: false, error: `caller_credential_required: ${type} is a write; no Authorization header` }, { status: 401 });
let holder: ReturnType<typeof Bun.serve> | null = null;
let identity: ReturnType<typeof Bun.serve> | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (!gapMod.isScratchGapStoreRoot(gapMod.gapStoreRootForTest())) throw new Error("per-call credential test refused: the store root is not a scratch root");
  holder = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (req) => {
      const p = ((await req.json()) as { impulse: { pointer: { type: string; gap?: { id?: unknown } } } }).impulse.pointer;
      const auth = req.headers.get("authorization");
      seen.push({ type: p.type, auth });
      return holderAnswer(p.type, p.gap?.id, auth !== null);
    },
  });
  identity = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: async (req) => {
      const key = ((await req.json()) as { impulse?: { pointer?: { apiKey?: string } } }).impulse?.pointer?.apiKey;
      return key === CALLER_KEY ? Response.json({ success: true, data: { authenticated: true, scopes: ["read", "write"], keyId: "fixturecaller" } }) : Response.json({ success: false }, { status: 401 });
    },
  });
});
afterAll(() => {
  holder?.stop(true); identity?.stop(true);
  globalThis.fetch = realFetch;
  publishStub.restore();
  for (const [k, v] of Object.entries(SAVED)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  cc.__resetCredentialCacheForTests();
  process.env["METABOB_API_KEY"] = NODE_KEY;
  process.env["IDENTITY_VESSEL_URL"] = `http://127.0.0.1:${identity!.port}`;
  process.env["GAP_STORE_ENDPOINT"] = `http://127.0.0.1:${holder!.port}/v2/impulses/resolve`;
});
afterEach(() => { globalThis.fetch = realFetch; });

const post = (key: string, pointer: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify({ impulse: { pointer } }),
});

describe("whose key a forwarded call carries", () => {
  it("[MUST-FAIL] a write the route received is forwarded with the caller's own key, the gate read and the write alike", async () => {
    const r = await post(CALLER_KEY, { type: "substrateGap_write", gap: gap(`percall-route-${SUFFIX}`) });
    expect(((await r.json()) as { success: boolean }).success).toBe(true);
    expect(seen.map((s) => s.type)).toEqual(["substrateGap", "substrateGap_write"]);
    expect(seen.map((s) => s.auth)).toEqual([`ApiKey ${CALLER_KEY}`, `ApiKey ${CALLER_KEY}`]);
  });
  it("[MUST-FAIL] a read the route received is forwarded with the caller's key too", async () => {
    await post(CALLER_KEY, { type: "substrateGap", id: `percall-read-${SUFFIX}` });
    expect(seen).toEqual([{ type: "substrateGap", auth: `ApiKey ${CALLER_KEY}` }]);
  });
  it("[CONTROL] a write this node makes itself is forwarded with the node key", async () => {
    const r = await gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: gap(`percall-inproc-${SUFFIX}`) }, { vocabulary: null });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(seen.map((s) => s.auth)).toEqual([`ApiKey ${NODE_KEY}`, `ApiKey ${NODE_KEY}`]);
  });
});

describe("where a key may go", () => {
  const stubHost = (prefix: string) => {
    const calls: Seen[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(prefix)) return realFetch(input as never, init);
      const p = (JSON.parse(String(init?.body ?? "{}")) as { impulse: { pointer: { type: string; gap?: { id?: unknown } } } }).impulse.pointer;
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ type: p.type, auth });
      return holderAnswer(p.type, p.gap?.id, auth !== null);
    }) as typeof fetch;
    return calls;
  };
  it("[MUST-FAIL] plain http to a host not shown private gets no key; the read answers, the write is typed gap_store_cleartext_refused", async () => {
    process.env["GAP_STORE_ENDPOINT"] = "http://gap-holder.cleartext.invalid/v2/impulses/resolve";
    const calls = stubHost("http://gap-holder.cleartext.invalid/");
    const r = await gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: gap(`percall-clear-${SUFFIX}`) }, { vocabulary: null });
    expect(calls.map((c) => c.type)).toEqual(["substrateGap", "substrateGap_write"]);
    expect(calls.map((c) => c.auth)).toEqual([null, null]);
    expect(r.shape).toBe("structuredError");
    expect((r.body as { failure_mode: string }).failure_mode).toBe("gap_store_cleartext_refused");
  });
  it("[MUST-FAIL] the caller's own key is withheld from that host as well", async () => {
    process.env["GAP_STORE_ENDPOINT"] = "http://gap-holder.cleartext2.invalid/v2/impulses/resolve";
    const calls = stubHost("http://gap-holder.cleartext2.invalid/");
    await post(CALLER_KEY, { type: "substrateGap_write", gap: gap(`percall-clear2-${SUFFIX}`) });
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.auth === null)).toBe(true);
  });
  it("[CONTROL] https carries the key to the same kind of host, and the write lands", async () => {
    process.env["GAP_STORE_ENDPOINT"] = "https://gap-holder.tls.invalid/v2/impulses/resolve";
    const calls = stubHost("https://gap-holder.tls.invalid/");
    const r = await gapMod.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: gap(`percall-tls-${SUFFIX}`) }, { vocabulary: null });
    expect(calls.map((c) => c.auth)).toEqual([`ApiKey ${NODE_KEY}`, `ApiKey ${NODE_KEY}`]);
    expect(r.shape).toBe("substrateGapWriteResult");
  });
});
