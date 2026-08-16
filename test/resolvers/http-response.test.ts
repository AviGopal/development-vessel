import { describe, it, expect } from "bun:test";
import { resolveHttpResponse } from "../../src/resolvers/http-response.js";

// WHAT THIS TEST USED TO ASSERT (2026-08-16):
//
//   it("fetches httpbin 404 page and returns title in http_response shape", async () => {
//     const result = await resolveHttpResponse({ type: "http_response" });
//     expect(typeof result.body).toBe("string");
//   });
//
// It pinned a resolver that ignored the pointer entirely and fetched a hardcoded
// https://httpbin.org/status/404, returning that page's <title>. The shape was advertised and
// dispatched, so a walk needing an external fetch selected it and got httpbin's title back no
// matter what it asked for — and the coverage said that was correct. It also made a live network
// call from a unit test, so the suite depended on httpbin being up.
//
// A test that pins a hardcoded answer pins the lie with it. These tests assert the two properties
// that matter instead: an unbound url is REFUSED rather than assumed, and the trust gate's verdict
// reaches the caller instead of being flattened into a success.

describe("resolveHttpResponse", () => {
  it("REFUSES an unbound url rather than fetching an assumed address", async () => {
    const result = await resolveHttpResponse({ type: "http_response" });
    expect(result.shape).toBe("http_response");
    const body = result.body as Record<string, unknown>;
    expect(body["resolved"]).toBe(false);
    expect(String(body["error"])).toContain("url is required");
    // The predecessor's hardcoded probe must not survive anywhere in the refusal.
    expect(JSON.stringify(body)).not.toContain("httpbin.org/status/404");
  });

  it("refuses empty and whitespace-only urls, not just a missing key", async () => {
    for (const url of ["", "   ", "\t"]) {
      const body = (await resolveHttpResponse({ type: "http_response", url })).body as Record<string, unknown>;
      expect(body["resolved"]).toBe(false);
    }
  });

  it("rejects a wrong pointer type without touching the network", async () => {
    const body = (await resolveHttpResponse({ type: "not_http_response" })).body as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
  });

  // THE DELEGATION PROPERTY. http_response must inherit web_resource's trust gate rather than
  // become a second, ungated egress path — an unknown origin is REFUSED, not fetched. No network
  // call happens here: the gate rejects before any fetch is attempted.
  it("passes the trust gate's refusal through instead of flattening it into a success", async () => {
    const body = (await resolveHttpResponse({
      type: "http_response",
      url: "https://not-an-allowlisted-origin.invalid/thing",
    })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(String(body["reason"])).toContain("allowlist");
    // The caller is told which domain was refused and what the allowlist is, so a walk can
    // report the real obstacle rather than inventing a value.
    expect(body["domain"]).toBe("not-an-allowlisted-origin.invalid");
    expect(Array.isArray(body["allow_domains"])).toBe(true);
  });

  // Pins the 2026-08-16 allowlist entry. ssd.jpl.nasa.gov is the origin the substrate has
  // repeatedly derived as the right source for an ephemeris question and been unable to reach —
  // the goal class failed for want of an origin, not for want of reasoning. If someone removes
  // the entry, this fails loudly instead of the capability silently disappearing again.
  // Asserts only that the gate ADMITS the origin: no network call is made, and admission is not
  // a claim that any particular query works.
  it("admits ssd.jpl.nasa.gov — a read-only public scientific data API, like open-meteo", async () => {
    const { resolveWebResource } = await import("../../src/resolvers/web-resource.js");
    const rejected = (await resolveWebResource({
      type: "web_resource",
      url: "https://ssd.jpl.nasa.gov/api/horizons.api",
      allow_domains: ["example.invalid"], // force a refusal to prove the gate is what decides
    })).body as Record<string, unknown>;
    expect(rejected["trust"]).toBe("rejected");

    // With the shipped default list, the same origin is NOT refused by the allowlist branch.
    const body = (await resolveHttpResponse({
      type: "http_response",
      url: "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=%27501%27",
    })).body as Record<string, unknown>;
    expect(body["trust"]).not.toBe("rejected");
  }, 20_000);

  it("refuses non-https urls through the same gate", async () => {
    const body = (await resolveHttpResponse({
      type: "http_response",
      url: "http://en.wikipedia.org/wiki/Io",
    })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
  });

  it("honours a caller-supplied allowlist override, so the gate is data not a constant", async () => {
    const body = (await resolveHttpResponse({
      type: "http_response",
      url: "https://example.invalid/thing",
      allow_domains: ["other.invalid"],
    })).body as Record<string, unknown>;
    expect(body["trust"]).toBe("rejected");
    expect(body["allow_domains"]).toEqual(["other.invalid"]);
  });
});
