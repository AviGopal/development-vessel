// THE CALLER WHO STOPPED WAITING (compose-caller-cut; USER: "Operator: fix 1"). A goal-host dispatch that gives up on a
// compose drops the connection; the compose used to run on, holding its slot (median 1249 s after the cut) while later
// goals were refused BUSY. The inbound Request's own AbortSignal says the caller left; index.ts binds it for a
// feature_compose body (never while this process drains) and the compose reads it at three checkpoints.
//   - [MUST-FAIL] a client that drops the connection aborts the bound signal; [CONTROL] this process's own drain and
//     server.stop never do, with a REAL Bun server.
//   - [CONTROL] variant-0 goes on at every checkpoint (byte-identical: the call sites branch only on a report), logging
//     the cut once and posting its own trace.
//   - [MUST-FAIL] variant-1 stops a goal-host compose with CALLER_GONE before drafting or a repair round; never one with
//     no dispatch id; never at the cutover (a compose past its verify lands).
//   - [MUST-FAIL] the next acquire of the cut's slot class settles its credit: admitted -> reached, BUSY -> not, every
//     pending cut of the class at once with settled_by; another class untouched; older than 30 min -> ungraded.
//   - [CONTROL] at a cut, a mask that is unset, names variant-0, or cannot be read leaves a goal-host compose on
//     variant-0: it goes on at every checkpoint, reads once, logs once, never retries.
//   - [MUST-FAIL] the mask is read only at a cut, once per compose, so a compose whose caller stays logs exactly what it
//     logged before (the F5(b) golden pins that log).
//   - the mask's log lines are the shared form; the wiring is where the checkpoints say.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const lr = (await import("../../src/long-running.js")) as Record<string, any>;
const SRC = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", "src", rel), "utf8");
const P = "[development-vessel:compose-caller-cut]";

type Trace = Record<string, any>;
const capture = () => {
  const lines: string[] = [];
  const log = console.log, warn = console.warn;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.log = log; console.warn = warn; } };
};
// The fixture clock: a fixed instant read once, so lines can be matched exactly (no literal dates in tests).
const T0 = Date.now() - (Date.now() % 1000);
const T0_ISO = new Date(T0).toISOString();
const gone = () => { const ac = new AbortController(); ac.abort({ at: T0_ISO }); return ac.signal; };
const state = (variant: number, dispatchId: string | null, directed = false) => ({ variant, why: `fixture variant-${variant}`, gapId: "gap-fixture", dispatchId, directed });
// A compose's pointer as the run carries it: its caller-cut state under COMPOSE_CUT_STATE, copied by a spread.
const ptr = (st: Record<string, unknown>) => ({ ...{ type: "feature_compose", [fc.COMPOSE_CUT_STATE]: st } });
const at = (signal: AbortSignal | undefined, st: Record<string, unknown>, fn: (p: unknown) => unknown) => { const p = ptr(st); return fc.runWithCallerGone(signal, () => fn(p)); };
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => fc.__setCallerCutDepsForTests(null));

describe("the caller-gone signal", () => {
  it("[MUST-FAIL] a client dropping the connection aborts it, with the time it left; a draining process does not", () => {
    const req = new AbortController();
    const s = fc.bindCallerGone(req.signal, () => false);
    expect(s.aborted).toBe(false);
    req.abort();
    expect(s.aborted).toBe(true);
    expect(typeof (s.reason as { at?: unknown }).at).toBe("string");
    const req2 = new AbortController();
    const s2 = fc.bindCallerGone(req2.signal, () => true);
    req2.abort();
    expect(s2.aborted).toBe(false);
  });
  it("[CONTROL, real server] a client timeout aborts it; this process's own drain and server.stop do not", async () => {
    let draining = false;
    const seen: Record<string, boolean> = {};
    const srv = Bun.serve({ port: 0, idleTimeout: 30, async fetch(req) {
      const s = fc.bindCallerGone(req.signal, () => draining);
      const tag = new URL(req.url).pathname;
      await new Promise((r) => setTimeout(r, 800));
      seen[tag] = s.aborted;
      return new Response("ok");
    } });
    await fetch(`http://127.0.0.1:${srv.port}/client-drop`, { signal: AbortSignal.timeout(150) }).catch(() => null);
    await new Promise((r) => setTimeout(r, 900));
    const inFlight = fetch(`http://127.0.0.1:${srv.port}/drain`).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    draining = true;
    srv.stop(true);
    await inFlight;
    await new Promise((r) => setTimeout(r, 900));
    expect(seen["/client-drop"]).toBe(true);
    expect(seen["/drain"] ?? false).toBe(false);
  }, 15_000);
});

