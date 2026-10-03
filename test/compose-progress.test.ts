// /health must say whether an in-flight compose is still MOVING, not only how old it is.
//
// substrate-pull-sync defers an owed restart while the oldest in-flight request is under the
// 900 s compose ceiling, and restarted into it once it passed — killing composes that were
// still walking scope -> plan -> apply -> verify -> own-check -> cutover. The approved fix:
// this vessel stamps each STAGE TRANSITION on the record of the request it runs under, and
// /health publishes, beside in_flight / in_flight_oldest_ms:
//   in_flight_last_progress_ms  ms since the most recent stage transition of any in-flight
//                               request; null until one has stamped
//   in_flight_last_progress_id  the attempt (gap id) that stamp named, or null
// pull-sync keeps deferring a past-ceiling restart while the first is under its stall bound.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Rec = { at: number };
type Mod = {
  admitInFlight: () => Rec;
  releaseInFlight: (r: Rec) => void;
  runInFlight: <T>(r: Rec, fn: () => T) => T;
  stampComposeProgress: (stage: string, id?: unknown) => void;
  inFlightProgressHealth: () => { in_flight_last_progress_ms: number | null; in_flight_last_progress_id: string | null };
};
const mod = (await import("../src/lib/compose-progress").catch(() => null)) as Mod | null;
const src = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

describe("/health publishes compose progress", () => {
  test("an in-flight compose that stamped a stage publishes in_flight_last_progress_ms and its attempt", async () => {
    expect(mod).not.toBeNull();
    const rec = mod!.admitInFlight();
    try {
      await mod!.runInFlight(rec, async () => {
        await Bun.sleep(5);
        mod!.stampComposeProgress("plan", "gap-demo");
      });
      const h = mod!.inFlightProgressHealth();
      expect(typeof h.in_flight_last_progress_ms).toBe("number");
      expect(h.in_flight_last_progress_ms!).toBeGreaterThanOrEqual(0);
      expect(h.in_flight_last_progress_ms!).toBeLessThan(1000);
      expect(h.in_flight_last_progress_id).toBe("gap-demo");
    } finally { mod?.releaseInFlight(rec); }
  });

  test("it advances when a stage transition is stamped", async () => {
    expect(mod).not.toBeNull();
    const rec = mod!.admitInFlight();
    try {
      await mod!.runInFlight(rec, async () => {
        mod!.stampComposeProgress("scope");
        await Bun.sleep(60);
        const before = mod!.inFlightProgressHealth().in_flight_last_progress_ms;
        expect(before!).toBeGreaterThanOrEqual(50);
        mod!.stampComposeProgress("verify");
        const after = mod!.inFlightProgressHealth().in_flight_last_progress_ms;
        expect(after!).toBeLessThan(before!);
        expect(after!).toBeLessThan(50);
      });
    } finally { mod?.releaseInFlight(rec); }
  });

  test("controls: null before any stamp, a stamp outside a request is dropped, a released request stops publishing", async () => {
    expect(mod).not.toBeNull();
    const rec = mod!.admitInFlight();
    try {
      expect(mod!.inFlightProgressHealth().in_flight_last_progress_ms).toBeNull();
      mod!.stampComposeProgress("plan", "in-process-caller");   // no request context
      expect(mod!.inFlightProgressHealth().in_flight_last_progress_ms).toBeNull();
      mod!.runInFlight(rec, () => mod!.stampComposeProgress("apply"));
      expect(mod!.inFlightProgressHealth().in_flight_last_progress_ms).not.toBeNull();
    } finally { mod?.releaseInFlight(rec); }
    expect(mod!.inFlightProgressHealth().in_flight_last_progress_ms).toBeNull();
  });
});

describe("wiring", () => {
  test("src/index.ts publishes the progress fields in /health and runs requests under their record", () => {
    const s = src("src/index.ts");
    const health = s.slice(s.indexOf('app.get("/health"'), s.indexOf("drain_ms:", s.indexOf('app.get("/health"')));
    expect(/inFlightProgressHealth\s*\(/.test(health)).toBe(true);
    expect(/runInFlight\s*\(/.test(s)).toBe(true);
  });

  test("feature-compose stamps the stage boundaries", () => {
    const s = src("src/resolvers/feature-compose.ts");
    for (const stage of ["scope", "plan", "apply", "verify", "own_check", "cutover"]) {
      expect(new RegExp(`stampComposeProgress\\(\\s*"${stage}"`).test(s)).toBe(true);
    }
  });
});
