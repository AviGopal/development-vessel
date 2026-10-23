// A COMPOSE GOES WHERE A SLOT IS FREE, FOUND THROUGH DISCOVERY (law 11; compose-placement.ts).
//
// The check supply sent every test-writing goal to its own goal-host, so the compose ran on its own development-vessel.
// With that node's one unarmed autonomous slot held, every supply goal came back a BUSY non-attempt while a peer that
// composes the same vessels, on the same gap store, ran nothing. The supply now asks discovery's composeOwnership
// producers (a placement query: {gap_id, targets, armed}) when no local slot of the class is free, and sends the goal
// through the development-vessel of a peer that can take it. Synthetic fixtures only.
//
// The supply's compose is admitted in the UNARMED autonomous class (feature_compose's composeArmed is false for it), so
// "busy" and "idle" below are that class; the producer-side case checks both classes are answered apart.
//
//   [MUST-FAIL] this node busy, a peer idle: the goal goes through the peer (no local /run-goal), and the ledger names
//               the peer as dispatch_node, placed by this node.
//   [CONTROL]   both idle: sent locally, as today, and no peer is even asked.
//   [CONTROL]   both busy: sent locally, as today; the receiver's BUSY settles as an uncharged non-attempt.
//   [CONTROL]   a peer that is unreachable, or whose capacity read errors: sent locally, logged where the read failed.
//   [CONTROL]   a peer that does not own the vessel, does not see the row, or whose scope excludes a target: never chosen;
//               an able peer is chosen for no more goals in one tick than the free slots it reported.
//   [MUST-FAIL] the producer side: a placement query is answered with the node's own capacity per class, its scope's
//               exclusions and its row visibility; the plain composeOwnership read is unchanged.
//   [MUST-FAIL] a placed dispatch nobody here can read settles by the dispatch timeout, not the foreign bound.
// SEVERAL OWNERS (REALIGNMENT §4, law 11; user ruling "(B) Several owners, lease-serialized"): a vessel may be composed
// by more than one node, and the gap-store holder's landing lease serialises their landings (gap-landing-lease.test.ts).
//   [MUST-FAIL] this node does not compose the vessel, though a local slot is free: the goal goes to an owner with a
//               free slot (the owner with none is passed over), never to this node's own compose, which would refuse it.
//   [CONTROL]   this node does not compose the vessel and no peer can take it: sent locally, as today.
//   [MUST-FAIL] a placed goal's outcome is read back through the peer that took it and settles as read, not as lost.
//   [CONTROL]   a peer that answers no dispatch (an older composeOwnership) leaves the placed goal waiting, as today.
//   [MUST-FAIL] the producer side answers a dispatch read from its own goal-host record.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { promises as dns } from "node:dns";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-placement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const SLOTS = join(ROOT, "compose-slots");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "METABOB_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["COMPOSE_SLOT_DIR"] = SLOTS;
delete process.env["GAP_STORE_ENDPOINT"];
// A synthetic node key, set before any module reads it, so the peer calls can be seen to carry it (or not).
const NODE_KEY = `synthetic-node-key-${Math.random().toString(36).slice(2, 10)}`;
process.env["METABOB_API_KEY"] = NODE_KEY;