describe("the checkpoints", () => {
  it("[CONTROL] variant-0 goes on at every checkpoint; the cut is logged once and traced once", () => {
    const traces: Trace[] = [];
    fc.__setCallerCutDepsForTests({ postTrace: async (t: Trace) => { traces.push(t); return 201; } });
    const st = state(0, "dispatch-1");
    const c = capture();
    let r: unknown[] = [];
    try { r = ["before_draft", "repair_round", "repair_round", "before_cutover"].map((stage) => at(gone(), st, (p) => fc.callerCutCheckpoint(stage, p))); } finally { c.restore(); }
    expect(r).toEqual([null, null, null, null]);
    const decision = c.lines.filter((l) => l.startsWith(`${P} cut observed dispatch=`));
    expect(decision.length).toBe(1);
    expect(decision[0]).toContain("dispatch=dispatch-1 gap=gap-fixture variant=0 (fixture variant-0)");
    expect(decision[0]).toContain(`stage=before_draft lane=undirected cut_at=${T0_ISO} observed_at=`);
    expect(decision[0]).toMatch(/ node=\S+ stage=/);
    expect(c.lines).toContain(`${P} cut observed, landing gap=gap-fixture stopped=false reason=past_verify`);
    expect(traces.length).toBe(1);
    expect(traces[0]!["activity_variant_id"]).toBe("development-vessel:compose-caller-cut");
    expect(traces[0]!["output_shapes"]).toEqual(["composeCallerCut"]);
  });
  it("[CONTROL] no caller gone, or no compose state: every checkpoint goes on and nothing is logged or traced", () => {
    const traces: Trace[] = [];
    fc.__setCallerCutDepsForTests({ postTrace: async (t: Trace) => { traces.push(t); return 201; } });
    expect(at(new AbortController().signal, state(1, "d"), (p: unknown) => fc.callerCutCheckpoint("before_draft", p))).toBeNull();
    expect(fc.runWithCallerGone(gone(), () => fc.callerCutCheckpoint("before_draft", { type: "feature_compose" }))).toBeNull();
    expect(fc.callerCutCheckpoint("repair_round", ptr(state(1, "d")))).toBeNull();
    expect(traces.length).toBe(0);
  });
  it("the state rides the pointer through the run's spreads, and is never serialised", () => {
    fc.__setCallerCutDepsForTests({ postTrace: async () => 201 });
    const p = ptr(state(1, "d-copy")) as Record<string, unknown>;
    const c = capture();
    let r: any;
    try { r = fc.runWithCallerGone(gone(), () => fc.callerCutCheckpoint("before_draft", { ...{ ...p, spec: "copied" } })); } finally { c.restore(); }
    expect(r?.body?.verdict).toBe("CALLER_GONE");
    expect(JSON.stringify(p)).toBe('{"type":"feature_compose"}');
  });
  it("[MUST-FAIL] variant-1 stops a goal-host compose with CALLER_GONE before drafting, and at a repair round", () => {
    fc.__setCallerCutDepsForTests({ postTrace: async () => 201 });
    const c = capture();
    let a: any, b: any;
    try {
      a = at(gone(), state(1, "dispatch-2"), (p: unknown) => fc.callerCutCheckpoint("before_draft", p));
      b = at(gone(), state(1, "dispatch-3"), (p: unknown) => fc.callerCutCheckpoint("repair_round", p));
    } finally { c.restore(); }
    expect(a).toMatchObject({ shape: "featureComposeReport", body: { ok: false, verdict: "CALLER_GONE", stage: "before_draft" } });
    expect(b?.body?.stage).toBe("repair_round");
  });
  it("[CONTROL] variant-1 never stops a compose with no dispatch id, nor one at the cutover", () => {
    fc.__setCallerCutDepsForTests({ postTrace: async () => 201 });
    const c = capture();
    try {
      expect(at(gone(), state(1, null), (p: unknown) => fc.callerCutCheckpoint("before_draft", p))).toBeNull();
      expect(at(gone(), state(1, "dispatch-4"), (p: unknown) => fc.callerCutCheckpoint("before_cutover", p))).toBeNull();
    } finally { c.restore(); }
    expect(c.lines.some((l) => l.includes("dispatch=none"))).toBe(true);
  });
});

