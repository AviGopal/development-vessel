// SHARED NETWORK GUARD FOR THE CUTOVER SUITES (test setup, not a test file).
//
// The cutover reaches the network from many places: discovery and the shell producer (the
// pre-cutover and post-land suites), the trace store (refusal and landing traces, reach),
// the activity API (feedback, events), goal-host /health, the gap-store forward. Their
// endpoints default to 127.0.0.1:8xxx module constants, so a cutover unit test run inside a
// substrate container talks to the LIVE fleet, and on a dev host it silently gets
// connection-refused and reads that as "could not measure". Neither is a test.
//
// installCutoverFetchGuard() replaces globalThis.fetch for one test. Every request must match a
// route the test (or its file) declared; anything else is RECORDED as a violation and rejected.
// Recording matters: production code wraps most of these calls in try/catch, so a throw alone
// would be swallowed and the test would pass on a fail-open path. restore() returns the
// violations so afterEach can fail the test on any of them.
//
// A route either answers (a Response) or declares the endpoint unreachable (throws). The
// latter reproduces a dead endpoint deterministically, on any host, as an explicit decision.

export type GuardRoute = {
  name: string;
  match: (url: string, body: Record<string, any>) => boolean;
  respond: (url: string, body: Record<string, any>) => Response | Promise<Response>;
};

export type FetchGuard = {
  route: (r: GuardRoute) => void;
  /** Requests that matched no route (URL + method), in order. */
  violations: string[];
  /** Every request that matched a route, by route name. */
  hits: string[];
  restore: () => string[];
};

/** The real fetch, captured when this helper first loads. */
const ORIGINAL_FETCH = globalThis.fetch;
/** Re-installs the real fetch. Idempotent; each cutover file also calls it from afterAll. */
export function restoreCutoverFetch(): void {
  globalThis.fetch = ORIGINAL_FETCH;
}

export function installCutoverFetchGuard(): FetchGuard {
  const original = globalThis.fetch;
  const routes: GuardRoute[] = [];
  const violations: string[] = [];
  const hits: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    // Later routes win, so a test can override a file-wide default.
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i]!;
      if (r.match(url, body)) {
        hits.push(r.name);
        return r.respond(url, body);
      }
    }
    violations.push(`${init?.method ?? "GET"} ${url}`);
    throw new Error(`cutover fetch guard: unstubbed request ${init?.method ?? "GET"} ${url}`);
  }) as unknown as typeof fetch;
  return {
    route: (r) => { routes.push(r); },
    violations,
    hits,
    restore: () => {
      globalThis.fetch = original;
      return [...violations];
    },
  };
}

const pathIs = (re: RegExp) => (url: string) => {
  try { return re.test(new URL(url).pathname); } catch { return false; }
};
const unreachable = (name: string) => () => { throw new Error(`${name}: unreachable (declared by the test's fetch guard)`); };

/**
 * The fleet endpoints a cutover calls besides discovery/shell, declared UNREACHABLE: exactly what
 * a dev host with nothing on 127.0.0.1:8xxx produced before the guard, now explicit and the same
 * on every host. Each is named so a new call site shows up as a violation, not a silent pass.
 */
