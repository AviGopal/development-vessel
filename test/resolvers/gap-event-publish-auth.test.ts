// THE GAP-WRITTEN PUBLISH AUTHENTICATES (check-first, harm-stop).
//
// resolveSubstrateGapWrite published devvessel.gap.written to activity-api's /v2/events/publish with only
// `X-Internal-Api-Key: development-vessel`, a literal. activity-api checks that header for presence, never against a
// secret, and the hub's activity-api is reachable from the internet (2026-10-07), so the header-only path let anyone post
// to the bus and the trace store. activity-api removes it next; this caller has to authenticate first: Authorization:
// ApiKey <this vessel's key>, read at use time, and with no key nothing is published (counted), never a literal.
// Harness: gap-event-publish-isolation.test.ts (a listener at the address the resolver uses, the scratch opt-in).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seen: Array<Record<string, string>> = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/v2/events/publish") seen.push(Object.fromEntries(req.headers.entries()));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  },
});
const LISTENER = `http://127.0.0.1:${server.port}`;
const ROOT = mkdtempSync(join(tmpdir(), "gap-publish-auth-"));
const KEYS = ["WORKSPACE_ROOT", "ACTIVITY_API_ENDPOINT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "SUBSTRATE_API_KEY", "METABOB_API_KEY", "API_KEY"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const mod = await import(`../../src/resolvers/substrate-gap.js?${"gap-publish-auth"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) throw new Error("refusing to run against a non-temp gap store");

beforeAll(() => {
  process.env["ACTIVITY_API_ENDPOINT"] = LISTENER;
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  writeFileSync(join(ROOT, "gaps", "gaps.json"), "[]");
  mod.__allowGapEventPublishFromScratchForTests?.(true);
});
afterAll(() => {
  mod.__allowGapEventPublishFromScratchForTests?.(false);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  server.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
});

const gap = (id: string) => ({ type: "substrateGap_write", gap: { id, category: "source_divergence", source: "substrate_detected", status: "open", summary: `publish auth probe ${id}` } });

describe("the gap-written publish is authenticated", () => {
  test("MUST-FAIL: it posts with Authorization: ApiKey <key> and no X-Internal-Api-Key", async () => {
    seen = [];
    delete process.env["SUBSTRATE_API_KEY"];
    process.env["METABOB_API_KEY"] = "mb-test-dev-key";
    await mod.resolveSubstrateGapWrite(gap("publish-auth-probe-a") as never, { vocabulary: null });
    expect(seen.length).toBe(1);
    expect(seen[0]!["authorization"]).toBe("ApiKey mb-test-dev-key");
    expect(seen[0]!["x-internal-api-key"]).toBeUndefined();
  });

  test("MUST-FAIL: with no key it publishes nothing and counts the skip", async () => {
    seen = [];
    for (const k of ["SUBSTRATE_API_KEY", "METABOB_API_KEY", "API_KEY"]) delete process.env[k];
    const before = typeof mod.gapEventPublishSkippedNoKey === "function" ? mod.gapEventPublishSkippedNoKey() : NaN;
    await mod.resolveSubstrateGapWrite(gap("publish-auth-probe-b") as never, { vocabulary: null });
    expect(seen).toEqual([]);
    expect(mod.gapEventPublishSkippedNoKey()).toBe(before + 1);
  });
});
