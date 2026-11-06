// The auto-pick cases of gap-to-feature-lineage-cap-release.test.ts, run by it in their own process with their own temp
// gap store (runCasesIsolated, isolated-gap-store-run.ts): substrate-gap fixes its store root at first load, so in the
// full suite these would otherwise trip the temp-dir guard as one "(unnamed)" failure whenever another file loaded it
// first. The [CONTROL] case uses only what the parent has (the seam is looked up, not imported), so it runs there too.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { snapshotGapStore } from "./gap-store-snapshot.js";

const ROOT = join(tmpdir(), `lineage-cap-release-pick-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js") as Record<string, any>;
const g2fPolicy = await import("../../src/judge/gap-policy.js");

type Row = Record<string, unknown>;
const RUN = process.env["LCR_RUN"] ?? Math.random().toString(36).slice(2, 8);
const ACTIVITY = "development-vessel:lineage-cap-release";
const T_FAIL_ROOT = "2000-01-02T01:00:00.000Z";
const T_FAIL = "2000-01-03T01:00:00.000Z";
const T_AFTER = "2000-01-04T01:00:00.000Z";
const T_BEFORE = "2000-01-01T01:00:00.000Z";
const SITE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
const row = (id: string, source: string, meta: Row): Row => ({ id, category: "systematic_failure", source, status: "open", summary: `fixture ${id}`, detected_at: "1999-12-30T00:00:00.000Z", classification_metadata: meta });
/** A root (failed 4) and its recommit (failed 3): lineage attempts 7, over the cap of 6. */
const lineage = (tag: string, recommitMeta: Row, rootMeta: Row = {}): Row[] => {
  const root = `lcr-root-${tag}-${RUN}`;
  return [
    row(root, "substrate_detected", { edit_site: SITE, falsifier: "class2", falsifier_classified_at: T_BEFORE, failed_attempts: 4, last_failed_at: T_FAIL_ROOT, ...rootMeta }),
    row(`recommit-lcr-${tag}-${RUN}`, "substrate_detected", { edit_site: SITE, falsifier: "class2", falsifier_classified_at: T_BEFORE, source_gap_id: root, re_commit: true, failed_attempts: 3, last_failed_at: T_FAIL, ...recommitMeta }),
  ];
};
const ARMED_AFTER = { check_supply: { state: "armed", armed_at: T_AFTER } };
const mask = (v: unknown) => [{ id: "mask-lcr", body: { activity_id: ACTIVITY, active_variant: v, from: "1999-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", by: "operator:test", reason: "test" } }];

const originalFetch = globalThis.fetch;
const savedPush = process.env["MITOSIS_DIRECT_PUSH"];
const savedStore = process.env["GAP_STORE_ENDPOINT"];
let gapStore: { restore: () => Promise<void> } | null = null;
const storeFile = (): string => join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
function plant(rows: Row[]): void {
  let all: Row[] = [];
  try { all = JSON.parse(readFileSync(storeFile(), "utf8")) as Row[]; } catch { all = []; }
  writeFileSync(storeFile(), JSON.stringify([...all.filter((r) => !rows.some((x) => x["id"] === r["id"])), ...rows], null, 2));
}
async function pick(): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await g2f.resolveGapToFeature({ type: "gapToFeature" } as never); } finally { console.log = orig; }
  await sg.__settleBirthEvaluationsForTests();
  return lines;
}
const CAP_LINE = (n: number) => `[gap-to-feature] lineage cap excluded ${n} recommit gap(s) (lineage failed_attempts >= 6)`;

describe("the auto-pick over a planted store: one capped lineage with a new arm, one without", () => {
  beforeAll(() => {
    delete process.env["GAP_STORE_ENDPOINT"];
    gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
    const root = sg.gapStoreRootForTest();
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
    mkdirSync(join(root, "gaps"), { recursive: true });
    writeFileSync(storeFile(), "[]");
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
        return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      }
      if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    sg.__setBirthJudgeForTests(async () => "present");
    g2fPolicy.__resetPolicyReadsForTests();
    // Landings stopped: admission admits nothing, so each pass ends at select without composing.
    process.env["MITOSIS_DIRECT_PUSH"] = "0";
  });
  afterAll(async () => {
    g2f.__setLineageCapReleaseDepsForTests?.(null);
    await gapStore?.restore();
    globalThis.fetch = originalFetch;
    sg.__setBirthJudgeForTests(null);
    if (savedPush === undefined) delete process.env["MITOSIS_DIRECT_PUSH"]; else process.env["MITOSIS_DIRECT_PUSH"] = savedPush;
    if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
    try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  });
  const planted = () => [...lineage("pick-new", ARMED_AFTER), ...lineage("pick-old", {})];

  it("[CONTROL] with no mask in force both lineages stay capped, with the parent's line (runs at the parent too)", async () => {
    g2f.__setLineageCapReleaseDepsForTests?.({ readMasks: () => [] });
    plant(planted());
    const lines = await pick();
    expect(lines).toContain(CAP_LINE(2));
    if (process.env["LCR_DUMP_PICK_LINES"]) writeFileSync(process.env["LCR_DUMP_PICK_LINES"], lines.filter((l) => !l.startsWith("[gap-to-feature] lineage-cap-release")).join("\n") + "\n");
  });
  it("[MUST-FAIL] under variant-1 the lineage with the new arm passes the cap; the other stays capped", async () => {
    g2f.__setLineageCapReleaseDepsForTests({ readMasks: () => mask(1) });
    plant(planted());
    const lines = await pick();
    expect(lines).toContain(CAP_LINE(1));
    expect(lines.some((l) => l.includes(`row=recommit-lcr-pick-new-${RUN}`) && l.endsWith("→ released"))).toBe(true);
    expect(lines.some((l) => l.includes(`row=recommit-lcr-pick-old-${RUN}`))).toBe(false);
  });
});
