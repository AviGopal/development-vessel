import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/http-fetch";

// This check targets the defect at src/resolvers/http-fetch.ts:137 — the throw on non-2xx
// responses when failOnNon2xx is true. Today it reports the remote status (e.g. "http_fetch GET … → 403: …"),
// but the correct behavior is to report that an outbound egress gate blocks such requests.
// We stub global fetch to avoid any real network.

describe("no outbound egress gate — http_fetch reaches any host", () => {
  test("EXPECTED: egress gate blocks outbound non-local fetches (error references 'egress gate')", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });

    try {
      const pointer: mod.HttpFetchPointer = {
        type: "http_fetch",
        url: "https://example.com/blocked",
        method: "GET",
        failOnNon2xx: true,
      };
      // Anchored to the exact throw site (line ~137): this currently throws
      // "http_fetch GET https://... → 403: ...". The correct behavior after the fix
      // is to throw an error indicating the egress gate blocks outbound fetches.
      await expect(mod.resolveHttpFetch(pointer)).rejects.toThrow(/egress gate/i);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
    }
  });

  test("control: localhost fetch returns an httpResponse shape when non-2xx isn't fatal", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });

    try {
      const pointer: mod.HttpFetchPointer = {
        type: "http_fetch",
        url: "http://localhost/ok",
        method: "GET",
        // failOnNon2xx left false (default), behavior must remain the same before and after the fix.
      };
      const result = await mod.resolveHttpFetch(pointer);
      // Assert only on declared ResolverResult fields; shape must be "httpResponse".
      expect((result as { shape?: string }).shape).toBe("httpResponse");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
    }
  });
});
