// BEHAVIOUR PIN: ownership forwarding of a directed gap (judge split, extraction `directedOwnerRoute`, RECOUNT
// uncovered #8). A targeted pointer (gap_id) that was not itself forwarded, for a gap whose vessel this node does not
// own (it owns at least one), asks discovery for the feature_compose producers and each for its composeOwnership.
// Exactly one claimant gets the pointer forwarded with forwarded_from, and its answer is returned with routed_to.
// Zero or several claimants mean the gap composes here. An owned vessel, a forwarded pointer, or an empty owned set
// never forwards.
//
// Driven through resolveGapToFeature with a stored row and a fixture clone root (owned set = clones with .git);
// asserted on the requests made, the forwarded pointer, the report, the store writes and whether compose ran.
// Written against the tree before the extraction; it must hold after it.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, writesFor, route, hitsOf, calls, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const OWNED = `pinowned-${RUN}`;
const OTHER = `pinother-${RUN}`;
// Captured after beginPin (which applies the harness env), so each test restores what the harness set.
let savedRoot: string | undefined;
let savedName: string | undefined;
/** A clone root owning `owned` (a .git dir is what ownedVessels reads). */
function ownClones(...owned: string[]): void {
  const root = mkdtempSync(join(tmpdir(), "judge-pin-own-"));
  for (const v of owned) mkdirSync(join(root, v, ".git"), { recursive: true });
  process.env["VESSELS_CLONE_ROOT"] = root;
}
type Producer = { vesselId: string; endpoint: string; owns: string[]; forwardAnswer?: Row | "throw" };
function routeProducers(producers: Producer[]): void {
  route({
    name: "discovery feature_compose",
    match: (_u, b) => b?.pointer?.type === "vesselCapability" && b.pointer.shape === "feature_compose",
    respond: () => Response.json({ content: { shape: "feature_compose", vessels: producers.map((p) => ({ vesselId: p.vesselId, endpoint: p.endpoint, resolve_endpoint: "/v2/impulses/resolve" })), found: producers.length > 0 } }),
  });
  for (const p of producers) {
    route({
      name: `ownership ${p.vesselId}`,
      match: (u, b) => u.startsWith(p.endpoint) && b?.impulse?.pointer?.type === "composeOwnership",
      respond: () => Response.json({ shape: "composeOwnership", body: { owned_repos: p.owns } }),
    });
    route({
      name: `forward ${p.vesselId}`,
      match: (u, b) => u.startsWith(p.endpoint) && b?.impulse?.pointer?.type !== "composeOwnership",
      respond: () => {
        if (p.forwardAnswer === "throw") throw new TypeError("pin: owner unreachable");
        return Response.json(p.forwardAnswer ?? { shape: "gapToFeatureReport", body: { ok: true, verdict: "FORWARDED_FIXTURE", from: p.vesselId } });
      },
    });
  }
}
const gapAt = (tag: string, vessel: string): string => {
  const id = `pin-owner-${tag}-${RUN}`;
  seed({ id, classification_metadata: { falsifier: "class2", edit_site: `repos/${vessel}/src/site.ts` } });
  return id;
};
const directed = (id: string, extra: Row = {}) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, dry_run: true, ...extra } as never));

beforeEach(() => {
  beginPin();
  savedRoot = process.env["VESSELS_CLONE_ROOT"];
  savedName = process.env["SUBSTRATE_NAME"];
  delete process.env["SUBSTRATE_NAME"];
  for (const v of [OWNED, OTHER]) {
    mkdirSync(join(SCRATCH, "runtime", v, "src"), { recursive: true });
    writeFileSync(join(SCRATCH, "runtime", v, "src", "site.ts"), "export const site = 1;\n");
  }
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = savedRoot;
  if (savedName === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = savedName;
  expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] });
});
afterAll(() => restoreHarness());

