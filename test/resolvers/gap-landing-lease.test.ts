// ONE LANDING LEASE PER GAP, HELD AT THE GAP-STORE HOLDER (check-first, 2026-10-08).
//
// Measured 2026-10-07: node1 landed 214f9fbd and compose2 landed c1a1ed7f for gap
// gap-check-supply-dispatches-oldest-first-… 75 s apart, the second replacing the first. Every
// coordination primitive was node-local (compose slots, composeInFlight, gap-to-feature's maps, the
// maintenance-lease file). compose2 forwards its gap reads and writes to node1's store
// (GAP_STORE_ENDPOINT), so both nodes share ONE store holder, and an op serialized there is a fleet lease.
//
// CONTRACT pinned here (substrateGapLease_write on the holder; two nodes = two holder identities):
//   (a) A acquires -> granted; B acquires the same gap -> refused, held_by A;
//   (b) after A releases, B acquires -> granted;
//   (c) an expired A lease -> B granted;
//   (d) A re-acquiring its own lease -> granted (idempotent);
//   (e) a non-holder node whose forward to the holder FAILS -> {granted:false, unknown:true} (abstain);
//   (f) a non-holder node whose forward reaches the holder gets the holder's verdict (B refused, held_by A);
//   (g) the lease persists on the row (classification_metadata.landing_lease) and a substrateGap_write that
//       echoes a stale metadata snapshot can neither clear nor re-plant it;
//   (h) concurrent acquires by two nodes: exactly one is granted (serialized at the holder).
// Red at base 2738dbf5: substrateGapLease_write does not exist.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gap-landing-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"gap-landing-lease-isolated"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const STORE = join(ROOT, "gaps", "gaps.json");
const GAP = "lease-fixture-gap";
const AT = "2026-10-07T10:00:00Z";
const NODE_A = "node-a";
const NODE_B = "node-b";
const HOLDER_EP = "http://gap-store-holder.fixture/v2/impulses/resolve";

type Verdict = { granted?: boolean; unknown?: boolean; held_by?: string; until?: string; released?: boolean; reason?: string };
const row = (meta: Record<string, unknown> = {}) => ({ id: GAP, category: "systematic_failure", source: "operator_narration", summary: `fixture ${GAP}`, detected_at: AT, status: "open", classification_metadata: meta, created_at: AT, updated_at: AT });
const stored = (): Record<string, any> => (JSON.parse(readFileSync(STORE, "utf8")) as Array<Record<string, any>>).find((r) => r.id === GAP)!;
const lease = async (action: string, holder: string, extra: Record<string, unknown> = {}) => {
  const r = await sg.resolveSubstrateGapLease({ type: "substrateGapLease_write", action, gap_id: GAP, holder, attempt: `${holder}-attempt`, ...extra });
  return { shape: r.shape as string, body: (r.body ?? {}) as Verdict };
};

const originalFetch = globalThis.fetch;
let savedEndpoint: string | undefined;
beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  writeFileSync(STORE, JSON.stringify([row()]));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

/** This process plays a NON-holder: GAP_STORE_ENDPOINT names the holder, whose route runs the holder's op. */
function becomeNonHolder(answer: (pointer: Record<string, unknown>) => Promise<Response>): string[] {
  const seen: string[] = [];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER_EP;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (url !== HOLDER_EP) throw new Error(`unexpected fetch ${url}`);
    const pointer = (JSON.parse(String(init?.body ?? "{}")).impulse?.pointer ?? {}) as Record<string, unknown>;
    seen.push(String(pointer["type"]));
    return answer(pointer);
  }) as typeof fetch;
  return seen;
}
/** The holder answering in-process: the same op with GAP_STORE_ENDPOINT unset (it holds the store). */
async function holderAnswers(pointer: Record<string, unknown>): Promise<Response> {
  const ep = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try {
    const r = await sg.resolveSubstrateGapLease(pointer);
    return Response.json({ success: true, shape: r.shape, body: r.body });
  } finally { process.env["GAP_STORE_ENDPOINT"] = ep; }
}

