// THE NODE KEY NEVER FOLLOWS A POINTER-SUPPLIED URL, ON ANY ROUTE.
//
// Round 1 closed the resolve routes. The same leak runs on every other route a pointer can override:
// traces, activity-api, concept-db, goal-host /run-goal, discovery reached through a helper. It also runs
// on pointers named `p` rather than `pointer`. One case per family the keyed-URL sweep
// (test/lib/self-call-auth-sweep.test.ts) lists, each with a RECORDING fetch stub:
//   - override: the pointer's endpoint fields name http://attacker.invalid. A request reaches it (the site
//     ran) and carries no Authorization;
//   - control: no override. The configured endpoint gets `ApiKey <key>`, so a fix that dropped the key
//     everywhere also fails.
// Where the resolver takes a caller key (pointer.apiKey), the case passes one. qa ruled that an override
// gets no key at all, the caller's included, because internal callers pass the node key down that way.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NODE_KEY = "node-key-under-test";
const ATTACKER = "http://attacker.invalid";

type Seen = { url: string; authorization: string | null; body: string };
const realFetch = globalThis.fetch;
let priorKey: string | undefined;
let tmp = "";

beforeAll(() => {
  priorKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = NODE_KEY;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "node-key-any-route-"));
});
afterAll(() => {
  if (priorKey === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = priorKey;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function recordingFetch(respond: (url: string, body: string) => unknown = () => ({})): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = init?.body ? String(init.body) : "";
    seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization"), body });
    return new Response(JSON.stringify(respond(url, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

const toAttacker = (seen: Seen[]) => seen.filter((s) => s.url.startsWith(ATTACKER));
const keyed = (seen: Seen[]) => seen.filter((s) => s.authorization === `ApiKey ${NODE_KEY}`);

function overrideCase(name: string, run: (attacker: boolean) => Promise<Seen[]>, controlUrl: (url: string) => boolean): void {
  it(`${name}: an overridden URL gets no Authorization`, async () => {
    const seen = await run(true);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null).map((s) => s.url)).toEqual([]);
  });
  it(`${name} control: the configured endpoint gets the key`, async () => {
    const seen = await run(false);
    expect(keyed(seen).filter((s) => controlUrl(s.url)).length).toBeGreaterThan(0);
  });
}

// ── dev-vessel, through a pointer named `p` (gap-lifecycle-scan) ──────────────────────────────────────
describe("dev-vessel via `p`: gap-lifecycle-scan p.devVesselImpulsesUrl", () => {
  // The scan appends funnel history and landability predictions under WORKSPACE_ROOT (read at use time):
  // point it at a temp dir so the test leaves the checkout clean.
  let priorRoot: string | undefined;
  beforeAll(() => {
    priorRoot = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = fs.mkdtempSync(path.join(tmp, "ws-"));
    fs.mkdirSync(path.join(process.env["WORKSPACE_ROOT"], "gaps"), { recursive: true });
  });
  afterAll(() => {
    if (priorRoot === undefined) delete process.env["WORKSPACE_ROOT"];
    else process.env["WORKSPACE_ROOT"] = priorRoot;
  });
  overrideCase("gap-lifecycle-scan", async (attacker) => {
    const { resolveGapLifecycleScan } = await import("../../src/resolvers/gap-lifecycle-scan.js");
    const dir = fs.mkdtempSync(path.join(tmp, "gls-"));
    const gapsPath = path.join(dir, "gaps.json");
    fs.writeFileSync(gapsPath, JSON.stringify({ gaps: [{ id: "g1", status: "open", category: "missing_capability", summary: "s", detected_at: new Date().toISOString(), classification_metadata: { missing_shape: "someShape" } }] }));
    const seen = recordingFetch(() => ({ body: { activities: [], templates: [] } }));
    await resolveGapLifecycleScan({
      type: "gap_lifecycle_scan",
      gapsPath,
      proposalsDir: path.join(dir, "proposals"),
      autoClose: true,
      ...(attacker ? { devVesselImpulsesUrl: `${ATTACKER}/v2/impulses/resolve` } : {}),
    } as never);
    return seen;
  }, (u) => u === "http://127.0.0.1:8090/v2/impulses/resolve");
});

// ── dev-vessel and activity-api, through `const p = pointer` (learning-mode) ─────────────────────────
describe("dev-vessel and activity-api via `p`: learning-mode p.devVesselUrl / p.activityApiUrl", () => {
  // learning-mode persists its hysteresis to <WORKSPACE_ROOT>/state/learning-mode-state.json, with
  // WORKSPACE_ROOT frozen at config import: keep whatever was there and put it back afterwards.
  let stateFile = "";
  let priorState: string | null = null;
  beforeAll(async () => {
    const { WORKSPACE_ROOT } = await import("../../src/config.js");
    stateFile = path.join(WORKSPACE_ROOT, "state", "learning-mode-state.json");
    priorState = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
  });
  afterAll(() => {
    if (priorState === null) { try { fs.rmSync(stateFile, { force: true }); } catch { /* best effort */ } }
    else fs.writeFileSync(stateFile, priorState);
  });
  overrideCase("learning-mode", async (attacker) => {
    const { resolveLearningMode } = await import("../../src/resolvers/learning-mode.js");
    const seen = recordingFetch();
    await resolveLearningMode({
      type: "learning_mode",
      ...(attacker ? { devVesselUrl: ATTACKER, activityApiUrl: ATTACKER } : {}),
    } as never);
    return seen;
  }, (u) => u.startsWith("http://127.0.0.1:8090/"));
});

// ── traces (tracesUrl) ────────────────────────────────────────────────────────────────────────────────
describe("traces: authoring-chain-health-report pointer.tracesUrl", () => {
  overrideCase("authoring-chain-health-report", async (attacker) => {
    const { resolveAuthoringChainHealthReport } = await import("../../src/resolvers/authoring-chain-health-report.js");
    const seen = recordingFetch(() => ({ executions: [] }));
    await resolveAuthoringChainHealthReport({
      type: "authoring_chain_health_report",
      ...(attacker ? { tracesUrl: `${ATTACKER}/v2/activities/execution-traces` } : {}),
    } as never);
    return seen;
  }, (u) => u.startsWith("http://127.0.0.1:8080/v2/activities/execution-traces"));
});

// ── activity-api (metabobEndpoint) ────────────────────────────────────────────────────────────────────
describe("activity-api: cyclic-flow-scan pointer.metabobEndpoint", () => {
  overrideCase("cyclic-flow-scan", async (attacker) => {
    const { resolveCyclicFlowScan } = await import("../../src/resolvers/cyclic-flow-scan.js");
    const seen = recordingFetch(() => ({ executions: [] }));
    await resolveCyclicFlowScan({
      type: "cyclic_flow_scan",
      emit_gap: false,
      ...(attacker ? { metabobEndpoint: ATTACKER } : {}),
    } as never);
    return seen;
  }, (u) => u.includes("/v2/activities/execution-traces") && !u.startsWith(ATTACKER));
});

// ── concept-db (conceptDbUrl) ─────────────────────────────────────────────────────────────────────────
describe("concept-db: concept-write pointer.conceptDbUrl", () => {
  overrideCase("concept-write", async (attacker) => {
    const { resolveConceptWrite } = await import("../../src/resolvers/concept-write.js");
    const seen = recordingFetch(() => ({ id: "c1" }));
    await resolveConceptWrite({
      type: "concept_write",
      name: "n",
      content: "c",
      source_type: "architectural_pattern_principle",
      ...(attacker ? { conceptDbUrl: `${ATTACKER}/concepts` } : {}),
    } as never);
    return seen;
  }, (u) => u === "http://127.0.0.1:8260/concepts");
});

// ── discovery through a helper, concept-db through a helper, goal-host /run-goal (vessel-gap-to-cluster) ─
describe("discovery, concept-db and goal-host /run-goal through helpers: vessel-gap-to-cluster", () => {
  const run = async (attacker: boolean): Promise<Seen[]> => {
    const { resolveVesselGapToCluster } = await import("../../src/resolvers/vessel-gap-to-cluster.js");
    const seen = recordingFetch(() => ({ content: { vessels: [] }, body: { concepts: [] } }));
    await resolveVesselGapToCluster({
      type: "vessel_gap_to_cluster",
      shape: "someShape",
      apiKey: NODE_KEY,
      patternsDir: fs.mkdtempSync(path.join(tmp, "vgc-")),
      dispatch: true,
      ...(attacker ? { discoveryEndpoint: ATTACKER, conceptDbEndpoint: ATTACKER, goalHostEndpoint: ATTACKER } : {}),
    } as never);
    return seen;
  };
  it("no request to an overridden discovery, concept-db or goal-host carries Authorization", async () => {
    const seen = await run(true);
    const hit = toAttacker(seen);
    expect(hit.some((s) => s.url.endsWith("/run-goal"))).toBe(true);
    expect(hit.some((s) => s.url.endsWith("/v2/impulses/resolve"))).toBe(true);
    expect(hit.some((s) => /\/resolve$/.test(s.url) && !s.url.endsWith("/v2/impulses/resolve"))).toBe(true);
    expect(hit.filter((s) => s.authorization !== null).map((s) => s.url)).toEqual([]);
  });
  it("control: the configured discovery, concept-db and goal-host get the key", async () => {
    const seen = await run(false);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(keyed(seen).length).toBe(seen.length);
  });
});
