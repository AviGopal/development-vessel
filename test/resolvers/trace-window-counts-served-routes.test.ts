/**
 * Every route and shape the 30-day count readers call is actually SERVED.
 *
 * The failure this pins: a substrate-authored landing called GET /v2/activities/execution-traces/aggregate, a route
 * activity-api does not serve, so its fallback ran on every tick. Here every `${METABOB_ENDPOINT}/v2/...` route literal
 * and every shape the changed files resolve is checked against a list pinned at an activity-api commit, each entry naming
 * the file and the router/handler literal that serves it. When activity-api's source is readable (the gate container
 * holds the deployed tree), each pin is ALSO checked against that source, and a pin the source does not hold fails.
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CHANGED = [
  "src/lib/trace-window-counts.ts",
  "src/resolvers/reachable-unlearned-report.ts",
  "src/resolvers/substrate-health-tick.ts",
];

/** activity-api at ec4e0145031ff2009410eded5a04000a34762174: route -> the literal(s) that serve it, and where. */
const SERVED_ROUTES: Record<string, Array<{ file: string; literal: string }>> = {
  "/v2/activities/templates": [
    { file: "src/index.ts", literal: "app.route('/v2/activities', activitiesRoutes)" },
    { file: "src/routes/activities.ts", literal: "app.get('/templates'" },
  ],
  "/v2/activities/templates/auto-promote": [
    { file: "src/index.ts", literal: "app.route('/v2/activities', activitiesRoutes)" },
    { file: "src/routes/activities.ts", literal: "app.post('/templates/auto-promote'" },
  ],
  "/v2/activities/composition/graph": [
    { file: "src/index.ts", literal: "app.route('/v2/activities', activitiesRoutes)" },
    { file: "src/routes/activities.ts", literal: "app.get('/composition/graph'" },
  ],
  "/v2/activities/execution-traces": [
    { file: "src/index.ts", literal: "app.route('/v2/activities/execution-traces', executionTracesRoutes)" },
    { file: "src/routes/execution-traces.ts", literal: "app.get('/'" },
    { file: "src/routes/execution-traces.ts", literal: "c.req.query('since_iso')" },
  ],
  "/v2/impulses/resolve": [
    { file: "src/index.ts", literal: "app.route('/v2/impulses', impulsesRoutes)" },
    { file: "src/routes/impulses.ts", literal: "router.post('/resolve'" },
  ],
};
/** Shapes resolved by these files: advertised in activity-api's config AND handled by its impulse route. */
const SERVED_SHAPES: Record<string, Array<{ file: string; literal: string }>> = {
  traceAggregateReport: [
    { file: "src/config.ts", literal: "'traceAggregateReport'" },
    { file: "src/routes/impulses.ts", literal: "case 'traceAggregateReport':" },
  ],
};

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

function routesCalled(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\{METABOB_ENDPOINT\}(\/v2\/[A-Za-z0-9_\-/]+)/g)) out.add(m[1]!.replace(/\/+$/, ""));
  return [...out];
}

function shapesResolved(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/discoverOwnResolveUrls\(\s*["']([A-Za-z0-9_:]+)["']/g)) out.add(m[1]!);
  for (const m of text.matchAll(/export const TRACE_AGGREGATE_SHAPE = ["']([A-Za-z0-9_:]+)["']/g)) out.add(m[1]!);
  if (/discoverOwnResolveUrls\(TRACE_AGGREGATE_SHAPE\)/.test(text) && !out.size) out.add("<unresolved constant>");
  return [...out];
}

describe("the 30-day count readers call only served routes and shapes", () => {
  it("every ${METABOB_ENDPOINT}/v2 route literal in the changed files is a pinned, served route", () => {
    const called = CHANGED.flatMap((f) => routesCalled(src(f)).map((r) => ({ f, r })));
    expect(called.length).toBeGreaterThan(0);
    const unserved = called.filter(({ r }) => !SERVED_ROUTES[r]);
    expect(unserved).toEqual([]);
  });

  it("the aggregate is looked up by a shape activity-api advertises and handles", () => {
    const shapes = shapesResolved(src("src/lib/trace-window-counts.ts"));
    expect(shapes).toContain("traceAggregateReport");
    expect(shapes.filter((s) => !SERVED_SHAPES[s])).toEqual([]);
    // The lookup goes through discovery, never a hand-built aggregate route.
    expect(src("src/lib/trace-window-counts.ts")).toContain("discoverOwnResolveUrls(TRACE_AGGREGATE_SHAPE)");
    for (const f of CHANGED) expect(src(f)).not.toMatch(/execution-traces\/aggregate/);
  });

  it("each pin holds in activity-api's own source when that source is readable", () => {
    const candidates = ["/workspace/git/vessels/activity-api", join(ROOT, "..", "activity-api")];
    const tree = candidates.find((d) => existsSync(join(d, "src", "routes", "impulses.ts")));
    if (!tree) {
      // Not a silent pass: the pinned lists above were still enforced by the two tests before this one.
      console.warn(`[served-routes] activity-api source not found at ${candidates.join(" or ")}: pins checked against the pinned list only`);
      return;
    }
    console.log(`[served-routes] checking pins against ${tree}`);
    const missing: string[] = [];
    for (const [name, pins] of [...Object.entries(SERVED_ROUTES), ...Object.entries(SERVED_SHAPES)]) {
      for (const p of pins) {
        const path = join(tree, p.file);
        if (!existsSync(path) || !readFileSync(path, "utf-8").includes(p.literal)) missing.push(`${name}: ${p.file} lacks ${p.literal}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
