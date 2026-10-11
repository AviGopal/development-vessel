// BEHAVIOUR PIN: the live-producer probe close (judge split, extraction `liveProducerProbeClose`, RECOUNT uncovered
// #11). A missing_capability gap whose candidate shape (the first quoted token of its summary, else
// classification_metadata.shape) has a live producer in discovery, and whose edit_site (when it names one) exists, is
// closed already_resolved by gap_to_feature.live_producer_probe without composing. Any other answer (no producer,
// discovery unreachable, an edit_site that does not exist) falls through to the compose route.
//
// Driven through resolveGapToFeature with a stored row; asserted on the stored row after the tick, the writes in
// order, the probe request, the report and whether feature_compose ran. Written against the tree before the
// extraction; it must hold after it. See harness.ts for the seams.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, writesFor, store, route, hitsOf, calls, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const VESSEL = `pinvessel-${RUN}`;
let n = 0;
/** A site that exists in the runtime tree (so the fall-through localizes on metadata, no grep or LLM). */
function runtimeSite(): string {
  const rel = `src/live-probe-${++n}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), "export const probe = 1;\n");
  return `repos/${VESSEL}/${rel}`;
}
type Probe = "producer" | "none" | "unreachable" | "http500";
function routeProbe(kind: Probe): void {
  route({
    name: "probe",
    match: (u) => { try { return new URL(u).pathname === "/vessels"; } catch { return false; } },
    respond: () => {
      if (kind === "unreachable") throw new TypeError("Unable to connect (pin: discovery declared unreachable)");
      if (kind === "http500") return new Response("boom", { status: 500 });
      return Response.json({ vessels: kind === "producer" ? [{ vesselId: "producer-fixture" }] : [] });
    },
  });
}
const gapId = (tag: string) => `pin-live-probe-${tag}-${RUN}`;
const directedTick = (id: string) => tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: id, dry_run: true } as never));

beforeEach(() => beginPin());
afterEach(() => {
  const v = endPin();
  expect(v).toEqual({ fetch: [], fs: [], exec: [] });
});
afterAll(() => restoreHarness());

describe("live-producer probe: a missing_capability gap with a live producer is closed already_resolved without composing", () => {
  it("[PIN] producer found, no edit_site: closed already_resolved by gap_to_feature.live_producer_probe; the quoted shape is probed", async () => {
    const id = gapId("found-nosite");
    seed({ id, category: "missing_capability", summary: `no producer for "pinShape_${RUN}" in the fleet`, classification_metadata: { kind: "missing_capability_report", shape: "ignored_meta_shape" } });
    routeProbe("producer");
    const { result } = await directedTick(id);
    const body = result.body as Row;
    expect(body.verdict).toBe("already_resolved");
    expect(body.ok).toBe(true);
    expect(String(body.note)).toBe(`already_resolved: live producer found for shape 'pinShape_${RUN}'; gap closed without recompose to prevent duplicate-identifier patches`);
    const probes = hitsOf("probe");
    expect(probes.length).toBe(1);
    expect(new URL(probes[0]!.url).searchParams.get("shape")).toBe(`pinShape_${RUN}`);
    expect(probes[0]!.url.startsWith(`${process.env["DISCOVERY_ENDPOINT"]}/vessels?shape=`)).toBe(true);
    const row = stored(id)!;
    expect(row.status).toBe("closed");
    expect(row.classification_metadata.closed_reason).toBe("already_resolved");
    expect(row.classification_metadata.resolution).toBe("already_resolved");
    expect(row.classification_metadata.closed_by).toBe("gap_to_feature.live_producer_probe");
    expect(typeof row.classification_metadata.closed_at).toBe("string");
    // Writes, in order: the approach decision (open), then the close.
    expect(writesFor(id).map((w) => w.status)).toEqual(["open", "closed"]);
    expect(Array.isArray(writesFor(id)[0]!.meta.approach_decisions)).toBe(true);
    expect(calls.compose.length).toBe(0);
  });

  it("[PIN] no quoted token: the probed shape is classification_metadata.shape", async () => {
    const id = gapId("meta-shape");
    seed({ id, category: "missing_capability", summary: "a capability nobody serves", classification_metadata: { shape: `metaShape_${RUN}` } });
    routeProbe("producer");
    const { result } = await directedTick(id);
    expect((result.body as Row).verdict).toBe("already_resolved");
    expect(new URL(hitsOf("probe")[0]!.url).searchParams.get("shape")).toBe(`metaShape_${RUN}`);
    expect(stored(id)!.status).toBe("closed");
  });

  it("[PIN] producer found and the edit_site exists (statSync): closed, and the note names the edit_site", async () => {
    const id = gapId("found-site");
    const abs = join(SCRATCH, `existing-site-${RUN}.ts`);
    writeFileSync(abs, "export {};\n");
    seed({ id, category: "missing_capability", summary: `"pinShapeSite_${RUN}" has no producer`, classification_metadata: { edit_site: abs } });
    routeProbe("producer");
    const { result } = await directedTick(id);
    const body = result.body as Row;
    expect(body.verdict).toBe("already_resolved");
    expect(String(body.note)).toContain(`and edit_site '${abs}' exists in container tree`);
    expect(stored(id)!.status).toBe("closed");
    expect(stored(id)!.classification_metadata.closed_by).toBe("gap_to_feature.live_producer_probe");
    expect(calls.compose.length).toBe(0);
  });

  for (const [tag, kind, site] of [
    ["found-missing-site", "producer", true],
    ["no-producer", "none", true],
    ["discovery-unreachable", "unreachable", true],
    ["discovery-http500", "http500", true],
  ] as const) {
    it(`[PIN] ${tag}: NOT closed; falls through to the compose route`, async () => {
      const id = gapId(tag);
      // A repos/ edit_site is resolved by statSync against the process cwd, where it does not exist (the probe's
      // own semantics); the runtime copy lets the fall-through localize it on metadata.
      seed({ id, category: "missing_capability", summary: `"pinShapeX_${RUN}" is missing`, classification_metadata: { ...(site ? { edit_site: runtimeSite() } : {}) } });
      routeProbe(kind);
      const { result } = await directedTick(id);
      const body = result.body as Row;
      expect(body.verdict).not.toBe("already_resolved");
      expect(hitsOf("probe").length).toBe(1);
      expect(stored(id)!.status).toBe("open");
      expect(stored(id)!.classification_metadata.closed_by).toBeUndefined();
      expect(writesFor(id).every((w) => w.status === "open")).toBe(true);
      expect(calls.compose.length).toBe(1);
      expect(body.verdict).toBe("BUSY");
    });
  }

  it("[CONTROL] a gap of another category is never probed, even with a producer and a quoted shape", async () => {
    const id = gapId("other-category");
    seed({ id, category: "systematic_failure", summary: `"pinShapeY_${RUN}" is missing`, classification_metadata: { edit_site: runtimeSite() } });
    routeProbe("producer");
    const { result } = await directedTick(id);
    expect(hitsOf("probe").length).toBe(0);
    expect((result.body as Row).verdict).toBe("BUSY");
    expect(stored(id)!.status).toBe("open");
    expect(calls.compose.length).toBe(1);
    expect(store.writes.some((w) => w.status === "closed")).toBe(false);
  });
});
