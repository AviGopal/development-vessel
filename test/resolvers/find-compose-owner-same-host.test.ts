// findComposeOwner SENDS THE NODE KEY ONLY TO THIS HOST (user ruling "same-host peers only"; self-auth.ts crossNodeKeyHeaders).
//
// findComposeOwner reads composeOwnership from every feature_compose producer discovery lists, with this node's key.
// A discovery row is whatever a registrant or a federated peer wrote, so a producer whose endpoint is not on this machine
// must get no key and no call: it claims nothing. Synthetic fixtures only.
//
//   [MUST-FAIL] a loopback owner and an off-host owner both claim the vessel: the off-host one is never called, so the
//               loopback one is the single owner (before: both asked, two claims, no owner).
//   [CONTROL]   the local-only path: this node's own producer alone is asked, with the key, and owns the vessel.
//   [CONTROL]   a loopback producer on another port is asked, with the key.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `fco-same-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "METABOB_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// A synthetic node key, set before any module reads it, so each call can be seen to carry it (or not).
const NODE_KEY = `synthetic-node-key-${Math.random().toString(36).slice(2, 10)}`;
process.env["METABOB_API_KEY"] = NODE_KEY;

const { findComposeOwner } = await import("../../src/judge/gap-admission.js");

const VESSEL = "local-tools-vessel";
type Producer = { vesselId: string; url: string; owns: string[] };
let producers: Producer[] = [];
let calls: Array<{ url: string; auth: string | null }> = [];
let warned: string[] = [];
const originalFetch = globalThis.fetch;
const origWarn = console.warn;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      return Response.json({ content: { vessels: producers.map((p) => ({ vesselId: p.vesselId, endpoint: p.url, resolve_endpoint: `${p.url}/v2/impulses/resolve` })) } });
    }
    const p = producers.find((x) => url.startsWith(x.url));
    if (p && body?.impulse?.pointer?.type === "composeOwnership") {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ success: true, shape: "composeOwnership", body: { node: p.vesselId, owned_repos: p.owns } });
    }
    return new Response("unexpected", { status: 400 });
  }) as unknown as typeof fetch;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.warn = origWarn;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { producers = []; calls = []; warned = []; process.env["METABOB_API_KEY"] = NODE_KEY; });

describe("findComposeOwner: the node key goes only to producers on this host", () => {
  it("[MUST-FAIL] an off-host producer claiming the vessel is never called, so the loopback owner is the one owner", async () => {
    producers = [
      { vesselId: "development-vessel@here", url: "http://127.0.0.1:18951", owns: [VESSEL] },
      { vesselId: "development-vessel@elsewhere", url: "http://203.0.113.9:8090", owns: [VESSEL] },
    ];
    const owner = await findComposeOwner(VESSEL);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:18951/v2/impulses/resolve"]);
    expect(owner?.vesselId).toBe("development-vessel@here");
    expect(warned.some((w) => w.includes("[cross-node-key] refused non-local 203.0.113.9"))).toBe(true);
    expect(warned.some((w) => w.includes(NODE_KEY))).toBe(false);
  });

  it("[CONTROL] the local-only path: this node's own producer is asked with the key and owns the vessel", async () => {
    producers = [{ vesselId: "development-vessel-local", url: "http://127.0.0.1:8090", owns: [VESSEL] }];
    const owner = await findComposeOwner(VESSEL);
    expect(owner?.vesselId).toBe("development-vessel-local");
    expect(calls).toEqual([{ url: "http://127.0.0.1:8090/v2/impulses/resolve", auth: `ApiKey ${NODE_KEY}` }]);
    expect(warned.filter((w) => w.includes("[cross-node-key]"))).toEqual([]);
  });

  it("[CONTROL] a loopback producer on another port is asked, with the key", async () => {
    producers = [
      { vesselId: "development-vessel-local", url: "http://127.0.0.1:8090", owns: ["some-other-vessel"] },
      { vesselId: "development-vessel@here", url: "http://127.0.0.1:18952", owns: [VESSEL] },
    ];
    const owner = await findComposeOwner(VESSEL);
    expect(owner?.vesselId).toBe("development-vessel@here");
    expect(calls.find((c) => c.url.startsWith("http://127.0.0.1:18952"))?.auth).toBe(`ApiKey ${NODE_KEY}`);
  });
});