describe("substrateGapLease_write: one landing lease per gap at the gap-store holder", () => {
  it("[MUST-FAIL a] node A acquires -> granted; node B acquires the same gap -> refused, held_by A", async () => {
    const a = await lease("acquire", NODE_A);
    expect(a.shape).toBe("substrateGapLease");
    expect(a.body.granted).toBe(true);
    const b = await lease("acquire", NODE_B);
    expect(b.body.granted).toBe(false);
    expect(b.body.unknown ?? false).toBe(false);
    expect(b.body.held_by).toBe(NODE_A);
  });

  it("[MUST-FAIL b] after A releases, B acquires -> granted", async () => {
    expect((await lease("acquire", NODE_A)).body.granted).toBe(true);
    expect((await lease("acquire", NODE_B)).body.granted).toBe(false);
    const rel = await lease("release", NODE_A);
    expect(rel.body.released).toBe(true);
    expect((await lease("acquire", NODE_B)).body.granted).toBe(true);
  });

  it("[MUST-FAIL b'] a release by a node that does not hold the lease clears nothing", async () => {
    expect((await lease("acquire", NODE_A)).body.granted).toBe(true);
    expect((await lease("release", NODE_B)).body.released).toBe(false);
    const b = await lease("acquire", NODE_B);
    expect(b.body.granted).toBe(false);
    expect(b.body.held_by).toBe(NODE_A);
  });

  it("[MUST-FAIL c] an EXPIRED A lease -> B granted", async () => {
    writeFileSync(STORE, JSON.stringify([row({ landing_lease: { holder: NODE_A, attempt: "old", acquired_at: "2026-10-07T07:00:00Z", until: "2026-10-07T09:00:00Z" } })]));
    const b = await lease("acquire", NODE_B);
    expect(b.body.granted).toBe(true);
    expect(stored().classification_metadata.landing_lease.holder).toBe(NODE_B);
  });

  it("[MUST-FAIL d] A re-acquiring its own lease -> granted (idempotent), and the until is extended", async () => {
    const first = await lease("acquire", NODE_A, { ttl_ms: 60_000 });
    expect(first.body.granted).toBe(true);
    const again = await lease("acquire", NODE_A);
    expect(again.body.granted).toBe(true);
    expect(Date.parse(String(again.body.until))).toBeGreaterThan(Date.parse(String(first.body.until)));
  });

  it("[MUST-FAIL e] a non-holder node whose forward to the holder FAILS abstains: {granted:false, unknown:true}", async () => {
    const seen = becomeNonHolder(async () => { throw new Error("connection refused"); });
    const b = await lease("acquire", NODE_B);
    expect(seen).toEqual(["substrateGapLease_write"]);
    expect(b.body.granted).toBe(false);
    expect(b.body.unknown).toBe(true);
  });

  it("[MUST-FAIL e'] a non-holder whose holder answers something that is not a lease verdict abstains too", async () => {
    becomeNonHolder(async () => Response.json({ success: false, shape: "structuredError", body: { detail: "unknown shape: substrateGapLease_write" } }, { status: 400 }));
    const b = await lease("acquire", NODE_B);
    expect(b.body.granted).toBe(false);
    expect(b.body.unknown).toBe(true);
  });

  it("[MUST-FAIL f] a non-holder whose forward reaches the holder gets the holder's verdict: B refused while A holds it", async () => {
    expect((await lease("acquire", NODE_A)).body.granted).toBe(true);
    const seen = becomeNonHolder(holderAnswers);
    const b = await lease("acquire", NODE_B);
    expect(seen).toEqual(["substrateGapLease_write"]);
    expect(b.body.granted).toBe(false);
    expect(b.body.unknown ?? false).toBe(false);
    expect(b.body.held_by).toBe(NODE_A);
  });

  it("[MUST-FAIL g] the lease persists on the row, and a substrateGap_write echoing a stale snapshot neither clears nor re-plants it", async () => {
    expect((await lease("acquire", NODE_A)).body.granted).toBe(true);
    const held = stored().classification_metadata.landing_lease;
    expect(held.holder).toBe(NODE_A);
    expect(typeof held.until).toBe("string");
    // A writer that read the row BEFORE the acquire writes back metadata with no lease key -> carried forward.
    // One that writes an explicit other lease -> ignored: only the lease op sets it.
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...row({ landing_lease: { holder: NODE_B, attempt: "forged", acquired_at: AT, until: "2099-01-01T00:00:00Z" } }) } }, { vocabulary: null });
    expect(w.shape).not.toBe("structuredError");
    expect(stored().classification_metadata.landing_lease).toEqual(held);
    // After the release, a writer echoing the snapshot that still carries A's lease does not re-plant it.
    expect((await lease("release", NODE_A)).body.released).toBe(true);
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...row({ landing_lease: held }) } }, { vocabulary: null });
    expect(stored().classification_metadata.landing_lease).toBeUndefined();
    expect((await lease("acquire", NODE_B)).body.granted).toBe(true);
  });

  it("[MUST-FAIL h] two nodes acquiring concurrently: exactly one is granted", async () => {
    const [a, b] = await Promise.all([lease("acquire", NODE_A), lease("acquire", NODE_B)]);
    expect([a.body.granted, b.body.granted].filter(Boolean).length).toBe(1);
    const winner = a.body.granted ? NODE_A : NODE_B;
    expect(stored().classification_metadata.landing_lease.holder).toBe(winner);
  });

  it("[CONTROL] an acquire does not touch the row's updated_at (supply order reads recency)", async () => {
    expect((await lease("acquire", NODE_A)).body.granted).toBe(true);
    expect(stored().updated_at).toBe(AT);
  });
});
