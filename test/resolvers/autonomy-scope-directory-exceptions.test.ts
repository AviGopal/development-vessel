// A DIRECTORY ENTRY WITH EXACT-FILE EXCEPTIONS (user rulings 2026-10-20, "(c) Wait for a matcher exception", then
// "Today 20:00Z").
//
// autonomyScopeExcludes read an excluded_paths entry ending in "/" as a plain prefix, so "exclude repos/<v>/src/judge/
// except credit-decision.ts" could not be said: lifting one file meant opening the whole directory (17 files, among
// them a must-stay floor module), and listing the siblings by name instead lost forward-closure. The record now carries
// a SIBLING field, excluded_path_exceptions: exact file paths a directory entry does not exclude. Pinned here:
//   - a file named by an exception and lying under a directory entry reads OPEN; its siblings, and a file added to the
//     directory later that no list names, stay EXCLUDED (forward-closed);
//   - an exception for a path under no directory entry changes nothing; an exception that is also an exact entry stays
//     EXCLUDED, whatever the entry order; a directory, glob or `..` exception, or a bare basename, excepts nothing;
//   - FAIL CLOSED FOR READERS THAT DO NOT KNOW THE FIELD: the field is never encoded inside excluded_paths, so a reader
//     that builds its scope from excluded_paths alone still excludes the excepted file;
//   - the live reader carries the field from the pool record, and scope earn-in's proposer reads an excepted file as in
//     scope (a regression on it is proposed as a tightening, which, as an exact entry, closes it again);
//   - CONTROL: with no exceptions, prefix and exact entries match exactly as before.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `scope-dir-exceptions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);

const policy = (await import("../../src/judge/gap-policy.js")) as Record<string, any>;
const earn = (await import("../../src/resolvers/scope-earn-in.js")) as Record<string, any>;
const { autonomyScope, autonomyScopeExcludes, autonomyScopeFloor, __resetPolicyReadsForTests } = policy;
type Scope = { excluded: string[]; readable: boolean; reason: string; exceptions?: string[] };
type Row = Record<string, unknown>;

const DIR = "repos/goal-host-vessel/src/judge/";
const CREDIT = `${DIR}credit-decision.ts`;
const FLOOR = `${DIR}floor-clamps.ts`;
const NEW_FILE = `${DIR}a-module-added-after-the-lift.ts`;
const EXACT = "repos/development-vessel/src/judge/gap-policy.ts";
const OUTSIDE = "repos/boredom-vessel/src/index.ts";
const scope = (excluded: string[], exceptions?: string[]): Scope => ({ excluded, readable: true, reason: "test", ...(exceptions ? { exceptions } : {}) });
const open = (s: Scope, p: string): boolean => autonomyScopeExcludes(s, p) === null;

