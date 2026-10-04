// THE GAP WRITE PATH NUDGES THE COMPOSER ONLY FOR A GAP THE LANE CAN COMPOSE.
//
// resolveSubstrateGapWrite fires a gap_to_feature nudge (systemctl start gap-compose.service plus an in-process
// gap_to_feature) on every open created/updated write, sharing the drain observer's in-flight/cooldown globals, with
// no eligibility check. The drain observer gates the same nudge on the written row: open, armed (falsifier
// class1/class2), naming an edit site, not held. The write path must use that same predicate on the row it just
// wrote, count each skip into the same per-window summary, and log nothing per event.
//
// Outbound side stubbed exactly as substrate-gap-compose-nudge-capacity.test.ts: Bun.spawnSync/Bun.spawn
// (systemctl), fetch (the in-process nudge; the policy reads answered as explicit open records). A real temp slot
// dir with a free autonomous slot, so the lane is not what refuses.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const root = mkdtempSync(join(tmpdir(), "write-nudge-eligibility-"));
process.env["WORKSPACE_ROOT"] = root;
const mod = await import(`../../src/resolvers/substrate-gap.js?${"write-nudge-eligibility"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) {
  throw new Error(`refusing to run: gap store ${mod.gapStoreRootForTest()} is not under ${tmpdir()}`);
}
const { __resetPolicyReadsForTests } = await import("../../src/resolvers/gap-to-feature.js");
const observer = (await import("../../src/services/gap-drain-observer.js")) as unknown as {
  __resetComposeNudgeGateForTests: () => void;
  __composeNudgeSkipCountsForTests?: () => Record<string, number>;
};

type G = { __gapComposeLastTrigger?: number; __composeDrainInflight?: boolean; __composeDrainLastAt?: number };
const g = globalThis as unknown as G;

const EDIT_SITE = "src/nudge-probe.ts";
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
  slotDir = mkdtempSync(join(tmpdir(), "write-nudge-slots-"));
  process.env["COMPOSE_SLOT_DIR"] = slotDir;
  process.env["COMPOSE_MAX_CONCURRENT"] = "2"; // autonomous lane cap = 1, free
  savedSkip = process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
  delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"]; // exercise the real trigger path
  saved = { __gapComposeLastTrigger: g.__gapComposeLastTrigger, __composeDrainInflight: g.__composeDrainInflight, __composeDrainLastAt: g.__composeDrainLastAt };
  g.__gapComposeLastTrigger = undefined;
  g.__composeDrainInflight = false;
  g.__composeDrainLastAt = undefined;
  observer.__resetComposeNudgeGateForTests();
  mkdirSync(join(root, "gaps"), { recursive: true });
  writeFileSync(join(root, "gaps", "gaps.json"), "[]");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, EDIT_SITE), "export const probe = 1;\n");
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
    if (body?.type === "devvessel.gap.written") return Response.json({ ok: true });
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
  observer.__resetComposeNudgeGateForTests();
  rmSync(slotDir, { recursive: true, force: true });
  __resetPolicyReadsForTests();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const vocab = { shapes: new Set(["trace_failure_pattern_report", "substrateGap", ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]), configs_read: 1 };
const judge = async (): Promise<string> => "present";

/** class1: an expected literal (absent from the file) at an existing edit site. */
const ARMED_AT_SITE = { edit_site: EDIT_SITE, expected_literal: "NUDGE_PROBE_LITERAL_NOT_YET_PRESENT" };
/** class2 with no edit site: a measured evidence resolve and nothing to edit. */
const ARMED_NO_SITE = { evidence_resolve: { shape: "trace_failure_pattern_report", nonzero_field: "occurrence_count" } };

const write = (id: string, meta: Record<string, unknown>, status = "open") =>
  mod.resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id, category: "systematic_failure", source: "substrate_detected", summary: `write nudge eligibility probe ${id}`, detected_at: "2026-10-03T00:00:00Z", status, classification_metadata: meta },
  } as never, { vocabulary: vocab, birthJudge: judge });

const skipCounts = (): Record<string, number> => observer.__composeNudgeSkipCountsForTests?.() ?? {};
const perEventSkipLines = (id: string) => logs.filter((l) => l.includes(id) && /skip/i.test(l) && !l.includes("compose lane full"));

describe("substrateGap_write compose nudge — the drain observer's eligibility predicate", () => {
  it("CONTROL: an open class1 gap with an edit site nudges the composer once", async () => {
    const r = await write("write-nudge-armed-site", ARMED_AT_SITE);
    expect((r.body as { falsifier?: string }).falsifier).toBe("class1");
    expect(nudges.length).toBe(1);
  });

  it("an open gap with an edit site but falsifier none is not nudged; counted unarmed, no line per event", async () => {
    const r = await write("write-nudge-unarmed-site", { edit_site: EDIT_SITE });
    expect((r.body as { falsifier?: string }).falsifier).toBe("none");
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(skipCounts()["unarmed"]).toBe(1);
    expect(perEventSkipLines("write-nudge-unarmed-site")).toEqual([]);
  });

  it("an armed (class2) open gap with no edit site is not nudged; counted no_edit_site", async () => {
    const r = await write("write-nudge-armed-nosite", ARMED_NO_SITE);
    expect((r.body as { falsifier?: string }).falsifier).toBe("class2");
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(skipCounts()["no_edit_site"]).toBe(1);
  });

  it("an armed open gap with an edit site under operator_hold is not nudged; counted held", async () => {
    await write("write-nudge-held", { ...ARMED_AT_SITE, operator_hold: true });
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(skipCounts()["held"]).toBe(1);
  });

  it("a STORED hold the rewrite omits still holds: the gate reads the merged row, not the incoming metadata", async () => {
    process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1"; // seed the held row without nudging
    await write("write-nudge-held-carried", { ...ARMED_AT_SITE, operator_hold: true });
    delete process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"];
    const r = await mod.resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { id: "write-nudge-held-carried", category: "systematic_failure", source: "substrate_detected", summary: "write nudge eligibility probe, summary changed", detected_at: "2026-10-03T00:00:00Z", status: "open", classification_metadata: { ...ARMED_AT_SITE } },
    } as never, { vocabulary: vocab, birthJudge: judge });
    expect((r.body as { action?: string }).action).toBe("updated");
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(skipCounts()["held"]).toBe(1);
  });

  it("a closed armed gap with an edit site is not nudged", async () => {
    await write("write-nudge-closed", ARMED_AT_SITE, "closed");
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
  });

  it("a skipped write does not spend the 60 s nudge throttle: an eligible write right after it still nudges", async () => {
    await write("write-nudge-unarmed-first", { edit_site: EDIT_SITE });
    await write("write-nudge-armed-second", ARMED_AT_SITE);
    expect(nudges.length).toBe(1);
  });

  it("SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER=1 still suppresses the whole trigger, eligible or not, and counts nothing", async () => {
    process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
    await write("write-nudge-flag-armed", ARMED_AT_SITE);
    await write("write-nudge-flag-unarmed", { edit_site: EDIT_SITE });
    expect(nudges.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(Object.values(skipCounts()).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
