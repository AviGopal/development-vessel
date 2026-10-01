// A FAILED COMPOSE'S LESSON REACHES THE GAP RECORD, WHATEVER CONCEPT-DB IS DOING (10-01, node 2).
//
// appendComposeLesson writes the lesson to the gap's classification_metadata.failure_lessons first (the gap
// store), then mirrors the class-grain lesson to concept-db best-effort. The mirror is addressed through
// discovery, own-substrate producers only (discoverOwnResolveUrls): a node with no concept-db of its own skips
// it ("mirror skipped (<reason>)") instead of posting to a pinned loopback default nothing serves, and a peer
// substrate's concept-db is never this substrate's corpus. The recall side (composeLessonsBlock) resolves the
// same way and falls back to the local jsonl.
//
// The loss on the live fleet was downstream of the write: bumpFailedAttempts wrote the caller's PICK-TIME
// snapshot back over the row the compose had just updated, and the store replaces classification_metadata,
// so the lesson vanished and the narrowing check read the same stale list. These tests drive the real
// appendComposeLesson, bumpFailedAttempts and composeLessonsBlock against the real (temp) gap store, with
// globalThis.fetch standing in for discovery and concept-db.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `lesson-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const fc = await import("../../src/resolvers/feature-compose.js");
const RUN = Math.random().toString(36).slice(2, 8);

