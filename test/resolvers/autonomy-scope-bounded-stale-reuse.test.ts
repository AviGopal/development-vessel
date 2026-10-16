// A FAILED autonomyScope READ FALLS BACK TO THE LAST GOOD SCOPE FOR A BOUNDED TIME (CHANGE-31).
//
// User ruling (docs session, ~2026-10-16T05:57Z), "Full bounded reuse": "Stale scope may admit and refuse for a bounded
// time. Fastest, but a change could be admitted under an outdated scope." (It supersedes the refuse-only "Yes" given
// at 05:56:53Z in the qa session; both quotes are in the CHANGE-31 record.)
// Measured before: on a spoke the scope read failed (discovery lookup timing out, a silent own producer) and every
// autonomous candidate was excluded and a verified compose was withheld at the floor, for a transport blip.
//
//   [MUST-FAIL] the live read fails in transport, a last-good scope is inside the bound: the last-good scope decides
//               (a path it allows is allowed, a path it excludes stays excluded), marked stale with its age.
//   [CONTROL]   past the bound: fail closed, as today.
//   [CONTROL]   a live read that SUCCEEDS always wins, including one that now excludes a path the stale scope allowed.
//   [CONTROL]   the bound row absent or unreadable (0): fail closed.
//   [CONTROL]   an EXPLICIT answer (no record: absent) is never stood in for.
//   [CONTROL]   no last-good (a restart: memory only): fail closed until a good read.
//   [CONTROL]   a stale reuse is held only for the unreadable retry interval, so a recovered live read wins within seconds.
//   [CONTROL]   every stale use is journalled with its age and counted.
import { afterEach, describe, expect, it } from "bun:test";

const gp = (await import("../../src/judge/gap-policy.js")) as Record<string, any>;
type Scope = { excluded: string[]; readable: boolean; reason: string; transport?: boolean; absent?: boolean; stale?: { age_ms: number; reuse: number } };

const GOOD: Scope = { excluded: ["repos/development-vessel/src/resolvers/feature-compose.ts"], readable: true, reason: "autonomyScope: 1 excluded path(s)" };
const FAILED: Scope = { excluded: [], readable: false, transport: true, lookup_failed: true, reason: "poolImpulse lookup failed (timeout): no answer from discovery within 8000 ms" } as Scope;
const ABSENT: Scope = { excluded: [], readable: false, absent: true, reason: "autonomyScope absent" };
const OPEN_PATH = "repos/development-vessel/src/resolvers/gap-check-supply.ts";
const HELD_PATH = "repos/development-vessel/src/resolvers/feature-compose.ts";

let t = 1_000_000;
let liveAnswers: Scope[] = [];
let bound: number | null = 600;
function install(): void {
  gp["__setAutonomyScopeDepsForTests"]({ live: async () => liveAnswers.shift() ?? FAILED, boundS: async () => bound, now: () => t });
}
afterEach(() => { gp["__setAutonomyScopeDepsForTests"]?.(null); bound = 600; liveAnswers = []; });
const excludes = (s: Scope, p: string): string | null => gp["autonomyScopeExcludes"](s, p);

describe("autonomyScope: bounded reuse of the last good scope when the live read fails", () => {
  it("[MUST-FAIL] inside the bound the last-good scope decides admit AND refuse, marked stale", async () => {
    install();
    liveAnswers = [GOOD, FAILED];
    expect((await gp["autonomyScope"]()).readable).toBe(true);
    t += 60_000; // past the 30 s cache: the live read is tried again, and fails
    const s: Scope = await gp["autonomyScope"]();
    expect(s.readable).toBe(true);
    expect(s.stale?.age_ms).toBe(60_000);
    expect(excludes(s, OPEN_PATH)).toBeNull(); // admitted (today: everything excluded)
    expect(excludes(s, HELD_PATH)).not.toBeNull(); // still refused
  });

  it("[CONTROL] past the bound: fail closed", async () => {
    install();
    liveAnswers = [GOOD, FAILED];
    await gp["autonomyScope"]();
    t += 601_000;
    const s: Scope = await gp["autonomyScope"]();
    expect(s.readable).toBe(false);
    expect(s.stale).toBeUndefined();
  });

  it("[CONTROL] a live read that succeeds wins, even when it now excludes a path the stale scope allowed", async () => {
    install();
    const tighter: Scope = { ...GOOD, excluded: [...GOOD.excluded, OPEN_PATH] };
    liveAnswers = [GOOD, FAILED, tighter];
    await gp["autonomyScope"]();
    t += 60_000;
    expect(excludes(await gp["autonomyScope"](), OPEN_PATH)).toBeNull(); // stale: allowed
    t += 60_000; // past the short stale hold: live tried again, succeeds
    const live: Scope = await gp["autonomyScope"]();
    expect(live.stale).toBeUndefined();
    expect(excludes(live, OPEN_PATH)).not.toBeNull(); // the live scope's exclusion wins
  });

  it("[CONTROL] the bound row absent or unreadable is 0: fail closed", async () => {
    install();
    bound = null;
    liveAnswers = [GOOD, FAILED];
    await gp["autonomyScope"]();
    t += 60_000;
    expect((await gp["autonomyScope"]()).readable).toBe(false);
  });

  it("[CONTROL] an explicit answer (absent) is never stood in for", async () => {
    install();
    liveAnswers = [GOOD, ABSENT];
    await gp["autonomyScope"]();
    t += 60_000;
    const s: Scope = await gp["autonomyScope"]();
    expect(s.readable).toBe(false);
    expect(s.absent).toBe(true);
  });

  it("[CONTROL] no last-good (a restart: memory only): fail closed until a good read", async () => {
    install();
    liveAnswers = [FAILED];
    expect((await gp["autonomyScope"]()).readable).toBe(false);
  });

  it("[CONTROL] a stale reuse is held only briefly: a recovered live read wins within seconds", async () => {
    install();
    liveAnswers = [GOOD, FAILED, GOOD];
    await gp["autonomyScope"]();
    t += 60_000;
    expect((await gp["autonomyScope"]()).stale).toBeDefined();
    t += 5_000; // well inside the 30 s readable TTL, past the unreadable retry interval
    expect((await gp["autonomyScope"]()).stale).toBeUndefined();
  });

  it("[CONTROL] every stale use is journalled with its age and counted", async () => {
    install();
    liveAnswers = [GOOD, FAILED, FAILED];
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => { logs.push(String(m)); };
    try {
      await gp["autonomyScope"]();
      t += 60_000; await gp["autonomyScope"]();
      t += 5_000; await gp["autonomyScope"]();
    } finally { console.log = orig; }
    const reuses = logs.filter((l) => l.includes("autonomyScope: STALE REUSE #"));
    expect(reuses.length).toBe(2);
    expect(reuses[0]).toContain("STALE REUSE #1");
    expect(reuses[0]).toContain("age 60 s, bound 600 s");
    expect(reuses[1]).toContain("STALE REUSE #2");
  });

  it("[CONTROL] the pure rule: a readable live scope or a non-transport failure is returned as is", () => {
    const f = gp["applyStaleReuse"];
    const lg = { at: 0, v: GOOD };
    expect(f(GOOD, lg, 1000, 600_000)).toBe(GOOD);
    expect(f(ABSENT, lg, 1000, 600_000)).toBe(ABSENT);
    expect(f(FAILED, lg, 1000, 0)).toBe(FAILED);
    expect(f(FAILED, null, 1000, 600_000)).toBe(FAILED);
    expect(f(FAILED, lg, 1000, 600_000).stale?.age_ms).toBe(1000);
  });
});
