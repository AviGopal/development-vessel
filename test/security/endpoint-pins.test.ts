// PINS: two places the node-key sweep reads as safe for a reason it cannot check itself.
//
// 1. http_fetch is a generic fetch to the URL its pointer names, by design. It attaches the node key only
//    when the PARSED hostname is 127.0.0.1 or localhost. A string-prefix check would hand the key to
//    http://127.0.0.1.attacker.invalid or http://localhost@attacker.invalid. This pins the parsed check.
// 2. The scaffold templates contain `discoveryEndpoint: DISCOVERY_ENDPOINT`. That text is SOURCE CODE for
//    the scaffolded vessel's config.ts, inside an fs_write `content` string. It is not a pointer field a
//    resolver would send a key to. This pins that it stays inside content.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { resolveHttpFetch } from "../../src/resolvers/http-fetch.js";
import { COMPLETE_VESSEL_SCAFFOLD_TEMPLATE } from "../../src/seed/complete-vessel-scaffold.js";
import { SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE } from "../../src/seed/scaffold-and-publish-vessel.js";

const NODE_KEY = "node-key-under-test";
const realFetch = globalThis.fetch;
let priorKey: string | undefined;
beforeAll(() => {
  priorKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = NODE_KEY;
});
afterAll(() => {
  if (priorKey === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = priorKey;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function recordingFetch(): Array<{ url: string; authorization: string | null }> {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization") });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

describe("http_fetch: the node key goes only to a parsed local hostname", () => {
  for (const url of ["http://127.0.0.1.attacker.invalid/x", "http://localhost@attacker.invalid/x", "http://127.0.0.1:8080@attacker.invalid/x", "http://attacker.invalid/127.0.0.1"]) {
    it(`${url}: no Authorization`, async () => {
      const seen = recordingFetch();
      await resolveHttpFetch({ type: "http_fetch", url } as never);
      expect(seen.length).toBe(1);
      expect(seen[0]!.authorization).toBeNull();
    });
  }

  it("control: a local URL gets the node key", async () => {
    const seen = recordingFetch();
    await resolveHttpFetch({ type: "http_fetch", url: "http://127.0.0.1:8080/x" } as never);
    expect(seen.map((s) => s.authorization)).toEqual([`ApiKey ${NODE_KEY}`]);
  });
});

describe("scaffold templates: discoveryEndpoint is generated source, not a pointer field", () => {
  /** Every object key in a template's task configs, skipping string values (their text is content). */
  function configKeys(v: unknown, out: Array<{ key: string; value: unknown }> = []): Array<{ key: string; value: unknown }> {
    if (Array.isArray(v)) for (const x of v) configKeys(x, out);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.push({ key: k, value: x });
        configKeys(x, out);
      }
    }
    return out;
  }

  for (const [name, tpl] of [["complete-vessel-scaffold", COMPLETE_VESSEL_SCAFFOLD_TEMPLATE], ["scaffold-and-publish-vessel", SCAFFOLD_AND_PUBLISH_VESSEL_TEMPLATE]] as const) {
    it(`${name}: no task config has an endpoint field; the DISCOVERY_ENDPOINT text lives in fs_write content`, () => {
      const tasks = (tpl as unknown as { tasks: Array<{ config?: Record<string, unknown> }> }).tasks;
      const keys = tasks.flatMap((t) => configKeys(t.config ?? {}));
      expect(keys.filter((k) => /endpoint$|url$/i.test(k.key)).map((k) => k.key)).toEqual([]);
      const contents = tasks.map((t) => String(t.config?.["content"] ?? ""));
      expect(contents.some((c) => /discoveryEndpoint: DISCOVERY_ENDPOINT/.test(c))).toBe(true);
    });
  }
});
