// THE CALLER-CREDENTIAL GOLDEN TABLE (operator security review, 2026-10-19).
//
// development-vessel owns src/lib/caller-credential.ts; goal-host-vessel carries a byte-for-byte copy
// (src/caller-credential.ts: a header naming the source repo and commit, then the same bytes). The copy is
// named debt until a shared package replaces it. This test is the same in both repos except for the
// constants below, and runs the SAME table (test/fixtures/caller-credential-cases.json, identical in both):
//   - every case's calls, against THIS repo's module, with identity and DNS stood in for;
//   - module_sha256: the table pins the sha256 of the module bytes (after the copy header, in the copy), so
//     an edit to the module reds this side until the table is re-pinned;
//   - sibling parity: where both checkouts sit side by side (the fleet's vessels directory, the super-repo's
//     repos/), the other side's module bytes and table must equal this side's. A re-pin on one side alone
//     reds the other. Where no sibling checkout exists the parity test is SKIPPED, visibly, with a line.
// No case touches the network: globalThis.fetch and dns.promises.lookup are stubbed and anything else fails.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import dns from "node:dns";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MODULE_FILE = join(REPO_ROOT, "src/lib/caller-credential.ts");
const cc = await import("../../src/lib/caller-credential.js");
const { identityCredential, isNodeSelfCredential, __resetCredentialCacheForTests } = cc;
const SIBLING_ROOT = join(REPO_ROOT, "..", "goal-host-vessel");
const SIBLING_MODULE_FILE = join(SIBLING_ROOT, "src/caller-credential.ts");
const SIBLING_TABLE_FILE = join(SIBLING_ROOT, "test", "fixtures", "caller-credential-cases.json");
const TABLE_FILE = join(REPO_ROOT, "test", "fixtures", "caller-credential-cases.json");
/** The copy header ends at this line; every byte after it is the source module. */
const COPY_MARKER = "// --- end of copy header: every byte below this line is the source file, unchanged ---\n";

type Expect = { authenticated: boolean; scopes?: string[]; keyId?: string; node_self?: boolean; why?: string; why_prefix?: string };
type Call = { authorization: string | null; opts?: { cache?: boolean; xApiKeyPresented?: boolean }; expect: Expect };
type Mode = "up" | "down" | "error500" | "unauthenticated200";
type Case = {
  name: string; env: Record<string, string>; identity: Mode;
  dns?: Record<string, Array<{ address: string; family: number }> | "fail">;
  calls: Call[]; then_identity?: Mode; then_calls?: Call[]; expect_identity_calls: number;
};
const table = JSON.parse(readFileSync(TABLE_FILE, "utf8")) as { module_sha256: string; cases: Case[] };

/** The module bytes the table pins: the whole file, or what follows the copy header in the copy. */
function moduleBody(text: string): string {
  const i = text.indexOf(COPY_MARKER);
  return i < 0 ? text : text.slice(i + COPY_MARKER.length);
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const realFetch = globalThis.fetch;
let mode: Mode = "up";
let identityCalls = 0;
let dnsAnswers: NonNullable<Case["dns"]> = {};
let violations: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) { saved[k] = process.env[k]; delete process.env[k]; }
  mode = "up"; identityCalls = 0; dnsAnswers = {}; violations = [];
  __resetCredentialCacheForTests();
  for (const m of ["log", "warn", "error", "info", "debug"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
  spies.push(spyOn(dns.promises, "lookup").mockImplementation((async (host: string) => {
    const a = dnsAnswers[host];
    if (!a || a === "fail") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  }) as never));
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (!u.endsWith("/v1/auth/resolve")) { violations.push(u); throw new TypeError("unexpected network call in test: " + u); }
    identityCalls++;
    if (mode === "down") throw new TypeError("Unable to connect");
    if (mode === "error500") return new Response("boom", { status: 500 });
    const key = String((JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { apiKey?: string } } })?.impulse?.pointer?.apiKey ?? "");
    if (!key.startsWith("golden-valid-")) return Response.json({ success: false, error: "invalid" }, { status: 401 });
    if (mode === "unauthenticated200") return Response.json({ success: true, data: { authenticated: false } });
    return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "golden-key-id", scopes: ["read", "write"] } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(violations).toEqual([]);
});

async function runCall(c: Call): Promise<void> {
  const got = await identityCredential(c.authorization ?? undefined, c.opts ?? {});
  const e = c.expect;
  expect(got.authenticated).toBe(e.authenticated);
  if (e.scopes) expect(got.scopes).toEqual(e.scopes);
  if (e.keyId) expect(got.keyId).toBe(e.keyId);
  if (e.node_self !== undefined) expect(isNodeSelfCredential(got)).toBe(e.node_self);
  if (e.why) expect(got.why).toBe(e.why);
  if (e.why_prefix) expect(String(got.why ?? "").startsWith(e.why_prefix)).toBe(true);
}

describe("caller-credential golden table", () => {
  it("caller-credential-golden the module bytes are the ones the shared table pins", () => {
    expect(sha256(moduleBody(readFileSync(MODULE_FILE, "utf8")))).toBe(table.module_sha256);
  });

  for (const tc of table.cases) {
    it(`caller-credential-golden ${tc.name}`, async () => {
      for (const [k, v] of Object.entries(tc.env)) process.env[k] = v;
      mode = tc.identity;
      dnsAnswers = tc.dns ?? {};
      for (const c of tc.calls) await runCall(c);
      if (tc.then_identity) mode = tc.then_identity;
      for (const c of tc.then_calls ?? []) await runCall(c);
      expect(identityCalls).toBe(tc.expect_identity_calls);
    });
  }

  const siblingPresent = existsSync(SIBLING_MODULE_FILE) && existsSync(SIBLING_TABLE_FILE);
  if (!siblingPresent) process.stdout.write(`[caller-credential-golden] no sibling checkout at ${SIBLING_ROOT}: parity with the other copy is pinned by module_sha256 only\n`);
  it.skipIf(!siblingPresent)("caller-credential-golden sibling parity: the other side's module bytes and table equal this side's", () => {
    expect(sha256(moduleBody(readFileSync(SIBLING_MODULE_FILE, "utf8")))).toBe(sha256(moduleBody(readFileSync(MODULE_FILE, "utf8"))));
    expect(readFileSync(SIBLING_TABLE_FILE, "utf8")).toBe(readFileSync(TABLE_FILE, "utf8"));
  });
});