export function routeFleetUnreachable(g: FetchGuard): void {
  g.route({ name: "trace-store executions", match: pathIs(/\/v2\/activities\/executions$/), respond: unreachable("trace-store executions") });
  g.route({ name: "trace-store reach", match: pathIs(/\/v2\/activities\/execution-traces\//), respond: unreachable("trace-store reach") });
  g.route({ name: "activity feedback", match: pathIs(/\/v2\/activities\/feedback$/), respond: unreachable("activity feedback") });
  g.route({ name: "events publish", match: pathIs(/\/v2\/events\/publish$/), respond: unreachable("events publish") });
  g.route({ name: "impulse resolve (self)", match: pathIs(/\/v2\/impulses\/resolve$/), respond: unreachable("impulse resolve") });
  g.route({ name: "goal-host health", match: pathIs(/^\/health$/), respond: unreachable("goal-host health") });
}

/** Discovery declares no shell producer: the test_suite resolver then reports a run that never started. */
export function routeDiscoveryNoShell(g: FetchGuard): void {
  g.route({
    name: "discovery (no shell producer)",
    match: (_u, b) => b?.pointer?.type === "vesselCapability",
    respond: () => Response.json({ content: { vessels: [] } }),
  });
}

/**
 * Discovery names a fixture shell producer; `answer` is called with the shell command and returns
 * the stdout (or throws: the dispatch failed). The resolver's real parsing reads that stdout.
 */
export function routeShell(g: FetchGuard, answer: (command: string) => string): void {
  g.route({
    name: "discovery (fixture shell)",
    match: (_u, b) => b?.pointer?.type === "vesselCapability",
    respond: () => Response.json({ content: { vessels: [{ endpoint: "http://shell.fixture", resolve_endpoint: "/resolve", health_score: 1 }] } }),
  });
  g.route({
    name: "fixture shell",
    match: (u) => u.startsWith("http://shell.fixture"),
    respond: (_u, b) => Response.json({ stdout: answer(String(b?.impulse?.pointer?.command ?? "")) }),
  });
}

// bun 1.3.14's real output (captured), for the three suite outcomes the cutover must tell apart.
export const BUN_PASSING =
  "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/ok.test.ts:\n(pass) ok [0.06ms]\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [11.00ms]\n";
export const BUN_NO_TESTS =
  "bun test v1.3.14 (0d9b296a)\nNo tests found!\n\nTests need \".test\", \"_test_\", \".spec\" or \"_spec_\" in the filename (ex: \"MyApp.test.ts\")\n\nLearn more about bun test: https://bun.com/docs/cli/test\n";
/** Killed by `timeout` before any summary (captured as `h.test.ts:`; filename adjusted). */
export const BUN_KILLED_BY_TIMEOUT = "bun test v1.3.14 (0d9b296a)\n\ntest/resolvers/slow.test.ts:\n";

export const FIXTURE_GAP_STORE = "http://gap-store.fixture/resolve";
/**
 * An in-memory gap store behind GAP_STORE_ENDPOINT (read at call time by substrate-gap.ts, which
 * forwards both reads and writes there). Without it the real resolver uses its gap store under the
 * WORKSPACE_ROOT captured at MODULE LOAD — the repo checkout on a dev host, the LIVE store in a
 * container — which no per-test env can redirect. Same merge rule as the real store: omitted
 * classification_metadata keys carry forward. Set process.env.GAP_STORE_ENDPOINT =
 * FIXTURE_GAP_STORE in the test's setup (and restore it).
 */
export function routeFixtureGapStore(g: FetchGuard): Map<string, Record<string, any>> {
  const rows = new Map<string, Record<string, any>>();
  g.route({
    name: "fixture gap store",
    match: (u) => u.startsWith("http://gap-store.fixture"),
    respond: (_u, b) => {
      const p = (b?.impulse?.pointer ?? {}) as Record<string, any>;
      if (p["type"] === "substrateGap_write") {
        const gap = (p["gap"] ?? {}) as Record<string, any>;
        const id = String(gap["id"] ?? "");
        const ex = rows.get(id);
        const meta = { ...((ex?.["classification_metadata"] ?? {}) as object), ...((gap["classification_metadata"] ?? {}) as object) };
        rows.set(id, { ...(ex ?? {}), ...gap, classification_metadata: meta });
        return Response.json({ shape: "substrateGapWriteResult", body: { id, action: ex ? "updated" : "created" } });
      }
      if (p["type"] === "substrateGap") {
        let gaps = [...rows.values()];
        if (typeof p["id"] === "string") gaps = gaps.filter((r) => r["id"] === p["id"]);
        if (typeof p["status"] === "string") gaps = gaps.filter((r) => r["status"] === p["status"]);
        if (typeof p["limit"] === "number") gaps = gaps.slice(0, p["limit"]);
        return Response.json({ shape: "substrateGap", body: { gaps } });
      }
      return Response.json({ shape: "structuredError", body: { detail: `fixture gap store: unsupported pointer type ${String(p["type"])}` } });
    },
  });
  return rows;
}
