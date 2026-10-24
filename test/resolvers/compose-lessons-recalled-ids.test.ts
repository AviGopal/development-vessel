// THE COMPOSE-LESSONS LINE NAMES THE CONCEPTS A DRAFT WAS SHOWN (qa, 2026-10-24). composeLessonsBlock logged
// "[compose-lessons] source=concept-db n=<n> class=<class>": how many lessons, never which, so per-draft exposure to a
// lesson could not be read from the journal. The line now ends "ids=<id1,id2,…>": a response-level id list if the
// search carries one, else the ids of the rows that yielded a lesson; "ids=unknown" when there are none. The jsonl
// fallback line is unchanged. Driven with globalThis.fetch standing in for discovery and concept-db.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `lesson-ids-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const fc = await import("../../src/resolvers/feature-compose.js") as Record<string, unknown> & typeof import("../../src/resolvers/feature-compose.js");

const OWN_EP = "http://cdb.own:8260";
const ownRow = { vesselId: "concept-db-local", endpoint: OWN_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
let answer: unknown = { content: [] };
let producers: Array<Record<string, unknown>> = [ownRow];
let logs: string[] = [];
const originalFetch = globalThis.fetch;
const origWarn = console.warn;
const origLog = console.log;
beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (p?.type === "vesselCapability" && p.shape === "conceptSearch") return Response.json({ content: { shape: p.shape, vessels: producers, found: producers.length > 0 } });
    if (p?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (p?.type === "conceptSearch") return Response.json(answer);
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.warn = origWarn;
  console.log = origLog;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { logs = []; producers = [ownRow]; g2fPolicy.__resetPolicyReadsForTests(); });
const line = (): string | undefined => logs.find((l) => l.startsWith("[compose-lessons] source=concept-db"));

describe("the [compose-lessons] line names the recalled concept ids", () => {
  it("[MUST-FAIL] the ids of the rows the stubbed search returned", async () => {
    answer = { content: [{ id: "concept_a1", content: "lesson one" }, { concept_id: "concept_b2", content: "lesson two" }, { id: "concept_c3", content: "" }] };
    await fc.composeLessonsBlock("edit repos/x/src/y.ts", ["anchor_not_found"]);
    expect(line()).toBe("[compose-lessons] source=concept-db n=2 class=anchor_not_found ids=concept_a1,concept_b2");
  });
  it("[CONTROL] a response-level id list wins; rows with no id log ids=unknown", async () => {
    answer = { ids: ["concept_x", "concept_y"], content: [{ content: "lesson one" }, { content: "lesson two" }] };
    await fc.composeLessonsBlock("edit repos/x/src/y.ts", ["anchor_not_found"]);
    expect(line()).toBe("[compose-lessons] source=concept-db n=2 class=anchor_not_found ids=concept_x,concept_y");
    logs = [];
    g2fPolicy.__resetPolicyReadsForTests();
    answer = { content: [{ content: "lesson one" }] };
    await fc.composeLessonsBlock("edit repos/x/src/y.ts", []);
    expect(line()).toBe("[compose-lessons] source=concept-db n=1 class=none ids=unknown");
  });
  it("[CONTROL] the jsonl fallback line is unchanged", async () => {
    producers = [];
    await fc.composeLessonsBlock("edit repos/x/src/y.ts", ["anchor_not_found"]);
    expect(logs).toContain("[compose-lessons] source=fallback=jsonl");
    expect(line()).toBeUndefined();
  });
});
