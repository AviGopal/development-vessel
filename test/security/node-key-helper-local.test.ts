// THE NODE KEY NEVER FOLLOWS A POINTER URL THAT A HELPER BUILDS INTO A LOCAL.
//
// These five sites hand a pointer-overridable base (conceptDbUrl, metabobEndpoint) to a helper that builds
// the request URL in a local and attaches the raw METABOB_API_KEY. The keyed-URL sweep could not see them
// until it learned that a helper's local URL still passes its parameter through (cdb328e1). One case per
// family, each with a RECORDING fetch stub:
//   concept-db:   concept-select-for-prompt (pointer.conceptDbUrl -> fetchForSourceType)
//   activity-api: vector-space-orthogonality-audit (pointer.metabobEndpoint -> fetchFailureTraces), whose
//                 concept-db leg (pointer.conceptDbUrl -> nearestPrincipleSimilarity) is checked in the same run
// override: the endpoint fields name http://attacker.invalid; a request reaches it and carries no
// Authorization. control: no override; the configured endpoint gets `ApiKey <key>`.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";

const NODE_KEY = "node-key-under-test";
const ATTACKER = "http://attacker.invalid";
type Seen = { url: string; authorization: string | null };
const realFetch = globalThis.fetch;
let priorKey: string | undefined;
beforeAll(() => { priorKey = process.env["METABOB_API_KEY"]; process.env["METABOB_API_KEY"] = NODE_KEY; });
afterAll(() => { if (priorKey === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = priorKey; });
afterEach(() => { globalThis.fetch = realFetch; });

function recordingFetch(respond: (url: string) => unknown): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization") });
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}
const toAttacker = (seen: Seen[]) => seen.filter((s) => s.url.startsWith(ATTACKER));
const keyed = (seen: Seen[]) => seen.filter((s) => s.authorization === `ApiKey ${NODE_KEY}`);

describe("concept-db through a helper's local URL: concept-select-for-prompt pointer.conceptDbUrl", () => {
  const run = async (attacker: boolean) => {
    const { resolveConceptSelectForPrompt } = await import("../../src/resolvers/concept-select-for-prompt.js");
    const seen = recordingFetch(() => ({ concepts: [] }));
    await resolveConceptSelectForPrompt({ type: "concept_select_for_prompt", query: "q", ...(attacker ? { conceptDbUrl: `${ATTACKER}/concepts/search` } : {}) } as never);
    return seen;
  };
  it("an overridden conceptDbUrl gets no Authorization", async () => {
    const seen = await run(true);
    expect(toAttacker(seen).length).toBeGreaterThan(0);
    expect(toAttacker(seen).filter((s) => s.authorization !== null).map((s) => s.url)).toEqual([]);
  });
  it("control: the configured concept-db gets the key", async () => {
    const seen = await run(false);
    expect(keyed(seen).filter((s) => s.url.startsWith("http://127.0.0.1:8260/concepts/search")).length).toBeGreaterThan(0);
  });
});

describe("activity-api and concept-db through helpers: vector-space-orthogonality-audit", () => {
  const trace = { id: "t1", activity_id: "a1", status: "failure", executed_at: new Date().toISOString(), failure_mode: { type: "x", reason: "r" } };
  const run = async (attacker: boolean) => {
    const { resolveVectorSpaceOrthogonalityAudit } = await import("../../src/resolvers/vector-space-orthogonality-audit.js");
    const seen = recordingFetch((url) => (url.includes("execution-traces") ? { executions: [trace] } : { concepts: [] }));
    await resolveVectorSpaceOrthogonalityAudit({ type: "vector_space_orthogonality_audit", emit_gap: false, ...(attacker ? { metabobEndpoint: ATTACKER, conceptDbUrl: ATTACKER } : {}) } as never);
    return seen;
  };
  it("overridden metabobEndpoint and conceptDbUrl get no Authorization", async () => {
    const seen = await run(true);
    expect(toAttacker(seen).some((s) => s.url.includes("/execution-traces"))).toBe(true);
    expect(toAttacker(seen).some((s) => s.url.includes("/concepts/search"))).toBe(true);
    expect(toAttacker(seen).filter((s) => s.authorization !== null).map((s) => s.url)).toEqual([]);
  });
  it("control: the configured activity-api and concept-db get the key", async () => {
    const seen = await run(false);
    expect(keyed(seen).some((s) => s.url.includes("/execution-traces"))).toBe(true);
    expect(keyed(seen).some((s) => s.url.includes("/concepts/search"))).toBe(true);
  });
});
