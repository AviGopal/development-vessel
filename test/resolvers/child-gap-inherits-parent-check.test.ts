// A CHILD OF A VERIFIABLE PARENT IS BORN VERIFIABLE (10-02).
//
// When the lane gives up on a stuck armed gap it mints children about the same defect: a `-narrowed` clone
// (bumpFailedAttempts, at the chronic threshold) and a `recommit-<id>-<class>` row (appendComposeLesson, on a
// repeated failure class). Measured on node 1, 12:00-13:45Z: every such child was born falsifier=none, with no
// evidence_resolve and no birth verdict, so it could never close landed_verified while its parent sat at 6-8
// failed attempts. These tests drive the real emitters against the real (temp) gap store and pin:
//   - a trusted class-2 test_suite parent gives each child the identical check, judged afresh at the child's
//     birth (not copied), and its directed flag;
//   - a falsifier-less parent's children stay none (nothing is fabricated);
//   - a parent whose check read 'absent' at birth (it never saw the defect) gives nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `child-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const fc = await import("../../src/resolvers/feature-compose.js");
const RUN = Math.random().toString(36).slice(2, 8);

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
let judged: string[] = [];
let verdictFor: (id: string) => string = () => "present";

type Row = Record<string, unknown>;
const SITE = "repos/activity-api/src/routes/trace-aggregate-report.ts";
const CHECK = { shape: "test_suite", input: { vessel: "activity-api", test_file: "src/routes/trace-aggregate-report.failure-class.test.ts", only_tests: ["Y1-read-a: traceAggregateReport reads the authoritative execution table > queries FROM execution"], timeout_ms: 120001 }, zero_field: "requested_not_passing" };

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (p?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (url.endsWith("/run-goal")) return Response.json({ ok: true });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async (g: Row) => { const id = String(g["id"] ?? ""); judged.push(id); return verdictFor(id); });
  console.log = () => {};
  console.warn = () => {};
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { judged = []; verdictFor = () => "present"; g2f.__resetPolicyReadsForTests(); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
async function seedParent(id: string, meta: Row): Promise<Row> {
  const gap = { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `child-check fixture ${id}: the report reads a dead table`, classification_metadata: { edit_site: SITE, failed_attempts: 2, failure_lessons: [{ at: "2026-10-02T12:00:00.000Z", class: "verify_failed", reason: "THE GAP'S OWN CHECK IS STILL RED on this draft" }], ...meta } };
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  return JSON.parse(JSON.stringify((await storeRow(id))!)) as Row;
}
async function narrowAndRecommit(parent: Row): Promise<{ narrowed: Row; recommit: Row }> {
  const id = String(parent["id"]);
  // A repeated class mints the recommit; the bump to 3 failed attempts mints the narrowed child.
  await fc.appendComposeLesson("verify_failed", "THE GAP'S OWN CHECK IS STILL RED on this draft again", "activity-api", parent as never);
  await g2f.bumpFailedAttempts(JSON.parse(JSON.stringify((await storeRow(id))!)) as Row);
  await sg.__settleBirthEvaluationsForTests();
  const narrowed = await storeRow(`${id}-narrowed`);
  const recommit = await storeRow(`recommit-${id}-verify_failed`);
  expect(narrowed).toBeDefined();
  expect(recommit).toBeDefined();
  return { narrowed: narrowed!, recommit: recommit! };
}

describe("a child of a stuck gap inherits the parent's trusted class-2 check", () => {
  it("the parent fixture is a trusted, directed class-2 gap (positive control)", async () => {
    const parent = await seedParent(`cc-ctl-${RUN}`, { evidence_resolve: CHECK, directed: true });
    expect(metaOf(parent)["falsifier"]).toBe("class2");
    expect(metaOf(parent)["predicate_birth_verdict"]).toBe("present");
  });

  it("narrowed and recommit children carry the identical check, its own fresh birth verdict, and directed", async () => {
    const id = `cc-armed-${RUN}`;
    const parent = await seedParent(id, { evidence_resolve: CHECK, directed: true });
    judged = [];
    const { narrowed, recommit } = await narrowAndRecommit(parent);
    for (const child of [narrowed, recommit]) {
      const m = metaOf(child);
      expect(m["falsifier"]).toBe("class2");
      expect(m["evidence_resolve"]).toEqual(CHECK);
      expect(m["directed"]).toBe(true);
      expect(m["predicate_birth_verdict"]).toBe("present");
      expect(m["predicate_birth_key"]).toBe(sg.class2PredicateKey(m));
      expect(m["predicate_source"]).toBe("gap_falsify:inherit");
    }
    // Judged at the child's own birth, not copied from the parent's verdict.
    expect(judged).toContain(`${id}-narrowed`);
    expect(judged).toContain(`recommit-${id}-verify_failed`);
  });

  it("a check the parent's tree already satisfies is born absent on the child: suspect, never closable", async () => {
    const id = `cc-fixed-${RUN}`;
    const parent = await seedParent(id, { evidence_resolve: CHECK, directed: true });
    verdictFor = (g) => (g === id ? "present" : "absent");
    const { narrowed } = await narrowAndRecommit(parent);
    expect(metaOf(narrowed)["predicate_birth_verdict"]).toBe("absent");
    expect(sg.predicateSuspect(metaOf(narrowed))).not.toBeNull();
  });

  it("a falsifier-less parent's children stay none (nothing is fabricated)", async () => {
    const parent = await seedParent(`cc-none-${RUN}`, {});
    expect(metaOf(parent)["falsifier"]).toBe("none");
    const { narrowed, recommit } = await narrowAndRecommit(parent);
    for (const child of [narrowed, recommit]) {
      expect(metaOf(child)["falsifier"]).toBe("none");
      expect(metaOf(child)["evidence_resolve"] ?? null).toBeNull();
    }
  });

  it("a parent whose check read absent at birth (never saw the defect) gives its children nothing", async () => {
    const id = `cc-inverted-${RUN}`;
    verdictFor = () => "absent";
    const parent = await seedParent(id, { evidence_resolve: CHECK });
    expect(metaOf(parent)["predicate_birth_verdict"]).toBe("absent");
    const { narrowed, recommit } = await narrowAndRecommit(parent);
    for (const child of [narrowed, recommit]) expect(metaOf(child)["evidence_resolve"] ?? null).toBeNull();
  });
});

describe("inheritableParentCheck: only a check the child's scope still covers", () => {
  const trusted = { falsifier: "class2", edit_site: SITE, evidence_resolve: CHECK, predicate_birth_verdict: "present", predicate_birth_key: sg.class2PredicateKey({ evidence_resolve: CHECK }) };
  it("same edit site: inherited (a :line suffix is the same site)", () => {
    expect(sg.inheritableParentCheck(trusted, SITE + ":42")["evidence_resolve"]).toEqual(CHECK);
  });
  it("another edit site: not inherited", () => {
    expect(sg.inheritableParentCheck(trusted, "repos/activity-api/src/other.ts")).toEqual({});
  });
  it("a shape check (no at-commit contract): not inherited", () => {
    const er = { shape: "x_report", input: {}, zero_field: "n" };
    expect(sg.inheritableParentCheck({ ...trusted, evidence_resolve: er, predicate_birth_key: sg.class2PredicateKey({ evidence_resolve: er }) }, SITE)).toEqual({});
  });
  it("an unstamped or pending birth verdict: not inherited", () => {
    expect(sg.inheritableParentCheck({ ...trusted, predicate_birth_verdict: undefined }, SITE)).toEqual({});
    expect(sg.inheritableParentCheck({ ...trusted, predicate_birth_verdict: "pending" }, SITE)).toEqual({});
  });
});
