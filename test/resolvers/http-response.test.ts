import { describe, it, expect } from "bun:test";
import { resolveHttpResponse } from "../../src/resolvers/http-response.js";

describe("resolveHttpResponse", () => {
  it("fetches httpbin 404 page and returns title in http_response shape", async () => {
    const result = await resolveHttpResponse({ type: "http_response" });
    expect(result.shape).toBe("http_response");
    expect(typeof result.body).toBe("string");
    expect(result.body.length).toBeGreaterThan(0);
  });
});
