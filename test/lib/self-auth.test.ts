// selfAuthHeaders sends the node key to this vessel's own self endpoint and to nothing else.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { selfAuthHeaders } from "../../src/lib/self-auth.js";

const SELF = "http://127.0.0.1:8090/v2/impulses/resolve";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = "self-auth-test-key";
});
afterEach(() => {
  if (saved === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = saved;
});

describe("selfAuthHeaders", () => {
  it("attaches the node key when the target is exactly the self endpoint", () => {
    expect(selfAuthHeaders(SELF, SELF)).toEqual({ Authorization: "ApiKey self-auth-test-key" });
  });

  it("MUST-FAIL: a caller-supplied or arbitrary URL gets NO Authorization", () => {
    for (const url of [
      "http://caller-supplied.example/v2/impulses/resolve",
      "http://127.0.0.1:8080/v2/impulses/resolve",
      `${SELF}?x=1`,
      "http://127.0.0.1:8090/v2/impulses/resolve/",
      "",
    ]) {
      expect(selfAuthHeaders(url, SELF)).toEqual({});
    }
  });

  it("reads the key at use time, and omits the header when it is empty (the gate refuses either way)", () => {
    process.env["METABOB_API_KEY"] = "rotated";
    expect(selfAuthHeaders(SELF, SELF)).toEqual({ Authorization: "ApiKey rotated" });
    process.env["METABOB_API_KEY"] = "";
    expect(selfAuthHeaders(SELF, SELF)).toEqual({});
    delete process.env["METABOB_API_KEY"];
    expect(selfAuthHeaders(SELF, SELF)).toEqual({});
  });
});
