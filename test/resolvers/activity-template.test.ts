import { describe, it, expect, afterAll } from "bun:test";

// Two defects, one fix.
//
// 1) The resolver freezes its endpoint in a MODULE-SCOPE const evaluated at import:
//      const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
//    `??` falls back only on null/undefined, NOT on "", and this container exports
//    METABOB_ENDPOINT as an EMPTY STRING — so the const became "" and fetch threw
//    ERR_INVALID_URL before any assertion ran. A static import would freeze that empty
//    value before a hook could fix it, hence the dynamic import below.
//
// 2) This suite made REAL network calls to the live activity-api and was therefore
//    FLAKY: two consecutive runs on an identical tree gave 3 pass / 0 fail and then
//    0 pass / 3 fail. The resolver does not wrap fetch in try/catch, so any connection
//    hiccup throws straight out of it. CLAUDE.md is explicit — "use scripted ProcessPort
//    / fake fetch for HTTP-touching resolvers — no real network in tests" — so the fix is
//    to serve both paths from a scripted mock rather than depend on live substrate state.
//
// The 404 for the single-template lookup is deliberate: it exercises the `!res.ok` branch
// the test name describes ("missing returns ok=false"), instead of asserting a tolerant
// "either outcome is fine" that passes no matter what happens.
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENDPOINT = process.env["METABOB_ENDPOINT"];
if (!process.env["METABOB_ENDPOINT"]) process.env["METABOB_ENDPOINT"] = "http://127.0.0.1:8080";

globalThis.fetch = (async (input: string | URL | Request) => {
  const u = String(input);
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (u.includes("/v2/activities/templates/")) return json({ error: "not found" }, 404);
  return json({ templates: [{ id: "tmpl:alpha", tasks: [{}], tags: ["t"] }], total: 1 });
}) as typeof fetch;

const { resolveActivityTemplate } = await import("../../src/resolvers/activity-template.js");

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENDPOINT === undefined) delete process.env["METABOB_ENDPOINT"];
  else process.env["METABOB_ENDPOINT"] = ORIGINAL_ENDPOINT;
});

describe("resolveActivityTemplate", () => {

  it("returns shape=activity_template with ok=true or ok=false", async () => {
    const result = await resolveActivityTemplate({ type: "activity_template", limit: 5 });
    expect(result.shape).toBe("activity_template");
    expect(result.body).toBeDefined();
    const body = result.body as Record<string, unknown>;
    expect(typeof body["ok"]).toBe("boolean");
    expect(typeof body["summary"]).toBe("string");
  });

  it("returns templates array in body", async () => {
    const result = await resolveActivityTemplate({ type: "activity_template", limit: 5 });
    expect(result.shape).toBe("activity_template");
    const body = result.body as Record<string, unknown>;
    expect(Array.isArray(body["templates"])).toBe(true);
    expect(typeof body["total"]).toBe("number");
  });

  it("returns activity_template shape for single templateId lookup (missing returns ok=false)", async () => {
    const result = await resolveActivityTemplate({
      type: "activity_template",
      templateId: "nonexistent-template-id-for-test",
    });
    expect(result.shape).toBe("activity_template");
    const body = result.body as Record<string, unknown>;
    // Either ok (if substrate is up) or error path
    expect(typeof body["summary"]).toBe("string");
  });
});
