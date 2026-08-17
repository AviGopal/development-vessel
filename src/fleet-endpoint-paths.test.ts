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
import { join } from "node:path";

const SRC = new URL("./", import.meta.url).pathname;
const ACTIVITY_API_INDEX = join(SRC, "../../activity-api/src/index.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Prefixes activity-api mounts, from its `app.route('<prefix>', …)` table. */
function mountedPrefixes(): string[] {
  const src = readFileSync(ACTIVITY_API_INDEX, "utf8");
  return [...src.matchAll(/app\.route\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
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
  it("can read activity-api's mount table (guards the instrument)", () => {
    expect(existsSync(ACTIVITY_API_INDEX)).toBe(true);
    const prefixes = mountedPrefixes();
    // If this comes back empty the assertion below passes vacuously — the failure mode that
    // let two wrong paths live in this repo for as long as they did.
    expect(prefixes.length).toBeGreaterThan(5);
    expect(prefixes).toContain("/v2/activities/execution-traces");
  });

  it("finds the /v2 paths this vessel calls (guards the scanner)", () => {
    const paths = calledPaths();
    expect(paths.length).toBeGreaterThan(5);
  });

  it("THE REGRESSION: no call targets an unmounted path", () => {
    const prefixes = mountedPrefixes();
    const bad = calledPaths().filter(({ path }) => {
      // A call is fine when SOME mounted prefix covers it. Sub-paths are the router's business.
      return !prefixes.some((pre) => path === pre || path.startsWith(pre.replace(/\/$/, "") + "/"));
    });
    // Before the fix this listed /v2/execution-traces (silent 404 → concepts from zero traces)
    // and /v2/activities/traces (loud 404 → the report could never run).
    expect(bad.map((b) => `${b.file} -> ${b.path}`)).toEqual([]);
  });

  it("the specific paths that were wrong are now right", () => {
    const concept = readFileSync(join(SRC, "resolvers/concept.ts"), "utf8");
    expect(concept).toContain("/v2/activities/execution-traces");
    expect(concept).not.toMatch(/\$\{METABOB_ENDPOINT\}\/v2\/execution-traces/);
    const report = readFileSync(join(SRC, "resolvers/failure-count-report.ts"), "utf8");
    expect(report).toContain("/v2/activities/execution-traces");
    expect(report).not.toContain('"/v2/activities/traces"');
  });

  it("a failed trace fetch is STATED, not read as an empty store", () => {
    // The silent-empty half of the defect. Fixing the URL without this would leave the next
    // wrong path just as invisible.
    const concept = readFileSync(join(SRC, "resolvers/concept.ts"), "utf8");
    expect(concept).toMatch(/if \(!tracesResp\.ok\)/);
  });
});