describe("a directory entry with an exact-file exception (must-fail at the parent)", () => {
  const s = scope([DIR, EXACT], [CREDIT]);
  it("the excepted file reads OPEN, in every path form the lane passes", () => {
    for (const p of [CREDIT, CREDIT.replace(/^repos\//, ""), `./${CREDIT}`, `/workspace/git/vessels/goal-host-vessel/src/judge/credit-decision.ts`, `${CREDIT}:42`]) {
      expect({ p, hit: autonomyScopeExcludes(s, p) }).toEqual({ p, hit: null });
    }
    expect(autonomyScopeFloor(s, [CREDIT])).toEqual({ hits: [], unreadable: null });
  });
  it("a sibling the exception does not name stays EXCLUDED by the directory entry", () => {
    expect(autonomyScopeExcludes(s, FLOOR)).toBe(DIR);
    expect(autonomyScopeFloor(s, [CREDIT, FLOOR]).hits).toEqual([DIR]);
  });
  it("a NEW file under the directory, named by no list, stays EXCLUDED (forward-closed)", () => {
    expect(autonomyScopeExcludes(s, NEW_FILE)).toBe(DIR);
    expect(autonomyScopeExcludes(s, `${DIR}sub/credit-decision.ts`)).toBe(DIR);
  });
});

describe("an exception counts only for an exact file under a directory entry", () => {
  it("an exception for a path under NO directory entry is ignored: the path reads as it did without it", () => {
    const outsideFile = "repos/goal-host-vessel/src/other.ts";
    for (const p of [outsideFile, EXACT, OUTSIDE]) {
      expect(autonomyScopeExcludes(scope([DIR, EXACT], [outsideFile, EXACT, OUTSIDE]), p)).toBe(autonomyScopeExcludes(scope([DIR, EXACT]), p));
    }
    expect(autonomyScopeExcludes(scope([DIR, EXACT], [EXACT]), EXACT)).toBe(EXACT);
  });
  it("an exception that is ALSO an exact entry stays EXCLUDED, whichever entry comes first", () => {
    expect(autonomyScopeExcludes(scope([DIR, CREDIT], [CREDIT]), CREDIT)).toBe(CREDIT);
    expect(autonomyScopeExcludes(scope([CREDIT, DIR], [CREDIT]), CREDIT)).toBe(CREDIT);
  });
  it("a directory, glob or `..` exception, or a bare basename, excepts nothing", () => {
    expect(policy.parseScopeExceptions).toBeInstanceOf(Function);
    expect(policy.parseScopeExceptions([CREDIT, ` ${FLOOR} `, DIR, `${DIR}sub/`, `${DIR}*.ts`, `${DIR}credit-*`, `${DIR}../judge/floor-clamps.ts`, "", 7, null])).toEqual([CREDIT, FLOOR]);
    expect(policy.parseScopeExceptions(undefined)).toEqual([]);
    for (const exc of [DIR, `${DIR}*.ts`, `${DIR}credit-*`, "credit-decision.ts", "src/judge/credit-decision.ts", `${DIR}../judge/credit-decision.ts`]) {
      expect({ exc, hit: autonomyScopeExcludes(scope([DIR], [exc]), CREDIT) }).toEqual({ exc, hit: DIR });
    }
    expect(autonomyScopeExcludes(scope([DIR], [`${DIR}sub/`]), `${DIR}sub/x.ts`)).toBe(DIR);
  });
  it("an unreadable scope still excludes the excepted file", () => {
    expect(autonomyScopeExcludes({ excluded: [], readable: false, reason: "down", exceptions: [CREDIT] }, CREDIT)).not.toBeNull();
  });
});

describe("FAIL CLOSED: a reader that does not know excluded_path_exceptions", () => {
  // The record as the pool holds it. An unaware reader builds its scope from excluded_paths alone (as the committed-file
  // readers and the goal-host opening-state reader do); nothing in excluded_paths names the exception.
  const body = { excluded_paths: [DIR, EXACT], excluded_path_exceptions: [CREDIT], require_falsifier_classes: ["class2"] };
  it("excluded_paths carries no exception marker, so an excluded_paths-only scope EXCLUDES the excepted file", () => {
    expect(body.excluded_paths.every((e) => !e.startsWith("!") && e !== CREDIT)).toBe(true);
    const unaware = scope(body.excluded_paths);
    expect(autonomyScopeExcludes(unaware, CREDIT)).toBe(DIR);
    // A plain-prefix reader (goal-host scopeEntryFor, pull-sync's dir rule) reads the same.
    expect(body.excluded_paths.find((e) => e.endsWith("/") && CREDIT.startsWith(e))).toBe(DIR);
  });
});

describe("CONTROL: with no exceptions, prefix and exact entries behave as before", () => {
  const s = scope([DIR, EXACT]);
  it("prefix and exact entries match; everything else is open", () => {
    expect(autonomyScopeExcludes(s, CREDIT)).toBe(DIR);
    expect(autonomyScopeExcludes(s, FLOOR)).toBe(DIR);
    expect(autonomyScopeExcludes(s, `/workspace/git/vessels/${CREDIT.replace(/^repos\//, "")}`)).toBe(DIR);
    expect(autonomyScopeExcludes(s, EXACT)).toBe(EXACT);
    expect(autonomyScopeExcludes(s, `${EXACT}:10`)).toBe(EXACT);
    expect(autonomyScopeExcludes(s, OUTSIDE)).toBeNull();
    expect(autonomyScopeExcludes(scope([DIR, EXACT], []), CREDIT)).toBe(DIR);
  });
});

// ── The live reader: the pool record's excluded_path_exceptions reaches the matcher.
const originalFetch = globalThis.fetch;
const POOL = "http://node-a:18090/v2/impulses/resolve";
let poolRecords: Array<Record<string, unknown>> = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
function install(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      const vessels = [{ vesselId: "development-vessel-local", endpoint: "http://node-a:18090", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }];
      return Response.json({ content: { shape: body.pointer.shape, vessels, found: true } });
    }
    if (url === POOL && body?.impulse?.type === "poolImpulse") return Response.json({ body: { impulses: poolRecords.filter((r) => r["shape"] === body.impulse.shape) } });
    return Response.json({});
  }) as unknown as typeof fetch;
}
beforeAll(() => { mkdirSync(ROOT, { recursive: true }); });
beforeEach(() => {
  setSystemTime(new Date("2026-10-20T12:00:00Z"));
  __resetPolicyReadsForTests();
  poolRecords = [];
  install();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  logSpy?.mockRestore();
  logSpy = null;
  earn.__setScopeEarnInDepsForTests?.(null);
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });

