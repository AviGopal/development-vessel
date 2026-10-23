// SEVERAL OWNERS, LEASE-SERIALISED (user ruling "(B) Several owners, lease-serialized"; REALIGNMENT §4, law 11).
//
// findComposeOwner admitted exactly one owner: two feature_compose producers whose composeOwnership both listed the
// vessel meant "no owner", and a directed gap for a vessel this node does not run composed here, where its own compose
// refuses it. Under the ruling any listed owner may compose the gap, and the gap-store holder's EXISTING per-gap landing
// lease (substrate-gap.ts LANDING LEASE: decideLandingLease under withGapLock; pinned by gap-landing-lease.test.ts a/b/h
// and compose-landing-lease-admission.test.ts) is what keeps two owners from both landing it. No new lock.
//   [MUST-FAIL] two producers both claim the vessel: both are owners, findComposeOwner admits one of them (the first by
//               vesselId) instead of none. RED at the parent: it returned null (the second owner refused before any
//               landing could be attempted).
//   [MUST-FAIL] the two owners race to land one gap through the landing lease: exactly one is granted and lands; the
//               other is refused held_by the winner while it holds the lease through its landing. (The lease half
//               held at the parent too; what the parent lacked was the second owner's admission above.)
//   [MUST-FAIL] placement by FREE SLOTS: two owners, A full and B free -> B (the free-slot reading check-supply placement
//               uses: each producer's composeOwnership placement.capacity.free). RED at 2fc4f952: the first by vesselId.
//   [CONTROL]   equal free slots -> deterministic, the first by vesselId; an owner whose slots cannot be read -> the same
//               first-by-vesselId fallback (the two-claimant case above has no slot data at all).
//   [CONTROL]   a single owner is unchanged: it is the owner, its acquire is granted, it lands once.
//   [CONTROL]   no owner is unchanged: null.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `several-owners-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "METABOB_API_KEY", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["METABOB_API_KEY"] = `synthetic-node-key-${Math.random().toString(36).slice(2, 10)}`;
delete process.env["GAP_STORE_ENDPOINT"];

const { findComposeOwner } = await import("../../src/judge/gap-admission.js");
const sg = await import("../../src/resolvers/substrate-gap.js");

const VESSEL = "local-tools-vessel";
const GAP = `several-owners-gap-${Math.random().toString(36).slice(2, 8)}`;
const AT = "2026-10-23T08:00:00Z";
type Producer = { vesselId: string; url: string; owns: string[]; free?: number };
let ownershipPointers: Array<Record<string, unknown>> = [];
let producers: Producer[] = [];
const originalFetch = globalThis.fetch;
const origWarn = console.warn;
const origLog = console.log;
const storeFile = (): string => join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
const row = { id: GAP, category: "systematic_failure", source: "operator", summary: `fixture ${GAP}: ${VESSEL} src/widget.ts`, detected_at: AT, status: "open", classification_metadata: { falsifier: "class2", edit_site: `repos/${VESSEL}/src/widget.ts` }, created_at: AT, updated_at: AT };
const stored = (): Record<string, any> => (JSON.parse(readFileSync(storeFile(), "utf8")) as Array<Record<string, any>>).find((r) => r.id === GAP)!;

beforeAll(() => {
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      return Response.json({ content: { vessels: producers.map((p) => ({ vesselId: p.vesselId, endpoint: p.url, resolve_endpoint: `${p.url}/v2/impulses/resolve` })) } });
    }
    const p = producers.find((x) => url.startsWith(x.url));
    if (p && body?.impulse?.pointer?.type === "composeOwnership") {
      ownershipPointers.push(body.impulse.pointer);
      // A producer with slot data answers the placement query as compose-placement's composePlacementAnswer does.
      const placement = p.free === undefined ? {} : { placement: { armed: false, capacity: { free: p.free, live: p.free > 0 ? 0 : 1, cap: Math.max(1, p.free) }, scope_readable: true, scope_excludes: [], gap_row_visible: null } };
      return Response.json({ success: true, shape: "composeOwnership", body: { node: p.vesselId, owned_repos: p.owns, ...placement } });
    }
    return new Response("unexpected", { status: 400 });
  }) as unknown as typeof fetch;
  console.warn = () => {};
  console.log = () => {};
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.warn = origWarn;
  console.log = origLog;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { producers = []; ownershipPointers = []; writeFileSync(storeFile(), JSON.stringify([row])); });

