// pool_record_pin pins the autonomyScope and the spendEnvelope on EVERY node of the substrate, so a node's copy
// is asserted equal to the operator-seeded value each tick and drift (a path added to or removed from one node's
// scope, a cap or a pause changed) is a filed divergence. The instrument is the one 70ed3ee added for
// substrateNodes; these rows use its object form (named body fields, the reason text not compared).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = mkdtempSync(join(tmpdir(), "pool-pin-policy-"));
const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { evaluateSelfFactRow, __setPoolPinDepsForTests, pinFieldDiff } = sfr;

const N1 = "c951b44f4a99";
const N2 = "compose2";
const CORE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const DIR = "repos/discovery-vessel/";
const PATHS = [CORE, DIR, "scripts/substrate/"];
const scopePin = { excluded_paths: PATHS, require_falsifier_classes: ["class2"] };
const envelopePin = { usd_cap_per_hour: 2, paused: false };
const scopeRow = (pins: Record<string, unknown>): sfr.SelfFactRow => ({
  id: "autonomy_scope_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts",
  must_fail: "a planted path and class must be reported", pool_shape: "autonomyScope", expected_by_node: pins as never, nodes: [N1, N2],
});
const envelopeRow = (pins: Record<string, unknown>): sfr.SelfFactRow => ({
  id: "spend_envelope_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts",
  must_fail: "a perturbed cap and pause must be reported", pool_shape: "spendEnvelope", expected_by_node: pins as never, nodes: [N1, N2],
});
// Each node's own pool copy, as that node's readNewest would return it.
let copies: Record<string, Record<string, { id?: string; updated_at?: string; body?: unknown } | null>> = {};
const asNode = async <T>(node: string, f: () => Promise<T>): Promise<T> => {
  const prev = process.env["SUBSTRATE_NAME"];
  process.env["SUBSTRATE_NAME"] = node;
  __setPoolPinDepsForTests({ readNewest: async (shape) => copies[node]?.[shape] ?? null });
  try { return await f(); } finally { if (prev === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = prev; }
};
const real = (r: sfr.SelfFactResult | null) => (r?.divergences ?? []).filter((d) => !d.canary);
const canaries = (r: sfr.SelfFactResult | null) => (r?.divergences ?? []).filter((d) => d.canary);
const scopeRec = (paths: string[], extra: Record<string, unknown> = {}) => ({ id: "autonomy-scope", updated_at: "2026-10-01T11:54:08Z", body: { reason: "stage 1", excluded_paths: paths, require_falsifier_classes: ["class2"], ...extra } });
const envRec = (body: Record<string, unknown>) => ({ id: "spend-envelope", updated_at: "2026-10-01T11:54:08Z", body: { reason: "operator", ...body } });

afterEach(() => { __setPoolPinDepsForTests(null); copies = {}; });

describe("autonomyScope pinned on every node", () => {
  it("both nodes holding the pinned value read clean, and each node's run reports its own canary", async () => {
    copies = { [N1]: { autonomyScope: scopeRec(PATHS) }, [N2]: { autonomyScope: scopeRec([...PATHS].reverse(), { reason: "a different reason text" }) } };
    const row = scopeRow({ [N1]: scopePin, [N2]: scopePin });
    for (const node of [N1, N2]) {
      const r = await asNode(node, () => evaluateSelfFactRow(row));
      expect(r?.source_read).toBe(true);
      expect(real(r)).toEqual([]);
      const c = canaries(r);
      expect(c.length).toBe(1);
      expect(c[0]!.node).toBe(node);
      expect(c[0]!.detail).toContain(`on node ${node}`);
    }
  });

  it("MUST-FAIL: an excluded path ADDED on node 2 only is a mismatch on node 2 naming the path; node 1 stays clean", async () => {
    const ROGUE = "repos/boredom-vessel/src/index.ts";
    copies = { [N1]: { autonomyScope: scopeRec(PATHS) }, [N2]: { autonomyScope: scopeRec([...PATHS, ROGUE]) } };
    const row = scopeRow({ [N1]: scopePin, [N2]: scopePin });
    expect(real(await asNode(N1, () => evaluateSelfFactRow(row)))).toEqual([]);
    const d = real(await asNode(N2, () => evaluateSelfFactRow(row)));
    expect(d.map((x) => x.key)).toEqual([`${N2}-mismatch`]);
    expect(d[0]!.detail).toContain(`excluded_paths: added [${ROGUE}], removed []`);
  });

  it("MUST-FAIL: an excluded path REMOVED on node 1 only is a mismatch on node 1", async () => {
    copies = { [N1]: { autonomyScope: scopeRec([CORE, "scripts/substrate/"]) }, [N2]: { autonomyScope: scopeRec(PATHS) } };
    const row = scopeRow({ [N1]: scopePin, [N2]: scopePin });
    const d = real(await asNode(N1, () => evaluateSelfFactRow(row)));
    expect(d.map((x) => x.key)).toEqual([`${N1}-mismatch`]);
    expect(d[0]!.detail).toContain(`removed [${DIR}]`);
    expect(real(await asNode(N2, () => evaluateSelfFactRow(row)))).toEqual([]);
  });

  it("a directory entry turned into a file entry (trailing slash dropped) is drift: path sets are never URL-normalised", async () => {
    copies = { [N1]: { autonomyScope: scopeRec([CORE, "repos/discovery-vessel", "scripts/substrate/"]) } };
    const d = real(await asNode(N1, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin }))));
    expect(d.map((x) => x.key)).toEqual([`${N1}-mismatch`]);
  });

  it("require_falsifier_classes drift is a mismatch; the record turned unrestricted is a mismatch", async () => {
    copies = { [N1]: { autonomyScope: scopeRec(PATHS, { require_falsifier_classes: ["class1", "class2"] }) } };
    expect(real(await asNode(N1, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin })))).map((x) => x.key)).toEqual([`${N1}-mismatch`]);
    copies = { [N1]: { autonomyScope: { id: "autonomy-scope", body: { unrestricted: true } } } };
    const d = real(await asNode(N1, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin }))));
    expect(d.map((x) => x.key)).toEqual([`${N1}-mismatch`]);
    expect(d[0]!.detail).toContain("excluded_paths: expected a set of 3");
  });

  it("a node that holds no scope record is a missing divergence", async () => {
    copies = { [N2]: {} };
    const d = real(await asNode(N2, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin, [N2]: scopePin }))));
    expect(d.map((x) => x.key)).toEqual([`${N2}-missing`]);
  });

  it("MUST-FAIL: a node HOLDING autonomyScope with no pinned value is unpinned (an unguarded trust root), never skipped", async () => {
    copies = { [N2]: { autonomyScope: scopeRec(PATHS) } };
    const r = await asNode(N2, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin })));
    expect(r?.source_read).toBe(true);
    expect(real(r).map((x) => x.key)).toEqual([`${N2}-unpinned`]);
  });

  it("a node holding NO autonomyScope record and no pinned value is not judged (unobserved), never clean", async () => {
    copies = { [N2]: {} };
    const r = await asNode(N2, () => evaluateSelfFactRow(scopeRow({ [N1]: scopePin })));
    expect(r?.source_read).toBe(false);
  });
});

