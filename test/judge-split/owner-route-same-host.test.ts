// THE DIRECTED-OWNER FORWARD GOES ONLY TO A HOST ON THIS MACHINE (user ruling "same-host peers only";
// self-auth.ts crossNodeKeyHeaders). A directed gap for a vessel another node owns is forwarded, WITH this node's key,
// to the one owner findComposeOwner names. An owner whose endpoint is not on this machine is never asked for its
// ownership and never sent the pointer: no single owner is found, so the gap composes here, and one line names the
// host (never the key). Same harness and fixtures as pin-owner-route.test.ts.
//
//   [MUST-FAIL] the only claimant is off-host: no ownership read, no forward, composes here (before: forwarded there).
//   [CONTROL]   the same claimant on a loopback port is forwarded to, as pin-owner-route pins.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, route, hitsOf, calls, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const OWNED = `showned-${RUN}`;
const OTHER = `shother-${RUN}`;
let savedRoot: string | undefined;
let savedName: string | undefined;
function ownClones(...owned: string[]): void {
  const root = mkdtempSync(join(tmpdir(), "judge-same-host-own-"));
  for (const v of owned) mkdirSync(join(root, v, ".git"), { recursive: true });
  process.env["VESSELS_CLONE_ROOT"] = root;
}
function routeOwner(endpoint: string): void {
  route({
    name: "discovery feature_compose",
    match: (_u, b) => b?.pointer?.type === "vesselCapability" && b.pointer.shape === "feature_compose",
    respond: () => Response.json({ content: { shape: "feature_compose", vessels: [{ vesselId: "owner-node", endpoint, resolve_endpoint: "/v2/impulses/resolve" }], found: true } }),
  });
  route({ name: "ownership owner-node", match: (u, b) => u.startsWith(endpoint) && b?.impulse?.pointer?.type === "composeOwnership", respond: () => Response.json({ shape: "composeOwnership", body: { owned_repos: [OTHER] } }) });
  route({ name: "forward owner-node", match: (u, b) => u.startsWith(endpoint) && b?.impulse?.pointer?.type !== "composeOwnership", respond: () => Response.json({ shape: "gapToFeatureReport", body: { ok: true, verdict: "FORWARDED_FIXTURE", from: "owner-node" } }) });
}
const gapAt = (tag: string): string => {
  const id = `same-host-owner-${tag}-${RUN}`;
  seed({ id, classification_metadata: { falsifier: "class2", edit_site: `repos/${OTHER}/src/site.ts` } });
  return id;
};
const directed = (id: string) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, dry_run: true } as never));

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

describe("the directed-owner forward carries the node key only to this host", () => {
  it("[MUST-FAIL] the only claimant is off-host: never asked, never forwarded to; composes here", async () => {
    ownClones(OWNED);
    const id = gapAt("offhost");
    routeOwner("http://203.0.113.11:8090");
    const { result, lines } = await directed(id);
    expect(hitsOf("ownership owner-node").length).toBe(0);
    expect(hitsOf("forward owner-node").length).toBe(0);
    expect(lines).toContain("[cross-node-key] refused non-local 203.0.113.11");
    expect(lines).toContain(`[gap-to-feature] directed ${id}: ${OTHER} is not owned here and no single owner was found; composing here`);
    expect((result.body as Row).routed_to).toBeUndefined();
    expect(calls.compose.length).toBe(1);
  });

  it("[CONTROL] the same claimant on a loopback port is asked and forwarded to", async () => {
    ownClones(OWNED);
    const id = gapAt("loopback");
    routeOwner("http://127.0.0.1:18971");
    const { result } = await directed(id);
    expect(hitsOf("ownership owner-node").length).toBe(1);
    expect(hitsOf("forward owner-node").length).toBe(1);
    expect(result.body).toEqual({ ok: true, verdict: "FORWARDED_FIXTURE", from: "owner-node", routed_to: "owner-node" });
    expect(calls.compose.length).toBe(0);
  });
});
