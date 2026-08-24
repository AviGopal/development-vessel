import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRhythmConductorTick } from "../../src/resolvers/rhythm-conductor-tick.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// A due+affordable gap-closing rhythm and a not-due/not-affordable pattern-mining one.
const RHYTHMS = [
  {
    id: "rhythm-gap-closing",
    shape: "timeShapedRhythm",
    body: { axis: "gap", axis_code: 3, family: "gap-closing", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 },
  },
  {
    id: "rhythm-pattern-mining",
    shape: "timeShapedRhythm",
    body: { axis: "pattern", axis_code: 4, family: "pattern-mining", budget: 0.9, alpha: 1, beta: 5, staleness: 0.1 },
  },
];

function scriptedFetch(onDecay: (id: string) => void): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    if (url.includes("/v2/impulses/resolve")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const t = body?.impulse?.type;
      if (t === "poolImpulse") {
        return new Response(JSON.stringify({ body: { impulses: RHYTHMS, count: RHYTHMS.length } }), { status: 200 });
      }
      if (t === "poolImpulse_write") {
        onDecay(String(body.impulse.id));
        return new Response(JSON.stringify({ body: { ok: true, id: body.impulse.id } }), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("rhythm_conductor_tick", () => {
  it("enqueues only the affordable+due family and decays the fired rhythm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rct-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));

    const decayed: string[] = [];
    globalThis.fetch = scriptedFetch((id) => decayed.push(id));

    const r = await resolveRhythmConductorTick({
      type: "rhythm_conductor_tick",
      bucket_load: 0, // deterministic: don't let the host's real load gate affordability
      registry_endpoint: "http://test/v2/impulses/resolve",
      queue_path: queuePath,
    });
    const body = r.body as any;

    // gap-closing is due+affordable; pattern-mining is neither → only gap-closing enqueued.
    expect(body.enqueued.map((e: any) => e.family)).toEqual(["gap-closing"]);
    expect(body.enqueued[0].goal).toContain("drain the highest-priority");

    // The enqueue actually landed a task in the boredom queue.
    const q = JSON.parse(readFileSync(queuePath, "utf-8"));
    expect(q.tasks.length).toBe(1);
    expect(q.tasks[0].reason).toContain("gap-closing");

    // The fired rhythm was decayed (credit accrual + staleness reset).
    expect(decayed).toContain("rhythm-gap-closing");
    expect(decayed).not.toContain("rhythm-pattern-mining");
  });

  it("dedups against a family already pending in the queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rct-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(
      queuePath,
      JSON.stringify({ tasks: [{ id: "x", status: "pending", reason: "rhythm gap-closing due (score 9.0)" }], lastUpdated: 0 }),
    );
    globalThis.fetch = scriptedFetch(() => {});

    const r = await resolveRhythmConductorTick({
      type: "rhythm_conductor_tick",
      bucket_load: 0, // deterministic: don't let the host's real load gate affordability
      registry_endpoint: "http://test/v2/impulses/resolve",
      queue_path: queuePath,
    });
    const body = r.body as any;
    expect(body.enqueued.length).toBe(0);
    expect(body.skipped.some((s: any) => s.family === "gap-closing" && s.reason === "already_pending")).toBe(true);
  });

  it("dry_run enqueues nothing", async () => {
    globalThis.fetch = scriptedFetch(() => {});
    const r = await resolveRhythmConductorTick({
      type: "rhythm_conductor_tick",
      bucket_load: 0, // deterministic: don't let the host's real load gate affordability
      registry_endpoint: "http://test/v2/impulses/resolve",
      dry_run: true,
    });
    const body = r.body as any;
    expect(body.dry_run).toBe(true);
    expect(body.enqueued.length).toBe(1); // gap-closing selected but not actually enqueued
  });

  it("dispatches a resolver-backed family (gap-organizing) DIRECTLY, not as an NL goal", async () => {
    // REGRESSION: the gap-organizing NL goal was enqueued + walked by goal-host, which
    // went HOLLOW because gap_lifecycle_scan is a resolver, not a walkable activity. A
    // resolver-backed family must resolve the resolver directly against this vessel.
    const dir = mkdtempSync(join(tmpdir(), "rct-"));
    const queuePath = join(dir, "queue.json");
    writeFileSync(queuePath, JSON.stringify({ tasks: [], lastUpdated: 0 }));

    const posted: Array<{ type?: string; autoClose?: unknown }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : String(input.url ?? input);
      if (url.includes("/v2/impulses/resolve")) {
        const b = init?.body ? JSON.parse(String(init.body)) : {};
        const t = b?.impulse?.type ?? b?.impulse?.pointer?.type;
        if (t === "poolImpulse") {
          return new Response(JSON.stringify({ body: { impulses: [
            { id: "rhythm-gap-organizing", shape: "timeShapedRhythm", body: { axis: "gap", family: "gap-organizing", budget: 0.1, alpha: 6, beta: 1, staleness: 0.9 } },
          ], count: 1 } }), { status: 200 });
        }
        if (t === "poolImpulse_write") return new Response(JSON.stringify({ body: { ok: true, id: b.impulse.id } }), { status: 200 });
        if (t === "gap_lifecycle_scan") { posted.push({ type: t, autoClose: b?.impulse?.pointer?.autoClose }); return new Response(JSON.stringify({ body: { auto_closed: 3 } }), { status: 200 }); }
      }
      return new Response("not found", { status: 404 });
    }) as any;

    const r = await resolveRhythmConductorTick({
      type: "rhythm_conductor_tick",
      bucket_load: 0,
      registry_endpoint: "http://test/v2/impulses/resolve",
      queue_path: queuePath,
    });
    const body = r.body as any;

    // The scan resolver was invoked directly (with autoClose), not enqueued as text.
    expect(posted.some((p) => p.type === "gap_lifecycle_scan" && p.autoClose === true)).toBe(true);
    expect(body.enqueued.map((e: any) => e.family)).toEqual(["gap-organizing"]);
    expect(body.enqueued[0].goal).toBe("direct:gap_lifecycle_scan");
    // Nothing was written to the boredom queue for this family.
    const q = JSON.parse(readFileSync(queuePath, "utf-8"));
    expect(q.tasks.length).toBe(0);
  });
});
