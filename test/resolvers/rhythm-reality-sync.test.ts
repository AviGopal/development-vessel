import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveRhythmRealitySync } from "../../src/resolvers/rhythm-reality-sync.js";

const GAP_CLOSING_RHYTHM = {
  id: "rhythm:gap-closing-1",
  body: {
    axis: "time",
    axis_code: "T1",
    family: "gap-closing",
    budget: 1,
    alpha: 1,
    beta: 1,
    staleness: 0.3,
  },
};

describe("resolveRhythmRealitySync", () => {
  let writtenPayloads: unknown[] = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    writtenPayloads = [];
    originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { impulse: { type: string } }) : null;
      const type = body?.impulse?.type;

      if (type === "poolImpulse") {
        return new Response(
          JSON.stringify({ body: { items: [GAP_CLOSING_RHYTHM] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (type === "gap_lifecycle_scan") {
        return new Response(
          JSON.stringify({ body: { open: 385 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (type === "poolImpulse_write") {
        writtenPayloads.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("computes gap-closing new_staleness = Math.min(1, 385/400) = 0.9625", async () => {
    const report = await resolveRhythmRealitySync({ type: "rhythm_reality_sync" });

    expect(report.shape).toBe("rhythmRealitySyncReport");
    expect(report.body.open_gap_count).toBe(385);
    expect(report.body.considered).toBe(1);
    expect(report.body.updated).toHaveLength(1);

    const entry = report.body.updated[0]!;
    expect(entry.id).toBe("rhythm:gap-closing-1");
    expect(entry.family).toBe("gap-closing");
    expect(entry.old_staleness).toBe(0.3);
    expect(entry.new_staleness).toBeCloseTo(0.9625, 10);
  });

  it("issues a poolImpulse_write for the updated rhythm", async () => {
    await resolveRhythmRealitySync({ type: "rhythm_reality_sync" });

    expect(writtenPayloads).toHaveLength(1);
    const written = writtenPayloads[0] as {
      impulse: { type: string; id: string; body: { staleness: number } };
    };
    expect(written.impulse.type).toBe("poolImpulse_write");
    expect(written.impulse.id).toBe("rhythm:gap-closing-1");
    expect(written.impulse.body.staleness).toBeCloseTo(0.9625, 10);
  });
});
