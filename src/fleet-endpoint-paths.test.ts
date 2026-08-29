/**
 * EVERY activity-api PATH THIS VESSEL CALLS MUST BE A PATH activity-api MOUNTS.
 *
 * MEASURED 2026-08-17, found by a cross-vessel audit rather than by anything failing.
 *
 *   concept.ts               GET /v2/execution-traces?status=success&limit=50
 *   failure-count-report.ts  GET /v2/activities/traces?since=…
 *
 * activity-api mounts NEITHER. Its router is `app.route('/v2/activities/execution-traces', …)`;
 * there is no `/v2/execution-traces` and no `/traces` route in the activities router.
 *
 * The two failed differently, and the difference is the whole lesson:
 *
 *  - failure-count-report checked `!response.ok` and returned a structuredError, so its 404
 *    was VISIBLE every time it ran.
 *  - concept.ts guarded only with `if (tracesResp.ok)`, so the 404 left `traces` as [] and the
 *    resolver built concepts from ZERO traces and reported SUCCESS. A zero read through a
 *    broken query is indistinguishable from an empty store.
 *
 * An HTTP probe cannot catch this: auth middleware answers 401 before routing, so a mounted
 * path and an unmounted one return the SAME status. The discriminator is the mount table.
 * That is why this test reads activity-api's `app.route(...)` calls rather than calling the
 * service — an instrument that cannot tell the two cases apart is not a check.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = new URL("./", import.meta.url).pathname;

// Locate the SIBLING activity-api by WALKING UP, not by fixed depth. `../../activity-api/...`
// only resolves when this vessel sits at `<repos>/development-vessel/src/`. From an isolated
// clone it pointed at `/tmp/activity-api/src/index.ts`, so `existsSync` was false, the
// instrument-guard failed, and all four cases in this file failed with ENOENT — a portability
// bug here, not a change in the mount table this file audits. Fourth instance of this class in
// this repo (see detectors-are-scheduled.test.ts and detector-gap-summary-actionable.test.ts).
function findSibling(relative: string): string | null {
  let dir = SRC;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const ACTIVITY_API_INDEX_RESOLVED = findSibling(join("activity-api", "src", "index.ts"));
// Skip explicitly rather than fail: a standalone development-vessel checkout genuinely has no
// sibling activity-api whose mount table could be read. Never skip silently, and never skip when
// it IS found — a real unmounted call path must still fail this file.
const HAS_ACTIVITY_API = ACTIVITY_API_INDEX_RESOLVED !== null;
const ACTIVITY_API_INDEX = ACTIVITY_API_INDEX_RESOLVED ?? join(SRC, "../../activity-api/src/index.ts");
if (!HAS_ACTIVITY_API) {
  console.error(
    `[fleet-endpoint-paths] SKIPPED: no sibling activity-api found above ${SRC} — ` +
      "cannot read the mount table from a standalone vessel checkout.",
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Prefixes activity-api mounts, from its `app.route('<prefix>', …)` table.
 *
 *  THE ROOT MOUNT IS EXCLUDED, and this is the whole reason the first version of this test
 *  was worthless. activity-api has `app.route('/', boredomRoutes)`. With `/` in the list, the
 *  coverage check `path.startsWith(prefix + "/")` matched EVERY path — so the detector
 *  reported clean while /v2/traces, /v2/goals and /v2/executions were all live and unmounted.
 *  It passed vacuously for exactly the class it exists to catch.
 *
 *  A root-mounted router serves specific paths, not the whole namespace; treating it as
 *  covering /v2/* is what erased the signal. The negative-control test below now proves the
 *  matcher can still REJECT. */
function mountedPrefixes(): string[] {
  const src = readFileSync(ACTIVITY_API_INDEX, "utf8");
  return [...src.matchAll(/app\.route\(\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1]!)
    .filter((p) => p !== "/" && p !== "");
}

/** True when some mounted prefix genuinely covers this path. */
function isCovered(path: string, prefixes: string[]): boolean {
  const p = path.replace(/\/$/, "");
  return prefixes.some((pre) => {
    const q = pre.replace(/\/$/, "");
    return q.length > 0 && (p === q || p.startsWith(q + "/"));
  });
}

/** `/v2/...` paths this vessel builds, from template literals and new URL(...) calls. */
function calledPaths(): Array<{ file: string; path: string }> {
  const out: Array<{ file: string; path: string }> = [];
  for (const f of walk(SRC)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/["'`]\/v2\/[a-zA-Z0-9/_-]*/g)) {
      const p = m[0].slice(1).split("?")[0]!.replace(/\/$/, "");
      out.push({ file: f.replace(SRC, "src/"), path: p });
    }
    // `${ENDPOINT}/v2/...` inside a template literal
    for (const m of src.matchAll(/\$\{[^}]+\}(\/v2\/[a-zA-Z0-9/_-]*)/g)) {
      out.push({ file: f.replace(SRC, "src/"), path: m[1]!.split("?")[0]!.replace(/\/$/, "") });
    }
  }
  return out;
}

