import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

// THE NUDGE MUST SEE A FREE SLOT AS FREE.
//
// An open substrateGap_write nudges the compose lane, guarded by a capacity check that reads
// peekComposeCapacity(). peekComposeCapacity returns {free: number, live: number, cap: number}.
// The nudge's reader (799bd58d) duck-typed that result through `as unknown as {...}` looking for
// boolean flags or an {observed, cap} pair; none matched, so it fell to "unknown shape => no
// capacity" on EVERY write. Measured live: ~170 "compose nudge skipped … compose lane full" lines on
// one node in a day and zero "compose nudge for … finished". The sibling reader in gap-to-feature
// reads `free` correctly, so the two readers disagreed about the same slot directory.
//
// These tests drive the REAL peekComposeCapacity against a temp slot dir (COMPOSE_SLOT_DIR, read by
// slotDir() at call time). Only the outbound side is stubbed: Bun.spawnSync/Bun.spawn (systemctl)
// and fetch (the in-process gap_to_feature nudge, plus the policy reads, answered as the explicit
// open records so the spend envelope admits the nudge for a reason this test is not about).

const root = mkdtempSync(join(tmpdir(), "nudge-capacity-"));
process.env["WORKSPACE_ROOT"] = root;
const mod = await import(`../../src/resolvers/substrate-gap.js?${"nudge-capacity-isolated"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) {
  throw new Error(`refusing to run: gap store ${mod.gapStoreRootForTest()} is not under ${tmpdir()}`);
}
const { __resetPolicyReadsForTests } = await import("../../src/resolvers/gap-to-feature.js");

type G = { __gapComposeLastTrigger?: number; __composeDrainInflight?: boolean; __composeDrainLastAt?: number };
const g = globalThis as unknown as G;

let slotDir = "";
let saved: G = {};
let savedSkip: string | undefined;
let logs: string[] = [];
let nudges: string[] = [];
let spawns: unknown[] = [];
const realLog = console.log;
const realFetch = globalThis.fetch;
const realSpawnSync = Bun.spawnSync;
const realSpawn = Bun.spawn;

beforeEach(() => {
  slotDir = mkdtempSync(join(tmpdir(), "nudge-slots-"));
  process.env["COMPOSE_SLOT_DIR"] = slotDir;
  process.env["COMPOSE_MAX_CONCURRENT"] = "2"; // autonomous lane cap = 1
  savedSkip = process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
  delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"]; // exercise the real trigger path
  saved = { __gapComposeLastTrigger: g.__gapComposeLastTrigger, __composeDrainInflight: g.__composeDrainInflight, __composeDrainLastAt: g.__composeDrainLastAt };
  g.__gapComposeLastTrigger = undefined;
  g.__composeDrainInflight = false;
  g.__composeDrainLastAt = undefined;
  mkdirSync(join(mod.gapStoreRootForTest(), "gaps"), { recursive: true });
  writeFileSync(join(mod.gapStoreRootForTest(), "gaps", "gaps.json"), "[]");
  logs = []; nudges = []; spawns = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  (Bun as unknown as { spawnSync: unknown }).spawnSync = ((...a: unknown[]) => {
    spawns.push(a);
    return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  }) as unknown;
  (Bun as unknown as { spawn: unknown }).spawn = ((...a: unknown[]) => {
    spawns.push(a);
    return { exited: Promise.resolve(0), stderr: new Response("").body };
  }) as unknown;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (body?.impulse?.type === "gap_to_feature") { nudges.push(String(init?.body)); return Response.json({ ok: true }); }
    throw new TypeError("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
});

afterEach(() => {
  console.log = realLog;
  globalThis.fetch = realFetch;
  (Bun as unknown as { spawnSync: unknown }).spawnSync = realSpawnSync;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
  if (savedSkip === undefined) delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"]; else process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = savedSkip;
  delete process.env["COMPOSE_SLOT_DIR"];
  delete process.env["COMPOSE_MAX_CONCURRENT"];
  g.__gapComposeLastTrigger = saved.__gapComposeLastTrigger;
  g.__composeDrainInflight = saved.__composeDrainInflight;
  g.__composeDrainLastAt = saved.__composeDrainLastAt;
  rmSync(slotDir, { recursive: true, force: true });
  __resetPolicyReadsForTests();
});

// The nudge fires only for a gap the lane can compose (composeEligibilitySkipReason: open, armed, an edit site, not
// held), so the probe is a class1 gap at an existing edit site; capacity is then the only thing that varies.
const writeOpenGap = (id: string) => {
  mkdirSync(join(mod.gapStoreRootForTest(), "src"), { recursive: true });
  writeFileSync(join(mod.gapStoreRootForTest(), "src", "nudge-capacity-probe.ts"), "export const probe = 1;\n");
  return mod.resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: {
      id, category: "conversation_only", source: "operator_narration", summary: `nudge capacity probe ${id}`, detected_at: "2026-10-03T00:00:00Z", status: "open",
      classification_metadata: { edit_site: "src/nudge-capacity-probe.ts", expected_literal: "NUDGE_CAPACITY_PROBE_LITERAL_NOT_YET_PRESENT" },
    },
  } as never, { vocabulary: { shapes: new Set(["substrateGap"]), configs_read: 1 }, birthJudge: async () => "present" });
};

describe("substrateGap_write compose nudge — reads the real peekComposeCapacity shape", () => {
  it("with the autonomous slot FREE, an open gap write fires the gap_to_feature nudge and never logs lane full", async () => {
    await writeOpenGap("nudge-capacity-free-probe");
    const laneFull = logs.filter((l) => l.includes("compose lane full"));
    expect(laneFull).toEqual([]);
    expect(nudges.length).toBe(1);
    expect(logs.some((l) => l.includes("event-driven gap-compose pickup triggered by nudge-capacity-free-probe"))).toBe(true);
  });

  it("CONTROL: with the autonomous slot HELD by a live holder, the same write logs compose lane full and fires nothing", async () => {
    // A live slot exactly as acquireComposeSlot writes it: slot-0 claimed by a pid that is alive.
    writeFileSync(join(slotDir, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "held" }));
    await writeOpenGap("nudge-capacity-full-probe");
    expect(logs.some((l) => l.includes("compose nudge skipped for nudge-capacity-full-probe — compose lane full"))).toBe(true);
    expect(nudges.length).toBe(0);
  });
});