describe("a directed gap for a vessel another node owns is forwarded to that one owner", () => {
  it("[PIN] one claimant: the pointer is forwarded with forwarded_from, its answer returned with routed_to; nothing composed or written here", async () => {
    ownClones(OWNED);
    const id = gapAt("one-owner", OTHER);
    routeProducers([
      { vesselId: "owner-node", endpoint: "http://owner.judge-pin", owns: [OTHER] },
      { vesselId: "bystander-node", endpoint: "http://bystander.judge-pin", owns: [OWNED] },
    ]);
    const { result, lines } = await directed(id, { model: "pin-model" });
    expect(result.shape).toBe("gapToFeatureReport");
    expect(result.body).toEqual({ ok: true, verdict: "FORWARDED_FIXTURE", from: "owner-node", routed_to: "owner-node" });
    const fwd = hitsOf("forward owner-node");
    expect(fwd.length).toBe(1);
    expect(fwd[0]!.url).toBe("http://owner.judge-pin/v2/impulses/resolve");
    expect(fwd[0]!.body).toEqual({ impulse: { pointer: { type: "gap_to_feature", gap_id: id, dry_run: true, model: "pin-model", forwarded_from: "substrate" } } });
    expect(hitsOf("forward bystander-node").length).toBe(0);
    expect(hitsOf("ownership owner-node").length).toBe(1);
    expect(hitsOf("ownership bystander-node").length).toBe(1);
    expect(lines).toContain(`[gap-to-feature] directed ${id} routed by ownership → owner-node (${OTHER} is not owned here)`);
    expect(calls.compose.length).toBe(0);
    expect(writesFor(id)).toEqual([]);
    expect(stored(id)!.status).toBe("open");
  });

  it("[PIN] forwarded_from names SUBSTRATE_NAME when set", async () => {
    ownClones(OWNED);
    process.env["SUBSTRATE_NAME"] = "pin-node-1";
    const id = gapAt("named", OTHER);
    routeProducers([{ vesselId: "owner-node", endpoint: "http://owner.judge-pin", owns: [OTHER] }]);
    await directed(id);
    expect(hitsOf("forward owner-node")[0]!.body.impulse.pointer.forwarded_from).toBe("pin-node-1");
  });

  it("[PIN] the forward fails: a route-stage error report naming the owner; nothing composed", async () => {
    ownClones(OWNED);
    const id = gapAt("fwd-fails", OTHER);
    routeProducers([{ vesselId: "owner-node", endpoint: "http://owner.judge-pin", owns: [OTHER], forwardAnswer: "throw" }]);
    const { result } = await directed(id);
    expect(result.body).toEqual({ ok: false, stage: "route", gap_id: id, routed_to: "owner-node", error: "forward to owner failed: pin: owner unreachable" });
    expect(calls.compose.length).toBe(0);
    expect(writesFor(id)).toEqual([]);
  });

  for (const [tag, owners] of [["no-claimant", 0], ["two-claimants", 2]] as const) {
    it(`[PIN] ${tag}: composes here, with the "no single owner" line`, async () => {
      ownClones(OWNED);
      const id = gapAt(tag, OTHER);
      routeProducers(owners === 0
        ? [{ vesselId: "bystander-node", endpoint: "http://bystander.judge-pin", owns: [OWNED] }]
        : [{ vesselId: "a-node", endpoint: "http://a.judge-pin", owns: [OTHER] }, { vesselId: "b-node", endpoint: "http://b.judge-pin", owns: [OTHER] }]);
      const { result, lines } = await directed(id);
      expect(lines).toContain(`[gap-to-feature] directed ${id}: ${OTHER} is not owned here and no single owner was found; composing here`);
      expect(hitsOf("discovery feature_compose").length).toBe(1);
      expect(net_forwards()).toBe(0);
      expect(calls.compose.length).toBe(1);
      expect((result.body as Row).routed_to).toBeUndefined();
      expect((result.body as Row).verdict).toBe("BUSY");
    });
  }

  for (const [tag, setup, extra] of [
    ["owned-target", () => ownClones(OWNED, OTHER), {}],
    ["already-forwarded", () => ownClones(OWNED), { forwarded_from: "pin-peer" }],
    ["owned-set-empty", () => ownClones(), {}],
  ] as const) {
    it(`[PIN] ${tag}: no ownership lookup, no forward; composes here`, async () => {
      (setup as () => void)();
      const id = gapAt(tag, OTHER);
      routeProducers([{ vesselId: "owner-node", endpoint: "http://owner.judge-pin", owns: [OTHER] }]);
      const { result, lines } = await directed(id, extra as Row);
      expect(hitsOf("discovery feature_compose").length).toBe(0);
      expect(net_forwards()).toBe(0);
      expect(lines.some((l) => l.includes("routed by ownership") || l.includes("no single owner"))).toBe(false);
      expect(calls.compose.length).toBe(1);
      expect((result.body as Row).verdict).toBe("BUSY");
    });
  }
});

function net_forwards(): number {
  return ["owner-node", "a-node", "b-node", "bystander-node"].reduce((s, v) => s + hitsOf(`forward ${v}`).length, 0);
}