describe("fleet endpoint paths — this vessel calls only routes activity-api mounts", () => {
  it.skipIf(!HAS_ACTIVITY_API)("can read activity-api's mount table (guards the instrument)", () => {
    expect(existsSync(ACTIVITY_API_INDEX)).toBe(true);
    const prefixes = mountedPrefixes();
    // If this comes back empty the assertion below passes vacuously — the failure mode that
    // let two wrong paths live in this repo for as long as they did.
    expect(prefixes.length).toBeGreaterThan(5);
    expect(prefixes).toContain("/v2/activities/execution-traces");
  });

  it.skipIf(!HAS_ACTIVITY_API)("finds the /v2 paths this vessel calls (guards the scanner)", () => {
    const paths = calledPaths();
    expect(paths.length).toBeGreaterThan(5);
  });

  /** Call sites targeting a path nothing in the fleet mounts, as of 2026-08-17.
   *
   *  Each is a live defect, not a style issue: the call 404s and the caller degrades. They are
   *  FROZEN rather than fixed because choosing the replacement needs the receiving contract —
   *  what serves gaps, notes, goals and impulse resolutions, and in what response shape. A
   *  guessed endpoint is worse than a known-broken one: it would 404 identically while looking
   *  deliberate.
   *
   *  Where a correct target WAS determinable it was fixed rather than listed: five sites moved
   *  to /v2/activities/execution-traces, each also switched to read `executions` — the key that
   *  endpoint actually returns. Fixing the URL alone would have left them silently empty, which
   *  is the same write-key/read-key mismatch one layer out.
   *
   *  The list may SHRINK. It may not grow. */
  const KNOWN_UNMOUNTED = new Set<string>([
    "src/resolvers/gap-lifecycle-scan.ts -> /v2/gaps",
    "src/resolvers/human-input.ts -> /v2/notes",
    "src/resolvers/resolver-tier-cost-summary.ts -> /v2/resolutions",
    "src/resolvers/vessel-health-report.ts -> /v2/goals",
  ]);

  it.skipIf(!HAS_ACTIVITY_API)("THE REGRESSION: no NEW call targets an unmounted path", () => {
    const prefixes = mountedPrefixes();
    // A call is fine when SOME mounted prefix covers it. Sub-paths are the router's business.
    const bad = calledPaths().filter(({ path }) => !isCovered(path, prefixes));
    // Before the fix this listed /v2/execution-traces (silent 404 → concepts from zero traces)
    // and /v2/activities/traces (loud 404 → the report could never run).
    const labelled = [...new Set(bad.map((b) => `${b.file} -> ${b.path}`))];
    expect(labelled.filter((l) => !KNOWN_UNMOUNTED.has(l))).toEqual([]);
  });

  it.skipIf(!HAS_ACTIVITY_API)("NEGATIVE CONTROL: the matcher can still reject an unmounted path", () => {
    // Without this, the previous bug is invisible: a coverage function that returns true for
    // everything passes every assertion above. Before believing a clean result, prove a dirty
    // one is detectable.
    const prefixes = mountedPrefixes();
    expect(isCovered("/v2/activities/execution-traces", prefixes)).toBe(true);
    for (const dead of ["/v2/traces", "/v2/goals", "/v2/executions", "/v2/resolutions", "/v2/gaps"]) {
      expect(isCovered(dead, prefixes)).toBe(false);
    }
  });

  it.skipIf(!HAS_ACTIVITY_API)("the frozen list does not go stale — every entry is still unmounted", () => {
    // A baseline that silently becomes false is how a detector stops detecting. If someone
    // mounts /v2/gaps, this fails and the entry must come out.
    const prefixes = mountedPrefixes();
    for (const entry of KNOWN_UNMOUNTED) {
      const path = entry.split(" -> ")[1]!;
      expect(isCovered(path, prefixes)).toBe(false);
    }
  });

  it.skipIf(!HAS_ACTIVITY_API)("the specific paths that were wrong are now right", () => {
    const concept = readFileSync(join(SRC, "resolvers/concept.ts"), "utf8");
    expect(concept).toContain("/v2/activities/execution-traces");
    expect(concept).not.toMatch(/\$\{METABOB_ENDPOINT\}\/v2\/execution-traces/);
    const report = readFileSync(join(SRC, "resolvers/failure-count-report.ts"), "utf8");
    expect(report).toContain("/v2/activities/execution-traces");
    expect(report).not.toContain('"/v2/activities/traces"');
  });

  it.skipIf(!HAS_ACTIVITY_API)("a failed trace fetch is STATED, not read as an empty store", () => {
    // The silent-empty half of the defect. Fixing the URL without this would leave the next
    // wrong path just as invisible.
    const concept = readFileSync(join(SRC, "resolvers/concept.ts"), "utf8");
    expect(concept).toMatch(/if \(!tracesResp\.ok\)/);
  });
});