/** One owner's landing attempt, as feature_compose takes it: the gap's lease first; granted, it lands (and holds the
 *  lease through its cutover, which releases it at the outcome); refused, it does not land. */
async function attemptLanding(owner: string, landings: string[]): Promise<{ granted?: boolean; held_by?: string }> {
  const r = await sg.resolveSubstrateGapLease({ type: "substrateGapLease_write", action: "acquire", gap_id: GAP, holder: owner, attempt: `${owner}-attempt` });
  const v = (r.body ?? {}) as { granted?: boolean; held_by?: string };
  if (v.granted) landings.push(owner);
  return v;
}

describe("several owners of one vessel: admitted, and serialised by the landing lease", () => {
  it("[MUST-FAIL] two producers both claim the vessel: findComposeOwner admits one of them (the first by vesselId), not none", async () => {
    producers = [
      { vesselId: "owner-b", url: "http://127.0.0.1:18972", owns: [VESSEL] },
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL] },
    ];
    const owner = await findComposeOwner(VESSEL);
    expect(owner?.vesselId).toBe("owner-a");
    expect(owner?.url).toBe("http://127.0.0.1:18971/v2/impulses/resolve");
  });

  it("[MUST-FAIL] the two owners race to land one gap: exactly one lands, the other is refused held_by the winner", async () => {
    producers = [
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL] },
      { vesselId: "owner-b", url: "http://127.0.0.1:18972", owns: [VESSEL] },
    ];
    // both are owners (each producer's own composeOwnership lists the vessel), and one is admitted
    expect(await findComposeOwner(VESSEL)).not.toBeNull();
    const landings: string[] = [];
    const [a, b] = await Promise.all([attemptLanding("owner-a", landings), attemptLanding("owner-b", landings)]);
    expect(landings.length).toBe(1);
    const winner = landings[0]!;
    const loser = winner === "owner-a" ? b : a;
    expect(loser.granted).toBe(false);
    expect(loser.held_by).toBe(winner);
    expect(stored().classification_metadata.landing_lease.holder).toBe(winner);
    // the loser trying again while the winner's landing holds the lease still does not land
    await attemptLanding(winner === "owner-a" ? "owner-b" : "owner-a", landings);
    expect(landings).toEqual([winner]);
  });

  it("[MUST-FAIL] placement by free slots: owner A full, owner B free -> B", async () => {
    producers = [
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL], free: 0 },
      { vesselId: "owner-b", url: "http://127.0.0.1:18972", owns: [VESSEL], free: 2 },
    ];
    expect((await findComposeOwner(VESSEL))?.vesselId).toBe("owner-b");
    // the read is the placement query (its targets), so each producer answers its own free slots
    expect(ownershipPointers.every((p) => Array.isArray(p["targets"]))).toBe(true);
  });

  it("[CONTROL] equal free slots -> the first by vesselId; an owner whose slots cannot be read -> the same fallback", async () => {
    producers = [
      { vesselId: "owner-b", url: "http://127.0.0.1:18972", owns: [VESSEL], free: 1 },
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL], free: 1 },
    ];
    expect((await findComposeOwner(VESSEL))?.vesselId).toBe("owner-a");
    producers = [
      { vesselId: "owner-b", url: "http://127.0.0.1:18972", owns: [VESSEL], free: 3 },
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL] },
    ];
    expect((await findComposeOwner(VESSEL))?.vesselId).toBe("owner-a");
  });

  it("[CONTROL] a single owner is unchanged: it is the owner, its acquire is granted, it lands once", async () => {
    producers = [
      { vesselId: "owner-a", url: "http://127.0.0.1:18971", owns: [VESSEL] },
      { vesselId: "bystander", url: "http://127.0.0.1:18973", owns: ["some-other-vessel"] },
    ];
    expect((await findComposeOwner(VESSEL))?.vesselId).toBe("owner-a");
    const landings: string[] = [];
    expect((await attemptLanding("owner-a", landings)).granted).toBe(true);
    expect(landings).toEqual(["owner-a"]);
  });

  it("[CONTROL] no owner is unchanged: null", async () => {
    producers = [{ vesselId: "bystander", url: "http://127.0.0.1:18973", owns: ["some-other-vessel"] }];
    expect(await findComposeOwner(VESSEL)).toBeNull();
  });
});
