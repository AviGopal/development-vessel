// THE GAP-LANE ADMISSION LIVELOCK (node1, 24 h to 2026-10-10). An unarmed gap with route:dispatchable and a
// gap_to_feature remedy (db_performance_slow_queries_*) was rewritten by its detector every ~10 min. Each write
// made gap-drain-observer dispatch gap_to_feature with its gap_id, a TARGETED call that never passed admission.
// feature_compose then refused it ("undirected compose NOT started: ... ineligible (unarmed)"), and gap_to_feature
// graded that refusal as a failed attempt. The bump took the gap past the chronic threshold on every tick, and each
// tick re-emitted the existing -narrowed child and re-escalated with no step written (126 escalations in 24 h).
//
// Pinned here (admission, (a) (b) (e), is gap-lane-livelock-admission.test.ts):
//   (c) a narrowed child that already exists is not emitted again by the next chronic bump.
//   (d) a chronic escalation is not repeated while its inputs (falsifier, edit site, arming state, last attempt
//       outcome) are unchanged. Keyed on state, not on a clock; a changed input escalates again.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "gap-lane-livelock-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = join(SCRATCH, "ws");
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// Every file this path can write is pointed at scratch, so no run touches /workspace, /vessels or a tracked store.
const SCRATCH_ENV: Record<string, string> = {
  ATTEMPT_LEDGER_DIR: join(SCRATCH, "ledger"),
  MITOSIS_RUNTIME_DIR: join(SCRATCH, "runtime"),
  VESSELS_CLONE_ROOT: join(SCRATCH, "clones"),
  VESSEL_CLONE_ROOT: join(SCRATCH, "clones"),
  MITOSIS_PUSH_CLONE_DIR: join(SCRATCH, "push"),
  PROPOSALS_DIR: join(SCRATCH, "proposals"),
  PARKED_LANDINGS_DIR: join(SCRATCH, "parked"),
  EXPECTATION_CALIB_PATH: join(SCRATCH, "expectation-calibration.json"),
  GAP_CLASS_POSTERIOR_PATH: join(SCRATCH, "gap-class-posteriors.json"),
  CLOSE_ORACLE_CALIB_PATH: join(SCRATCH, "close-oracle-calibration.json"),
  DETECTOR_CLOSURE_LEDGER_PATH: join(SCRATCH, "detector-closure-credit.json"),
};
const SAVED_ENV: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(SCRATCH_ENV)) { SAVED_ENV[k] = process.env[k]; process.env[k] = v; mkdirSync(k.endsWith("_PATH") ? SCRATCH : v, { recursive: true }); }

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js") as typeof import("../../src/resolvers/gap-to-feature.js") & Record<string, unknown>;
const g2fPolicy = await import("../../src/judge/gap-policy.js") as typeof import("../../src/judge/gap-policy.js") & Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const SITE = "repos/development-vessel/src/resolvers/gap-to-feature.ts";
mkdirSync(join(SCRATCH, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
writeFileSync(join(SCRATCH, "runtime", "development-vessel", "src", "resolvers", "gap-to-feature.ts"), "export const fixture = 1;\n");

const originalFetch = globalThis.fetch;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
let runGoals = 0;
let storeFile = "";
let storeBefore: string | null = null;
beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  storeFile = join(root, "gaps", "gaps.json");
  try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (body?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (url.endsWith("/run-goal")) { runGoals++; return Response.json({ ok: true }); }
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  g2fPolicy.__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  if (storeFile) { if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore); }
  for (const [k, v] of Object.entries(SAVED_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2fPolicy.__resetPolicyReadsForTests();
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* noop */ }
});

type Row = Record<string, unknown>;
const LESSON = { class: "verify", reason: "typecheck failed in the drafted change at the named site", at: "2026-10-09T00:00:00.000Z" };
async function put(id: string, meta: Row, extra: Row = {}): Promise<Row> {
  const gap = { id, category: "db_performance", source: "substrate_detected", status: "open", detected_at: "2026-10-01T06:00:00.000Z", summary: `livelock probe ${id}`, ...extra, classification_metadata: meta };
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  return gap;
}
async function read(id: string): Promise<Row | null> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id } as never);
  return (((r as { body?: { gaps?: Row[] } }).body?.gaps) ?? []).find((g) => String(g.id) === id) ?? null;
}
const metaOf = (g: Row | null): Row => ((g?.classification_metadata ?? {}) as Row);
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { result: await fn(), lines }; } finally { console.log = orig.log; console.warn = orig.warn; }
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("(c) an existing narrowed child is not emitted again by the next chronic bump", () => {
  it("POSITIVE CONTROL: a root reaching the threshold with no child emits it once", async () => {
    const P = `livelock-narrow-fresh-${RUN}`;
    await put(P, { failed_attempts: 2, failure_lessons: [LESSON], decomposed_at: "2026-10-01T00:00:00Z", decomposition: { children: ["s-1"] } });
    const { lines } = await captureLog(() => g2f.bumpFailedAttempts({ id: P, category: "db_performance", source: "substrate_detected", summary: "p", detected_at: "2026-10-01T06:00:00.000Z" }));
    await settle();
    expect(await read(`${P}-narrowed`)).not.toBeNull();
    expect(lines.filter((l) => l.includes("emitted narrowed child")).length).toBe(1);
  });

  it("a second chronic tick with the child already stored does not re-emit it (the stored child is untouched)", async () => {
    const P = `livelock-narrow-exists-${RUN}`;
    await put(P, { failed_attempts: 3, failure_lessons: [LESSON], decomposed_at: "2026-10-01T00:00:00Z", decomposition: { children: ["s-1"] } });
    await put(`${P}-narrowed`, { parent_gap_id: P, failed_attempts: 0, narrowed_at: "2026-01-01T00:00:00.000Z" }, { summary: "the original child" });
    const { lines } = await captureLog(() => g2f.bumpFailedAttempts({ id: P, category: "db_performance", source: "substrate_detected", summary: "p", detected_at: "2026-10-01T06:00:00.000Z" }));
    await settle();
    const child = await read(`${P}-narrowed`);
    expect(metaOf(child).narrowed_at).toBe("2026-01-01T00:00:00.000Z");
    expect(String(child?.summary)).toBe("the original child");
    expect(lines.some((l) => l.includes("emitted narrowed child"))).toBe(false);
    expect(lines.some((l) => l.includes(`narrowed child ${P}-narrowed already exists`))).toBe(true);
    expect(Number(metaOf(await read(P)).failed_attempts)).toBe(4);
  });
});

