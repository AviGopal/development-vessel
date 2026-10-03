// THE NODE KEY NEVER FOLLOWS A POINTER-OVERRIDABLE URL.
//
// METABOB_API_KEY is this node's own credential: the resolve route accepts it as node-self. Many resolvers
// let a request's pointer override the endpoint they call (`pointer.devVesselImpulsesUrl ?? DEFAULT`,
// `pointer.obsidianEndpoint ?? DEFAULT`, `pointer.endpoint ?? DEFAULT`). When the key goes with the request
// whatever the URL is, whoever writes the pointer names the URL and collects the key.
//
// The rule (lib/self-auth.ts selfAuthHeaders): the node key is attached only when the resolved URL is the
// module's configured endpoint. An overridden URL gets no node key.
//
// One case per family the static sweep (test/lib/self-call-auth-sweep.test.ts) lists, each with a
// RECORDING fetch stub:
//   - override: the pointer names http://attacker.invalid; a request reaches it (the site ran) and carries
//     no Authorization;
//   - control: no override; the request to the configured endpoint carries `ApiKey <node key>`, so the
//     guard did not simply drop the key everywhere.
// Modules that freeze the key at import are imported fresh after the key is set.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NODE_KEY = "node-key-under-test";
const ATTACKER = "http://attacker.invalid";

type Seen = { url: string; authorization: string | null };
const realFetch = globalThis.fetch;
let priorKey: string | undefined;

beforeAll(() => {
  priorKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = NODE_KEY;
});
afterAll(() => {
  if (priorKey === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = priorKey;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records every request's URL and Authorization; answers with `respond(url)` (default `{ success: true }`). */
function recordingFetch(respond: (url: string) => unknown = () => ({ success: true })): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const h = new Headers(init?.headers ?? {});
    seen.push({ url, authorization: h.get("authorization") });
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

const toAttacker = (seen: Seen[]) => seen.filter((s) => s.url.startsWith(ATTACKER));
const keyed = (seen: Seen[]) => seen.filter((s) => s.authorization === `ApiKey ${NODE_KEY}`);

let fresh = 0;
const freshImport = <T>(spec: string): Promise<T> => import(`${spec}?node-key-test=${++fresh}`) as Promise<T>;

// ── FAMILY: gap filing to this vessel's resolve route (pointer.devVesselImpulsesUrl ?? DEFAULT) ─────────
describe("gap filing: pointer.devVesselImpulsesUrl", () => {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "node-key-envgate-"));
    const src = path.join(root, "probe-vessel", "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "unset-gated.ts"), ["const v = process.env.FEATURE_ENABLED;", "if (!v) {", "  return null;", "}"].join("\n"));
    fs.writeFileSync(path.join(root, "env"), "");
    fs.mkdirSync(path.join(root, "units"), { recursive: true });
  });
  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const envGate = async (override?: string): Promise<Seen[]> => {
    const { resolveEnvGateScan } = await import("../../src/resolvers/env-gate-scan.js");
    const seen = recordingFetch();
    await resolveEnvGateScan({
      type: "env_gate_scan",
      rootDir: root,
      envFile: path.join(root, "env"),
      unitsDir: path.join(root, "units"),
      ...(override ? { devVesselImpulsesUrl: override } : {}),
    });
    return seen;
  };

  it("direct fetch (env-gate-scan): an overridden URL gets no Authorization", async () => {
    const seen = await envGate(`${ATTACKER}/v2/impulses/resolve`);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null)).toEqual([]);
  });

  it("direct fetch (env-gate-scan) control: the configured endpoint gets the node key", async () => {
    const seen = await envGate();
    expect(keyed(seen).map((s) => s.url)).toContain("http://127.0.0.1:8090/v2/impulses/resolve");
  });

  const lifecycle = async (override?: string): Promise<Seen[]> => {
    const { resolveActivityLifecycleAudit } = await import("../../src/resolvers/activity-lifecycle-audit.js");
    const recent = new Date(Date.now() - 60_000).toISOString();
    const traces = Array.from({ length: 4 }, () => ({ status: "success", occurred_at: recent, metadata: { template_id: "candidate", state_signature: "sig" } }));
    const seen = recordingFetch((url) =>
      url.includes("/templates") ? { templates: [{ id: "candidate", tags: ["proposed"] }] }
        : url.includes("execution-traces") ? { executions: traces }
        : { success: true },
    );
    await resolveActivityLifecycleAudit({
      type: "activity_lifecycle_audit",
      promoteThreshold: 3,
      ...(override ? { devVesselImpulsesUrl: override } : {}),
    } as never);
    return seen;
  };

  it("through a helper that sets its own headers (activity-lifecycle-audit emitGap): an overridden URL gets no Authorization", async () => {
    const seen = await lifecycle(`${ATTACKER}/v2/impulses/resolve`);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null)).toEqual([]);
  });

  it("through a helper (activity-lifecycle-audit emitGap) control: the configured endpoint gets the node key", async () => {
    const seen = await lifecycle();
    expect(keyed(seen).map((s) => s.url)).toContain("http://127.0.0.1:8090/v2/impulses/resolve");
  });
});

// ── FAMILY: obsidian-* resolvers (pointer.obsidianEndpoint ?? DEFAULT) ─────────────────────────────────
describe("obsidian resolvers: pointer.obsidianEndpoint", () => {
  type Mod = typeof import("../../src/resolvers/obsidian-verify-output.js");
  const verify = async (override?: string): Promise<Seen[]> => {
    const { resolveObsidianVerifyOutput } = await freshImport<Mod>("../../src/resolvers/obsidian-verify-output.ts");
    const seen = recordingFetch(() => ({ success: true, content: "x".repeat(400) }));
    await resolveObsidianVerifyOutput({
      type: "obsidian_verify_output",
      path: "notes/out.md",
      ...(override ? { obsidianEndpoint: override } : {}),
    });
    return seen;
  };

  it("obsidian-verify-output: an overridden endpoint gets no Authorization", async () => {
    const seen = await verify(ATTACKER);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null)).toEqual([]);
  });

  it("obsidian-verify-output control: the configured endpoint gets the node key", async () => {
    const seen = await verify();
    expect(seen.length).toBeGreaterThan(0);
    expect(keyed(seen).length).toBe(seen.length);
  });
});

// ── FAMILY: other peer endpoints a pointer can override (discovery: pointer.endpoint ?? DEFAULT) ────────
describe("peer endpoints: discovery-vessel-registry-observer pointer.endpoint", () => {
  type Mod = typeof import("../../src/resolvers/discovery-vessel-registry-observer.js");
  const observe = async (override?: string): Promise<Seen[]> => {
    const { resolveDiscoveryVesselRegistryObserver } = await freshImport<Mod>("../../src/resolvers/discovery-vessel-registry-observer.ts");
    const seen = recordingFetch(() => ({ vessels: [] }));
    await resolveDiscoveryVesselRegistryObserver({
      type: "discovery_vessel_registry_observer",
      ...(override ? { endpoint: override } : {}),
    });
    return seen;
  };

  it("an overridden discovery endpoint gets no Authorization", async () => {
    const seen = await observe(ATTACKER);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null)).toEqual([]);
  });

  it("control: the configured discovery endpoint gets the node key", async () => {
    const seen = await observe();
    expect(seen.length).toBeGreaterThan(0);
    expect(keyed(seen).length).toBe(seen.length);
  });
});