const OWN_EP = "http://cdb.own:8260";
const FOREIGN_EP = "http://cdb.syzygy:8401";
const N1_DISCOVERY = "http://host.containers.internal:18100";
const SYZ_DISCOVERY = "http://syzygy.host:18100";
const ownRow = { vesselId: "concept-db-local", endpoint: OWN_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
// A third substrate's concept-db as node 2 sees it: relayed through node 1 (the live row on 10-01).
const foreignRow = { vesselId: "concept-db-local@syzygy-hub", endpoint: FOREIGN_EP, resolve_endpoint: "/v2/impulses/resolve", origin: `peer:${N1_DISCOVERY}`, origin_upstream: `peer:${SYZ_DISCOVERY}` };

let conceptRows: Array<Record<string, unknown>> = [];
let ownDown = false;
let hits: Array<{ url: string; type: string }> = [];
let logs: string[] = [];
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
const savedStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (p?.type === "vesselCapability") {
      if (p.shape === "poolImpulse") return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      if (p.shape === "concept_create_write" || p.shape === "conceptSearch") return Response.json({ content: { shape: p.shape, vessels: conceptRows, found: conceptRows.length > 0 } });
      return Response.json({ content: { vessels: [] } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (p?.type === "concept_create_write" || p?.type === "conceptSearch") {
      hits.push({ url, type: p.type });
      if (url.startsWith(OWN_EP) && ownDown) throw new TypeError("Unable to connect. Is the computer able to access the url?");
      // A post to discovery's /resolve is routed by discovery to whatever producer it knows: the
      // foreign corpus, as on node 2.
      if (p.type === "conceptSearch") return Response.json({ content: [{ content: url.startsWith(OWN_EP) ? "own lesson" : "FOREIGN lesson" }] });
      return Response.json({ shape: "concept", body: { id: "c1" } });
    }
    if (url.endsWith("/run-goal")) return Response.json({ ok: true });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  if (savedStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStoreEndpoint;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  conceptRows = [];
  ownDown = false;
  hits = [];
  logs = [];
  g2f.__resetPolicyReadsForTests();
});

type Row = Record<string, unknown>;
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
async function seedGap(id: string, meta: Row): Promise<Row> {
  const gap = { id, category: "missing_capability", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `lesson-store fixture ${id}: the drafter must learn from its failures`, classification_metadata: meta };
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  // The caller's copy: the gap as it was PICKED, before the compose ran.
  return JSON.parse(JSON.stringify((await storeRow(id))!)) as Row;
}
const lessonsOf = (row: Row | undefined): Row[] => ((row?.["classification_metadata"] as Row | undefined)?.["failure_lessons"] as Row[] | undefined) ?? [];

describe("appendComposeLesson: the gap record first, the concept-db mirror best-effort", () => {
  it("concept-db unreachable: the lesson reaches failure_lessons and the mirror is skipped, not an error", async () => {
    conceptRows = [ownRow];
    ownDown = true;
    const id = `ls-down-${RUN}`;
    const snap = await seedGap(id, { failure_lessons: [] });
    await fc.appendComposeLesson("verify_failed", "1 fail\nExpected: 1\nReceived: 2", "development-vessel", snap as never);
    await fc.__lastComposeLessonMirrorForTests();
    const ls = lessonsOf(await storeRow(id));
    expect(ls.length).toBe(1);
    expect(ls[0]!["class"]).toBe("verify_failed");
    expect(logs.some((l) => l.includes("[compose-lessons] mirror skipped (unreachable " + OWN_EP))).toBe(true);
    expect(logs.some((l) => l.includes("mirrored class="))).toBe(false);
  });

  it("no concept-db producer at all (node 2): the lesson is recorded and the mirror says why it skipped", async () => {
    conceptRows = [];
    const id = `ls-none-${RUN}`;
    const snap = await seedGap(id, { failure_lessons: [] });
    await fc.appendComposeLesson("anchor_not_found", "missing anchor string", "development-vessel", snap as never);
    await fc.__lastComposeLessonMirrorForTests();
    expect(lessonsOf(await storeRow(id)).map((l) => l["class"])).toEqual(["anchor_not_found"]);
    expect(logs.some((l) => l.includes("[compose-lessons] mirror skipped (no own-substrate concept_create_write producer"))).toBe(true);
    expect(hits.filter((h) => h.type === "concept_create_write")).toEqual([]);
  });

  it("an own concept-db producer: both writes happen, the mirror to that producer's resolve URL", async () => {
    conceptRows = [ownRow];
    const id = `ls-up-${RUN}`;
    const snap = await seedGap(id, { failure_lessons: [] });
    await fc.appendComposeLesson("syntax_break", "error TS1005: ';' expected", "development-vessel", snap as never);
    await fc.__lastComposeLessonMirrorForTests();
    expect(lessonsOf(await storeRow(id)).map((l) => l["class"])).toEqual(["syntax_break"]);
    expect(hits.filter((h) => h.type === "concept_create_write")).toEqual([{ url: `${OWN_EP}/v2/impulses/resolve`, type: "concept_create_write" }]);
    expect(logs.some((l) => l.includes("[compose-lessons] mirrored class=syntax_break to concept-db"))).toBe(true);
  });

  it("a foreign (peer-substrate) concept-db producer is never used for the mirror", async () => {
    conceptRows = [foreignRow];
    const id = `ls-foreign-${RUN}`;
    const snap = await seedGap(id, { failure_lessons: [] });
    await fc.appendComposeLesson("semantic_reject", "only implements half", "development-vessel", snap as never);
    await fc.__lastComposeLessonMirrorForTests();
    expect(lessonsOf(await storeRow(id)).length).toBe(1);
    expect(hits.filter((h) => h.type === "concept_create_write")).toEqual([]);
    expect(logs.some((l) => l.includes("mirror skipped (no own-substrate concept_create_write producer, 1 foreign set aside)"))).toBe(true);
  });
});

describe("bumpFailedAttempts builds on the stored row, so the lesson survives and narrowing sees it", () => {
  it("the lesson the compose just recorded survives the bump, and the chronic gap narrows on it", async () => {
    conceptRows = [];
    const id = `ls-narrow-${RUN}`;
    // Picked with two failed attempts and an (empty) lesson list, as gap-drain-redispatches was on node 2.
    const snap = await seedGap(id, { failure_lessons: [], failed_attempts: 2 });
    await fc.appendComposeLesson("typecheck_dangling_reference", "error TS2304: Cannot find name 'x'", "development-vessel", snap as never);
    await fc.__lastComposeLessonMirrorForTests();
    expect(lessonsOf(await storeRow(id)).length).toBe(1);
    await g2f.bumpFailedAttempts(snap);
    const row = await storeRow(id);
    expect((row?.["classification_metadata"] as Row)["failed_attempts"]).toBe(3);
    expect(lessonsOf(row).map((l) => l["class"])).toEqual(["typecheck_dangling_reference"]);
    expect(logs.some((l) => l.includes(`NOT narrowing ${id}`))).toBe(false);
    expect(logs.some((l) => l.includes(`emitted narrowed child gap for chronically-stuck gap ${id}`))).toBe(true);
    const child = await storeRow(`${id}-narrowed`);
    expect(String(child?.["summary"] ?? "")).toContain("typecheck_dangling_reference");
  });

  it("an earlier lesson already on the snapshot is not rolled back to the snapshot's list either", async () => {
    conceptRows = [];
    const id = `ls-keep-${RUN}`;
    const snap = await seedGap(id, { failure_lessons: [{ at: "2026-10-01T03:00:00.000Z", class: "semantic_reject", reason: "earlier" }], failed_attempts: 0 });
    await fc.appendComposeLesson("verify_failed", "1 fail", "development-vessel", snap as never);
    await g2f.bumpFailedAttempts(snap);
    expect(lessonsOf(await storeRow(id)).map((l) => l["class"])).toEqual(["semantic_reject", "verify_failed"]);
  });
});

describe("composeLessonsBlock recalls from this substrate's corpus only", () => {
  it("no own conceptSearch producer: no post to a foreign corpus, the recall is skipped to the local jsonl", async () => {
    conceptRows = [foreignRow];
    const out = await fc.composeLessonsBlock("edit repos/x/src/y.ts", ["anchor_not_found"]);
    expect(hits.filter((h) => h.type === "conceptSearch")).toEqual([]);
    expect(out).not.toContain("FOREIGN lesson");
    expect(logs.some((l) => l.includes("[compose-lessons] concept-db recall skipped (no own-substrate conceptSearch producer, 1 foreign set aside)"))).toBe(true);
    expect(logs.some((l) => l.includes("[compose-lessons] source=fallback=jsonl"))).toBe(true);
  });

  it("an own conceptSearch producer serves the recall", async () => {
    conceptRows = [ownRow];
    const out = await fc.composeLessonsBlock("edit repos/x/src/y.ts", ["anchor_not_found"]);
    expect(hits.filter((h) => h.type === "conceptSearch")).toEqual([{ url: `${OWN_EP}/v2/impulses/resolve`, type: "conceptSearch" }]);
    expect(out).toContain("own lesson");
    expect(logs.some((l) => l.includes("[compose-lessons] source=concept-db n=1 class=anchor_not_found"))).toBe(true);
  });
});