describe("(d) a chronic escalation that writes no step is not repeated while its inputs are unchanged", () => {
  it("same inputs: the second escalation is not dispatched; a changed input escalates again", async () => {
    const G = `livelock-escalate-${RUN}`;
    const base = { edit_site: SITE, failure_lessons: [LESSON], decomposed_at: "2026-10-01T00:00:00Z", decomposition: { children: [], reason: "no valid step" } };
    await put(G, base);
    const r0 = runGoals;
    const first = await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure");
    await settle();
    expect(first).toContain("dispatched: investigation");
    const second = await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure");
    await settle();
    expect(second).toContain("not dispatched: inputs unchanged");
    expect(runGoals - r0).toBe(1);

    // A new attempt outcome (a new failure lesson) is a changed input.
    const stamped = metaOf(await read(G));
    await put(G, { ...stamped, failure_lessons: [LESSON, { class: "apply", reason: "anchor not found in the named file", at: "2026-10-10T00:00:00.000Z" }] });
    const third = await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure");
    await settle();
    expect(third).toContain("dispatched: investigation");
    expect(runGoals - r0).toBe(2);

    // A changed edit site is a changed input; then the same inputs hold again.
    await put(G, { ...metaOf(await read(G)), edit_site: "repos/development-vessel/src/resolvers/substrate-gap.ts" });
    expect(await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure")).toContain("dispatched: investigation");
    expect(await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure")).toContain("not dispatched: inputs unchanged");
    await settle();
    expect(runGoals - r0).toBe(3);
  });

  it("a changed falsifier (arming) escalates again", async () => {
    const G = `livelock-escalate-arm-${RUN}`;
    await put(G, { edit_site: SITE, failure_lessons: [LESSON], decomposed_at: "2026-10-01T00:00:00Z", decomposition: { children: [] } });
    const before = g2f["chronicEscalationFingerprint"] as (r: Row, why: string) => string;
    const row0 = (await read(G))!;
    expect(await g2f.escalateToDecomposition({ id: G, summary: "g" }, "chronic failure")).toContain("dispatched: investigation");
    const armed = { ...row0, classification_metadata: { ...metaOf(await read(G)), falsifier: "class2" } };
    expect(before(armed, "chronic failure")).not.toBe(before((await read(G))!, "chronic failure"));
  });
});