describe("the live autonomyScope read carries excluded_path_exceptions", () => {
  it("a record with the field: the excepted file reads OPEN, its sibling and a new file EXCLUDED", async () => {
    poolRecords = [{ shape: "autonomyScope", updated_at: "2026-10-20T11:00:00Z", body: { excluded_paths: [DIR, EXACT], excluded_path_exceptions: [CREDIT, `${DIR}*.ts`] } }];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(s.exceptions).toEqual([CREDIT]); // the glob is dropped at the read
    expect(open(s, CREDIT)).toBe(true);
    expect(autonomyScopeExcludes(s, FLOOR)).toBe(DIR);
    expect(autonomyScopeExcludes(s, NEW_FILE)).toBe(DIR);
    expect(autonomyScopeExcludes(s, EXACT)).toBe(EXACT);
  });
  it("CONTROL: a record without the field reads exactly as before", async () => {
    poolRecords = [{ shape: "autonomyScope", updated_at: "2026-10-20T11:00:00Z", body: { excluded_paths: [DIR, EXACT] } }];
    const s = await autonomyScope();
    expect(s.readable).toBe(true);
    expect(s.exceptions).toBeUndefined();
    expect(autonomyScopeExcludes(s, CREDIT)).toBe(DIR);
  });
});

describe("scope earn-in's proposer reads an excepted file as in scope", () => {
  const regression: Row = {
    id: "reg-credit-decision", category: "systematic_failure", source: "operator", status: "open", summary: "regression on the excepted file", detected_at: "2026-10-20T10:00:00.000Z",
    classification_metadata: { edit_site: CREDIT, falsifier: { class: "class2" }, regressed_by: { sha: "0badc0de", revert_sha: null, by: "gap-sweep:falsified_after_restart" } },
  };
  const tick = async (s: Scope, sites: Row[]): Promise<Row[]> => {
    const now = Date.parse("2026-10-20T12:00:00.000Z");
    earn.__setScopeEarnInDepsForTests({
      readGaps: async () => sites,
      readScope: async () => s,
      readRhythm: async () => ({ id: "rhythm-scope-earn-in", updated_at: new Date(now).toISOString(), body: { axis: "load", family: "scope-earn-in", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, tighten_ttl_hours: 48 } }),
      pace: async () => true,
      runCheck: async () => null,
      poolRead: () => [],
      poolWrite: () => ({ body: { ok: true } }),
      report: async () => {},
      unitsText: () => "",
      runtimeSha: () => null,
      readFileAt: () => null,
      classify: () => null,
      testFilesMentioning: () => [],
      now: () => now,
    });
    const r = await earn.resolveScopeEarnInTick({ type: "scope_earn_in_tick", dry_run: true });
    return ((r.body as Row)["proposed"] as Row[]) ?? [];
  };
  it("a regression on the excepted file is proposed as a tightening (must-fail at the parent)", async () => {
    expect(await tick(scope([DIR], [CREDIT]), [regression])).toEqual([{ path: CREDIT, change: "tighten" }]);
  });
  it("CONTROL: with no exception the directory covers it, and nothing is proposed", async () => {
    expect(await tick(scope([DIR]), [regression])).toEqual([]);
  });
  it("a regression on a sibling the exception does not name is not proposed (still excluded)", async () => {
    const sibling = { ...regression, id: "reg-floor", classification_metadata: { ...(regression["classification_metadata"] as Row), edit_site: FLOOR } };
    expect(await tick(scope([DIR], [CREDIT]), [sibling])).toEqual([]);
  });
});
