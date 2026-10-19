// THE STEP SCOPE REFUSAL AGREES WITH THE CHILD IT WOULD WRITE (CHANGE-37a; user ruling 2026-10-16T20:05:03Z).
//
// armDecomposition refused a step "inside the autonomy scope" on opts.directed alone, but writes the child directed
// when meta.directed || opts.directed. So a DIRECTED parent decomposed without a directed caller (escalation, the
// lifecycle scan) had its in-scope steps refused although they would be directed (RUN 1: S2 0/12 decompositions of
// in-vessel gaps). And a tightening hold refused the repair of its own regression, which admission and the floor allow.
// The check stays (a cost / closability filter; admission, the floor, the cutover chokepoint and settlement still guard
// undirected work).
//   [MUST-FAIL] a directed parent (meta.directed), called undirected, with an in-scope step: the step is written, directed.
//   [MUST-FAIL] an undirected parent in the lineage of the tightening hold on the step's file: the step is written.
//   [CONTROL]   an undirected parent with an in-scope step: still refused at the step ("inside the autonomy scope").
//   [WIRING]    the gapDecomposition route passes no pointer `directed` (37b: a pointer could mint directed children).
// Driven like pin-arm-decomposition.test.ts: resolveGapToFeature({decompose_gap_id}) over stored rows, the LLM and the
// autonomy scope answered through the fetch router.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, route, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");

const VESSEL = `armdir-${RUN}`;
const READER_SRC = "export function readerFn(x: string) { return x; }\n";
let n = 0;
function stepFile(): string {
  const rel = `src/armdir-${++n}.ts`;
  mkdirSync(join(SCRATCH, "clones", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "clones", VESSEL, rel), READER_SRC);
  return `repos/${VESSEL}/${rel}`;
}
function proposal(answer: unknown): void {
  route({ name: "llm", match: (u, b) => u.startsWith("http://llm.judge-pin") && b?.type === "llm_completion", respond: () => Response.json({ content: JSON.stringify(answer) }) });
}
function scope(excluded: string[], holds: Row[] = []): void {
  route({ name: "scope", match: (_u, b) => b?.impulse?.type === "poolImpulse" && b.impulse.shape === "autonomyScope",
    respond: () => Response.json({ body: { impulses: [{ shape: "autonomyScope", updated_at: "2026-01-02T00:00:00Z", body: { excluded_paths: excluded, tightening_holds: holds, reason: "37a test" } }] } }) });
  route({ name: "shape descriptions", match: (u) => { try { return new URL(u).pathname === "/registry/shape-descriptions"; } catch { return false; } }, respond: () => Response.json({ shape_descriptions: {} }) });
}
const parentId = (tag: string) => `armdir-${tag}-${RUN}`;
function parent(tag: string, meta: Row = {}): string {
  const id = parentId(tag);
  seed({ id, summary: `decompose me ${tag}`, classification_metadata: { falsifier: "class2", edit_site: stepFile(), evidence_resolve: { shape: "pin_parent_shape", input: {}, zero_field: "n" }, ...meta } });
  return id;
}
const decompose = (id: string) => tick(() => resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: id } as never));
const literalStep = (site: string) => ({ edit_site: site, change: "route the request through the guard", falsifier: { expected_literal: `armDirLiteral_${RUN}_${n}`, reader: "readerFn" } });

beforeEach(() => { beginPin(); __resetPolicyReadsForTests(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("the step scope refusal agrees with the child it would write", () => {
  it("[MUST-FAIL] a directed parent called undirected: its in-scope step is written, directed", async () => {
    const site = stepFile();
    scope([site]);
    // An operator-directed row carries its provenance (lib/operator-direct.ts gapDirected); a bare directed:true is legacy.
    const id = parent("directed", { directed: true, directed_by: "operator:key:pin-fixture" });
    proposal({ steps: [literalStep(site)] });
    await decompose(id);
    expect(stored(`${id}-step-1`)).toBeDefined();
    expect(metaOf(`${id}-step-1`).directed).toBe(true);
  });

  it("[MUST-FAIL] an undirected parent in the hold's lineage: its in-scope step is written", async () => {
    const site = stepFile();
    const id = parentId("hold");
    scope([site], [{ path: site, lineage_roots: [id], lineage_checks: [] }]);
    parent("hold");
    proposal({ steps: [literalStep(site)] });
    await decompose(id);
    expect(stored(`${id}-step-1`)).toBeDefined();
  });

  it("[HELD-OUT] a directed parent under a DIRECTORY scope entry: every in-scope step is written, directed", async () => {
    const a = stepFile(), b = stepFile();
    const dir = a.slice(0, a.lastIndexOf("/") + 1);
    expect(b.startsWith(dir)).toBe(true);
    scope([dir]);
    const id = parent("dirscope", { directed: true, directed_by: "operator:key:pin-fixture" });
    proposal({ steps: [literalStep(a), literalStep(b)] });
    await decompose(id);
    for (const k of [1, 2]) expect(metaOf(`${id}-step-${k}`).directed).toBe(true);
  });

  it("[CONTROL] an undirected parent with an in-scope step: refused at the step", async () => {
    const site = stepFile();
    scope([site]);
    const id = parent("undirected");
    proposal({ steps: [literalStep(site)] });
    const { result } = await decompose(id);
    expect(stored(`${id}-step-1`)).toBeUndefined();
    expect(String((result as { body?: { reason?: unknown } }).body?.reason ?? "")).toContain("inside the autonomy scope");
  });

  it("[WIRING] the gapDecomposition route passes no pointer `directed`", () => {
    const SRC = readFileSync(new URL("../../src/routes/impulses.ts", import.meta.url), "utf8");
    const i = SRC.indexOf('case "gapDecomposition": {');
    const block = SRC.slice(i, SRC.indexOf("// @shape-dispatch:private", i));
    expect(block).toContain('resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: gid }');
    expect(block).not.toMatch(/directed\s*:/);
  });
});
