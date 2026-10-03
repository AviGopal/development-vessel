// DECOMPOSE_NO_OPS MINTS AT MOST ONE RECOMMIT PER ROOT, AND ITS LESSON NAMES WHAT THE DRAFTER LACKED
// (check-first, qa amendment).
//
// appendComposeLesson files `recommit-<gap>-<class>` when a class repeats on a gap, down to two recommit
// levels. For decompose_no_ops that meant a root gap G, and then its child recommit-G-decompose_no_ops,
// could each mint one: two children for one root predicate, each carrying nothing new, because the
// lesson said only "drafter returned no ops". The child must carry new information: what the drafter
// was given (target file bytes, own-check test bytes and named-test count, anchors supplied, grounding
// bytes), and whether an own check was present.
//
// SEAM: GAP_STORE_ENDPOINT points at an in-memory holder (fetch stubbed); appendComposeLesson's gap reads
// and writes go there. No gap store file, no concept-db, no network.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { appendComposeLesson, recordDecomposeNoOps } from "../../src/resolvers/feature-compose.js";

const HOLDER = "http://holder.fixture.invalid/v2/impulses/resolve";
const realFetch = globalThis.fetch;
let store = new Map<string, Record<string, unknown>>();
let recommitWrites: string[] = [];
let savedEndpoint: string | undefined;
const spies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  store = new Map(); recommitWrites = [];
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  for (const m of ["log", "warn", "error"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== HOLDER) return Response.json([]);
    const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
    if (p.type === "substrateGap") {
      const rows = p.id ? (store.has(p.id) ? [store.get(p.id)] : []) : [...store.values()];
      return Response.json({ shape: "substrateGap", body: { gaps: rows, total: rows.length } });
    }
    if (p.type === "substrateGap_write") {
      const g = p.gap as Record<string, unknown>;
      if (String(g.id).startsWith("recommit-")) recommitWrites.push(String(g.id));
      store.set(String(g.id), { ...(store.get(String(g.id)) ?? {}), ...g });
      return Response.json({ shape: "substrateGapWriteResult", body: { id: g.id, action: "updated" } });
    }
    return Response.json({ shape: "structuredError", body: {} });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint;
});
afterAll(() => { globalThis.fetch = realFetch; });

const AT = "2026-10-03T10:00:00.000Z";
const prior = { at: AT, class: "decompose_no_ops", reason: "drafter returned no ops", stage: "decompose", edited_spans: [] };
function root(): Record<string, unknown> {
  return { id: "root-gap-fixture", category: "systematic_failure", source: "substrate_detected", summary: "a root gap", detected_at: AT, status: "open", classification_metadata: { edit_site: "repos/x/src/a.ts", failure_lessons: [prior] } };
}

describe("decompose_no_ops recommit cap", () => {
  it("[MUST-FAIL] two decompose_no_ops on one root (the root, then its recommit child) yield at most one recommit child", async () => {
    store.set("root-gap-fixture", root());
    await appendComposeLesson("decompose_no_ops", "drafter returned no ops", "", root() as never, { stage: "decompose", edited_spans: [] } as never);
    const children = [...store.keys()].filter((k) => k.startsWith("recommit-"));
    expect(children).toHaveLength(1);
    const child = { ...store.get(children[0]!)!, classification_metadata: { ...(store.get(children[0]!)!["classification_metadata"] as object), failure_lessons: [prior] } };
    store.set(children[0]!, child);
    await appendComposeLesson("decompose_no_ops", "drafter returned no ops", "", child as never, { stage: "decompose", edited_spans: [] } as never);
    // Again on the root: the existing child is not rewritten (which could reopen it).
    await appendComposeLesson("decompose_no_ops", "drafter returned no ops", "", root() as never, { stage: "decompose", edited_spans: [] } as never);
    expect(new Set(recommitWrites).size).toBeLessThanOrEqual(1);
    expect(recommitWrites.length).toBeLessThanOrEqual(1);
  });

  it("[MUST-FAIL] the decompose_no_ops lesson names the grounding sizes and whether an own check was present", async () => {
    const reasons: string[] = [];
    const rec = async (_c: string, reason: string) => { reasons.push(reason); };
    await (recordDecomposeNoOps as unknown as (...a: unknown[]) => Promise<void>)("drafter_no_ops", "", { id: "g" }, rec, {
      target_files: [{ path: "repos/x/src/a.ts", bytes: 12345 }], grounding_bytes: 8000, anchors_supplied_bytes: 0,
      own_check: { test_file: "test/a.test.ts", bytes: 2048, named_tests: 3 },
    });
    await (recordDecomposeNoOps as unknown as (...a: unknown[]) => Promise<void>)("redraft_unparseable", "x", { id: "g" }, rec, {
      target_files: [{ path: "repos/x/src/a.ts", bytes: 12345 }], grounding_bytes: 8000, anchors_supplied_bytes: 512, own_check: null,
    });
    expect(reasons[0]).toContain("12345");
    expect(reasons[0]).toContain("2048");
    expect(reasons[0]).toMatch(/3 named test/);
    expect(reasons[0]).toContain("anchors=0B");
    expect(reasons[0]).toContain("grounding=8000B");
    expect(reasons[1]).toContain("own_check=absent");
    expect(reasons[1]).toContain("anchors=512B");
    // The grounding summary survives the 200-character lesson truncation.
    expect(reasons[0].slice(0, 200)).toContain("own_check=");
  });

  it("[MUST-FAIL] the compose passes the grounding sizes at the no-ops exit", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    expect(src.includes("await recordDecomposeNoOps(redraftUnparseable ? \"redraft_unparseable\" : \"drafter_no_ops\", planRaw, pointer.gap, appendComposeLesson, decomposeGrounding("))
      .toBe(true);
  });
});
