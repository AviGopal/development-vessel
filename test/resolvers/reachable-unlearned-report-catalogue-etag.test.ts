// reachable-unlearned-report DOES NOT RE-PAGE AN UNCHANGED TEMPLATE CATALOGUE.
//
// Every run paged GET /v2/activities/templates 100 at a time to `total` (~30 pages per run on a live hub, from every
// node running the report). activity-api now answers a catalogue ETag and a 304 to a matching If-None-Match; the report
// keeps its last complete walk with that tag (src/lib/template-catalogue-fetch.ts).
//   [MUST-FAIL] the second run on an unchanged catalogue makes ONE templates request, answered 304 (no pagination), and
//               reports the same entries as the first;
//   [CONTROL]   a changed catalogue (new tag) is walked in full and its new rows are reported;
//   [CONTROL]   a walk whose pages carried different tags (the catalogue changed mid-walk) is not kept: the next run
//               walks in full again;
//   [CONTROL]   a server that sends no ETag is never asked conditionally and is walked in full every run;
//   [HELPER]    a different caller credential does not reuse another credential's kept catalogue (the helper is new).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { resolveReachableUnlearnedReport } from "../../src/resolvers/reachable-unlearned-report.js";
// Loaded dynamically so that, on a tree without the helper, the report cases still run (and fail on the pagination).
const helper = await import("../../src/lib/template-catalogue-fetch.js").catch(() => null);

const originalFetch = globalThis.fetch;

interface Calls { templates: Array<{ offset: number; inm: string | null; status: number }> }

function makeTemplates(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `t:${tag}${i}`, output_shapes: [`shape-${tag}-${i}`], thompson_alpha: 1 }));
}

function serve(state: { templates: unknown[]; etag: string | null; etagForPage?: (offset: number) => string | null }, calls: Calls) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v2/activities/templates") && !u.includes("auto-promote")) {
      const q = new URL(u).searchParams;
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 100);
      const h = new Headers(init?.headers);
      const inm = h.get("If-None-Match");
      const tag = state.etagForPage ? state.etagForPage(offset) : state.etag;
      if (tag && inm === tag) {
        calls.templates.push({ offset, inm, status: 304 });
        return new Response(null, { status: 304, headers: { ETag: tag } });
      }
      calls.templates.push({ offset, inm, status: 200 });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tag) headers["ETag"] = tag;
      return new Response(JSON.stringify({ templates: state.templates.slice(offset, offset + limit), total: state.templates.length, limit, offset }), { status: 200, headers });
    }
    if (u.includes("/v2/activities/execution-traces")) return new Response(JSON.stringify({ traces: [] }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => { helper?.__resetTemplateCatalogueCache(); });
afterAll(() => { globalThis.fetch = originalFetch; });

describe("reachable-unlearned-report template catalogue ETag", () => {
  it("[MUST-FAIL] the second run on an unchanged catalogue makes one 304 request, no pagination", async () => {
    const state = { templates: makeTemplates(250, "a"), etag: 'W/"tc-one"' };
    const calls: Calls = { templates: [] };
    globalThis.fetch = serve(state, calls);
    const first = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(calls.templates.length).toBe(3);
    calls.templates.length = 0;
    const second = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(calls.templates.length).toBe(1);
    expect(calls.templates[0]).toEqual({ offset: 0, inm: 'W/"tc-one"', status: 304 });
    expect((second.body as { entries: unknown[] }).entries).toEqual((first.body as { entries: unknown[] }).entries);
    expect((second.body as { entries: unknown[] }).entries.length).toBe(250);
  });

  it("[CONTROL] a changed catalogue is walked in full and its new rows reported", async () => {
    const state = { templates: makeTemplates(250, "a"), etag: 'W/"tc-one"' };
    const calls: Calls = { templates: [] };
    globalThis.fetch = serve(state, calls);
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    state.templates = makeTemplates(260, "b");
    state.etag = 'W/"tc-two"';
    calls.templates.length = 0;
    const second = await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(calls.templates.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(calls.templates[0]!.inm).toBe('W/"tc-one"');
    const shapes = (second.body as { entries: Array<{ shape: string }> }).entries.map((e) => e.shape);
    expect(shapes).toContain("shape-b-259");
    expect(shapes).not.toContain("shape-a-0");
  });

  it("[CONTROL] a walk whose pages carried different tags is not kept", async () => {
    const state = { templates: makeTemplates(250, "a"), etag: null, etagForPage: (o: number) => (o === 0 ? 'W/"tc-one"' : 'W/"tc-two"') };
    const calls: Calls = { templates: [] };
    globalThis.fetch = serve(state, calls);
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    calls.templates.length = 0;
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(calls.templates.length).toBe(3);
    expect(calls.templates[0]!.inm).toBeNull();
  });

  it("[CONTROL] a server with no ETag is never asked conditionally", async () => {
    const state = { templates: makeTemplates(150, "a"), etag: null };
    const calls: Calls = { templates: [] };
    globalThis.fetch = serve(state, calls);
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    await resolveReachableUnlearnedReport({ type: "reachable_unlearned_report" });
    expect(calls.templates.length).toBe(4);
    expect(calls.templates.every((c) => c.inm === null && c.status === 200)).toBe(true);
  });

  it("[HELPER] another credential does not reuse the kept catalogue", async () => {
    expect(helper).not.toBeNull();
    const { fetchTemplateCatalogue } = helper!;
    const state = { templates: makeTemplates(120, "a"), etag: 'W/"tc-one"' };
    const calls: Calls = { templates: [] };
    globalThis.fetch = serve(state, calls);
    await fetchTemplateCatalogue("https://activity.test", "fixture-cred-one");
    calls.templates.length = 0;
    const other = await fetchTemplateCatalogue("https://activity.test", "fixture-cred-two");
    expect(other.notModified).toBe(false);
    expect(calls.templates[0]!.inm).toBeNull();
    expect(other.templates.length).toBe(120);
    calls.templates.length = 0;
    const again = await fetchTemplateCatalogue("https://activity.test", "fixture-cred-two");
    expect(again.notModified).toBe(true);
    expect(again.requests).toBe(1);
  });
});