describe("spendEnvelope pinned on every node", () => {
  it("the pinned cap and pause read clean on both nodes (reason text not compared), with a canary per node", async () => {
    copies = { [N1]: { spendEnvelope: envRec({ usd_cap_per_hour: 2, paused: false }) }, [N2]: { spendEnvelope: envRec({ usd_cap_per_hour: 2, paused: false, reason: "copied to node 2" }) } };
    const row = envelopeRow({ [N1]: envelopePin, [N2]: envelopePin });
    for (const node of [N1, N2]) {
      const r = await asNode(node, () => evaluateSelfFactRow(row));
      expect(real(r)).toEqual([]);
      expect(canaries(r).map((c) => c.node)).toEqual([node]);
    }
  });

  it("MUST-FAIL: a raised cap on one node, or a pause lifted, is a mismatch", async () => {
    copies = { [N2]: { spendEnvelope: envRec({ usd_cap_per_hour: 50, paused: false }) } };
    const d = real(await asNode(N2, () => evaluateSelfFactRow(envelopeRow({ [N2]: envelopePin }))));
    expect(d.map((x) => x.key)).toEqual([`${N2}-mismatch`]);
    expect(d[0]!.detail).toContain("usd_cap_per_hour: expected 2, found 50");
    copies = { [N1]: { spendEnvelope: envRec({ usd_cap_per_hour: 2, paused: false }) } };
    const p = real(await asNode(N1, () => evaluateSelfFactRow(envelopeRow({ [N1]: { usd_cap_per_hour: 2, paused: true } }))));
    expect(p[0]!.detail).toContain("paused: expected true, found false");
  });

  it("an envelope turned uncapped (cap removed) is a mismatch against a pinned cap", async () => {
    copies = { [N1]: { spendEnvelope: envRec({ uncapped: true, paused: false }) } };
    const d = real(await asNode(N1, () => evaluateSelfFactRow(envelopeRow({ [N1]: envelopePin }))));
    expect(d[0]!.detail).toContain("usd_cap_per_hour: expected 2, found null");
  });
});

describe("pinFieldDiff", () => {
  it("compares sets exactly, scalars by equality, and ignores fields not pinned", () => {
    expect(pinFieldDiff({ a: ["x", "y"], n: 2 }, { a: ["y", "x"], n: 2, reason: "anything" })).toEqual([]);
    expect(pinFieldDiff({ a: ["x"] }, { a: ["x", "z"] })).toEqual(["a: added [z], removed []"]);
    expect(pinFieldDiff({ n: 2 }, { n: "2" })).toEqual(['n: expected 2, found "2"']);
    expect(pinFieldDiff({ n: null }, {})).toEqual([]);
  });
});

describe("the substrateNodes row keeps its list form", () => {
  it("a string-array pin still compares body_field as an endpoint set (trailing slash normalised)", async () => {
    copies = { [N1]: { substrateNodes: { id: "substrate-nodes", body: { discovery_endpoints: ["http://host.containers.internal:18100/", "http://host.containers.internal:26100"] } } } };
    const row: sfr.SelfFactRow = { id: "substrate_nodes_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: "x", must_fail: "x", pool_shape: "substrateNodes", body_field: "discovery_endpoints", expected_by_node: { [N1]: ["http://host.containers.internal:18100", "http://host.containers.internal:26100"] } };
    const r = await asNode(N1, () => evaluateSelfFactRow(row));
    expect(real(r)).toEqual([]);
    expect(canaries(r).length).toBe(1);
  });
});