describe("the credit: the next acquire of the cut's slot class", () => {
  const observe = (directed: boolean, traces: Trace[]) => {
    const c = capture();
    try { at(gone(), state(0, "d", directed), (p: unknown) => fc.callerCutCheckpoint("before_draft", p)); } finally { c.restore(); }
    return traces[traces.length - 1]!["execution_id"] as string;
  };
  it("[MUST-FAIL] admitted -> reached, BUSY -> not, all pending in the class at once, another class untouched", async () => {
    const traces: Trace[] = [];
    let now = T0 + 5 * 60_000;
    fc.__setCallerCutDepsForTests({ postTrace: async (t: Trace) => { traces.push(t); return 201; }, nowMs: () => now });
    const u1 = observe(false, traces), u2 = observe(false, traces), d1 = observe(true, traces);
    expect(fc.settleCallerCutCredits(false, true, "acquire-1")).toBe(2);
    await settle();
    const credits = traces.filter((t) => t["activity_id"] === "development-vessel:compose-caller-cut-credit");
    expect(credits.map((t) => t["composition_chain"][0]).sort()).toEqual([u1, u2].sort());
    expect(credits.every((t) => t["tags"].includes("reached:true") && t["metadata"]["settled_by"] === "acquire-1")).toBe(true);
    expect(fc.settleCallerCutCredits(true, false, "acquire-2")).toBe(1);
    await settle();
    const busy = traces.filter((t) => t["activity_id"] === "development-vessel:compose-caller-cut-credit" && t["composition_chain"][0] === d1);
    expect(busy[0]!["tags"]).toContain("reached:false");
    expect(fc.settleCallerCutCredits(false, true, "acquire-3")).toBe(0);
  });
  it("[CONTROL] a cut with no acquire of its class within 30 min is ungraded, not credited", async () => {
    const traces: Trace[] = [];
    let now = T0 + 5 * 60_000;
    fc.__setCallerCutDepsForTests({ postTrace: async (t: Trace) => { traces.push(t); return 201; }, nowMs: () => now });
    observe(false, traces);
    now += 31 * 60_000;
    const c = capture();
    try { expect(fc.settleCallerCutCredits(false, true, "acquire-late")).toBe(0); } finally { c.restore(); }
    expect(c.lines.some((l) => l.startsWith(`${P} ungraded `))).toBe(true);
    await settle();
    expect(traces.some((t) => t["activity_id"] === "development-vessel:compose-caller-cut-credit")).toBe(false);
  });
});

