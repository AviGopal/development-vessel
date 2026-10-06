// THE CONDUCTOR PRICES ITSELF BY CONTENTION, NOT BY LOAD AVERAGE (check-first).
//
// The affordability bucket was computed from /proc/loadavg. On 2026-10-06 node1 read load 23-25 on 16 cores
// (bucket 2, ceiling 0.333) and enqueued nothing for 31 consecutive ticks (~8 h), while PSI on the same host
// said it was uncontended: /proc/pressure/cpu "some" avg60 ~3%, io 0. A load average counts runnable AND
// uninterruptible tasks and is not a contention measure on this host.
//
// CONTRACT:
//  - the bucket comes from PSI "some avg60" for cpu and io, against thresholds read at use time from the shaped
//    rhythmPacing pool record (psi_bucket_thresholds), with defaults; the bucket is the worse of the two;
//  - when PSI cannot be read, the per-core loadavg bucket is used, a WARN is logged and a counter rises;
//  - an explicit pointer bucket_load still wins (callers and tests that pin it);
//  - the report names the source and the readings.
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rct from "../../src/resolvers/rhythm-conductor-tick.js";
const m = rct as any;
const affordabilityBucket = (...a: any[]) => m.affordabilityBucket(...a);
const parsePsiSomeAvg60 = (...a: any[]) => m.parsePsiSomeAvg60(...a);
const DEFAULT_PSI_BUCKET_THRESHOLDS = (m.DEFAULT_PSI_BUCKET_THRESHOLDS ?? { cpu: [15, 30, 50], io: [10, 20, 40] }) as { cpu: number[]; io: number[] };
const __setLoadReadersForTests = (x: any) => { if (typeof m.__setLoadReadersForTests === "function") m.__setLoadReadersForTests(x); };
const psiFallbackCount = (): number => (typeof m.psiFallbackCount === "function" ? m.psiFallbackCount() : -1);
const resolveRhythmConductorTick = rct.resolveRhythmConductorTick;
import { __resetPolicyReadsForTests } from "../../src/resolvers/gap-to-feature.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const PSI = (avg60: number) => `some avg10=${avg60.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=${avg60.toFixed(2)} total=12345\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

const originalFetch = globalThis.fetch;
beforeEach(() => { __resetPolicyReadsForTests(); __setLoadReadersForTests(null); });
afterEach(() => { globalThis.fetch = originalFetch; __resetPolicyReadsForTests(); __setLoadReadersForTests(null); });

describe("PSI affordability exports", () => {
  it("[MUST-FAIL] the module exports the PSI bucketing API", () => {
    expect(typeof m.affordabilityBucket).toBe("function");
    expect(typeof m.parsePsiSomeAvg60).toBe("function");
    expect(typeof m.__setLoadReadersForTests).toBe("function");
    expect(typeof m.psiFallbackCount).toBe("function");
    expect(m.DEFAULT_PSI_BUCKET_THRESHOLDS).toEqual({ cpu: [15, 30, 50], io: [10, 20, 40] });
  });
});

describe("parsePsiSomeAvg60", () => {
  it("reads the some-line avg60 as a percentage", () => {
    expect(parsePsiSomeAvg60(PSI(3.6))).toBeCloseTo(3.6, 5);
  });
  it("returns null on unparseable text", () => {
    expect(parsePsiSomeAvg60("garbage")).toBeNull();
  });
});

describe("affordabilityBucket", () => {
  it("[MUST-FAIL] loadavg 22 on 16 cores with PSI cpu some 3% is NOT priced out (bucket 0)", () => {
    const r = affordabilityBucket({ psiCpu: 3, psiIo: 0, load: 22, cores: 16, thresholds: DEFAULT_PSI_BUCKET_THRESHOLDS });
    expect(r.source).toBe("psi");
    expect(r.bucket).toBe(0);
  });
  it("[MUST-FAIL] PSI cpu some 60% is priced out (bucket 3, ceiling 0)", () => {
    const r = affordabilityBucket({ psiCpu: 60, psiIo: 0, load: 2, cores: 16, thresholds: DEFAULT_PSI_BUCKET_THRESHOLDS });
    expect(r.bucket).toBe(3);
  });
  it("[MUST-FAIL] high io pressure alone is priced out", () => {
    const r = affordabilityBucket({ psiCpu: 1, psiIo: 45, load: 1, cores: 16, thresholds: DEFAULT_PSI_BUCKET_THRESHOLDS });
    expect(r.bucket).toBe(3);
  });
  it("[MUST-FAIL] the shaped thresholds decide a borderline reading", () => {
    const base = affordabilityBucket({ psiCpu: 25, psiIo: 0, load: 1, cores: 16, thresholds: DEFAULT_PSI_BUCKET_THRESHOLDS });
    const relaxed = affordabilityBucket({ psiCpu: 25, psiIo: 0, load: 1, cores: 16, thresholds: { cpu: [30, 45, 70], io: DEFAULT_PSI_BUCKET_THRESHOLDS.io } });
    expect(base.bucket).toBe(1);
    expect(relaxed.bucket).toBe(0);
  });
  it("[MUST-FAIL] PSI unreadable falls back to the per-core loadavg bucket", () => {
    const r = affordabilityBucket({ psiCpu: null, psiIo: null, load: 22, cores: 16, thresholds: DEFAULT_PSI_BUCKET_THRESHOLDS });
    expect(r.source).toBe("loadavg");
    expect(r.bucket).toBe(2); // 22/16 = 1.375 per core
  });
});

