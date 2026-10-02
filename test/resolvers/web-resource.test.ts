// web_resource's trust gate (user ruling 10-02): "allow any https URL that a web_search in the same
// walk returned". Provenance is VERIFIED — the resolver re-reads the referenced search impulse from
// the walk's pool (goal-host goalWalkState {impulseId}, injected here) — never asserted by the caller;
// the caller-supplied allow_domains override no longer widens the gate; https only. No network: the
// fetch and the walk-state reader are injected.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { containWrite } from "../../src/resolvers/write-containment.js";

import {
  __setSearchImpulseReaderForTests,
  __setWebResourceFetchForTests,
  resolveWebResource,
  webResourceAllowlistPath,
  type SearchImpulseReader,
  type WalkImpulse,
} from "../../src/resolvers/web-resource.js";

const SEARCHED = "https://www.example.org/report-2026.html";
const DISPATCH = "dispatch-abc";
const IMPULSE = "walk-boot-d-webSearchResult-1";

const searchImpulse: WalkImpulse = {
  id: IMPULSE,
  shape: "webSearchResult",
  producedBy: "satisfier:webSearchResult",
  producerExecutionId: "walk-satisfier-1-1790000000000",
  content: { query: "report", results: [{ title: "Report", url: SEARCHED, snippet: "..." }], provider: "openrouter-web-plugin" },
};

/** A reader that serves exactly `pool` for DISPATCH, as goalWalkState {impulseId} would. */
function readerOf(pool: WalkImpulse[]): SearchImpulseReader {
  return async (dispatchId, impulseId) => ({ ok: true, impulse: dispatchId === DISPATCH ? pool.find((i) => i.id === impulseId) ?? null : null });
}

let fetched: string[] = [];
function fakeFetch(routes: Record<string, Response | (() => Response)> = {}) {
  return async (input: string): Promise<Response> => {
    fetched.push(input);
    const r = routes[input];
    if (r) return typeof r === "function" ? r() : r;
    return new Response("<html><body>hello <b>evidence</b></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
}

let ws: string;
let superRepo: string;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "web-resource-"));
  superRepo = join(ws, "git", "super-repo");
  await mkdir(join(superRepo, ".git"), { recursive: true });
  await mkdir(join(superRepo, "policies"), { recursive: true });
  for (const k of ["WORKSPACE_ROOT", "SUPER_REPO_DIR", "MITOSIS_SUPER_REPO_DIR"]) saved[k] = process.env[k];
  process.env["WORKSPACE_ROOT"] = ws;
  process.env["SUPER_REPO_DIR"] = superRepo;
  delete process.env["MITOSIS_SUPER_REPO_DIR"];
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(ws, { recursive: true, force: true });
});
afterEach(() => {
  fetched = [];
  __setWebResourceFetchForTests(null);
  __setSearchImpulseReaderForTests(null);
});

