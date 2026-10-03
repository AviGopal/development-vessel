// THE WRITE-GATE REFUSAL NAMES ITS CAUSE AND ITS CALLER (check-first).
//
// The resolve route refused an unauthenticated write with one line for four different failures:
// "[resolve] REFUSED unauthenticated <type>: no ApiKey credential presented", whether the request had
// no Authorization header, a scheme other than ApiKey, "ApiKey " with an empty key, or only an
// x-api-key header (which this route does not read). The line also named no caller, so a refusal
// storm could not be traced to who was sending it.
//
// CONTRACT: each case gives a distinct reason, the refusal line carries remote=<socket address> and
// caller=<pointer.caller> when the pointer names one, and no line contains the presented key or an 8+
// character prefix of its sha256 or sha1 hex (the leak check from gap-write-audit-no-key-derivative).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";

const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"write-gate-refusal-attribution"}`);

const SECRET = "sk-fixture-refusal-SECRET-7c2a91f0";
function forbidden(): string[] {
  const out = [SECRET];
  for (const alg of ["sha256", "sha1"]) {
    const hex = createHash(alg).update(SECRET).digest("hex");
    for (let n = 8; n <= hex.length; n++) out.push(hex.slice(0, n));
  }
  return out;
}
const leaks = (text: string): string[] => { const t = text.toLowerCase(); return forbidden().filter((n) => t.includes(n.toLowerCase())); };

const realFetch = globalThis.fetch;
let lines: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
beforeEach(() => {
  lines = [];
  for (const m of ["log", "warn", "error", "info"] as const) spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
  // Nothing may reach the network: no write here is meant to get past the gate.
  globalThis.fetch = (async () => { throw new Error("network disabled in this test"); }) as unknown as typeof fetch;
});
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });
afterAll(() => { globalThis.fetch = realFetch; });

async function refuse(headers: Record<string, string>): Promise<{ status: number; error: string; line: string }> {
  const before = lines.length;
  const res = await impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dv-remote-addr": "10.9.8.7", ...headers },
    body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse_write", id: "refusal-fixture", shape: "fixture", caller: "boredom-vessel" } } }),
  });
  const j = (await res.json()) as { error?: string };
  return { status: res.status, error: String(j.error ?? ""), line: lines.slice(before).find((l) => l.includes("REFUSED unauthenticated")) ?? "" };
}

describe("the write-gate refusal", () => {
  it("[MUST-FAIL] gives each of the four missing-credential cases a distinct reason", async () => {
    const cases = [
      await refuse({}),
      await refuse({ Authorization: `Bearer ${SECRET}` }),
      await refuse({ Authorization: "ApiKey " }),
      await refuse({ "x-api-key": SECRET }),
    ];
    for (const c of cases) expect(c.status).toBe(401);
    const reasons = cases.map((c) => c.line.replace(/^.*poolImpulse_write: /, "").replace(/ remote=.*$/, ""));
    expect(new Set(reasons).size).toBe(4);
    expect(new Set(cases.map((c) => c.error)).size).toBe(4);
  });

  it("[MUST-FAIL] names the socket remote address and the pointer's caller", async () => {
    const c = await refuse({});
    expect(c.line).toContain("remote=10.9.8.7");
    expect(c.line).toContain("caller=boredom-vessel");
  });

  it("[CONTROL] never logs or returns key material", async () => {
    for (const h of [{ Authorization: `Bearer ${SECRET}` }, { "x-api-key": SECRET }, { Authorization: SECRET }, { Authorization: `ApiKey ${SECRET} extra` }]) {
      const c = await refuse(h);
      expect(leaks(c.error)).toEqual([]);
    }
    for (const l of lines) expect(leaks(l)).toEqual([]);
  });
});
