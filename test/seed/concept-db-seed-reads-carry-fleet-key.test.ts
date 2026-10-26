// PIN: the seed templates' concept-db reads carry the fleet key through the established http_fetch convention.
//
// The convention (src/resolvers/http-fetch.ts, "Auto-attach this vessel's METABOB_API_KEY"; restated at
// src/seed/vessel-scaffold-trigger-tick.ts "No Authorization here" and src/seed/detect-stale-pointer.ts): a seed
// http_fetch to a loopback vessel sets NO Authorization header, and the resolver attaches `ApiKey <fleet key>`.
// No executor expands a `${...}` placeholder, so a literal header would be sent as-is and suppress the real key.
// draft-spec-from-gap's read_gaps and read_priors and draft-gap-closing-activity's concept-db reads follow it: each
// is a loopback GET with no Authorization, and driven through resolveHttpFetch each request carries the key.
// CONTROL: a step that sets its own Authorization keeps it and does not get the fleet key.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveHttpFetch } from "../../src/resolvers/http-fetch.js";
import { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "../../src/seed/draft-spec-from-gap.js";
import { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "../../src/seed/draft-gap-closing-activity.js";

type Task = { id: string; resolver: string; config?: Record<string, unknown> };
const conceptDbReads = (tasks: readonly Task[]) =>
  tasks.filter((t) => t.resolver === "http_fetch" && /:8260\/concepts\/search/.test(String(t.config?.["url"] ?? "")));

const KEY = "pin-fleet-key";
let prevKey: string | undefined;
let realFetch: typeof fetch;
let seen: Array<Record<string, string>> = [];
beforeEach(() => {
  prevKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = KEY;
  realFetch = globalThis.fetch;
  seen = [];
  globalThis.fetch = (async (_u: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(JSON.stringify({ concepts: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevKey === undefined) delete process.env["METABOB_API_KEY"]; else process.env["METABOB_API_KEY"] = prevKey;
});

const authOf = (h: Record<string, string>) => h[Object.keys(h).find((k) => k.toLowerCase() === "authorization") ?? ""];

const seeds: Array<[string, readonly Task[], string[]]> = [
  ["draft-spec-from-gap", DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks as unknown as Task[], ["read_gaps", "read_priors"]],
  ["draft-gap-closing-activity", DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks as unknown as Task[], []],
];

describe("[PIN] seed concept-db reads carry the fleet key via http_fetch's loopback auto-attach", () => {
  for (const [name, tasks, mustInclude] of seeds) {
    it(`${name}: every concept-db read is a loopback GET with no Authorization of its own`, () => {
      const reads = conceptDbReads(tasks);
      expect(reads.length).toBeGreaterThan(0);
      for (const id of mustInclude) expect(reads.map((t) => t.id)).toContain(id);
      for (const t of reads) {
        const u = new URL(String(t.config!["url"]).replace(/\{\{[^}]+\}\}/g, "x"));
        expect(["127.0.0.1", "localhost"]).toContain(u.hostname);
        const h = (t.config!["headers"] ?? {}) as Record<string, string>;
        expect(authOf(h)).toBeUndefined();
      }
    });

    it(`${name}: driven through http_fetch, each concept-db read sends ApiKey <fleet key>`, async () => {
      for (const t of conceptDbReads(tasks)) {
        const c = t.config!;
        await resolveHttpFetch({
          type: "http_fetch",
          url: String(c["url"]).replace(/\{\{[^}]+\}\}/g, "x"),
          method: (c["method"] as "GET") ?? "GET",
          ...(c["headers"] ? { headers: c["headers"] as Record<string, string> } : {}),
        });
      }
      expect(seen.length).toBe(conceptDbReads(tasks).length);
      for (const h of seen) expect(authOf(h)).toBe(`ApiKey ${KEY}`);
    });
  }

  it("[CONTROL] a step that sets a literal Authorization suppresses the fleet key", async () => {
    await resolveHttpFetch({
      type: "http_fetch",
      url: "http://127.0.0.1:8260/concepts/search?query=x",
      method: "GET",
      headers: { Authorization: "ApiKey ${METABOB_API_KEY}" },
    });
    expect(authOf(seen[0]!)).toBe("ApiKey ${METABOB_API_KEY}");
  });
});