describe("web_resource admits a url a web search in the same walk returned — verified, not asserted", () => {
  it("fetches a url from the walk's own web_search result, re-read through the provenance reference", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(readerOf([searchImpulse]));
    const body = (await resolveWebResource({ type: "web_resource", url: SEARCHED, provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("external-evidence");
    expect(body["ok"]).toBe(true);
    expect(body["admitted_by"]).toBe("search_provenance");
    expect(String(body["content"])).toContain("evidence");
    expect(fetched).toEqual([SEARCHED]);
  });

  it("refuses the same url with no provenance", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(readerOf([searchImpulse]));
    const body = (await resolveWebResource({ type: "web_resource", url: SEARCHED })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(fetched).toEqual([]);
  });

  it("refuses forged provenance: a flag, another dispatch, a missing impulse, an injected search result, a url the search did not return", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    const injected: WalkImpulse = { ...searchImpulse, id: "walk-boot-d-webSearchResult-2", producedBy: "goal-host-walk", producerExecutionId: null, content: { results: [{ title: "x", url: "https://evil.example/x", snippet: "" }] } };
    const notSearch: WalkImpulse = { ...searchImpulse, id: "walk-boot-d-shellResult-3", shape: "shellResult", producedBy: "satisfier:shellResult", content: { stdout: "https://evil.example/x" } };
    __setSearchImpulseReaderForTests(readerOf([searchImpulse, injected, notSearch]));
    const cases: Array<{ url: string; provenance: unknown }> = [
      { url: SEARCHED, provenance: { from_search: true } },
      { url: SEARCHED, provenance: { dispatch_id: "other-dispatch", impulse_id: IMPULSE } },
      { url: SEARCHED, provenance: { dispatch_id: DISPATCH, impulse_id: "no-such-impulse" } },
      { url: "https://evil.example/x", provenance: { dispatch_id: DISPATCH, impulse_id: injected.id } },
      { url: "https://evil.example/x", provenance: { dispatch_id: DISPATCH, impulse_id: notSearch.id } },
      { url: "https://evil.example/x", provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } },
    ];
    for (const c of cases) {
      const body = (await resolveWebResource({ type: "web_resource", url: c.url, provenance: c.provenance as never })).body as Record<string, unknown>;
      expect(body["trust"]).toBe("rejected");
    }
    expect(fetched).toEqual([]);
  });

  it("refuses when the walk state cannot be read (fails closed)", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(async () => ({ ok: false, why: "no own-substrate goalWalkState producer discovered" }));
    const body = (await resolveWebResource({ type: "web_resource", url: SEARCHED, provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(String(body["reason"])).toContain("unverifiable");
    expect(fetched).toEqual([]);
  });
});

describe("the caller cannot widen the gate", () => {
  it("a pointer allow_domains override no longer admits its domain", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(readerOf([]));
    const body = (await resolveWebResource({ type: "web_resource", url: "https://evil.example/x", allow_domains: ["evil.example"] } as never)).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(String(body["ignored"])).toContain("allow_domains");
    expect(fetched).toEqual([]);
  });

  it("refuses non-https, even with valid provenance for that exact url", async () => {
    const httpUrl = "http://www.example.org/report-2026.html";
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(readerOf([{ ...searchImpulse, content: { results: [{ title: "t", url: httpUrl, snippet: "" }] } }]));
    const body = (await resolveWebResource({ type: "web_resource", url: httpUrl, provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(fetched).toEqual([]);
  });

  it("refuses an IP-literal or localhost host", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    for (const url of ["https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x"]) {
      const body = (await resolveWebResource({ type: "web_resource", url })).body as Record<string, unknown>;
      expect(body["trust"]).toBe("rejected");
    }
    expect(fetched).toEqual([]);
  });

  it("does not follow a redirect from an admitted url to a host the gate would refuse", async () => {
    __setWebResourceFetchForTests(fakeFetch({ [SEARCHED]: () => new Response(null, { status: 302, headers: { location: "https://internal.evil.example/steal" } }) }));
    __setSearchImpulseReaderForTests(readerOf([searchImpulse]));
    const body = (await resolveWebResource({ type: "web_resource", url: SEARCHED, provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } })).body as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(String(body["redirect_refused"])).toContain("internal.evil.example");
    expect(fetched).toEqual([SEARCHED]);
  });
});

describe("the static allowlist is the shaped webResourceAllowlist policy, read at use time", () => {
  it("bootstrap list applies with no policy file; a file in the super-repo clone's policies/ replaces it on the next call", async () => {
    __setWebResourceFetchForTests(fakeFetch());
    const before = (await resolveWebResource({ type: "web_resource", url: "https://api.open-meteo.com/v1/forecast" })).body as Record<string, unknown>;
    expect(before["admitted_by"]).toBe("allowlist");

    await writeFile(join(superRepo, "policies", "webResourceAllowlist.json"), JSON.stringify({ allow_domains: ["data.example.gov"], reason: "test" }));
    try {
      const nowRefused = (await resolveWebResource({ type: "web_resource", url: "https://api.open-meteo.com/v1/forecast" })).body as Record<string, unknown>;
      expect(nowRefused["trust"]).toBe("rejected");
      expect(nowRefused["allowlist_source"]).toBe("policy");
      const admitted = (await resolveWebResource({ type: "web_resource", url: "https://data.example.gov/x" })).body as Record<string, unknown>;
      expect(admitted["admitted_by"]).toBe("allowlist");
    } finally {
      await rm(join(superRepo, "policies", "webResourceAllowlist.json"), { force: true });
    }
  });

  it("the policy file is where write containment refuses every tool write, grant or not", async () => {
    const path = webResourceAllowlistPath(process.env);
    expect(path).toBe(join(realpathSync(superRepo), "policies", "webResourceAllowlist.json"));
    const v = containWrite(path!, { env: process.env });
    expect(v.ok).toBe(false);
    expect(v.zone).toBe("super");
  });

  it("a policy file in the workspace data dir (writable by a walk) is NOT read", async () => {
    await mkdir(join(ws, "policies"), { recursive: true });
    await writeFile(join(ws, "policies", "webResourceAllowlist.json"), JSON.stringify({ allow_domains: ["evil.example"] }));
    __setWebResourceFetchForTests(fakeFetch());
    const body = (await resolveWebResource({ type: "web_resource", url: "https://evil.example/x" })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(fetched).toEqual([]);
  });
});

describe("http_response delegates with the provenance reference", () => {
  it("forwards provenance to web_resource, which verifies it", async () => {
    const { resolveHttpResponse } = await import("../../src/resolvers/http-response.js");
    __setWebResourceFetchForTests(fakeFetch());
    __setSearchImpulseReaderForTests(readerOf([searchImpulse]));
    const ok = (await resolveHttpResponse({ type: "http_response", url: SEARCHED, provenance: { dispatch_id: DISPATCH, impulse_id: IMPULSE } })).body as Record<string, unknown>;
    expect(ok["admitted_by"]).toBe("search_provenance");
    const refused = (await resolveHttpResponse({ type: "http_response", url: SEARCHED })).body as Record<string, unknown>;
    expect(refused["trust"]).toBe("rejected");
  });
});