// config.js after the key is set (a static import is hoisted above it), so its frozen copy of the key is the synthetic one too.
const { __resetDiscoveryForTests } = await import("../../src/config.js");
const sg = await import("../../src/resolvers/substrate-gap.js");
await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const slots = await import("../../src/compose-slots.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const LOCAL = supply.checkSupplyNode();

/** A peer compose producer as discovery lists it and as it answers a placement query. */
type Peer = { id: string; url: string; node: string; owns: string[]; free: number | null; visible: boolean | null; excludes: string[]; fail?: "throw" | "http500"; origin?: string; readsNoDispatch?: boolean };
// Peers on THIS host (the node key goes to no other: self-auth.ts crossNodeKeyHeaders): loopback, one port per name.
const peerPorts = new Map<string, number>();
const loopbackUrl = (name: string): string => {
  if (!peerPorts.has(name)) peerPorts.set(name, 18_900 + peerPorts.size);
  return `http://127.0.0.1:${peerPorts.get(name)}`;
};
const peerAt = (name: string, over: Partial<Peer> = {}): Peer => ({ id: `development-vessel-peer-${name}`, url: loopbackUrl(name), node: name, owns: [VESSEL], free: 1, visible: true, excludes: [], ...over });

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let warned: string[] = [];
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let peers: Peer[] = [];
let peerReads: Array<{ node: string; pointer: Row; auth: string | null }> = [];
/** Dispatch reads (a placed goal's outcome read back), kept apart from the placement queries above. */
let peerDispatchReads: Array<{ node: string; pointer: Row; auth: string | null }> = [];
let peerGoals: Array<{ node: string; goal: string; variables?: Record<string, unknown>; auth: string | null }> = [];
let executions: Record<string, { status: string; reached: boolean | null; outcome?: Record<string, unknown> }> = {};
let rhythms: Row[] = [];
/** The pool's autonomyScope excluded paths, as this node's own policy read sees them (the producer-side case). */
let poolExcluded: string[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3 },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test"), join(RUNTIME, VESSEL, "src"), SLOTS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const peer = peers.find((p) => url.startsWith(p.url));
    if (peer) {
      const auth = new Headers(init?.headers).get("authorization");
      if (peer.fail === "throw") throw new Error("connect ECONNREFUSED (synthetic)");
      if (peer.fail === "http500") return new Response("internal error", { status: 500 });
      const ptr = (body?.impulse?.pointer ?? {}) as Row;
      if (ptr["type"] === "composeOwnership") {
        (typeof ptr["dispatch_id"] === "string" ? peerDispatchReads : peerReads).push({ node: peer.node, pointer: ptr, auth });
        return Response.json({ success: true, shape: "composeOwnership", body: { node: peer.node, owned_repos: peer.owns,
          placement: { armed: ptr["armed"] === true, capacity: peer.free === null ? null : { free: peer.free, live: peer.free > 0 ? 0 : 1, cap: 1 }, scope_readable: true,
            scope_excludes: peer.excludes.map((t) => ({ target: t, entry: t })), gap_row_visible: peer.visible,
            // A dispatch read (a placed goal's outcome, read back by the node that placed it) is answered from the
            // peer's own goal-host record; an older peer (readsNoDispatch) answers the placement without it.
            ...(typeof ptr["dispatch_id"] === "string" && !peer.readsNoDispatch ? { dispatch: executions[ptr["dispatch_id"] as string] ? { http: 200, ...executions[ptr["dispatch_id"] as string] } : { http: 404 } } : {}) } } });
      }
      if (ptr["type"] === "dispatch_goal") {
        peerGoals.push({ node: peer.node, goal: String(ptr["goal"] ?? ""), variables: ptr["variables"] as Record<string, unknown> | undefined, auth });
        return Response.json({ success: true, shape: "goalDispatchResult", body: { dispatched: true, dispatch_id: `p-${peer.node}-${peerGoals.length}`, status: "accepted" } });
      }
      return Response.json({ success: false, error: "unexpected" }, { status: 400 });
    }
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const rec = executions[decodeURIComponent(exec[1]!)];
      return rec ? Response.json({ dispatchId: exec[1], ...rec }) : new Response("not found", { status: 404 });
    }
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 });
    }
    const cap = body?.pointer ?? imp?.pointer;
    if (cap?.type === "vesselCapability") {
      if (cap.shape === "composeOwnership") {
        return Response.json({ content: { vessels: [
          { vesselId: "development-vessel-self", endpoint: "http://127.0.0.1:8090", resolve_endpoint: "http://127.0.0.1:8090/v2/impulses/resolve", origin: "local" },
          ...peers.map((p) => ({ vesselId: p.id, endpoint: p.url, resolve_endpoint: `${p.url}/v2/impulses/resolve`, origin: p.origin ?? "peer:http://127.0.0.1:28100" })),
        ] } });
      }
      if (cap.shape === "poolImpulse") return Response.json({ content: { vessels: [{ vesselId: "pool-self", endpoint: "http://pool.self.test", resolve_endpoint: "http://pool.self.test/v2/impulses/resolve", origin: "local" }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url.startsWith("http://pool.self.test") && imp?.shape === "autonomyScope") {
      return Response.json({ body: { impulses: [{ shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: { excluded_paths: poolExcluded } }] } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"] } }], count: 1 } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  // The cap the shaped record sets: 2 slots, so ONE unarmed autonomous slot (the last is reserved for directed work).
  slots.__setComposeCapacityReaderForTests(async () => ({ max_concurrent: 2, reserved_for_armed: 0 }));
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  slots.__setComposeCapacityReaderForTests(null);
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  goals = []; peers = []; peerReads = []; peerDispatchReads = []; peerGoals = []; executions = {}; warned = []; poolExcluded = []; rhythms = [dueRhythm()];
  setLocalBusy(false);
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

/** This node's one unarmed slot held by a live holder (this process), or free. */
function setLocalBusy(busy: boolean): void {
  const f = join(SLOTS, "slot-0.slot");
  if (busy) writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "synthetic-holder" }));
  else rmSync(f, { force: true });
}
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
async function seed(id: string, what: string): Promise<void> {
  const summary = `${what} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const localGoalsFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);
const peerGoalsFor = (id: string) => peerGoals.filter((g) => g.variables?.["gap_id"] === id);

describe("check-supply placement: the compose runs where a slot is free", () => {
  it("[MUST-FAIL] this node busy, a peer idle: the goal goes through the peer and the ledger names it", async () => {
    const id = T("gcs-place");
    await seed(id, "placed");
    setLocalBusy(true);
    peers = [peerAt("node-b")];
    await tick(Date.now());
    expect(localGoalsFor(id).length).toBe(0);
    expect(peerGoalsFor(id).length).toBe(1);
    expect(peerGoalsFor(id)[0]!.node).toBe("node-b");
    expect(peerGoalsFor(id)[0]!.variables?.["check_supply"]).toBe(true);
    expect(peerGoalsFor(id)[0]!.goal).toContain("Write ONE failing test");
    // the placement query asked for the supply's class, with this gap and its scope targets
    const l = ledgerOf(await storeRow(id));
    const ask = peerReads.find((r) => r.pointer["gap_id"] === id);
    expect(ask?.pointer["armed"]).toBe(false);
    expect(ask?.pointer["targets"]).toEqual(supply.checkSupplyScopeTargets(VESSEL, (l["edit_site"] as string | null) ?? null, supply.checkSupplyTestFile(id)));
    expect(l["state"]).toBe("goal_dispatched");
    expect(l["dispatch_node"]).toBe("node-b");
    expect(l["placed_by"]).toBe(LOCAL);
    expect(String(l["dispatch_id"])).toBe("p-node-b-1");
    expect(Number(l["attempts"])).toBe(1);
  });

  it("[CONTROL] both idle: sent locally, as today, and no peer is asked", async () => {
    const id = T("gcs-idle");
    await seed(id, "both idle");
    peers = [peerAt("node-b")];
    await tick(Date.now());
    expect(localGoalsFor(id).length).toBe(1);
    expect(peerGoalsFor(id).length).toBe(0);
    expect(peerReads.length).toBe(0);
    const l = ledgerOf(await storeRow(id));
    expect(l["dispatch_node"]).toBe(LOCAL);
    expect(l["placed_by"]).toBeUndefined();
  });

  it("[CONTROL] both busy: sent locally, and the receiver's BUSY is an uncharged non-attempt, as today", async () => {
    const id = T("gcs-busy");
    await seed(id, "both busy");
    setLocalBusy(true);
    peers = [peerAt("node-b", { free: 0 })];
    const t0 = Date.now();
    await tick(t0);
    expect(peerGoalsFor(id).length).toBe(0);
    expect(localGoalsFor(id).length).toBe(1);
    const sent = ledgerOf(await storeRow(id));
    expect(sent["dispatch_node"]).toBe(LOCAL);
    executions[String(sent["dispatch_id"])] = { status: "failed", reached: false, outcome: { kind: "non_attempt", failure_kind: "capacity" } };
    await tick(t0 + 60_000);
    const held = ledgerOf(await storeRow(id));
    expect(held["state"]).toBe("non_attempt");
    expect(Number(held["attempts"])).toBe(0);
  });

  it("[CONTROL] a peer that is unreachable, or whose capacity read errors, is no candidate: sent locally, logged", async () => {
    const id = T("gcs-unreach");
    await seed(id, "unreachable peer");
    setLocalBusy(true);
    peers = [peerAt("node-b", { fail: "throw" }), peerAt("node-c", { fail: "http500" })];
    await tick(Date.now());
    expect(peerGoalsFor(id).length).toBe(0);
    expect(localGoalsFor(id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["dispatch_node"]).toBe(LOCAL);
    expect(warned.some((w) => w.includes("[compose-placement]") && w.includes("development-vessel-peer-node-b") && w.includes("ECONNREFUSED"))).toBe(true);
    expect(warned.some((w) => w.includes("[compose-placement]") && w.includes("development-vessel-peer-node-c") && w.includes("HTTP 500"))).toBe(true);
  });

  it("[CONTROL] a peer that does not own the vessel, does not see the row, or whose scope excludes a target is never chosen", async () => {
    const id = T("gcs-refuse");
    await seed(id, "refusing peers");
    setLocalBusy(true);
    peers = [
      peerAt("node-b", { owns: ["some-other-vessel"] }),
      peerAt("node-c", { visible: false }),
      peerAt("node-d", { excludes: [`repos/${VESSEL}/src/widget.ts`] }),
      peerAt("node-e", { free: null }),
    ];
    await tick(Date.now());
    expect(peerReads.length).toBe(4);
    expect(peerGoalsFor(id).length).toBe(0);
    expect(localGoalsFor(id).length).toBe(1);
    // and with one peer that can take it among them, that one is chosen, but only for as many goals as it has free
    // slots: its one free slot is debited by the first placement of the tick, so the second goal stays local
    const id2 = T("gcs-refuse2");
    const id3 = T("gcs-refuse3");
    await seed(id2, "one able peer");
    await seed(id3, "one able peer, second goal");
    peers = [...peers, peerAt("node-f", { free: 1 })];
    g2fPolicy.__resetPolicyReadsForTests(); // a fresh discovery answer (the producer list is cached per lookup)
    await tick(Date.now() + 1_000);
    const viaPeer = [id2, id3].filter((g) => peerGoalsFor(g).length === 1);
    expect(viaPeer.length).toBe(1);
    expect(peerGoalsFor(viaPeer[0]!)[0]!.node).toBe("node-f");
    expect([id2, id3].filter((g) => localGoalsFor(g).length === 1).length).toBe(1);
  });

  it("[CONTROL] discovery lists no peer composer: sent locally, nobody asked, nothing placed, as today", async () => {
    // A fleet where every node registers the same development-vessel id and discovery merges rows by id: the peer's
    // row is merged away, so the lookup answers this node's own producer only (origin local), and nobody is asked.
    const id = T("gcs-merged");
    await seed(id, "peer row merged away");
    setLocalBusy(true);
    peers = [];
    await tick(Date.now());
    expect(peerReads.length).toBe(0);
    expect(peerGoals.length).toBe(0);
    // peerReads sees only peer URLs; a placement read of this node's own row would fail on the stub and warn here
    expect(warned.filter((w) => w.includes("[compose-placement]"))).toEqual([]);
    expect(localGoalsFor(id).length).toBe(1);
    const l = ledgerOf(await storeRow(id));
    expect(l["dispatch_node"]).toBe(LOCAL);
    expect(l["placed_by"]).toBeUndefined();
  });

  it("[CONTROL] this node's own producer under a non-local row answers with this node's name: never a candidate", async () => {
    // The surviving merged row may be this node's own producer reached as a non-local row (an older discovery stamps
    // no origin). It is asked, answers with this node's name and, even reporting a free slot, is not chosen.
    const id = T("gcs-merged-self");
    await seed(id, "own producer as a non-local row");
    setLocalBusy(true);
    peers = [peerAt("self-row", { node: LOCAL, free: 1 })];
    await tick(Date.now());
    expect(peerReads.some((r) => r.pointer["gap_id"] === id)).toBe(true);
    expect(peerGoals.length).toBe(0);
    expect(localGoalsFor(id).length).toBe(1);
    const l = ledgerOf(await storeRow(id));
    expect(l["dispatch_node"]).toBe(LOCAL);
    expect(l["placed_by"]).toBeUndefined();
  });

  it("[MUST-FAIL] a producer off this host gets no key and no call: never asked, never placed", async () => {
    const id = T("gcs-offhost");
    await seed(id, "off-host producer");
    setLocalBusy(true);
    // idle and able in every other respect, but its endpoint is not on this machine (a documentation-range address)
    peers = [peerAt("node-remote", { url: "http://203.0.113.7:8090" })];
    await tick(Date.now());
    expect(peerReads.length).toBe(0);
    expect(peerGoals.length).toBe(0);
    expect(warned.some((w) => w.includes("[cross-node-key] refused non-local 203.0.113.7"))).toBe(true);
    expect(warned.some((w) => w.includes(NODE_KEY))).toBe(false);
    expect(localGoalsFor(id).length).toBe(1);
    const l = ledgerOf(await storeRow(id));
    expect(l["dispatch_node"]).toBe(LOCAL);
    expect(l["placed_by"]).toBeUndefined();
  });

  it("[MUST-FAIL] a libp2p overlay row on this node's own loopback egress gets no key and no call: never asked, never placed", async () => {
    // A federation facade (id <vessel>@<substrate>, origin overlay) resolves through this node's own egress on loopback,
    // which would carry the key to ANOTHER substrate. Idle and able in every other respect.
    const id = T("gcs-overlay");
    await seed(id, "overlay row");
    setLocalBusy(true);
    peers = [peerAt("far-substrate", { id: "development-vessel-local@far-substrate", url: "http://127.0.0.1:8401", origin: "overlay" })];
    await tick(Date.now());
    expect(peerReads.length).toBe(0);
    expect(peerGoals.length).toBe(0);
    expect(warned.some((w) => w.includes("[cross-node-key] refused overlay development-vessel-local@far-substrate"))).toBe(true);
    expect(warned.some((w) => w.includes(NODE_KEY))).toBe(false);
    expect(localGoalsFor(id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["dispatch_node"]).toBe(LOCAL);
  });

  it("[CONTROL] a same-host HTTP peer row named by container name (resolving on the shared bridge) is asked with the key", async () => {
    // The container's own name resolves to its address on the bridge sibling containers share: an HTTP peer row from a
    // peer's own registry under this node's id, not an overlay. Skipped only where the name does not resolve.
    const name = hostname();
    let resolves = false;
    try { resolves = (await dns.lookup(name, { all: true })).length > 0; } catch { resolves = false; }
    if (!resolves) return;
    const id = T("gcs-bridge");
    await seed(id, "bridge peer row");
    setLocalBusy(true);
    process.env["METABOB_API_KEY"] = NODE_KEY;
    peers = [peerAt("node-b", { id: "development-vessel-self", url: `http://${name}:18998`, origin: "peer:http://127.0.0.1:28100" })];
    await tick(Date.now());
    const ask = peerReads.find((r) => r.pointer["gap_id"] === id);
    expect(ask?.auth).toBe(`ApiKey ${NODE_KEY}`);
    expect(peerGoalsFor(id).length).toBe(1);
    expect(peerGoalsFor(id)[0]!.auth).toBe(`ApiKey ${NODE_KEY}`);
  });

  it("[CONTROL] a loopback producer on another port is still asked and placed, with the node key", async () => {
    const id = T("gcs-loopkey");
    await seed(id, "loopback producer with key");
    setLocalBusy(true);
    process.env["METABOB_API_KEY"] = NODE_KEY;
    peers = [peerAt("node-b")];
    await tick(Date.now());
    const ask = peerReads.find((r) => r.pointer["gap_id"] === id);
    expect(ask?.auth).toBe(`ApiKey ${NODE_KEY}`);
    expect(peerGoalsFor(id).length).toBe(1);
    expect(peerGoalsFor(id)[0]!.auth).toBe(`ApiKey ${NODE_KEY}`);
    expect(warned.some((w) => w.includes("[cross-node-key]"))).toBe(false);
  });

  it("[CONTROL] a same-host peer node's row under THIS node's own id (node-distinct composeOwnership) is asked and placed on", async () => {
    // What discovery answers once composeOwnership is declared stateful_data_owner_merge on both nodes: the peer's
    // development-vessel row carries the same vesselId as this node's own, from the peer's own registry.
    const id = T("gcs-sameid");
    await seed(id, "same-id peer row");
    setLocalBusy(true);
    peers = [peerAt("node-b", { id: "development-vessel-self", origin: "peer:http://127.0.0.1:28100" })];
    await tick(Date.now());
    expect(peerGoalsFor(id).length).toBe(1);
    expect(peerGoalsFor(id)[0]!.node).toBe("node-b");
    expect(localGoalsFor(id).length).toBe(0);
    expect(ledgerOf(await storeRow(id))["dispatch_node"]).toBe("node-b");
  });

  it("[BACKSTOP] a self-echo under this node's own id (its own row seen again through a peer's discovery) is never a candidate", async () => {
    // A node whose peer list reaches its OWN discovery (through the runtime's host name) sees its own development-vessel
    // again, under the same id, as a peer row. It answers with this node's name, so even with a free slot it is refused.
    const id = T("gcs-selfecho");
    await seed(id, "self echo");
    setLocalBusy(true);
    peers = [peerAt("self-echo", { id: "development-vessel-self", node: LOCAL, free: 3, origin: "peer:http://host.containers.internal:18100" })];
    await tick(Date.now());
    expect(peerReads.some((r) => r.pointer["gap_id"] === id)).toBe(true);
    expect(peerGoals.length).toBe(0);
    expect(localGoalsFor(id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["dispatch_node"]).toBe(LOCAL);
  });

  it("[MUST-FAIL] the producer side answers a placement query from its own capacity per class, scope and store", async () => {
    const id = T("gcs-answer");
    await seed(id, "producer side");
    // 3 slots, 1 reserved for armed: the unarmed autonomous lane has 1 slot, the armed lane 2. One holder: unarmed full.
    slots.__setComposeCapacityReaderForTests(async () => ({ max_concurrent: 3, reserved_for_armed: 1 }));
    try {
      setLocalBusy(true);
      poolExcluded = [`repos/${VESSEL}/src/held.ts`];
      // A query-string instance of the route module: test/observers/topology-chain.test.ts replaces routes/impulses.js
      // process-wide with mock.module (never undone), whose stub answers composeOwnership with an empty body; the plain
      // specifier would hand this case that stub in a full run (see pool-trust-root.test.ts).
      const { resolveDispatch } = await import(`../../src/routes/impulses.js?${"gcs-placement"}`);
      const ask = async (extra: Row) => ((await resolveDispatch({ type: "composeOwnership", ...extra } as never)).body ?? {}) as Row;
      const plain = await ask({});
      expect(plain["placement"]).toBeUndefined();
      expect(Array.isArray(plain["owned_repos"])).toBe(true);
      const targets = [`repos/${VESSEL}/src/held.ts`, `repos/${VESSEL}/src/widget.ts`];
      const unarmed = (await ask({ gap_id: id, targets, armed: false }))["placement"] as Row | undefined;
      expect(unarmed?.["armed"]).toBe(false);
      expect((unarmed?.["capacity"] as Row | undefined)?.["free"]).toBe(0);
      expect(unarmed?.["gap_row_visible"]).toBe(true);
      expect(unarmed?.["scope_readable"]).toBe(true);
      expect(((unarmed?.["scope_excludes"] ?? []) as Row[]).map((x) => x["target"])).toEqual([`repos/${VESSEL}/src/held.ts`]);
      const armed = (await ask({ gap_id: id, targets, armed: true }))["placement"] as Row | undefined;
      expect((armed?.["capacity"] as Row | undefined)?.["free"]).toBe(1);
      const other = (await ask({ gap_id: `no-such-gap-${RUN}`, targets: [] }))["placement"] as Row | undefined;
      expect(other?.["gap_row_visible"]).toBe(false);
    } finally {
      slots.__setComposeCapacityReaderForTests(async () => ({ max_concurrent: 2, reserved_for_armed: 0 }));
    }
  });

  it("[MUST-FAIL] this node does not compose the vessel, a local slot free: an owner with a free slot takes it", async () => {
    const id = T("gcs-nonowner");
    await seed(id, "non-owner node");
    // This node owns another vessel only (a clone with .git), so the owned set is non-empty and lacks VESSEL.
    const other = join(CLONES, "some-other-vessel", ".git");
    mkdirSync(other, { recursive: true });
    try {
      // node-c has room for every goal this tick sends (rows earlier cases left undispatched are placed too)
      peers = [peerAt("node-b", { free: 0 }), peerAt("node-c", { free: 4 })];
      await tick(Date.now());
      expect(localGoalsFor(id).length).toBe(0);
      expect(peerGoalsFor(id).length).toBe(1);
      expect(peerGoalsFor(id)[0]!.node).toBe("node-c");
      const l = ledgerOf(await storeRow(id));
      expect(l["dispatch_node"]).toBe("node-c");
      expect(l["placed_by"]).toBe(LOCAL);
      expect(String(l["placement"])).toContain(`does not compose ${VESSEL}`);
    } finally {
      rmSync(join(CLONES, "some-other-vessel"), { recursive: true, force: true });
    }
  });

  it("[CONTROL] this node does not compose the vessel and no peer can take it: sent locally, as today", async () => {
    const id = T("gcs-nonowner-alone");
    await seed(id, "non-owner node, no able peer");
    mkdirSync(join(CLONES, "some-other-vessel", ".git"), { recursive: true });
    try {
      peers = [peerAt("node-b", { free: 0 })];
      await tick(Date.now());
      expect(peerGoalsFor(id).length).toBe(0);
      expect(localGoalsFor(id).length).toBe(1);
      const l = ledgerOf(await storeRow(id));
      expect(l["dispatch_node"]).toBe(LOCAL);
      expect(l["placed_by"]).toBeUndefined();
    } finally {
      rmSync(join(CLONES, "some-other-vessel"), { recursive: true, force: true });
    }
  });

  /** A row whose goal THIS node placed on `peer` an hour ago (the ledger the placed send writes). */
  async function seedPlaced(id: string, peer: Peer, dispatchId: string): Promise<void> {
    const summary = `placed outcome fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
    const check_supply = { state: "goal_dispatched", attempts: 1, last_dispatch_at: new Date(Date.now() - 3_600_000).toISOString(), test_file: "test/checks/placed.check.ts", vessel: VESSEL,
      dispatch_id: dispatchId, dispatch_node: peer.node, dispatch_host: `${peer.url}/v2/impulses/resolve`, placed_by: LOCAL, placement: "fixture" };
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { check_supply } } } as never);
    if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
    await sg.__settleBirthEvaluationsForTests();
  }

  it("[MUST-FAIL] a placed goal's outcome is read back through the peer that took it, and settles as read", async () => {
    rhythms = [{ ...dueRhythm(), body: { ...(dueRhythm()["body"] as Row), backoff_hours: 500 } }]; // the settled state is read, no same-tick retry
    const id = T("gcs-placed-read");
    const peer = peerAt("node-b");
    peers = [peer];
    await seedPlaced(id, peer, `p-read-${RUN}`);
    executions[`p-read-${RUN}`] = { status: "failed", reached: false };
    await tick(Date.now());
    const ask = peerDispatchReads.find((r) => r.pointer["dispatch_id"] === `p-read-${RUN}`);
    expect(ask?.node).toBe("node-b");
    expect(ask?.auth).toBe(`ApiKey ${NODE_KEY}`);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("dispatch_failed");
    expect((l["outcome"] as Row)["status"]).toBe("failed");
    expect((l["outcome"] as Row)["lost_why"]).toBeUndefined();
  });

  it("[CONTROL] a peer that answers no dispatch (an older composeOwnership) leaves the placed goal waiting, as today", async () => {
    rhythms = [{ ...dueRhythm(), body: { ...(dueRhythm()["body"] as Row), backoff_hours: 500 } }];
    const id = T("gcs-placed-old");
    const peer = peerAt("node-b", { readsNoDispatch: true });
    peers = [peer];
    await seedPlaced(id, peer, `p-old-${RUN}`);
    executions[`p-old-${RUN}`] = { status: "failed", reached: false };
    const b = await tick(Date.now());
    expect(ledgerOf(await storeRow(id))["state"]).toBe("goal_dispatched");
    expect(((b["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === id && w["why"] === "owning_node_never_settled")).toBe(true);
  });

  it("[MUST-FAIL] the producer side answers a dispatch read from its own goal-host record", async () => {
    const id = T("gcs-dispatch-answer");
    await seed(id, "producer side dispatch read");
    executions[`d-answer-${RUN}`] = { status: "completed", reached: true };
    const { resolveDispatch } = await import(`../../src/routes/impulses.js?${"gcs-placement"}`);
    const ask = async (extra: Row) => ((await resolveDispatch({ type: "composeOwnership", ...extra } as never)).body ?? {}) as Row;
    const read = (await ask({ gap_id: id, dispatch_id: `d-answer-${RUN}` }))["placement"] as Row | undefined;
    expect((read?.["dispatch"] as Row | undefined)?.["http"]).toBe(200);
    expect((read?.["dispatch"] as Row | undefined)?.["status"]).toBe("completed");
    expect((read?.["dispatch"] as Row | undefined)?.["reached"]).toBe(true);
    const missing = (await ask({ gap_id: id, dispatch_id: `d-none-${RUN}` }))["placement"] as Row | undefined;
    expect((missing?.["dispatch"] as Row | undefined)?.["http"]).toBe(404);
    // a placement query without a dispatch id carries no dispatch read
    expect(((await ask({ gap_id: id, targets: [] }))["placement"] as Row | undefined)?.["dispatch"]).toBeUndefined();
  });

  it("[MUST-FAIL] a placed dispatch nobody here reads settles by the dispatch timeout, not the foreign bound", () => {
    const bounds = supply.outcomeBoundsOf({});
    const sent = new Date(Date.now() - bounds.timeout_ms - 60_000).toISOString();
    const base = { state: "goal_dispatched", dispatch_id: "p-1", dispatch_node: "node-b", last_dispatch_at: sent };
    const placed = supply.dispatchVerdict({ ...base, placed_by: LOCAL } as never, null, Date.now(), bounds, LOCAL);
    expect(placed.kind).toBe("lost");
    expect((placed as { why?: string }).why).toBe("owning_node_never_settled");
    // a dispatch another sender made keeps the foreign bound, as today
    expect(supply.dispatchVerdict(base as never, null, Date.now(), bounds, LOCAL).kind).toBe("wait");
  });
});
