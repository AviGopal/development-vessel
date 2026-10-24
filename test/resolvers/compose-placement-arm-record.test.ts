// A COMPOSER'S ARM RECORD WEIGHS WHERE CHECK SUPPLY PLACES ITS COMPOSES (compose-placement.ts placeCompose).
//
// The arm step judges every check a supply compose wrote: armed, or not armed (green at HEAD, red for the wrong reason,
// existence only). The ledger names the node that composed it (dispatch_node), so the shared gap store holds each
// composer's recent arm verdicts, and nothing read them: placement chose the peer with the most free slots whatever
// the checks it wrote had come to. Each peer now answers a placement query with its arm record (composeOwnership
// placement.arm_record, counted from the shared store), and among peers tied on free slots the placer takes a Thompson
// draw from Beta(prior + armed, prior + not armed), the prior and window read from the check-supply rhythm body.
//
//   [MUST-FAIL] at equal free capacity, a peer whose recent arms failed is placed less than the clean peer over N
//               placements (listed first, so the old first-of-ties rule would give it every goal).
//   [CONTROL 1] with no arm record, the peer with the most free slots wins every placement, as before.
//   [CONTROL 2] exploration is not starved: the failed peer's share over N placements is above zero.
//   [MUST-FAIL] the producer side: a placement query is answered with this node's arm record from the store, over the
//               window the pointer names, counting only ledgers this node composed.
// Synthetic fixtures; the draws come from a seeded generator.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `compose-placement-arm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SLOTS = join(ROOT, "compose-slots");
const ENV_KEYS = ["WORKSPACE_ROOT", "GAP_STORE_ENDPOINT", "COMPOSE_SLOT_DIR", "METABOB_API_KEY", "SUBSTRATE_NAME", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["COMPOSE_SLOT_DIR"] = SLOTS;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];
process.env["METABOB_API_KEY"] = `synthetic-node-key-${Math.random().toString(36).slice(2, 10)}`;
const SELF = `arm-record-node-${Math.random().toString(36).slice(2, 8)}`;
process.env["SUBSTRATE_NAME"] = SELF;

const { __resetDiscoveryForTests } = await import("../../src/config.js");
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const slots = await import("../../src/compose-slots.js");
const placement = await import("../../src/resolvers/compose-placement.js");

type Row = Record<string, unknown>;
const VESSEL = "local-tools-vessel";
type Peer = { node: string; url: string; free: number; record?: { armed: number; not_armed: number } };
let peers: Peer[] = [];
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;

/** A seeded uniform source (mulberry32): the same draws on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(() => {
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(SLOTS, { recursive: true });
  // This node's one unarmed slot is held, so every placement asks the peers.
  writeFileSync(join(SLOTS, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "synthetic-holder" }));
  slots.__setComposeCapacityReaderForTests(async () => ({ max_concurrent: 2, reserved_for_armed: 0 }));
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const peer = peers.find((p) => url.startsWith(p.url));
    if (peer) {
      const ptr = (body?.impulse?.pointer ?? {}) as Row;
      return Response.json({ success: true, shape: "composeOwnership", body: { node: peer.node, owned_repos: [VESSEL],
        placement: { armed: ptr["armed"] === true, capacity: { free: peer.free, live: 0, cap: peer.free }, scope_readable: true, scope_excludes: [], gap_row_visible: true,
          ...(peer.record ? { arm_record: { ...peer.record, window: 20 } } : {}) } } });
    }
    const imp = body?.impulse ?? {};
    const cap = body?.pointer ?? imp?.pointer;
    if (cap?.type === "vesselCapability") {
      if (cap.shape === "composeOwnership") {
        return Response.json({ content: { vessels: [
          { vesselId: "development-vessel-self", endpoint: "http://127.0.0.1:8090", resolve_endpoint: "http://127.0.0.1:8090/v2/impulses/resolve", origin: "local" },
          ...peers.map((p) => ({ vesselId: `development-vessel-${p.node}`, endpoint: p.url, resolve_endpoint: `${p.url}/v2/impulses/resolve`, origin: "peer:http://127.0.0.1:28100" })),
        ] } });
      }
      if (cap.shape === "poolImpulse") return Response.json({ content: { vessels: [{ vesselId: "pool-self", endpoint: "http://pool.self.test", resolve_endpoint: "http://pool.self.test/v2/impulses/resolve", origin: "local" }] } });
      return Response.json({ content: { vessels: [] } });
    }
    if (url.startsWith("http://pool.self.test") && imp?.shape === "autonomyScope") {
      return Response.json({ body: { impulses: [{ shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: { excluded_paths: [] } }] } });
    }
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = () => {};
  console.warn = () => {};
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  slots.__setComposeCapacityReaderForTests(null);
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { peers = []; g2fPolicy.__resetPolicyReadsForTests(); __resetDiscoveryForTests(); });

const N = 200;
/** N independent placements (a fresh per-pass debit each), counted by the node that took each. */
async function shares(seed: number): Promise<Map<string, number>> {
  const rng = seeded(seed);
  const count = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const p = await placement.placeCompose({ gap_id: `arm-record-gap-${i}`, vessel: VESSEL, targets: [], armed: false }, SELF, new Map(), { arm: { prior_alpha: 1, prior_beta: 1, window: 20 }, rng } as never);
    const node = p.where === "peer" ? p.node : "local";
    count.set(node, (count.get(node) ?? 0) + 1);
  }
  return count;
}