describe("the mask and the wiring", () => {
  it("the mask selects the variant; a failed read is mask_unread (every time), pool_read at most once per 30 s", () => {
    const at0 = new Date().toISOString();
    const DAY = 86_400_000;
    const row = (v: unknown) => [{ id: "mask-ccc", body: { activity_id: "development-vessel:compose-caller-cut", active_variant: v, from: new Date(Date.now() - DAY).toISOString(), until: new Date(Date.now() + DAY).toISOString(), reason: "fixture", by: "operator" } }];
    fc.__setCallerCutDepsForTests({ readMasks: () => [] });
    expect(fc.composeCallerCutVariant(at0)).toMatchObject({ variant: 0, why: "no mask in force: variant-0" });
    fc.__setCallerCutDepsForTests({ readMasks: () => row(1) });
    expect(fc.composeCallerCutVariant(at0).variant).toBe(1);
    fc.__setCallerCutDepsForTests({ readMasks: () => row(7) });
    expect(fc.composeCallerCutVariant(at0).variant).toBe(0);
    fc.__setCallerCutDepsForTests({ readMasks: () => { throw new Error("pool down"); } });
    const c = capture();
    try { fc.composeCallerCutVariant(at0); fc.composeCallerCutVariant(at0); } finally { c.restore(); }
    expect(c.lines.filter((l) => l === `${P} mask_unread (pool down): variant-0`).length).toBe(2);
    expect(c.lines.filter((l) => l === `${P} pool_read shape=activityVariantMask ok=false`).length).toBe(1);
  });
  it("[MUST-FAIL] the mask is read at a cut, once per compose: a compose whose caller stays reads none and logs nothing", async () => {
    let reads = 0;
    fc.__setCallerCutDepsForTests({ readMasks: () => { reads += 1; return []; }, postTrace: async () => 200 });
    const st: Record<string, unknown> = { gapId: "gap-fixture", dispatchId: "d-fixture", directed: false };
    const p = ptr(st);
    const stages = ["before_draft", "repair_round", "before_cutover"];
    const c = capture();
    try {
      for (const s of stages) fc.runWithCallerGone(undefined, () => fc.callerCutCheckpoint(s, p));
      for (const s of stages) fc.runWithCallerGone(new AbortController().signal, () => fc.callerCutCheckpoint(s, p));
      expect(reads).toBe(0);
      expect(c.lines).toEqual([]);
      for (const s of stages) fc.runWithCallerGone(gone(), () => fc.callerCutCheckpoint(s, p));
      await settle();
    } finally { c.restore(); }
    expect(reads).toBe(1);
    expect(st).toMatchObject({ variant: 0, why: "no mask in force: variant-0" });
    expect(c.lines.filter((l) => l === `${P} pool_read shape=activityVariantMask ok=true`).length).toBe(1);
    // The compose's entry builds its state without reading the mask: the one call is the checkpoint's.
    expect(SRC("resolvers/feature-compose.ts").split("composeCallerCutVariant(").length - 1).toBe(2);
  });
  it("[CONTROL] at a cut with the mask unset, naming variant-0, or unreadable, a goal-host compose goes on as before: one read, one decision line, no stop, no retry", async () => {
    const DAY = 86_400_000;
    const v0 = [{ id: "mask-ccc-v0", body: { activity_id: "development-vessel:compose-caller-cut", active_variant: 0, from: new Date(Date.now() - DAY).toISOString(), until: new Date(Date.now() + DAY).toISOString(), reason: "fixture", by: "operator" } }];
    const cases: Array<[string, () => unknown[], string]> = [
      ["unset", () => [], "no mask in force: variant-0"],
      ["variant-0", () => v0, "mask mask-ccc-v0"],
      ["unreadable", () => { throw new Error("pool down"); }, "mask_unread (pool down): variant-0"],
    ];
    for (const [name, rows, why] of cases) {
      let reads = 0;
      fc.__setCallerCutDepsForTests({ readMasks: () => { reads += 1; return rows(); }, postTrace: async () => 200 });
      const st: Record<string, unknown> = { gapId: "gap-fixture", dispatchId: "d-fixture", directed: true };
      const p = ptr(st);
      const c = capture();
      const out: unknown[] = [];
      try {
        for (const s of ["before_draft", "repair_round", "repair_round", "before_cutover"]) out.push(fc.runWithCallerGone(gone(), () => fc.callerCutCheckpoint(s, p)));
        await settle();
      } finally { c.restore(); }
      expect({ name, out }).toEqual({ name, out: [null, null, null, null] });
      expect({ name, reads }).toEqual({ name, reads: 1 });
      expect({ name, variant: st["variant"], stopped: st["stopped"] }).toEqual({ name, variant: 0, stopped: undefined });
      expect(String(st["why"])).toStartWith(why);
      expect(c.lines.filter((l) => l.startsWith(`${P} cut observed dispatch=d-fixture`) && l.includes(" variant=0 ")).length).toBe(1);
      expect(c.lines.filter((l) => l === `${P} cut observed, landing gap=gap-fixture stopped=false reason=past_verify`).length).toBe(1);
      expect(c.lines.filter((l) => l.includes(" stopped gap=") || l.includes("CALLER_GONE")).length).toBe(0);
      expect(c.lines.filter((l) => l === `${P} mask_unread (pool down): variant-0`).length).toBe(name === "unreadable" ? 1 : 0);
      expect(c.lines.filter((l) => l.includes("pool_read shape=activityVariantMask")).length).toBe(1);
    }
  });
  it("index.ts binds the signal for a feature_compose body only, with the drain flag, and runs the request under it", () => {
    const src = SRC("index.ts");
    expect(src).toContain('if (longRunningType(raw) === "feature_compose") callerGone = bindCallerGone(req.signal, () => devDraining);');
    expect(src).toContain("return await runWithCallerGone(callerGone, () => (startRec ? runInFlight(startRec, () => app.fetch(forwarded, srv)) : app.fetch(forwarded, srv)));");
    expect(lr.longRunningType(JSON.stringify({ impulse: { pointer: { type: "feature_compose" } } }))).toBe("feature_compose");
    expect(lr.longRunningType(JSON.stringify({ pointer: { type: "gap_to_feature" } }))).toBe("gap_to_feature");
    expect(lr.longRunningType("not json")).toBeNull();
    expect(lr.isLongRunningBody(JSON.stringify({ pointer: { type: "llm_completion_dispatch" } }))).toBe(false);
  });
  it("dv's own drain (developmentVesselDrain, run on SIGTERM, which vessel-ctl restart sends) raises the drain flag before it stops the server, so its stop never reads as a caller leaving", () => {
    const src = SRC("index.ts");
    const a = src.indexOf("async function developmentVesselDrain(sig: string): Promise<void> {");
    const b = src.indexOf("\n}\n", a);
    expect(a).toBeGreaterThan(0);
    const fn = src.slice(a, b);
    const flag = fn.indexOf("devDraining = true;"), stop = fn.indexOf("server.stop(true)");
    expect(flag).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(flag);
    // nothing anywhere in the entrypoint lowers the drain flag, and the stop never moves ahead of it
    expect(src.match(/devDraining\s*=\s*false/g)?.length ?? 0).toBe(1); // its one declaration, `let devDraining = false;`
    expect(src).toContain("let devDraining = false;");
    expect(src).toContain('process.on("SIGTERM", () => { void developmentVesselDrain("SIGTERM"); });');
  });
  it("feature-compose checks at exactly three places: before the draft and each repair round (may stop), before the cutover (records only)", () => {
    const src = SRC("resolvers/feature-compose.ts");
    expect(src.split('{ const _callerGone = callerCutCheckpoint("before_draft", pointer); if (_callerGone) return _callerGone; }').length - 1).toBe(1);
    expect(src.split('{ const _callerGone = callerCutCheckpoint("repair_round", pointer); if (_callerGone) return _callerGone; }').length - 1).toBe(1);
    expect(src.split('      callerCutCheckpoint("before_cutover", pointer);\n      const cut = await resolveVesselMitosisCutover({').length - 1).toBe(1);
    expect(src).toContain("settleCallerCutCredits(isDirected, slot.granted, slotId);");
  });
});