function pacingFetch(pacing: Record<string, unknown> | null): typeof fetch {
  return (async (input: any, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    const imp = body?.impulse ?? {};
    if (imp.type === "poolImpulse" && imp.shape === "spendEnvelope") return openPolicyAnswer(imp.shape);
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (!url.startsWith("http://test/")) return new Response("not found", { status: 404 });
    if (imp.type === "poolImpulse") {
      const rows = imp.shape === "rhythmPacing" && pacing ? [{ id: "rhythm-pacing", shape: "rhythmPacing", body: pacing }] : [];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    return Response.json({ body: { ok: true } });
  }) as unknown as typeof fetch;
}

async function tick(pointerExtra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "rct-psi-"));
  const queuePath = join(dir, "queue.json");
  writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));
  const r = await resolveRhythmConductorTick({ type: "rhythm_conductor_tick", registry_endpoint: "http://test/v2/impulses/resolve", queue_path: queuePath, dry_run: true, ...pointerExtra } as any);
  return (r as any).body as Record<string, unknown>;
}

describe("rhythm_conductor_tick affordability source", () => {
  it("[MUST-FAIL] with no pinned bucket it buckets on PSI and reports the readings", async () => {
    __setLoadReadersForTests({ psiCpu: () => PSI(3), psiIo: () => PSI(0), loadavg: () => "22.0 22.5 21.5 3/900 1", cores: () => 16 });
    globalThis.fetch = pacingFetch(null);
    const b = await tick();
    expect(b["bucket_load"]).toBe(0);
    expect(b["load_source"]).toBe("psi");
    expect(b["psi_cpu"]).toBeCloseTo(3, 5);
    expect(b["load"]).toBeCloseTo(22, 5);
  });

  it("[MUST-FAIL] the thresholds are read from the shaped rhythmPacing record at use time", async () => {
    __setLoadReadersForTests({ psiCpu: () => PSI(25), psiIo: () => PSI(0), loadavg: () => "1.0 1.0 1.0 1/100 1", cores: () => 16 });
    globalThis.fetch = pacingFetch(null);
    expect((await tick())["bucket_load"]).toBe(1);
    globalThis.fetch = pacingFetch({ psi_bucket_thresholds: { cpu: [30, 45, 70], io: [10, 20, 40] } });
    expect((await tick())["bucket_load"]).toBe(0);
  });

  it("[MUST-FAIL] PSI unreadable ⇒ loadavg bucket, a WARN, and the fallback counter rises", async () => {
    const warns: string[] = [];
    const ow = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    try {
      __setLoadReadersForTests({ psiCpu: () => { throw new Error("ENOENT"); }, psiIo: () => { throw new Error("ENOENT"); }, loadavg: () => "22.0 22.5 21.5 3/900 1", cores: () => 16 });
      globalThis.fetch = pacingFetch(null);
      const before = psiFallbackCount();
      const b = await tick();
      expect(b["load_source"]).toBe("loadavg");
      expect(b["bucket_load"]).toBe(2);
      expect(psiFallbackCount()).toBe(before + 1);
      expect(b["psi_fallback"]).toBe(before + 1);
      expect(warns.some((w) => /PSI unreadable/i.test(w))).toBe(true);
    } finally { console.warn = ow; }
  });

  it("[CONTROL] an explicit bucket_load still wins", async () => {
    __setLoadReadersForTests({ psiCpu: () => PSI(3), psiIo: () => PSI(0), loadavg: () => "1 1 1 1/1 1", cores: () => 16 });
    globalThis.fetch = pacingFetch(null);
    const b = await tick({ bucket_load: 2 });
    expect(b["bucket_load"]).toBe(2);
    expect(b["load_source"]).toBe("pointer");
  });
});