describe("placement weighs a composer by its arm record", () => {
  it("[MUST-FAIL] at equal free capacity the peer whose recent arms failed is placed less than the clean peer [CONTROL 2: but above zero]", async () => {
    // The failed peer is listed (and answers) first: the first-of-ties rule gave it every goal.
    peers = [
      // A mixed record either way, so the share is measurable in N = 200: Beta(2,4) against Beta(4,2), about 18% of draws.
      { node: "node-failed", url: "http://127.0.0.1:18951", free: 1, record: { armed: 1, not_armed: 3 } },
      { node: "node-clean", url: "http://127.0.0.1:18952", free: 1, record: { armed: 3, not_armed: 1 } },
    ];
    const c = await shares(20261024);
    const failed = c.get("node-failed") ?? 0;
    const clean = c.get("node-clean") ?? 0;
    expect(failed + clean).toBe(N);
    expect(failed).toBeLessThan(clean);
    expect(failed / N).toBeLessThan(0.35);
    // CONTROL 2: exploration is not starved.
    expect(failed).toBeGreaterThan(0);
  });

  it("[CONTROL 1] with no arm record the peer with the most free slots takes every placement, as before", async () => {
    peers = [
      { node: "node-one-free", url: "http://127.0.0.1:18953", free: 1 },
      { node: "node-two-free", url: "http://127.0.0.1:18954", free: 2 },
    ];
    const c = await shares(7);
    expect(c.get("node-two-free")).toBe(N);
  });

  it("[CONTROL 1'] a better arm record never outranks more free slots", async () => {
    peers = [
      { node: "node-clean-one-free", url: "http://127.0.0.1:18955", free: 1, record: { armed: 9, not_armed: 0 } },
      { node: "node-failed-two-free", url: "http://127.0.0.1:18956", free: 2, record: { armed: 0, not_armed: 9 } },
    ];
    const c = await shares(11);
    expect(c.get("node-failed-two-free")).toBe(N);
  });
});

describe("the producer side answers its own arm record", () => {
  it("[MUST-FAIL] a placement query carries this node's arm verdicts as a composer, over the pointer's window", async () => {
    const ledger = (node: string, state: string, at: string): Row => ({ dispatch_node: node, state, armed_at: at, last_dispatch_at: at });
    const row = (id: string, l: Row): Row => ({ id, category: "systematic_failure", source: "operator", status: "open", summary: `arm record fixture ${id}`, detected_at: "2026-10-01T00:00:00Z", classification_metadata: { check_supply: l } });
    const rows = [
      row("ar-1", ledger(SELF, "armed", "2026-10-20T01:00:00Z")),
      row("ar-2", ledger(SELF, "arm_refused", "2026-10-20T02:00:00Z")),
      row("ar-3", ledger(SELF, "green_at_head", "2026-10-20T03:00:00Z")),
      row("ar-4", ledger(SELF, "armed", "2026-10-20T04:00:00Z")),
      row("ar-5", ledger(SELF, "goal_dispatched", "2026-10-20T05:00:00Z")), // no verdict yet: not counted
      row("ar-6", ledger("another-node", "arm_refused", "2026-10-20T06:00:00Z")), // another composer's
      row("ar-0", ledger(SELF, "existence_only", "2026-10-19T00:00:00Z")), // oldest: outside a window of 4
    ];
    writeFileSync(join(sg.gapStoreRootForTest(), "gaps", "gaps.json"), JSON.stringify(rows));
    const all = await placement.composePlacementAnswer({ type: "composeOwnership", gap_id: "ar-1", targets: [], armed: false, arm_window: 20 });
    expect(all?.gap_row_visible).toBe(true);
    expect(all?.arm_record).toEqual({ armed: 2, not_armed: 3, window: 20 });
    const recent = await placement.composePlacementAnswer({ type: "composeOwnership", gap_id: "ar-1", targets: [], armed: false, arm_window: 4 });
    expect(recent?.arm_record).toEqual({ armed: 2, not_armed: 2, window: 4 });
    // A plain read is answered as before: no placement at all.
    expect(await placement.composePlacementAnswer({ type: "composeOwnership" })).toBeNull();
  });
});
